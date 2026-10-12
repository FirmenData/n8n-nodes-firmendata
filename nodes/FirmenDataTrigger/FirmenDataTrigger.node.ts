import type {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { insolvencyCountry, insolvencyFilters, newCompanyCountry, newCompanyFilters } from './feedFilters';

const MAX_PAGES = 10;
const MAX_SEEN_IDS = 10_000;

interface FeedEvent extends IDataObject {
  id: string;
}

interface FeedResponse {
  data?: FeedEvent[];
  next_cursor: string;
  has_more: boolean;
}

interface FeedState {
  stream?: string;
  since?: string;
  cursor?: string;
  seenIds?: string[];
}

// Polling triggers have no execute method and cannot be used as AI tools.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class FirmenDataTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FirmenData Trigger',
    name: 'firmenDataTrigger',
    icon: { light: 'file:firmendata.svg', dark: 'file:firmendata.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Poll new companies or insolvency notices from FirmenData (Beta)',
    defaults: { name: 'FirmenData Trigger' },
    polling: true,
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'firmenDataApi', required: true }],
    properties: [
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        noDataExpression: true,
        default: 'newCompany',
        options: [
          { name: 'Insolvency Notice', value: 'insolvencyNotice' },
          { name: 'New Company', value: 'newCompany' },
        ],
      },
      {
        displayName: 'Feed Status',
        name: 'feedNotice',
        type: 'notice',
        default: 'Beta feeds start from now on the first poll. Each page with events costs 1 credit; empty pages are free.',
      },
      { ...newCompanyCountry, displayOptions: { show: { event: ['newCompany'] } } },
      { ...insolvencyCountry, displayOptions: { show: { event: ['insolvencyNotice'] } } },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        default: 50,
        description: 'Max number of results to return',
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { event: ['newCompany'] } },
        options: newCompanyFilters,
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { event: ['insolvencyNotice'] } },
        options: insolvencyFilters,
      },
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const event = this.getNodeParameter('event') as string;
    const endpoint = event === 'insolvencyNotice' ? 'insolvencies' : 'new-companies';
    const filters = this.getNodeParameter('filters', {}) as Record<string, string[]>;
    const qs: IDataObject = {};
    const country = this.getNodeParameter('country', event === 'insolvencyNotice' ? 'DE' : '') as string;
    if (country) qs.country = country;
    for (const [field, parameter] of [
      ['bundesland', 'bundesland'],
      ['canton', 'canton'],
      ['industrySlug', 'industry_slug'],
      ['rechtsform', 'rechtsform'],
      ...(event === 'insolvencyNotice' ? [['category', 'category']] : []),
    ]) {
      const values = filters[field];
      if (values?.length) qs[parameter] = [...values].sort().join(',');
    }

    // A cursor belongs to a particular feed and filter selection. Editing them
    // starts a new stream at now. Manual tests must not consume the live cursor.
    const stream = JSON.stringify({ endpoint, qs });
    const state: FeedState = this.getMode() === 'manual'
      ? {}
      : this.getWorkflowStaticData('node');
    if (state.stream !== stream) {
      state.stream = stream;
      state.since = new Date().toISOString();
      delete state.cursor;
      delete state.seenIds;
    }
    qs.limit = this.getNodeParameter('limit', 50) as number;
    let cursor = state.cursor;
    const seen = new Set(state.seenIds ?? []);
    const items: INodeExecutionData[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.helpers.httpRequestWithAuthentication.call(this, 'firmenDataApi', {
        method: 'GET',
        url: `https://api.firmendata.com/v1/feeds/${endpoint}`,
        headers: { Accept: 'application/json' },
        qs: { ...qs, ...(cursor === undefined ? { since: state.since } : { cursor }) },
        json: true,
        timeout: 30_000,
      }) as FeedResponse;
      if (!response || typeof response.next_cursor !== 'string' || typeof response.has_more !== 'boolean') {
        throw new NodeOperationError(this.getNode(), 'Invalid feed response: missing next_cursor or has_more');
      }
      if (response.data !== undefined && (!Array.isArray(response.data) || response.data.some(
        (entry) => !entry || typeof entry.id !== 'string',
      ))) {
        throw new NodeOperationError(this.getNode(), 'Invalid feed response: expected events with string IDs');
      }
      for (const entry of response.data ?? []) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          items.push({ json: entry });
        }
      }
      cursor = response.next_cursor;
      if (!response.has_more) break;
    }

    // Commit only after all fetched pages succeed: a later-page failure must
    // not advance past events that this poll never emitted. Empty pages still
    // advance the cursor; at the cap the next poll continues where we stopped.
    state.cursor = cursor;
    state.seenIds = [...seen].slice(-MAX_SEEN_IDS);
    return items.length ? [items] : null;
  }
}
