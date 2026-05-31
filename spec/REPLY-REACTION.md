# Reply and Reaction Support

## Purpose

Add first-class support for WhatsApp message references so the MCP channel can:

- Receive replies with a reference to the quoted past message.
- Receive emoji reactions with a reference to the reacted-to past message.
- Send replies quoting a past WhatsApp message.
- Send or remove emoji reactions on a past WhatsApp message.

The implementation should preserve the current architecture: `src/whatsapp.ts` normalizes Baileys events, `src/index.ts` exposes MCP notifications and tools, and group forwarding remains governed by `AttentionManager`.

## Non-Goals

- Persistent message history across process restarts.
- Full WhatsApp thread reconstruction.
- Editing or deleting messages.
- Rendering every quoted message type perfectly.
- Supporting reactions to messages that are no longer available in the local reference cache.

## Current System

Inbound WhatsApp messages are handled in `WhatsAppClient.connect()` through Baileys `messages.upsert` events. Each whitelisted, non-status, non-`fromMe` message is normalized by `processMessage()` into `FormattedMessage`, then passed to `onMessage`.

`src/index.ts` applies group attention logic and sends `notifications/claude/channel` notifications with text content and flat string metadata. The only outbound MCP tool is `reply`, which sends text and optional image messages to whitelisted conversations.

There is currently no durable or general message index. The only reference-like structure is the group lookbehind buffer.

## Data Model

Extend `FormattedMessage` with message identity and optional reference fields:

```ts
export interface FormattedMessage {
  jid: string;
  senderJid: string;
  senderName: string;
  content: string;
  timestamp: Date;
  isGroup: boolean;
  isMentioned: boolean;
  mediaSaved: SavedMedia[];
  messageId: string;
  messageKey: MessageKeyReference;
  replyTo?: MessageReference;
  reaction?: ReactionEvent;
  forwardedToMcp?: boolean;
}

export interface MessageKeyReference {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
}

export interface MessageReference {
  messageId: string;
  conversation: string;
  senderJid?: string;
  senderName?: string;
  timestamp?: Date;
  preview: string;
  mediaPaths?: string[];
  messageKey?: MessageKeyReference;
  forwardedToMcp?: boolean;
}

export interface ReactionEvent {
  emoji: string;
  removed: boolean;
  target: MessageReference;
}
```

The actual implementation may keep Baileys `WAMessage` and `WAMessageKey` types internally, but MCP-facing metadata should use the stable shape above.

## Message Reference Cache

Add a bounded in-memory message reference cache owned by `WhatsAppClient`.

Requirements:

- Key references by conversation JID and message id.
- Store enough data to render reply and reaction previews.
- Store enough Baileys data to quote or react to a message later.
- Prune by both age and max entries to prevent unbounded memory growth.
- Cache messages even when a group message is dropped by attention logic, as later replies or reactions may reference them.

Suggested defaults:

- `MESSAGE_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000`
- `MESSAGE_REFERENCE_MAX = 2000`

Suggested cache record:

```ts
interface CachedMessageReference extends MessageReference {
  rawMessage: WAMessage;
  messageKey: MessageKeyReference;
  lastSeenAt: number;
  forwardedToMcp: boolean;
}
```

If future persistence is needed, this cache can be moved behind an interface without changing the MCP contract.

## Inbound Replies

Baileys attaches quoted-message data to message content through `contextInfo`.

The implementation should add a helper in `src/whatsapp.ts` that unwraps message content and extracts reply context from message types that support `contextInfo`, including at least:

- `extendedTextMessage`
- `imageMessage`
- `videoMessage`
- `documentMessage`
- `audioMessage`

Fields to read:

- `contextInfo.stanzaId`
- `contextInfo.participant`
- `contextInfo.remoteJid`
- `contextInfo.quotedMessage`

Resolution:

1. Determine the target conversation as `contextInfo.remoteJid || current remoteJid`.
2. Determine the target message id from `contextInfo.stanzaId`.
3. Look up the target in the message reference cache.
4. If found, attach the cached reference to `FormattedMessage.replyTo`.
5. If not found, create a fallback `MessageReference` from `contextInfo.quotedMessage`.

Fallback previews should reuse the same content extraction rules as normal messages where possible. If extraction fails, use `[Quoted Message]`.

Inbound reply notifications should include both readable context and metadata.

Example content:

```text
[14:02 Alice | Team Chat] Replying to Bob: "Can you check this?"
Looks good to me.
```

Required metadata:

- `message_id`
- `reply_to_message_id`
- `reply_to_preview`

Optional metadata when known:

- `reply_to_sender`
- `reply_to_timestamp`
- `reply_to_media_path`

## Inbound Reactions

