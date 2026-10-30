# Changelog

## 2.0.0

### Breaking changes

- **Search, Autocomplete and List Documents return one n8n item per result.**
  Migration: remove any Split Out step for `data`, and read fields directly
  from each item, for example `{{ $json.eu_id }}`. Empty results emit no items.
  Response-envelope metadata is no longer included in these items. Search now
  uses **Return All** (off by default) and **Limit** (50 by default, 1–1,000).
  Each page of up to 50 results costs 1 credit; Return All stops at 10,000
  results and can cost 200 credits. Migration: use Limit to bound credit use
  and remove any manual cursor loop when using automatic pagination.
- **Include Line Items is replaced by Line Items**, enabled by default, and
  sends `details=true|false`. Migration: select **Line Items: off** to keep a
  lean financial response; recreate expressions on the new `details` field.
- Trigger **Limit** is renamed **Page Size**, with a default of 100 for new
  nodes. Migration: existing values are retained under the same parameter
  name; review page size and schedule because each poll follows up to 10
  pages and each page with events costs 1 credit.
- Search boolean filters now offer **Any / Yes / No**. Migration: review saved
  filters and choose Any to omit a filter, Yes to send true or No to send
  false. Saved false values now filter for No instead of being silently
  omitted. Explicit numeric zero values are also now sent; remove filters
  that should not constrain a search.

### Added and fixed

- New **FirmenData Trigger** for Beta New Company and Insolvency Notice feeds,
  with country, federal state/canton, register court, legal form, industry and
  insolvency category filters. Register Court supports German and Austrian
  courts and means the company's register court on insolvency notices.
- Expired feed positions automatically resume from seven days ago plus ten
  minutes, keeping recent event IDs and warning in the log. Deduplication
  retains 2,000 IDs; failed pages do not consume undelivered events.
- Manual Fetch Test Event checks one event from the last day without reading
  or changing saved workflow state.
- Autocomplete supports one or more characters and an optional Country picker
  (All, DE, CH or AT). Search pickers support Austria, its federal states,
  legal forms and courts, plus the Other Services industry.
- Search exposes VAT ID, preserves official register label spelling and
  formats dates as `YYYY-MM-DD`, including picker values with time offsets.
- New free **List** resource with Get Many (one item per list) and Get (one
  response object containing a page of companies and pagination metadata).
- Optional **Fetch Live From Register** on Get, History, Shareholders, UBO and
  Autocomplete, with operation-specific credit costs.
- Download Document optionally returns the file in binary property `data`,
  preserving metadata. The free file fetch sends no API authorization header;
  signed URLs expire after 15 minutes.
- All API calls and credential tests identify the package and version via
  `X-FirmenData-Client`. API problem messages remain visible for authentication,
  credit, missing-resource, validation and rate-limit failures.
- Tested against n8n 2.x. Publication checks that the tag equals the package
  version. These changes include the previously unpublished 1.3.0 work.

## 1.2.1

Regenerated from the updated API contract. **Additive, non-breaking change:**

- Search: **Company Size** now includes **Micro** (`kleinst`,
  Kleinstkapitalgesellschaft under § 267a HGB), alongside Small (`klein`)
  and Medium-Sized (`mittelgross`). The filter description now references
  § 267 / § 267a HGB.

## 1.2.0

Regenerated from API contract 1.2.0. **Additive, non-breaking changes:**

- Get, Search and Autocomplete: required `country_code` (`DE` or `CH`) in
  company profiles and hits, also present on list rows.
- Search: **Country** and multi-select **Canton** filters; cantons are
  OR-merged with **Federal State**. **Legal Form** includes Swiss forms such
  as `AG (CH)` and `GmbH (CH)`. Hits include `registered_seat`; sorting by
  name now defaults to ascending.
- List Documents: new live registry check listing available documents,
  including older versions, with labels, dates, stored-copy metadata,
  coverage, freshness and `country_code`. Costs 5 credits; Swiss, empty and
  registry-unreachable responses cost no credits.
- Download Document: exposed as a Company operation, with optional
  **Document ID** from List Documents to select a specific version.
  **File Type** remains required and must match; **Document ID** cannot be
  combined with **File ID** or **Fetch Realtime**. Responses include
  `document_id` and `label`.

## 1.0.0

Regenerated from API contract 1.1.0, which renames and reshapes response
fields. **Breaking for workflows that read these fields:**

- Get: `status` is now `legal_status`.
- Get Financials: the top-level `id` is now `eu_id`; the structured
  profit-and-loss and balance-sheet rows are no longer returned by default —
  switch on **Include Line Items**. **Years** limits the history, and
  `relationships.subsidiaries` lists the first 25 (`subsidiaries_total` has
  the count).
- Get History: English keys and ISO dates throughout.
- Errors: a 422 lists `errors` as `{ param, message }`; unknown filter values
  and inverted ranges are now rejected instead of ignored.

New response fields include `is_branch`, `register_canton` and `uid` (Swiss
companies). Answers without data (e.g. no cap table on file) cost no credits.
