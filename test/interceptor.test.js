'use strict';

const assert = require('assert');
const { createEnvironment, request } = require('./harness');

const CHANNEL = 'UCtest';
const OFFSET = -10800;
const DAY = 86400000;

// The dates the fixtures use, expressed the way the API does.
function dateId(ms) {
  const d = new Date(ms + OFFSET * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function dayStart(offsetDays) {
  const todayStart = Math.floor((Date.now() + OFFSET * 1000) / DAY) * DAY - OFFSET * 1000;
  return todayStart + offsetDays * DAY;
}

function screenRequest(entity = { channelId: CHANNEL }, period = 'ANALYTICS_TIME_PERIOD_TYPE_WEEK') {
  return JSON.stringify({
    context: { client: { clientName: 62 } },
    screenConfig: { entity, timePeriod: { timePeriodType: period }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    desktopState: { tabId: 'ANALYTICS_TAB_ID_OVERVIEW' }
  });
}

// A screen with a headline card, its daily chart, the sentence above it and a
// per-video table - the four things the extension has to convert.
function screenResponse() {
  const datums = [];
  for (let i = 7; i >= 1; i--) datums.push({ x: dayStart(-i), y: i });
  return JSON.stringify({
    cards: [
      { personalizedHeaderCardData: { title: 'Your channel got 28 views in the last 7 days' } },
      {
        keyMetricCardData: {
          keyMetricTabs: [
            {
              metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
              primaryContent: {
                metric: 'EXTERNAL_VIEWS',
                total: 28,
                previousTotal: 20,
                mainSeries: { datums, timeUnit: 'TIME_PERIOD_UNIT_DAYS' },
                typicalPerformanceTotal: { typicalValue: 30 },
                anomalies: [{ type: 'ANALYTICS_ANOMALY_TYPE_NEW_VOD_VIEW_COUNT_EXTERNAL_VIEWS_COUNTING' }]
              }
            },
            { metricTabConfig: { metric: 'EXTERNAL_WATCH_TIME' }, primaryContent: { metric: 'EXTERNAL_WATCH_TIME', total: 500 } }
          ]
        }
      },
      {
        tableCardData: {
          mainTableData: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [20, 8] } }]
          }
        }
      }
    ]
  });
}

// A realtime card: 48 hourly buckets plus a top-videos table.
function realtimeResponse() {
  const timestamps = [];
  const base = Math.floor(Date.now() / 3600000) * 3600000 - 47 * 3600000;
  for (let i = 0; i < 48; i++) timestamps.push(base + i * 3600000);
  return JSON.stringify({
    cards: [{
      latestActivityCardData: {
        datas: [{
          timePeriod: 'ANALYTICS_TIME_PERIOD_TYPE_REALTIME_LAST_48_HOURS',
          mainChartData: {
            dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: timestamps } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: timestamps.map(() => 1) } }]
          },
          topEntitiesData: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [14, 2] } }]
          }
        }]
      }
    }]
  });
}

// Answers any query with a fixed engaged number, so assertions can tell
// substituted figures from the raw ones at a glance.
function joinResponder(perLabel = {}, scalar = 7) {
  return (body) => {
    const parsed = JSON.parse(body);
    const results = parsed.nodes.map((node) => {
      const query = node.value.query;
      const dimension = query.dimensions[0] && query.dimensions[0].type;
      if (!dimension) {
        return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [scalar] } }] } } };
      }
      if (dimension === 'VIDEO') {
        const ids = Object.keys(perLabel).length ? Object.keys(perLabel) : ['vidA', 'vidB'];
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ids } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: ids.map((id) => (perLabel[id] === undefined ? 3 : perLabel[id])) } }]
            }
          }
        };
      }
      if (dimension === 'DAY') {
        const start = query.timeRange.dateIdRange.inclusiveStart;
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'DAY' }, dateIds: { values: [start] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }]
            }
          }
        };
      }
      if (dimension === 'HOUR') {
        const startSec = Number(query.timeRange.unixTimeRange.inclusiveStart);
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: [startSec * 1000] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [9] } }]
            }
          }
        };
      }
      return { key: node.key, value: {} };
    });
    return { status: 200, text: JSON.stringify({ results }) };
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('screen: headline, chart, sentence and table are all substituted', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const payload = JSON.parse(result.text);

  const content = payload.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.metric, 'ENGAGED_VIEWS', 'headline metric renamed');
  assert.strictEqual(content.total, 7, 'headline total substituted');
  assert.strictEqual(content.previousTotal, 7, 'previous total substituted');
  assert.strictEqual(content.typicalPerformanceTotal, undefined, 'typical range dropped');
  assert.strictEqual(content.anomalies, undefined, 'view-counting anomaly dropped');

  const series = content.mainSeries.datums;
  assert.strictEqual(series.filter((d) => d.y === 5).length, 1, 'the one day with data is filled in');
  assert.strictEqual(series.filter((d) => d.y === 0).length, series.length - 1, 'days without data become zero');

  assert.strictEqual(payload.cards[1].keyMetricCardData.keyMetricTabs[0].metricTabConfig.metric, 'ENGAGED_VIEWS', 'tab renamed');
  assert.strictEqual(payload.cards[1].keyMetricCardData.keyMetricTabs[1].metricTabConfig.metric, 'EXTERNAL_WATCH_TIME', 'other metrics untouched');

  assert.strictEqual(payload.cards[0].personalizedHeaderCardData.title, 'Your channel got 7 engaged views in the last 7 days');

  const table = payload.cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.strictEqual(table.metric.type, 'EXTERNAL_VIEWS', 'the column keeps the name Studio configured');
  assert.deepStrictEqual(table.counts.values, [11, 4], 'table rows matched by video id');
});

