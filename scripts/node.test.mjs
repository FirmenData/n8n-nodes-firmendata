import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { Expression } = require('n8n-workflow');
const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'firmendata-node-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

// Load the current TypeScript sources without relying on a previous build.
symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
for (const name of ['nodes/version', 'nodes/FirmenData/searchFilters', 'nodes/FirmenData/routing',
  'nodes/FirmenData/FirmenData.node', 'credentials/FirmenDataApi.credentials']) {
  const source = readFileSync(join(root, `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  });
  mkdirSync(join(work, name, '..'), { recursive: true });
  writeFileSync(join(work, `${name}.js`), outputText);
}
const { FirmenData } = require(join(work, 'nodes/FirmenData/FirmenData.node.js'));
const { FirmenDataApi } = require(join(work, 'credentials/FirmenDataApi.credentials.js'));
const credential = new FirmenDataApi();
const { packageVersion } = require(join(work, 'nodes/version.js'));
const { NodeApiError } = require('n8n-workflow');
const { description } = new FirmenData();
const properties = description.properties;
const operations = properties.find((p) => p.name === 'operation').options;
const filters = properties.find((p) => p.name === 'filters').options;
const contract = JSON.parse(readFileSync(join(root, 'contracts', 'openapi.v1.json'), 'utf8'));

// A small routing harness: resolve the declarations with n8n's own expression
// evaluator, then send the resulting request to a mocked HTTP helper. n8n
// owns the actual transport and workflow execution; this tests our routing.
async function request(parameters, httpRequest, execution = null) {
  const params = { resource: 'company', ...parameters };
  const operationProperty = properties.find((p) => p.name === 'operation' && p.displayOptions.show.resource.includes(params.resource));
  const operation = operationProperty.options.find((o) => o.value === params.operation);
  assert.ok(operation, `Unknown operation: ${params.operation}`);
  const expression = new Expression('UTC');
  const resolve = (value, fieldValue) => expression.resolveSimpleParameterValue(value, {
    $parameter: params,
    $value: fieldValue,
  });
  const result = {
    method: operation.routing.request.method,
    url: description.requestDefaults.baseURL + resolve(operation.routing.request.url),
    qs: {},
  };
  const route = (property, value) => {
    for (const [key, expression] of Object.entries(property.routing?.request?.qs ?? {})) {
      const resolved = resolve(expression, value);
      if (resolved !== undefined) result.qs[key] = resolved;
    }
  };
  for (const property of properties) {
    const show = property.displayOptions?.show ?? {};
    if (!Object.entries(show).every(([key, values]) => values.includes(params[key]))) continue;
    const value = params[property.name] ?? property.default;
    if (property.type === 'collection') {
      for (const option of property.options) {
        if (Object.hasOwn(value, option.name)) route(option, value[option.name]);
      }
    } else {
      route(property, value);
    }
  }
  if (!execution) return await httpRequest(result);
  const node = { name: 'FirmenData', type: 'firmenData', typeVersion: 1 };
  const postReceive = [{ data: { parameterValue: undefined }, actions: operation.routing.output?.postReceive ?? [] }];
  const context = {
    getNode: () => node,
    getNodeParameter: (name, fallback) => params[name] ?? properties.find((p) => p.name === name)?.default ?? fallback,
    getItemIndex: () => execution.itemIndex ?? 0,
    helpers: execution.helpers ?? {},
    async makeRoutingRequest(requestData) {
      const body = await httpRequest(structuredClone(requestData.options));
      let items = [{ json: body }];
      // n8n processes the original request's actions on every paginated response.
      for (const group of postReceive) {
        for (const action of group.actions) {
          if (typeof action === 'function') items = await action.call(context, items, { body });
          else if (action.type === 'rootProperty') items = items.flatMap((item) =>
            item.json[action.properties.property].map((json) => ({ json })));
          else assert.fail(`Unhandled postReceive ${action.type}`);
        }
      }
      return items;
    },
  };
  try {
    const requestData = { options: result, preSend: [], postReceive };
    const items = operation.routing.operations?.pagination
      ? await operation.routing.operations.pagination.call(context, requestData)
      : await context.makeRoutingRequest(requestData);
    return items;
  } catch (error) {
    const nodeError = new NodeApiError(node, error);
    if (execution.continueOnFail) return [{ json: {}, error: nodeError }];
    throw nodeError;
  }
}

test('document operations require Company ID and stay alphabetically ordered', () => {
  const companyId = properties.find((p) => p.name === 'euId');
  assert.equal(companyId.required, true);
  for (const operation of ['listDocuments', 'downloadDocument']) {
    assert.ok(companyId.displayOptions.show.operation.includes(operation));
  }
  const names = operations.map((o) => o.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
});

test('Autocomplete defaults to all countries and sends each selected contract country', async () => {
  const country = properties.find((p) => p.name === 'country');
  assert.equal(country.default, '');
  assert.deepEqual(country.options.map((o) => o.value).filter(Boolean).sort(),
    [...contract.components.schemas.Country.enum].sort());
  for (const selected of [undefined, '', 'DE', 'CH', 'AT']) {
    const http = mock.fn(async () => ({ data: [] }));
    await request({ operation: 'autocomplete', q: 'test', country: selected }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0], {
      method: 'GET', url: 'https://api.firmendata.com/v1/companies/autocomplete',
      qs: { q: 'test', limit: 10, ...(selected ? { country: selected } : {}) },
    });
  }
});

test('List Documents makes an encoded GET without query parameters and returns paired document items', async () => {
  const response = {
    object: 'company_document_list',
    eu_id: 'DE/company ?#',
    country_code: 'DE',
    coverage: { status: 'available' },
    freshness: { last_checked_at: '2026-10-01T12:00:00Z' },
    data: [
      { document_id: null, type: 'register_extract_current', is_latest: true, stored: false },
      { document_id: 'doc_2', type: 'shareholder_list', is_latest: true, stored: true, file_id: 'file_2' },
      { document_id: 'doc_1', type: 'shareholder_list', is_latest: false, stored: false, label: 'Older version' },
    ],
  };
  const http = mock.fn(async () => response);
  assert.deepEqual(await request({ operation: 'listDocuments', euId: response.eu_id }, http, { itemIndex: 7 }),
    response.data.map((json) => ({ json, pairedItem: { item: 7 } })));
  assert.equal(http.mock.callCount(), 1);
  assert.deepEqual(http.mock.calls[0].arguments[0], {
    method: 'GET',
    url: 'https://api.firmendata.com/v1/companies/DE%2Fcompany%20%3F%23/documents',
    qs: {},
  });
});

test('List Documents emits no items for an empty Swiss response', async () => {
  const response = {
    object: 'company_document_list', eu_id: 'CHE-123', country_code: 'CH',
    data: [], coverage: { status: 'not_applicable' }, freshness: { last_checked_at: null },
  };
  const http = mock.fn(async () => response);
  assert.deepEqual(await request({ operation: 'listDocuments', euId: 'CHE-123' }, http, {}), []);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, {});
});

test('Download Document sends a specific older document_id and preserves metadata', async () => {
  const response = {
    object: 'company_document_download', document_id: 'doc_1', label: 'Older version',
    download_url: 'https://example.test/document.pdf',
  };
  const http = mock.fn(async () => response);
  assert.deepEqual(await request({
    operation: 'downloadDocument', euId: 'DE/company ?#',
    fileType: 'shareholder_list', documentId: 'doc_1',
  }, http), response);
  assert.deepEqual(http.mock.calls[0].arguments[0], {
    method: 'GET',
    url: 'https://api.firmendata.com/v1/companies/DE%2Fcompany%20%3F%23/documents/download',
    qs: { file_type: 'shareholder_list', document_id: 'doc_1' },
  });
});

test('Download Document omits empty optional parameters to request the latest version', async () => {
  const http = mock.fn(async () => ({}));
  await request({ operation: 'downloadDocument', euId: 'DE123', documentId: '' }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { file_type: 'register_extract_current' });
  const documentId = properties.find((p) => p.name === 'documentId');
  assert.equal(documentId.default, '');
  assert.notEqual(documentId.required, true);
  assert.deepEqual(documentId.displayOptions.show.operation, ['downloadDocument']);
});

test('Download Document supports stored file IDs and realtime requests', async () => {
  for (const [option, qs] of [
    [{ fileId: 'file_1' }, { file_id: 'file_1' }],
    [{ fetchRealtime: true }, { fetch_realtime: true }],
  ]) {
    const http = mock.fn(async () => ({}));
    await request({ operation: 'downloadDocument', euId: 'DE123', fileType: 'shareholder_list', ...option }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0].qs, { file_type: 'shareholder_list', ...qs });
  }
});

test('Download Document offers every contract file type and requires a selection', () => {
  const fileType = properties.find((p) => p.name === 'fileType');
  const parameter = contract.paths['/v1/companies/{eu_id}/documents/download'].get.parameters
    .find((p) => p.name === 'file_type');
  assert.equal(fileType.required, true);
  assert.deepEqual(fileType.options.map((o) => o.value).sort(), [...parameter.schema.enum].sort());
  assert.ok(parameter.schema.enum.includes(fileType.default));
});

test('generated Country and Canton pickers include all contract enum values', () => {
  for (const [name, schema, type] of [
    ['country', 'Country', 'options'], ['canton', 'Canton', 'multiOptions'],
  ]) {
    const filter = filters.find((p) => p.name === name);
    assert.equal(filter.type, type);
    assert.deepEqual(filter.options.map((o) => o.value).sort(), [...contract.components.schemas[schema].enum].sort());
  }
  assert.equal(filters.find((p) => p.name === 'country').default, 'DE');
  assert.deepEqual(filters.find((p) => p.name === 'canton').default, []);
});

test('generated Company Size picker offers micro, small and medium statutory classes', () => {
  const filter = filters.find((p) => p.name === 'companySize');
  assert.equal(filter.type, 'multiOptions');
  assert.deepEqual(filter.default, []);
  assert.deepEqual(filter.options.map((o) => o.value).sort(), ['klein', 'kleinst', 'mittelgross']);
  assert.deepEqual(filter.options.map((o) => o.value).sort(), [...contract.components.schemas.CompanySize.enum].sort());
  assert.equal(filter.options.find((o) => o.value === 'kleinst').name,
    'Micro (Kleinstkapitalgesellschaft, § 267a HGB)');
  assert.equal(filter.description, 'Statutory size class under § 267 / § 267a HGB');
});

test('Search sends canonical company sizes and omits empty selections', async () => {
  for (const [sizes, qs] of [
    [['kleinst'], { company_size: 'kleinst' }],
    [['kleinst', 'klein', 'mittelgross'], { company_size: 'kleinst,klein,mittelgross' }],
    [[], {}],
  ]) {
    const http = mock.fn(async () => ({ data: [] }));
    await request({ operation: 'search', filters: { companySize: sizes } }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0].qs, { ...qs });
  }
});

test('Search sends country, comma-joined cantons, federal states and Swiss legal forms', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: {
    country: 'CH', canton: ['GE', 'ZH'], bundesland: ['Berlin'], rechtsform: ['AG (CH)', 'GmbH (CH)'],
  } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0], {
    method: 'GET', url: 'https://api.firmendata.com/v1/companies/search',
    qs: { country: 'CH', canton: 'GE,ZH', bundesland: 'Berlin', rechtsform: 'AG (CH),GmbH (CH)' },
  });
  const legalForm = filters.find((p) => p.name === 'rechtsform');
  assert.deepEqual(legalForm.options.map((o) => o.value).sort(), [...contract.components.schemas.Rechtsform.enum].sort());
});

test('Search omits empty location filters and leaves name ordering to the API', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: { canton: [], sort: 'name' } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { sort: 'name' });
});

test('Search keeps an explicit sort direction', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: { sort: 'name', sortDirection: 'desc' } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { sort: 'name', sort_direction: 'desc' });
});

test('Get Financials always sends details, defaulting to full line items, and optional years', async () => {
  for (const [options, qs] of [
    [{}, { details: true }], [{ details: false, years: 3 }, { details: false, years: 3 }],
    [{ details: true }, { details: true }],
  ]) {
    const http = mock.fn(async () => ({ eu_id: 'DE123' }));
    await request({ operation: 'financials', euId: 'DE123', ...options }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0], {
      method: 'GET', url: 'https://api.firmendata.com/v1/companies/DE123/financials', qs,
    });
  }
});

test('generated version matches package.json and credentials identify every authenticated request', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageVersion, pkg.version);
  assert.equal(credential.authenticate.properties.headers['X-FirmenData-Client'], `n8n-node/${pkg.version}`);
  assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
  assert.equal(credential.test.request.url, '/v1/companies/autocomplete');
  // Generic authentication is shared by declarative calls and the credential test.
  for (const options of [credential.test.request, description.requestDefaults]) {
    const headers = { ...options.headers, ...credential.authenticate.properties.headers };
    assert.equal(headers['X-FirmenData-Client'], `n8n-node/${pkg.version}`);
  }
});

test('yes/no filters preserve both boolean values, while Any and absent filters are omitted', async () => {
  const names = ['hasWebsite', 'hasEmail', 'familyManaged', 'founderLed', 'successionRisk'];
  for (const name of names) {
    const field = filters.find((p) => p.name === name);
    assert.equal(field.type, 'options');
    assert.deepEqual(field.options.map((o) => [o.name, o.value]), [['Any', ''], ['No', false], ['Yes', true]]);
    const queryName = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const value of [true, false, '']) {
      const http = mock.fn(async () => ({ data: [] }));
      await request({ operation: 'search', filters: { [name]: value } }, http);
      assert.deepEqual(http.mock.calls[0].arguments[0].qs, value === '' ? {} : { [queryName]: value });
    }
  }
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search' }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, {});
});

test('an added numeric filter sends zero; absent filters stay absent', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: { profitMax: 0, revenueMin: 0 } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { profit_max: 0, revenue_min: 0 });
});

test('date filters send only the selected calendar date, including offset datetimes', async () => {
  for (const value of ['2026-10-01T00:00:00.000Z', '2026-10-01T23:45:00-05:00']) {
    const http = mock.fn(async () => ({ data: [] }));
    await request({ operation: 'search', filters: { foundedFrom: value, foundedTo: value } }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0].qs, { founded_from: '2026-10-01', founded_to: '2026-10-01' });
  }
});

test('VAT-ID is available and official register labels retain API spelling', () => {
  assert.ok(filters.some((p) => p.name === 'ustIdnr'));
  for (const name of ['registerCourt', 'registerType', 'rechtsform']) {
    const field = filters.find((p) => p.name === name);
    for (const option of field.options) {
      if (/[A-ZÄÖÜ]|\s|[()]/.test(option.value)) assert.equal(option.name, option.value);
    }
  }
  assert.equal(filters.find((p) => p.name === 'industrySlug').options
    .find((o) => o.value === 'other_services').name, 'Other Services');
});

function searchServer(counts = [50, 50, 25]) {
  let index = 0;
  let offset = 0;
  return mock.fn(async ({ qs }) => {
    assert.ok(index < counts.length, 'Unexpected extra billed page');
    const length = Math.min(qs.limit, counts[index]);
    const data = Array.from({ length }, () => ({ eu_id: `DE${offset++}` }));
    const has_more = ++index < counts.length;
    return { data, pagination: { has_more, next_cursor: has_more ? `page-${index}` : null } };
  });
}

test('Search follows a fake three-page server, sends only cursor+limit after page one and pairs every company', async () => {
  const server = searchServer();
  const result = await request({ operation: 'search', searchQuery: 'test', searchLimit: 120,
    filters: { country: 'AT', profitMax: 0 } }, server, { itemIndex: 3 });
  assert.equal(result.length, 120);
  assert.equal(new Set(result.map((item) => item.json.eu_id)).size, 120);
  assert.ok(result.every((item) => item.pairedItem.item === 3));
  assert.deepEqual(server.mock.calls.map((call) => call.arguments[0].qs), [
    { q: 'test', country: 'AT', profit_max: 0, limit: 50 },
    { cursor: 'page-1', limit: 50 }, { cursor: 'page-2', limit: 20 },
  ]);
});

test('Search default Limit stops after one page; Return All follows has_more and ignores Limit', async () => {
  let server = searchServer();
  assert.equal((await request({ operation: 'search' }, server, {})).length, 50);
  assert.equal(server.mock.callCount(), 1);
  server = searchServer();
  assert.equal((await request({ operation: 'search', returnAll: true, searchLimit: 1 }, server, {})).length, 125);
  assert.equal(server.mock.callCount(), 3);
  server = searchServer([0]);
  assert.deepEqual(await request({ operation: 'search', returnAll: true }, server, {}), []);
});

test('Search Return All stops at 10,000 results / 200 requests and Limit is bounded at 1000', async () => {
  let server = searchServer(Array(201).fill(50));
  assert.equal((await request({ operation: 'search', returnAll: true }, server, {})).length, 10000);
  assert.equal(server.mock.callCount(), 200);
  server = searchServer(Array(21).fill(50));
  assert.equal((await request({ operation: 'search', searchLimit: 1001 }, server, {})).length, 1000);
  assert.equal(server.mock.callCount(), 20);
});

test('Search stops on has_more false, rejects broken continuations and handles encoded cursors unchanged', async () => {
  const server = mock.fn(async ({ qs }) => qs.cursor
    ? { data: [{ eu_id: 'DE2' }], pagination: { has_more: false } }
    : { data: [{ eu_id: 'DE1' }], pagination: { has_more: true, next_cursor: 'opaque+/=? %' } });
  assert.equal((await request({ operation: 'search', returnAll: true }, server, {})).length, 2);
  assert.equal(server.mock.calls[1].arguments[0].qs.cursor, 'opaque+/=? %');
  await assert.rejects(request({ operation: 'search', returnAll: true }, async () =>
    ({ data: [{ eu_id: 'DE1' }], pagination: { has_more: true } }), {}), /Invalid search pagination/);
});

test('Autocomplete, List Documents and List Get Many emit one paired item per result, including empty lists', async () => {
  for (const parameters of [
    { operation: 'autocomplete', q: 'a' },
    { operation: 'listDocuments', euId: 'DE1' },
    { resource: 'list', operation: 'getMany' },
  ]) {
    const server = mock.fn(async () => ({ data: [{ id: 'one' }, { id: 'two' }] }));
    assert.deepEqual(await request(parameters, server, { itemIndex: 2 }), [
      { json: { id: 'one' }, pairedItem: { item: 2 } }, { json: { id: 'two' }, pairedItem: { item: 2 } },
    ]);
    assert.equal(server.mock.callCount(), 1);
    assert.deepEqual(await request(parameters, async () => ({ data: [] }), {}), []);
  }
});

test('Get, History, Shareholders, UBO and Financials preserve a single response object', async () => {
  const response = { eu_id: 'DE1', data: [{ id: 'nested' }], history: { metrics: [] } };
  for (const operation of ['get', 'history', 'shareholders', 'ubo', 'financials']) {
    assert.deepEqual(await request({ operation, euId: 'DE1' }, async () => response, { itemIndex: 1 }), [
      { json: response, pairedItem: { item: 1 } },
    ]);
  }
});

test('List Get uses the list ID and returns its envelope with optional free paging', async () => {
  const response = { list_id: 42, name: 'KYC', data: [{ eu_id: 'AT1' }], pagination: { has_more: false } };
  const server = mock.fn(async () => response);
  assert.deepEqual(await request({ resource: 'list', operation: 'get', listId: 42,
    listOptions: { cursor: 'next', pageSize: 20 } }, server, {}), [{ json: response, pairedItem: { item: 0 } }]);
  assert.deepEqual(server.mock.calls[0].arguments[0], {
    method: 'GET', url: 'https://api.firmendata.com/v1/lists/42', qs: { cursor: 'next', limit: 20 },
  });
});

test('live register option is optional and preserves explicit true and false on every supported operation', async () => {
  for (const [operation, liveCost] of [['get', 10], ['history', 10], ['shareholders', 20], ['ubo', 50], ['autocomplete', 5]]) {
    const options = properties.find((p) => p.name === 'options' && p.displayOptions.show.operation.includes(operation));
    const live = options.options.find((p) => p.name === 'fetchRealtime');
    assert.equal(live.displayName, 'Fetch Live From Register');
    assert.ok(live.description.includes(`${liveCost} credits`));
    for (const value of [undefined, true, false]) {
      const server = mock.fn(async () => ({}));
      await request({ operation, euId: 'DE1', q: 'abc', options: value === undefined ? {} : { fetchRealtime: value } }, server);
      const qs = server.mock.calls[0].arguments[0].qs;
      assert.equal(qs.fetch_realtime, value);
      assert.equal(Object.hasOwn(qs, 'fetch_realtime'), value !== undefined);
    }
  }
});

test('Download File fetches signed URLs without credentials, preserves metadata and prepares binary data', async () => {
  for (const [metadata, headers, filename, mime] of [
    [{ file_name_en: 'Extract.pdf', file_name_de: 'Auszug.pdf' }, { 'content-type': 'application/pdf' }, 'Extract.pdf', 'application/pdf'],
    [{ file_name_de: 'Auszug.pdf' }, { 'content-type': 'application/octet-stream' }, 'Auszug.pdf', 'application/octet-stream'],
    [{}, {}, 'document.pdf', 'application/pdf'],
  ]) {
    const response = { ...metadata, download_url: 'https://files.example.test/signed.pdf?signature=abc' };
    const bytes = Buffer.from('%PDF-1.4 test');
    const httpRequest = mock.fn(async () => ({ body: bytes, headers }));
    const prepareBinaryData = mock.fn(async (data, fileName, mimeType) => ({ data: data.toString('base64'), fileName, mimeType }));
    const result = await request({ operation: 'downloadDocument', euId: 'DE1', downloadFile: true },
      async () => response, { itemIndex: 4, helpers: { httpRequest, prepareBinaryData } });
    assert.deepEqual(httpRequest.mock.calls[0].arguments[0], {
      method: 'GET', url: response.download_url, encoding: 'arraybuffer', returnFullResponse: true,
    });
    assert.deepEqual(prepareBinaryData.mock.calls[0].arguments, [bytes, filename, mime]);
    assert.deepEqual(result, [{ json: response, pairedItem: { item: 4 }, binary: {
      data: { data: bytes.toString('base64'), fileName: filename, mimeType: mime },
    } }]);
  }
  const httpRequest = mock.fn();
  const response = { download_url: 'https://files.example.test/signed.pdf' };
  assert.deepEqual(await request({ operation: 'downloadDocument', euId: 'DE1' }, async () => response,
    { helpers: { httpRequest } }), [{ json: response, pairedItem: { item: 0 } }]);
  assert.equal(httpRequest.mock.callCount(), 0);
});

test('RFC 7807 API messages surface for 401/402/404/422/429 and continueOnFail returns an error item', async () => {
  for (const status of [401, 402, 404, 422, 429]) {
    const message = `API detail for ${status}`;
    const problem = { type: `https://api.firmendata.com/problems/${status}`, title: 'Problem', status,
      detail: message, message, request_id: 'req_1', errors: [] };
    const server = async () => { throw { message: `Request failed with status code ${status}`,
      response: { status, data: problem }, isAxiosError: true }; };
    for (const operation of ['get', 'search']) {
      await assert.rejects(request({ operation, euId: 'DE1' }, server, {}),
        (error) => error instanceof NodeApiError && (error.message.includes(message) || error.description?.includes(message)));
      const result = await request({ operation, euId: 'DE1' }, server, { continueOnFail: true, itemIndex: 5 });
      assert.equal(result.length, 1);
      assert.equal(result[0].error.description, message);
    }
  }
});

test('an initial search cursor continues with only cursor and page size', async () => {
  const server = mock.fn(async () => ({ data: [{ eu_id: 'DE1' }], pagination: { has_more: false } }));
  await request({ operation: 'search', searchQuery: 'old query', filters: { cursor: 'saved', country: 'CH' } }, server, {});
  assert.deepEqual(server.mock.calls[0].arguments[0].qs, { cursor: 'saved', limit: 50 });
});
