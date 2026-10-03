import { z } from 'zod';

/**
 * The SocialMate MCP tool catalog.
 *
 * Each tool is a thin, well-described translator over the SocialMate REST API —
 * it builds a { method, path, body, qs } request that the server executes
 * through the SAME auth → scope → tier-gate → anti-ban → audit pipeline a real
 * client hits. Zero business logic lives here; the app stays the source of
 * truth. Descriptions follow the tool-writing bar (third person, what it
 * returns, when NOT to use) so any LLM selects the right tool reliably.
 *
 * `account` tools take an optional `account_id`; when omitted the server
 * auto-resolves it if the API key is scoped to exactly one account.
 */

const chatId = z
	.string()
	.describe(
		'Recipient WhatsApp id: a phone number in full international format including country code (a leading +, spaces, dashes and a 00 prefix are all accepted, e.g. "+1 415 555 1234" or "14155551234"), OR a group id/JID ending in @g.us. A national number without a country code will not resolve.',
	);

const accountId = z
	.string()
	.optional()
	.describe('SocialMate account id to act on (from whatsapp_list_accounts). Omit to use the only account the API key is scoped to.');

const groupId = z.string().describe('The target group id/JID ending in @g.us (from whatsapp_list_groups).');
const itemId = z.string().describe('A queued item id (from whatsapp_list_queue).');
const batchId = z.string().describe('A queue batch id (from whatsapp_list_batches, or the batch returned by whatsapp_queue_import).');
const mediaId = z.string().describe('A media id (from whatsapp_list_media, or a message\'s media.id).');

const replyTo = z
	.string()
	.optional()
	.describe('Optional id of an existing message to quote, so this send appears as a threaded reply to it.');

const targetMessageId = z
	.string()
	.describe('Id of the target message (from whatsapp_fetch_new_messages, whatsapp_search_messages, or a previous send result).');

const agentIdArg = z.string().describe('The id of one of SocialMate\'s own WhatsApp agents (from whatsapp_agent_list).');

const agentChatId = z
	.string()
	.describe(
		'The chat\'s full WhatsApp id (JID) exactly as SocialMate reports it — the `chatId` from whatsapp_agent_list_handoffs or whatsapp_agent_list_approvals, or a chat `id` from whatsapp_list_chats. Not a bare phone number: the agent\'s per-chat state is keyed on this exact id.',
	);

/**
 * `binary: true` marks a tool whose endpoint answers with bytes, not JSON — the
 * result is returned to the client as an MCP image content block so a vision
 * model can actually look at it.
 *
 * @type {Array<{name:string,description:string,inputSchema:Record<string,any>,accountScoped:boolean,binary?:boolean,build:(a:any)=>{method:string,path:string,body?:any,qs?:any}}>}
 */
