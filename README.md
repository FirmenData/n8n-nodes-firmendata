# n8n-nodes-firmendata

An [n8n](https://n8n.io) community node for [firmendata](https://firmendata.com) —
German, Austrian and Swiss company register data: profiles, annual financial
statements, shareholders, UBO chains and register history, plus polling triggers
for new companies and insolvency notices.

[![npm](https://img.shields.io/npm/v/n8n-nodes-firmendata)](https://www.npmjs.com/package/n8n-nodes-firmendata)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and enter `n8n-nodes-firmendata` as the npm package name.

## Operations

### Company

| Operation | What it returns |
|---|---|
| **Autocomplete** | One item per company-name suggestion, from **1 character**, optionally restricted by **Country** (All, DE, CH or AT). Costs 0 credits unless live register fetching is requested. |
| **Search** | One item per company, with filters for country, canton, legal form, legal status, register court, federal state, city, industry, VAT ID, financial figures, founding date and more. |
| **Get** | A single company profile |
| **Get Financials** | A single object with multi-year financial statements. **Line Items** defaults to on; turn it off for headline figures and top-level positions only. **Years** shortens the history. |
| **Get Shareholders** | A single cap table from the most recent Gesellschafterliste (GmbH/UG) |
| **Get UBO** | A single object with ultimate beneficial owners and ownership chains |
| **Get History** | A single object with chronological register history |
| **List Documents** | One item per available document, including older versions, with labels, dates and availability information |
| **Download Document** | A single object with a download URL and document metadata; enable **Download File** to also return the file in binary property `data` |

All Company Get operations, List Documents and Download Document take a
**Company ID (`eu_id`)**, returned by Search and Autocomplete.

Search defaults to **Return All: off** and **Limit: 50**. Limit accepts 1–1,000
results. Each page of up to 50 results costs **1 credit**; a limit of 120 can
therefore cost 3 credits. **Return All** follows every page up to the API cap of
10,000 results and can cost **200 credits**. Tighten the filters when the cap is
reached. Later pages continue the same filtered search automatically.

Only filters you add are sent. Yes/no filters offer **Any**, **Yes** and **No**;
Any leaves that filter unset. Numeric filters send the value you choose,
including zero. Date filters send calendar dates (`YYYY-MM-DD`).

**Canton** accepts multiple selections and is OR-merged with **Federal State**.
Sorting by **Name** defaults to ascending unless **Sort Direction** is set.
Company profiles, search hits and autocomplete hits include `country_code`
(`DE`, `CH` or `AT`); search hits also include `registered_seat`.

**Company Size** accepts multiple selections: Micro (`kleinst`, § 267a HGB),
Small (`klein`, § 267 (1) HGB) and Medium-Sized (`mittelgross`, § 267 (2) HGB).

**Fetch Live From Register** is an optional setting on Get, Get History,
Get Shareholders, Get UBO and Autocomplete. It requests current information
from the German register. Live prices per call are **10 credits** for Get or
Get History (normally 1), **20** for Get Shareholders (normally 10), **50** for
Get UBO (normally 20), and **5** for Autocomplete (normally 0); see the
[plans page](https://firmendata.com/en/plans). Austrian and Swiss company
lookups have no live surcharge. Live Autocomplete requires at least 3 characters.

For a specific document version, pass its `document_id` from List Documents
and select the matching **File Type**. **Document ID** cannot be combined with
**File ID** or **Fetch Realtime**. Register extracts have no `document_id`;
download them by **File Type**. The download response includes `document_id`
and `label`. **Download File** defaults to off. The document call costs
**60 credits**, or **70** with live fetching
([document prices](https://firmendata.com/en/plans)); fetching the file is free.
The signed URL expires after **15 minutes**. When downloading the file,
the node retains the JSON metadata and adds binary property `data`, using the
English or German file name and the file's content type.

### List

Both operations cost **0 credits**. Lists are created and edited in the web app.

| Operation | What it returns |
|---|---|
| **Get Many** | One item per list you own, with its ID and name |
| **Get** | A single response object containing a page of companies in the selected **List ID** and pagination metadata; optional **Page Size** and **Cursor** select further pages |

### Typical flow

Search emits one n8n item per company. Connect it directly to Get UBO for a KYC
or onboarding check; n8n runs the next node for each item:

```text
FirmenData: Search (Legal Status: Insolvent, Total Assets Min: 1000000)
  → one item per company
  → FirmenData: Get UBO (Company ID = {{ $json.eu_id }})
```

Small and medium-sized German companies generally file abridged accounts
without a profit-and-loss statement or headcount. **Total Assets** is a useful
size filter when revenue or employee figures are absent.

The Company node is also usable as an **AI tool**.

### Not exposed

- Subscriptions and webhooks: use n8n's **HTTP Request** node or the
  [Python SDK](https://github.com/FirmenData/firmendata-python) /
  [TypeScript SDK](https://github.com/FirmenData/firmendata-node).
- Specialist search filters such as CPV codes and average board birth year:
  use the HTTP Request node or SDKs when needed.

## FirmenData Trigger (Beta)

Add **FirmenData Trigger**, select your **FirmenData API** credential, choose an
**Event** and configure n8n's **Poll Times** schedule.

| Event | Feed | Filters |
|---|---|---|
| **New Company** | `/v1/feeds/new-companies` | Country (All, DE, CH or AT), Federal State, Canton, Register Court, Legal Form, Industry |
| **Insolvency Notice** | `/v1/feeds/insolvencies` | Country (DE by default, CH or AT), Federal State, Canton, Register Court, Legal Form, Industry, Category |

The first scheduled poll starts from now. Changing the event or filters starts
a new stream from now. Events appear after a short release delay.
**Fetch Test Event** instead checks the last day, requests just one event and
does not read or change the live workflow's saved position. An empty day
returns no test event.

**Register Court** selects German Registergericht or Austrian Firmenbuch courts;
several selections match any of them. Use **Canton** for Swiss companies. On the
insolvency feed this is the company's register court, not the insolvency court.
**Schuldenruf** notices are included only when explicitly selected in **Category**.

**Page Size** controls events per page (1–100, default **100**). Each poll follows
at most **10 pages**, so a page size of 1 can still cost 10 credits in one poll.
Each page with events costs **1 credit**; empty pages are free. Duplicate-only
pages still cost 1 credit. Remaining pages continue on the next scheduled poll.
The trigger emits one item per event, preserving its `id`, `type`, `company`
and other fields. Empty polls emit no items.

The trigger remembers the most recent **2,000 event IDs** to suppress repeats.
For permanent deduplication, persist `id` in your workflow before performing an
action. It keeps the continuation cursor between polls; n8n saves poll static
data only when items are emitted, so empty polls alone do not durably advance
that position. A failed page does not consume undelivered events.

A position older than seven days expires. The trigger automatically resumes
from **seven days ago plus ten minutes**, retaining remembered event IDs and
logging a warning. Events outside that recovery window cannot be recovered
through the feed. Manual tests do not save workflow static data.

## Credentials

1. Create an API key at [Account → API Keys](https://firmendata.com/de/account/api-keys).
   The free plan includes 100 credits.
2. In n8n, add a **FirmenData API** credential and paste the key.
3. Press **Test** — it calls Autocomplete and costs 0 credits.

See the [pricing page](https://firmendata.com/en/plans) for operation costs.
Failed requests (4xx/5xx) are never charged. API requests identify this package
with `X-FirmenData-Client: n8n-node/<version>`.

## Compatibility

Tested against n8n 2.x with `n8nNodesApiVersion: 1`. Requires Node.js 20.15+.
The package has no runtime dependencies. Company and List operations use n8n's
declarative routing; the trigger uses its authenticated HTTP helper.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [FirmenData API reference](https://api.firmendata.com/v1/docs)
- [Python SDK](https://github.com/FirmenData/firmendata-python)
- [TypeScript SDK](https://github.com/FirmenData/firmendata-node)

## Development

```bash
npm install
npm run dev
npm run generate
npm run lint
npm test
npm run build
```

Search and trigger filters are generated from `contracts/openapi.v1.json` into
`nodes/FirmenData/searchFilters.ts` and `nodes/FirmenDataTrigger/feedFilters.ts`.
The node deliberately exposes a subset of the API; omitted parameters and
reasons are in `scripts/generate-filters.mjs`. Node-specific descriptions and
label handling live in that generator. `npm run generate` also writes
`nodes/version.ts` from the package version.

To pick up an API change, copy in the new contract and run `npm run generate`.
Both `npm test` and `npm run build` check that generated files are current.
Tests use mocked HTTP responses and make no live API calls.

## License

[MIT](LICENSE.md)
