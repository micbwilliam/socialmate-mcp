import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * End-to-end: MCP client → spawned socialmate-mcp (index.mjs) → mock SocialMate
 * REST. Proves the tool catalog, account auto-resolution, the { data } unwrap,
 * a normal send, and that an anti-ban 429 surfaces as an actionable tool error.
 */

/** The smallest valid JPEG — stands in for a real media thumbnail on the binary route. */
const JPEG_1PX = Buffer.from(
	'/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
	'base64',
);

function startMock() {
	const server = createServer((req, res) => {
		let chunks = '';
		req.on('data', (c) => (chunks += c));
		req.on('end', () => {
			const path = req.url.split('?')[0];
			const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
			const send = (code, obj) => {
				res.writeHead(code, { 'content-type': 'application/json' });
				res.end(JSON.stringify(obj));
			};
			if (req.method === 'GET' && path === '/v1/accounts') return send(200, { data: [{ id: 'acc1', name: 'Test', state: 'connected' }] });
			if (req.method === 'POST' && path === '/v1/accounts/acc1/messages') {
				const body = chunks ? JSON.parse(chunks) : {};
				if (body.text === '__BLOCK__') {
					return send(429, { error: { code: 'rate_limited', message: 'Sending is paused during quiet hours', reason: 'night_mode', hint: 'Upgrade to Pro to auto-queue.', upgrade: { tier: 'pro', feature: 'apiSmartQueue' } } });
				}
				// `echo` lets the tests assert each send tool builds the right body.
				return send(200, { data: { sent: true, messageId: 'm-1', chatId: body.chatId, status: 'sent', echo: body } });
			}
			// Signal lane — presence / mark-read / reaction. Echo the body back so
			// the test can prove each tool builds the right request.
			if (req.method === 'POST' && path === '/v1/accounts/acc1/presence') {
				return send(200, { data: { ok: true, ...(chunks ? JSON.parse(chunks) : {}) } });
			}
			if (req.method === 'POST' && path === '/v1/accounts/acc1/messages/read') {
				return send(200, { data: { ok: true, ...(chunks ? JSON.parse(chunks) : {}) } });
			}
			if (req.method === 'POST' && /^\/v1\/accounts\/acc1\/messages\/[^/]+\/reaction$/.test(path)) {
				const body = chunks ? JSON.parse(chunks) : {};
				return send(200, { data: { ok: true, messageId: path.split('/')[5], emoji: body.emoji, removed: body.emoji === '' } });
			}
			if (req.method === 'GET' && path === '/v1/accounts/acc1/chats') return send(200, { data: [{ id: '15551234567', name: 'Jane', type: 'user', unread: 0 }] });
			// AI-context (memory) — used by both whatsapp_get_ai_context and its deprecated alias.
			if (req.method === 'GET' && path === '/v1/accounts/acc1/ai-context') return send(200, { data: { transcript: 'Jane: hi', messages: [], meta: {} } });
			// Poll cursor — echo afterTs inside `data` (the { data } envelope is
			// unwrapped by the client) so the test can prove it was forwarded.
			if (req.method === 'GET' && path === '/v1/accounts/acc1/messages') {
				return send(200, { data: { echoedAfterTs: query.afterTs ?? null, messages: [{ id: 'm-2', chatId: '15551234567', text: 'new one', timestamp: 1750000000001 }] } });
			}
			if (req.method === 'GET' && path === '/v1/capabilities') return send(200, { data: { tier: 'pro', features: { localMessageCache: true }, accountScope: null } });
			// Media — the vision loop. The list echoes the query back so the test can
			// prove the filters map onto the REST param names.
			if (req.method === 'GET' && path === '/v1/accounts/acc1/media') {
				return send(200, {
					data: [{ id: 'med_1', type: 'image', state: 'downloaded', needsContext: true }],
					pagination: { limit: 100, offset: 0, total: 1, echoedQuery: query },
				});
			}
			// The thumbnail is BINARY, not JSON — a 1x1 JPEG stands in for a real one.
			if (req.method === 'GET' && path === '/v1/accounts/acc1/media/med_1/thumbnail') {
				res.writeHead(200, { 'content-type': 'image/jpeg' });
				return res.end(JPEG_1PX);
			}
			if (req.method === 'PUT' && path === '/v1/accounts/acc1/media/med_1/context') {
				return send(200, { data: { success: true, media: { id: 'med_1', needsContext: false, ...(chunks ? JSON.parse(chunks) : {}) } } });
			}
			// Bulk lane — import a batch, then cancel/retry it by batch id.
			if (req.method === 'POST' && path === '/v1/accounts/acc1/queue/import') {
				const body = chunks ? JSON.parse(chunks) : {};
				if (body.batchName === '__DISABLED__') {
					// The real 403 shape: a product gate (bulk import is off by default),
					// NOT a missing API-key scope.
					return send(403, { error: 'bulk_import_disabled', message: 'Batch sending is turned off. Ask the user to switch it on in the app under Settings → Advanced → Enable batch sending.' });
				}
				return send(200, { data: { success: true, batch: { id: 'batch_1', name: body.batchName }, itemCount: (body.rows ?? []).length, echo: body } });
			}
			if (req.method === 'DELETE' && path === '/v1/queue/batches/batch_1') return send(200, { data: { success: true, cancelled: 3 } });
			if (req.method === 'POST' && path === '/v1/queue/batches/batch_1/retry') return send(200, { data: { success: true, retried: 2 } });
			return send(404, { error: { code: 'not_found', message: `no mock for ${req.method} ${path}` } });
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

/** Unwrap an MCP tool result back into the object the server returned. */
function payload(res) {
	return JSON.parse(res.content[0].text);
}

test('socialmate-mcp end to end', async () => {
	const mock = await startMock();
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL('./index.mjs', import.meta.url))],
		env: { ...process.env, SOCIALMATE_API_KEY: 'test-key', SOCIALMATE_BASE_URL: mock.url },
	});
	const client = new Client({ name: 'test-client', version: '1.0.0' });
	await client.connect(transport);

	// tools/list
	const { tools } = await client.listTools();
	assert.equal(tools.length, 44, 'exposes the full tool catalog');
	assert.ok(tools.every((t) => t.name.startsWith('whatsapp_')), 'tools are namespaced');
	assert.ok(tools.every((t) => t.description.length > 80), 'every tool has an agent-grade description');
	// the memory tool is discoverable under the clear name AND the deprecated alias
	assert.ok(tools.find((t) => t.name === 'whatsapp_get_ai_context'), 'ai-context tool present');
	assert.ok(tools.find((t) => t.name === 'whatsapp_get_conversation'), 'deprecated alias present');
	assert.ok(tools.find((t) => t.name === 'whatsapp_fetch_new_messages'), 'inbound poll tool present');
	// Agent Memory writes (Pro): enrich a contact, cache a media description
	assert.ok(tools.find((t) => t.name === 'whatsapp_update_contact'), 'contact enrichment tool present');
	assert.ok(tools.find((t) => t.name === 'whatsapp_set_media_context'), 'media context tool present');
	// The vision loop — set_media_context is a dead end without a way to SEE the media.
	for (const n of ['whatsapp_list_media', 'whatsapp_get_media']) assert.ok(tools.find((t) => t.name === n), `${n} present`);
	// The bulk lane — without it an agent loops send_message over a list.
	for (const n of ['whatsapp_queue_import', 'whatsapp_cancel_batch', 'whatsapp_retry_batch']) assert.ok(tools.find((t) => t.name === n), `${n} present`);
	// conversational primitives — send AND read back (a poll you can't read the
	// results of is a dead end for an agent).
	for (const n of ['whatsapp_send_poll', 'whatsapp_get_poll_results', 'whatsapp_send_location', 'whatsapp_send_contact', 'whatsapp_react_message', 'whatsapp_mark_read', 'whatsapp_send_typing']) {
		assert.ok(tools.find((t) => t.name === n), `${n} present`);
	}

	// list accounts
	const accounts = await client.callTool({ name: 'whatsapp_list_accounts', arguments: {} });
	assert.match(JSON.stringify(accounts), /acc1/);

	// normal send (account auto-resolves to the single account)
	const sent = await client.callTool({ name: 'whatsapp_send_message', arguments: { chat_id: '15551234567', text: 'hello' } });
	assert.ok(!sent.isError, 'send succeeds');
	assert.match(JSON.stringify(sent), /m-1/);

	// anti-ban block → actionable tool error, not a crash
	const blocked = await client.callTool({ name: 'whatsapp_send_message', arguments: { chat_id: '15551234567', text: '__BLOCK__' } });
	assert.ok(blocked.isError, 'block is surfaced as a tool error');
	assert.match(JSON.stringify(blocked), /anti-ban|night_mode/);

	// read-only chat list
	const chats = await client.callTool({ name: 'whatsapp_list_chats', arguments: {} });
	assert.match(JSON.stringify(chats), /Jane/);

	// memory tool and its deprecated alias both reach the ai-context endpoint
	const ctx = await client.callTool({ name: 'whatsapp_get_ai_context', arguments: { chat_id: '15551234567' } });
	assert.ok(!ctx.isError && /transcript/.test(JSON.stringify(ctx)), 'get_ai_context returns the transcript');
	const aliasCtx = await client.callTool({ name: 'whatsapp_get_conversation', arguments: { chat_id: '15551234567' } });
	assert.ok(!aliasCtx.isError && /transcript/.test(JSON.stringify(aliasCtx)), 'alias returns the transcript');

	// poll tool forwards the `since` cursor as afterTs and returns new rows
	const polled = await client.callTool({ name: 'whatsapp_fetch_new_messages', arguments: { since: 1750000000000 } });
	assert.ok(!polled.isError, 'poll succeeds');
	assert.match(JSON.stringify(polled), /echoedAfterTs.{0,8}1750000000000/, 'since is forwarded as afterTs');
	assert.match(JSON.stringify(polled), /m-2/, 'returns the new message');

	// capabilities lets an agent self-discover its tier/scope
	const caps = await client.callTool({ name: 'whatsapp_get_capabilities', arguments: {} });
	assert.match(JSON.stringify(caps), /tier.{0,8}pro/, 'capabilities returns the tier');

	// ── Conversational primitives ────────────────────────────────────────────
	// Each asserts the tool maps its snake_case inputs onto the app's camelCase
	// REST body — the exact place a mirror silently drifts from the source.
	// The mock echoes the received body back as `echo`.

	const reply = await client.callTool({ name: 'whatsapp_send_message', arguments: { chat_id: '15551234567', text: 'hi', reply_to: 'm-0' } });
	assert.equal(payload(reply).echo.replyTo, 'm-0', 'reply_to maps to replyTo');

	const poll = await client.callTool({ name: 'whatsapp_send_poll', arguments: { chat_id: '15551234567', name: 'Lunch?', options: ['Yes', 'No'], selectable_count: 1 } });
	assert.ok(!poll.isError, 'send_poll succeeds');
	assert.deepEqual(payload(poll).echo.poll, { name: 'Lunch?', options: ['Yes', 'No'], selectableCount: 1 }, 'poll body shape');

	const loc = await client.callTool({ name: 'whatsapp_send_location', arguments: { chat_id: '15551234567', latitude: 30.0444, longitude: 31.2357, name: 'Cairo' } });
	assert.deepEqual(payload(loc).echo.location, { latitude: 30.0444, longitude: 31.2357, name: 'Cairo' }, 'location body shape');

	const card = await client.callTool({ name: 'whatsapp_send_contact', arguments: { chat_id: '15551234567', contacts: [{ full_name: 'Jane Doe', phone: '15551230000' }] } });
	assert.deepEqual(payload(card).echo.contacts, [{ fullName: 'Jane Doe', phone: '15551230000' }], 'contacts snake_case → camelCase');

	const react = await client.callTool({ name: 'whatsapp_react_message', arguments: { chat_id: '15551234567', message_id: 'm-1', emoji: '👍' } });
	assert.equal(payload(react).messageId, 'm-1', 'react targets the message by id in the path');
	const unreact = await client.callTool({ name: 'whatsapp_react_message', arguments: { chat_id: '15551234567', message_id: 'm-1', emoji: '' } });
	assert.equal(payload(unreact).removed, true, 'empty emoji removes the reaction');

	const read = await client.callTool({ name: 'whatsapp_mark_read', arguments: { chat_id: '15551234567' } });
	assert.equal(payload(read).ok, true, 'mark_read succeeds');

	const typing = await client.callTool({ name: 'whatsapp_send_typing', arguments: { chat_id: '15551234567', state: 'composing' } });
	assert.equal(payload(typing).state, 'composing', 'typing forwards the presence state');

	// ── The vision loop ──────────────────────────────────────────────────────
	// list (what haven't I seen?) → get (actually see it) → set_media_context
	// (never see it again). The middle step is the one MCP used to be missing.

	const mediaList = await client.callTool({ name: 'whatsapp_list_media', arguments: { has_context: false, chat_id: '15551234567', limit: 10 } });
	assert.ok(!mediaList.isError, 'list_media succeeds');
	const listed = payload(mediaList);
	assert.equal(listed.data[0].id, 'med_1', 'returns media rows');
	assert.equal(listed.pagination.echoedQuery.hasContext, 'false', 'has_context maps onto the REST hasContext filter');
	assert.equal(listed.pagination.echoedQuery.chatId, '15551234567', 'chat_id maps onto chatId');

	const img = await client.callTool({ name: 'whatsapp_get_media', arguments: { media_id: 'med_1' } });
	assert.ok(!img.isError, 'get_media succeeds');
	assert.equal(img.content[0].type, 'image', 'get_media returns an MCP image block, not JSON');
	assert.equal(img.content[0].mimeType, 'image/jpeg', 'the thumbnail mime type is passed through');
	assert.equal(img.content[0].data, JPEG_1PX.toString('base64'), 'the raw bytes arrive base64-encoded and intact');

	const cached = await client.callTool({ name: 'whatsapp_set_media_context', arguments: { media_id: 'med_1', context: 'A dented parcel.', source: 'my-vision-model' } });
	assert.equal(payload(cached).media.context, 'A dented parcel.', 'the description your model produced is stored');

	// ── The bulk lane ────────────────────────────────────────────────────────
	// One import, not N sends — and the batch can be stopped or re-run.

	const imported = await client.callTool({
		name: 'whatsapp_queue_import',
		arguments: {
			batch_name: 'Delay notice',
			template: 'Hi {{name}}, order {{order}} is delayed.',
			rows: [{ chat_id: '15551234567', display_name: 'Jane', fields: { name: 'Jane', order: 'A-1001' } }],
			scheduled_at: '2026-07-10T14:30:00Z',
		},
	});
	assert.ok(!imported.isError, 'queue_import succeeds');
	const batch = payload(imported);
	assert.equal(batch.batch.id, 'batch_1');
	assert.deepEqual(batch.echo.rows, [{ chatId: '15551234567', displayName: 'Jane', fields: { name: 'Jane', order: 'A-1001' } }], 'rows are mapped snake_case → camelCase');
	assert.equal(batch.echo.batchName, 'Delay notice', 'batch_name maps to batchName');
	assert.equal(batch.echo.scheduledAt, Date.parse('2026-07-10T14:30:00Z'), 'an ISO scheduled_at becomes a unix-ms scheduledAt');

	// Bulk import is OFF by default: its 403 is a product gate, and the agent must
	// be told to ask the user — not to rebuild its API key, and not to loop sends.
	const disabled = await client.callTool({ name: 'whatsapp_queue_import', arguments: { batch_name: '__DISABLED__', template: 'x', rows: [{ chat_id: '15551234567' }] } });
	assert.ok(disabled.isError, 'a disabled bulk import surfaces as a tool error');
	assert.match(JSON.stringify(disabled), /Batch sending is turned off/, 'the server’s own instruction reaches the agent');
	assert.doesNotMatch(JSON.stringify(disabled), /scope/, 'a 403 product gate is not mistaken for a missing API-key scope');

	const cancelledBatch = await client.callTool({ name: 'whatsapp_cancel_batch', arguments: { batch_id: 'batch_1' } });
	assert.equal(payload(cancelledBatch).cancelled, 3, 'cancel_batch stops everything still pending');
	const retriedBatch = await client.callTool({ name: 'whatsapp_retry_batch', arguments: { batch_id: 'batch_1' } });
	assert.equal(payload(retriedBatch).retried, 2, 'retry_batch re-queues the failures');

	// ── Native MCP prompts ───────────────────────────────────────────────────
	// The seed prompt is served over `prompts/list` + `prompts/get` so a client
	// can load it as its system prompt. Assert it interpolates rather than
	// shipping raw {{PLACEHOLDER}} text to an agent.
	const { prompts } = await client.listPrompts();
	assert.equal(prompts.length, 1, 'exposes the agent seed prompt');
	assert.equal(prompts[0].name, 'socialmate_human_agent');

	const filled = await client.getPrompt({
		name: 'socialmate_human_agent',
		arguments: { business_name: 'Northwind Coffee', business_description: 'specialty roastery', tone: 'brisk' },
	});
	const text = filled.messages[0].content.text;
	assert.ok(text.includes('Northwind Coffee'), 'business name interpolated');
	assert.ok(text.includes('specialty roastery'), 'description interpolated');
	assert.ok(text.includes('brisk'), 'tone interpolated');
	assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'no unfilled placeholders leak to the agent');
	// The prompt must teach the hard limits, or an agent will hallucinate them.
	for (const claim of ['no inbound push', 'signal_rate_limit', 'queueable', 'deprecated', 'Never claim to be a human']) {
		assert.ok(text.includes(claim), `prompt states: ${claim}`);
	}
	// …and it must not teach a tool that does not exist, or send the agent down a
	// path the catalog can't serve. The bulk worked example used to say "queue_message
	// each one" — i.e. 200 calls — which is the exact anti-pattern it warns against.
	assert.ok(text.includes('whatsapp_queue_import'), 'prompt names the bulk primitive');
	assert.ok(text.includes('whatsapp_get_media'), 'prompt names the tool that makes the vision loop possible');
	for (const named of text.matchAll(/`(whatsapp_[a-z_]+)`/g)) {
		assert.ok(tools.find((t) => t.name === named[1]), `the prompt tells the agent to call ${named[1]}, which is not in the catalog`);
	}

	const bare = await client.getPrompt({ name: 'socialmate_human_agent', arguments: {} });
	assert.ok(bare.messages[0].content.text.includes('{{BUSINESS_NAME}}'), 'unset business name stays a visible slot');

	await client.close();
	await mock.close();
});
