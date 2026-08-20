import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

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
              request: { method: 'GET', url: '=/v1/companies/{{$parameter.euId}}' },
            },
          },
          {
            name: 'Get Financials',
            value: 'financials',
            action: 'Get company financials',
            description: 'Multi-year financial statements, parsed into figures',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{$parameter.euId}}/financials' },
            },
          },
          {
            name: 'Get History',
            value: 'history',
            action: 'Get company register history',
            description: 'Chronological register history',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{$parameter.euId}}/history' },
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
                url: '=/v1/companies/{{$parameter.euId}}/shareholders',
              },
            },
          },
          {
            name: 'Get UBO',
            value: 'ubo',
            action: 'Get ultimate beneficial owners',
            description: 'Beneficial owners resolved through ownership chains',
            routing: {
              request: { method: 'GET', url: '=/v1/companies/{{$parameter.euId}}/ubo' },
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
        // Alphabetical by displayName — enforced by n8n's linter.
        options: [
          {
            displayName: 'City Names or IDs',
            name: 'city',
            type: 'string',
            default: '',
            placeholder: 'Berlin, Hamburg',
            description: 'Comma-separated list of cities',
            routing: {
              request: {
                qs: {
                  city: '={{$value ? $value.split(",").map(s => s.trim()) : undefined}}',
                },
              },
            },
          },
          {
            displayName: 'Cursor',
            name: 'cursor',
            type: 'string',
            default: '',
            description:
              'Pagination cursor from a previous response (<code>pagination.next_cursor</code>)',
            routing: { request: { qs: { cursor: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Federal State',
            name: 'bundesland',
            type: 'string',
            default: '',
            placeholder: 'Bayern',
            description: 'Comma-separated list of federal states',
            routing: {
              request: {
                qs: {
                  bundesland: '={{$value ? $value.split(",").map(s => s.trim()) : undefined}}',
                },
              },
            },
          },
          {
            displayName: 'Has Website',
            name: 'hasWebsite',
            type: 'boolean',
            default: false,
            description: 'Whether to return only companies with a known website',
            routing: { request: { qs: { has_website: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Legal Form',
            name: 'rechtsform',
            type: 'string',
            default: '',
            placeholder: 'GmbH',
            description: 'Comma-separated list of legal forms',
            routing: {
              request: {
                qs: {
                  rechtsform: '={{$value ? $value.split(",").map(s => s.trim()) : undefined}}',
                },
              },
            },
          },
          {
            displayName: 'Legal Status',
            name: 'legalStatus',
            type: 'multiOptions',
            default: [],
            description: 'Only companies in these legal states',
            options: [
              { name: 'Active', value: 'active' },
              { name: 'Deleted', value: 'deleted' },
              { name: 'Dissolved', value: 'dissolved' },
              { name: 'In Liquidation', value: 'in_liquidation' },
              { name: 'Insolvent', value: 'insolvent' },
            ],
            routing: {
              request: { qs: { legal_status: '={{$value.length ? $value : undefined}}' } },
            },
          },
          {
            displayName: 'Maximum Revenue',
            name: 'revenueMax',
            type: 'number',
            default: 0,
            description: 'Only companies with at most this revenue, in EUR',
            routing: { request: { qs: { revenue_max: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Minimum Employees',
            name: 'employeeCountMin',
            type: 'number',
            default: 0,
            description: 'Only companies with at least this many employees',
            routing: { request: { qs: { employee_count_min: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Minimum Revenue',
            name: 'revenueMin',
            type: 'number',
            default: 0,
            description: 'Only companies with at least this revenue, in EUR',
            routing: { request: { qs: { revenue_min: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Person Name',
            name: 'personName',
            type: 'string',
            default: '',
            placeholder: 'Max Mustermann',
            description: 'Companies connected to a person by name',
            routing: { request: { qs: { person_name: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Register Number',
            name: 'registerNumber',
            type: 'number',
            default: 0,
            placeholder: '123456',
            description: 'Exact register number, e.g. 123456 for HRB 123456',
            routing: { request: { qs: { register_number: '={{$value || undefined}}' } } },
          },
          {
            displayName: 'Register Type',
            name: 'registerType',
            type: 'options',
            default: 'HRB',
            options: [
              { name: 'GnR', value: 'GnR' },
              { name: 'GsR', value: 'GsR' },
              { name: 'HRA', value: 'HRA' },
              { name: 'HRB', value: 'HRB' },
              { name: 'PR', value: 'PR' },
              { name: 'VR', value: 'VR' },
            ],
            routing: { request: { qs: { register_type: '={{$value || undefined}}' } } },
          },
        ],
      },
    ],
  };
}
