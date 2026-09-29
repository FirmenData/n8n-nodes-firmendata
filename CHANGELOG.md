# Changelog

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
