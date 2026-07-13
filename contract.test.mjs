import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.mjs';

/**
 * Contract-drift guard, mirroring the n8n node's `test/contract/drift.test.ts`.
 *
 * This package lives in its own public repo, so it reads a vendored snapshot of
 * the app's canonical `docs/product-facts.json` — refresh it from an SM4
 * checkout with `npm run sync:contract` (same pattern as the n8n node). If the
 * app adds, moves or deprecates a REST endpoint, these assertions fail until
 * the MCP catalog is brought back into lockstep, or the endpoint is explicitly
 * declared unexposed below with a reason.
 *
 * That last part is the point: MCP shipped for months with no media-read tools
 * and no bulk-send tool, and nothing noticed, because "not exposed" was a
 * silence rather than a decision.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(readFileSync(join(HERE, 'test', 'fixtures', 'product-facts.json'), 'utf8'));

/**
 * Endpoints the MCP server deliberately does NOT expose, each with the reason.
 * A NEW endpoint in the app fails this test until it is either given a tool or
 * added here on purpose — silence is not a decision.
 */
const NOT_EXPOSED = {
	// Key & delivery plumbing: an agent minting credentials or rewiring where
	// events land is a footgun, and it can't verify the consequences. App only.
	'GET /v1/api-keys': 'API-key management belongs in the app, not in the agent that uses the key.',
	'POST /v1/api-keys': 'An agent must not mint credentials for itself.',
	'DELETE /v1/api-keys/:param': 'An agent must not revoke the key it (or another integration) is using.',
	'POST /v1/api-keys/:param/rotate': 'Rotating a key mid-session breaks live integrations; a human does this.',
	'GET /v1/webhooks': 'Webhook wiring is delivery infrastructure the user owns; MCP has no inbound push to wire anyway.',
	'POST /v1/webhooks': 'An agent must not point event delivery somewhere new.',
	'PATCH /v1/webhooks/:param': 'Same — rewiring delivery is a human decision.',
	'DELETE /v1/webhooks/:param': 'Deleting an endpoint silently breaks someone else\'s automation.',
	'GET /v1/webhooks/:param': 'No agent use without the management verbs above.',
	'GET /v1/webhooks/:param/deliveries': 'Delivery debugging is an app/ops surface.',
	'POST /v1/webhooks/:param/test': 'Ops surface; firing test events at a live endpoint is not agent business.',

	// Raw media bytes: an unbounded binary blob dumped into the model context.
	// whatsapp_get_media serves the thumbnail instead — enough to SEE the media,
	// bounded in size. Full-resolution reads stay on the HTTP API.
	'GET /v1/accounts/:param/media/:param/file': 'Raw bytes (up to ~15 MB) would blow the context window; whatsapp_get_media returns the bounded thumbnail instead.',
	'POST /v1/accounts/:param/media/:param/download': 'Spends disk/network on the user\'s machine; the downloader already runs on its own policy.',
	'DELETE /v1/accounts/:param/media/:param': 'Destructive and irreversible — an agent must not delete the user\'s media.',
	'POST /v1/media/cleanup': 'Destructive retention sweep; belongs to the app\'s media policy, not an agent.',
	'GET /v1/media/queue': 'Downloader-internals telemetry; nothing an agent can act on.',
	'GET /v1/accounts/:param/media/stats': 'Storage accounting for the app\'s Media page, not a conversational need.',
	'GET /v1/accounts/:param/media/:param': 'Redundant — whatsapp_list_media already returns every field of an item.',

	// Per-account outbound proxy: network infrastructure, set once by the user.
	'GET /v1/accounts/:param/proxy': 'Network infrastructure; the user configures a proxy in the app.',
	'PUT /v1/accounts/:param/proxy': 'An agent must not re-route a live account\'s traffic.',
	'DELETE /v1/accounts/:param/proxy': 'Same — dropping the proxy would silently expose the server\'s real IP.',

	// Server-health / metadata routes with no conversational use. What an agent
	// actually needs to know about itself is in whatsapp_get_capabilities.
	'GET /v1/status': 'Server health; whatsapp_get_capabilities tells the agent what it needs about itself.',
	'GET /v1/version': 'Build metadata; no agent decision depends on it.',
	'GET /v1/network/status': 'Tunnel/API server state — an ops surface.',
	'GET /v1/accounts/:param': 'Redundant — whatsapp_list_accounts returns each account with its live state.',

	// Deprecated in the app; the unified send endpoint supersedes it.
	'POST /v1/accounts/:param/messages/media': 'Deprecated by the app — whatsapp_send_media uses the unified POST …/messages, which also auto-queues.',
};

// ── Route extraction ────────────────────────────────────────────────────────
// A tool's route is not declared, it is *derived* from the same build() the
// server calls at runtime — so a tool cannot pass this test while calling
// somewhere else. We feed build() a sample argument per input and collapse any
// segment that came from an argument back to `:param`.

const PARAM = 'smparam';

