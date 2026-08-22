import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { searchFilters } from './searchFilters';

/**
 * FirmenData node — German company data.
 *
 * Written in n8n's **declarative** style: each operation describes the HTTP
 * request it makes via `routing`, and n8n's own request helper executes it.
 *
 * That is not a stylistic choice. n8n's community-node verification forbids
 * runtime dependencies entirely, so this package cannot import
 * `firmendata (npm)` (or anything else) at runtime. Declarative routing means
 * there is nothing to import: no HTTP client, no auth handling, no retry
 * logic of our own. n8n renders the operations natively and users get
 * expression support on every field for free.
 *
 * `NodeConnectionTypes.Main` rather than the string literal `'main'`: n8n's
 * community-node scanner rejects the literal outright
 * (@n8n/community-nodes/node-connection-type-literal), and a rejection there
 * is automatic. It makes this the one value import in the package, from the
 * `n8n-workflow` peer dependency that n8n itself provides at runtime.
 *
 * Options inside each `options: []` array are ordered alphabetically by
 * display name. n8n's linter enforces that; keep it when adding operations.
 */
export class FirmenData implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FirmenData',
    name: 'firmenData',
    icon: { light: 'file:firmendata.svg', dark: 'file:firmendata.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description:
      'Look up German company data: register profiles, financials, shareholders and UBO',
    defaults: { name: 'FirmenData' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: 'firmenDataApi', required: true }],
    requestDefaults: {
      baseURL: 'https://api.firmendata.com',
      headers: { Accept: 'application/json' },
      // Without this, n8n serialises array query params through its global
      // axios default of `qs.stringify(..., {arrayFormat: 'indices'})`, so a
      // multi-value filter goes out as `rechtsform[0]=GmbH&rechtsform[1]=AG`.
      // FastAPI binds `rechtsform`, finds nothing, and applies no filter —
      // returning 200 with the *unfiltered* register. That is what made the
      // Legal Form filter appear to do nothing, and it is silent: no error,
      // just more results than you asked for.
      //
      // 'repeat' produces `rechtsform=GmbH&rechtsform=AG`, which is what the
      // API binds. The generated filters additionally comma-join their values
      // so they stay correct even if this default is ever lost.
      arrayFormat: 'repeat',
    },
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [{ name: 'Company', value: 'company' }],
        default: 'company',
      },

      // ---------------------------------------------------------------
      // Operations (alphabetical — enforced by n8n's linter)
      // ---------------------------------------------------------------
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['company'] } },
        default: 'search',
        options: [
          {
            name: 'Autocomplete',
            value: 'autocomplete',
            action: 'Autocomplete a company name',
            description: 'Suggest company names for a fragment. Costs no credits.',
            routing: { request: { method: 'GET', url: '/v1/companies/autocomplete' } },
          },
          {
            name: 'Get',
            value: 'get',
            action: 'Get a company',
            description: 'Full profile for one company',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{ encodeURIComponent($parameter.euId) }}' },
            },
          },
          {
            name: 'Get Financials',
            value: 'financials',
            action: 'Get company financials',
            description: 'Multi-year financial statements, parsed into figures',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{ encodeURIComponent($parameter.euId) }}/financials' },
            },
          },
          {
            name: 'Get History',
            value: 'history',
            action: 'Get company register history',
            description: 'Chronological register history',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{ encodeURIComponent($parameter.euId) }}/history' },
            },
          },
          {
            name: 'Get Shareholders',
            value: 'shareholders',
            action: 'Get company shareholders',
            description: 'Cap table from the most recent Gesellschafterliste',
            routing: {
              request: {
                method: 'GET',
                url: '=/v1/companies/{{ encodeURIComponent($parameter.euId) }}/shareholders',
              },
            },
          },
          {
            name: 'Get UBO',
            value: 'ubo',
            action: 'Get ultimate beneficial owners',
            description: 'Beneficial owners resolved through ownership chains',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{ encodeURIComponent($parameter.euId) }}/ubo' },
            },
          },
          {
            name: 'Search',
            value: 'search',
            action: 'Search companies',
            description: 'Search the German commercial register with filters',
            routing: { request: { method: 'GET', url: '/v1/companies/search' } },
          },
        ],
      },

      // ---------------------------------------------------------------
      // Autocomplete
      // ---------------------------------------------------------------
      {
        displayName: 'Query',
        name: 'q',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'siemens',
        description: 'Company-name fragment. At least 3 characters.',
        displayOptions: { show: { resource: ['company'], operation: ['autocomplete'] } },
        routing: { request: { qs: { q: '={{$value}}' } } },
      },
      {
        // Not called "Limit": n8n's linter requires a field by that name to
        // default to 50, and this endpoint caps at 25. A typeahead wants a
        // short list anyway, so 10 is the useful default.
        displayName: 'Max Results',
        name: 'maxResults',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 25 },
        default: 10,
        description: 'Max number of suggestions to return (up to 25)',
        displayOptions: { show: { resource: ['company'], operation: ['autocomplete'] } },
        routing: { request: { qs: { limit: '={{$value}}' } } },
      },

      // ---------------------------------------------------------------
      // Operations taking an eu_id
      // ---------------------------------------------------------------
      {
        displayName: 'Company ID (Eu ID)',
        name: 'euId',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'DEB1103R_HRB123456',
        description:
          'The company identifier returned by Search or Autocomplete as <code>eu_id</code>',
        displayOptions: {
          show: {
            resource: ['company'],
            operation: ['get', 'financials', 'shareholders', 'ubo', 'history'],
          },
        },
      },

      // ---------------------------------------------------------------
      // Search
      // ---------------------------------------------------------------
      {
        displayName: 'Search Query',
        name: 'searchQuery',
        type: 'string',
        default: '',
        placeholder: 'Siemens',
        description: 'Free-text keyword. Leave empty to filter only.',
        displayOptions: { show: { resource: ['company'], operation: ['search'] } },
        routing: { request: { qs: { q: '={{$value || undefined}}' } } },
      },
      {
        displayName: 'Limit',
        name: 'searchLimit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 50 },
        default: 50,
        description: 'Max number of results to return',
        displayOptions: { show: { resource: ['company'], operation: ['search'] } },
        routing: { request: { qs: { limit: '={{$value}}' } } },
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { resource: ['company'], operation: ['search'] } },
        // Generated from contracts/openapi.v1.json — every search filter the
        // API exposes, with real pickers for the enum-backed ones. Regenerate
        // with `npm run generate`; `npm run generate -- --check` fails CI when
        // the contract has moved and this file has not.
        options: searchFilters,
      },
    ],
  };
}
