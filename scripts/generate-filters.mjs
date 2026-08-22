#!/usr/bin/env node
/**
 * Generate `nodes/FirmenData/searchFilters.ts` from `contracts/openapi.v1.json`.
 *
 *   npm run generate          # write
 *   npm run generate -- --check   # exit 1 if the committed file is stale
 *
 * Why this exists: this node was hand-written and drifted. It exposed 12 of the
 * API's 37 search filters, and the four multi-valued ones were free-text boxes
 * the user had to comma-split themselves — so "GmbH" in the Legal Form field
 * worked only if you already knew the exact German spelling the API wanted.
 * The two SDKs (`firmendata` on npm and PyPI) have always generated their types
 * from this same contract; the n8n node was the odd one out, and the only one
 * that could silently disagree with the API.
 *
 * Everything here is derived, so it cannot drift again: parameter names,
 * descriptions, enum options, numeric bounds and defaults all come from the
 * spec. Adding a filter to the API and re-running this is the whole change.
 *
 * Two n8n-specific constraints shape the output, both enforced by the
 * community-node scanner (a rejection there is automatic and costs a release):
 *
 *  - options inside a `collection` must be **alphabetical by displayName**;
 *  - a field named "Limit" must default to 50, which is why the page-size
 *    field elsewhere in this node is called "Max Results".
 *
 * Display names are title-cased from the parameter name, except where the spec
 * name is a German term of art that would title-case into nonsense
 * (`rechtsform` -> "Legal Form", not "Rechtsform").
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The very package `node-param-display-name-miscased` uses to decide whether a
// name is title cased, pinned to the major that rule depends on. Using anything
// else means guessing at the rule and discovering the mismatch at submission
// time, which costs a release. It also happens to do the right thing for German
// legal forms: a word carrying internal capitals (`gGmbH`, `eG`, `e.K.`,
// `BaFin`) is left alone, where a naive title-caser would emit `GGmbH`.
import { titleCase } from 'title-case';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'contracts', 'openapi.v1.json');
const OUT = join(ROOT, 'nodes', 'FirmenData', 'searchFilters.ts');

// Parameters this node deliberately does not offer.
//
// The API surface and the n8n surface are not the same product. A workflow
// builder picks from a dropdown in a side panel; they cannot consult a
// classification manual, and a filter that silently returns zero results
// because the code was mistyped is worse than one that isn't there. So the
// expert identifiers are omitted here and stay available through the REST API
// and the typed SDKs, where the caller already knows what they are asking for.
const SKIP = new Map([
  ['q', 'top-level "Search Query" field'],
  ['limit', 'top-level "Limit" field'],
  ['eu_id', 'exact-ID lookup — that is what the Get operation is for'],
  ['cpv_code', 'requires the EU CPV vocabulary; Tender Role covers the common case'],
  ['ust_idnr', 'expert identifier most companies do not publish'],
  ['avg_birth_year_min', 'average board birth year — obscure outside research use'],
  ['avg_birth_year_max', 'average board birth year — obscure outside research use'],
]);

// Where the spec's first sentence is not the whole story. A workflow that
// filters on employee count and gets twelve results looks broken, so the
// reason belongs in the tooltip rather than in a doc nobody opens mid-build.
// Phrased in terms of German filing law rather than our coverage: small and
// medium companies file abridged accounts (§§ 266, 276 HGB) with a balance
// sheet but no P&L and no headcount, which is why revenue and employees are
// scarce and the balance-sheet total is not.
const DESCRIPTION_OVERRIDE = {
  revenue_min:
    'Minimum reported revenue in EUR. Most German companies file abridged accounts with no profit-and-loss statement, so revenue is the scarcest figure — use Total Assets Min to filter on size instead',
  revenue_max: 'Maximum reported revenue in EUR. Filed by a minority of companies — see Revenue Min',
  profit_min: 'Minimum reported profit in EUR. Only companies filing a full profit-and-loss statement have one',
  profit_max: 'Maximum reported profit in EUR — negative values select loss-making companies',
  total_assets_min:
    'Minimum balance-sheet total in EUR. Every filing company publishes a balance sheet, so this is the widest-reaching size filter',
  total_assets_max: 'Maximum balance-sheet total in EUR. The widest-reaching size filter — see Total Assets Min',
  employee_count_min:
    'Minimum reported employee count. Reporting headcount is optional for most German legal forms, so expect small result sets',
  employee_count_max: 'Maximum reported employee count. Optional for most legal forms — see Employee Count Min',
  lei_code: 'Exact 20-character Legal Entity Identifier, for companies that hold one',
  wz_2025_code:
    'WZ 2025 industry code at any level: 62, 62.1, 62.10 or 62.10.3. Note these are WZ 2025, not WZ 2008 — an old code such as 62.01 matches nothing. Use Industry for a plain-language picker instead',
  city: 'Registered seat city, spelled as in the register. Comma-separate for several; umlauts are optional (Munchen matches München)',
  fetch_realtime:
    'Whether to also search the German registers live and add companies not yet indexed. Requires Search Query or Company Name, costs extra credits, and adds a few seconds',
  cursor: 'Pagination cursor — pass pagination.next_cursor from a previous response to fetch the next page',
  company_name: 'Company name prefix. The legal-form suffix counts, so "Bosch GmbH" narrows against "Bosch"',
  person_name: 'Name of a board member, shareholder or partner, current or historical',
  register_number:
    'Registernummer digits only, e.g. 123456 for HRB 123456. Numbers repeat across courts — add Register Court or Register Type to identify one company',
};

// Where title-casing the spec name would produce something a non-German
// speaker cannot act on.
const DISPLAY_NAME = {
  rechtsform: 'Legal Form',
  bundesland: 'Federal State',
  wz_2025_code: 'Industry Code (WZ 2025)',
  industry_slug: 'Industry',
  eu_id: 'Company ID (Eu ID)',
  ust_idnr: 'VAT Number (USt-IdNr)',
  lei_code: 'LEI',
  cpv_code: 'CPV Code',
  q: 'Search Query',
};

// n8n requires a single-select `options` field to default to one of its own
// values, and the field starts sending that value the moment the user adds it
// to the collection. Falling back to the alphabetically-first option is
// actively wrong here: it made Sort default to "Employee Count", which most
// German legal forms never report, and Sort Direction to "Asc" — neither the
// API's default nor its indexed fast path, since every ordering index is
// DESC NULLS LAST and an ascending sort over the whole register takes seconds.
const DEFAULT_VALUE = {
  sort: 'revenue',
  sort_direction: 'desc',
  register_type: 'HRB',                       // the most common register type
  register_court: 'Berlin (Charlottenburg)',  // the largest register court
};

const SNAKE_CASE = /^[a-z0-9]+(_[a-z0-9]+)+$/;

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const params = spec.paths['/v1/companies/search'].get.parameters;

/** Resolve a `$ref` chain to the schema it points at. */
function deref(schema) {
  if (!schema) return schema;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    return deref(spec.components.schemas[name]);
  }
  return schema;
}

