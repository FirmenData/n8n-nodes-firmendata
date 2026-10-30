import type {
  DeclarativeRestApiSettings,
  IDataObject,
  IExecutePaginationFunctions,
  IExecuteSingleFunctions,
  INodeExecutionData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/** Link every emitted result to the input that produced it. */
export async function pairItems(
  this: IExecuteSingleFunctions,
  items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
  return items.map((item) => ({ ...item, pairedItem: { item: this.getItemIndex() } }));
}

/** Use n8n's transport and postReceive processing for every search page. */
export async function searchPages(
  this: IExecutePaginationFunctions,
  request: DeclarativeRestApiSettings.ResultOptions,
): Promise<INodeExecutionData[]> {
  const maximum = this.getNodeParameter('returnAll', false)
    ? 10_000
    : Math.min(1000, Math.max(1, Number(this.getNodeParameter('searchLimit', 50))));
  const items: INodeExecutionData[] = [];
  let pagination: IDataObject | undefined;
  // makeRoutingRequest applies the original request's postReceive actions.
  // Capture the envelope before rootProperty extracts its companies.
  const capture = {
    data: { parameterValue: undefined },
    actions: [
      async (pageItems: INodeExecutionData[], response: { body: unknown }) => {
        pagination = (response.body as IDataObject).pagination as IDataObject | undefined;
        return pageItems;
      },
    ],
  };
  request.postReceive.unshift(capture);
  const initialQuery = { ...request.options.qs };
  let cursor =
    typeof initialQuery.cursor === 'string' && initialQuery.cursor
      ? initialQuery.cursor
      : undefined;
  try {
    while (items.length < maximum) {
      request.options.qs = {
        ...(cursor === undefined ? initialQuery : { cursor }),
        limit: Math.min(50, maximum - items.length),
      };
      const page = await this.makeRoutingRequest(request);
      items.push(...page.slice(0, maximum - items.length));
      if (!pagination?.has_more) break;
      const next = pagination.next_cursor;
      if (typeof next !== 'string' || !next || next === cursor || !page.length) {
        throw new NodeOperationError(
          this.getNode(),
          'Invalid search pagination: missing or repeated cursor, or empty continuation page',
        );
      }
      cursor = next;
    }
  } finally {
    request.postReceive.splice(request.postReceive.indexOf(capture), 1);
  }
  return items;
}

/** Fetch the signed URL without the API credential or its headers. */
export async function downloadFile(
  this: IExecuteSingleFunctions,
  items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
  if (!this.getNodeParameter('downloadFile', false)) return items;
  for (const item of items) {
    const response = await this.helpers.httpRequest({
      method: 'GET',
      url: item.json.download_url as string,
      encoding: 'arraybuffer',
      returnFullResponse: true,
    });
    const mimeType = response.headers['content-type'] || item.json.mime_type || 'application/pdf';
    const fileName = item.json.file_name_en || item.json.file_name_de || 'document.pdf';
    item.binary = {
      ...item.binary,
      data: await this.helpers.prepareBinaryData(response.body, String(fileName), String(mimeType)),
    };
  }
  return items;
}
