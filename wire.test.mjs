import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * How the app's REAL wire shapes reach the agent. Every response here comes from
 * test/fixtures/sm4-api-envelopes.json, captured from SM4's createApiServer with
 * no X-SocialMate-Envelope header — what this server actually receives. The mocks
 * in test.mjs once used pre-1.1 bare shapes the app never sends, which is how
 * "every 403 says 'missing the required scope'" shipped unnoticed.
 */

const FX = JSON.parse(readFileSync(new URL('./test/fixtures/sm4-api-envelopes.json', import.meta.url), 'utf8'));

/** The next answer the mock gives to any route except GET /v1/accounts, plus every request it saw. */
let next = null;
const seen = [];

let mock;
let client;

before(async () => {
	const server = createServer((req, res) => {
		let chunks = '';
		req.on('data', (c) => (chunks += c));
		req.on('end', () => {
			const path = req.url.split('?')[0];
			if (req.method === 'GET' && path === '/v1/accounts') {
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ data: [{ id: 'acc-1', name: 'Test', state: 'connected' }] }));
			}
			seen.push({ method: req.method, path, body: chunks ? JSON.parse(chunks) : null });
			const fx = next ?? { status: 404, body: { error: { code: 'not_found', message: 'no fixture set' } } };
			res.writeHead(fx.status, { 'content-type': 'application/json', ...(fx.retryAfter ? { 'retry-after': fx.retryAfter } : {}) });
			res.end(JSON.stringify(fx.body));
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${server.address().port}`;
	mock = { close: () => new Promise((r) => server.close(r)) };
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL('./index.mjs', import.meta.url))],
		env: { ...process.env, SOCIALMATE_API_KEY: 'sm_test-key', SOCIALMATE_BASE_URL: url },
		stderr: 'pipe',
	});
	client = new Client({ name: 'wire-test', version: '1.0.0' });
	await client.connect(transport);
});

after(async () => {
	await client.close();
	await mock.close();
});

async function callWith(fixture, name, args) {
	next = fixture;
	seen.length = 0;
	try {
		return await client.callTool({ name, arguments: args });
	} finally {
		next = null;
	}
}
const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');

// ── 403: branch on error.code, never on the HTTP status alone ────────────────

test('403 bulk_import_disabled passes the app’s own instruction through, not a key-scope message', async () => {
	const res = await callWith(FX.bulk_import_disabled, 'whatsapp_queue_import', { batch_name: 'b', template: 'Hi {{name}}', rows: [{ chat_id: '15551234567' }] });
	assert.equal(res.isError, true);
	assert.equal(textOf(res), FX.bulk_import_disabled.body.error.message);
	assert.match(textOf(res), /never loop a send over a list/);
	assert.doesNotMatch(textOf(res), /scope/i);
});

test('403 insufficient_scope names the missing scope and the scopes the key has', async () => {
	const res = await callWith(FX.insufficient_scope, 'whatsapp_send_message', { chat_id: '15551234567', text: 'hi' });
	assert.equal(res.isError, true);
	assert.match(textOf(res), /missing the 'send' scope \(it has: read\)/);
	assert.match(textOf(res), /API & Integrations/);
});

for (const code of ['account_scope_mismatch', 'account_suspended_free']) {
	test(`403 ${code} passes the app’s message through instead of "recreate the key with more scope"`, async () => {
		const res = await callWith(FX[code], 'whatsapp_list_chats', {});
		assert.equal(res.isError, true);
		assert.equal(textOf(res), FX[code].body.error.message);
		assert.doesNotMatch(textOf(res), /missing the/);
	});
}

test('403 group_forbidden passes the app’s "will not succeed on retry" message through', async () => {
	// Not captured (it needs a live WhatsApp refusal), but the onSend hook folds it
	// exactly like bulk_import_disabled: convention B → { error: { code, message } }.
	const fx = { status: 403, body: { error: { code: 'group_forbidden', message: 'WhatsApp refused to leave the group: this account is not an admin of the group (or the group restricts the action to admins). This will not succeed on retry.' } } };
	const res = await callWith(fx, 'whatsapp_leave_group', { group_id: '123@g.us' });
	assert.equal(res.isError, true);
	assert.equal(textOf(res), fx.body.error.message);
});

test('a pre-1.1 bare 403 (X-SocialMate-Envelope: v1 shape) is still read by its code', async () => {
	const legacy = { status: 403, body: { error: 'bulk_import_disabled', message: 'Batch sending is turned off (legacy shape).' } };
	const res = await callWith(legacy, 'whatsapp_queue_import', { batch_name: 'b', template: 'x', rows: [{ chat_id: '15551234567' }] });
	assert.equal(textOf(res), 'Batch sending is turned off (legacy shape).');
});

// ── 401 / 402 / 429 ──────────────────────────────────────────────────────────

test('401 says the key was rejected and how to get a working one', async () => {
	const res = await callWith(FX.unauthorized_invalid, 'whatsapp_queue_status', {});
	assert.equal(res.isError, true);
	assert.match(textOf(res), /rejected the API key \(Invalid API key\) — it was revoked, rotated or mistyped/);
	assert.match(textOf(res), /API & Integrations → MCP → "Create key & copy config"/);
});

test('402 names the Pro feature', async () => {
	const res = await callWith(FX.license_required, 'whatsapp_search_messages', {});
	assert.equal(res.isError, true);
	assert.match(textOf(res), /requires SocialMate Pro \(feature: localMessageCache\)/);
});

test('per-key 429 surfaces how long to wait', async () => {
	const res = await callWith(FX.rate_limited_per_key, 'whatsapp_list_chats', {});
	assert.equal(res.isError, true);
	assert.equal(textOf(res), 'Rate limited (Per-key request rate exceeded) — retry after 5 s.');
});

test('per-key 429 with no retryAfterMs falls back to the Retry-After header', async () => {
	const fx = { status: 429, retryAfter: '7', body: { error: { code: 'rate_limited', message: 'Per-key request rate exceeded' } } };
	const res = await callWith(fx, 'whatsapp_list_chats', {});
	assert.match(textOf(res), /retry after 7 s/);
});

test('a Free anti-ban 429 names the reason, the wait and the app’s hint', async () => {
	const res = await callWith(FX.send_blocked_free, 'whatsapp_send_message', { chat_id: '15551234567', text: 'hi' });
	assert.equal(res.isError, true);
	assert.match(textOf(res), /Send blocked by anti-ban \(reason: night_mode\) — retry after 60 min\./);
	assert.match(textOf(res), /Quiet hours are active/);
	assert.match(textOf(res), /Do not resend in a loop/);
});

// ── 202: a Pro send that anti-ban deferred is queued, not sent, and not an error ──

test('a Pro 202 { queued } answer to whatsapp_send_message is a success the agent can read', async () => {
	const res = await callWith(FX.send_queued_pro, 'whatsapp_send_message', { chat_id: '15551234567', text: 'hi' });
	assert.ok(!res.isError, 'queued is not an error');
	assert.deepEqual(JSON.parse(textOf(res)), FX.send_queued_pro.body.data);
});
