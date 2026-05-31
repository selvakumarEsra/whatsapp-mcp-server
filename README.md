# WhatsApp MCP Channel

Transform WhatsApp into an MCP (Model Context Protocol) channel server that forwards messages into a Claude Code session and exposes a reply tool for outbound messages.

> **Forked from [`gauravmm/whatsapp-mcp`](https://github.com/gauravmm/whatsapp-mcp)** — original WhatsApp ↔ MCP bridge (Baileys client, whitelist, name resolution, attention windows, reply/react tools) is the work of **Gaurav Manek** under MIT (see `LICENSE`). This fork adds a local HTTP send endpoint, a SQLite contacts/groups cache with a forward-dedup table, and inline image sending — see `CHANGELOG.md` for the full delta.

## Overview

WhatsApp MCP runs as a subprocess spawned by Claude Code over stdio. It connects to WhatsApp via Baileys, filters messages by a conversation whitelist, applies attention-window logic for groups, auto-saves media, and forwards formatted messages as `notifications/claude/channel` events.

## Features

- **Conversation Whitelist** — Only messages from whitelisted JIDs are forwarded; others are silently dropped.
- **Name Resolution** — Messages are prefixed with `[HH:MM Sender Name]` (DMs) or `[HH:MM Sender Name | Group Name]` (groups), using Baileys contact/participant data. Mentions are substituted with resolved names.
- **Media Auto-Save** — Images, videos, audio, and documents from whitelisted conversations are saved to a configurable directory structure. Saved paths are included in notifications.
- **Group Attention Mechanism** — Groups operate in 3-minute attention windows. The bot forwards group messages when mentioned, when an active window is open, or when recent bot messages are referenced.
- **Reply and Reaction Tools** — MCP tools for sending messages, quoted replies, and emoji reactions back to whitelisted conversations.
- **Local HTTP Send Endpoint** *(optional)* — Bearer-token-authenticated `127.0.0.1` HTTP server that other local processes can POST to in order to send text + image (base64) messages to whitelisted JIDs. Useful for letting tools outside the MCP stdio session push notifications into WhatsApp.
- **Contacts / Groups Database** *(optional)* — SQLite cache of contacts and groups synced from Baileys, plus a `forwarded_messages` dedup table so cross-channel forwards don't fire twice. Periodically refreshes groups at a configurable interval.
- **Structured Logging** — Configurable pino logger with file output. Log is truncated on each startup.

## Installation

### Prerequisites

- Node.js >= 20.0.0
- npm

### Setup

```bash
npm install
npm run build
```

## Usage

### Configure

Edit `config/whatsapp-mcp.json`:

```json
{
  "conversations": {
    "1234567890@s.whatsapp.net": { "type": "dm", "label": "Alice" },
    "9876543210-1122334455@g.us": { "type": "group", "label": "Team Chat" }
  },
  "authDir": "config/whatsapp-auth",
  "media": {
    "enabled": true,
    "baseDir": "./media"
  },
  "logging": {
    "level": "info",
    "file": "logs/whatsapp-mcp.log"
  },
  "http": {
    "port": 8765,
    "tokenFile": "config/send.token"
  },
  "database": {
    "file": "config/whatsapp.db",
    "groupSyncIntervalHours": 24
  }
}
```

Conversation keys are full JIDs. `type` is `"dm"` or `"group"`. `label` is a human-readable name used for media paths and notifications.

The `http` and `database` blocks are optional. Omit them to disable the HTTP endpoint or the SQLite cache respectively.

### Environment Variables

| Variable | Description |
|---|---|
| `WHATSAPP_CONFIG` | Path to config JSON file (required) |

### Run

```bash
npm run dev
```

On first run, a QR code will be printed to the terminal. Scan it with WhatsApp (Linked Devices) to authenticate. Session credentials are stored in `authDir`.

## Adding to Claude Code

Add the server to your MCP configuration so Claude Code spawns it as a stdio subprocess.

### Via `mcp.json` (project-level)

Create or edit `.opencode/mcp.json` in your project:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp/dist/index.js"],
      "env": {
        "WHATSAPP_CONFIG": "/absolute/path/to/whatsapp-mcp/config/whatsapp-mcp.json"
      }
    }
  }
}
```

> **Note:** Use absolute paths for `command`, `args`, and `env` values.

After adding the config, restart Claude Code. On first launch the QR code will appear in the MCP server logs — scan it with WhatsApp to authenticate.

## Architecture

### MCP Server

- Uses `@modelcontextprotocol/sdk` with `StdioServerTransport`.
- Exposes the `claude/channel` experimental capability for inbound notifications.
- Provides `reply` and `react` tools for outbound messages and reactions.

### Reply Tool

```json
{
  "name": "reply",
  "inputSchema": {
    "conversation": "string (required) — JID of the conversation",
    "text": "string (required) — message text",
    "imagePath": "string (optional) — absolute path to an image under the configured send root",
    "replyToMessageId": "string (optional) — cached WhatsApp message id to quote"
  }
}
```

Replies to non-whitelisted JIDs return an error. Quoted replies require the referenced message to still be in the in-memory message reference cache.

### Reaction Tool

```json
{
  "name": "react",
  "inputSchema": {
    "conversation": "string (required) — JID of the conversation",
    "messageId": "string (required) — cached WhatsApp message id to react to",
    "emoji": "string (required) — emoji to send; empty string removes the reaction"
  }
}
```

Reactions to non-whitelisted JIDs return an error. Reactions require the target message to still be in the in-memory message reference cache.

### HTTP Send Endpoint *(optional)*

When the `http` config block is set, the server also listens on `127.0.0.1:<port>` and writes a freshly generated bearer token to `tokenFile` on each startup (mode `0600`). All requests require `Authorization: Bearer <token>`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/send` | `{conversation, text, replyToMessageId?, imageBase64?, imageMimeType?}` | Send text or image+caption to a whitelisted JID. Equivalent to the `reply` MCP tool but callable from any local process. |
| GET  | `/groups` | — | List all groups the WhatsApp account is in (from the local DB cache). |
| POST | `/sync/groups` | — | Force a refresh of the groups cache. |
| GET  | `/db/stats` | — | Counts of cached contacts and groups. |
| GET  | `/dedup/check?id=<msgId>` | — | Check whether a message id was already forwarded (returns `{forwarded: bool}`). |
| POST | `/dedup/mark` | `{id, source}` | Mark a message id as forwarded so subsequent cross-channel forwarders skip it. |

