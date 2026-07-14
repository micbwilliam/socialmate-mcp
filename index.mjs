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
 * Two prerequisites, in this order:
 *   1. The app's **local API server must be switched on** — it is OFF by default
 *      (SocialMate → API & Integrations). Everything below talks to it over loopback;
 *      if it isn't running you get a clean tool list and every call fails.
 *   2. An **API key** (API & Integrations → API Keys). A real key is `sm_<base64url>` —
 *      there is no `sk-`/`sk_` prefix and no `_live_` segment in this product. The key's
 *      scope (read / send / admin) and your license tier decide which tools actually work.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.mjs';
import { PROMPTS } from './prompts.mjs';

const API_KEY = process.env.SOCIALMATE_API_KEY;
const BASE_URL = (process.env.SOCIALMATE_BASE_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');

if (!API_KEY) {
	process.stderr.write(
		'socialmate-mcp: SOCIALMATE_API_KEY is required. Create one in the SocialMate app → API & Integrations, then set it in your MCP client config.\n',
	);
	process.exit(2);
}

/** Call the SocialMate REST API and unwrap the { data } envelope. Throws an ApiError on non-2xx. */
class ApiError extends Error {
	constructor(status, body) {
		const inner = (body && typeof body === 'object' && body.error) || {};
		super(inner.message || (typeof body?.error === 'string' ? body.error : `HTTP ${status}`));
		this.status = status;
		this.body = body;
		this.inner = inner;
	}
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
		throw new ApiError(0, { error: { message: `Cannot reach the SocialMate server at ${BASE_URL}. Is the app running and the API enabled? (${e.message})` } });
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
	if (!res.ok) throw new ApiError(res.status, parsed);
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
	if (!res.ok) throw new ApiError(res.status, await errorBody(res));
	// The only binary route we expose is the thumbnail, which is always JPEG.
	const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
	return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType };
}

// Account-scope resolution, mirroring the n8n node: a single-account key
// auto-selects; a multi-account key must be told which account.
let accountsCache = null;
async function resolveAccount(explicit) {
	if (explicit) return explicit;
	if (!accountsCache) accountsCache = await call('GET', '/v1/accounts');
	const list = Array.isArray(accountsCache) ? accountsCache : [];
	if (list.length === 1) return list[0].id;
	if (list.length === 0) throw new ApiError(404, { error: { message: 'This API key has no accounts in scope. Connect a WhatsApp account in the SocialMate app first.' } });
	throw new ApiError(400, {
		error: { message: `This API key can use ${list.length} accounts, so account_id is required. Call whatsapp_list_accounts to see ids: ${list.map((a) => a.id).join(', ')}.` },
	});
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

/** Turn an ApiError into an agent-friendly message that preserves the actionable signal. */
function formatError(err) {
	if (!(err instanceof ApiError)) return fail(`Unexpected error: ${err.message}`);
	const { status, inner } = err;
	if (status === 402) return fail(`This requires SocialMate Pro (feature: ${inner.feature || 'unknown'}). Upgrade in the app, or use a Free-tier tool.`);
	if (status === 403) {
		// Batch sending is opt-in and OFF by default, so its 403 is a product gate,
		// not a scope problem — pass the server's own instruction through rather
		// than sending the agent to rebuild its API key. (`bulk_import_disabled` is
		// the wire code and never changes; only the words the agent reads do.)
		if (err.body?.error === 'bulk_import_disabled') {
			return fail(err.body.message || 'Batch sending is switched off. The user must enable it in the app under Settings → Advanced → "Enable batch sending". Do not fall back to sending the messages one by one.');
		}
		return fail(`The API key is missing the '${inner.required || 'required'}' scope. Recreate it with more scope in the app → API & Integrations.`);
	}
	if (status === 409) return fail('That WhatsApp account is not connected. Link it in the SocialMate app first.');
	if (status === 429) {
		// Anti-ban block carries a reason/upgrade; the per-key limiter does not.
		if (inner.reason) return fail(`Send blocked by anti-ban (reason: ${inner.reason}). ${inner.hint || 'Back off and retry later, or upgrade to Pro to auto-queue blocked sends.'}`);
		return fail('Rate limited — slow down and retry in a moment.');
	}
	return fail(err.message);
}

const server = new McpServer({ name: 'socialmate', version: '1.0.0' });

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

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
	`socialmate-mcp: connected to ${BASE_URL} with ${TOOLS.length} tools and ${PROMPTS.length} prompt(s).\n`,
);