test('screen: the engaged query runs in parallel, not after the screen', async () => {
  const order = [];
  const env = createEnvironment({
    'get_screen': (body) => { order.push('screen'); return { status: 200, text: screenResponse() }; },
    'yta_web/join': (body) => { order.push('join'); return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.ok(order.indexOf('join') <= order.indexOf('screen') + 1, 'join is issued alongside the screen request');
  assert.strictEqual(order[0], 'join', 'the guessed query goes out first, before the screen answers');
});

test('cards: the request goes out exactly as Studio wrote it', async () => {
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': joinResponder({ vidA: 5, vidB: 1 })
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, timePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_WEEK' }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: [{ keyMetricCardConfig: { metricTabConfigs: [{ metric: 'EXTERNAL_VIEWS' }] } }]
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);

  const outgoing = env.sent.find((entry) => entry.url.includes('get_cards'));
  assert.strictEqual(outgoing.body, body, 'the request is not rewritten at all');
});

test('a converted column keeps the name Studio configured for it', async () => {
  // Studio matches a card's configured metric against the columns it gets back.
  // Renaming a column it cannot then find makes it discard the whole screen.
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder({ vidA: 11, vidB: 4 }) });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const payload = JSON.parse(result.text);

  const column = payload.cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.strictEqual(column.metric.type, 'EXTERNAL_VIEWS', 'name untouched');
  assert.deepStrictEqual(column.counts.values, [11, 4], 'numbers replaced');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'flagged so the wording can be corrected in the page');
});

test('a half-converted screen is not flagged for relabelling', async () => {
  // One table answers, the other does not, so the wording must stay as Studio
  // wrote it rather than claim more than the numbers deliver.
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const parsed = JSON.parse(body);
      return {
        status: 200,
        text: JSON.stringify({
          results: parsed.nodes
            .filter((node) => !node.key.startsWith('rv_table'))
            .map((node) => ({ key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }] } } }))
        })
      };
    }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.notStrictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'not flagged for relabelling');
});

test('the realtime table uses its own 48 hours, not the screen period', async () => {
  const queries = [];
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': (body) => {
      JSON.parse(body).nodes.forEach((node) => queries.push(node.value.query));
      return joinResponder({ vidA: 5, vidB: 1 })(body);
    }
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, timePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS' }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: []
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);

  const videoQuery = queries.find((q) => q.dimensions[0] && q.dimensions[0].type === 'VIDEO');
  assert.ok(videoQuery, 'the video table was queried');
  assert.ok(videoQuery.timeRange.unixTimeRange, 'over an hourly window rather than the 28 day period');
  const span = Number(videoQuery.timeRange.unixTimeRange.exclusiveEnd) - Number(videoQuery.timeRange.unixTimeRange.inclusiveStart);
  assert.strictEqual(span, 48 * 3600, 'exactly the 48 hours the card covers');

  const top = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].topEntitiesData.metricColumns[0];
  assert.deepStrictEqual(top.counts.values, [5, 1], 'and the card shows those hours');
});

test('dashboard: a query already asking for both metrics is left alone', async () => {
  const env = createEnvironment({ 'yta_web/join': () => ({ status: 200, text: '{"results":[]}' }) });
  const body = JSON.stringify({
    context: {},
    nodes: [{ key: 'a', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }, { type: 'ENGAGED_VIEWS' }] } } }]
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);
  assert.strictEqual(env.sent[0].body, body, 'passed through unchanged');
});

test('a table split by two dimensions at once is skipped, not mangled', async () => {
  const env = createEnvironment({
    'get_cards': JSON.stringify({
      cards: [{
        latestActivityCardData: {
          datas: [{
            sparkChartData: {
              dimensionColumns: [
                { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
                { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
              ],
              metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
            }
          }]
        }
      }]
    }),
    'yta_web/join': joinResponder()
  });
  const body = JSON.stringify({ context: {}, screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET }, cardConfigs: [] });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);
  const column = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].sparkChartData.metricColumns[0];
  assert.strictEqual(column.metric.type, 'EXTERNAL_VIEWS', 'left raw rather than half-converted');
  assert.deepStrictEqual(column.counts.values, [3, 4]);
});

test('realtime: the 48-hour card is substituted from its own hourly window', async () => {
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': joinResponder({ vidA: 5, vidB: 1 })
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: []
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);
  const data = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0];

  assert.strictEqual(data.mainChartData.metricColumns[0].metric.type, 'EXTERNAL_VIEWS', 'the column keeps its configured name');
  const hourly = data.mainChartData.metricColumns[0].counts.values;
  assert.strictEqual(hourly.filter((v) => v === 9).length, 1, 'the hour with data is filled in');
  assert.strictEqual(hourly.filter((v) => v === 0).length, 47, 'hours without data become zero');

  assert.deepStrictEqual(data.topEntitiesData.metricColumns[0].counts.values, [5, 1], 'top videos substituted by id');

  const query = JSON.parse(env.sent.find((e) => e.url.includes('join')).body).nodes
    .map((n) => n.value.query).find((q) => q.dimensions[0] && q.dimensions[0].type === 'HOUR');
  assert.ok(query.timeRange.unixTimeRange, 'the hourly query uses a unix time range');
  const span = Number(query.timeRange.unixTimeRange.exclusiveEnd) - Number(query.timeRange.unixTimeRange.inclusiveStart);
  assert.strictEqual(span, 48 * 3600, 'the window is exactly the 48 hours the card draws');
});

