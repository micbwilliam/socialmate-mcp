#!/usr/bin/env node
/**
 * Refresh the vendored contract snapshot the drift test checks against, from the
 * app repo's canonical `docs/product-facts.json` (SM4 is the source of truth).
 *
 *   node scripts/sync-contract.mjs
 *   SM4_DIR=/path/to/SM4 node scripts/sync-contract.mjs
 *
 * After syncing, run `npm test` — the contract-drift test will flag anything the
 * MCP catalog now needs to mirror (a moved endpoint, a new/renamed webhook event).
 * Same pattern as n8n-nodes-socialmate/scripts/sync-contract.mjs.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const candidates = [
	process.env.SM4_DIR && resolve(process.env.SM4_DIR, 'docs/product-facts.json'),
	resolve(repoRoot, '../SM4/docs/product-facts.json'),
	resolve(repoRoot, '../../Desktop/SM4/docs/product-facts.json'),
].filter(Boolean);

const source = candidates.find((p) => existsSync(p));
if (!source) {
	console.error('✖ Could not find SM4 docs/product-facts.json. Set SM4_DIR=/path/to/SM4.');
	console.error('  Looked in:\n   - ' + candidates.join('\n   - '));
	process.exit(1);
}

const dest = resolve(repoRoot, 'test/fixtures/product-facts.json');
const content = readFileSync(source, 'utf8');
// Validate it parses and has the expected shape before overwriting.
const parsed = JSON.parse(content);
if (!Array.isArray(parsed.endpoints) || !parsed.webhookEvents?.all) {
	console.error('✖ Source does not look like product-facts.json (missing endpoints[] / webhookEvents).');
	process.exit(1);
}
writeFileSync(dest, content);
console.log(`✔ Synced contract snapshot from ${source}`);
console.log(`  → ${dest}  (${parsed.endpoints.length} endpoints, ${parsed.webhookEvents.all.length} events, v${parsed.version})`);
console.log('  Now run: npm test');
