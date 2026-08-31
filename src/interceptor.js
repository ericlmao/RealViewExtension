/*
 * RealView - runs in the page's own JavaScript context (MAIN world).
 *
 * YouTube Studio reports the metric EXTERNAL_VIEWS, which since the 2025 change
 * counts a view the moment playback starts. The older 30-second definition
 * survives under the metric name ENGAGED_VIEWS. RealView puts the old number
 * back in front, everywhere Studio shows a view count.
 *
 * Studio's surfaces need three different techniques, because they expose the
 * metric to the client to different degrees:
 *
 *   yta_web/get_cards  The request carries the card's metric list, so asking
 *                      for ENGAGED_VIEWS is enough and the server does the
 *                      work. Its realtime card ignores that and is substituted.
 *   yta_web/join       The request carries an explicit query, so the metric is
 *                      swapped on the way out and renamed back on the way in,
 *                      leaving the caller's own bookkeeping intact.
 *   yta_web/get_screen The request carries no metric at all and the server
 *   creator/*_videos   always answers with raw views, so the response is held,
 *                      the engaged equivalent of each figure is fetched from
 *                      join, and the numbers are substituted.
 *
 * Nothing is ever relabelled unless its numbers really changed: if a query
 * fails or times out, the original response is passed through untouched.
 */
