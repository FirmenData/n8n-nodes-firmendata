import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'firmendata-trigger-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
for (const name of ['feedFilters', 'FirmenDataTrigger.node']) {
  const source = readFileSync(join(root, 'nodes', 'FirmenDataTrigger', `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  });
  writeFileSync(join(work, `${name}.js`), outputText);
}
const { FirmenDataTrigger } = require(join(work, 'FirmenDataTrigger.node.js'));
const trigger = new FirmenDataTrigger();
const contract = JSON.parse(readFileSync(join(root, 'contracts', 'openapi.v1.json'), 'utf8'));

function harness(parameters = {}, state = {}, mode = 'trigger', handler) {
  const params = { event: 'newCompany', limit: 50, filters: {}, ...parameters };
  const http = mock.fn(handler ?? (async () => ({ data: [], next_cursor: 'empty', has_more: false })));
  const context = {
    getNodeParameter: (name, fallback) => params[name] ?? fallback,
    getMode: () => mode,
    getNode: () => ({ name: 'FirmenData Trigger', type: 'firmenDataTrigger', typeVersion: 1 }),
    getWorkflowStaticData: mock.fn((scope) => {
      assert.equal(scope, 'node');
      return state;
    }),
    helpers: { httpRequestWithAuthentication: http },
  };
  return { params, state, http, context, poll: () => trigger.poll.call(context) };
}

const event = (id) => ({
  id, object: 'feed_event', type: 'company.founded', discovered_at: '2026-10-12T00:00:00Z',
  company: { country: 'DE', eu_id: 'DE123', name: 'Test GmbH' }, links: { company: null },
});
const page = (ids, cursor, hasMore = false) => ({
  data: ids.map(event), next_cursor: cursor, has_more: hasMore,
});

test('first poll uses now, authenticated transport and persists an empty page cursor unchanged', async () => {
  const cursor = 'opaque+/= ?%token';
  const h = harness({}, {}, 'trigger', async () => page([], cursor));
  const start = Date.now();
  assert.equal(await h.poll(), null);
  const [credential, options] = h.http.mock.calls[0].arguments;
  assert.equal(credential, 'firmenDataApi');
  assert.equal(h.http.mock.calls[0].this, h.context);
  assert.equal(options.method, 'GET');
  assert.equal(options.url, 'https://api.firmendata.com/v1/feeds/new-companies');
  assert.deepEqual(Object.keys(options.qs).sort(), ['limit', 'since']);
  assert.equal(options.qs.limit, 50);
  assert.ok(Date.parse(options.qs.since) >= start && Date.parse(options.qs.since) <= Date.now());
  assert.equal(h.state.cursor, cursor);
  await h.poll();
  assert.deepEqual(h.http.mock.calls[1].arguments[1].qs, { limit: 50, cursor });
});

test('has_more pages immediately, emits intact events and deduplicates across pages and restarts', async () => {
  const pages = [page(['a', 'a'], 'one', true), page(['a', 'b'], 'two')];
  const h = harness({}, {}, 'trigger', async () => pages.shift());
  assert.deepEqual(await h.poll(), [[{ json: event('a') }, { json: event('b') }]]);
  assert.equal(h.http.mock.callCount(), 2);
  assert.equal(h.http.mock.calls[1].arguments[1].qs.cursor, 'one');
  assert.equal(h.state.cursor, 'two');
  const restored = JSON.parse(JSON.stringify(h.state));
  const next = harness({}, restored, 'trigger', async () => page(['a', 'b', 'c'], 'three'));
  assert.deepEqual(await next.poll(), [[{ json: event('c') }]]);
  assert.equal(next.http.mock.calls[0].arguments[1].qs.cursor, 'two');
  assert.equal(next.state.cursor, 'three');
});

test('ten-page cap saves the continuation and resumes next poll', async () => {
  let count = 0;
  const h = harness({ limit: 100 }, {}, 'trigger', async () => page([String(++count)], `cursor-${count}`, true));
  assert.equal((await h.poll())[0].length, 10);
  assert.equal(h.http.mock.callCount(), 10);
  assert.equal(h.state.cursor, 'cursor-10');
  assert.equal((await h.poll())[0].length, 10);
  assert.equal(h.http.mock.calls[10].arguments[1].qs.cursor, 'cursor-10');
  assert.equal(h.http.mock.calls[10].arguments[1].qs.limit, 100);
});

test('empty has_more page continues immediately; duplicate-only pages still advance', async () => {
  const pages = [page([], 'one', true), page(['a'], 'two'), page(['a'], 'three')];
  const h = harness({}, {}, 'trigger', async () => pages.shift());
  assert.deepEqual(await h.poll(), [[{ json: event('a') }]]);
  assert.equal(h.http.mock.callCount(), 2);
  assert.equal(await h.poll(), null);
  assert.equal(h.state.cursor, 'three');
});

test('filters use canonical query names and empty values are omitted for both feeds', async () => {
  for (const selectedEvent of ['newCompany', 'insolvencyNotice']) {
    const h = harness({ event: selectedEvent, country: 'CH', filters: {
      bundesland: ['Berlin'], canton: ['ZH', 'GE'], rechtsform: ['AG (CH)'],
      industrySlug: ['it'], category: ['Schuldenruf'],
      registerCourt: ['München', 'Berlin (Charlottenburg)'],
    } });
    await h.poll();
    const options = h.http.mock.calls[0].arguments[1];
    assert.equal(options.url, `https://api.firmendata.com/v1/feeds/${selectedEvent === 'newCompany' ? 'new-companies' : 'insolvencies'}`);
    assert.deepEqual(options.qs, {
      country: 'CH', bundesland: 'Berlin', canton: 'GE,ZH', rechtsform: 'AG (CH)',
      industry_slug: 'it', register_court: 'Berlin (Charlottenburg),München',
      ...(selectedEvent === 'insolvencyNotice' ? { category: 'Schuldenruf' } : {}),
      limit: 50, since: h.state.since,
    });
  }
  const h = harness({ event: 'insolvencyNotice', filters: {
    canton: [], category: [], industrySlug: [], registerCourt: [],
  } });
  await h.poll();
  assert.deepEqual(h.http.mock.calls[0].arguments[1].qs, { country: 'DE', limit: 50, since: h.state.since });
});

