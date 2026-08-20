#!/usr/bin/env node
/**
 * Run the exact ESLint gate `@n8n/scan-community-package` applies at
 * submission time, against the working tree.
 *
 *   npm test
 *
 * Why this exists: `npm run lint` is NOT this gate. `n8n-node lint` bundles
 * whatever @n8n/eslint-plugin-community-nodes version @n8n/node-cli depends
 * on, which lagged the scanner by 30 rules. Version 0.1.0 of this package
 * passed `npm run lint` cleanly and was rejected by the scanner for two
 * errors the older plugin had no rules for. A scanner rejection is
 * automatic, so discovering it at submission costs a release.
 *
 * Fidelity matters more than convenience here, so this imports the
 * scanner's own `buildScanConfig()` rather than reconstructing the rule set.
 * A hand-rolled version was tried first and silently under-reported: it
 * applied only `plugin.configs.recommended.rules`, dropping the config's own
 * `files`/`languageOptions` (so package.json rules never fired) and the
 * entire `eslint-plugin-n8n-nodes-base` half of the gate. Importing the
 * builder means the check cannot drift from what the scanner enforces.
 *
 * The scanner is installed into a temp directory rather than added as a
 * devDependency: its plugin peers on an exact eslint version that conflicts
 * with this package's own, and a published node should not carry a broken
 * dependency tree to run a check. Sources are copied in because ESLint
 * refuses to lint outside its config's base path.
 *
 * Note this covers the ESLint leg only. The scanner additionally verifies
 * npm provenance and that the tarball matches the attested source commit —
 * both of which need a published artifact and are exercised by the publish
 * workflow.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Pin the scanner so the gate is reproducible; bump deliberately.
const SCANNER = '@n8n/scan-community-package@0.32.0';

const RUNNER = `
import { ESLint } from 'eslint';
import { buildScanConfig } from '@n8n/scan-community-package/scanner/scanner.mjs';

const baseConfig = await buildScanConfig();

// A config that matches nothing would exit 0 and tell us nothing, which is
// exactly the failure this script was rewritten to avoid.
const ruleCount = new Set(
  baseConfig.flatMap((c) => Object.keys(c.rules ?? {})),
).size;
if (ruleCount < 20) {
  console.error(\`scan-check: only \${ruleCount} rules loaded — refusing to report a pass\`);
  process.exit(2);
}

const eslint = new ESLint({ overrideConfigFile: true, baseConfig, cwd: process.cwd() });
const results = await eslint.lintFiles(['nodes', 'credentials', 'package.json']);
const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output) console.log(output);

const errors = results.reduce((n, r) => n + r.errorCount, 0);
console.log(\`scan-check: \${ruleCount} rules applied, \${errors} error(s)\`);
process.exit(errors > 0 ? 1 : 0);
`;

const work = mkdtempSync(join(tmpdir(), 'n8n-scan-'));
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }));

  process.stdout.write('scan-check: installing the submission scanner…\n');
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', SCANNER], {
    cwd: work,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // Copied after install so the package's real manifest is what gets linted.
  for (const entry of ['nodes', 'credentials', 'package.json']) {
    cpSync(join(ROOT, entry), join(work, entry), { recursive: true });
  }
  writeFileSync(join(work, 'run.mjs'), RUNNER);

  execFileSync(process.execPath, ['run.mjs'], { cwd: work, stdio: 'inherit' });
  process.stdout.write('scan-check: clean — matches the submission gate\n');
} catch (err) {
  process.stderr.write(
    '\nscan-check: FAILED. These are the rules @n8n/scan-community-package applies;\n' +
      'a node failing them is rejected automatically at submission.\n',
  );
  process.exitCode = typeof err?.status === 'number' ? err.status : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
