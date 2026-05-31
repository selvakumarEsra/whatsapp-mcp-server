#!/usr/bin/env node
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { fileURLToPath } from 'url';
import { dirname, resolve, extname, sep } from 'path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { WhatsAppClient, FormattedMessage } from './whatsapp.js';
import { AttentionManager } from './attention.js';
import { ContactsDb } from './contacts-db.js';
import { startHttpSend } from './http-send.js';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import qrcode from 'qrcode-terminal';

const config = loadConfig();
const logger = createLogger(config.logging.level, config.logging.file);
const whitelist = new Map(
  Object.entries(config.conversations),
);

const contactsDb = config.database
  ? new ContactsDb(config.database.file, logger)
  : undefined;

const qrCodeFile = config.logging.file + '.qrcode.txt';
if (existsSync(qrCodeFile)) {
  try {
    unlinkSync(qrCodeFile);
  } catch {
    // ignore
  }
}

logger.info(
  { whitelistCount: whitelist.size, authDir: config.authDir },
  'Starting WhatsApp MCP channel',
);

const mcp = new Server(
  { name: 'whatsapp', version: '0.2.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'WhatsApp messages arrive as <channel source="whatsapp" conversation="..." conversation_type="dm|group" sender="...">. ' +
      'All messages are prefixed with [HH:MM Sender Name] for DMs or [HH:MM Sender Name | Group Name] for groups. ' +
      'Reply with the reply tool, passing the conversation JID from the tag; use replyToMessageId to quote a cached message_id. ' +
      'Use the react tool with conversation, messageId, and emoji to send or remove emoji reactions. ' +
      'Media files are saved locally; paths are included in the message content and meta.media_path.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a WhatsApp message to a conversation',
      inputSchema: {
        type: 'object',
        properties: {
          conversation: { type: 'string', description: 'The JID of the conversation to reply to' },
          text: { type: 'string', description: 'The message text to send' },
          imagePath: { type: 'string', description: 'Absolute path to an image file to attach (must be under the configured send root)' },
          replyToMessageId: { type: 'string', description: 'Optional WhatsApp message id to quote in the reply' },
        },
        required: ['conversation', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Send or remove an emoji reaction on a WhatsApp message',
      inputSchema: {
        type: 'object',
        properties: {
          conversation: { type: 'string', description: 'The JID of the conversation to react in' },
          messageId: { type: 'string', description: 'The WhatsApp message id to react to' },
          emoji: { type: 'string', description: 'Emoji reaction to send. Use an empty string to remove the reaction.' },
        },
        required: ['conversation', 'messageId', 'emoji'],
      },
    },
  ],
}));

const attention = new AttentionManager(logger);

