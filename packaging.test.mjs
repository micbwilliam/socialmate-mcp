import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the npm tarball against the failure that shipped v1.0.1 broken:
 * `index.mjs` imported `./prompts.mjs`, but `prompts.mjs` was missing from
 * package.json `files` — so the published package resolved to
 * ERR_MODULE_NOT_FOUND on every `npx socialmate-mcp`.
 *
 * We walk the real import graph from the bin entrypoint rather than asserting a
 * hardcoded list, so a module added tomorrow is covered without touching this
 * test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));

/** Every relative import reachable from `entry`, as paths relative to the package root. */
function localImportGraph(entry) {
	const seen = new Set();
	const queue = [entry];

	while (queue.length) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);

		const src = readFileSync(join(HERE, file), 'utf8');
		// Static `import ... from './x.mjs'` and dynamic `import('./x.mjs')`.
		for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
			const resolved = relative(HERE, join(HERE, dirname(file), m[1]));
			if (!seen.has(resolved)) queue.push(resolved);
		}
	}
	return seen;
}

test('every local module reachable from the bin entrypoint is in package.json files[]', () => {
	const entry = relative(HERE, join(HERE, pkg.bin['socialmate-mcp']));
	const reachable = localImportGraph(entry);
	const shipped = new Set(pkg.files);

	const missing = [...reachable].filter((f) => !shipped.has(f));
	assert.deepEqual(
		missing,
		[],
		`These modules are imported at runtime but are NOT in package.json "files", so the published ` +
			`tarball would crash with ERR_MODULE_NOT_FOUND: ${missing.join(', ')}`,
	);
});

test('the entrypoint is itself shipped', () => {
	assert.ok(
		pkg.files.includes(relative(HERE, join(HERE, pkg.bin['socialmate-mcp']))),
		'package.json "bin" points at a file that is not in "files"',
	);
});
