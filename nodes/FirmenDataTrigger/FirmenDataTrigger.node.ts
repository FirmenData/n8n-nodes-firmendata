/* eslint @n8n/community-nodes/node-usable-as-tool: off -- Polling triggers cannot be AI tools; the bundled older rule does not exempt them. */
import type {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IPollFunctions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
  insolvencyCountry,
  insolvencyFilters,
  newCompanyCountry,
  newCompanyFilters,
} from './feedFilters';

const MAX_PAGES = 10;
const MAX_SEEN_IDS = 2_000;

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
export class FirmenDataTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FirmenData Trigger',
    name: 'firmenDataTrigger',
    icon: { light: 'file:firmendata.svg', dark: 'file:firmendata.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Poll German, Austrian and Swiss company or insolvency events (Beta)',
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
        default:
          'Beta feeds start from now on the first poll. Each page with events costs 1 credit; empty pages are free.',
      },
      { ...newCompanyCountry, displayOptions: { show: { event: ['newCompany'] } } },
      { ...insolvencyCountry, displayOptions: { show: { event: ['insolvencyNotice'] } } },
      {
        displayName: 'Page Size',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        // Keep the existing parameter key while using the feed page-size default.
        // eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-limit
        default: 100,
        // eslint-disable-next-line n8n-nodes-base/node-param-description-wrong-for-limit
        description:
          'Events per page; each page with events costs 1 credit (empty pages are free), and one poll fetches at most 10 pages',
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
    const country = this.getNodeParameter(
      'country',
      event === 'insolvencyNotice' ? 'DE' : '',
    ) as string;
    if (country) qs.country = country;
    for (const [field, parameter] of [
      ['bundesland', 'bundesland'],
      ['canton', 'canton'],
      ['industrySlug', 'industry_slug'],
      ['rechtsform', 'rechtsform'],
      ['registerCourt', 'register_court'],
      ...(event === 'insolvencyNotice' ? [['category', 'category']] : []),
    ]) {
      const values = filters[field];
      if (values?.length) qs[parameter] = [...values].sort().join(',');
    }

    // A cursor belongs to a particular feed and filter selection. Editing them
    // starts a new stream at now. Manual tests must not consume the live cursor.
    const stream = JSON.stringify({ endpoint, qs });
    const manual = this.getMode() === 'manual';
    const state: FeedState = manual ? {} : this.getWorkflowStaticData('node');
    if (state.stream !== stream) {
      state.stream = stream;
      state.since = new Date(Date.now() - (manual ? 24 * 60 * 60 * 1000 : 0)).toISOString();
      delete state.cursor;
      delete state.seenIds;
    }
    qs.limit = manual ? 1 : (this.getNodeParameter('limit', 100) as number);
    let cursor = state.cursor;
    const seen = new Set(state.seenIds ?? []);
    const items: INodeExecutionData[] = [];

    let recovered = false;
    let since = state.since;
    for (let page = 0; page < (manual ? 1 : MAX_PAGES); page++) {
      let response: FeedResponse;
      try {
        response = (await this.helpers.httpRequestWithAuthentication.call(this, 'firmenDataApi', {
          method: 'GET',
          url: `https://api.firmendata.com/v1/feeds/${endpoint}`,
          headers: { Accept: 'application/json' },
          qs: { ...qs, ...(cursor === undefined ? { since } : { cursor }) },
          json: true,
          timeout: 30_000,
        })) as FeedResponse;
      } catch (error) {
        // Authenticated HTTP helpers preserve the RFC 7807 body in response.data.
        const problem =
          error.context?.data ?? error.response?.data ?? error.response?.body ?? error.error;
        const status =
          error.statusCode ?? error.httpCode ?? error.response?.status ?? problem?.status;
        if (
          !manual &&
          !recovered &&
          Number(status) === 422 &&
          typeof problem?.type === 'string' &&
          problem.type.endsWith('cursor_expired')
        ) {
          recovered = true;
          cursor = undefined;
          since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString();
          this.logger?.warn?.(
            'FirmenData feed cursor expired; resuming from the last seven days with a ten-minute margin',
          );
          page--;
          continue;
        }
        if (error instanceof NodeOperationError) {
          throw new NodeOperationError(this.getNode(), error);
        }
        throw new NodeApiError(this.getNode(), error as JsonObject);
      }
      if (
        !response ||
        typeof response.next_cursor !== 'string' ||
        typeof response.has_more !== 'boolean'
      ) {
        throw new NodeOperationError(
          this.getNode(),
          'Invalid feed response: missing next_cursor or has_more',
        );
      }
      if (
        response.data !== undefined &&
        (!Array.isArray(response.data) ||
          response.data.some((entry) => !entry || typeof entry.id !== 'string'))
      ) {
        throw new NodeOperationError(
          this.getNode(),
          'Invalid feed response: expected events with string IDs',
        );
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
    if (!manual) {
      state.since = since;
      state.cursor = cursor;
      state.seenIds = [...seen].slice(-MAX_SEEN_IDS);
    }
    return items.length ? [items] : null;
  }
}