export const TOOLS = [
	{
		name: 'whatsapp_list_accounts',
		description:
			'Lists the WhatsApp accounts this API key can use, with each account\'s id and live connection state. Call this first if you have more than one account, then pass an account_id to the other tools. Returns an array of accounts.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/accounts' }),
	},
	{
		name: 'whatsapp_send_message',
		description:
			'Sends a WhatsApp text message to one chat. Returns { sent: true, messageId, chatId, timestamp, status }. Read `status` — but know what it means: at send time it is only "pending"/"sent", i.e. the message was handed to WhatsApp, NOT that it arrived. It advances to "delivered" (it reached their phone) and then "read" (they opened it) later. So never tell anyone a message was delivered on the strength of this result. Learn the real outcome either from the `message.delivered` / `message.read` webhooks (they carry messageId + status, via the n8n Trigger or your own receiver — MCP has no inbound push), or by re-reading the row later with whatsapp_fetch_new_messages / whatsapp_search_messages, whose `status` is current. Keep the returned messageId: it is what every receipt correlates on, and what reply_to / whatsapp_react_message target. This is the primary way to reply to or notify a person or group. Set reply_to to quote a specific message. Use whatsapp_send_media for files and whatsapp_send_poll to ask a multiple-choice question. Never loop this over a list of recipients — that is the pattern that gets numbers banned; use whatsapp_queue_message to schedule one message for later, or whatsapp_queue_import when several people who are already waiting on you need the same news. If anti-ban blocks the send you get a { blocked, reason } result — back off or upgrade to Pro to auto-queue.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			text: z.string().min(1).max(4096).describe('The message text to send (1–4096 characters).'),
			reply_to: replyTo,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages`,
			body: { chatId: a.chat_id, text: a.text, ...(a.reply_to ? { replyTo: a.reply_to } : {}) },
		}),
	},
	{
		name: 'whatsapp_send_media',
		description:
			'Sends an image, video, audio, document or sticker to a chat from a public https URL, with an optional caption. Returns { sent: true, messageId, chatId, type, timestamp, status }. As with every send, `status` is the send-time state ("sent" = handed to WhatsApp, not proof it arrived) — the real outcome arrives later on the `message.delivered` / `message.read` webhooks, or by re-reading the row with whatsapp_fetch_new_messages / whatsapp_search_messages. Use whatsapp_send_message for plain text. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			type: z.enum(['image', 'video', 'audio', 'document', 'sticker']).describe('The kind of media being sent.'),
			url: z.string().url().describe('Public https URL of the file to send; the server fetches it.'),
			caption: z.string().max(4096).optional().describe('Optional caption shown with the media.'),
			reply_to: replyTo,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages`,
			body: {
				chatId: a.chat_id,
				media: { type: a.type, url: a.url, ...(a.caption ? { caption: a.caption } : {}) },
				...(a.reply_to ? { replyTo: a.reply_to } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_send_poll',
		description:
			'Sends a multiple-choice poll to a chat. Returns { sent: true, messageId, chatId, type, timestamp, status } — keep `messageId`, it is what whatsapp_get_poll_results reads the votes back with. `status` is the send-time state ("sent" = handed to WhatsApp, not proof it arrived); delivery/read come later on the `message.delivered` / `message.read` webhooks. Use a poll instead of asking an open question when you need a structured answer — WhatsApp renders tappable options. Votes are NOT pushed back to you here: read them with whatsapp_get_poll_results, or bridge the `poll.vote` webhook via the SocialMate Trigger (MCP cannot receive pushes). Only polls sent by this account can have their votes decrypted. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			name: z.string().min(1).max(255).describe('The poll question.'),
			options: z.array(z.string().min(1).max(100)).min(2).max(12).describe('Between 2 and 12 answer options.'),
			selectable_count: z.number().int().min(1).max(12).optional().describe('How many options a voter may pick. Defaults to 1 (single-select).'),
			reply_to: replyTo,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages`,
			body: {
				chatId: a.chat_id,
				poll: { name: a.name, options: a.options, ...(a.selectable_count ? { selectableCount: a.selectable_count } : {}) },
				...(a.reply_to ? { replyTo: a.reply_to } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_send_location',
		description:
			'Sends a location pin (latitude/longitude, with an optional place name and address) to a chat. Use this for directions, meeting points, or delivery addresses — the recipient can tap it to open maps. Returns { sent: true, messageId, chatId, type, timestamp, status }; `status` is the send-time state ("sent" = handed to WhatsApp, not proof it arrived), with delivery/read arriving later on the `message.delivered` / `message.read` webhooks. Never guess coordinates — a wrong pin sends a real person to the wrong place; if you do not have the exact latitude/longitude, send the address as text instead. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
			longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
			name: z.string().max(255).optional().describe('Optional place name shown on the pin.'),
			address: z.string().max(512).optional().describe('Optional street address shown under the pin.'),
			reply_to: replyTo,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages`,
			body: {
				chatId: a.chat_id,
				location: {
					latitude: a.latitude,
					longitude: a.longitude,
					...(a.name ? { name: a.name } : {}),
					...(a.address ? { address: a.address } : {}),
				},
				...(a.reply_to ? { replyTo: a.reply_to } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_send_contact',
		description:
			'Sends one or more contact cards (vCards) to a chat, so the recipient can tap to save or message them. Use this to hand off a lead to a colleague or share a support number. Returns { sent: true, messageId, chatId, type, timestamp, status }; `status` is the send-time state ("sent" = handed to WhatsApp, not proof it arrived), with delivery/read arriving later on the `message.delivered` / `message.read` webhooks. Only share a number the person is entitled to have — never pass one customer\'s contact details to another. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			contacts: z
				.array(
					z.object({
						full_name: z.string().min(1).max(255).describe('Display name on the card.'),
						phone: z.string().min(5).max(32).describe('Phone number in full international format including country code.'),
						organization: z.string().max(255).optional().describe('Optional company name.'),
					}),
				)
				.min(1)
				.max(10)
				.describe('Between 1 and 10 contact cards to send.'),
			reply_to: replyTo,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages`,
			body: {
				chatId: a.chat_id,
				contacts: a.contacts.map((c) => ({
					fullName: c.full_name,
					phone: c.phone,
					...(c.organization ? { organization: c.organization } : {}),
				})),
				...(a.reply_to ? { replyTo: a.reply_to } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_react_message',
		description:
			'Reacts to a message with a single emoji, or removes your reaction by passing an empty string. WhatsApp allows one reaction per sender per message, so a new emoji replaces your previous one. Use this to acknowledge a message cheaply instead of sending a reply. Available on every tier: reactions consume no message-send budget and do not raise the anti-ban risk score.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			message_id: targetMessageId,
			emoji: z.string().max(8).describe('A single emoji, e.g. "👍". Pass an empty string "" to remove your existing reaction.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages/${encodeURIComponent(a.message_id)}/reaction`,
			body: { chatId: a.chat_id, emoji: a.emoji },
		}),
	},
	{
		name: 'whatsapp_mark_read',
		description:
			'Marks a chat as read, showing the sender blue ticks. Omit message_ids to acknowledge every unread message in the chat. Call this once you have handled someone\'s message so they know it landed. Available on every tier: read receipts consume no message-send budget.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			message_ids: z.array(z.string()).max(100).optional().describe('Optional specific message ids to acknowledge. Omit to mark the whole chat read.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/messages/read`,
			body: { chatId: a.chat_id, ...(a.message_ids ? { messageIds: a.message_ids } : {}) },
		}),
	},
	{
		name: 'whatsapp_send_typing',
		description:
			'Shows or clears a "typing…" / "recording audio…" indicator in a chat. Send "composing" before a slow reply so the contact sees you are responding, then send the message. WhatsApp expires the indicator after about 10 seconds. Pass "paused" to clear it. Available on every tier: presence consumes no message-send budget.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			state: z.enum(['composing', 'recording', 'paused']).describe('"composing" = typing, "recording" = recording a voice note, "paused" = clear the indicator.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/presence`,
			body: { chatId: a.chat_id, state: a.state },
		}),
	},
	{
		name: 'whatsapp_get_poll_results',
		description:
			'Reads back the results of a poll you sent: every option, how many people picked each one, and who voted for what. Call this after sending a poll to find out whether it was answered — polls are not delivered back to you automatically. Re-voting replaces a person\'s earlier choice, so the counts never double-count anyone, and an option nobody picked is still listed with a count of 0. Pass the message_id you got back when you sent the poll. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			message_id: targetMessageId,
		},
		accountScoped: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/polls/${encodeURIComponent(a.message_id)}`,
		}),
	},
	{
		name: 'whatsapp_get_ai_context',
		description:
			'Returns a chat\'s recent history as a role-mapped, token-windowed transcript (the contact = user, your account = assistant), ready to use as conversation memory before you reply. This is the recommended way to recall a thread — call it before answering a returning contact. Emoji reactions a message drew, and the results of any poll, are rendered into the turns, so you see how people responded and not just what was said; media that a vision model already described (whatsapp_set_media_context) reads inline as "[image: <what it shows>]". Returns { transcript, meta, account, chat } — `transcript` is the rendered thread and `meta` reports the window it fitted ({ totalMessages, returnedMessages, truncated, tokenEstimate }). It also returns an EMPTY `messages: []`: this tool asks the API for the transcript rendering, so the structured rows are not populated — an empty `messages` does NOT mean an empty chat, read `transcript`. The transcript carries no delivery status: to learn whether a message you sent was delivered or read, use whatsapp_search_messages or whatsapp_fetch_new_messages (every row has a `status`), or subscribe to the `message.delivered` / `message.read` webhooks. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			max_messages: z.number().int().min(1).max(500).optional().describe('How many recent messages to include (default 50).'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/ai-context`,
			qs: { chatId: a.chat_id, format: 'transcript', order: 'newest', ...(a.max_messages ? { maxMessages: a.max_messages } : {}) },
		}),
	},
	{
		// Deprecated alias for whatsapp_get_ai_context — kept so existing agent
		// configs keep working. Prefer the ai_context name (clearer intent).
		name: 'whatsapp_get_conversation',
		description:
			'Deprecated alias of whatsapp_get_ai_context — returns a chat\'s recent history as a role-mapped, token-windowed transcript for use as conversation memory. Prefer whatsapp_get_ai_context in new agents. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			max_messages: z.number().int().min(1).max(500).optional().describe('How many recent messages to include (default 50).'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/ai-context`,
			qs: { chatId: a.chat_id, format: 'transcript', order: 'newest', ...(a.max_messages ? { maxMessages: a.max_messages } : {}) },
		}),
	},
	{
		name: 'whatsapp_fetch_new_messages',
		description:
			'Returns messages that arrived AFTER a given timestamp cursor — the poll a pure-MCP agent uses to detect new WhatsApp messages, since MCP has no inbound push. Pass the newest timestamp you have already seen as `since`; the first call omits it to get the recent tail. Returns { data, pagination }, where each row is { id, chatId, body, type, fromMe, status, hasMedia, timestamp, media }, newest first — track the largest `timestamp` and pass it back as `since` next time. Every row also carries its current `status` ("pending" → "sent" → "delivered" → "read"), so the same poll that finds new inbound messages also tells you whether the messages YOU sent have since been delivered or read: read it from the row rather than asking a human. For automatic (event-driven) reactions instead of polling, drive the loop from the SocialMate Trigger in n8n or a webhook to your own code — `message.received` for arrivals, `message.delivered` / `message.read` for receipts on what you sent. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			since: z.number().int().optional().describe('Unix-ms timestamp cursor: only messages strictly after this are returned. Omit on the first call to get the most recent messages, then pass the largest timestamp you saw.'),
			chat_id: z.string().optional().describe('Restrict to one chat (a phone number or a @g.us group JID). Omit to poll across all chats.'),
			limit: z.number().int().min(1).max(200).optional().describe('Max messages to return (default 50).'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/messages`,
			qs: { ...(a.since ? { afterTs: a.since } : {}), ...(a.chat_id ? { chatId: a.chat_id } : {}), limit: a.limit ?? 50 },
		}),
	},
	{
		name: 'whatsapp_search_messages',
		description:
			'Reads raw stored message rows for the account, optionally restricted to one chat and/or full-text searched. Returns { data, pagination }, where each row is { id, chatId, body, type, fromMe, status, hasMedia, timestamp, media }. `status` is that message\'s CURRENT delivery state — "pending" → "sent" → "delivered" (it reached their phone) → "read" (they opened it) — so this is how you check whether something you sent actually landed WITHOUT asking a human and without waiting on a webhook. Use it to find or count specific messages, or to confirm a delivery. To load conversation memory before replying, use whatsapp_get_ai_context instead — it returns a role-mapped transcript, where this returns raw rows. To detect messages that arrived since a timestamp, use whatsapp_fetch_new_messages. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: z.string().optional().describe('Restrict the search to one chat (a phone number or a @g.us group JID). Omit to search all chats.'),
			search: z.string().optional().describe('Full-text query to match message bodies. Omit to just list recent messages.'),
			limit: z.number().int().min(1).max(200).optional().describe('Max messages to return (default 50).'),
		},
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/messages`, qs: { ...(a.chat_id ? { chatId: a.chat_id } : {}), ...(a.search ? { search: a.search } : {}), limit: a.limit ?? 50 } }),
	},
	{
		name: 'whatsapp_list_media',
		description:
			'Lists the media stored for the account — images, videos, voice notes, documents, stickers — newest first, with each item\'s id, type, chat, caption, size, download state and whether it already carries an agent description (`aiContext` / `needsContext`). This is step 1 of the vision loop: pass has_context=false for the "what have I not looked at yet?" sweep, fetch each one with whatsapp_get_media, then cache what you saw with whatsapp_set_media_context. Returns { data, pagination }. Do not call this just to read a conversation — whatsapp_get_ai_context already renders described media inline in the transcript.',
		inputSchema: {
			account_id: accountId,
			chat_id: z.string().optional().describe('Restrict to one chat (a phone number or a @g.us group JID). Omit for all chats.'),
			type: z.enum(['image', 'video', 'audio', 'voice', 'document', 'sticker', 'all']).optional().describe('Media kind filter ("voice" = PTT voice notes). Defaults to all.'),
			state: z
				.enum(['pending', 'queued', 'downloading', 'downloaded', 'failed', 'skipped', 'expired', 'deleted', 'all'])
				.optional()
				.describe('Download-lifecycle filter. Defaults to all.'),
			direction: z.enum(['received', 'sent', 'all']).optional().describe('Inbound vs outbound media. Defaults to all.'),
			has_context: z
				.boolean()
				.optional()
				.describe('Agent Memory filter: false = only media still needing a description (your "what to analyze next" sweep), true = only media you have already described. Omit for both.'),
			search: z.string().optional().describe('Match on filename or caption.'),
			sort: z.enum(['newest', 'oldest', 'biggest', 'smallest']).optional().describe('Ordering (default newest).'),
			pinned_only: z.boolean().optional().describe('Only items pinned in the app.'),
			downloaded_only: z.boolean().optional().describe('Only items already downloaded to disk.'),
			limit: z.number().int().min(1).max(500).optional().describe('Page size (default 100).'),
			offset: z.number().int().min(0).max(100_000).optional().describe('Rows to skip, for paging.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/media`,
			qs: {
				...(a.chat_id ? { chatId: a.chat_id } : {}),
				...(a.type ? { type: a.type } : {}),
				...(a.state ? { state: a.state } : {}),
				...(a.direction ? { direction: a.direction } : {}),
				...(a.has_context !== undefined ? { hasContext: a.has_context } : {}),
				...(a.search ? { search: a.search } : {}),
				...(a.sort ? { sort: a.sort } : {}),
				...(a.pinned_only !== undefined ? { pinnedOnly: a.pinned_only } : {}),
				...(a.downloaded_only !== undefined ? { downloadedOnly: a.downloaded_only } : {}),
				limit: a.limit ?? 100,
				...(a.offset !== undefined ? { offset: a.offset } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_get_media',
		description:
			'Returns a media item AS AN IMAGE, so you can actually look at it with your own vision model — a JPEG preview of the photo, video frame or sticker. This is step 2 of the vision loop: fetch anything whose `needsContext` is true, describe what you see, then save that description with whatsapp_set_media_context so it is never analyzed twice. What you get back is a preview-resolution thumbnail, not the original file: enough to see what a photo IS, not to read fine print. Voice notes and most documents have no thumbnail and return 404 — work from their caption, or pull the original bytes over the HTTP API (GET /v1/accounts/{id}/media/{mediaId}/file), which is deliberately not exposed over MCP.',
		inputSchema: { account_id: accountId, media_id: mediaId },
		accountScoped: true,
		// Binary route: the result is an MCP image content block, not JSON.
		binary: true,
		build: (a) => ({
			method: 'GET',
			path: `/v1/accounts/${a._account}/media/${encodeURIComponent(a.media_id)}/thumbnail`,
		}),
	},
	{
		name: 'whatsapp_set_media_context',
		description:
			'Caches the description or transcript YOU produced for a media item (image, video, voice note, document) so the same media is never re-analyzed (Agent Memory). This is step 3 of the vision loop: find the media with whatsapp_list_media (has_context=false), look at it with whatsapp_get_media, then save the result here — it comes back already described inside whatsapp_get_ai_context, saving tokens and re-processing on every future pass. The media id also arrives on a message\'s `media.id` (webhook / transcript); an item whose `needsContext` is already false does not need this. SocialMate stores your description; it never generates one. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			media_id: mediaId,
			context: z.string().min(1).max(16384).describe('The description/transcript your model produced for this media.'),
			source: z.string().max(128).optional().describe('What produced the context, e.g. "gpt-4o", "whisper-1".'),
			overwrite: z.boolean().optional().describe('Set false to refuse (409) when context already exists. Defaults to true (replace).'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'PUT',
			path: `/v1/accounts/${a._account}/media/${encodeURIComponent(a.media_id)}/context`,
			body: { context: a.context, ...(a.source ? { source: a.source } : {}), ...(a.overwrite !== undefined ? { overwrite: a.overwrite } : {}) },
		}),
	},
	{
		name: 'whatsapp_list_chats',
		description:
			'Lists every chat (1:1, group and broadcast) on the account. Returns each chat\'s id, name, type and unread count. Use it to discover conversations and to get a chat id to message. It does not return any messages: to READ a chat, use whatsapp_get_ai_context (a role-mapped transcript, for recalling a thread before you reply) or whatsapp_search_messages (raw rows, each carrying its delivery `status`). Available on every tier.',
		inputSchema: { account_id: accountId },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/chats` }),
	},
	{
		name: 'whatsapp_list_contacts',
		description:
			'Finds WhatsApp contacts by name, phone or JID (or lists them). Returns each contact\'s id, name, phone and JID. Use to look up who to message; pass a returned phone or JID as chat_id to whatsapp_send_message.',
		inputSchema: {
			account_id: accountId,
			search: z.string().optional().describe('Match contacts whose name, phone or JID contains this text. Omit to list contacts.'),
			limit: z.number().int().min(1).max(200).optional().describe('Max contacts to return (default 25).'),
		},
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/contacts`, qs: { ...(a.search ? { search: a.search } : {}), limit: a.limit ?? 25 } }),
	},
	{
		name: 'whatsapp_list_groups',
		description:
			'Lists every WhatsApp group the account belongs to. Returns each group\'s id (a @g.us JID), subject and size. Use a returned id to message a group or with the group-management tools.',
		inputSchema: { account_id: accountId },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/groups` }),
	},
	{
		name: 'whatsapp_create_group',
		description:
			'Creates a new WhatsApp group with a subject and its founding participants. Returns the new group as { id, subject } — `id` is the @g.us JID you pass to every other group tool and to whatsapp_send_message. The account becomes the group\'s admin. Do NOT use a group as a way to reach several people at once: a group exposes every member\'s number to every other member, and adding people who did not ask to be there is the fastest way to get a number reported. When several people who are already waiting on you need the same news, send them individual, personalised, paced messages with whatsapp_queue_import instead. Add only people who asked to be in this group; otherwise create it and send them the join link from whatsapp_get_group_invite. Change the roster afterwards with whatsapp_update_group_participants. Requires SocialMate Pro (`apiWriteEnabled`) and an API key with the `admin` scope; fails 409 if the account is not connected.',
		inputSchema: {
			account_id: accountId,
			name: z.string().min(1).max(100).describe('The group subject/name (1–100 characters).'),
			participants: z.array(z.string()).min(1).describe('Phone numbers (full international format) or JIDs to add as founding members.'),
		},
		accountScoped: true,
		build: (a) => ({ method: 'POST', path: `/v1/accounts/${a._account}/groups`, body: { name: a.name, participants: a.participants } }),
	},
	{
		name: 'whatsapp_update_group_participants',
		description:
			'Adds, removes, promotes (to admin) or demotes members of a group. Returns only { success: true } — it is NOT a per-number report, so it does not tell you which numbers actually changed. WhatsApp silently ignores a number it will not add (one whose privacy settings forbid being added, or that has no WhatsApp account), so if the outcome matters, verify the roster afterwards with whatsapp_get_group. Never add a person who has not asked to join: unsolicited group adds are how numbers get reported and banned — send them the join link from whatsapp_get_group_invite and let them tap it. "remove" ejects SOMEONE ELSE; to make the account itself leave, use whatsapp_leave_group. Requires SocialMate Pro (`apiWriteEnabled`), an API key with the `admin` scope, AND the account must be an admin of that group; fails 409 if the account is not connected.',
		inputSchema: {
			account_id: accountId,
			group_id: z.string().describe('The target group id/JID ending in @g.us (from whatsapp_list_groups).'),
			participants: z.array(z.string()).min(1).describe('Phone numbers or JIDs to act on.'),
			action: z.enum(['add', 'remove', 'promote', 'demote']).describe('What to do with the listed participants.'),
		},
		accountScoped: true,
		build: (a) => ({ method: 'POST', path: `/v1/accounts/${a._account}/groups/${a.group_id}/participants`, body: { participants: a.participants, action: a.action } }),
	},
	{
		name: 'whatsapp_queue_message',
		description:
			'Queues one text message to send later — optionally at a scheduled time — drained safely by the anti-ban engine. Returns the queued item id. Use for reminders, follow-ups and scheduled sends; for an immediate reply use whatsapp_send_message. Requires SocialMate Pro.',
		inputSchema: {
			account_id: accountId,
			chat_id: chatId,
			content: z.string().min(1).max(4096).describe('The message text to queue.'),
			scheduled_at: z.string().optional().describe('ISO-8601 date-time to send at (e.g. 2026-07-10T14:30:00Z). Omit to send as soon as anti-ban allows.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/queue/items`,
			body: { chatId: a.chat_id, content: a.content, ...(a.scheduled_at ? { scheduledAt: Date.parse(a.scheduled_at) || undefined } : {}) },
		}),
	},
	{
		name: 'whatsapp_queue_import',
		description:
			'Queues one batch for people who are ALREADY WAITING ON YOU: when several of them need the same news — an order delay, a new pickup time — one call creates one batch from a {{field}} template plus up to 5000 rows, and each row becomes an individual, personalised message, still sent one by one through the anti-ban pipeline. Returns { batch, itemCount } — track it with whatsapp_list_batches, stop it with whatsapp_cancel_batch. Only for people who contacted the user or explicitly opted in; never a list that was bought, scraped or guessed. This is not a broadcast and SocialMate is not a broadcast tool: identical text to many contacts trips the duplicate-content guard, so personalise every row. Never loop whatsapp_send_message or whatsapp_queue_message over a list instead — that is the exact pattern that gets a number banned. Use whatsapp_queue_message for a single scheduled message. Requires SocialMate Pro AND batch sending to be switched on by the user — it is OFF by default and returns 403 bulk_import_disabled until they enable it (Settings → Advanced → "Enable batch sending"). Do not work around that 403.',
		inputSchema: {
			account_id: accountId,
			template: z
				.string()
				.min(1)
				.max(4096)
				.describe('Message template. {{field}} placeholders are filled per row from that row\'s fields, e.g. "Hi {{name}}, your order {{order}} is delayed."'),
			batch_name: z.string().min(1).max(256).describe('Human label for the batch, shown in the app and in whatsapp_list_batches.'),
			rows: z
				.array(
					z.object({
						chat_id: chatId,
						display_name: z.string().max(256).optional().describe('Friendly name for the live feed / logs.'),
						fields: z.record(z.string()).optional().describe('Values for this row\'s {{placeholders}}, e.g. { "name": "Jane", "order": "A-1001" }.'),
					}),
				)
				.min(1)
				.max(5000)
				.describe('The recipients, 1–5000. Each row supplies its own placeholder values.'),
			scheduled_at: z.string().optional().describe('ISO-8601 date-time to start the batch (e.g. 2026-07-10T14:30:00Z). Anti-ban still paces it. Omit to start as soon as allowed.'),
			priority: z.number().int().min(0).max(3).optional().describe('Queue priority, 0 (lowest) to 3 (highest). Defaults to 2.'),
			max_retries: z.number().int().min(0).max(10).optional().describe('Retries per item before it is marked failed. Defaults to 3.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'POST',
			path: `/v1/accounts/${a._account}/queue/import`,
			body: {
				template: a.template,
				batchName: a.batch_name,
				rows: a.rows.map((r) => ({
					chatId: r.chat_id,
					...(r.display_name ? { displayName: r.display_name } : {}),
					...(r.fields ? { fields: r.fields } : {}),
				})),
				...(a.scheduled_at ? { scheduledAt: Date.parse(a.scheduled_at) || undefined } : {}),
				...(a.priority !== undefined ? { priority: a.priority } : {}),
				...(a.max_retries !== undefined ? { maxRetries: a.max_retries } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_get_antiban_status',
		description:
			'Returns the account\'s live anti-ban state — call it BEFORE anything resembling a campaign, so you find out how much room is left instead of discovering it by getting blocked. Returns { accountId, riskLevel, riskScore, warmingDay, messagesToday, dailyLimit, paused, pauseScope, pauseReason, autoResumeAt, nightMode, warming, rateLimits }, where `rateLimits` is { perMinute, perHour, perDay, burst }, each a { current, max } pair — `max - current` is your remaining headroom in that window, and the tightest of the four is what will actually stop you. `riskLevel` / `riskScore` grade how much the recent send pattern looks like a spammer. `paused: true` means the engine has cooled the number down: `pauseReason` says why and `autoResumeAt` is when it lifts by itself — WAIT for it, never work around it, and never spend the remaining headroom just because it is there. `nightMode` means quiet hours are in force (sends are blocked; a person\'s phone should not buzz at 3am). `warming` describes a new number\'s ramp-up, which deliberately keeps early limits low. These numbers are advisory — the pipeline enforces them regardless of what you do with them. This is a read: it changes nothing and sends nothing. Available on every tier (read scope).',
		inputSchema: { account_id: accountId },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/antiban` }),
	},
	{
		name: 'whatsapp_get_contact',
		description:
			'Returns one contact\'s full details (name, phone, JID, profile info, plus any saved agent enrichment) by contact id or phone. Use after whatsapp_list_contacts when you need the complete record for a specific person.',
		inputSchema: { account_id: accountId, contact_id: z.string().describe('The contact id, phone number or JID to fetch (from whatsapp_list_contacts).') },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/contacts/${encodeURIComponent(a.contact_id)}` }),
	},
	{
		name: 'whatsapp_update_contact',
		description:
			'Saves what YOU learned about a contact — a custom name, notes, email, company, tags — into SocialMate\'s local store (Agent Memory). Use the moment you discover who an unknown/unnamed contact is, or a new detail while chatting: the name then shows in every future transcript and the app, so you never re-ask. Works even for a brand-new number (creates the contact). SocialMate STORES what you learned; it does not generate it. Requires SocialMate Pro. A provided field is saved, null clears it, an omitted field is left unchanged.',
		inputSchema: {
			account_id: accountId,
			contact_id: z.string().describe('The contact id from a message/webhook, or a plain phone number in full international format. A group id is rejected.'),
			custom_name: z.string().max(256).nullish().describe('Agent-set display name (e.g. "Jane (VIP)"). Wins the display label everywhere. null clears it.'),
			notes: z.string().max(4096).nullish().describe('Free-form notes about the contact. null clears.'),
			email: z.string().max(320).nullish().describe('Contact email. null clears.'),
			company: z.string().max(256).nullish().describe('Company / organization. null clears.'),
			tags: z.array(z.string().min(1).max(64)).max(32).nullish().describe('Up to 32 short tags, e.g. ["vip","lead"]. null clears all.'),
		},
		accountScoped: true,
		build: (a) => ({
			method: 'PATCH',
			path: `/v1/accounts/${a._account}/contacts/${encodeURIComponent(a.contact_id)}`,
			body: {
				...(a.custom_name !== undefined ? { customName: a.custom_name } : {}),
				...(a.notes !== undefined ? { notes: a.notes } : {}),
				...(a.email !== undefined ? { email: a.email } : {}),
				...(a.company !== undefined ? { company: a.company } : {}),
				...(a.tags !== undefined ? { tags: a.tags } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_get_group',
		description:
			'Returns one group\'s details: subject, description, participants and admin roles. Use after whatsapp_list_groups when you need the member list or metadata before managing the group.',
		inputSchema: { account_id: accountId, group_id: groupId },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/groups/${a.group_id}` }),
	},
	{
		name: 'whatsapp_set_group_subject',
		description:
			'Renames a group — sets the subject every member sees, in their chat list and as a system line in the conversation. Returns { success: true }. Because the rename is visible to everyone, never use the subject as a scratchpad, a status line or a way to pass a message: send a message. It replaces the name outright, so read the current one with whatsapp_get_group first if you mean to amend rather than overwrite. Use whatsapp_set_group_description for the longer description/topic instead. Requires SocialMate Pro (`apiWriteEnabled`), an API key with the `admin` scope, AND the account must be an admin of that group; fails 409 if the account is not connected.',
		inputSchema: { account_id: accountId, group_id: groupId, subject: z.string().min(1).max(100).describe('The new group name/subject (1–100 characters).') },
		accountScoped: true,
		build: (a) => ({ method: 'PUT', path: `/v1/accounts/${a._account}/groups/${a.group_id}/subject`, body: { subject: a.subject } }),
	},
	{
		name: 'whatsapp_set_group_description',
		description:
			'Sets a group\'s description — the longer topic text members read in the group\'s info panel (up to 512 characters; an empty string clears it). Returns { success: true }. It REPLACES the existing description rather than appending to it, so read the current text with whatsapp_get_group first if you mean to amend it, or you will silently destroy what was there. Members are notified that the description changed, so do not rewrite it repeatedly. Use whatsapp_set_group_subject to rename the group instead. Requires SocialMate Pro (`apiWriteEnabled`), an API key with the `admin` scope, AND the account must be an admin of that group; fails 409 if the account is not connected.',
		inputSchema: { account_id: accountId, group_id: groupId, description: z.string().max(512).describe('The new group description (up to 512 characters; empty clears it).') },
		accountScoped: true,
		build: (a) => ({ method: 'PUT', path: `/v1/accounts/${a._account}/groups/${a.group_id}/description`, body: { description: a.description } }),
	},
	{
		name: 'whatsapp_get_group_invite',
		description:
			'Returns a group\'s shareable invite link as { inviteCode, inviteLink } (inviteLink is https://chat.whatsapp.com/<code>). PREFER THIS over whatsapp_update_group_participants whenever you want someone to join: sending a link is consented and they choose to tap it, whereas adding a number outright is not, and unsolicited adds are how numbers get reported. It adds nobody by itself — the recipient must tap the link. Treat the link as a secret: anyone who holds it can join, so send it to the person who asked, never to a group or a public channel. The account must be an admin of that group (and once it has left the group it can no longer fetch this — get the link before whatsapp_leave_group, not after). Available on every tier (read scope); fails 409 if the account is not connected.',
		inputSchema: { account_id: accountId, group_id: groupId },
		accountScoped: true,
		build: (a) => ({ method: 'GET', path: `/v1/accounts/${a._account}/groups/${a.group_id}/invite` }),
	},
	{
		name: 'whatsapp_leave_group',
		description:
			'Makes the account itself leave a group. Returns { success: true }. Irreversible from your side: the account cannot re-join without a fresh invite, and it cannot fetch one after leaving (whatsapp_get_group_invite is an admin read, and you are no longer a member) — so if there is any chance of going back, get the link BEFORE you call this. If the account is the group\'s only admin, the group is left without one. Confirm the user actually wants to leave before calling; never leave a group to tidy up, to stop notifications or to end a conversation — to stop replying, simply stop replying. This removes YOU: to remove someone else, use whatsapp_update_group_participants with action "remove". Requires SocialMate Pro (`apiWriteEnabled`) and an API key with the `admin` scope; fails 409 if the account is not connected.',
		inputSchema: { account_id: accountId, group_id: groupId },
		accountScoped: true,
		build: (a) => ({ method: 'POST', path: `/v1/accounts/${a._account}/groups/${a.group_id}/leave` }),
	},
	{
		name: 'whatsapp_queue_status',
		description:
			'Returns the smart-queue\'s live state: how many messages are pending, processing, sent and failed, and whether the queue is paused. Call to check outbound backlog before or after queueing sends. Requires SocialMate Pro.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/queue/status' }),
	},
	{
		name: 'whatsapp_list_queue',
		description:
			'Lists queued messages, newest-relevant first, optionally filtered by account or status (pending, processing, sent, failed, cancelled). Returns queue items with their ids, target chats and scheduled times. Use to review or find an item to cancel/retry. Requires SocialMate Pro.',
		inputSchema: {
			account_id: z.string().optional().describe('Restrict to one account. Omit to list across all accounts the key can use.'),
			status: z.string().optional().describe('Filter by status: a single value or CSV (e.g. "pending,processing"). Omit for all.'),
			limit: z.number().int().min(1).max(500).optional().describe('Max items to return (default 100).'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: '/v1/queue/items', qs: { ...(a.account_id ? { accountId: a.account_id } : {}), ...(a.status ? { status: a.status } : {}), limit: a.limit ?? 100 } }),
	},
	{
		name: 'whatsapp_list_batches',
		description:
			'Lists smart-queue batches (each one a set of individual, personalised messages queued together by whatsapp_queue_import) with their progress counts. Use it to track a batch through to completion. Requires SocialMate Pro.',
		inputSchema: {
			account_id: z.string().optional().describe('Restrict to one account. Omit for all.'),
			status: z.enum(['active', 'completed', 'cancelled', 'paused']).optional().describe('Filter by batch status. Omit for all.'),
			limit: z.number().int().min(1).max(500).optional().describe('Max batches to return (default 50).'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: '/v1/queue/batches', qs: { ...(a.account_id ? { accountId: a.account_id } : {}), ...(a.status ? { status: a.status } : {}), limit: a.limit ?? 50 } }),
	},
	{
		name: 'whatsapp_cancel_queued',
		description:
			'Cancels a single pending queued message by its item id so it is never sent. Returns the cancelled item. Use to pull back a scheduled or backlogged send. Requires SocialMate Pro.',
		inputSchema: { item_id: itemId },
		accountScoped: false,
		build: (a) => ({ method: 'DELETE', path: `/v1/queue/items/${encodeURIComponent(a.item_id)}` }),
	},
	{
		name: 'whatsapp_retry_queued',
		description:
			'Re-queues a failed message by its item id for another send attempt. Returns the item. Use after fixing whatever caused a failure. Requires SocialMate Pro.',
		inputSchema: { item_id: itemId },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/queue/items/${encodeURIComponent(a.item_id)}/retry` }),
	},
	{
		name: 'whatsapp_cancel_batch',
		description:
			'Cancels a whole queue batch by its batch id: every item of it still pending is dropped and never sent. Returns how many were cancelled. Use this to pull back a batch you started with whatsapp_queue_import and got wrong — items already sent cannot be recalled. To stop the queue temporarily without discarding anything, use whatsapp_pause_queue; to drop one message, use whatsapp_cancel_queued. Requires SocialMate Pro.',
		inputSchema: { batch_id: batchId },
		accountScoped: false,
		build: (a) => ({ method: 'DELETE', path: `/v1/queue/batches/${encodeURIComponent(a.batch_id)}` }),
	},
	{
		name: 'whatsapp_retry_batch',
		description:
			'Re-queues every failed item in a batch for another send attempt. Returns how many were retried. Use after fixing whatever made them fail (e.g. the account reconnected). This does not resend items that already went out. To retry a single message, use whatsapp_retry_queued. Requires SocialMate Pro.',
		inputSchema: { batch_id: batchId },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/queue/batches/${encodeURIComponent(a.batch_id)}/retry` }),
	},
	{
		name: 'whatsapp_pause_queue',
		description:
			'Pauses the smart queue: queued and scheduled messages stop draining and nothing more goes out until whatsapp_resume_queue. Pass account_id to pause one account; omit it to pause every account. Returns { success: true, paused: true, accountId } (accountId is null on a global pause). This is a kill-switch, not a cancel — NOTHING is discarded: items stay queued and their scheduled times keep passing, so a long pause builds a backlog that fires as one overdue rush when you resume. If a message should never be sent, cancel it instead (whatsapp_cancel_queued for one item, whatsapp_cancel_batch for a whole batch). It does NOT stop whatsapp_send_message, which sends immediately and never touches the queue. The pause is held in memory, so restarting the SocialMate app clears it and the queue resumes on its own — do not rely on it as a durable stop. Check the backlog with whatsapp_queue_status. Requires SocialMate Pro (`scheduledMessages`) and an API key with the `admin` scope.',
		inputSchema: { account_id: z.string().optional().describe('Pause only this account\'s queue. Omit to pause globally.') },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: '/v1/queue/pause', body: { ...(a.account_id ? { accountId: a.account_id } : {}) } }),
	},
	{
		name: 'whatsapp_resume_queue',
		description:
			'Resumes a smart queue you paused with whatsapp_pause_queue, so queued messages start draining again. Pass account_id to resume one account; omit it to resume globally. Returns { success: true, paused: false, accountId } (accountId is null on a global resume). Everything that fell due during the pause is now overdue and will go out as fast as the anti-ban engine allows, so before resuming a long pause check whatsapp_queue_status for the backlog and cancel whatever is now stale (whatsapp_cancel_queued / whatsapp_cancel_batch) rather than letting a pile of late messages land at once. This only lifts an OPERATOR pause. It cannot un-pause an account the anti-ban engine cooled down itself (risk, warming or quiet hours): that lifts on its own — inspect it with whatsapp_get_antiban_status (`paused`, `pauseReason`, `autoResumeAt`) and wait, never try to force through it. Requires SocialMate Pro (`scheduledMessages`) and an API key with the `admin` scope.',
		inputSchema: { account_id: z.string().optional().describe('Resume only this account\'s queue. Omit to resume globally.') },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: '/v1/queue/resume', body: { ...(a.account_id ? { accountId: a.account_id } : {}) } }),
	},
	{
		name: 'whatsapp_trigger_sync',
		description:
			'Starts a history sync (backfill) for the account — the whole archive, or just contacts / chats / messages. Returns { success: true, accountId, type, status: "started" } immediately: it does NOT wait for the sync to finish, and it returns no messages. Poll whatsapp_sync_status for progress, and only then read the history with whatsapp_search_messages / whatsapp_get_ai_context. You almost never need this: SocialMate keeps the archive current on its own, and WhatsApp pushes history to it. Call it only when the archive is visibly stale (an expected message is genuinely missing) — not before every read, not "to be safe", and never in a loop, which just makes the app re-ingest the same archive. A sync is a heavy local operation; one is enough. Requires SocialMate Pro (`localMessageCache`) and an API key with the `admin` scope; fails 409 if the account is not connected.',
		inputSchema: {
			account_id: accountId,
			type: z.enum(['full', 'contacts', 'chats', 'messages']).optional().describe('What to sync (default full).'),
		},
		accountScoped: true,
		build: (a) => ({ method: 'POST', path: `/v1/accounts/${a._account}/sync`, body: { ...(a.type ? { type: a.type } : {}) } }),
	},
	{
		name: 'whatsapp_sync_status',
		description:
			'Returns the most recent history-sync jobs (up to 50, newest first) across all accounts: each is { id, accountId, type, status, progress, itemsDone, itemsTotal, error, startedAt, finishedAt }, where `status` is "pending" / "running" / "completed" / "failed" and `progress` is a FRACTION from 0 to 1 (0.5 = half done, 1 = finished) — not a percentage. Poll this after whatsapp_trigger_sync — when the job for your account reads "completed", the archive is current and whatsapp_search_messages / whatsapp_get_ai_context will see it; if it reads "failed", `error` says why, and retrying immediately will usually fail the same way. Poll it at a human interval (a few seconds), never in a tight loop. It reports job state only — it returns no messages and starts nothing. Available on every tier (read scope), though starting a sync requires Pro.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/sync/status' }),
	},
	{
		name: 'whatsapp_get_capabilities',
		description:
			'Returns what this SocialMate install can do AND what THIS key may actually call: ' +
			'{ tier, features{...}, tools[{name, n8nNode, available, feature?, requiresAdminKey?, reason?}], tunnel, keyScope, accounts[] }. ' +
			'**Call it once, first.** Your MCP client lists every tool this server exposes regardless of licence, so `tools[]` is the only thing that tells you which of them will really work. ' +
			'`available:false` with a `feature` means the licence tier is wrong — calling it returns 402. ' +
			'`available:false` with `requiresAdminKey` means your API key lacks admin scope — calling it returns 403 on ANY tier, and Pro does not help. ' +
			'Do not discover your limits by failing.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/capabilities' }),
	},

	// ── SocialMate's own WhatsApp agent (Pro, `aiEnabled`) ─────────────────────
	// These tools supervise the native agent that runs INSIDE the SocialMate app
	// (one per WhatsApp number). They do not make the calling model a WhatsApp
	// agent — the app's agent reads and replies on its own. Creating an agent and
	// its configuration (provider, keys, persona, jobs, senses) stay in the app.
	{
		name: 'whatsapp_agent_list',
		description:
			'Lists SocialMate\'s own WhatsApp agents (one per WhatsApp number, configured in the SocialMate app) as an array of { id, accountId, accountLabel, name, status, autonomy, model, providerId, provider{kind,label}, today{conversations, replies, tokens, costUsd}, openHandoffs, pendingApprovals }. `status` is "draft" (never activated), "active", "paused" or "error". Call this first to get the agent_id every other whatsapp_agent_* tool needs, and to see at a glance whether anything is waiting on a person (openHandoffs / pendingApprovals). An API key scoped to some accounts only sees the agents on those accounts. These are the app\'s built-in agents, not you; an empty array means none has been set up in the app yet. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/agents' }),
	},
	{
		name: 'whatsapp_agent_get',
		description:
			'Returns the full configuration of one of SocialMate\'s own WhatsApp agents: its name, status, autonomy, purpose and custom instructions, persona, enabled jobs, tool policies, delivery, escalation, budget and senses settings, owner numbers, model and fallback model, provider (kind and label only — never keys), configVersion, and the catalog of available jobs (jobCatalog). Use it to understand how the agent is set up before deciding on an approval or a hand-off. It is read-only: changing the configuration is done in the SocialMate app. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: { agent_id: agentIdArg },
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: `/v1/agents/${encodeURIComponent(a.agent_id)}` }),
	},
	{
		name: 'whatsapp_agent_pause',
		description:
			'Pauses one of SocialMate\'s own WhatsApp agents: it stops answering on that number until whatsapp_agent_resume. Returns the agent summary (same shape as whatsapp_agent_list) with status "paused". Nothing is deleted, and the number itself keeps working — people can still message it and a person can still reply. Emits the `agent.paused` webhook. Use this when the agent is getting things wrong and a person should take over everywhere; to silence it in a single chat, use whatsapp_agent_take_over instead. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: { agent_id: agentIdArg },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/pause` }),
	},
	{
		name: 'whatsapp_agent_resume',
		description:
			'Resumes a paused SocialMate WhatsApp agent so it answers on its number again. Returns the agent summary with status "active". Fails with "Choose an AI provider and model in SocialMate first." if the agent has no provider/model yet — that is set up in the SocialMate app, not here. It only lifts this agent\'s own pause: if every agent is switched off in the app (the global kill switch), it still stays quiet. Emits the `agent.resumed` webhook. Confirm with the user before resuming an agent someone else paused. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: { agent_id: agentIdArg },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/resume` }),
	},
	{
		name: 'whatsapp_agent_usage',
		description:
			'Returns one SocialMate agent\'s usage over a range: { range, totals{runs, conversations, replies, escalations, tokens, inputTokens, outputTokens, cacheReadTokens, costUsd, resolutionRate, p50LatencyMs, p95LatencyMs}, daily[], byModel[], byTool[], monthCostUsd }. `costUsd` is computed from SocialMate\'s own model price catalog — an estimate of what the AI provider bills the user, not an invoice. `range` is "today", "7d" (default), "14d", "30d" or "90d". For all agents at once, use whatsapp_agent_usage_summary. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			range: z.enum(['today', '7d', '14d', '30d', '90d']).optional().describe('The period to report. Defaults to 7d.'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/usage`, ...(a.range ? { qs: { range: a.range } } : {}) }),
	},
	{
		name: 'whatsapp_agent_usage_summary',
		description:
			'Returns usage across every SocialMate agent the API key can see: { agents, today{conversations, replies, tokens, costUsd, escalations}, monthCostUsd, daily[{day, conversations, replies, escalations, tokens, costUsd}] } — `daily` covers the last 14 days. Costs are estimates from SocialMate\'s own price catalog. Use it for a quick "how much did the agents do and spend" answer; drill into one agent with whatsapp_agent_usage. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: {},
		accountScoped: false,
		build: () => ({ method: 'GET', path: '/v1/usage/summary' }),
	},
	{
		name: 'whatsapp_agent_list_approvals',
		description:
			'Lists the actions one of SocialMate\'s own agents is holding for a person to approve — replies or steps it was not allowed to take on its own under its autonomy setting. Each is { id, agentId, runId, chatId, contactPhone, kind ("act" | "draft" | "connector_intent"), summary, preview, payload, status, decidedBy, createdAt, decidedAt, expiresAt } (times in epoch ms). By default only "pending" items; pass status "all" to include approved, rejected and expired ones. Read `summary` and `preview` before deciding with whatsapp_agent_decide_approval. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			status: z.enum(['pending', 'all']).optional().describe('"pending" (default) or "all".'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/approvals`, ...(a.status === 'all' ? { qs: { status: 'all' } } : {}) }),
	},
	{
		name: 'whatsapp_agent_decide_approval',
		description:
			'Approves or rejects one action SocialMate\'s own agent is holding (from whatsapp_agent_list_approvals). Approving a held reply SENDS it to the customer on WhatsApp right away, through the anti-ban engine; approving a held website step (kind "connector_intent") carries it out on the connected site; rejecting discards it. Returns { ok, message } — e.g. "Approved and sent.", or a note that some part could not be sent. It fails with "Already approved." / "Already rejected." if someone decided it first. This is a decision on a real customer conversation: only approve what the user has actually agreed to — never approve to clear the list. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			approval_id: z.string().describe('The approval id (from whatsapp_agent_list_approvals).'),
			decision: z.enum(['approve', 'reject']).describe('"approve" carries the action out; "reject" discards it.'),
			note: z.string().max(500).optional().describe('Optional note recorded with the decision (up to 500 characters).'),
		},
		accountScoped: false,
		build: (a) => ({
			method: 'POST',
			path: `/v1/agents/${encodeURIComponent(a.agent_id)}/approvals/${encodeURIComponent(a.approval_id)}`,
			body: { decision: a.decision, ...(a.note ? { note: a.note } : {}) },
		}),
	},
	{
		name: 'whatsapp_agent_list_handoffs',
		description:
			'Lists the chats one of SocialMate\'s own agents handed to a person — because it was asked for a human, could not answer, hit its budget, or someone took the chat over. Each is { id, agentId, accountId, chatId, contactName, contactPhone, reason, trigger, status ("open" | "claimed" | "resolved"), openedAt, resolvedAt } (epoch ms). By default only open ones; pass status "all" for the history. While a chat is handed off the agent stays quiet there; answer the person with whatsapp_agent_reply, and give the chat back with whatsapp_agent_release once it is dealt with. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			status: z.enum(['open', 'all']).optional().describe('"open" (default) or "all".'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/handoffs`, ...(a.status === 'all' ? { qs: { status: 'all' } } : {}) }),
	},
	{
		name: 'whatsapp_agent_take_over',
		description:
			'Takes one chat away from SocialMate\'s own agent so a person can handle it: the agent stops replying in that chat (any reply it was about to send is cancelled) until whatsapp_agent_release. Returns { ok: true }. It opens a hand-off marked "Taken over by a person" and sends nothing to the customer. Other chats are unaffected; to stop the agent everywhere use whatsapp_agent_pause. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: { agent_id: agentIdArg, chat_id: agentChatId },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/chats/${encodeURIComponent(a.chat_id)}/takeover` }),
	},
	{
		name: 'whatsapp_agent_release',
		description:
			'Gives a chat back to SocialMate\'s own agent after a person handled it: the chat\'s open hand-offs are resolved and the agent answers there again from the next message on. Returns { ok: true }. It sends nothing by itself. Only release once the person\'s issue is actually dealt with, or the agent picks the conversation up mid-problem. Emits `agent.handoff_resolved` when a hand-off was open. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: { agent_id: agentIdArg, chat_id: agentChatId },
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/chats/${encodeURIComponent(a.chat_id)}/release` }),
	},
	{
		name: 'whatsapp_agent_reply',
		description:
			'Sends a reply in one chat as the person running the business — not as the agent — and keeps SocialMate\'s own agent out of that chat: it takes the chat over first (as whatsapp_agent_take_over does), then sends the text through the anti-ban engine. Returns { ok: true } once the text is handed to WhatsApp, which is not proof it arrived. Use this to answer a handed-off customer; afterwards the agent stays quiet in that chat until whatsapp_agent_release. Only send what the user actually wants said in their name. To message a chat with no agent involved, use whatsapp_send_message. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			chat_id: agentChatId,
			text: z.string().min(1).max(4000).describe('The reply text (1–4000 characters).'),
		},
		accountScoped: false,
		build: (a) => ({ method: 'POST', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/chats/${encodeURIComponent(a.chat_id)}/reply`, body: { text: a.text } }),
	},
	{
		name: 'whatsapp_agent_send_event',
		description:
			'Hands a business event to SocialMate\'s own agent so it starts the matching job with one customer — e.g. an order update ("order.created", "order.paid", "order.shipped", "order.status_changed"), a booking reminder ("booking.created", "booking.reminder"), a form follow-up ("form.submitted"), cart recovery ("cart.abandoned") or back-in-stock ("stock.back_in"). The agent writes and sends the message itself. Returns { status: "queued" | "duplicate" | "skipped", reason?, eventId? }; read `status` — "skipped" is common and correct: the agent is paused, no enabled job handles that event type, the person opted out, a marketing-type job has no consent, the frequency cap (2 per 12 h per job) was hit, the chat is handed to a person, or the recipient is a group (never allowed). The recipient must come from the caller\'s own record of a real customer (an order, a booking, a form submission) — never invent, guess or look up a number to message. Reuse the same idempotency_key for the same real-world event so a retry is a "duplicate", not a second message. Requires SocialMate Pro (AI agents) and an API key with the `send` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			type: z.string().min(1).max(64).describe('The event type, e.g. "order.shipped", "booking.reminder", "cart.abandoned".'),
			idempotency_key: z
				.string()
				.min(8)
				.max(200)
				.describe('A stable key for this real-world event (8–200 characters), e.g. "order-1042-shipped". Sending the same key again is reported as a duplicate and sends nothing.'),
			recipient: z
				.object({
					phone: z.string().min(7).max(24).describe('The customer\'s phone in full international format with country code, taken from the caller\'s own record.'),
					name: z.string().max(80).optional().describe('The customer\'s name, if known.'),
					locale: z.string().max(20).optional().describe('The customer\'s language/locale, e.g. "en" or "ar-EG".'),
				})
				.describe('Who the event is about — one individual customer (groups are refused).'),
			job: z.string().max(64).optional().describe('Force a specific enabled event job (e.g. "order_update"); omit to let the event type pick it.'),
			data: z.record(z.unknown()).optional().describe('Event details the agent can use in the message, e.g. { "order_number": "1042", "tracking_url": "…" }.'),
			consent: z
				.object({
					source: z.string().max(200).describe('Where the person opted in, e.g. "checkout checkbox".'),
					at: z.number().describe('When they opted in, epoch ms.'),
				})
				.optional()
				.describe('Proof the person opted in to this kind of message. Marketing-type jobs (cart recovery, back in stock, review requests, form follow-ups…) are skipped as no_consent unless the person opted in, either here or earlier; order, payment and booking updates about the person\'s own order or booking do not need it. Never fabricate it.'),
			instruction: z.string().max(1000).optional().describe('What the business owner wants the agent to do for this event, in their words (e.g. "Thank them and suggest the next visit"). Only pass the owner\'s own instruction, never text taken from a customer.'),
			audience: z.enum(['customer', 'owner']).optional().describe('"owner" tells the business owner instead of a customer: recipient.phone must be one of the agent\'s owner numbers (otherwise skipped as recipient_not_owner). Default "customer".'),
		},
		accountScoped: false,
		build: (a) => ({
			method: 'POST',
			path: `/v1/agents/${encodeURIComponent(a.agent_id)}/events`,
			body: {
				type: a.type,
				idempotencyKey: a.idempotency_key,
				recipient: a.recipient,
				...(a.job ? { job: a.job } : {}),
				...(a.data ? { data: a.data } : {}),
				...(a.consent ? { consent: a.consent } : {}),
				...(a.instruction ? { instruction: a.instruction } : {}),
				...(a.audience ? { audience: a.audience } : {}),
			},
		}),
	},
	{
		name: 'whatsapp_agent_list_knowledge',
		description:
			'Lists the knowledge one of SocialMate\'s own agents answers from — its own items plus the items shared across the account: [{ id, agentId (null = shared), kind ("text" | "qa" | "file" | "url" | "example"), title, content, tokens, createdAt, updatedAt }]. Check it before adding something, so you do not add a duplicate or a contradiction. Requires SocialMate Pro (AI agents) and an API key with the `read` scope.',
		inputSchema: { agent_id: agentIdArg },
		accountScoped: false,
		build: (a) => ({ method: 'GET', path: `/v1/agents/${encodeURIComponent(a.agent_id)}/knowledge` }),
	},
	{
		name: 'whatsapp_agent_add_knowledge',
		description:
			'Adds one knowledge item that SocialMate\'s own agent will answer customers from — prices, policies, opening hours, a question with its answer, or an example reply. Returns the stored item { id, agentId, kind, title, content, tokens, createdAt, updatedAt }. `kind` is "text" (default), "qa", "url" or "example"; a "url" item stores the text you give as `content` — SocialMate does not fetch the page. `shared: true` makes it available to every agent on that account. The agent will repeat it to real customers, so add only facts the user has confirmed; check whatsapp_agent_list_knowledge first to avoid duplicates. Removing an item is done in the SocialMate app. Requires SocialMate Pro (AI agents) and an API key with the `admin` scope.',
		inputSchema: {
			agent_id: agentIdArg,
			content: z.string().min(1).max(200000).describe('The knowledge itself (up to 200,000 characters).'),
			title: z.string().max(200).optional().describe('Optional short title.'),
			kind: z.enum(['text', 'qa', 'url', 'example']).optional().describe('The kind of item. Defaults to "text".'),
			shared: z.boolean().optional().describe('true = share with every agent on this account; default false = this agent only.'),
		},
		accountScoped: false,
		build: (a) => ({
			method: 'POST',
			path: `/v1/agents/${encodeURIComponent(a.agent_id)}/knowledge`,
			body: {
				content: a.content,
				...(a.title ? { title: a.title } : {}),
				...(a.kind ? { kind: a.kind } : {}),
				...(a.shared !== undefined ? { shared: a.shared } : {}),
			},
		}),
	},
];