test('dashboard: a page query is swapped out and renamed back', async () => {
  const env = createEnvironment({
    'yta_web/join': () => ({ status: 200, text: JSON.stringify({ results: [{ key: '0__X', value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } }] }) })
  });
  const body = JSON.stringify({
    context: {},
    nodes: [{ key: '0__X', value: { query: { dimensions: [], metrics: [{ type: 'EXTERNAL_VIEWS' }] } } }],
    trackingLabel: 'web_creator_channel_dashboard_mixer'
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);

  assert.ok(env.sent[0].body.includes('"ENGAGED_VIEWS"'), 'the query asks for engaged views');
  assert.ok(result.text.includes('"EXTERNAL_VIEWS"'), 'the answer is renamed back for the caller');
  assert.ok(!result.text.includes('"ENGAGED_VIEWS"'), 'no engaged name leaks into the caller');
  assert.strictEqual(env.attributes['data-realview-converted-dashboard'], 'yes', 'dashboard flagged for relabelling');
});

test("dashboard: the extension's own queries are left alone", async () => {
  const env = createEnvironment({ 'yta_web/join': () => ({ status: 200, text: '{"results":[]}' }) });
  const body = JSON.stringify({ context: {}, trackingLabel: 'realview', nodes: [{ key: 'rv', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }] } } }] });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);
  assert.ok(env.sent[0].body.includes('"EXTERNAL_VIEWS"'), 'its own request is not rewritten again');
});

test('content tab: lifetime view counts are replaced per video', async () => {
  const env = createEnvironment({
    'list_creator_videos': JSON.stringify({
      videos: [
        { videoId: 'vidA', channelId: CHANNEL, publicMetrics: { viewCount: '100', externalViewCount: '100', likeCount: '2' } },
        { videoId: 'vidB', channelId: CHANNEL, publicMetrics: { viewCount: '50', externalViewCount: '50', likeCount: '1' } }
      ]
    }),
    'yta_web/join': joinResponder({ vidA: 40, vidB: 25 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/list_creator_videos?alt=json', JSON.stringify({ context: {} }));
  const videos = JSON.parse(result.text).videos;

  assert.strictEqual(videos[0].publicMetrics.viewCount, '40');
  assert.strictEqual(videos[0].publicMetrics.externalViewCount, '40');
  assert.strictEqual(videos[1].publicMetrics.viewCount, '25');
  assert.strictEqual(videos[0].publicMetrics.likeCount, '2', 'other metrics untouched');
  assert.strictEqual(env.attributes['data-realview-converted-videolist'], 'yes', 'video list flagged for relabelling');
});

test('a query that never answers cannot hold the screen open', async () => {
  const stalled = () => ({ status: 200, text: '{"results":[]}' });
  stalled.__delay = Infinity;
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': stalled });

  const started = Date.now();
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const waited = Date.now() - started;

  assert.ok(waited < 9000, 'delivered within the query budget, took ' + waited + 'ms');
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.metric, 'EXTERNAL_VIEWS', 'untouched rather than relabelled');
  assert.strictEqual(content.total, 28, 'the original figure survives');
});

test('a failed query leaves the response exactly as it was', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.text, screenResponse(), 'byte-identical passthrough');
});

test('an error from Studio itself is passed straight through', async () => {
  const env = createEnvironment({
    'get_screen': () => ({ status: 503, text: 'unavailable' }),
    'yta_web/join': joinResponder()
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.text, 'unavailable');
});

test('a repeated screen is served from cache without querying again', async () => {
  let joins = 0;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => { joins++; return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const first = joins;
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(joins, first, 'the second screen asked nothing new');
});

test('turning the extension off restores plain Studio behaviour', async () => {
  const env = createEnvironment(
    { 'get_screen': screenResponse(), 'yta_web/join': joinResponder() },
    { attributes: { 'data-realview-rewrite': 'off' } }
  );
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.text, screenResponse());
  assert.strictEqual(env.sent.filter((e) => e.url.includes('join')).length, 0, 'no extra requests at all');
});

test('a video-scoped screen filters by video rather than by channel', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest({ videoId: 'vidA' }));
  const query = JSON.parse(env.sent.find((e) => e.url.includes('join')).body).nodes[0].value.query;
  assert.deepStrictEqual(query.restricts[0], { dimension: { type: 'VIDEO' }, inValues: ['vidA'] });
});

test('a rewritten response is announced only once, as finished', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const states = [];
  const events = [];

  await new Promise((resolve) => {
    const xhr = new env.FakeXHR();
    xhr.open('POST', 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json');
    xhr.onreadystatechange = () => { states.push(xhr.readyState); events.push('readystatechange'); };
    xhr.addEventListener('load', () => { events.push('load'); });
    xhr.addEventListener('loadend', () => { events.push('loadend'); resolve(); });
    xhr.send(screenRequest());
  });

  assert.deepStrictEqual(states, [4], 'no intermediate states are replayed');
  assert.deepStrictEqual(events, ['readystatechange', 'load', 'loadend'], 'each event fires once, in order');
});