/**
 * Reduce an OpenAPI parameter schema to `{ enum, type, isList, bounds }`.
 * The spec wraps every optional parameter in `anyOf: [T, {type: null}]`, and
 * list parameters in `anyOf: [{type: array, items: T}, {type: null}]`.
 */
function describe(schema) {
  schema = deref(schema);
  const branches = schema.anyOf ?? schema.oneOf ?? [schema];
  const meaningful = branches
    .map(deref)
    .filter((b) => b && b.type !== 'null');

  for (const branch of meaningful) {
    if (branch.type === 'array') {
      const items = deref(branch.items);
      return { isList: true, enum: items.enum, type: items.type ?? 'string' };
    }
  }
  const branch = meaningful[0] ?? {};
  return {
    isList: false,
    enum: branch.enum,
    type: branch.type ?? 'string',
    format: branch.format,
    minimum: branch.minimum,
    maximum: branch.maximum,
  };
}

/** `avg_birth_year_min` -> `Avg Birth Year Min`. */
function fieldName(name) {
  return titleCase(name.split('_').join(' '));
}

/** Enum value -> the label shown in the dropdown. */
function optionName(value) {
  return titleCase(SNAKE_CASE.test(value) ? value.split('_').join(' ') : value);
}

/**
 * First sentence of the spec description, shaped into an n8n tooltip.
 *
 * Two of the scanner's rules apply here and both are errors, not warnings:
 * descriptions must not end in a period
 * (`node-param-description-excess-final-period`), and a boolean's description
 * must start with "Whether" (`node-param-description-boolean-without-whether`).
 */