const wa = new WhatsAppClient({
  authDir: config.authDir,
  mediaBaseDir: config.media.baseDir,
  mediaEnabled: config.media.enabled,
  whitelist,
  contacts: config.contacts || {},
  logger,
  contactsDb,
  onMessage: (msg: FormattedMessage) => {
    logger.debug(
      { jid: msg.jid, sender: msg.senderName, contentPreview: msg.content.slice(0, 80) },
      'Inbound message',
    );

    const entry = whitelist.get(msg.jid);
    if (!entry) return;

    if (msg.isGroup) {
      const wasActive = attention.isActive(msg.jid);
      const referencesBotMessage =
        msg.replyTo?.messageKey?.fromMe === true
        || msg.reaction?.target.messageKey?.fromMe === true;
      const reactionTargetsForwarded = msg.reaction?.target.forwardedToMcp === true;

      if (msg.isMentioned || referencesBotMessage) {
        attention.open(msg.jid, entry.label);
      } else if (wasActive) {
        attention.reset(msg.jid);
      }

      const shouldForward =
        attention.shouldForward(msg.jid, msg.isMentioned)
        || referencesBotMessage
        || reactionTargetsForwarded;

      if (!shouldForward) {
        logger.debug({ groupJid: msg.jid }, 'Group message dropped: attention window inactive');
        return;
      }

      if ((msg.isMentioned || referencesBotMessage) && !wasActive && !msg.reaction) {
        const lookbehind = wa.getLookbehind(msg.jid, msg.messageId);
        if (lookbehind.length > 0) {
          for (const prior of lookbehind) {
            wa.markForwarded(prior);
          }
          msg.content = lookbehind.map((m) => m.content).join('\n') + '\n' + msg.content;
        }
      }
    }

    const meta: Record<string, string> = {
      conversation: msg.jid,
      conversation_label: entry.label,
      conversation_type: msg.isGroup ? 'group' : 'dm',
      sender: msg.senderName,
      sender_jid: msg.senderJid,
      timestamp: msg.timestamp.toISOString(),
      message_id: msg.messageId,
    };

    if (msg.mediaSaved.length > 0) {
      meta.media_path = msg.mediaSaved.map((m) => m.relativePath).join(', ');
    }

    if (msg.replyTo) {
      meta.reply_to_message_id = msg.replyTo.messageId;
      meta.reply_to_preview = msg.replyTo.preview;
      if (msg.replyTo.senderName) meta.reply_to_sender = msg.replyTo.senderName;
      if (msg.replyTo.timestamp) meta.reply_to_timestamp = msg.replyTo.timestamp.toISOString();
      if (msg.replyTo.mediaPaths?.length) meta.reply_to_media_path = msg.replyTo.mediaPaths.join(', ');
    }

    if (msg.reaction) {
      meta.message_kind = 'reaction';
      meta.reaction = msg.reaction.emoji;
      meta.reaction_removed = String(msg.reaction.removed);
      meta.target_message_id = msg.reaction.target.messageId;
      meta.target_preview = msg.reaction.target.preview;
      if (msg.reaction.target.senderName) meta.target_sender = msg.reaction.target.senderName;
      if (msg.reaction.target.timestamp) meta.target_timestamp = msg.reaction.target.timestamp.toISOString();
      if (msg.reaction.target.mediaPaths?.length) meta.target_media_path = msg.reaction.target.mediaPaths.join(', ');
    }

    wa.markForwarded(msg);

    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: msg.content,
        meta,
      },
    }).catch((err) => {
      logger.error('Failed to send notification: %o', err);
    });
  },
  onQR: (qr) => {
    logger.info('QR code generated for scanning');
    try {
      qrcode.generate(qr, { small: true }, (ascii: string) => {
        writeFileSync(qrCodeFile, ascii);
      });
    } catch (err) {
      logger.error({ err }, 'Failed to write QR code file');
    }
  },
  onStatus: (status) => {
    logger.info({ status }, 'WhatsApp connection status changed');
  },
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const args = req.params.arguments as {
      conversation: string;
      text: string;
      imagePath?: string;
      replyToMessageId?: string;
    };

    if (!whitelist.has(args.conversation)) {
      logger.warn({ jid: args.conversation }, 'Reply rejected: conversation not whitelisted');
      return {
        content: [{ type: 'text', text: `Error: conversation ${args.conversation} is not in the whitelist` }],
        isError: true,
      };
    }

    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;

    if (args.imagePath) {
      const abs = resolve(args.imagePath);
      const root = resolve(config.media.sendRoot ?? config.media.baseDir) + sep;
      if (!abs.startsWith(root)) {
        logger.warn({ path: abs, root }, 'Reply rejected: image path outside send root');
        return {
          content: [{ type: 'text', text: `Error: image path is outside the allowed send root` }],
          isError: true,
        };
      }
      const ext = extname(abs).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
      };
      imageMimeType = mimeMap[ext] ?? 'image/jpeg';
      imageBase64 = readFileSync(abs).toString('base64');
    }

    try {
      await wa.sendMessage(
        args.conversation,
        args.text,
        imageBase64,
        imageMimeType,
        args.replyToMessageId,
      );
      logger.debug(
        { jid: args.conversation, replyToMessageId: args.replyToMessageId, contentPreview: args.text.slice(0, 80) },
        'Reply sent',
      );
      return { content: [{ type: 'text', text: 'sent' }] };
    } catch (err) {
      logger.error({ err }, 'Failed to send reply');
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  if (req.params.name === 'react') {
    const args = req.params.arguments as {
      conversation: string;
      messageId: string;
      emoji: string;
    };

    if (!whitelist.has(args.conversation)) {
      logger.warn({ jid: args.conversation }, 'Reaction rejected: conversation not whitelisted');
      return {
        content: [{ type: 'text', text: `Error: conversation ${args.conversation} is not in the whitelist` }],
        isError: true,
      };
    }

    try {
      await wa.sendReaction(args.conversation, args.messageId, args.emoji);
      logger.debug(
        { jid: args.conversation, messageId: args.messageId, reactionRemoved: args.emoji.length === 0 },
        'Reaction sent',
      );
      return { content: [{ type: 'text', text: args.emoji.length === 0 ? 'removed' : 'sent' }] };
    } catch (err) {
      logger.error({ err }, 'Failed to send reaction');
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Error: unknown tool ${req.params.name}` }],
    isError: true,
  };
});

async function shutdown() {
  logger.info('Shutting down...');
  if (groupSyncTimer) clearInterval(groupSyncTimer);
  attention.destroy();
  await wa.disconnect();
  await mcp.close();
  if (contactsDb) contactsDb.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

let groupSyncTimer: NodeJS.Timeout | undefined;

async function main() {
  await mcp.connect(new StdioServerTransport());
  logger.info('MCP server connected over stdio');
  await wa.connect();
  if (config.http) {
    startHttpSend({
      port: config.http.port,
      tokenFile: config.http.tokenFile,
      whitelist: new Set(whitelist.keys()),
      client: wa,
      logger,
      contactsDb,
    });
  }
  if (config.database) {
    const intervalHours = config.database.groupSyncIntervalHours ?? 24;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    groupSyncTimer = setInterval(() => {
      wa.syncGroups().catch((err) => logger.error({ err }, 'scheduled group sync failed'));
    }, intervalMs);
    groupSyncTimer.unref();
    logger.info({ intervalHours }, 'scheduled daily group sync');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`whatsapp-mcp failed to start: ${message}\n`);
  try {
    logger.error('Failed to start: %o', error);
  } catch {
    // logger may not be initialised yet
  }
  process.exit(1);
});
