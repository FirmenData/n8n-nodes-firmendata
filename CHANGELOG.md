# Changelog

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