All `/send` requests are subject to the same conversation whitelist used by the MCP `reply` tool — non-whitelisted JIDs return `403`.

### Contacts / Groups Database *(optional)*

When the `database` block is set, the server opens a SQLite file with four tables:

- `contacts` (jid, name, notify, verified_name, last_synced_at) — populated from Baileys contact sync events.
- `groups` (jid, subject, owner, creation, size, last_synced_at) — populated from initial group fetch and the periodic re-sync (every `groupSyncIntervalHours`, default 24).
- `sync_state` (key, value) — metadata such as last full sync timestamps.
- `forwarded_messages` (message_id, source, sent_at) — dedup table used by the `/dedup/*` endpoints so external forwarders don't deliver the same content twice.

### Message References

Inbound notifications include `message_id` and `sender_jid` metadata. Replies include `reply_to_message_id` and a short `reply_to_preview`; reactions include `message_kind=reaction`, `reaction`, `reaction_removed`, `target_message_id`, and a short `target_preview`.

The reference cache is intentionally in-memory and bounded. It stores enough Baileys message data to quote or react to recent messages while avoiding long repeated quoted content in MCP notifications.

### Attention Windows (Groups)

1. Bot is mentioned → attention window opens, message forwarded.
2. Replies or reactions to the bot's own messages also open the attention window.
3. Each subsequent forwarded message in the group resets a 3-minute timer.
4. After 3 minutes of silence, the window closes. Messages are received and cached but not forwarded until the next mention or bot-message reference.

### Media Storage

Media is saved to `<baseDir>/<slugified-label>/<YYYY-MM-DD>/<HHmmss>_<filename>`.

### Name Resolution

The bot resolves display names from multiple sources:
- Baileys contact sync (phone, JID, and LID)
- Group participant metadata
- LID-to-phone mapping for contacts not in the address book

Mentions in message text are substituted with resolved names (e.g., `@Alice` instead of `@1234567890`).

### Logging

Structured JSON via pino. Log file is truncated on each startup.

## Project Structure

```
src/
  index.ts            — MCP server entry point, tool registration, message routing
  whatsapp.ts         — Baileys client wrapper, message processing
  name-resolver.ts    — Contact and name resolution (JID, LID, phone, group participants)
  attention.ts        — Group attention window manager
  media.ts            — Media saving and path generation
  config.ts           — Configuration loading from file
  logger.ts           — Pino logger setup
  http-send.ts        — Local HTTP send endpoint with bearer-token auth (optional)
  contacts-db.ts      — SQLite cache for contacts, groups, and forwarded-message dedup (optional)
  types.d.ts          — Type declarations
config/
  whatsapp-mcp.json   — Main configuration (includes conversations whitelist)
  whatsapp-auth/      — WhatsApp session credentials (auto-created)
  whatsapp.db         — SQLite cache (when database block is configured)
  send.token          — HTTP bearer token (regenerated on each startup, mode 0600)
```