test('an exception anywhere in the extension still lets the request through', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });

  // Break the settings lookup the way a hostile page or a future Chrome change
  // might; the request must still reach Studio.
  const documentElement = env.attributes;
  const original = Object.getOwnPropertyDescriptor(env, 'attributes');
  const xhr = new env.FakeXHR();
  xhr.open('POST', 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json');
  Object.defineProperty(xhr, '__realViewUrl', {
    configurable: true,
    get() { throw new Error('boom'); }
  });

  const result = await new Promise((resolve) => {
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ status: xhr.status, error: true });
    xhr.send(screenRequest());
  });

  assert.strictEqual(result.status, 200, 'the request went out despite the failure');
  assert.strictEqual(result.text, screenResponse(), 'and returned Studio\'s own answer');
  if (original) Object.defineProperty(env, 'attributes', original);
  assert.ok(documentElement, 'settings object untouched');
});

test('a json response type receives both the object and the text', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest(), 'json');

  assert.strictEqual(typeof result.response, 'object', 'json readers get a parsed object');
  assert.strictEqual(typeof result.text, 'string', 'text readers get the body rather than nothing');
  assert.strictEqual(result.response.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent.total, 7);
});

test('a wrongly guessed period is discarded rather than used', async () => {
  const queries = [];
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => queries.push(n.value.query.timeRange.dateIdRange.inclusiveStart)); return joinResponder()(body); }
  });
  // The request claims a year while the response describes a week, so the
  // figures must come from a query matching the response.
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest({ channelId: CHANNEL }, 'ANALYTICS_TIME_PERIOD_TYPE_YEAR'));

  const responseStart = dateId(dayStart(-7));
  assert.ok(queries.includes(responseStart), 'a query was made for the range the response actually covers');
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.total, 7, 'and the substituted figure comes from it');
});

test('repeated faults make the extension stand down instead of repeating', async () => {
  let screenCalls = 0;
  const env = createEnvironment({
    'get_screen': () => { screenCalls++; return { status: 200, text: screenResponse() }; },
    // Every conversion attempt fails, the way a broken query endpoint would.
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });

  const attempts = [];
  for (let i = 0; i < 4; i++) {
    const before = env.sent.filter((entry) => entry.url.includes('join')).length;
    const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
    assert.strictEqual(result.text, screenResponse(), 'every attempt still returns a working screen');
    attempts.push(env.sent.filter((entry) => entry.url.includes('join')).length - before);
  }

  assert.ok(attempts[0] >= 1, 'it did try at first');
  assert.strictEqual(attempts[3], 0, 'and had stopped trying by the end, attempts were ' + attempts.join(','));
  assert.strictEqual(screenCalls, 4, 'and Studio kept getting its screens throughout');
});

test('the channel dashboard asks for the engaged metric and reads back its own', async () => {
  const env = createEnvironment({
    'get_channel_dashboard': () => ({ status: 200, text: JSON.stringify({ cards: [{ body: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [47] } }] } } }] }) })
  });
  const body = JSON.stringify({
    context: {},
    dashboardParams: { channelId: CHANNEL, facts: [{ query: { metrics: [{ type: 'EXTERNAL_VIEWS' }] } }] }
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_channel_dashboard?alt=json', body);

  const outgoing = env.sent.find((entry) => entry.url.includes('get_channel_dashboard'));
  assert.ok(outgoing.body.includes('"ENGAGED_VIEWS"'), 'the dashboard query asks for engaged views');
  assert.ok(result.text.includes('"EXTERNAL_VIEWS"'), 'and the answer is renamed back for the caller');
  assert.ok(result.text.includes('47'), 'carrying the engaged figure');
  assert.strictEqual(env.attributes['data-realview-converted-dashboard'], 'yes');
});

test('the card gets a typical range worked out from engaged history', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const parsed = JSON.parse(body);
      return {
        status: 200,
        text: JSON.stringify({
          results: parsed.nodes.map((node) => {
            const query = node.value.query;
            const daily = query.dimensions[0] && query.dimensions[0].type === 'DAY';
            const start = query.timeRange.dateIdRange.inclusiveStart;
            const end = query.timeRange.dateIdRange.exclusiveEnd;
            // The history query is the long one; answer it with a run of days.
            if (daily && String(end - start).length > 2) {
              const labels = [];
              const values = [];
              let ms = dayStart(-1 - 8 * 7);
              for (let i = 0; i < 8 * 7; i++) { labels.push(dateId(ms)); values.push(1 + Math.floor(i / 7)); ms += DAY; }
              return { key: node.key, value: { resultTable: { dimensionColumns: [{ dimension: { type: 'DAY' }, dateIds: { values: labels } }], metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }] } } };
            }
            return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } };
          })
        })
      };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.ok(content.typicalPerformanceTotal, 'the card keeps a typical range rather than losing it');
  const band = content.typicalPerformanceTotal.typicalRange;
  assert.ok(band.lowerBound <= content.typicalPerformanceTotal.typicalValue, 'band brackets the middle value');
  assert.ok(band.upperBound >= content.typicalPerformanceTotal.typicalValue, 'band brackets the middle value');
  assert.notStrictEqual(content.typicalPerformanceTotal.typicalValue, 30, 'not the raw figure the fixture shipped with');
});

test('a card with too little history loses its typical range rather than inventing one', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.typicalPerformanceTotal, undefined);
});

