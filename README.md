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
| **Search** | The commercial register, filtered by city, state, legal form, legal status, revenue, employees, register number, connected person and more. Cursor-paginated. |
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
Search (legal_status: insolvent, revenue_min: 1000000)
  → Loop Over Items
    → FirmenData: Get UBO  (Company ID = {{ $json.eu_id }})
```

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
npm run dev     # starts n8n with this node loaded
npm run lint    # enforces much of n8n's verification checklist
npm run build
```

## License

[MIT](LICENSE.md)
