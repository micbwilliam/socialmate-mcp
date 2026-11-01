import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Startup behaviour (before any tool call): a bad API key is refused with a
 * pointer to where a real one comes from, the reported server version tracks
 * package.json, and the /health probe warns — on stderr only, never fatally —
 * when the app's API server is not reachable.
 */

const ENTRY = fileURLToPath(new URL('./index.mjs', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Run the server to exit with no client attached; resolves { code, stdout, stderr }. */
function runToExit(env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		child.on('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

function startHealthMock(handler) {
	const server = createServer(handler);
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

/** A port nothing listens on: bind one, then release it. */
async function deadUrl() {
	const m = await startHealthMock(() => {});
	await m.close();
	return m.url;
}

/** Connect an MCP client with stderr captured; returns the client, transport and a stderr getter. */
async function connect(env) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { ...process.env, ...env }, stderr: 'pipe' });
	let stderr = '';
	transport.stderr.on('data', (c) => (stderr += c));
	const client = new Client({ name: 'startup-test', version: '1.0.0' });
	await client.connect(transport);
	return { client, getStderr: () => stderr };
}

async function waitFor(predicate, ms = 4000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return predicate();
}

for (const [label, key, expect] of [
	['missing', '', /SOCIALMATE_API_KEY is required/],
	['the documented placeholder', 'sm_paste_your_api_key_here', /still the placeholder "sm_paste_your_api_key_here"/],
	['the website one-liner placeholder', 'sm_xxx', /still the placeholder "sm_xxx"/],
	['not sm_-prefixed', 'sk-live-123', /starts with "sm_"/],
]) {
	test(`a ${label} API key exits 2 with a create-key hint on stderr and nothing on stdout`, async () => {
		const { code, stdout, stderr } = await runToExit({ SOCIALMATE_API_KEY: key, SOCIALMATE_BASE_URL: 'http://127.0.0.1:9' });
		assert.equal(code, 2);
		assert.equal(stdout, '', 'stdout is the MCP channel and must stay clean');
		assert.match(stderr, expect);
		assert.match(stderr, /API & Integrations → MCP → "Create key & copy config"/);
	});
}

/** The real /health answer, captured from SM4's createApiServer (enveloped, no opt-out header). */
const HEALTH = JSON.parse(readFileSync(new URL('./test/fixtures/sm4-api-envelopes.json', import.meta.url), 'utf8')).health;

/**
 * Two healthy servers: the real app (envelopes unless the caller pins the legacy
 * shape with X-SocialMate-Envelope: v1, exactly like api-server.ts's onSend hook)
 * and one that always envelopes. Before 1.3.0's fix the probe read `body.app` off
 * the enveloped answer and warned "not reachable" on every healthy install.
 */
for (const [label, honoursOptOut] of [
	['the real app (honours the envelope opt-out)', true],
	['an app that always envelopes /health', false],
]) {
	test(`server version comes from package.json, and a healthy app prints no warning — ${label}`, async () => {
		const mock = await startHealthMock((req, res) => {
			if (req.url !== '/health') {
				res.writeHead(404, { 'content-type': 'application/json' });
				return res.end('{}');
			}
			const optedOut = req.headers['x-socialmate-envelope'] === 'v1';
			res.writeHead(HEALTH.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(honoursOptOut && optedOut ? HEALTH.body.data : HEALTH.body));
		});
		const { client, getStderr } = await connect({ SOCIALMATE_API_KEY: 'sm_test-key', SOCIALMATE_BASE_URL: mock.url });
		try {
			assert.equal(client.getServerVersion()?.version, PKG.version);
			assert.ok(await waitFor(() => getStderr().includes(`using ${mock.url}`)), 'startup line printed');
			// Give the probe time to finish, then assert it stayed quiet.
			await new Promise((r) => setTimeout(r, 300));
			assert.doesNotMatch(getStderr(), /not reachable/);
		} finally {
			await client.close();
			await mock.close();
		}
	});
}

test('an unreachable API server warns on stderr but the server still starts and serves tools', async () => {
	const url = await deadUrl();
	const { client, getStderr } = await connect({ SOCIALMATE_API_KEY: 'sm_test-key', SOCIALMATE_BASE_URL: url });
	try {
		assert.ok(await waitFor(() => /not reachable/.test(getStderr())), `expected a reachability warning, got: ${getStderr()}`);
		assert.match(getStderr(), new RegExp(`SocialMate API not reachable at ${url}/health`));
		assert.match(getStderr(), /API & Integrations shows the local API running \(creating a key turns it on\), or check SOCIALMATE_BASE_URL/);
		const { tools } = await client.listTools();
		assert.ok(tools.length > 0, 'tools are still listed');
	} finally {
		await client.close();
	}
});

test('a non-SocialMate answer on /health also warns', async () => {
	const mock = await startHealthMock((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html>some other app</html>');
	});
	const { client, getStderr } = await connect({ SOCIALMATE_API_KEY: 'sm_test-key', SOCIALMATE_BASE_URL: mock.url });
	try {
		assert.ok(await waitFor(() => /something other than SocialMate answered/.test(getStderr())));
	} finally {
		await client.close();
		await mock.close();
	}
});
