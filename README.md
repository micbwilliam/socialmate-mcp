# socialmate-mcp

<p align="center">
  <img src="https://raw.githubusercontent.com/micbwilliam/n8n-nodes-socialmate/main/assets/logo.png" width="96" alt="SocialMate" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/socialmate-mcp"><img src="https://img.shields.io/npm/v/socialmate-mcp.svg?color=2563eb" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/socialmate-mcp"><img src="https://img.shields.io/npm/dm/socialmate-mcp.svg?color=2563eb" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/socialmate-mcp.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/socialmate-mcp.svg" alt="node version" />
</p>

<p align="center"><strong>Give your AI a WhatsApp.</strong></p>

A native **[Model Context Protocol](https://modelcontextprotocol.io)** server for
**[SocialMate](https://socialmate.app)** — the self-hosted WhatsApp automation server (desktop app,
or headless on your own VPS/Docker, managed from a browser at `/admin`). Point
**Claude Desktop, Cursor, Cline** or any MCP client at it and your agent can send and read WhatsApp
messages, look up contacts, manage groups, queue a paced batch of personalised messages, recall whole conversations, **look at the
photos people send**, remember who it's talking to and what media said, and check anti-ban headroom —
**44 tools**, all on your own machine and your own number.

> **SocialMate doesn't contain an AI — it gives *your* AI a WhatsApp.** This server is a thin
> translator over SocialMate's local REST API: every tool call runs through the app's real
> **auth → scope → tier-gate → anti-ban → audit** pipeline, so nothing here can bypass a limit and
> the app stays the single source of truth.

- **Guide:** https://socialmate.app/docs/mcp-server
- **Landing page:** https://socialmate.app/whatsapp-mcp-server
- **The app:** https://socialmate.app

---

## Requirements

- The **SocialMate desktop app** running, with its Local API server on (**API & Integrations**).
- An **API key** from the app (**API & Integrations → new key**). Its scope (read / send / admin)
  and your license tier decide which tools work.
- **Node.js ≥ 18.17** (only to run `npx`; nothing to install globally).

## Quickstart — Claude Desktop

Add SocialMate to your `claude_desktop_config.json` (the app shows a copy-paste snippet under
**API & Integrations → MCP**):

```json
{
  "mcpServers": {
    "socialmate": {
      "command": "npx",
      "args": ["socialmate-mcp"],
      "env": {
        "SOCIALMATE_API_KEY": "sm_live_xxx",
        "SOCIALMATE_BASE_URL": "http://127.0.0.1:3456"
      }
    }
  }
}
```

Restart Claude Desktop and the WhatsApp tools appear. **Cursor, Cline, Goose** and any other MCP
client use the same `command` / `args` / `env` — drop it into their MCP config the same way.

### Environment variables

| Variable | Required | Default | What it is |
|---|:---:|---|---|
| `SOCIALMATE_API_KEY` | ✅ | — | An API key from the app → API & Integrations. |
| `SOCIALMATE_BASE_URL` | | `http://127.0.0.1:3456` | The app's API — a desktop app or a headless VPS. Use your **Pro named tunnel** host to drive WhatsApp from a remote agent. On a VPS (a datacenter IP) you can route an account through your own residential/mobile proxy (Pro) to keep a residential IP. |

## What your agent can do — 44 tools

All namespaced `whatsapp_*`; the model picks the right one from its description.

| Area | Tools |
|---|---|
| **Messaging** | `send_message` (with `reply_to` to quote) · `send_media` · `send_poll` · `get_poll_results` · `send_location` · `send_contact` |
| **Conversational signals** | `react_message` (`emoji: ""` removes) · `mark_read` · `send_typing` — free on every tier; they consume no send budget and don't raise the risk score |
| **Memory & reading** | `get_ai_context` (role-mapped memory feed) · `search_messages` · `fetch_new_messages` (poll cursor) · `list_chats` |
| **Vision (see what people send)** | `list_media` (`has_context: false` = "what haven't I looked at yet?") · `get_media` — returns the image **as an MCP image block**, so your model can actually look at it · `set_media_context` — save what you saw, so it's never analyzed twice |
| **Agent Memory (write, Pro)** | `update_contact` (save a name/notes/tags you learned) · `set_media_context` — SocialMate **stores** what your agent learned, it never generates it |
| **Contacts** | `list_contacts` · `get_contact` |
| **Groups** | `list_groups` · `get_group` · `create_group` · `update_group_participants` · `set_group_subject` · `set_group_description` · `get_group_invite` · `leave_group` |
| **Queue & batches (Pro)** | `queue_import` — for people **already waiting on you**: one `{{field}}` template + up to 5000 rows, each row becoming one *individual, personalised* message paced by anti-ban · `queue_message` (one, scheduled) · `queue_status` · `list_queue` · `cancel_queued` · `retry_queued` · `list_batches` · `cancel_batch` · `retry_batch` · `pause_queue` · `resume_queue` |
| **Sync & status** | `trigger_sync` · `sync_status` · `get_antiban_status` · `get_capabilities` · `list_accounts` |

Account-scoped tools take an optional `account_id`; with a single-account key it's **auto-resolved**.
A good first call is `whatsapp_get_capabilities` — it tells the agent its tier, scope and feature
flags so it knows what it's allowed to do before it tries.

**The vision loop.** `list_media` (`has_context: false`) → `get_media` (the item comes back as a real
image content block your vision model can see) → `set_media_context` (cache the description). After
that the photo rides along already described inside `get_ai_context`, and is never analyzed again.
`get_media` returns the **thumbnail** — enough to see what a photo *is*, bounded in size; the
full-resolution bytes stay on the HTTP API on purpose (see below).

**Batch sending is off by default.** `queue_import` returns `403 bulk_import_disabled` (the wire code
is unchanged) until the user switches it on in the app (**Settings → Advanced → "Enable batch
sending"**). SocialMate is **not a broadcast tool** — it is for managing your own conversations, with
people who are already waiting on you. Every batch item is an individual, personalised message paced
by the anti-ban engine; identical text to many contacts is blocked by the duplicate guard. When the
gate is closed the server tells the agent to *ask*, rather than to loop `send_message` — which is the
pattern that gets numbers banned.

> **Deliberately not exposed:** API-key management, webhook wiring, the per-account proxy, media
> *writes* (force-download / delete / cleanup), and the **raw media file** — an agent minting keys,
> rewiring delivery, re-routing traffic, deleting files, or pulling a 15 MB blob into its context is a
> footgun. Do those in the app, or over the HTTP API / n8n. The full list, with a reason per endpoint,
> is the `NOT_EXPOSED` allowlist in [`contract.test.mjs`](contract.test.mjs) — a new app endpoint
> fails the build until it is either given a tool or deliberately skipped there.

## 🧠 A seed prompt that makes the agent behave like a human

The server ships a **native MCP prompt** — `socialmate_human_agent` — so any client that
supports `prompts/list` (Claude Desktop, Cursor, …) can load it as a system prompt. No
copy-paste.

It teaches the human reply cadence (*mark read → recall the thread → show typing → react or
reply*), the whole tool inventory and when **not** to use each, the tier + anti-ban error
contract (`402`, blocked sends, `queueable:false`, `signal_rate_limit`), the things the agent
genuinely **cannot** do (no edit/delete/forward; it can't see the contact typing; buttons are
deprecated — send a poll), and the consent and honesty rules.

Fill it in with your business:

| Argument | Example |
|---|---|
| `business_name` | `Northwind Coffee` |
| `business_description` | `specialty coffee roastery in Cairo` |
| `agent_name` | `Nora` |
| `agent_role` | `front-desk support` |
| `tone` | `warm, concise, never salesy` |
| `business_hours` | `Sun–Thu, 9:00–17:00 Cairo time` |
| `escalation_procedure` | `tagging @ops in Slack and telling the customer a colleague will follow up` |
| `scope_boundaries` | `orders, opening hours and the menu` |
| `additional_rules` | anything extra |

Canonical text (and the n8n version): [`docs/AI-AGENT-SYSTEM-PROMPT.md`](../docs/AI-AGENT-SYSTEM-PROMPT.md).

Reactions, read receipts and the typing indicator are **free on every tier** and consume no
send budget — an agent can behave like a human without spending its message allowance.

## 📥 Reacting to incoming messages

This is the one thing to know about MCP. **MCP is request/response — it has no inbound push.** The
server can't notify Claude/Cursor that a WhatsApp message just arrived; a client only acts when you
ask it to. Two ways to make an agent react to messages *as they arrive*:

1. **Poll (pure MCP)** — call `whatsapp_fetch_new_messages` on a loop, passing the newest `timestamp`
   you've seen as `since` to get only what's new. Requires Pro (it reads synced history).
2. **Event-driven (bridge)** — start the loop from n8n's **SocialMate Trigger** (`message.received`)
   or a **webhook** to your own code, then let the agent act back through these tools. Works on Free
   too (the `message.received` webhook is a Free event).

For a desktop assistant you drive by hand, MCP alone is perfect. For an unattended auto-responder,
use the bridge.

### Did it land? — delivery receipts

Every message row returned by `whatsapp_fetch_new_messages` and `whatsapp_search_messages` carries a
**`status`**: `pending` → `sent` → `delivered` (it reached their phone) → `read` (they opened it). So
an agent can check whether something it sent actually landed by re-reading the row — it never has to
ask a human. Note that a **send** returns `status: "sent"`, which only means *handed to WhatsApp*; it
is not proof of arrival.

To be *told* the moment it lands, subscribe to the two receipt webhooks (**Pro**) — like every other
event, they arrive through the n8n **SocialMate Trigger** or your own receiver, never over MCP:

| Event | Fires when |
|---|---|
| `message.delivered` | Your message reached the recipient's phone (two grey ticks) |
| `message.read` | They opened it (two blue ticks) |

Both carry `messageId`, `status` and `fromMe: true` — correlate on the `messageId` your send returned
and the notification loop closes. They fire **only for messages the operator sent**: an inbound
message the operator reads on their own phone never emits one, so `message.read` always means *they
read yours*, never *you read theirs*.

## Scope & tiers

Tools honor the API key's **scope** and your **license tier**, exactly like the REST API:

| | Free | Pro |
|---|:---:|:---:|
| Read messages, chats, contacts, groups | ✅ | ✅ |
| Send **text** | ✅ | ✅ |
| Anti-ban status, capabilities | ✅ | ✅ |
| Send **media**, create/manage groups | — | ✅ |
| History, **Get AI Context**, poll cursor | — | ✅ |
| Smart queue (schedule / batch / control) | — | ✅ |

A gated tool returns a clear *"requires Pro"* error rather than failing silently, so the agent can
adapt (e.g. fall back to a plain text send).

## Develop / explore

Browse and call every tool interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx socialmate-mcp
```

Run the test suite (spawns the server against a mock REST API and drives it over MCP):

```bash
npm install
npm test
```

## Prefer n8n?

Building visual, triggered workflows instead of a desktop assistant? SocialMate also ships a native
**[n8n node](https://www.npmjs.com/package/n8n-nodes-socialmate)** whose every operation is usable as
an AI-Agent tool. Same WhatsApp, different client — see the
[AI agents guide](https://socialmate.app/docs/n8n-ai-agents).

## License

[MIT](LICENSE) © SocialMate Ltd.
