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
  // How long a screen may spend on queries in total, retries included. A batch
  // that fails fast leaves room to try again; one that hangs does not. A screen
  // asking about a dozen tables is given more room than one asking about two.
  var QUERY_BUDGET_BASE_MS = 5000;
  var QUERY_BUDGET_PER_QUERY_MS = 250;
  var QUERY_BUDGET_CAP_MS = 10000;

  function queryBudget(count) {
    return Math.min(QUERY_BUDGET_CAP_MS, QUERY_BUDGET_BASE_MS + count * QUERY_BUDGET_PER_QUERY_MS);
  }
  // The backstop for the whole conversion, not just one query.
  var WATCHDOG_MS = 15000;
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
    if (document.documentElement.getAttribute('data-realview-converted-' + name) === 'no') return;
    document.documentElement.setAttribute('data-realview-converted-' + name, 'yes');
  }

  // A card can arrive after the screen it belongs to, so a later response that
  // leaves figures raw has to be able to withdraw the verdict of an earlier one.
  function markUnconverted(name) {
    document.documentElement.setAttribute('data-realview-converted-' + name, 'no');
  }

  /* ------------------------------------------------------------ date ids */

  // The analytics API addresses days as YYYYMMDD integers in the channel's own
  // time zone, which Studio sends as an offset in seconds.
  function toDateId(ms, offsetSecs) {
    var d = new Date(ms + offsetSecs * 1000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  function dateIdToMs(id) {
    var year = Math.floor(id / 10000);
    var month = Math.floor((id % 10000) / 100);
    var day = id % 100;
    return Date.UTC(year, month - 1, day);
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

  function lifetimeRange() {
    return { kind: 'days', inclusiveStart: 20050101, exclusiveEnd: toDateId(Date.now() + DAY_MS, 0) };
  }

  function startOfToday(offsetSecs) {
    return Math.floor((Date.now() + offsetSecs * 1000) / DAY_MS) * DAY_MS - offsetSecs * 1000;
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
  // Studio publishes the channel being worked on, which a video or playlist
  // screen does not otherwise mention.
  function currentChannelId() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        var id = window.ytcfg.get('CHANNEL_ID');
        if (id) return id;
      }
      if (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.CHANNEL_ID) return window.ytcfg.data_.CHANNEL_ID;
    } catch (e) { /* not available on this page */ }
    var match = location.pathname.match(/\/channel\/([^/]+)/);
    return match ? match[1] : null;
  }

  function entityRestricts(entity) {
    if (!entity) return null;
    if (entity.channelId) return [{ dimension: { type: 'USER' }, inValues: [entity.channelId] }];

    // A video or playlist is restricted by the channel as well. The server
    // rejects some queries that name only the entity.
    var channelId = currentChannelId();
    var owner = channelId ? [{ dimension: { type: 'USER' }, inValues: [channelId] }] : [];
    if (entity.videoId) return owner.concat([{ dimension: { type: 'VIDEO' }, inValues: [entity.videoId] }]);
    if (entity.playlistId) return owner.concat([{ dimension: { type: 'PLAYLIST' }, inValues: [entity.playlistId] }]);
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
    return hit.promise;
  }

  function cacheSet(key, promise) {
    cache.set(key, { at: Date.now(), promise: promise });
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
    var labels = dimension ? columnLabels(dimension) : null;

    var columns = (table.dimensionColumns || []).map(function (each) {
      return { type: each.dimension && each.dimension.type, labels: columnLabels(each) || [] };
    });

    return { values: values, labels: labels, columns: columns };
  }

  // Sends every query a surface needs as one request, and remembers each one by
  // the question it asks rather than by the name the caller gave it. A query
  // asked for twice - by the guess made ahead of a screen and again by the
  // screen itself - is therefore only ever sent once, and a guess that turns
  // out not to match simply goes unused.
  function runQueries(ctx, nodes) {
    var pending = [];
    var waits = [];

    nodes.forEach(function (node) {
      var key = cacheKey(node);
      var hit = cacheGet(key);
      if (hit) {
        waits.push(hit.then(function (table) { return { key: node.key, table: table }; }));
        return;
      }
      var resolve;
      var promise = new Promise(function (r) { resolve = r; });
      cacheSet(key, promise);
      pending.push({ node: node, resolve: resolve });
      waits.push(promise.then(function (table) { return { key: node.key, table: table }; }));
    });

    if (pending.length) sendBatch(ctx, pending, 0, Date.now() + queryBudget(pending.length));

    return Promise.all(waits).then(function (answers) {
      var results = {};
      answers.forEach(function (answer) {
        if (answer.table) results[answer.key] = answer.table;
      });
      return results;
    });
  }

  // A query the server will not accept fails the whole request it travels in,
  // so when a batch comes back with anything missing the stragglers are asked
  // for again one at a time. One unsupported query then costs only itself.
  function sendBatch(ctx, pending, stage, until) {
    var settled = false;
    function finish(byKey) {
      if (settled) return;
      settled = true;

      var missing = pending.filter(function (item) { return !byKey || !byKey[item.node.key]; });
      var answered = pending.filter(function (item) { return byKey && byKey[item.node.key]; });
      answered.forEach(function (item) { item.resolve(byKey[item.node.key]); });

      if (!missing.length) return;

      // First the stragglers go out together, in case the batch simply did not
      // arrive. Only then are they split up, which is what finds the single
      // query the server will not accept.
      var timeLeft = until - Date.now() > 500;
      if (timeLeft && stage === 0 && missing.length < pending.length) {
        log('retrying', missing.length, 'queries together');
        sendBatch(ctx, missing, 1, until);
        return;
      }
      if (timeLeft && stage < 2 && missing.length > 1) {
        log('retrying', missing.length, 'queries on their own');
        missing.forEach(function (item) { sendBatch(ctx, [item], 2, until); });
        return;
      }
      missing.forEach(function (item) { item.resolve(null); });
    }

    var remaining = Math.max(500, until - Date.now());
    var timer = setTimeout(function () {
      // Being slow is not the same as being broken: the figures are simply not
      // ready, and the screen is served as Studio sent it.
      log('gave up waiting on', pending.length, 'queries');
      finish(null);
    }, remaining);

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
      var byKey = {};
      if (xhr.status === 200) {
        try {
          var parsed = JSON.parse(xhr.responseText);
          var answered = parsed.results || parsed.nodes || [];
          answered.forEach(function (node) {
            var table = parseResultTable(node);
            if (table) byKey[node.key] = table;
          });
        } catch (e) { log('could not read the query response', e); }
      } else {
        fault('query returned status ' + xhr.status);
      }
      finish(byKey);
    };
    xhr.onerror = function () { clearTimeout(timer); fault('query failed'); finish(null); };
    nativeSend.call(xhr, JSON.stringify(body));
  }

  /* ---------------------------------------------------- target discovery */

  // Three shapes report views: a key metric tab with a headline total and daily
  // series, a result table with one column per metric, and the sentence printed
  // above the cards.
  function collectTargets(payload) {
    var headline = [];
    var tables = [];
    var headers = [];
    var entities = [];
    var rankings = [];

    // The realtime card covers the last 48 hours rather than the screen's
    // period, and the video table inside it covers those same hours, so a table
    // is tagged with the card it belongs to.
    function walk(node, depth, realtime, contentType) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, realtime, contentType);
        return;
      }

      // A card can repeat the same breakdown for each kind of content, one
      // table per tab, and names the kind alongside the table rather than
      // inside it.
      if (typeof node.contentType === 'string') contentType = node.contentType;
      if (node.metric === SOURCE_METRIC && typeof node.total === 'number') headline.push(node);

      // Some cards carry a plain view count for a video alongside their own
      // figures - the retention curve is one - rather than a metric column.
      if (typeof node.videoId === 'string' && node.metricTotals && typeof node.metricTotals.views === 'number') {
        entities.push({
          videoId: node.videoId,
          apply: (function (totals) { return function (value) { totals.views = value; }; })(node.metricTotals),
          holder: node.metricTotals
        });
      }

      // The latest-video card ranks the video against recent uploads, each
      // entry naming a video and its figure over the same span since publishing.
      if (node.ranking && Array.isArray(node.ranking.entities) && node.ranking.entities.length) {
        var ranked = node.ranking.entities.filter(function (item) {
          return item && item.entity && typeof item.entity.videoId === 'string' &&
            item.metric && item.metric.type === SOURCE_METRIC &&
            item.value && typeof item.value.double === 'number';
        });
        // The card around the ranking compares its video against the same
        // videos, so it is kept alongside for its comparison to be redone
        // from the same figures.
        if (ranked.length === node.ranking.entities.length) rankings.push({ ranking: node.ranking, holder: node });
      }

      // The latest-video card reports each of its metrics as a row of its own,
      // naming the video once at the top.
      if (node.video && typeof node.video.externalVideoId === 'string' && node.metricsTable && Array.isArray(node.metricsTable.metricRows)) {
        var snapshotId = node.video.externalVideoId;
        node.metricsTable.metricRows.forEach(function (row) {
          if (!row.metric || row.metric.type !== SOURCE_METRIC || !row.value || typeof row.value.double !== 'number') return;
          entities.push({
            videoId: snapshotId,
            apply: (function (target) { return function (value) { target.value.double = value; }; })(row),
            holder: row
          });
        });
      }
      if (node.personalizedHeaderCardData && typeof node.personalizedHeaderCardData.title === 'string') {
        headers.push(node.personalizedHeaderCardData);
      }
      if (Array.isArray(node.metricColumns)) {
        for (var c = 0; c < node.metricColumns.length; c++) {
          var column = node.metricColumns[c];
          if (column && column.metric && column.metric.type === SOURCE_METRIC && (column.counts || column.percentages)) {
            tables.push({ table: node, column: column, realtime: realtime, contentType: contentType });
          }
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        walk(node[keys[k]], depth + 1, realtime || keys[k] === 'latestActivityCardData', contentType);
      }
    }

    walk(payload, 0, false, null);
    return { headline: headline, tables: tables, headers: headers, entities: entities, rankings: rankings };
  }

  // The gap between the first two buckets gives the granularity, so an hourly
  // chart and a minute-by-minute one are both covered exactly.
  function timestampRange(labels) {
    var stamps = labels.map(Number);
    var bucket = stamps.length > 1 ? stamps[1] - stamps[0] : HOUR_MS;
    return { kind: 'hours', startMs: stamps[0], endMs: stamps[stamps.length - 1] + bucket };
  }

  function columnLabels(column) {
    if (!column) return null;
    if (column.strings) return column.strings.values;
    if (column.timestamps) return column.timestamps.values;
    if (column.dateIds) return column.dateIds.values;
    if (column.enumValues) return column.enumValues.values;
    return null;
  }

  // A table listing sources and their details together: "YouTube recommendations"
  // with "YouTube Home" and "Up next" beneath it. The server will not answer a
  // query for both at once, but it will answer each on its own, and a detail
  // belongs to exactly one source, so the two answers rebuild the table.
  function sourceHierarchy(table) {
    var columns = table.dimensionColumns;
    if (!columns || columns.length !== 2) return null;

    var types = null;
    var details = null;
    for (var i = 0; i < columns.length; i++) {
      var type = columns[i].dimension && columns[i].dimension.type;
      if (type === 'TRAFFIC_SOURCE_TYPE') types = columnLabels(columns[i]);
      if (type === 'TRAFFIC_SOURCE_DETAIL') details = columnLabels(columns[i]);
    }
    if (!types || !details || types.length !== details.length || !types.length) return null;
    return { types: types, details: details };
  }

  // The server answers a query split by more than one dimension for most
  // pairings, so a table like age against gender can be rebuilt by matching
  // each row on the whole set of names that identify it. Two exceptions stand:
  // a run of time buckets split by something else is a sparkline, too large and
  // pointless to rebuild, and traffic sources against their details are refused
  // outright, which the hierarchy path handles instead.
  function tableDimensions(table) {
    var columns = table.dimensionColumns;
    if (!columns || !columns.length) return null;

    var described = [];
    for (var i = 0; i < columns.length; i++) {
      var column = columns[i];
      if (!column || !column.dimension || !column.dimension.type) return null;
      var labels = columnLabels(column);
      if (!labels || !labels.length) return null;
      described.push({ type: column.dimension.type, labels: labels, time: !!(column.timestamps || column.dateIds) });
    }

    if (described.length > 1 && described.some(function (d) { return d.time; })) return null;
    return described;
  }

  // Row keys join every name that identifies the row, so a two-way table maps
  // by the pair rather than by either half.
  function rowKeys(described) {
    var count = described[0].labels.length;
    var keys = [];
    for (var row = 0; row < count; row++) {
      var parts = [];
      for (var d = 0; d < described.length; d++) parts.push(String(described[d].labels[row]));
      keys.push(parts.join('\u0000'));
    }
    return keys;
  }

  function answerKeys(table, described) {
    if (!table.columns) return null;
    var ordered = [];
    for (var d = 0; d < described.length; d++) {
      var match = null;
      for (var c = 0; c < table.columns.length; c++) if (table.columns[c].type === described[d].type) match = table.columns[c];
      if (!match) return null;
      ordered.push(match.labels);
    }
    var keys = [];
    for (var row = 0; row < ordered[0].length; row++) {
      var parts = [];
      for (var i = 0; i < ordered.length; i++) parts.push(String(ordered[i][row]));
      keys.push(parts.join('\u0000'));
    }
    return keys;
  }

  // Each tab of a by-content-type card is a table of its own, and the figures
  // behind it cover that kind of content alone. The query names the kind the
  // way the analytics backend does, which is not the way the card does.
  var CONTENT_TYPE_VALUES = {
    CONTENT_ANALYSIS_TYPE_ALL_CONTENT: null,
    CONTENT_ANALYSIS_TYPE_VIDEO: 'VIDEO_ON_DEMAND',
    CONTENT_ANALYSIS_TYPE_SHORTS: 'SHORTS',
    CONTENT_ANALYSIS_TYPE_LIVE_STREAMS: 'LIVE_STREAM'
  };

  // Returns the restricts a table's query needs, or null for a kind of content
  // this does not know how to ask about - a podcast tab, say - in which case
  // the table is left raw rather than filled with the whole channel's figures.
  function contentTypeRestricts(ctx, entry) {
    if (!entry.contentType) return ctx.restricts;
    if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPE_VALUES, entry.contentType)) return null;
    var value = CONTENT_TYPE_VALUES[entry.contentType];
    if (!value) return ctx.restricts;
    return ctx.restricts.concat([{ dimension: { type: 'CREATOR_CONTENT_TYPE' }, inValues: [value] }]);
  }

  function tableDimension(table) {
    var columns = table.dimensionColumns;
    if (!columns || columns.length !== 1) return null;
    var column = columns[0];
    if (!column || !column.dimension) return null;
    // A traffic source, device type and the like arrive as enumerated names.
    return { type: column.dimension.type, labels: columnLabels(column), timestamps: !!column.timestamps };
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
      if (!dimension || !dimension.timestamps || !dimension.labels || !dimension.labels.length) return;
      hourlyRange = timestampRange(dimension.labels);
    });

    found.headline.forEach(function (content, index) {
      var range = seriesRange(content.mainSeries && content.mainSeries.datums, ctx.offsetSecs);
      if (!range) return;
      var keys = { total: 'rv_total_' + index, series: 'rv_series_' + index, previous: 'rv_prev_' + index };
      var cumulative = !!(content.mainSeries && content.mainSeries.isCumulative);

      if (cumulative) {
        // A chart that runs to this moment is rebuilt from time buckets rather
        // than from a single total, so the line and the figure above it are the
        // same arithmetic and cannot disagree.
        //
        // The buckets have to be at least as fine as the chart's own points: a
        // "since published" chart draws several points inside one day, and a
        // day-sized bucket cannot say how much of that day had accrued by each
        // of them. Hours are used for a window short enough to make that
        // sensible, and days plus today's hours for anything longer, since the
        // daily store trails the live one by hours - most of a new video's
        // views.
        var todayStart = startOfToday(ctx.offsetSecs);
        var liveStart = Math.min(Math.floor(range.startMs / HOUR_MS) * HOUR_MS, todayStart);
        var liveEnd = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;

        if (Date.now() - range.startMs <= HOURLY_WINDOW_LIMIT_MS) {
          keys.hours = 'rv_hours_' + index;
          nodes.push({
            key: keys.hours,
            value: { query: buildQuery({ dimensions: [{ type: 'HOUR' }], range: { kind: 'hours', startMs: liveStart, endMs: liveEnd }, restricts: ctx.restricts, currency: ctx.currency }) }
          });
        } else {
          keys.days = 'rv_days_' + index;
          nodes.push({
            key: keys.days,
            value: { query: buildQuery({ dimensions: [{ type: 'DAY' }], range: dayRange(range.startMs, todayStart, ctx.offsetSecs), restricts: ctx.restricts, currency: ctx.currency }) }
          });
          if (liveEnd > todayStart) {
            keys.hours = 'rv_hours_' + index;
            nodes.push({
              key: keys.hours,
              value: { query: buildQuery({ dimensions: [{ type: 'HOUR' }], range: { kind: 'hours', startMs: todayStart, endMs: liveEnd }, restricts: ctx.restricts, currency: ctx.currency }) }
            });
          }
        }
      }

      // Kept as a fallback for a cumulative card whose buckets are refused.
      nodes.push({ key: keys.total, value: { query: buildQuery({ dimensions: [], range: range, restricts: ctx.restricts, currency: ctx.currency }) } });
      if (!cumulative) {
        nodes.push({ key: keys.series, value: { query: buildQuery({ dimensions: [{ type: 'DAY' }], range: range, restricts: ctx.restricts, currency: ctx.currency }) } });
      }

      if (typeof content.previousTotal === 'number') {
        nodes.push({
          key: keys.previous,
          value: { query: buildQuery({ dimensions: [], range: previousRange(range, ctx.offsetSecs), restricts: ctx.restricts, currency: ctx.currency }) }
        });
      }
      if (content.typicalPerformanceTotal) {
        var typicalNode = typicalHistoryNode('rv_typical_' + index, ctx, range);
        if (typicalNode) {
          nodes.push(typicalNode);
          keys.typical = typicalNode.key;
        }
      }

      plans.push({
        kind: 'headline',
        content: content,
        rawTotal: content.total,
        range: range,
        cumulative: cumulative,
        keys: keys,
        headers: found.headers
      });
    });

    found.tables.forEach(function (entry, index) {
      // A dashboard column was answered by a query whose metric was swapped on
      // the way out, so it already holds engaged figures over the window the
      // server chose for it. Asking again would swap that window for the
      // screen's own and overwrite the right figures with wrong ones.
      if (ctx.preConverted && ctx.preConverted.indexOf(entry.column) !== -1) return;

      var scoped = contentTypeRestricts(ctx, entry);
      if (!scoped) { log('left raw: a', entry.contentType, 'table, which cannot be asked for'); return; }

      var hierarchy = sourceHierarchy(entry.table);
      if (hierarchy) {
        var pairRange = entry.realtime ? hourlyRange : (ctx.range || hourlyRange);
        if (!pairRange) return;

        var typeKey = 'rv_pairs_' + index + '_type';
        nodes.push({
          key: typeKey,
          value: { query: buildQuery({ dimensions: [{ type: 'TRAFFIC_SOURCE_TYPE' }], range: pairRange, restricts: scoped, currency: ctx.currency }) }
        });

        var prefixes = {};
        hierarchy.details.forEach(function (label) {
          var name = String(label || '');
          if (!name) return;
          prefixes[name.split('.')[0]] = true;
        });
        var detailKeys = Object.keys(prefixes).map(function (prefix, part) {
          var key = 'rv_pairs_' + index + '_detail' + part;
          nodes.push({
            key: key,
            value: {
              query: buildQuery({
                dimensions: [{ type: 'TRAFFIC_SOURCE_DETAIL' }],
                range: pairRange,
                restricts: scoped.concat([{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, inValues: [prefix] }]),
                currency: ctx.currency,
                limit: Math.max(hierarchy.details.length, 25)
              })
            }
          });
          return key;
        });

        plans.push({ kind: 'pairs', entry: entry, hierarchy: hierarchy, typeKey: typeKey, detailKeys: detailKeys });
        return;
      }

      var described = tableDimensions(entry.table);
      if (described && described.length > 1) {
        var wideRange = entry.realtime ? hourlyRange : (ctx.range || hourlyRange);
        if (!wideRange) return;
        // A two-way table has as many rows as the pairings that occurred, so
        // the page has to be asked for large enough to hold all of them.
        var wideRestricts = scoped.slice();
        described.forEach(function (d) {
          if (d.type === 'VIDEO' || d.type === 'PLAYLIST') {
            wideRestricts = wideRestricts.concat([{ dimension: { type: d.type }, inValues: d.labels }]);
          }
        });

        var wideKey = 'rv_wide_' + index;
        nodes.push({
          key: wideKey,
          value: {
            query: buildQuery({
              dimensions: described.map(function (d) { return { type: d.type }; }),
              range: wideRange,
              restricts: wideRestricts,
              currency: ctx.currency,
              limit: Math.max(described[0].labels.length, 50)
            })
          }
        });
        plans.push({ kind: 'wide', entry: entry, described: described, keys: [wideKey] });
        return;
      }

      var dimension = tableDimension(entry.table);
      if (!dimension || !dimension.labels || !dimension.labels.length) return;

      // A table's own dimension tells the range: an hourly chart spans the
      // buckets it draws, everything else follows the screen's period.
      // A realtime table follows the hours its card draws; everything else
      // follows the period the screen was asked for.
      var range = entry.realtime ? hourlyRange : (ctx.range || hourlyRange);
      if (dimension.timestamps && dimension.labels.length) range = timestampRange(dimension.labels);
      if (!range) return;

      var restricts = scoped.slice();
      var isEntityDimension = dimension.type === 'VIDEO' || dimension.type === 'PLAYLIST';
      if (isEntityDimension) restricts = restricts.concat([{ dimension: { type: dimension.type }, inValues: dimension.labels }]);

      // Traffic source detail - a search term, a linking site - is only
      // answered when the query says which kind of source it belongs to. The
      // row names carry that as a prefix, so they are grouped by it and asked
      // for a group at a time.
      var groups = [{ restricts: restricts, rows: dimension.labels }];
      if (dimension.type === 'TRAFFIC_SOURCE_DETAIL') {
        var byPrefix = {};
        dimension.labels.forEach(function (label) {
          var prefix = String(label).split('.')[0];
          (byPrefix[prefix] = byPrefix[prefix] || []).push(label);
        });
        groups = Object.keys(byPrefix).map(function (prefix) {
          return {
            restricts: restricts.concat([{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, inValues: [prefix] }]),
            rows: byPrefix[prefix]
          };
        });
      }

      var keys = groups.map(function (group, part) {
        var key = 'rv_table_' + index + '_' + part;
        nodes.push({
          key: key,
          value: {
            query: buildQuery({
              dimensions: [{ type: dimension.type }],
              range: range,
              restricts: group.restricts,
              currency: ctx.currency,
              limit: isEntityDimension || dimension.type === 'TRAFFIC_SOURCE_DETAIL' ? Math.max(group.rows.length, 25) : undefined
            })
          }
        });
        return key;
      });

      plans.push({ kind: 'table', entry: entry, labels: dimension.labels, keys: keys });
    });

    if (found.entities.length) {
      // These cards count a video's whole life rather than the screen's period,
      // so they are asked for over that regardless of what the screen selected.
      var entityRange = lifetimeRange();
      var ids = found.entities.map(function (entity) { return entity.videoId; });
      var entityKey = 'rv_entities';
      nodes.push({
        key: entityKey,
        value: {
          query: buildQuery({
            dimensions: [{ type: 'VIDEO' }],
            range: entityRange,
            restricts: ctx.restricts.concat([{ dimension: { type: 'VIDEO' }, inValues: ids }]),
            currency: ctx.currency,
            limit: ids.length
          })
        }
      });
      plans.push({ kind: 'entities', entities: found.entities, key: entityKey });
    }

    return { nodes: nodes, plans: plans, found: found, payload: payload };
  }

  // Not every card reports its figures as metric columns. The latest-video
  // snapshot does not, and neither does anything Studio adds in future. Rather
  // than enumerate them, a card that mentions the raw metric anywhere in its
  // data and had nothing converted inside it is taken at its word: it is still
  // showing raw views, and the wording on that screen must be left alone.
  // Serialises a card's data without the notices attached to it. Those name the
  // raw metric - they are the "views are counted differently now" warnings - so
  // including them would make every card look as though it reported raw views.
  var NOTICE_KEYS = { anomalies: 1, columnAnomalies: 1, anomalyContext: 1 };

  function describeFigures(data) {
    return JSON.stringify(data, function (key, value) {
      return Object.prototype.hasOwnProperty.call(NOTICE_KEYS, key) ? undefined : value;
    });
  }

  function cardsLeftRaw(payload, converted) {
    if (!payload || !Array.isArray(payload.cards)) return false;

    function holds(node, column, depth) {
      if (depth > 16 || node === null || typeof node !== 'object') return false;
      if (node === column) return true;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) if (holds(node[i], column, depth + 1)) return true;
        return false;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) if (holds(node[keys[k]], column, depth + 1)) return true;
      return false;
    }

    for (var c = 0; c < payload.cards.length; c++) {
      var card = payload.cards[c];
      if (!card || card.isHidden) continue;

      var dataKeys = Object.keys(card).filter(function (key) { return /CardData$/.test(key); });
      for (var d = 0; d < dataKeys.length; d++) {
        var data = card[dataKeys[d]];
        var text;
        try { text = describeFigures(data); } catch (e) { continue; }
        // Either it names the raw metric, or it reports a view count under its
        // own name, as the latest-video snapshot does.
        var mentionsMetric = text.indexOf('"' + SOURCE_METRIC + '"') !== -1;
        var mentionsCount = /"(externalViewCount|viewCount|views)"\s*:/.test(text);
        if (!mentionsMetric && !mentionsCount) continue;

        // A card holding metric columns has already been judged one column at a
        // time, sparklines excepted. This is about the other kind: a card that
        // reports its figures some other way entirely, which the substitution
        // never had a chance to touch.
        if (text.indexOf('"metricColumns"') !== -1) continue;

        var touched = converted.some(function (item) { return holds(data, item, 0); });
        if (!touched) {
          log('left raw by an unfamiliar card:', dataKeys[d]);
          return true;
        }
      }
    }
    return false;
  }

  // Every figure the screen still reports as a raw view. Wording is only
  // corrected when there are none left, so a table that could not be converted
  // is never captioned as though it had been.
  function anyRawFiguresLeft(payload, converted) {
    var left = false;
    (function walk(node, depth) {
      if (left || depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (Array.isArray(node.metricColumns)) {
        // A sparkline - a run of time buckets split by something else - draws a
        // shape rather than captioned figures, and cannot be converted. Nor can
        // a table with no rows. Neither carries a caption, so neither stands in
        // the way of correcting the wording elsewhere on the screen.
        //
        // Any other table split two ways is a real table with real figures in
        // it: it cannot be converted either, but it is captioned, so it does.
        var dimensions = node.dimensionColumns;
        var sparkline = dimensions && dimensions.length > 1 && dimensions.some(function (column) {
          return !!(column.timestamps || column.dateIds);
        });
        var rows = dimensions && dimensions.length ? columnLabels(dimensions[0]) : null;
        var hasRows = !dimensions || !dimensions.length || (rows && rows.length);

        if (!sparkline && hasRows) {
          for (var c = 0; c < node.metricColumns.length; c++) {
            var column = node.metricColumns[c];
            if (!column || !column.metric || column.metric.type !== SOURCE_METRIC) continue;
            if (!column.counts && !column.percentages) continue;
            if (converted.indexOf(column) === -1) {
              log('left raw:', (dimensions && dimensions[0] && dimensions[0].dimension && dimensions[0].dimension.type) || 'a table with no dimension');
              left = true;
              return;
            }
          }
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]], depth + 1);
    })(payload, 0);
    return left;
  }

  // Turns whatever the queries answered into buckets of {startMs, value}, in
  // time order, whether they came back as days or as hours.
  function collectBuckets(item, results, ctx) {
    var buckets = [];

    function add(table, spanMs, toMs) {
      if (!table || !table.labels) return;
      for (var i = 0; i < table.labels.length; i++) {
        buckets.push({ startMs: toMs(table.labels[i]), spanMs: spanMs, value: Number(table.values[i]) });
      }
    }

    add(results[item.keys.days], DAY_MS, function (label) { return dateIdToMs(Number(label)) - ctx.offsetSecs * 1000; });
    add(results[item.keys.hours], HOUR_MS, function (label) { return Number(label); });
    if (!item.cumulative) add(results[item.keys.series], DAY_MS, function (label) { return dateIdToMs(Number(label)) - ctx.offsetSecs * 1000; });

    buckets.sort(function (a, b) { return a.startMs - b.startMs; });
    return buckets;
  }

  // Each point on the line is worth everything that had accrued by the moment
  // it marks, so several points inside one bucket share that bucket's figure
  // rather than each being credited with it.
  //
  // A point that lands on a bucket's start is credited with the whole bucket
  // when the points are no finer than the buckets, which is how Studio draws
  // a daily line: the point for a day carries that day's figure. When the
  // points are finer - a new video's chart marks every few minutes, while the
  // engaged figures only come by the hour - crediting the whole bucket at once
  // would draw a staircase that climbs once an hour and lies flat in between.
  // Each bucket is spread evenly across its span instead, so a point twenty
  // minutes into an hour is worth a third of that hour.
  function fillSeries(datums, buckets, cumulative) {
    var index = 0;
    var running = 0;
    var spread = cumulative && pointsFinerThanBuckets(datums, buckets);
    var now = Date.now();
    for (var d = 0; d < datums.length; d++) {
      var upTo = datums[d].x;
      var latest = 0;
      while (index < buckets.length && bucketCountedBy(buckets[index], upTo, spread)) {
        running += buckets[index].value;
        latest = buckets[index].value;
        index++;
      }
      var partial = 0;
      if (spread && index < buckets.length && buckets[index].startMs < upTo) {
        var bucket = buckets[index];
        // A bucket still being filled has only run up to this moment, so what
        // it holds so far is spread over the part of it that has passed.
        var end = Math.min(bucket.startMs + bucket.spanMs, Math.max(now, bucket.startMs + 1));
        var fraction = (upTo - bucket.startMs) / (end - bucket.startMs);
        partial = bucket.value * Math.min(1, Math.max(0, fraction));
      }
      datums[d].y = cumulative ? running + partial : latest;
    }
  }

  function bucketCountedBy(bucket, upTo, spread) {
    return spread ? bucket.startMs + bucket.spanMs <= upTo : bucket.startMs <= upTo;
  }

  function pointsFinerThanBuckets(datums, buckets) {
    if (datums.length < 2 || !buckets.length) return false;
    var step = Infinity;
    for (var d = 1; d < datums.length; d++) step = Math.min(step, datums[d].x - datums[d - 1].x);
    var span = Infinity;
    for (var b = 0; b < buckets.length; b++) span = Math.min(span, buckets[b].spanMs);
    return step < span;
  }

  function applyConversion(plan, results, ctx) {
    var changed = false;
    var tablesFound = 0;
    var tablesConverted = 0;
    var converted = (ctx.preConverted || []).slice();

    plan.plans.forEach(function (item) {
      if (item.kind === 'headline') {
        // Whatever the granularity, the answer becomes a list of buckets in
        // time order. The figure is their sum and the line is their running
        // total, so the two always agree.
        var buckets = collectBuckets(item, results, ctx);
        var total = results[item.keys.total];

        // A fixed window keeps the figure the server gives for it. A window
        // running to this moment has no such figure that is up to date, so it
        // is the sum of the buckets the line is drawn from.
        var figure = null;
        if (item.cumulative && buckets.length) {
          figure = buckets.reduce(function (sum, bucket) { return sum + bucket.value; }, 0);
        } else if (total && total.values.length) {
          figure = Number(total.values[0]);
        } else if (buckets.length) {
          figure = buckets.reduce(function (sum, bucket) { return sum + bucket.value; }, 0);
        }
        if (figure === null) return;

        item.content.total = figure;
        item.content.metric = TARGET_METRIC;
        converted.push(item.content);
        changed = true;

        item.headers.forEach(function (header) {
          rewriteHeaderSentence(header, item.rawTotal, item.content.total);
        });

        var previous = results[item.keys.previous];
        if (previous && previous.values.length) item.content.previousTotal = Number(previous.values[0]);
        else delete item.content.previousTotal;

        var mainSeries = item.content.mainSeries;
        var datums = mainSeries && mainSeries.datums;
        if (buckets.length && datums) {
          fillSeries(datums, buckets, item.cumulative);
          if (item.cumulative && datums.length) datums[datums.length - 1].y = figure;
        } else if (datums) {
          // Without figures to draw it from, the line would still be the raw
          // metric under an engaged label, so drop it rather than mislead.
          delete item.content.mainSeries;
        }

        var history = item.keys.typical ? results[item.keys.typical] : null;
        var typical = history ? typicalFromHistory(history, ctx, item.range) : null;
        if (typical) item.content.typicalPerformanceTotal = typical;
        else delete item.content.typicalPerformanceTotal;

        // Drawn behind the line, and modelled on the raw metric.
        delete item.content.typicalPerformanceSeries;
        delete item.content.anomalies;
      }

      if (item.kind === 'entities') {
        var counts = results[item.key];
        if (!counts || !counts.labels) return;
        var byVideo = {};
        for (var e = 0; e < counts.labels.length; e++) byVideo[counts.labels[e]] = Number(counts.values[e]);
        item.entities.forEach(function (entity) {
          if (!Object.prototype.hasOwnProperty.call(byVideo, entity.videoId)) return;
          entity.apply(byVideo[entity.videoId]);
          converted.push(entity.holder);
          changed = true;
        });
      }

      if (item.kind === 'pairs') {
        tablesFound++;
        var typeAnswer = results[item.typeKey];
        var detailAnswers = item.detailKeys.map(function (key) { return results[key]; });
        if (!typeAnswer || detailAnswers.some(function (answer) { return !answer; })) {
          log('no answer for the traffic hierarchy');
          return;
        }

        var byType = {};
        if (typeAnswer.labels) {
          for (var ti = 0; ti < typeAnswer.labels.length; ti++) byType[String(typeAnswer.labels[ti])] = Number(typeAnswer.values[ti]);
        }
        var byDetail = {};
        detailAnswers.forEach(function (answer) {
          if (!answer.labels) return;
          for (var di = 0; di < answer.labels.length; di++) byDetail[String(answer.labels[di])] = Number(answer.values[di]);
        });

        // A row naming a detail takes the detail's figure; a row naming only a
        // source takes the source's.
        var pairValues = item.hierarchy.types.map(function (type, row) {
          var detail = String(item.hierarchy.details[row] || '');
          if (detail && Object.prototype.hasOwnProperty.call(byDetail, detail)) return byDetail[detail];
          if (!detail && Object.prototype.hasOwnProperty.call(byType, String(type))) return byType[String(type)];
          return 0;
        });

        if (item.entry.column.counts) item.entry.column.counts.values = pairValues;
        var pairTotal = pairValues.reduce(function (a, b) { return a + b; }, 0);
        (item.entry.table.metricColumns || []).forEach(function (column) {
          if (!column.percentages || !column.metric || column.metric.type !== SOURCE_METRIC) return;
          column.percentages.values = pairValues.map(function (value) { return pairTotal ? (value / pairTotal) * 100 : 0; });
        });

        converted.push(item.entry.column);
        tablesConverted++;
        changed = true;
      }

      if (item.kind === 'wide') {
        tablesFound++;
        var wide = results[item.keys[0]];
        if (!wide) { log('no answer for the', item.described.map(function (d) { return d.type; }).join(' by '), 'table'); return; }

        var wanted = rowKeys(item.described);
        var answered = wide.labels ? answerKeys(wide, item.described) : [];
        if (wide.labels && !answered) { log('could not line up the', item.described.map(function (d) { return d.type; }).join(' by '), 'table'); return; }

        var byRow = {};
        for (var w = 0; w < answered.length; w++) byRow[answered[w]] = Number(wide.values[w]);

        var wideValues = wanted.map(function (key) {
          return Object.prototype.hasOwnProperty.call(byRow, key) ? byRow[key] : 0;
        });
        var wideTotal = wideValues.reduce(function (a, b) { return a + b; }, 0);

        if (item.entry.column.counts) item.entry.column.counts.values = wideValues;
        (item.entry.table.metricColumns || []).forEach(function (column) {
          if (!column.percentages || !column.metric || column.metric.type !== SOURCE_METRIC) return;
          column.percentages.values = wideValues.map(function (value) { return wideTotal ? (value / wideTotal) * 100 : 0; });
        });

        converted.push(item.entry.column);
        tablesConverted++;
        changed = true;
      }

      if (item.kind === 'table') {
        tablesFound++;
        // Every part of the table has to have been answered. A table half
        // filled from figures and half left raw would be worse than either.
        var answers = item.keys.map(function (key) { return results[key]; });
        if (answers.some(function (answer) { return !answer; })) {
          log('no answer for the', (tableDimension(item.entry.table) || {}).type || 'unnamed', 'table',
            '| rows', item.labels.length, '| first', String(item.labels[0]).slice(0, 40));
          return;
        }

        // An answer with no rows at all is not a failure: it means there were no
        // engaged views in that window, so every row of the table is zero. A
        // failed query is a different thing, and arrives as nothing at all.
        var byLabel = {};
        answers.forEach(function (answer) {
          if (!answer.labels) return;
          for (var r = 0; r < answer.labels.length; r++) byLabel[String(answer.labels[r])] = Number(answer.values[r]);
        });
        converted.push(item.entry.column);
        var replacement = item.labels.map(function (label) {
          var name = String(label);
          return Object.prototype.hasOwnProperty.call(byLabel, name) ? byLabel[name] : 0;
        });
        var total = replacement.reduce(function (a, b) { return a + b; }, 0);

        if (item.entry.column.counts) item.entry.column.counts.values = replacement;

        // Some tables report only each row's share of the views rather than the
        // views themselves. Those shares describe the raw metric until they are
        // worked out again from the figures fetched here.
        (item.entry.table.metricColumns || []).forEach(function (column) {
          if (!column.percentages || !column.metric || column.metric.type !== SOURCE_METRIC) return;
          column.percentages.values = replacement.map(function (value) {
            return total ? (value / total) * 100 : 0;
          });
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
    // The latest-video snapshot reports its figures outside the shapes handled
    // here, so a screen carrying one is not relabelled either - otherwise its
    // raw count would be captioned as an engaged one.
    var leftRaw = anyRawFiguresLeft(plan.payload, converted) || cardsLeftRaw(plan.payload, converted);
    var vouch = tablesFound > 0 && tablesFound === tablesConverted && !leftRaw;
    log('wording:', vouch ? 'safe to correct' : 'left as Studio wrote it',
      '| tables', tablesConverted + '/' + tablesFound, '| anything raw:', leftRaw);
    if (vouch) markConverted('analytics');
    else if (tablesFound > 0 || leftRaw) markUnconverted('analytics');

    return changed;
  }

  function convertAnalytics(payload, ctx) {
    var plan = planConversion(payload, ctx);
    if (plan.nodes.length === 0 && plan.found.rankings.length === 0) return Promise.resolve(false);

    var rankings = Promise.all(plan.found.rankings.map(function (entry) {
      return convertRanking(entry.ranking, entry.holder, ctx);
    }));

    return Promise.all([runQueries(ctx, plan.nodes), rankings]).then(function (both) {
      var results = both[0];
      var rankingChanged = both[1].some(Boolean);
      var changed = applyConversion(plan, results, ctx) || rankingChanged;
      if (changed) renameTabConfigs(payload);
      log('analytics converted', { headlines: plan.found.headline.length, tables: plan.found.tables.length, changed: changed });
      return changed;
    });
  }

  /* --------------------------------------------- the latest-video ranking */

  var VIDEO_LIST_REQUEST_PATH = '/youtubei/v1/creator/list_creator_videos';
  var RANKING_LOOKUP_SIZE = 50;

  // The ranking compares each video over the same stretch of its own life, so
  // every entry needs the moment its video went up. Studio's own video list
  // carries that, asked for with a mask narrow enough to keep the reply small.
  function fetchPublishTimes(ctx, ids) {
    if (!ctx.channelId) return Promise.resolve(null);

    var body = {
      filter: { and: { operands: [{ channelIdIs: { value: ctx.channelId } }] } },
      order: 'VIDEO_ORDER_DISPLAY_TIME_DESC',
      pageSize: RANKING_LOOKUP_SIZE,
      mask: { videoId: true, timePublishedSeconds: true },
      context: ctx.context
    };

    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) { if (!settled) { settled = true; resolve(value); } }
      var timer = setTimeout(function () { log('gave up waiting on the video list'); finish(null); }, QUERY_BUDGET_BASE_MS);

      var xhr = new XMLHttpRequest();
      nativeOpen.call(xhr, 'POST', location.origin + VIDEO_LIST_REQUEST_PATH + '?alt=json', true);
      Object.keys(ctx.headers).forEach(function (name) {
        try { nativeSetRequestHeader.call(xhr, name, ctx.headers[name]); } catch (e) {}
      });
      xhr.withCredentials = true;
      xhr.onload = function () {
        clearTimeout(timer);
        if (xhr.status !== 200) { log('video list lookup returned', xhr.status); finish(null); return; }
        try {
          var parsed = JSON.parse(xhr.responseText);
          var times = {};
          (parsed.videos || []).forEach(function (video) {
            if (video && video.videoId && video.timePublishedSeconds) {
              times[video.videoId] = Number(video.timePublishedSeconds) * 1000;
            }
          });
          finish(times);
        } catch (e) { finish(null); }
      };
      xhr.onerror = function () { clearTimeout(timer); finish(null); };
      nativeSend.call(xhr, JSON.stringify(body));
    });
  }

  // Competition ranking, which is what Studio does: a figure's place is one
  // more than the number of figures above it, so equal figures share a place.
  function placeOf(value, values) {
    var above = 0;
    for (var i = 0; i < values.length; i++) if (values[i] > value) above++;
    return above + 1;
  }

  // The row beside the ranking carries the server's judgement of the same
  // figures: a band of what is typical for these videos and an arrow saying
  // where this one sits in it. Both were made from raw views, so both are
  // redone from the engaged figures the ranking was just rebuilt with. A row
  // the server did not judge is left unjudged rather than given a verdict.
  function applySnapshotComparison(holder, ids, figures) {
    if (!holder || !holder.metricsTable || !Array.isArray(holder.metricsTable.metricRows)) return;
    var primary = holder.video && holder.video.externalVideoId;
    var at = ids.indexOf(primary);
    if (at === -1) return;
    var mine = figures[at];

    var sorted = figures.slice().sort(function (a, b) { return a - b; });
    function percentile(fraction) {
      var position = (sorted.length - 1) * fraction;
      var low = Math.floor(position);
      var high = Math.ceil(position);
      return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    }
    var lower = Math.round(percentile(0.25));
    var upper = Math.round(percentile(0.75));

    holder.metricsTable.metricRows.forEach(function (row) {
      if (!row.metric || row.metric.type !== SOURCE_METRIC) return;
      if (row.typicalRange && row.typicalRange.typicalRange) {
        row.typicalRange.typicalRange = { lowerBound: lower, upperBound: upper };
      }
      if (typeof row.trend === 'string') {
        var trend = mine > upper ? 'TREND_TYPE_UP' : mine < lower ? 'TREND_TYPE_DOWN' : 'TREND_TYPE_TYPICAL';
        if (trend !== row.trend) {
          row.trend = trend;
          // The sentence above the rows was written for the old verdict.
          delete holder.headline;
          delete row.performanceAnalysis;
        }
      }
    });
  }

  function convertRanking(ranking, holder, ctx) {
    var ids = ranking.entities.map(function (item) { return item.entity.videoId; });

    return fetchPublishTimes(ctx, ids).then(function (times) {
      if (!times) return false;

      // Every video has to be datable, or the list would mix spans and the
      // order would mean nothing.
      var missing = ids.filter(function (id) { return !times[id]; });
      if (missing.length) { log('ranking left alone,', missing.length, 'videos without a publish time'); return false; }

      // The list covers the newest video's life so far, measured from each
      // video's own start. Whole hours, because the hourly figures are only
      // accepted on hour boundaries.
      var newest = Math.max.apply(null, ids.map(function (id) { return times[id]; }));
      var span = Math.ceil((Date.now() - newest) / HOUR_MS) * HOUR_MS;
      if (span <= 0) return false;

      var nodes = ids.map(function (id, index) {
        var start = Math.floor(times[id] / HOUR_MS) * HOUR_MS;
        return {
          key: 'rv_rank_' + index,
          value: {
            query: buildQuery({
              dimensions: [{ type: 'VIDEO' }],
              range: { kind: 'hours', startMs: start, endMs: start + span },
              restricts: ctx.restricts.concat([{ dimension: { type: 'VIDEO' }, inValues: [id] }]),
              currency: ctx.currency,
              limit: 1
            })
          }
        };
      });

      return runQueries(ctx, nodes).then(function (results) {
        var figures = ids.map(function (id, index) {
          var table = results['rv_rank_' + index];
          if (!table) return null;
          if (!table.labels) return 0;
          for (var i = 0; i < table.labels.length; i++) if (String(table.labels[i]) === id) return Number(table.values[i]);
          return 0;
        });

        if (figures.some(function (figure) { return figure === null; })) {
          log('ranking left alone, some videos had no answer');
          return false;
        }

        ranking.entities.forEach(function (item, index) { item.value.double = figures[index]; });
        ranking.entities.sort(function (a, b) { return b.value.double - a.value.double; });
        ranking.entities.forEach(function (item) { item.rank = placeOf(item.value.double, figures); });
        applySnapshotComparison(holder, ids, figures);

        log('ranking rebuilt from engaged views', figures);
        return true;
      });
    }).catch(function (error) {
      log('ranking left alone', error);
      return false;
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

  // A dashboard request describes its own period inside the queries it carries.
  function dashboardContext(xhr, requestBody) {
    var parsed;
    try { parsed = JSON.parse(requestBody); } catch (e) { return null; }
    if (!parsed.context) return null;

    var channelId = null;
    var currency = 'USD';
    var range = null;

    (function walk(node, depth) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (!channelId && typeof node.externalChannelId === 'string') channelId = node.externalChannelId;
      if (!channelId && typeof node.channelId === 'string') channelId = node.channelId;
      if (typeof node.currency === 'string') currency = node.currency;
      if (!range && node.dateIdRange && node.dateIdRange.inclusiveStart && node.dateIdRange.exclusiveEnd) {
        range = dayRange(dateIdToMs(node.dateIdRange.inclusiveStart), dateIdToMs(node.dateIdRange.exclusiveEnd), 0);
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]], depth + 1);
    })(parsed, 0);

    // Without a channel to restrict by there is nothing to look up, but the
    // metric swap still applies, so a context is returned either way.
    return {
      context: parsed.context,
      headers: xhr.__realViewHeaders || {},
      currency: currency,
      offsetSecs: 0,
      channelId: channelId,
      restricts: channelId ? [{ dimension: { type: 'USER' }, inValues: [channelId] }] : [],
      range: range
    };
  }

  // Puts the worked-out range where the server would have put its own, and
  // points it at the engaged figure the rest of the response now carries.
  function applyTypical(payload, stats) {
    var current = null;
    var column = null;

    (function walk(node, depth) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      // The period's engaged total, as already substituted elsewhere.
      if (current === null && Array.isArray(node.metricColumns) && !node.dimensionColumns) {
        for (var c = 0; c < node.metricColumns.length; c++) {
          var entry = node.metricColumns[c];
          if (entry && entry.metric && entry.metric.type === SOURCE_METRIC && entry.counts && entry.counts.values.length) {
            current = Number(entry.counts.values[0]);
          }
        }
      }
      if (node.getTypicalPerformance && node.getTypicalPerformance.result) {
        var columns = node.getTypicalPerformance.result.metricColumns || [];
        for (var m = 0; m < columns.length; m++) {
          var candidate = columns[m];
          var type = candidate.metric && candidate.metric.metric && candidate.metric.metric.type;
          if (type === SOURCE_METRIC) column = candidate;
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]], depth + 1);
    })(payload, 0);

    if (!column) return false;
    column.stats = [stats];
    if (current !== null) column.currentValue = { column: { type: SOURCE_METRIC }, values: [{ double: current }] };
    return true;
  }

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
    var ctx = (convert.context || requestContext)(xhr, body);
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

  // Swaps the metric a request asks for, but never inside a typical performance
  // query. The server models a typical range for raw views only - asking it for
  // the engaged one comes back empty - so that query is left as Studio wrote it
  // and its views figures are replaced afterwards with a range worked out here.
  function swapRequestedMetric(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return text; }

    var swapped = 0;
    (function walk(node, depth, inTypical) {
      if (depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          if (node[i] === SOURCE_METRIC && !inTypical) { node[i] = TARGET_METRIC; swapped++; }
          else walk(node[i], depth + 1, inTypical);
        }
        return;
      }
      Object.keys(node).forEach(function (key) {
        var typical = inTypical || key === 'getTypicalPerformance';
        if (node[key] === SOURCE_METRIC && !typical) { node[key] = TARGET_METRIC; swapped++; }
        else walk(node[key], depth + 1, typical);
      });
    })(parsed, 0, false);

    if (!swapped) return text;
    return JSON.stringify(parsed);
  }

  // The channel's own engaged history stands in for the typical range the server
  // will not calculate: the same number of days, over each of the preceding
  // periods, gives a middle value and a band to compare today's figure against.
  var TYPICAL_PERIODS = 8;
  // Beyond this the hourly buckets become too many to ask for in one go.
  var HOURLY_WINDOW_LIMIT_MS = 14 * DAY_MS;

  function typicalHistoryNode(key, ctx, range) {
    if (!ctx.restricts.length || range.kind !== 'days') return null;
    var span = range.endMs - range.startMs;
    var history = dayRange(range.startMs - TYPICAL_PERIODS * span, range.startMs, ctx.offsetSecs);
    return {
      key: key,
      value: { query: buildQuery({ dimensions: [{ type: 'DAY' }], range: history, restricts: ctx.restricts, currency: ctx.currency }) }
    };
  }

  // Reduces a run of daily figures into the middle value and band of the
  // periods before this one.
  function typicalFromHistory(table, ctx, range) {
    if (!table || !table.labels) return null;
    var span = range.endMs - range.startMs;
    {

      var byDate = {};
      for (var i = 0; i < table.labels.length; i++) byDate[String(table.labels[i])] = Number(table.values[i]);

      // Total each preceding period, walking backwards a period at a time.
      var totals = [];
      for (var p = 1; p <= TYPICAL_PERIODS; p++) {
        var periodStart = range.startMs - p * span;
        var total = 0;
        var counted = 0;
        for (var ms = periodStart; ms < periodStart + span; ms += DAY_MS) {
          var id = String(toDateId(ms, ctx.offsetSecs));
          if (Object.prototype.hasOwnProperty.call(byDate, id)) { total += byDate[id]; counted++; }
        }
        if (counted) totals.push(total);
      }

      if (totals.length < 4) return null;
      totals.sort(function (a, b) { return a - b; });

      function percentile(fraction) {
        var position = (totals.length - 1) * fraction;
        var low = Math.floor(position);
        var high = Math.ceil(position);
        return totals[low] + (totals[high] - totals[low]) * (position - low);
      }

      var typical = Math.round(percentile(0.5));
      var lower = Math.round(percentile(0.25));
      var upper = Math.round(percentile(0.75));
      if (lower === upper) { lower = Math.min(lower, typical); upper = Math.max(upper, typical); }

      log('typical range worked out from', totals.length, 'periods', { typical: typical, lower: lower, upper: upper });
      return { typicalValue: typical, typicalRange: { lowerBound: lower, upperBound: upper } };
    }
  }

  function computeTypical(ctx, range) {
    var node = typicalHistoryNode('rv_typical', ctx, range);
    if (!node) return Promise.resolve(null);
    return runQueries(ctx, [node]).then(function (results) {
      return typicalFromHistory(results.rv_typical, ctx, range);
    });
  }

  function restoreMetric(text) {
    return text.split('"' + TARGET_METRIC + '"').join('"' + SOURCE_METRIC + '"');
  }

  // The audience screen asks for itself without naming a period: the request
  // carries only the channel, and the response states which period was chosen.
  // Without this the screen has no range and every table on it stays raw.
  function payloadTimePeriod(payload) {
    var found = null;
    (function walk(node, depth) {
      if (found || depth > 14 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (node.selectedTimePeriod && typeof node.selectedTimePeriod.timePeriodType === 'string') {
        found = node.selectedTimePeriod;
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length && !found; k++) walk(node[keys[k]], depth + 1);
    })(payload, 0);
    return found;
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
      var guessed = typicalHistoryNode('rv_typical_0', ctx, range);
      if (guessed) nodes.push(guessed);
      // Nothing is returned: this only warms the cache, so whichever of these
      // the screen turns out to need is already answered or on its way.
      runQueries(ctx, nodes).catch(function () {});
      return null;
    },
    run: function (payload, ctx) {
      // The response states the dates it actually covers, which settles any
      // disagreement with the range that was guessed from the request. A guess
      // that turns out wrong is discarded rather than used.
      var probe = collectTargets(payload);
      var answered = probe.headline.length
        ? seriesRange(probe.headline[0].mainSeries && probe.headline[0].mainSeries.datums, ctx.offsetSecs)
        : null;

      ctx.range = answered || periodRange(ctx.timePeriod, ctx.offsetSecs) || ctx.range ||
        periodRange(payloadTimePeriod(payload), ctx.offsetSecs);

      return convertAnalytics(payload, ctx);
    }
  };

  // The card request already returns engaged figures for everything except its
  // realtime card, so there is nothing worth guessing ahead of time.
  var cardsConverter = { run: analyticsConverter.run };

  var dashboardConverter = {
    context: dashboardContext,
    prefetch: function (ctx) {
      if (ctx && ctx.range) computeTypical(ctx, ctx.range).then(function (stats) { ctx.typical = stats; }).catch(function () {});
      return null;
    },
    run: function (payload, ctx) {
      // The queries were asked for the engaged metric, so the answer names it;
      // the caller's own bookkeeping expects the name it asked with.
      renameMetricDeeply(payload, TARGET_METRIC, SOURCE_METRIC);

      // Those columns were answered with the engaged metric and renamed back,
      // so they hold engaged figures even though they carry the old name.
      ctx.preConverted = metricColumnsNamed(payload, SOURCE_METRIC);
      if (ctx.typical) applyTypical(payload, ctx.typical);
      markConverted('dashboard');

      return convertAnalytics(payload, ctx).then(function () { return true; });
    }
  };

  function metricColumnsNamed(payload, type) {
    var found = [];
    (function walk(node, depth) {
      if (depth > 16 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i], depth + 1); return; }
      if (Array.isArray(node.metricColumns)) {
        node.metricColumns.forEach(function (column) {
          if (column && column.metric && column.metric.type === type) found.push(column);
        });
      }
      Object.keys(node).forEach(function (key) { walk(node[key], depth + 1); });
    })(payload, 0);
    return found;
  }

  function renameMetricDeeply(node, from, to) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        if (node[i] === from) node[i] = to;
        else renameMetricDeeply(node[i], from, to);
      }
      return;
    }
    Object.keys(node).forEach(function (key) {
      if (node[key] === from) node[key] = to;
      else renameMetricDeeply(node[key], from, to);
    });
  }

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
    if (url.indexOf(DASHBOARD_PATH) !== -1 && !skipped('join')) {
      if (body.indexOf('"' + SOURCE_METRIC + '"') === -1 || body.indexOf('"' + TARGET_METRIC + '"') !== -1) {
        return nativeSend.apply(xhr, args);
      }
      return proxy(xhr, body, swapRequestedMetric, dashboardConverter);
    }

    if (url.indexOf(JOIN_PATH) !== -1 && !skipped('join')) {
      var ours = body.indexOf('"realview"') !== -1;
      var hasSource = body.indexOf('"' + SOURCE_METRIC + '"') !== -1;
      // A query that already asks for both metrics would end up with a
      // duplicate column, and renaming its answer back would be ambiguous.
      var mixed = body.indexOf('"' + TARGET_METRIC + '"') !== -1;
      if (ours || !hasSource || mixed) return nativeSend.apply(xhr, args);

      // The typical range is worked out here, alongside the request, so it is
      // usually ready by the time Studio reads the answer.
      var typical = { stats: null };
      var ctx = dashboardContext(xhr, body);
      if (ctx && ctx.range) {
        computeTypical(ctx, ctx.range).then(function (stats) { typical.stats = stats; }).catch(function () {});
      }

      var textDescriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      var responseDescriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
      var cache = { from: null, to: null };

      function transform(raw) {
        if (typeof raw !== 'string' || raw === '') return raw;
        if (cache.from === raw) return cache.to;
        var out = restoreMetric(raw);
        if (typical.stats) {
          try {
            var payload = JSON.parse(out);
            if (applyTypical(payload, typical.stats)) out = JSON.stringify(payload);
          } catch (e) { /* leave the renamed text as it is */ }
        }
        cache.from = raw;
        cache.to = out;
        return out;
      }

      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get: function () { return transform(textDescriptor.get.call(xhr)); }
      });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get: function () { return transform(responseDescriptor.get.call(xhr)); }
      });
      markConverted('dashboard');
      log('dashboard query converted');
      return nativeSend.call(xhr, swapRequestedMetric(body));
    }

    // The card request names the metrics its cards should use, so asking for
    // the engaged one is enough; only its realtime card needs substituting.
    if (url.indexOf(CARDS_PATH) !== -1 && !skipped('cards')) return proxy(xhr, body, null, cardsConverter);

    if (url.indexOf(SCREEN_PATH) !== -1 && !skipped('screen')) return proxy(xhr, body, null, analyticsConverter);

    if (isVideoListUrl(url) && !skipped('videos')) return proxy(xhr, body, null, videoListConverter);

    return nativeSend.apply(xhr, args);
  }

})();