function shortDescription(text, isBoolean, keepWhole = false) {
  if (!text) return '';
  const flat = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = flat.replace(/`/g, '');
  // Overrides are written to be used whole; only spec prose gets truncated to
  // its lead sentence, and DESCRIPTION_OVERRIDE exists for the cases where
  // that truncation would drop a cost or coverage caveat.
  const firstSentence = keepWhole ? null : stripped.match(/^.*?[.!?](?=\s|$)/);
  let out = (firstSentence ? firstSentence[0] : stripped).trim();
  out = out.replace(/[.]+$/, '');
  if (isBoolean && !/^whether\b/i.test(out)) {
    // (final punctuation is decided below, after any "Whether to" prefixing)
    // The spec writes these in the imperative ("Restrict to companies…"),
    // which becomes correct English behind "Whether to".
    out = `Whether to ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
  }
  if (out.length > 240) out = out.slice(0, 237).trimEnd() + '…';
  return withFinalPunctuation(out);
}

/**
 * n8n's two final-period rules are exact complements, and both are errors:
 *
 *   node-param-description-excess-final-period  -> no internal ". ", must NOT end with "."
 *   node-param-description-missing-final-period -> exactly one ". ", MUST end with "."
 *
 * (Both ignore a literal "e.g." when counting, and neither fires on three or
 * more sentences.) Encoding the condition beats hand-tuning each string,
 * because these descriptions are generated and a lint failure at submission
 * time costs a release.
 */
function withFinalPunctuation(text) {
  const egLess = text.replace('e.g.', '');
  const sentences = egLess.split('. ').length;
  const endsWithPeriod = text.endsWith('.');
  if (sentences === 2 && !endsWithPeriod) return text + '.';
  if (sentences === 1 && endsWithPeriod) return text.slice(0, -1);
  return text;
}