test('a failed later page does not consume undelivered events; retries retain the initial since', async () => {
  let fail = true;
  const h = harness({}, {}, 'trigger', async (_credential, { qs }) => {
    if (!qs.cursor) return page(['a'], 'one', true);
    if (fail) throw new Error('rate limited');
    return page(['b'], 'two');
  });
  await assert.rejects(h.poll(), /rate limited/);
  assert.equal(h.state.cursor, undefined);
  assert.equal(h.state.seenIds, undefined);
  const since = h.state.since;
  fail = false;
  assert.deepEqual(await h.poll(), [[{ json: event('a') }, { json: event('b') }]]);
  assert.equal(h.http.mock.calls[2].arguments[1].qs.since, since);
  const saved = structuredClone(h.state);
  h.context.helpers.httpRequestWithAuthentication = async () => { throw new Error('network failure'); };
  await assert.rejects(h.poll(), /network failure/);
  assert.deepEqual(h.state, saved);
});

test('missing cursors, invalid pagination and malformed events fail without advancing state', async () => {
  const h = harness();
  await h.poll();
  const saved = structuredClone(h.state);
  for (const response of [null, { data: [] }, { next_cursor: 'x', has_more: 'false' },
    { next_cursor: 'x', has_more: false, data: [{}] }]) {
    h.context.helpers.httpRequestWithAuthentication = async () => response;
    await assert.rejects(h.poll(), /Invalid feed response/);
    assert.deepEqual(h.state, saved);
  }
});

test('event/filter edits start from now; changing page size or filter order preserves cursor', async () => {
  const h = harness({ filters: { canton: ['ZH', 'GE'] } });
  await h.poll();
  h.params.filters.canton.reverse();
  h.params.limit = 100;
  await h.poll();
  assert.equal(h.http.mock.calls[1].arguments[1].qs.cursor, 'empty');
  h.params.country = 'CH';
  await h.poll();
  assert.equal(h.http.mock.calls[2].arguments[1].qs.cursor, undefined);
  assert.ok(h.http.mock.calls[2].arguments[1].qs.since);
  h.params.event = 'insolvencyNotice';
  await h.poll();
  assert.equal(h.http.mock.calls[3].arguments[1].qs.cursor, undefined);
});

test('manual polling does not mutate or consume live state', async () => {
  const h = harness();
  await h.poll();
  const saved = structuredClone(h.state);
  const manual = harness({}, h.state, 'manual', async () => page(['test'], 'manual'));
  assert.deepEqual(await manual.poll(), [[{ json: event('test') }]]);
  assert.deepEqual(h.state, saved);
  assert.equal(manual.http.mock.calls[0].arguments[1].qs.cursor, undefined);
  assert.equal(manual.context.getWorkflowStaticData.mock.callCount(), 0);
});

test('deduplication history is bounded while suppressing recent IDs', async () => {
  const h = harness();
  await h.poll();
  h.state.seenIds = Array.from({ length: 10_000 }, (_, i) => `old-${i}`);
  h.context.helpers.httpRequestWithAuthentication = async () => page(['old-9999', 'new'], 'next');
  assert.deepEqual(await h.poll(), [[{ json: event('new') }]]);
  assert.equal(h.state.seenIds.length, 10_000);
  assert.equal(h.state.seenIds[0], 'old-1');
  assert.equal(h.state.seenIds.at(-1), 'new');
});

test('generated feed pickers match each endpoint enum and category is insolvency-only', () => {
  for (const [selectedEvent, path] of [
    ['newCompany', '/v1/feeds/new-companies'], ['insolvencyNotice', '/v1/feeds/insolvencies'],
  ]) {
    const filters = trigger.description.properties.find((p) => p.name === 'filters'
      && p.displayOptions.show.event.includes(selectedEvent)).options;
    const country = trigger.description.properties.find((p) => p.name === 'country'
      && p.displayOptions.show.event.includes(selectedEvent));
    assert.deepEqual(country.options.map((o) => o.value).filter(Boolean).sort(),
      [...contract.components.schemas.Country.enum].sort());
    assert.equal(country.default, selectedEvent === 'newCompany' ? '' : 'DE');
    const resolve = (schema) => schema.$ref
      ? resolve(contract.components.schemas[schema.$ref.split('/').at(-1)])
      : schema.anyOf ? resolve(schema.anyOf.find((s) => s.type !== 'null')) : schema;
    const names = filters.map((p) => p.displayName);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    for (const field of filters) {
      const name = field.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      const param = contract.paths[path].get.parameters.find((p) => p.name === name);
      assert.ok(param, `Missing parameter ${name} in ${path}`);
      assert.deepEqual(field.options.map((o) => o.value).sort(), [...resolve(resolve(param.schema).items).enum].sort());
    }
    assert.equal(filters.some((p) => p.name === 'category'), selectedEvent === 'insolvencyNotice');
    assert.ok(filters.some((p) => p.name === 'registerCourt' && p.type === 'multiOptions'));
  }
});
