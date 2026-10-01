import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
for (const name of ['searchFilters', 'FirmenData.node']) {
  const source = readFileSync(join(root, 'nodes', 'FirmenData', `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  });
  writeFileSync(join(work, `${name}.js`), outputText);
}
const { FirmenData } = require(join(work, 'FirmenData.node.js'));
const { description } = new FirmenData();
const properties = description.properties;
const operations = properties.find((p) => p.name === 'operation').options;
const filters = properties.find((p) => p.name === 'filters').options;
const contract = JSON.parse(readFileSync(join(root, 'contracts', 'openapi.v1.json'), 'utf8'));

// A small routing harness: resolve the declarations with n8n's own expression
// evaluator, then send the resulting request to a mocked HTTP helper. n8n
// owns the actual transport and workflow execution; this tests our routing.
async function request(parameters, httpRequest) {
  const params = { resource: 'company', ...parameters };
  const operation = operations.find((o) => o.value === params.operation);
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
  return await httpRequest(result);
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

test('List Documents makes an encoded GET without query parameters and preserves the catalog', async () => {
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
  assert.deepEqual(await request({ operation: 'listDocuments', euId: response.eu_id }, http), response);
  assert.equal(http.mock.callCount(), 1);
  assert.deepEqual(http.mock.calls[0].arguments[0], {
    method: 'GET',
    url: 'https://api.firmendata.com/v1/companies/DE%2Fcompany%20%3F%23/documents',
    qs: {},
  });
});

test('List Documents preserves an empty Swiss response and coverage', async () => {
  const response = {
    object: 'company_document_list', eu_id: 'CHE-123', country_code: 'CH',
    data: [], coverage: { status: 'not_applicable' }, freshness: { last_checked_at: null },
  };
  const http = mock.fn(async () => response);
  assert.deepEqual(await request({ operation: 'listDocuments', euId: 'CHE-123' }, http), response);
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
    assert.deepEqual(http.mock.calls[0].arguments[0].qs, { limit: 50, ...qs });
  }
});

test('Search sends country, comma-joined cantons, federal states and Swiss legal forms', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: {
    country: 'CH', canton: ['GE', 'ZH'], bundesland: ['Berlin'], rechtsform: ['AG (CH)', 'GmbH (CH)'],
  } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0], {
    method: 'GET', url: 'https://api.firmendata.com/v1/companies/search',
    qs: { limit: 50, country: 'CH', canton: 'GE,ZH', bundesland: 'Berlin', rechtsform: 'AG (CH),GmbH (CH)' },
  });
  const legalForm = filters.find((p) => p.name === 'rechtsform');
  assert.deepEqual(legalForm.options.map((o) => o.value).sort(), [...contract.components.schemas.Rechtsform.enum].sort());
});

test('Search omits empty location filters and leaves name ordering to the API', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: { canton: [], sort: 'name' } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { limit: 50, sort: 'name' });
});

test('Search keeps an explicit sort direction', async () => {
  const http = mock.fn(async () => ({ data: [] }));
  await request({ operation: 'search', filters: { sort: 'name', sortDirection: 'desc' } }, http);
  assert.deepEqual(http.mock.calls[0].arguments[0].qs, { limit: 50, sort: 'name', sort_direction: 'desc' });
});

test('Get Financials retains lean defaults and optional line items and years', async () => {
  for (const [options, qs] of [
    [{}, {}], [{ includeLineItems: true, years: 3 }, { include: 'line_items', years: 3 }],
  ]) {
    const http = mock.fn(async () => ({ eu_id: 'DE123' }));
    await request({ operation: 'financials', euId: 'DE123', ...options }, http);
    assert.deepEqual(http.mock.calls[0].arguments[0], {
      method: 'GET', url: 'https://api.firmendata.com/v1/companies/DE123/financials', qs,
    });
  }
});
