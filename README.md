# n8n-nodes-firmendata

An [n8n](https://n8n.io) community node for [firmendata](https://firmendata.com) —
German, Swiss and Austrian company data: register profiles, parsed annual
financial statements, shareholder cap tables, UBO chains and register history,
plus polling triggers for new companies and insolvency notices.

[![npm](https://img.shields.io/npm/v/n8n-nodes-firmendata)](https://www.npmjs.com/package/n8n-nodes-firmendata)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

[Installation](#installation) · [Operations](#operations) · [FirmenData Trigger](#firmendata-trigger-beta) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and enter `n8n-nodes-firmendata` as the npm package name.

## Operations

### Company

| Operation | What it returns |
|---|---|
| **Autocomplete** | Company-name suggestions for a fragment, optionally restricted by **Country** (All, DE, CH or AT). Costs no credits. |
| **Search** | Company registers, with filters for country (DE, CH or AT), Swiss canton, legal forms, legal status, register court, federal state, city, industry, revenue, balance-sheet total, employees, founding date, public-procurement role and more. Dropdowns wherever the API has a fixed set of values. Cursor-paginated. |
| **Get** | Full profile for one company |
| **Get Financials** | Multi-year financial statements, parsed into figures rather than PDFs. Lean by default — switch on *Include Line Items* for the rows as filed, and set *Years* to shorten the history |
| **Get Shareholders** | Cap table from the most recent Gesellschafterliste (GmbH/UG) |
| **Get UBO** | Ultimate beneficial owners, resolved through ownership chains |
| **Get History** | Chronological register history |
| **List Documents** | Live registry check returning available documents, including older versions, with labels, dates, stored-copy status, coverage and freshness. Costs 5 credits; Swiss, empty and registry-unreachable responses cost no credits. |
| **Download Document** | A download URL and document metadata. Select **File Type** and optionally a **Document ID** from List Documents; leave it empty for the latest version. |

All Get operations, List Documents and Download Document take a **Company ID (`eu_id`)**, which
Search and Autocomplete return on each hit.

**Canton** accepts multiple selections and is OR-merged with **Federal State**.
Sorting by **Name** defaults to ascending unless **Sort Direction** is set.
Company profiles, search hits and autocomplete hits include `country_code`
(`DE`, `CH` or `AT`); search hits also include `registered_seat`.

**Company Size** accepts multiple selections: Micro (`kleinst`, § 267a HGB),
Small (`klein`, § 267 (1) HGB) and Medium-Sized (`mittelgross`, § 267 (2) HGB).

For a specific document version, pass its `document_id` from List Documents
and select the matching **File Type**. **Document ID** cannot be combined with
**File ID** or **Fetch Realtime**. Register extracts have no `document_id`;
download them by **File Type**. The download response includes `document_id`
and `label`.

The node is also usable as an **AI tool**, so an agent can look companies up
directly.

### Typical flow

Search → iterate hits → Get UBO for each, for a KYC or onboarding check:

```
Search (Legal Status: Insolvent, Total Assets Min: 1000000)
  → Loop Over Items
    → FirmenData: Get UBO  (Company ID = {{ $json.eu_id }})
```

> **Filtering on company size?** Use **Total Assets**, not Revenue. Small and
> medium-sized German companies file abridged accounts — a balance sheet, but
> no profit-and-loss statement and no headcount. So a revenue or employee
> filter silently narrows your results to the minority that publish a full
> P&L, while the balance-sheet total is available for every filing company.

## FirmenData Trigger (Beta)

Add **FirmenData Trigger**, select the existing **FirmenData API** credential,
choose an **Event** and set n8n's **Poll Times** schedule.

| Event | Feed | Filters |
|---|---|---|
| **New Company** | `/v1/feeds/new-companies` | Country (All, DE, CH or AT), Federal State, Canton, Legal Form, Industry |
| **Insolvency Notice** | `/v1/feeds/insolvencies` | Country (DE by default, CH or AT), Federal State, Canton, Legal Form, Industry, Category |

The first poll starts from the current time (`since`) to avoid a historical
backlog. Changing the event or filters starts a new stream from now. Subsequent
polls persist `next_cursor` in node static data and send it back unchanged,
including after empty pages. Events are released after a settlement delay.

**Limit** controls the page size (1–100, default 50). When `has_more` is true,
the trigger requests the next page immediately, up to 10 pages per poll; any
remaining pages continue on the next scheduled poll. It emits one item per
event, preserving the event's `id`, `type`, `company` and other fields. Empty
polls emit no items. Each page with events costs **1 credit**; empty pages are
free. Pages containing only duplicate events still cost 1 credit.

The trigger remembers the most recent **10,000 event IDs** across polls to
suppress duplicates from reparses. For permanent deduplication, persist `id`
in your workflow's own datastore before performing an action. **Schuldenruf**
notices are included only when explicitly selected in **Category**.

Cursors expire when their discovery position is more than seven days old.
An expired cursor is reported as an API error; to restart from now, replace
the trigger with a node using a new name. Manual tests start from now and do
not advance the live workflow's cursor. Cursor persistence requires an active
workflow; test executions do not save static data.

## Credentials

1. Create an API key at
   [firmendata.com → Account → API Keys](https://firmendata.com/de/account/api-keys).
   The free plan includes 100 credits.
2. In n8n, add a **FirmenData API** credential and paste the key.
3. Press **Test** — it calls the autocomplete endpoint, which costs no credits,
   so testing never spends your balance.

Operations are priced in credits per call; see the
[pricing page](https://firmendata.com/preise). Failed requests (4xx/5xx) are
never charged.

## Compatibility

Tested against n8n 1.x with `n8nNodesApiVersion: 1`. Requires Node.js 20.15+.

The package has **no runtime dependencies** — a requirement for n8n's verified
community nodes. Company operations use declarative `routing`; the polling
trigger uses n8n's authenticated HTTP helper and workflow static data.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [FirmenData API reference](https://api.firmendata.com/v1/docs)
- [Python SDK](https://github.com/FirmenData/firmendata-python)
- [TypeScript SDK](https://github.com/FirmenData/firmendata-node)

## Development

```bash
npm install
npm run dev       # starts n8n with this node loaded
npm run generate  # regenerate search and trigger filters from the contract
npm run lint      # enforces much of n8n's verification checklist
npm test          # routing/polling tests and the submission scanner's ESLint gate
npm run build
```

The Search operation's and trigger's filters are **generated**, not hand-written:
`contracts/openapi.v1.json` (the same contract the `firmendata` npm and PyPI
SDKs generate their types from) is the input, and
`nodes/FirmenData/searchFilters.ts` and `nodes/FirmenDataTrigger/feedFilters.ts`
are the outputs. Names, descriptions,
dropdown options and numeric bounds all come from the spec, so the node cannot
drift from the API the way it did when this list was maintained by hand.
Search respects the documented SKIP rules in `scripts/generate-filters.mjs`;
the trigger exposes the main feed filters and omits optional revenue bounds.

To pick up an API change: copy the new contract in and run `npm run generate`.
Both `npm test` and `npm run build` re-run it with `--check` and fail if the
committed file is stale.

## License

[MIT](LICENSE.md)
