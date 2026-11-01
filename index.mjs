#!/usr/bin/env node
/**
 * SocialMate MCP server (stdio).
 *
 * Lets Claude Desktop, Cursor, Cline — any MCP client — control WhatsApp through
 * a running SocialMate app. It is a thin, standalone translator over SocialMate's
 * local REST API: every tool call flows through the app's real auth → scope →
 * tier-gate → anti-ban → audit pipeline, so the app stays the single source of
 * truth and nothing here can bypass a limit.
 *
 * Configure in an MCP client (e.g. Claude Desktop → claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "socialmate": {
 *         "command": "npx",
 *         "args": ["-y", "socialmate-mcp"],
 *         "env": {
 *           "SOCIALMATE_API_KEY": "sm_paste_your_api_key_here",
 *           "SOCIALMATE_BASE_URL": "http://127.0.0.1:3456"
 *         }
 *       }
 *     }
 *   }
 *
 * …or, for Claude Code:
 *
 *   claude mcp add socialmate \
 *     --env SOCIALMATE_API_KEY=sm_paste_your_api_key_here \
 *     --env SOCIALMATE_BASE_URL=http://127.0.0.1:3456 \
 *     -- npx -y socialmate-mcp
 *
 * Keep the `-y`: without it npx can stop to ask you to confirm the install, inside
 * a stdio client where there is no terminal to answer it — so the server never starts.
 *
 * Two prerequisites:
 *   1. An **API key** (API & Integrations → MCP → "Create key & copy config"). A real key
 *      is `sm_<base64url>` — there is no `sk-`/`sk_` prefix and no `_live_` segment in this
 *      product. The key's scope (read / send / admin) and your license tier decide which
 *      tools actually work.
 *   2. The app's **local API running**. It ships off, but creating a key turns it on. Everything
 *      below talks to it over loopback; if it isn't running you get a clean tool list and
 *      every call fails — check API & Integrations shows it running.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.mjs';
import { PROMPTS } from './prompts.mjs';

// npm always ships package.json, so the reported server version can never drift
// from the published one (it was a hardcoded '1.0.0' through 1.2.x).
const { version: VERSION } = createRequire(import.meta.url)('./package.json');

const API_KEY = (process.env.SOCIALMATE_API_KEY || '').trim();
const BASE_URL = (process.env.SOCIALMATE_BASE_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');

// The values the documented config snippets ship with: `sm_paste_your_api_key_here`
// (README, app, website docs) and `sm_xxx` (the website's one-line `claude mcp add`).
// Pasting a snippet without swapping it in is the most common first-run mistake, and
// both pass the `sm_` prefix check — the app would only answer an opaque 401 on the
// first tool call.
const PLACEHOLDER_KEYS = new Set(['sm_paste_your_api_key_here', 'sm_xxx']);
const CREATE_KEY_HINT =
	'Create a key in SocialMate → API & Integrations → MCP → "Create key & copy config", then paste that config into your MCP client.';

// stdout is the MCP stdio channel — every diagnostic goes to stderr.
if (!API_KEY) {
	process.stderr.write(`socialmate-mcp: SOCIALMATE_API_KEY is required. ${CREATE_KEY_HINT}\n`);
	process.exit(2);
}
if (PLACEHOLDER_KEYS.has(API_KEY)) {
	process.stderr.write(`socialmate-mcp: SOCIALMATE_API_KEY is still the placeholder "${API_KEY}". ${CREATE_KEY_HINT}\n`);
	process.exit(2);
}
if (!API_KEY.startsWith('sm_')) {
	process.stderr.write(`socialmate-mcp: SOCIALMATE_API_KEY is not a SocialMate API key (a real key starts with "sm_"). ${CREATE_KEY_HINT}\n`);
	process.exit(2);
}

/** Call the SocialMate REST API and unwrap the { data } envelope. Throws an ApiError on non-2xx. */
class ApiError extends Error {
	constructor(status, body, { retryAfterHeader } = {}) {
		// The app answers errors as `{ error: { code, message, ...extra } }` (v1.1
		// envelope). A pre-1.1 bare `{ error: 'code', message }` is folded into the
		// same shape so formatError only ever branches on `inner.code`.
		const raw = body && typeof body === 'object' ? body.error : undefined;
		const inner =
			raw && typeof raw === 'object'
				? raw
				: typeof raw === 'string'
					? typeof body.message === 'string'
						? { ...body, code: raw, message: body.message }
						: { ...body, message: raw }
					: {};
		super(inner.message || `HTTP ${status}`);
		this.status = status;
		this.body = body;
		this.inner = inner;
		this.retryAfterHeader = retryAfterHeader ?? null;
	}
}