test('a typical performance query is never asked for the engaged metric', async () => {
  // The server answers such a query with nothing, which is what removed the
  // comparison from the dashboard in the first place.
  const env = createEnvironment({ 'get_channel_dashboard': () => ({ status: 200, text: '{"cards":[]}' }) });
  const body = JSON.stringify({
    context: {},
    dashboardParams: {
      channelId: 'UCtest',
      nodes: [
        { key: 'current', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }], timeRange: { dateIdRange: { inclusiveStart: 20260803, exclusiveEnd: 20260831 } } } } },
        { key: 'typical', value: { getTypicalPerformance: { query: { metrics: [{ metric: { type: 'EXTERNAL_VIEWS' } }] } } } }
      ]
    }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_channel_dashboard?alt=json', body);

  const sent = JSON.parse(env.sent.find((e) => e.url.includes('get_channel_dashboard')).body);
  const nodes = sent.dashboardParams.nodes;
  assert.strictEqual(nodes[0].value.query.metrics[0].type, 'ENGAGED_VIEWS', 'the ordinary query is swapped');
  assert.strictEqual(nodes[1].value.getTypicalPerformance.query.metrics[0].metric.type, 'EXTERNAL_VIEWS', 'the typical query is left alone');
});

test('a screen carrying a latest-video snapshot is not relabelled', async () => {
  // That card's figures are not metric columns, so they stay raw. Relabelling
  // the screen would caption a raw count as an engaged one.
  const withSnapshot = JSON.parse(screenResponse());
  withSnapshot.cards.push({ entitySnapshotCardData: { item: { viewCount: '149600' } } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(withSnapshot),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  assert.notStrictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'wording left as Studio wrote it');
  const column = JSON.parse(result.text).cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [11, 4], 'the figures it can convert are still converted');
});

test('a traffic source table is converted and its share column follows', async () => {
  const payload = {
    cards: [{
      tableCardData: {
        mainTableData: {
          dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['SUBSCRIBER', 'YT_SEARCH'] } }],
          metricColumns: [
            { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [800, 200] } },
            { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [80, 20] } }
          ]
        }
      }
    }]
  };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => ({
          key: node.key,
          value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH', 'SUBSCRIBER'] } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [100, 300] } }]
          } }
        }))
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(columns[0].counts.values, [300, 100], 'rows matched by enumerated name, not position');
  assert.deepStrictEqual(columns[1].percentages.values, [75, 25], 'the share column is recomputed from them');
});

test('a cumulative chart is rebuilt as a running total ending at the figure shown', async () => {
  const datums = [];
  for (let i = 7; i >= 1; i--) datums.push({ x: dayStart(-i), y: i * 10 });
  const payload = {
    cards: [{
      keyMetricCardData: {
        keyMetricTabs: [{
          metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
          primaryContent: {
            metric: 'EXTERNAL_VIEWS',
            total: 70,
            mainSeries: { datums, isCumulative: true, timeUnit: 'TIME_PERIOD_UNIT_NTH_DAYS' },
            typicalPerformanceSeries: { datums: [{ x: 1, y: 2 }] }
          }
        }]
      }
    }]
  };
  const env = createEnvironment({ 'get_screen': JSON.stringify(payload), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[0].keyMetricCardData.keyMetricTabs[0].primaryContent;

  const ys = content.mainSeries.datums.map((d) => d.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], 'the line only ever climbs');
  assert.strictEqual(ys[ys.length - 1], content.total, 'and ends on the figure the card reports');
  assert.strictEqual(content.typicalPerformanceSeries, undefined, 'the raw band behind it is dropped');
});

test("a cumulative total takes today's figures from the live store", async () => {
  const datums = [];
  for (let i = 3; i >= 1; i--) datums.push({ x: dayStart(-i), y: i });
  const payload = { cards: [{ keyMetricCardData: { keyMetricTabs: [{ metricTabConfig: { metric: 'EXTERNAL_VIEWS' }, primaryContent: { metric: 'EXTERNAL_VIEWS', total: 5, mainSeries: { datums, isCumulative: true } } }] } }] };
  const queries = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => queries.push(n)); return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  // Whole days come from the daily store; today comes by the hour, because a
  // query with no dimension is refused over a clock-time range.
  const live = queries.filter((n) => n.value.query.timeRange.unixTimeRange);
  assert.ok(live.length, 'part of the window is asked for by clock time');
  assert.ok(live.every((n) => n.value.query.dimensions.length > 0), 'and always with a dimension');
  assert.ok(live.some((n) => (n.value.query.dimensions[0] || {}).type === 'HOUR'), 'today is asked for by the hour');

  const daily = queries.filter((n) => n.value.query.timeRange.dateIdRange && n.value.query.dimensions.length === 0);
  assert.ok(daily.length, 'the settled days are asked for as whole days');
});

test('a screen with a figure left raw is not relabelled', async () => {
  // The join answers the headline but not the table, so one column keeps its
  // raw figure and the screen must keep Studio's wording.
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes
          .filter((node) => !node.key.startsWith('rv_table'))
          .map((node) => ({ key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }] } } }))
      })
    })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no', 'and says so, in case an earlier response said otherwise');
});

test('one query the server rejects does not take the others down with it', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      // The server fails the whole request when any query in it is unsupported.
      const poisoned = nodes.some((n) => n.value.query.timeRange.unixTimeRange);
      return {
        status: 200,
        text: JSON.stringify({
          results: nodes.map((n) => (poisoned
            ? { key: n.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } }
            : joinResponder({ vidA: 11, vidB: 4 })(JSON.stringify({ nodes: [n] })).text
              ? JSON.parse(joinResponder({ vidA: 11, vidB: 4 })(JSON.stringify({ nodes: [n] })).text).results[0]
              : { key: n.key, value: {} }))
        })
      };
    }
  });

  // A cumulative card asks for its total by clock time as well, and that is the
  // query this fixture refuses.
  const payload = JSON.parse(screenResponse());
  payload.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent.mainSeries.isCumulative = true;
  env.routes = null;

  const withCumulative = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      const poisoned = nodes.some((n) => n.value.query.timeRange.unixTimeRange);
      if (poisoned) return { status: 200, text: JSON.stringify({ results: nodes.map((n) => ({ key: n.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } })) }) };
      return joinResponder({ vidA: 11, vidB: 4 })(body);
    }
  });

  const result = await request(withCumulative, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.metric, 'ENGAGED_VIEWS', 'the card still converted');
  assert.strictEqual(content.total, 7, 'from the query the server did accept');
});

