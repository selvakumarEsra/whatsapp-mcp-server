# Changelog

All notable changes after the initial baseline are tracked here. The baseline is commit `acbe881` ("Add MIT License to the project") — every commit up to and including that hash forms the starting point for this fork; entries below describe the delta on top of it.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Local HTTP send endpoint** (`src/http-send.ts`): bearer-token-authenticated `127.0.0.1` HTTP server that lets other local processes POST messages, reactions, and images to whitelisted WhatsApp JIDs. Token is regenerated on each startup and written to `tokenFile` with mode `0600`. Endpoints: `POST /send`, `GET /groups`, `POST /sync/groups`, `GET /db/stats`, `GET /dedup/check`, `POST /dedup/mark`.
- **Contacts / groups database** (`src/contacts-db.ts`): SQLite cache populated from Baileys contact sync and a periodic group refresh. Includes a `forwarded_messages` dedup table so external integrations can avoid duplicate cross-channel forwards.
- **Periodic group sync**: groups are refreshed every `groupSyncIntervalHours` (default 24h) when the database block is configured.
- **Inline image send via HTTP**: `/send` accepts `imageBase64` + `imageMimeType` for image+caption posts without staging files on disk.

### Changed
- `src/config.ts`: new optional `http` and `database` config blocks.
- `src/index.ts`: wires up `ContactsDb` and `startHttpSend` when the respective config blocks are present; sets cwd to the project root so relative config paths resolve consistently; starts the periodic group sync timer.
- `src/logger.ts`: switched the pino destination to a sync `pino.destination` to avoid losing log lines on abrupt exits.
- `src/whatsapp.ts`: persists contacts and groups to the SQLite cache on sync events; exposes `contactsDbCounts()` and an initial-group-sync method used at startup.
- `.gitignore`: excludes `media/` and `.claude/` so forwarded content and local Claude Code settings stay out of the public repo.
- `README.md`: documents the new HTTP endpoint, the SQLite cache, and the optional config blocks.

### Notes
- Both the HTTP endpoint and the database are **opt-in** — omit their config blocks to disable.
- The HTTP server binds only to `127.0.0.1`. Do not publish the token or expose the port externally without an additional auth layer.

## Baseline — `acbe881`

The baseline is the WhatsApp MCP server as of "Add MIT License to the project" (2026-05-29). Features at that point:
- Baileys-backed WhatsApp client with conversation whitelist.
- Name resolution from Baileys contact + LID-to-phone mapping.
- Media auto-save with slugified labels.
- Group attention windows with 3-minute timer and lookbehind.
- MCP `reply` (text + imagePath + quoted reply) and `react` (emoji) tools.
- Pino structured logging with per-startup truncation.
