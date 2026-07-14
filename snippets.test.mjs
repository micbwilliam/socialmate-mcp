import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the install instructions — the only part of this package most users ever read.
 *
 * SM4 has guards for the same things (`agent-blueprint.test.ts`, `api-examples.test.ts`),
 * but it structurally *cannot* see this repo: `socialmate-mcp` was extracted to its own
 * public repo for npm provenance, and SM4's CI checks out SM4 alone. So the copies of the
 * snippet that live here need their own guard, or they drift — which is exactly what
 * happened:
 *
 *   - `index.mjs` documented `"SOCIALMATE_API_KEY": "sm_live_xxx"` — a key format that has
 *     never existed in this product. (SM4's guard bans `_live_`, but only inside SM4.)
 *   - The README's `args` omitted `-y`, while SM4's builder included it. Without `-y`, npx
 *     can block on an install-confirmation prompt *inside a stdio MCP client* — where
 *     there is no terminal to answer it, so the server silently never comes up.
 *
 * See SM4 `docs/CROSS-REPO-CONTRACT.md` §3.12.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

const SURFACES = ['index.mjs', 'README.md'];

test('every documented API-key value uses the real sm_ format', () => {
	// A real SocialMate key is `sm_<base64url>`. There is no `_live_` segment (a Stripe
	// shape) and no `sk-`/`sk_` prefix (an OpenAI shape) anywhere in this product — and the
	// placeholder is the one example of a key most users ever see, so it has to be right.
	//
	// Scan VALUES, not prose: match `"SOCIALMATE_API_KEY": "<v>"` (JSON) and
	// `--env SOCIALMATE_API_KEY=<v>` (CLI). An earlier version of this test scanned the raw
	// text and flagged the very comment that documents this rule — a guard that fails on its
	// own explanation teaches the next person to delete the explanation.
	const VALUE = /SOCIALMATE_API_KEY"?\s*[:=]\s*"?([^"\s,]+)/g;

	for (const file of SURFACES) {
		const values = [...read(file).matchAll(VALUE)].map((m) => m[1]);
		assert.ok(values.length > 0, `${file} documents no SOCIALMATE_API_KEY value at all`);

		for (const v of values) {
			assert.ok(v.startsWith('sm_'), `${file}: key value "${v}" is not the real sm_ format`);
			assert.ok(!v.includes('_live_'), `${file}: key value "${v}" uses a fabricated "_live_" segment`);
			assert.ok(!/^sk[-_]/.test(v), `${file}: key value "${v}" is OpenAI-shaped, not SocialMate`);
		}
	}
});

test('every npx invocation passes -y', () => {
	// Matches both the JSON form ("args": ["-y", "socialmate-mcp"]) and the CLI form
	// (-- npx -y socialmate-mcp). Any `npx socialmate-mcp` without `-y` is a hang waiting
	// to happen in a client with no terminal.
	for (const file of SURFACES) {
		for (const line of read(file).split('\n')) {
			if (!line.includes('socialmate-mcp')) continue;

			const jsonArgs = /"args"\s*:\s*\[([^\]]*)\]/.exec(line);
			if (jsonArgs) {
				assert.ok(jsonArgs[1].includes("'-y'") || jsonArgs[1].includes('"-y"'), `${file}: "args" without -y → ${line.trim()}`);
			}
			if (/\bnpx\s+socialmate-mcp/.test(line)) {
				assert.fail(`${file}: bare "npx socialmate-mcp" (no -y) → ${line.trim()}`);
			}
		}
	}
});

test('the README documents exactly the env vars index.mjs actually reads', () => {
	const readme = read('README.md');
	const actual = new Set([...read('index.mjs').matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));

	assert.ok(actual.size > 0, 'index.mjs reads no env vars — did the config contract change?');

	for (const name of actual) {
		assert.ok(readme.includes(name), `index.mjs reads ${name} but the README never mentions it`);
	}

	// …and the reverse: a README that promises a knob the server ignores is worse than
	// one that omits it, because the user configures it and waits for it to work.
	for (const [, name] of readme.matchAll(/\b(SOCIALMATE_[A-Z0-9_]+)\b/g)) {
		assert.ok(actual.has(name), `the README documents ${name}, but index.mjs never reads it`);
	}
});

test('the README leads with the API-server prerequisite', () => {
	// The #1 first-run failure: SocialMate's local API server is OFF by default, so a
	// user copies a perfect config, restarts their client, and every tool call fails with
	// a connection error that names nothing. Saying so is not optional.
	const readme = read('README.md');
	assert.match(readme, /off by default/i, 'the README no longer warns that the API server is off by default');
});

test('both Claude Desktop and Claude Code have a documented path', () => {
	// Every surface used to assume Claude *Desktop* + claude_desktop_config.json. Claude
	// Code users had no documented path at all — the gap that started this whole pass.
	const readme = read('README.md');
	assert.match(readme, /claude_desktop_config\.json/, 'the README lost the Claude Desktop config');
	assert.match(readme, /claude mcp add socialmate/, 'the README lost the Claude Code command');
});