Baileys represents reactions as `reactionMessage`.

The implementation should detect reactions before normal content extraction. Current behavior drops these events because they do not produce normal text content.

Fields to read:

- `message.reactionMessage.key`
- `message.reactionMessage.text`
- `message.reactionMessage.senderTimestampMs`

Behavior:

- A non-empty `text` is the emoji reaction.
- An empty `text` means the reaction was removed.
- `key` identifies the reacted-to message.
- The sender is the current message sender.

Resolution:

1. Determine target conversation from `reactionMessage.key.remoteJid || current remoteJid`.
2. Determine target message id from `reactionMessage.key.id`.
3. Look up the target in the message reference cache.
4. If found, attach the cached reference.
5. If not found, create a minimal target reference with the message id and preview `[Unknown Message]`.

Example content:

```text
[14:04 Alice | Team Chat] Reacted 👍 to Bob: "Can you check this?"
```

Example removal content:

```text
[14:05 Alice | Team Chat] Removed reaction from Bob: "Can you check this?"
```

Required metadata:

- `message_kind=reaction`
- `message_id`
- `reaction`
- `reaction_removed`
- `target_message_id`
- `target_preview`

Optional metadata when known:

- `target_sender`
- `target_timestamp`
- `target_media_path`

## Group Attention Behavior

Normal group messages should continue using the existing attention-window logic.

Replies:

- A reply that mentions the bot should open attention as usual.
- A reply to one of the bot's own messages should also open or reset attention, even if the bot is not explicitly mentioned.
- Other replies should be forwarded only while the attention window is active.

Reactions:

- Reactions to one of the bot's own messages should be forwarded.
- Reactions to messages already forwarded during the current attention window should be forwarded.
- Other reactions should be dropped when the group attention window is inactive.
- Dropped reactions should still be logged at debug level.

To support this, cached references should track whether a message was forwarded to MCP during the current process lifetime.

## Outbound Replies

Extend the existing MCP `reply` tool with an optional `replyToMessageId` argument.

Schema addition:

```json
{
  "replyToMessageId": {
    "type": "string",
    "description": "Optional WhatsApp message id to quote in the reply"
  }
}
```

Validation:

- `conversation` must remain whitelisted.
- If `replyToMessageId` is provided, it must exist in the message reference cache for that conversation.
- If it does not exist, return an MCP tool error explaining that the target message is no longer available.

Sending:

- For text-only replies, call Baileys `sendMessage` with `{ quoted: cached.rawMessage }`.
- For image replies, send the image content and caption with the same quoted option.
- Store the returned outbound message in the reference cache when Baileys returns a message key.

## Outbound Reactions

Add a new MCP tool named `react`.

Schema:

```json
{
  "name": "react",
  "description": "Send or remove an emoji reaction on a WhatsApp message",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversation": {
        "type": "string",
        "description": "The JID of the whitelisted conversation"
      },
      "messageId": {
        "type": "string",
        "description": "The WhatsApp message id to react to"
      },
      "emoji": {
        "type": "string",
        "description": "Emoji reaction to send. Use an empty string to remove the reaction."
      }
    },
    "required": ["conversation", "messageId", "emoji"]
  }
}
```

Validation:

- `conversation` must be whitelisted.
- `messageId` must exist in the message reference cache for that conversation.
- `emoji` may be empty only to remove an existing reaction.
- Non-empty `emoji` should be a short string. The implementation should reject long arbitrary text.

Sending:

```ts
await sock.sendMessage(conversation, {
  react: {
    text: emoji,
    key: cached.rawMessage.key,
  },
});
```

The Baileys README documents that an empty reaction text removes the reaction.

## MCP Notification Metadata

Add common metadata for all inbound message notifications:

- `message_id`
- `sender_jid`

Keep existing metadata:

- `conversation`
- `conversation_label`
- `conversation_type`
- `sender`
- `timestamp`
- `media_path`

Add reply metadata only when present:

- `reply_to_message_id`
- `reply_to_sender`
- `reply_to_timestamp`
- `reply_to_preview`
- `reply_to_media_path`

Add reaction metadata only when present:

- `message_kind=reaction`
- `reaction`
- `reaction_removed`
- `target_message_id`
- `target_sender`
- `target_timestamp`
- `target_preview`
- `target_media_path`

All metadata values should remain strings to match the existing `Record<string, string>` pattern in `src/index.ts`.

## Token Economy

Reply and reaction support can easily repeat old message content. The implementation should minimize MCP token usage while preserving enough context for the model to act correctly.

Principles:

- Prefer stable ids and short previews over repeating full historical messages.
- Send full message content only once per inbound message.
- Send referenced-message content as a short preview unless the reference was not previously forwarded.
- Make repeated references machine-readable through metadata, not verbose prose.
- Keep MCP tool results terse.