(function () {
  'use strict';

  if (window.__realViewInstalled) return;
  window.__realViewInstalled = true;

  var SOURCE_METRIC = 'EXTERNAL_VIEWS';
  var TARGET_METRIC = 'ENGAGED_VIEWS';

  var SCREEN_PATH = '/youtubei/v1/yta_web/get_screen';
  var CARDS_PATH = '/youtubei/v1/yta_web/get_cards';
  var JOIN_PATH = '/youtubei/v1/yta_web/join';
  // The channel dashboard asks for its figures the same way a join query does:
  // the request names the metric, so it can simply be asked for a different one.
  var DASHBOARD_PATH = '/youtubei/v1/creator/get_channel_dashboard';
  var VIDEO_LIST_PATHS = ['/youtubei/v1/creator/list_creator_videos', '/youtubei/v1/creator/get_creator_videos'];

  var DAY_MS = 86400000;
  var HOUR_MS = 3600000;

  // A query that has not answered by this point is abandoned and the original
  // response is delivered, so a slow or unreachable backend can never leave a
  // Studio screen spinning.
  var QUERY_DEADLINE_MS = 4000;
  // The backstop for the whole conversion, not just one query.
  var WATCHDOG_MS = 8000;
  // After this many faults of the extension's own making, it stops taking part
  // for the rest of the page. A systematic problem then costs the engaged
  // figures rather than the screen.
  var FAULT_LIMIT = 2;
  var CACHE_TTL_MS = 60000;

  // Native handles are taken at document_start, before Studio's own code runs,
  // so the proxy can issue real requests without re-entering its own patch.
  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;
  var nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var nativeAbort = XMLHttpRequest.prototype.abort;
  var nativeGetAllResponseHeaders = XMLHttpRequest.prototype.getAllResponseHeaders;
  var nativeGetResponseHeader = XMLHttpRequest.prototype.getResponseHeader;

  function enabled() {
    return document.documentElement.getAttribute('data-realview-rewrite') !== 'off';
  }

  // Temporary diagnostic switch: a comma separated list of surfaces to leave
  // alone, so a misbehaving one can be isolated without rebuilding.
  function skipped(name) {
    var list = document.documentElement.getAttribute('data-realview-skip') || '';
    return list.split(',').indexOf(name) !== -1;
  }

  function debugEnabled() {
    return document.documentElement.getAttribute('data-realview-debug') === 'on';
  }

  function log() {
    if (!debugEnabled()) return;
    console.log.apply(console, ['[RealView]'].concat(Array.prototype.slice.call(arguments)));
  }

  // Surfaces whose labels Studio writes itself rather than deriving from the
  // metric are relabelled by the companion content script, but only once this
  // flag says their numbers were really replaced.
  function markConverted(name) {
    document.documentElement.setAttribute('data-realview-converted-' + name, 'yes');
  }

  /* ------------------------------------------------------------ date ids */

  // The analytics API addresses days as YYYYMMDD integers in the channel's own
  // time zone, which Studio sends as an offset in seconds.
  function toDateId(ms, offsetSecs) {
    var d = new Date(ms + offsetSecs * 1000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  function dayRange(startMs, endMs, offsetSecs) {
    return {
      kind: 'days',
      startMs: startMs,
      endMs: endMs,
      inclusiveStart: toDateId(startMs, offsetSecs),
      exclusiveEnd: toDateId(endMs, offsetSecs)
    };
  }

  function seriesRange(datums, offsetSecs) {
    if (!datums || datums.length === 0) return null;
    return dayRange(datums[0].x, datums[datums.length - 1].x + DAY_MS, offsetSecs);
  }

  function previousRange(range, offsetSecs) {
    var span = range.endMs - range.startMs;
    return dayRange(range.startMs - span, range.startMs, offsetSecs);
  }

  // Studio names the selected period in the request, so the engaged figures for
  // a screen can be fetched at the same time as the screen itself rather than
  // after it. The guess is checked against the response and redone if wrong.
  var PERIOD_DAYS = {
    ANALYTICS_TIME_PERIOD_TYPE_DAY: 1,
    ANALYTICS_TIME_PERIOD_TYPE_WEEK: 7,
    ANALYTICS_TIME_PERIOD_TYPE_TWO_WEEKS: 14,
    ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS: 28,
    ANALYTICS_TIME_PERIOD_TYPE_MONTH: 28,
    ANALYTICS_TIME_PERIOD_TYPE_NINETY_DAYS: 90,
    ANALYTICS_TIME_PERIOD_TYPE_THREE_MONTHS: 90,
    ANALYTICS_TIME_PERIOD_TYPE_YEAR: 365,
    ANALYTICS_TIME_PERIOD_TYPE_TWELVE_MONTHS: 365
  };

  function periodRange(timePeriod, offsetSecs) {
    if (!timePeriod) return null;
    var days = PERIOD_DAYS[timePeriod.timePeriodType];
    if (!days) return null;
    // Analytics runs a day behind, so the window ends at the start of today.
    var now = Date.now();
    var todayStart = Math.floor((now + offsetSecs * 1000) / DAY_MS) * DAY_MS - offsetSecs * 1000;
    return dayRange(todayStart - days * DAY_MS, todayStart, offsetSecs);
  }

  function sameRange(a, b) {
    return !!a && !!b && a.inclusiveStart === b.inclusiveStart && a.exclusiveEnd === b.exclusiveEnd;
  }

  /* ------------------------------------------------------- join querying */

  function buildQuery(options) {
    var restricts = options.restricts.slice();
    var query = {
      dimensions: options.dimensions || [],
      metrics: [{ type: TARGET_METRIC }],
      restricts: restricts,
      orders: options.orders || [],
      timeRange: options.range.kind === 'hours'
        ? { unixTimeRange: { inclusiveStart: String(Math.floor(options.range.startMs / 1000)), exclusiveEnd: String(Math.floor(options.range.endMs / 1000)) } }
        : { dateIdRange: { inclusiveStart: options.range.inclusiveStart, exclusiveEnd: options.range.exclusiveEnd } },
      currency: options.currency || 'USD',
      returnDataInNewFormat: true,
      limitedToBatchedData: false
    };
    if (options.limit) query.limit = { pageSize: options.limit, pageOffset: 0 };
    return query;
  }

  // The entity a screen is scoped to decides what the query must be filtered
  // by: a channel restricts on USER, a single video on VIDEO.
  function entityRestricts(entity) {
    if (!entity) return null;
    if (entity.channelId) return [{ dimension: { type: 'USER' }, inValues: [entity.channelId] }];
    if (entity.videoId) return [{ dimension: { type: 'VIDEO' }, inValues: [entity.videoId] }];
    if (entity.playlistId) return [{ dimension: { type: 'PLAYLIST' }, inValues: [entity.playlistId] }];
    return null;
  }

  var faults = 0;

  function fault(reason) {
    faults++;
    log('fault', faults, 'of', FAULT_LIMIT, '-', reason);
    if (faults >= FAULT_LIMIT) log('standing down for the rest of this page; Studio will serve its own figures');
  }

  function standingDown() {
    return faults >= FAULT_LIMIT;
  }

  var cache = new Map();

  function cacheKey(node) {
    return JSON.stringify(node.value.query);
  }

  function cacheGet(key) {
    var hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.result;
  }

  function cacheSet(key, result) {
    cache.set(key, { at: Date.now(), result: result });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }

  function parseResultTable(node) {
    var table = node && node.value && (node.value.resultTable || node.value);
    if (!table || !table.metricColumns || !table.metricColumns.length) return null;
    var column = table.metricColumns[0];
    var values = (column.counts && column.counts.values) || column.values || [];
    var dimension = table.dimensionColumns && table.dimensionColumns[0];
    // A dimension arrives as text for entities, as date ids for a daily series
    // and as timestamps for an hourly one. Rows only cover buckets that have
    // data, so results are matched by label rather than by position.
    var labels = null;
    if (dimension) {
      if (dimension.strings) labels = dimension.strings.values;
      else if (dimension.dateIds) labels = dimension.dateIds.values;
      else if (dimension.timestamps) labels = dimension.timestamps.values;
    }
    return { values: values, labels: labels };
  }

  // Sends every query a surface needs as one request, serves what it can from
  // cache, and gives up rather than holding a screen open past the deadline.
  function runQueries(ctx, nodes) {
    var results = {};
    var pending = [];

    nodes.forEach(function (node) {
      var key = cacheKey(node);
      var hit = cacheGet(key);
      if (hit) results[node.key] = hit;
      else pending.push({ node: node, cacheKey: key });
    });

    if (pending.length === 0) return Promise.resolve(results);

    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        resolve(results);
      }

      var timer = setTimeout(function () {
        fault('query deadline reached');
        finish();
      }, QUERY_DEADLINE_MS);

      var body = {
        nodes: pending.map(function (item) { return item.node; }),
        connectors: [],
        allowFailureResultNodes: true,
        context: ctx.context,
        trackingLabel: 'realview'
      };

      var xhr = new XMLHttpRequest();
      nativeOpen.call(xhr, 'POST', location.origin + JOIN_PATH + '?alt=json', true);
      Object.keys(ctx.headers).forEach(function (name) {
        try { nativeSetRequestHeader.call(xhr, name, ctx.headers[name]); } catch (e) { /* forbidden header */ }
      });
      xhr.withCredentials = true;
      xhr.onload = function () {
        clearTimeout(timer);
        if (xhr.status === 200) {
          try {
            var parsed = JSON.parse(xhr.responseText);
            var answered = parsed.results || parsed.nodes || [];
            answered.forEach(function (node) {
              var table = parseResultTable(node);
              if (!table) return;
              results[node.key] = table;
              var match = null;
              for (var i = 0; i < pending.length; i++) if (pending[i].node.key === node.key) match = pending[i];
              if (match) cacheSet(match.cacheKey, table);
            });
          } catch (e) { log('could not read the query response', e); }
        } else {
          fault('query returned status ' + xhr.status);
        }
        finish();
      };
      xhr.onerror = function () { clearTimeout(timer); fault('query failed'); finish(); };
      nativeSend.call(xhr, JSON.stringify(body));
    });
  }

  /* ---------------------------------------------------- target discovery */

  // Three shapes report views: a key metric tab with a headline total and daily
  // series, a result table with one column per metric, and the sentence printed
  // above the cards.
  function collectTargets(payload) {
    var headline = [];
    var tables = [];
    var headers = [];

    // The realtime card covers the last 48 hours rather than the screen's
    // period, and the video table inside it covers those same hours, so a table
    // is tagged with the card it belongs to.
    function walk(node, depth, realtime) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, realtime);
        return;
      }
      if (node.metric === SOURCE_METRIC && typeof node.total === 'number') headline.push(node);
      if (node.personalizedHeaderCardData && typeof node.personalizedHeaderCardData.title === 'string') {
        headers.push(node.personalizedHeaderCardData);
      }
      if (Array.isArray(node.metricColumns)) {
        for (var c = 0; c < node.metricColumns.length; c++) {
          var column = node.metricColumns[c];
          if (column && column.metric && column.metric.type === SOURCE_METRIC && column.counts) {
            tables.push({ table: node, column: column, realtime: realtime });
          }
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        walk(node[keys[k]], depth + 1, realtime || keys[k] === 'latestActivityCardData');
      }
    }

    walk(payload, 0, false);
    return { headline: headline, tables: tables, headers: headers };
  }

  function tableDimension(table) {
    var columns = table.dimensionColumns;
    // A table broken down by two dimensions at once, such as views per hour per
    // video, cannot be rebuilt from a one-dimensional answer, so it is skipped.
    if (!columns || columns.length !== 1) return null;
    var column = columns[0];
    if (!column || !column.dimension) return null;
    var labels = null;
    if (column.strings) labels = column.strings.values;
    else if (column.timestamps) labels = column.timestamps.values;
    else if (column.dateIds) labels = column.dateIds.values;
    return { type: column.dimension.type, labels: labels };
  }

  // "Your channel got 24 views in the last 7 days" quotes the figure the
  // headline card shows, so it is only touched when the number in it matches
  // the raw total that was just replaced.
  function rewriteHeaderSentence(header, rawTotal, engagedTotal) {
    var match = header.title.match(/([\d,]+)\s+views\b/);
    if (!match) return false;
    if (Number(match[1].replace(/,/g, '')) !== rawTotal) return false;
    header.title = header.title.replace(match[0], engagedTotal.toLocaleString() + ' engaged views');
    return true;
  }

  // The key metric card is the one place where the extension can rename safely:
  // the tab's configured metric and the figure it labels are both in this
  // payload, so they are renamed together and Studio stays consistent.
  function renameTabConfigs(payload) {
    function walk(node, depth) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (node.metricTabConfig && node.metricTabConfig.metric === SOURCE_METRIC) {
        node.metricTabConfig.metric = TARGET_METRIC;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]], depth + 1);
    }
    walk(payload, 0);
  }

  /* --------------------------------------------------------- conversion */

  // Describes every query an analytics payload needs, so they can all be asked
  // for at once.
  function planConversion(payload, ctx) {
    var found = collectTargets(payload);
    var nodes = [];
    var plans = [];

    // The realtime card states its own window through the hours it charts, and
    // the video table beside it covers those same hours. A payload that carries
    // no screen period at all therefore still has a range to work from.
    var hourlyRange = null;
    found.tables.forEach(function (entry) {
      var dimension = tableDimension(entry.table);
      if (!dimension || dimension.type !== 'HOUR' || !dimension.labels || !dimension.labels.length) return;
      var stamps = dimension.labels.map(Number);
      hourlyRange = { kind: 'hours', startMs: stamps[0], endMs: stamps[stamps.length - 1] + HOUR_MS };
    });

    found.headline.forEach(function (content, index) {
      var range = seriesRange(content.mainSeries && content.mainSeries.datums, ctx.offsetSecs);
      if (!range) return;
      var keys = { total: 'rv_total_' + index, series: 'rv_series_' + index, previous: 'rv_prev_' + index };

      nodes.push({ key: keys.total, value: { query: buildQuery({ dimensions: [], range: range, restricts: ctx.restricts, currency: ctx.currency }) } });
      nodes.push({ key: keys.series, value: { query: buildQuery({ dimensions: [{ type: 'DAY' }], range: range, restricts: ctx.restricts, currency: ctx.currency }) } });
      if (typeof content.previousTotal === 'number') {
        nodes.push({
          key: keys.previous,
          value: { query: buildQuery({ dimensions: [], range: previousRange(range, ctx.offsetSecs), restricts: ctx.restricts, currency: ctx.currency }) }
        });
      }
      plans.push({ kind: 'headline', content: content, rawTotal: content.total, keys: keys, headers: found.headers });
    });

    found.tables.forEach(function (entry, index) {
      var dimension = tableDimension(entry.table);
      if (!dimension || !dimension.labels || !dimension.labels.length) return;

      // A table's own dimension tells the range: an hourly chart spans the
      // buckets it draws, everything else follows the screen's period.
      // A realtime table follows the hours its card draws; everything else
      // follows the period the screen was asked for.
      var range = entry.realtime ? hourlyRange : (ctx.range || hourlyRange);
      if (dimension.type === 'HOUR' && dimension.labels.length) {
        var stamps = dimension.labels.map(Number);
        range = { kind: 'hours', startMs: stamps[0], endMs: stamps[stamps.length - 1] + HOUR_MS };
      }
      if (!range) return;

      var key = 'rv_table_' + index;
      var restricts = ctx.restricts.slice();
      var isEntityDimension = dimension.type === 'VIDEO' || dimension.type === 'PLAYLIST';
      if (isEntityDimension) restricts = restricts.concat([{ dimension: { type: dimension.type }, inValues: dimension.labels }]);

      nodes.push({
        key: key,
        value: {
          query: buildQuery({
            dimensions: [{ type: dimension.type }],
            range: range,
            restricts: restricts,
            currency: ctx.currency,
            limit: isEntityDimension ? dimension.labels.length : undefined
          })
        }
      });
      plans.push({ kind: 'table', entry: entry, labels: dimension.labels, key: key });
    });

    return { nodes: nodes, plans: plans, found: found };
  }

  function applyConversion(plan, results, ctx) {
    var changed = false;
    var tablesFound = 0;
    var tablesConverted = 0;

    plan.plans.forEach(function (item) {
      if (item.kind === 'headline') {
        var total = results[item.keys.total];
        if (!total || !total.values.length) return;

        item.content.total = Number(total.values[0]);
        item.content.metric = TARGET_METRIC;
        changed = true;

        item.headers.forEach(function (header) {
          rewriteHeaderSentence(header, item.rawTotal, item.content.total);
        });

        var previous = results[item.keys.previous];
        if (previous && previous.values.length) item.content.previousTotal = Number(previous.values[0]);
        else delete item.content.previousTotal;

        var series = results[item.keys.series];
        var datums = item.content.mainSeries && item.content.mainSeries.datums;
        if (series && series.labels && datums) {
          var byDate = {};
          for (var s = 0; s < series.labels.length; s++) byDate[series.labels[s]] = Number(series.values[s]);
          for (var i = 0; i < datums.length; i++) {
            var dateId = toDateId(datums[i].x, ctx.offsetSecs);
            datums[i].y = Object.prototype.hasOwnProperty.call(byDate, dateId) ? byDate[dateId] : 0;
          }
        } else if (datums) {
          // Without a matching series the chart would still be drawn from raw
          // views under an engaged label, so drop it rather than mislead.
          delete item.content.mainSeries;
        }

        // Both are computed from the raw metric by the server and cannot be
        // recomputed here; the anomaly is the "views are counted differently
        // now" notice, which no longer applies to a converted card.
        delete item.content.typicalPerformanceTotal;
        delete item.content.anomalies;
      }

      if (item.kind === 'table') {
        tablesFound++;
        var result = results[item.key];
        if (!result || !result.labels) return;
        var byLabel = {};
        for (var r = 0; r < result.labels.length; r++) byLabel[String(result.labels[r])] = Number(result.values[r]);
        item.entry.column.counts.values = item.labels.map(function (label) {
          var name = String(label);
          return Object.prototype.hasOwnProperty.call(byLabel, name) ? byLabel[name] : 0;
        });
        // The metric keeps its name. Studio matches a card's configured metric
        // against the columns it receives, and a column it cannot find makes it
        // discard the whole screen, so only the numbers change here and the
        // wording is corrected in the page instead.
        tablesConverted++;
        changed = true;
      }
    });

    // Only claim the wording is safe to change when every table on the screen
    // really was converted; a half-converted screen keeps Studio's own labels.
    if (tablesFound > 0 && tablesFound === tablesConverted) markConverted('analytics');

    return changed;
  }

  function convertAnalytics(payload, ctx, prefetch) {
    var plan = planConversion(payload, ctx);
    if (plan.nodes.length === 0) return Promise.resolve(false);

    var source = prefetch ? prefetch.promise : runQueries(ctx, plan.nodes);

    return source.then(function (results) {
      // A speculative prefetch only answers the queries it guessed; anything
      // still missing is asked for now.
      var missing = plan.nodes.filter(function (node) { return !results[node.key]; });
      if (missing.length === 0) return results;
      return runQueries(ctx, missing).then(function (extra) {
        Object.keys(extra).forEach(function (key) { results[key] = extra[key]; });
        return results;
      });
    }).then(function (results) {
      var changed = applyConversion(plan, results, ctx);
      if (changed) renameTabConfigs(payload);
      log('analytics converted', { headlines: plan.found.headline.length, tables: plan.found.tables.length, changed: changed });
      return changed;
    });
  }

  /* ------------------------------------------- the content tab's video list */

  // The video list reports a lifetime count per video and exposes no engaged
  // figure at all, so each page of it is looked up by video id.
  function convertVideoList(payload, ctx) {
    var videos = payload.videos;
    if (!Array.isArray(videos) || videos.length === 0) return Promise.resolve(false);

    var ids = [];
    videos.forEach(function (video) {
      if (video && video.videoId && (video.publicMetrics || video.metrics)) ids.push(video.videoId);
    });
    if (ids.length === 0) return Promise.resolve(false);

    var channelId = ctx.channelId || (videos[0] && videos[0].channelId);
    var restricts = [];
    if (channelId) restricts.push({ dimension: { type: 'USER' }, inValues: [channelId] });
    restricts.push({ dimension: { type: 'VIDEO' }, inValues: ids });

    var node = {
      key: 'rv_lifetime',
      value: {
        query: buildQuery({
          dimensions: [{ type: 'VIDEO' }],
          range: { kind: 'days', inclusiveStart: 20050101, exclusiveEnd: toDateId(Date.now() + DAY_MS, 0) },
          restricts: restricts,
          currency: ctx.currency,
          limit: ids.length
        })
      }
    };

    return runQueries(ctx, [node]).then(function (results) {
      var table = results.rv_lifetime;
      if (!table || !table.labels) return false;

      var byId = {};
      for (var i = 0; i < table.labels.length; i++) byId[table.labels[i]] = String(table.values[i]);

      var changed = false;
      videos.forEach(function (video) {
        if (!video || !Object.prototype.hasOwnProperty.call(byId, video.videoId)) return;
        var engaged = byId[video.videoId];
        if (video.publicMetrics) {
          if (video.publicMetrics.viewCount !== undefined) video.publicMetrics.viewCount = engaged;
          if (video.publicMetrics.externalViewCount !== undefined) video.publicMetrics.externalViewCount = engaged;
          changed = true;
        }
        if (video.metrics && video.metrics.viewCount !== undefined) {
          video.metrics.viewCount = engaged;
          changed = true;
        }
      });

      if (changed) markConverted('videolist');
      log('video list converted', { videos: ids.length, changed: changed });
      return changed;
    });
  }

  /* ------------------------------------------------------------- proxying */

  function requestContext(xhr, requestBody) {
    var parsed;
    try { parsed = JSON.parse(requestBody); } catch (e) { return null; }
    if (!parsed.context) return null;

    var config = parsed.screenConfig || {};
    var entity = config.entity || {};
    return {
      context: parsed.context,
      headers: xhr.__realViewHeaders || {},
      currency: config.currency || 'USD',
      offsetSecs: typeof config.timeZoneOffsetSecs === 'number' ? config.timeZoneOffsetSecs : 0,
      entity: entity,
      channelId: entity.channelId || null,
      restricts: entityRestricts(entity) || [],
      timePeriod: config.timePeriod || null,
      range: null
    };
  }

  // Completes a request by hand once its payload has been rewritten, walking
  // the same state sequence the platform would have.
  function deliver(xhr, source, text) {
    if (xhr.__realViewDelivered) return;
    xhr.__realViewDelivered = true;

    var responseValue = text;
    if (xhr.responseType === 'json') {
      try { responseValue = JSON.parse(text); } catch (e) { responseValue = null; }
    } else if (xhr.responseType && xhr.responseType !== 'text') {
      responseValue = source.response;
    }

    var props = {
      status: source.status,
      statusText: source.statusText,
      responseURL: source.responseURL,
      response: responseValue
    };
    // responseText is supplied whatever the response type asked for. A real
    // XMLHttpRequest refuses to hand it over for a json response, but a reader
    // that asks for it anyway should get the body rather than an empty string.
    props.responseText = text;

    function define(name, value) {
      try { Object.defineProperty(xhr, name, { configurable: true, value: value }); } catch (e) {}
    }

    Object.keys(props).forEach(function (key) { define(key, props[key]); });
    xhr.getAllResponseHeaders = function () { return nativeGetAllResponseHeaders.call(source); };
    xhr.getResponseHeader = function (name) { return nativeGetResponseHeader.call(source, name); };

    var size = typeof text === 'string' ? text.length : 0;
    function fire(type, event) { try { xhr.dispatchEvent(event || new Event(type)); } catch (e) {} }

    // Only the finished state is announced. Reporting the intermediate states
    // as well would hand the whole body to a reader that accumulates chunks,
    // and it would count the payload twice.
    define('readyState', 4);
    fire('readystatechange');
    fire('load', new ProgressEvent('load', { lengthComputable: true, loaded: size, total: size }));
    fire('loadend', new ProgressEvent('loadend', { lengthComputable: true, loaded: size, total: size }));
  }

  function relay(xhr, source) {
    var text = '';
    try { text = source.responseText; } catch (e) { text = ''; }
    deliver(xhr, source, text);
  }

  // Runs the real request on a second object, rewrites what comes back, and
  // completes the caller's request with the result. Any failure at all falls
  // back to the untouched response.
  function proxy(xhr, body, rewriteBody, convert) {
    var ctx = requestContext(xhr, body);
    if (!ctx) { nativeSend.call(xhr, body); return; }

    var prefetch = null;
    if (convert.prefetch) {
      try { prefetch = convert.prefetch(ctx); } catch (e) { log('prefetch failed', e); }
    }

    var source = new XMLHttpRequest();
    xhr.__realViewSource = source;
    nativeOpen.call(source, xhr.__realViewMethod || 'POST', xhr.__realViewUrl, true);
    Object.keys(ctx.headers).forEach(function (name) {
      try { nativeSetRequestHeader.call(source, name, ctx.headers[name]); } catch (e) {}
    });
    source.withCredentials = true;

    source.onload = function () {
      var text = source.responseText;

      // The response is in, so from here the only thing that could still delay
      // the caller is this extension. Guarantee an answer either way.
      setTimeout(function () {
        if (xhr.__realViewDelivered) return;
        fault('conversion never finished');
        relay(xhr, source);
      }, WATCHDOG_MS);

      if (source.status !== 200) { relay(xhr, source); return; }

      var payload;
      try { payload = JSON.parse(text); } catch (e) { relay(xhr, source); return; }

      var work;
      try { work = convert.run(payload, ctx, prefetch); } catch (e) { fault('conversion threw: ' + e); relay(xhr, source); return; }

      work.then(function (changed) {
        deliver(xhr, source, changed ? JSON.stringify(payload) : text);
      }).catch(function (error) {
        fault('conversion failed: ' + error);
        relay(xhr, source);
      });
    };

    // A transport failure is handed on as-is so Studio's own retry and error
    // handling behave exactly as they would without the extension.
    source.onerror = function () { relay(xhr, source); };
    source.ontimeout = function () { relay(xhr, source); };

    // Whatever happens above, the caller is completed. Without this a single
    // unforeseen failure anywhere in the conversion would leave a Studio screen
    // waiting for a response that never arrives.
    setTimeout(function () {
      if (xhr.__realViewDelivered) return;
      if (source.readyState === 4) { fault('watchdog had to deliver the untouched response'); relay(xhr, source); return; }
      log('watchdog: the request itself is still outstanding, leaving it alone');
    }, WATCHDOG_MS);

    nativeSend.call(source, rewriteBody ? rewriteBody(body, ctx) : body);
  }

  /* --------------------------------------------------------- entry points */

  function restoreMetric(text) {
    return text.split('"' + TARGET_METRIC + '"').join('"' + SOURCE_METRIC + '"');
  }

  var analyticsConverter = {
    // The screen's period is known before its response arrives, so the engaged
    // figures for the headline card are requested at the same time rather than
    // afterwards. Anything the guess misses is filled in later.
    prefetch: function (ctx) {
      var range = periodRange(ctx.timePeriod, ctx.offsetSecs);
      if (!range || !ctx.restricts.length) return null;
      ctx.range = range;
      var nodes = [
        { key: 'rv_total_0', value: { query: buildQuery({ dimensions: [], range: range, restricts: ctx.restricts, currency: ctx.currency }) } },
        { key: 'rv_series_0', value: { query: buildQuery({ dimensions: [{ type: 'DAY' }], range: range, restricts: ctx.restricts, currency: ctx.currency }) } },
        { key: 'rv_prev_0', value: { query: buildQuery({ dimensions: [], range: previousRange(range, ctx.offsetSecs), restricts: ctx.restricts, currency: ctx.currency }) } }
      ];
      return { range: range, promise: runQueries(ctx, nodes) };
    },
    run: function (payload, ctx, prefetch) {
      // The response states the dates it actually covers, which settles any
      // disagreement with the range that was guessed from the request. A guess
      // that turns out wrong is discarded rather than used.
      var probe = collectTargets(payload);
      var answered = probe.headline.length
        ? seriesRange(probe.headline[0].mainSeries && probe.headline[0].mainSeries.datums, ctx.offsetSecs)
        : null;

      ctx.range = answered || periodRange(ctx.timePeriod, ctx.offsetSecs) || ctx.range;

      var usable = prefetch && answered && sameRange(prefetch.range, answered) ? prefetch : null;
      if (prefetch && !usable) log('the guessed period did not match the response, querying again');
      return convertAnalytics(payload, ctx, usable);
    }
  };

  // The card request already returns engaged figures for everything except its
  // realtime card, so there is nothing worth guessing ahead of time.
  var cardsConverter = { run: analyticsConverter.run };

  var videoListConverter = {
    run: function (payload, ctx) { return convertVideoList(payload, ctx); }
  };

  function isVideoListUrl(url) {
    for (var i = 0; i < VIDEO_LIST_PATHS.length; i++) if (url.indexOf(VIDEO_LIST_PATHS[i]) !== -1) return true;
    return false;
  }

  /* -------------------------------------------------------------- patches */

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__realViewMethod = method;
    this.__realViewUrl = String(url);
    this.__realViewHeaders = {};
    this.__realViewDelivered = false;
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__realViewHeaders) this.__realViewHeaders[name] = value;
    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.abort = function () {
    if (this.__realViewSource) { try { nativeAbort.call(this.__realViewSource); } catch (e) {} }
    return nativeAbort.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // Fail open. Anything unexpected in here must end with Studio's request
    // going out untouched rather than with an exception thrown into Studio's
    // own networking code, which would leave the screen waiting forever.
    try {
      return route(this, body, arguments);
    } catch (error) {
      log('routing failed, sending the request untouched', error);
      return nativeSend.apply(this, arguments);
    }
  };

  function route(xhr, body, args) {
    var url = xhr.__realViewUrl || '';

    if (!enabled() || standingDown() || typeof body !== 'string') return nativeSend.apply(xhr, args);

    // The dashboard's own queries name their metric, so they only need the
    // metric swapped on the way out and restored on the way in. Queries this
    // extension issues carry their own label and are left alone.
    var namesItsOwnMetric = url.indexOf(JOIN_PATH) !== -1 || url.indexOf(DASHBOARD_PATH) !== -1;
    if (namesItsOwnMetric && !skipped('join')) {
      var ours = body.indexOf('"realview"') !== -1;
      var hasSource = body.indexOf('"' + SOURCE_METRIC + '"') !== -1;
      // A query that already asks for both metrics would end up with a
      // duplicate column, and renaming its answer back would be ambiguous.
      var mixed = body.indexOf('"' + TARGET_METRIC + '"') !== -1;
      if (ours || !hasSource || mixed) return nativeSend.apply(xhr, args);

      var textDescriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      var responseDescriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get: function () {
          var raw = textDescriptor.get.call(xhr);
          return typeof raw === 'string' ? restoreMetric(raw) : raw;
        }
      });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get: function () {
          var raw = responseDescriptor.get.call(xhr);
          return typeof raw === 'string' ? restoreMetric(raw) : raw;
        }
      });
      markConverted('dashboard');
      log('dashboard query converted');
      return nativeSend.call(xhr, body.split('"' + SOURCE_METRIC + '"').join('"' + TARGET_METRIC + '"'));
    }

    // The card request names the metrics its cards should use, so asking for
    // the engaged one is enough; only its realtime card needs substituting.
    if (url.indexOf(CARDS_PATH) !== -1 && !skipped('cards')) return proxy(xhr, body, null, cardsConverter);

    if (url.indexOf(SCREEN_PATH) !== -1 && !skipped('screen')) return proxy(xhr, body, null, analyticsConverter);

    if (isVideoListUrl(url) && !skipped('videos')) return proxy(xhr, body, null, videoListConverter);

    return nativeSend.apply(xhr, args);
  }

})();