function jsString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildField(param) {
  const info = describe(param.schema);
  const display = DISPLAY_NAME[param.name] ?? fieldName(param.name);
  let description = DESCRIPTION_OVERRIDE[param.name]
    ? shortDescription(DESCRIPTION_OVERRIDE[param.name], info.type === 'boolean', true)
    : shortDescription(param.description, info.type === 'boolean');
  // `node-param-description-identical-to-display-name`: a description that
  // only restates the label is noise, and an error to the scanner.
  if (squash(description) === squash(display)) description = '';

  const lines = [];
  lines.push('  {');
  lines.push(`    displayName: ${jsString(display)},`);
  lines.push(`    name: ${jsString(camel(param.name))},`);

  if (info.enum) {
    // n8n's linter enforces alphabetical option ordering by name.
    const options = info.enum
      .map((value) => ({ name: optionName(value), value }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    lines.push(`    type: '${info.isList ? 'multiOptions' : 'options'}',`);
    // `node-param-default-wrong-for-options`: a single-select must default to
    // one of its own values. See DEFAULT_VALUE for why that is not simply the
    // first option.
    const fallback = DEFAULT_VALUE[param.name] ?? options[0].value;
    if (!info.isList && !info.enum.includes(fallback)) {
      // A DEFAULT_VALUE that no longer exists would otherwise ship a field
      // that sends a value the API rejects.
      throw new Error(
        `DEFAULT_VALUE.${param.name} is "${fallback}", which is not one of ` +
          `its enum values: ${info.enum.join(', ')}`,
      );
    }
    lines.push(`    default: ${info.isList ? '[]' : jsString(fallback)},`);
    lines.push('    options: [');
    for (const opt of options) {
      lines.push(`      { name: ${jsString(opt.name)}, value: ${jsString(opt.value)} },`);
    }
    lines.push('    ],');
  } else if (info.type === 'boolean') {
    lines.push("    type: 'boolean',");
    lines.push('    default: false,');
  } else if (info.type === 'integer' || info.type === 'number') {
    lines.push("    type: 'number',");
    const opts = [];
    if (info.minimum !== undefined) opts.push(`minValue: ${info.minimum}`);
    if (info.maximum !== undefined) opts.push(`maxValue: ${info.maximum}`);
    if (opts.length) lines.push(`    typeOptions: { ${opts.join(', ')} },`);
    lines.push('    default: 0,');
  } else if (info.isList) {
    // Free-text list (city, wz_2025_code): comma-separated, split by the
    // backend's query normaliser. No enum to offer, so no picker is possible.
    lines.push("    type: 'string',");
    lines.push("    default: '',");
    lines.push("    placeholder: 'value1,value2',");
  } else {
    lines.push(`    type: '${info.format === 'date' ? 'dateTime' : 'string'}',`);
    lines.push("    default: '',");
  }

  if (description) lines.push(`    description: ${jsString(description)},`);
  lines.push(`    routing: { request: { qs: { ${jsonKey(param.name)}: ${routingValue(info)} } } },`);
  lines.push('  },');
  return { display, source: lines.join('\n') };
}

/**
 * How the field's value reaches the query string.
 *
 * Multi-valued fields are **joined with commas** rather than passed as an
 * array. n8n serialises arrays through `qs.stringify(..., {arrayFormat})`, and
 * `requestDefaults.arrayFormat: 'repeat'` already makes that correct — but a
 * comma string is correct under every arrayFormat, so the filter cannot break
 * if that default is ever lost or overridden. The API accepts both forms.
 */
function routingValue(info) {
  if (info.isList && info.enum) {
    return "'={{$value?.length ? $value.join(\",\") : undefined}}'";
  }
  if (info.isList) {
    return "'={{$value || undefined}}'";
  }
  if (info.type === 'boolean') {
    return "'={{$value || undefined}}'";
  }
  if (info.type === 'integer' || info.type === 'number') {
    return "'={{$value || undefined}}'";
  }
  return "'={{$value || undefined}}'";
}

function squash(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function jsonKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : jsString(name);
}

function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const fields = params
  .filter((p) => p.in === 'query' && !SKIP.has(p.name))
  .map(buildField)
  // n8n's linter: collection options must be alphabetical by displayName.
  .sort((a, b) => a.display.localeCompare(b.display, 'en'));

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`npm run generate\` from \`contracts/openapi.v1.json\`, the same
 * contract the firmendata TypeScript and Python SDKs generate their types
 * from. Edit the API, re-export the contract, re-run the generator.
 *
 * ${fields.length} filters, covering every query parameter of
 * GET /v1/companies/search except \`q\` and \`limit\`, which the node exposes as
 * top-level fields.
 */

import type { INodeProperties } from 'n8n-workflow';

export const searchFilters: INodeProperties[] = [
${fields.map((f) => f.source).join('\n')}
];
`;

const check = process.argv.includes('--check');
if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current !== header) {
    console.error(`${OUT} is stale — run \`npm run generate\``);
    process.exit(1);
  }
  console.log(`searchFilters.ts is current (${fields.length} filters)`);
} else {
  writeFileSync(OUT, header);
  console.log(`wrote ${OUT} (${fields.length} filters)`);
}
