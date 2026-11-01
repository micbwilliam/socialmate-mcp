import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * What an agent is told when it cannot pick an account: before a number is linked,
 * for a key limited to numbers that were removed, and for an account_id that names
 * no account. Shapes follow SM4's api-server.ts: GET /v1/accounts and
 * GET /v1/capabilities (`keyScope`: null = all accounts) answer the `{ data }`
 * envelope; an unknown account answers `{ error: 'Account not found' }`, which the
 * v1.1 envelope rewrites to `{ error: { code: 'not_found', message } }`.
 */

/** Mutable mock state: the accounts the key sees, its scope, and whether the handshake works. */
const state = { accounts: [], keyScope: null, capabilitiesFail: false };
const seen = [];

let mock;
let client;

const json = (res, status, body) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

before(async () => {
	const server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			const path = req.url.split('?')[0];
			seen.push(`${req.method} ${path}`);
			if (req.method === 'GET' && path === '/v1/accounts') return json(res, 200, { data: state.accounts });
			if (req.method === 'GET' && path === '/v1/capabilities') {
				if (state.capabilitiesFail) return json(res, 500, { error: { code: 'internal', message: 'boom' } });
				return json(res, 200, { data: { app: 'SocialMate', keyScope: state.keyScope, accounts: state.accounts } });
			}
			const m = /^\/v1\/accounts\/([^/]+)\/messages$/.exec(path);
			if (req.method === 'POST' && m) {
				if (!state.accounts.some((a) => a.id === m[1])) return json(res, 404, { error: { code: 'not_found', message: 'Account not found' } });
				return json(res, 200, { data: { sent: true, messageId: 'm1', chatId: '15551234567@s.whatsapp.net', status: 'sent' } });
			}
			return json(res, 404, { error: { code: 'not_found', message: 'no route in mock' } });
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
	client = new Client({ name: 'accounts-test', version: '1.0.0' });
	await client.connect(transport);
});

after(async () => {
	await client.close();
	await mock.close();
});

const send = (args = {}) => client.callTool({ name: 'whatsapp_send_message', arguments: { chat_id: '15551234567', text: 'hi', ...args } });
const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');

// Order matters: the server under test is one process, and these steps walk it
// from "nothing linked" to "linked" exactly as a user would.

test('all-accounts key, nothing linked yet: says to link a number, not that the key is out of scope', async () => {
	Object.assign(state, { accounts: [], keyScope: null, capabilitiesFail: false });
	const res = await send();
	assert.equal(res.isError, true);
	assert.match(textOf(res), /No WhatsApp number is linked to SocialMate yet/);
	assert.match(textOf(res), /Accounts → Add account/);
	assert.doesNotMatch(textOf(res), /in scope/);
});

test('a key limited to numbers that were removed says so, and how to fix it', async () => {
	Object.assign(state, { accounts: [], keyScope: ['acc-gone'], capabilitiesFail: false });
	const res = await send();
	assert.equal(res.isError, true);
	assert.match(textOf(res), /limited to specific WhatsApp numbers, and none of them is linked/);
	assert.doesNotMatch(textOf(res), /linked to SocialMate yet/);
});

test('when the handshake fails, the message names both causes instead of guessing', async () => {
	Object.assign(state, { accounts: [], keyScope: null, capabilitiesFail: true });
	const res = await send();
	assert.equal(res.isError, true);
	assert.match(textOf(res), /Either no number is linked to SocialMate yet/);
	assert.match(textOf(res), /limited to numbers that were removed/);
});

test('an empty list is not cached: linking a number mid-session works without restarting the server', async () => {
	Object.assign(state, { accounts: [{ id: 'acc-1', name: 'Shop', status: 'connected' }], keyScope: null, capabilitiesFail: false });
	seen.length = 0;
	const res = await send();
	assert.notEqual(res.isError, true, textOf(res));
	assert.match(textOf(res), /"sent": true/);
	assert.deepEqual(seen, ['GET /v1/accounts', 'POST /v1/accounts/acc-1/messages']);
});

test('an unknown account_id points at whatsapp_list_accounts', async () => {
	const res = await send({ account_id: 'nope' });
	assert.equal(res.isError, true);
	assert.match(textOf(res), /^Account not found/);
	assert.match(textOf(res), /Call whatsapp_list_accounts for valid ids/);
});

test('a cached number that was removed and re-linked under a new id: says so, refreshes, and the retry works', async () => {
	// acc-1 is cached from the step above; the user removes it and links acc-2.
	Object.assign(state, { accounts: [{ id: 'acc-2', name: 'Shop', status: 'connected' }], keyScope: null, capabilitiesFail: false });
	seen.length = 0;
	const first = await send();
	assert.equal(first.isError, true);
	assert.match(textOf(first), /no longer linked to SocialMate/);
	assert.deepEqual(seen, ['POST /v1/accounts/acc-1/messages']);
	seen.length = 0;
	const retry = await send();
	assert.notEqual(retry.isError, true, textOf(retry));
	assert.deepEqual(seen, ['GET /v1/accounts', 'POST /v1/accounts/acc-2/messages']);
});