test('a sparkline that cannot be converted does not block the wording', async () => {
  // Split by two dimensions, so it is skipped by design. It draws a shape
  // rather than a captioned figure, so it must not hold back the relabelling.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({
    latestActivityCardData: {
      datas: [{
        sparkChartData: {
          dimensionColumns: [
            { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
            { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
          ],
          metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
        }
      }]
    }
  });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('several points inside one bucket are not each credited with it', async () => {
  // A "since published" chart draws many points inside the first day. Adding
  // that day's figure once per point inflated the line to several times the
  // real total before it snapped back at the end.
  const dayOne = dayStart(-1);
  const datums = [];
  for (let i = 0; i < 6; i++) datums.push({ x: dayOne + i * 3 * 3600000, y: 1000 * (i + 1) });

  const payload = { cards: [{ keyMetricCardData: { keyMetricTabs: [{
    metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
    primaryContent: { metric: 'EXTERNAL_VIEWS', total: 90000, mainSeries: { datums, isCumulative: true } }
  }] } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const dimension = (node.value.query.dimensions[0] || {}).type;
          if (dimension !== 'HOUR') return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [999999] } }] } } };
          // Six hourly buckets of 100 each, spread across the same day.
          const labels = [];
          const values = [];
          for (let i = 0; i < 6; i++) { labels.push(dayOne + i * 3 * 3600000); values.push(100); }
          return { key: node.key, value: { resultTable: { dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: labels } }], metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }] } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[0].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.total, 600, 'the figure is the sum of the buckets, counted once each');
  const ys = content.mainSeries.datums.map((d) => d.y);
  assert.deepStrictEqual(ys, [100, 200, 300, 400, 500, 600], 'and the line is their running total');
  assert.strictEqual(ys[ys.length - 1], content.total, 'ending exactly on the figure shown');
});

test('a card reporting figures in an unfamiliar shape withdraws the relabelling', async () => {
  // Nothing here is a metric column, so the substitution had no way in. Saying
  // nothing would leave the card's raw count captioned as an engaged one.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ videoTrafficSourcesCardData: { rows: [{ source: 'BROWSE', metric: 'EXTERNAL_VIEWS', value: 130400 }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no');
});

test('a hidden card is not treated as showing anything', async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ isHidden: true, videoTrafficSourcesCardData: { rows: [{ metric: 'EXTERNAL_VIEWS', value: 1 }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('a share-only table is converted from figures fetched for it', async () => {
  const payload = {
    cards: [{
      tableCardData: {
        mainTableData: {
          dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['US', 'GB'] } }],
          metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [90, 10] } }]
        }
      }
    }]
  };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => ({
          key: node.key,
          value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['US', 'GB'] } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [30, 70] } }]
          } }
        }))
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.percentages.values, [30, 70], 'the shares describe the engaged figures now');
});

test('a real table split two ways still blocks the wording', async () => {
  // Not a sparkline: no time axis, so these are captioned figures on screen.
  // They cannot be converted, so the wording must stay as Studio wrote it.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({
    tableCardData: {
      mainTableData: {
        dimensionColumns: [
          { dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH'] } },
          { dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_SEARCH.thing'] } }
        ],
        metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [130400] } }]
      }
    }
  });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no');
});

test('detail rows are asked for one source type at a time', async () => {
  // The server refuses a traffic detail query that does not say which kind of
  // source it means. The row names carry that as a prefix.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_SEARCH.one', 'YT_SEARCH.two', 'EXT_URL.site'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20, 30] } }]
  } } }] };

  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      return {
        status: 200,
        text: JSON.stringify({
          results: nodes.map((node) => {
            const restrict = node.value.query.restricts.find((r) => r.dimension.type === 'TRAFFIC_SOURCE_TYPE');
            if (restrict) asked.push(restrict.inValues[0]);
            const rows = restrict && restrict.inValues[0] === 'YT_SEARCH'
              ? { labels: ['YT_SEARCH.one', 'YT_SEARCH.two'], values: [1, 2] }
              : { labels: ['EXT_URL.site'], values: [3] };
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: rows.labels } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: rows.values } }]
            } } };
          })
        })
      };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.deepStrictEqual(asked.sort(), ['EXT_URL', 'YT_SEARCH'], 'one query per kind of source');
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [1, 2, 3], 'and the rows are stitched back together in order');
});