### Deduplicating Referenced Content

The message reference cache should track whether a message has already been forwarded to MCP:

```ts
interface CachedMessageReference extends MessageReference {
  rawMessage: WAMessage;
  messageKey: MessageKeyReference;
  lastSeenAt: number;
  forwardedToMcp: boolean;
}
```

When formatting a reply or reaction:

- If the referenced message has `forwardedToMcp=true`, include only `reply_to_message_id` or `target_message_id` plus a short preview.
- If the referenced message has not been forwarded, include a bounded fallback preview so the model gets enough local context.
- Never inline the full quoted message from `contextInfo.quotedMessage` if the same message id is already known.
- If a lookbehind batch includes a message and the live mentioned message replies to it, include that message only once in content.

Suggested preview limits:

- Text preview: 120 characters.
- Media preview: media label plus caption preview, for example `[Image: caption...]`.
- Metadata preview: same truncation as content preview.

### Notification Content Shape

Avoid large quoted blocks. Prefer compact references:

```text
[14:02 Alice] Replying to Bob (msg A1B2): "Can you check this?"
Looks good to me.
```

For messages already forwarded in the same MCP session, the content may be even shorter:

```text
[14:02 Alice] Replying to Bob (msg A1B2)
Looks good to me.
```

The second form is preferred when token pressure is important and the referenced preview is already available in metadata.

### Reaction Coalescing

Reactions are low-information events and can be noisy.

The implementation may coalesce reaction updates before forwarding if this becomes necessary:

- Keep only the latest reaction state per `(conversation, targetMessageId, senderJid)` within a short debounce window.
- Suggested debounce window: 1-3 seconds.
- Do not coalesce reactions to the bot's own messages unless a later implementation proves it is safe.

Coalescing is optional for the first implementation, but the cache shape should not make it difficult later.

### Tool Result Verbosity

Outbound tools should return compact success messages:

- `reply`: `sent`
- `react`: `sent`
- reaction removal: `removed`

Errors should be clear but short. Avoid echoing full message text, image paths, or quoted content in tool results.

### Optional Reference Lookup Tool

Do not add a verbose history tool by default.

If a future implementation needs more context on demand, add a narrow `get_message_reference` tool that takes `conversation` and `messageId` and returns one cached reference. This keeps routine notifications small while allowing the model to request more detail only when needed.

## Content Formatting

Content should remain readable when shown directly to the model.

Rules:

- Keep the existing `[HH:MM Sender]` and `[HH:MM Sender | Group]` prefixes.
- Truncate referenced previews to a fixed length, suggested 120 characters.
- Replace newlines in previews with spaces.
- Prefer resolved display names over raw JIDs.
- Include message ids in metadata, not in normal content.

Suggested formats:

```text
[14:02 Alice] Replying to Bob: "Can you check this?"
Looks good to me.
```

```text
[14:04 Alice] Reacted 👍 to Bob: "Can you check this?"
```

```text
[14:05 Alice] Removed reaction from Bob: "Can you check this?"
```

## Error Handling

Tool errors should return `isError: true` with clear text:

- Conversation is not whitelisted.
- Referenced message is not in cache.
- WhatsApp is not connected.
- Reaction emoji is invalid.
- Image path validation failed.

Inbound malformed reply or reaction payloads should not crash processing. Log the malformed shape at debug level and either:

- Continue as a normal message if normal content exists.
- Drop the event if no meaningful content can be produced.

## Implementation Plan

1. Add message identity and reference types in `src/whatsapp.ts` or a new `src/message-references.ts`.
2. Add a bounded message reference cache.
3. Store inbound normal messages in the cache after content/media extraction.
4. Extract reply context from `contextInfo` and attach `replyTo`.
5. Extract `reactionMessage` events and attach `reaction`.
6. Update `src/index.ts` notification metadata and content formatting.
7. Extend `reply` with `replyToMessageId`.
8. Add the `react` MCP tool.
9. Cache outbound messages returned by Baileys when possible.
10. Update README tool documentation after implementation.

## Acceptance Criteria

- An inbound WhatsApp reply is forwarded with `reply_to_message_id` and readable quoted-message context.
- An inbound WhatsApp reaction is forwarded as a reaction notification with target-message metadata.
- Removed reactions are represented distinctly from added reactions.
- The MCP `reply` tool can quote a cached past message.
- The MCP `react` tool can add and remove reactions on cached past messages.
- Reactions and replies respect group attention behavior.
- Unknown or expired references produce clear MCP tool errors for outbound actions.
- Unknown inbound references still produce useful fallback previews.
- `npm run build` passes.
