# n8n-nodes-firmendata

An [n8n](https://n8n.io) community node for [firmendata](https://firmendata.com) —
data on **2.4 million German companies** from the Unternehmensregister and
Handelsregister: register profiles, parsed annual financial statements,
shareholder cap tables, UBO chains and register history.

[![npm](https://img.shields.io/npm/v/n8n-nodes-firmendata)](https://www.npmjs.com/package/n8n-nodes-firmendata)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and enter `n8n-nodes-firmendata` as the npm package name.

## Operations

### Company

| Operation | What it returns |
|---|---|
| **Autocomplete** | Company-name suggestions for a fragment. Costs no credits. |
| **Search** | The commercial register, across 30 filters — legal form, legal status, register court, federal state, city, industry, revenue, balance-sheet total, employees, founding date, public-procurement role and more, with dropdowns wherever the API has a fixed set of values. Cursor-paginated. |
| **Get** | Full profile for one company |
| **Get Financials** | Multi-year financial statements, parsed into figures rather than PDFs |
| **Get Shareholders** | Cap table from the most recent Gesellschafterliste (GmbH/UG) |
| **Get UBO** | Ultimate beneficial owners, resolved through ownership chains |
| **Get History** | Chronological register history |

Every operation after Autocomplete takes a **Company ID (`eu_id`)**, which
Search and Autocomplete return on each hit.

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
community nodes, and the reason the node is written in declarative style: it
describes its HTTP requests via `routing` and lets n8n's own request helper
execute them, rather than shipping an HTTP client of its own.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [FirmenData API reference](https://api.firmendata.com/v1/docs)
- [Python SDK](https://github.com/FirmenData/firmendata-python)
- [TypeScript SDK](https://github.com/FirmenData/firmendata-node)

## Development

```bash
npm install
npm run dev       # starts n8n with this node loaded
npm run generate  # regenerate the search filters from contracts/openapi.v1.json
npm run lint      # enforces much of n8n's verification checklist
npm test          # the exact ESLint gate the submission scanner applies
npm run build
```

The Search operation's filters are **generated**, not hand-written:
`contracts/openapi.v1.json` (the same contract the `firmendata` npm and PyPI
SDKs generate their types from) is the input, and
`nodes/FirmenData/searchFilters.ts` is the output. Names, descriptions,
dropdown options and numeric bounds all come from the spec, so the node cannot
drift from the API the way it did when this list was maintained by hand.

To pick up an API change: copy the new contract in and run `npm run generate`.
Both `npm test` and `npm run build` re-run it with `--check` and fail if the
committed file is stale.

## License

[MIT](LICENSE.md)