test('a table whose answer has no rows becomes zeros, not a failure', async () => {
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [14] } }]
  } } }] };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({ results: JSON.parse(body).nodes.map((n) => ({ key: n.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [] } }] } } })) })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [0], 'no engaged views in that window means zero, not raw');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test("a card's own view count for a video is converted too", async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ audienceRetentionHighlightsCardData: { videosData: [{ videoId: 'vidA', metricTotals: { avgPercentageWatched: 0.55, views: 3693 } }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const totals = JSON.parse(result.text).cards[3].audienceRetentionHighlightsCardData.videosData[0].metricTotals;

  assert.strictEqual(totals.views, 11, 'the count follows the metric');
  assert.strictEqual(totals.avgPercentageWatched, 0.55, 'and nothing else on the card is touched');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('a table listing sources with their details is rebuilt from both', async () => {
  // "YouTube recommendations" with "YouTube Home" and "Up next" beneath it. The
  // server answers each level on its own but not the two together.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [
      { dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_RELATED', 'YT_RELATED', 'YT_RELATED', 'SUBSCRIBER'] } },
      { dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['', 'YT_RELATED.home', 'YT_RELATED.upnext', ''] } }
    ],
    metricColumns: [
      { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [130400, 120400, 10000, 11600] } },
      { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [86.3, 79.7, 6.6, 7.7] } }
    ]
  } } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const dimension = (node.value.query.dimensions[0] || {}).type;
          if (dimension === 'TRAFFIC_SOURCE_TYPE') {
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_RELATED', 'SUBSCRIBER'] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [60, 8] } }]
            } } };
          }
          if (dimension === 'TRAFFIC_SOURCE_DETAIL') {
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_RELATED.home', 'YT_RELATED.upnext'] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [55, 5] } }]
            } } };
          }
          return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(columns[0].counts.values, [60, 55, 5, 8], 'parents from the source figures, children from the detail ones');
  assert.deepStrictEqual(columns[1].percentages.values.map(Math.round), [47, 43, 4, 6], 'shares follow');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'and the wording may be corrected');
});

test("the latest-video card's views row is converted", async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ entitySnapshotCardData: {
    video: { externalVideoId: 'vidA', videoFormat: 'VIDEO_FORMAT_VOD' },
    metricsTable: { metricRows: [
      { metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 149600 }, typicalRange: {} },
      { metric: { type: 'AVERAGE_WATCH_TIME' }, value: { double: 476 }, typicalRange: {} }
    ] }
  } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const rows = JSON.parse(result.text).cards[3].entitySnapshotCardData.metricsTable.metricRows;

  assert.strictEqual(rows[0].value.double, 11, 'the views row follows the metric');
  assert.strictEqual(rows[1].value.double, 476, 'and the other rows are left alone');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'so the card no longer holds the wording back');
});

test('the latest-video ranking is rebuilt from engaged views', async () => {
  // Studio ranks the newest video against recent uploads over the same stretch
  // of each one's life. Raw order here is A, B, C; engaged order is C, A, B.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } },
    { rank: 3, entity: { videoId: 'vidC' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 100 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const engaged = { vidA: 20, vidB: 5, vidC: 60 };
  const windows = {};

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': () => ({ status: 200, text: JSON.stringify({ videos: [
      { videoId: 'vidA', timePublishedSeconds: String(Math.floor((now - 3 * 3600000) / 1000)) },
      { videoId: 'vidB', timePublishedSeconds: String(Math.floor((now - 40 * 3600000) / 1000)) },
      { videoId: 'vidC', timePublishedSeconds: String(Math.floor((now - 90 * 3600000) / 1000)) }
    ] }) }),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const id = (node.value.query.restricts.find((r) => r.dimension.type === 'VIDEO') || { inValues: [] }).inValues[0];
          const range = node.value.query.timeRange.unixTimeRange;
          if (id && range) windows[id] = Number(range.exclusiveEnd) - Number(range.inclusiveStart);
          return { key: node.key, value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: [id] } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [engaged[id] || 0] } }]
          } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  assert.deepStrictEqual(entities.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'reordered by engaged views');
  assert.deepStrictEqual(entities.map((e) => e.value.double), [60, 20, 5], 'showing the engaged figures');
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2, 3], 'and renumbered');

  const spans = Object.values(windows);
  assert.strictEqual(new Set(spans).size, 1, 'every video measured over the same length of its own life');
});

test('videos share a place when their figures tie', async () => {
  const now = Date.now();
  const ranking = { entities: ['vidA', 'vidB', 'vidC'].map((id, i) => ({
    rank: i + 1, entity: { videoId: id }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 10 - i }
  })) };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const engaged = { vidA: 1, vidB: 0, vidC: 0 };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': () => ({ status: 200, text: JSON.stringify({ videos: ['vidA', 'vidB', 'vidC'].map((id, i) => ({ videoId: id, timePublishedSeconds: String(Math.floor((now - (2 + i * 10) * 3600000) / 1000)) })) }) }),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({ results: JSON.parse(body).nodes.map((node) => {
        const id = (node.value.query.restricts.find((r) => r.dimension.type === 'VIDEO') || { inValues: [] }).inValues[0];
        return { key: node.key, value: { resultTable: {
          dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: [id] } }],
          metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [engaged[id]] } }]
        } } };
      }) })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2, 2], 'the two tied videos share second place');
});

test('a ranking is left alone when a video cannot be dated', async () => {
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    // Only one of the two videos comes back with a publish time.
    'list_creator_videos': () => ({ status: 200, text: JSON.stringify({ videos: [{ videoId: 'vidA', timePublishedSeconds: '1780000000' }] }) }),
    'yta_web/join': joinResponder()
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.value.double), [900, 500], 'figures untouched');
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2], 'order untouched');
});