/** Build the ApiError for a non-2xx response, keeping the Retry-After header for 429s. */
function apiErrorFrom(res, body) {
	return new ApiError(res.status, body, { retryAfterHeader: res.headers.get('retry-after') });
}

async function request(method, path, { body, qs } = {}) {
	const url = new URL(`${BASE_URL}${path}`);
	if (qs) for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
	try {
		return await fetch(url, {
			method,
			headers: { 'x-api-key': API_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch (e) {
		throw new ApiError(0, { error: { message: `Cannot reach the SocialMate server at ${BASE_URL}. Is the app running with its local API on (API & Integrations)? (${e.message})` } });
	}
}

/** Read an error response body, which is always JSON even on the binary routes. */
async function errorBody(res) {
	const text = await res.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

async function call(method, path, { body, qs } = {}) {
	const res = await request(method, path, { body, qs });
	const parsed = await errorBody(res);
	if (!res.ok) throw apiErrorFrom(res, parsed);
	// Unwrap `{ data }` — but ONLY when `data` is the whole envelope. The paginated
	// routes answer `{ data, pagination }`, and unwrapping those would throw the
	// pagination away, leaving an agent unable to tell that there is a next page.
	const isEnvelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed && Object.keys(parsed).length === 1;
	return isEnvelope ? parsed.data : parsed;
}

/**
 * Fetch a binary route (media bytes) and base64 it for an MCP image block.
 * Without this the vision loop is impossible over pure MCP: an agent can see a
 * message HAS media but never look at it.
 */
async function callBinary(method, path, { qs } = {}) {
	const res = await request(method, path, { qs });
	if (!res.ok) throw apiErrorFrom(res, await errorBody(res));
	// The only binary route we expose is the thumbnail, which is always JPEG.
	const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
	return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType };
}

// Account-scope resolution, mirroring the n8n node: a single-account key
// auto-selects; a multi-account key must be told which account.
//
// Only a NON-empty list is cached. Before a number is linked the list is empty,
// and caching that would keep every account-bound tool failing until the MCP
// client restarted the server — long after the user had linked one.
let accountsCache = null;
async function resolveAccount(explicit) {
	if (explicit) return explicit;
	const list = accountsCache ?? (await call('GET', '/v1/accounts'));
	const accounts = Array.isArray(list) ? list : [];
	if (accounts.length > 0) accountsCache = accounts;
	if (accounts.length === 1) return accounts[0].id;
	if (accounts.length === 0) throw new ApiError(404, { error: { code: 'no_accounts', message: await noAccountsMessage() } });
	throw new ApiError(400, {
		error: { message: `This API key can use ${accounts.length} accounts, so account_id is required. Call whatsapp_list_accounts to see ids: ${accounts.map((a) => a.id).join(', ')}.` },
	});
}

/**
 * Why the key sees no accounts. An all-accounts key (`keyScope: null` from
 * /v1/capabilities) sees none only because no number is linked yet; a key limited
 * to specific numbers sees none because those numbers were removed. The fixes
 * differ, so say which — and fall back to naming both if the handshake fails.
 */
async function noAccountsMessage() {
	let keyScope;
	try {
		keyScope = (await call('GET', '/v1/capabilities'))?.keyScope;
	} catch {
		keyScope = undefined;
	}
	if (keyScope === null) {
		return 'No WhatsApp number is linked to SocialMate yet — link one in the SocialMate app or its admin console (Accounts → Add account), then retry.';
	}
	if (Array.isArray(keyScope)) {
		return 'This API key is limited to specific WhatsApp numbers, and none of them is linked to SocialMate any more. Re-link the number, or create a key that covers a linked number in SocialMate → API & Integrations.';
	}
	return 'This API key has no WhatsApp number in scope. Either no number is linked to SocialMate yet (link one in the app or its admin console: Accounts → Add account), or the key is limited to numbers that were removed (create a new key in API & Integrations).';
}

function ok(data) {
	return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
/** A binary tool result — an MCP image content block the client hands to its vision model. */
function image({ data, mimeType }) {
	return { content: [{ type: 'image', data, mimeType }] };
}
function fail(message) {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * How long the app asked us to wait, as human text ("5 s", "60 min"), from the
 * body's retryAfterMs or else the Retry-After header (seconds). Null if neither.
 */
function retryAfterText(err) {
	let ms = Number(err.inner?.retryAfterMs);
	if (!Number.isFinite(ms) || ms <= 0) {
		const sec = Number(err.retryAfterHeader);
		ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : NaN;
	}
	if (!Number.isFinite(ms)) return null;
	const sec = Math.max(1, Math.ceil(ms / 1000));
	if (sec < 90) return `${sec} s`;
	const min = Math.ceil(sec / 60);
	if (min < 90) return `${min} min`;
	return `${Math.round((min / 60) * 10) / 10} h`;
}

/** A 404 for an account id that names no account on this SocialMate. */
function isAccountNotFound(err) {
	return err.status === 404 && typeof err.inner?.message === 'string' && /^account not found/i.test(err.inner.message);
}

/** Turn an ApiError into an agent-friendly message that preserves the actionable signal. */
function formatError(err) {
	if (!(err instanceof ApiError)) return fail(`Unexpected error: ${err.message}`);
	const { status, inner } = err;
	const serverMessage = typeof inner.message === 'string' && inner.message ? inner.message : '';
	if (status === 401) {
		// The key reached the app and was refused: revoked, rotated, deleted, or
		// mistyped. Recreating it is the only fix, so say where.
		return fail(`SocialMate rejected the API key (${serverMessage || 'unauthorized'}) — it was revoked, rotated or mistyped. ${CREATE_KEY_HINT}`);
	}
	if (status === 402) return fail(`This requires SocialMate Pro (feature: ${inner.feature || 'unknown'}). Upgrade in the app, or use a Free-tier tool.`);
	if (status === 403) {
		// Branch on the app's stable machine code. Only `insufficient_scope` is a
		// key-scope problem; every other 403 (batch sending off, a key scoped to a
		// different account, every scoped account suspended on Free, not a group
		// admin) carries its own instruction, which recreating the key won't fix.
		if (inner.code === 'insufficient_scope') {
			return fail(`The API key is missing the '${inner.required || 'required'}' scope${Array.isArray(inner.have) ? ` (it has: ${inner.have.join(', ') || 'none'})` : ''}. Create a key with that scope in the app → API & Integrations, and put it in your MCP config.`);
		}
		if (inner.code === 'bulk_import_disabled') {
			// `bulk_import_disabled` is the wire code and never changes; only the words the agent reads do.
			return fail(serverMessage || 'Batch sending is switched off. The user must enable it in the app under Settings → Advanced → "Enable batch sending". Do not fall back to sending the messages one by one.');
		}
		return fail(serverMessage || 'SocialMate refused this request (403).');
	}
	if (isAccountNotFound(err)) {
		// An account_id that names no account on this SocialMate (mistyped, removed,
		// or from another install). Point at the tool that lists the real ones.
		return fail('Account not found — that account_id is not a WhatsApp number linked to this SocialMate. Call whatsapp_list_accounts for valid ids.');
	}
	if (status === 409) {
		// Most 409s are "account not connected", but the agent routes use 409 for
		// their own conflicts ("Already approved.", "Choose an AI provider…") —
		// pass those through instead of misreporting them as a dead connection.
		if (serverMessage && !/not connected/i.test(serverMessage)) return fail(serverMessage);
		return fail('That WhatsApp account is not connected. Link it in the SocialMate app first.');
	}
	if (status === 429) {
		const wait = retryAfterText(err);
		// The signal lane (typing / read receipts / reactions) has its own cap,
		// separate from the message budget. Signals are never queued on any tier,
		// so the "upgrade to Pro to auto-queue" pitch below would be false here.
		if (inner.reason === 'signal_rate_limit' || inner.code === 'ANTI_BAN_SIGNAL_RATE_LIMIT') {
			return fail(`Signal rate limit hit (typing/read/reaction) — ${wait ? `retry after ${wait}` : 'retry in a moment'}. This cap is separate from the message budget. Do not resend in a loop.`);
		}
		// Anti-ban block carries a reason; the per-key request limiter does not.
		// The send routes add their own tier-aware `hint`. A reason with no hint
		// comes only from the app's shared error handler, i.e. the routes that are
		// never auto-queued on any tier (signal lane pauses/bans, group writes), so
		// an "upgrade to Pro to auto-queue" fallback would be false there.
		if (inner.reason && inner.hint) {
			return fail(`Send blocked by anti-ban (reason: ${inner.reason})${wait ? ` — retry after ${wait}` : ''}. ${inner.hint} Do not resend in a loop.`);
		}
		if (inner.reason) {
			return fail(`Blocked by anti-ban (reason: ${inner.reason})${wait ? ` — retry after ${wait}` : ''}. This action is not auto-queued on any tier — back off and retry once the block clears. Do not resend in a loop.`);
		}
		return fail(`Rate limited (${serverMessage || 'too many requests'}) — ${wait ? `retry after ${wait}` : 'slow down and retry in a moment'}.`);
	}
	return fail(err.message);
}

const server = new McpServer({ name: 'socialmate', version: VERSION });

for (const tool of TOOLS) {
	server.registerTool(
		tool.name,
		{ description: tool.description, inputSchema: tool.inputSchema },
		async (args) => {
			try {
				const a = { ...args };
				if (tool.accountScoped) a._account = await resolveAccount(args.account_id);
				const req = tool.build(a);
				if (tool.binary) return image(await callBinary(req.method, req.path, { qs: req.qs }));
				const data = await call(req.method, req.path, { body: req.body, qs: req.qs });
				return ok(data);
			} catch (err) {
				if (tool.accountScoped && !args.account_id && err instanceof ApiError && isAccountNotFound(err)) {
					// The auto-selected id came from a stale cache (the number was removed
					// or re-linked under a new id). Drop it so the retry re-reads /v1/accounts.
					accountsCache = null;
					return fail('The WhatsApp number this server had auto-selected is no longer linked to SocialMate (it was removed or re-linked). The account list has been refreshed — retry the call, or call whatsapp_list_accounts for valid ids.');
				}
				return formatError(err);
			}
		},
	);
}

// Native MCP prompts (`prompts/list` / `prompts/get`). A client can surface these
// as slash-commands or load one as its system prompt — so the agent seed prompt
// lives where the agent can actually fetch it, not only in a README.
for (const prompt of PROMPTS) {
	server.registerPrompt(prompt.name, prompt.config, (args) => ({
		messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args ?? {}) } }],
	}));
}

/**
 * Non-fatal startup probe of the app's public /health route (no API key needed).
 * "The tools are there but every call fails" almost always means the app's local
 * API is not running — say so once, up front, on stderr. The server keeps starting
 * either way: the app may simply be launched later, and each tool call still
 * reports its own connection error.
 *
 * The app wraps every JSON answer in the v1.1 `{ data }` envelope, /health
 * included. We pin the legacy bare shape with `X-SocialMate-Envelope: v1` AND
 * unwrap `data` if it is there anyway, so neither an older nor a newer app is ever
 * misread as "something other than SocialMate".
 */
async function probeHealth() {
	const url = `${BASE_URL}/health`;
	const unreachable = (detail) =>
		process.stderr.write(
			`socialmate-mcp: SocialMate API not reachable at ${url} (${detail}) — open SocialMate and check that API & Integrations shows the local API running (creating a key turns it on), or check SOCIALMATE_BASE_URL.\n`,
		);
	try {
		const res = await fetch(url, { headers: { 'X-SocialMate-Envelope': 'v1' }, signal: AbortSignal.timeout(2000) });
		if (!res.ok) return unreachable(`HTTP ${res.status}`);
		const body = await res.json().catch(() => null);
		const health = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
		if (health?.app !== 'SocialMate') return unreachable('something other than SocialMate answered');
	} catch (e) {
		unreachable(e?.name === 'TimeoutError' ? 'no answer within 2s' : e?.cause?.code || e?.message || 'network error');
	}
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
	`socialmate-mcp ${VERSION}: using ${BASE_URL} with ${TOOLS.length} tools and ${PROMPTS.length} prompt(s).\n`,
);
void probeHealth();