/** A structurally valid sample value for one zod schema — enough to drive build(). */
function sample(schema) {
	const def = schema?._def ?? {};
	switch (def.typeName) {
		case 'ZodOptional':
		case 'ZodNullable':
		case 'ZodDefault':
			return sample(def.innerType);
		case 'ZodNumber':
			return 1;
		case 'ZodBoolean':
			return true;
		case 'ZodEnum':
			return def.values[0];
		case 'ZodArray':
			return [sample(def.type)];
		case 'ZodObject':
			return Object.fromEntries(Object.entries(def.shape()).map(([k, v]) => [k, sample(v)]));
		case 'ZodRecord':
			return {};
		default:
			return PARAM; // ZodString and anything else that lands in a path.
	}
}

/** `METHOD /path` for a tool, with every interpolated value normalised to :param. */
function routeOf(tool) {
	const args = Object.fromEntries(Object.entries(tool.inputSchema).map(([k, v]) => [k, sample(v)]));
	if (tool.accountScoped) args._account = PARAM;
	const { method, path } = tool.build(args);
	const normalised = path
		.split('/')
		.map((seg) => (seg === PARAM ? ':param' : seg))
		.join('/');
	return `${method.toUpperCase()} ${normalised}`;
}

/** The app writes `:id`; an OpenAPI-style mirror writes `{id}`. Both collapse to :param. */
const factRoute = (e) => `${e.method.toUpperCase()} ${e.path.replace(/\{[^}]+\}/g, ':param').replace(/:[^/]+/g, ':param')}`;

const appRoutes = new Set(facts.endpoints.map(factRoute));
const deprecatedRoutes = new Set(facts.endpoints.filter((e) => e.deprecated).map(factRoute));
const toolRoutes = new Map(TOOLS.map((t) => [t.name, routeOf(t)]));

test('normalising :param does not collapse two distinct app endpoints together', () => {
	// If it did, an MCP tool could "match" an endpoint it does not actually call.
	assert.equal(appRoutes.size, facts.endpoints.length, 'two endpoints normalise to the same route — the guard below would be blind');
});

test('every MCP tool calls an endpoint the app actually exposes', () => {
	const phantom = [...toolRoutes].filter(([, route]) => !appRoutes.has(route));
	assert.deepEqual(
		phantom.map(([name, route]) => `${name} → ${route}`),
		[],
		'these tools call routes that are not in the app’s product-facts.json',
	);
});

test('no MCP tool points at a deprecated endpoint', () => {
	const stale = [...toolRoutes].filter(([, route]) => deprecatedRoutes.has(route));
	assert.deepEqual(stale.map(([name, route]) => `${name} → ${route}`), [], 'these tools call deprecated app endpoints');
	// Sanity: the app still carries the one we know about, so this isn't vacuous.
	assert.ok(deprecatedRoutes.has('POST /v1/accounts/:param/messages/media'), 'expected the legacy media-send route to still be flagged deprecated');
});

test('every app endpoint is either an MCP tool or an explicit, reasoned omission', () => {
	const exposed = new Set(toolRoutes.values());
	const unexposed = [...appRoutes].filter((r) => !exposed.has(r)).sort();
	const allowed = Object.keys(NOT_EXPOSED).sort();

	const undeclared = unexposed.filter((r) => !NOT_EXPOSED[r]);
	assert.deepEqual(
		undeclared,
		[],
		'the app exposes these endpoints and MCP neither implements nor deliberately skips them — add a tool, or add a line to NOT_EXPOSED saying why not',
	);

	const stale = allowed.filter((r) => !unexposed.includes(r));
	assert.deepEqual(stale, [], 'NOT_EXPOSED lists routes that no longer exist (or are now exposed) — prune them');

	assert.deepEqual(unexposed, allowed);
});

test('every omission carries a reason', () => {
	for (const [route, reason] of Object.entries(NOT_EXPOSED)) {
		assert.ok(reason && reason.length > 20, `${route} needs a real reason, not "${reason}"`);
	}
});

test('the tool catalog covers the surfaces an agent needs', () => {
	const names = new Set(TOOLS.map((t) => t.name));
	// The vision loop: an agent must be able to go from "a message has media" to
	// "I have looked at it" to "I never look at it again".
	for (const n of ['whatsapp_list_media', 'whatsapp_get_media', 'whatsapp_set_media_context']) {
		assert.ok(names.has(n), `${n} is missing — the vision loop is broken without it`);
	}
	// The bulk lane: without it an agent loops send_message and gets the number banned.
	for (const n of ['whatsapp_queue_import', 'whatsapp_list_batches', 'whatsapp_cancel_batch', 'whatsapp_retry_batch']) {
		assert.ok(names.has(n), `${n} is missing — the bulk lane is incomplete without it`);
	}
	// Binary tools must declare themselves, or index.mjs will JSON-stringify bytes.
	assert.equal(TOOLS.find((t) => t.name === 'whatsapp_get_media').binary, true, 'whatsapp_get_media must be declared binary');
});