test('a table split by two dimensions is matched on the pair', async () => {
  // Age against gender: each row is identified by both names, so the answer has
  // to be lined up on the pair rather than on either half.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [
      { dimension: { type: 'VIEWER_AGE' }, enumValues: { values: ['AGE_18_24', 'AGE_18_24', 'AGE_25_34'] } },
      { dimension: { type: 'VIEWER_GENDER' }, enumValues: { values: ['GENDER_FEMALE', 'GENDER_MALE', 'GENDER_MALE'] } }
    ],
    metricColumns: [
      { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20, 70] } },
      { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [10, 20, 70] } }
    ]
  } } }] };

  let asked = null;
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const node = JSON.parse(body).nodes[0];
      asked = node.value.query.dimensions.map((d) => d.type);
      return { status: 200, text: JSON.stringify({ results: [{ key: node.key, value: { resultTable: {
        // Deliberately a different row order, and the columns the other way round.
        dimensionColumns: [
          { dimension: { type: 'VIEWER_GENDER' }, enumValues: { values: ['GENDER_MALE', 'GENDER_MALE', 'GENDER_FEMALE'] } },
          { dimension: { type: 'VIEWER_AGE' }, enumValues: { values: ['AGE_25_34', 'AGE_18_24', 'AGE_18_24'] } }
        ],
        metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [30, 5, 15] } }]
      } } }] }) };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(asked, ['VIEWER_AGE', 'VIEWER_GENDER'], 'asked for both dimensions at once');
  assert.deepStrictEqual(columns[0].counts.values, [15, 5, 30], 'each row took the figure for its own pair');
  assert.deepStrictEqual(columns[1].percentages.values, [30, 10, 60], 'and the shares follow');
});

test('a screen that names no period takes the one its response states', async () => {
  // The Audience screen asks for itself with a channel and nothing else. Its
  // period is only stated in the answer, and without reading it there is no
  // range and every table on the screen stays raw.
  const payload = {
    layout: { desktopLayout: { selectedTimePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_WEEK' } } },
    cards: [{ tableCardData: { mainTableData: {
      dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
      metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [20, 8] } }]
    } } }]
  };
  const request_ = JSON.stringify({
    context: { client: { clientName: 62 } },
    screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    desktopState: { tabId: 'ANALYTICS_TAB_ID_AUDIENCE' }
  });

  const env = createEnvironment({ 'get_screen': JSON.stringify(payload), 'yta_web/join': joinResponder({ vidA: 11, vidB: 4 }) });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', request_);
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];

  assert.deepStrictEqual(column.counts.values, [11, 4], 'converted from the period the response named');
});

test('each tab of a by-content-type card is asked for its own kind of content', async () => {
  // One breakdown repeated per content type: the tables are identical apart
  // from the kind of content they cover, so each needs its own query.
  const table = () => ({ tableCard: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['CA', 'US'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20] } }]
  } } });
  const payload = { cards: [{ tableCardByContentTypeCardData: { tables: [
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_ALL_CONTENT' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_VIDEO' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_SHORTS' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_PODCASTS' }, table())
  ] } }] };

  // Each kind of content answers with a figure of its own, so a table filled
  // from the wrong query is visible in the result.
  const byKind = { none: [1, 2], VIDEO_ON_DEMAND: [3, 4], SHORTS: [5, 6] };
  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const results = JSON.parse(body).nodes.map((node) => {
        const restrict = node.value.query.restricts.find((r) => r.dimension.type === 'CREATOR_CONTENT_TYPE');
        const kind = restrict ? restrict.inValues[0] : 'none';
        if ((node.value.query.dimensions[0] || {}).type === 'COUNTRY') asked.push(kind);
        return { key: node.key, value: { resultTable: {
          dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['CA', 'US'] } }],
          metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: byKind[kind] } }]
        } } };
      });
      return { status: 200, text: JSON.stringify({ results }) };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const tables = JSON.parse(result.text).cards[0].tableCardByContentTypeCardData.tables;

  assert.deepStrictEqual(asked.sort(), ['SHORTS', 'VIDEO_ON_DEMAND', 'none'], 'one query per kind, and none for the podcast tab');
  assert.deepStrictEqual(tables[0].tableCard.mainTableData.metricColumns[0].counts.values, [1, 2], 'all content');
  assert.deepStrictEqual(tables[1].tableCard.mainTableData.metricColumns[0].counts.values, [3, 4], 'videos only');
  assert.deepStrictEqual(tables[2].tableCard.mainTableData.metricColumns[0].counts.values, [5, 6], 'shorts only');
  assert.deepStrictEqual(tables[3].tableCard.mainTableData.metricColumns[0].counts.values, [10, 20], 'the podcast tab is left as it was');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no',
    'and the screen is not relabelled while a raw table remains');
});

test('a sparkline over time is still left alone', async () => {
  const payload = { cards: [{ latestActivityCardData: { datas: [{ sparkChartData: {
    dimensionColumns: [
      { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
      { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
    ],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
  } }] } }] };

  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => asked.push(n.value.query.dimensions.map((d) => d.type).join('+'))); return joinResponder()(body); }
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  assert.ok(!asked.includes('HOUR+VIDEO'), 'no query for the sparkline pairing');
  const column = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].sparkChartData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [3, 4], 'left as it was');
});

test('an unrelated request is not touched', async () => {
  const env = createEnvironment({ 'creator/get_creator_channels': '{"channels":[]}' });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_creator_channels?alt=json', '{}');
  assert.strictEqual(result.text, '{"channels":[]}');
  assert.strictEqual(env.sent.length, 1, 'passed through on the original object');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (error) {
      failed++;
      console.log('  FAIL ' + name);
      console.log('       ' + error.message);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passing');
  process.exit(failed ? 1 : 0);
})();
