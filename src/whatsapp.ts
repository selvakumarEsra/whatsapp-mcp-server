import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  WASocket,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import pino from 'pino';
import { saveMedia, SavedMedia } from './media.js';
import { WhitelistEntry } from './config.js';
import { NameResolver } from './name-resolver.js';
import { ContactsDb } from './contacts-db.js';

const VERSION = '0.2.0';
const MESSAGE_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_REFERENCE_MAX = 2000;
const REFERENCE_PREVIEW_LIMIT = 120;

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

interface CachedMessageReference extends MessageReference {
  rawMessage: WAMessage;
  messageKey: MessageKeyReference;
  lastSeenAt: number;
  forwardedToMcp: boolean;
}

interface RawReplyContext {
  messageId: string;
  conversation?: string;
  participant?: string;
  quotedMessage?: unknown;
}

interface RawReactionContext {
  emoji: string;
  removed: boolean;
  key: WAMessageKey;
}

export interface WhatsAppClientOptions {
  authDir: string;
  mediaBaseDir: string;
  mediaEnabled: boolean;
  whitelist: Map<string, WhitelistEntry>;
  contacts: Record<string, string>;
  onMessage: (msg: FormattedMessage) => void;
  onQR: (qr: string) => void;
  onStatus: (status: string) => void;
  logger: pino.Logger;
  contactsDb?: ContactsDb;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private options: WhatsAppClientOptions;
  private reconnecting = false;
  private nameResolver!: NameResolver;
  private loggedUnknownJids = new Set<string>();
  private lookbehindBuffer = new Map<string, FormattedMessage[]>();
  private messageReferences = new Map<string, CachedMessageReference>();

  constructor(options: WhatsAppClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.options.logger.info('Using Baileys version: %s', version.join('.'));

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['whatsapp-mcp', 'cli', VERSION],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.nameResolver = new NameResolver(this.sock, this.options.logger);
    this.nameResolver.loadConfigContacts(this.options.contacts);

    if (this.sock.ws && typeof this.sock.ws.on === 'function') {
      this.sock.ws.on('error', (err: Error) => {
        this.options.logger.error('WhatsApp WebSocket error: %s', err.message);
      });
    }

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.options.onQR(qr);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.options.logger.info(
          'Connection closed. Status: %s, Will reconnect: %s',
          statusCode,
          shouldReconnect,
        );
        this.options.onStatus('disconnected');

        if (shouldReconnect && !this.reconnecting) {
          this.reconnecting = true;
          this.options.logger.info('Reconnecting in 5 seconds...');
          setTimeout(() => {
            this.reconnecting = false;
            this.connect();
          }, 5000);
        }
      } else if (connection === 'open') {
        this.registerBotIdentity();
        this.options.onStatus('connected');
        this.maybeInitialGroupSync().catch((err) =>
          this.options.logger.error({ err }, 'initial group sync failed'),
        );
      }
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('contacts.upsert', (contacts) => {
      this.nameResolver.ingestContacts(contacts);
      this.persistContacts(contacts);
    });
    this.sock.ev.on('contacts.update', (contacts) => {
      this.nameResolver.ingestContacts(contacts);
      this.persistContacts(contacts);
    });
    this.sock.ev.on('chats.upsert', (chats) => {
      const db = this.options.contactsDb;
      if (!db) return;
      const records = chats
        .filter((c) => c.id && !c.id.endsWith('@g.us') && c.id !== 'status@broadcast')
        .map((c) => ({ jid: c.id!, name: c.name ?? undefined }));
      if (records.length) {
        try { db.upsertContacts(records); } catch (err) { this.options.logger.error({ err }, 'contacts upsert from chats failed'); }
      }
    });
    this.sock.ev.on('groups.upsert', (groups) => this.persistGroups(groups));
    this.sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
      this.persistContacts(contacts);
      const db = this.options.contactsDb;
      if (db) {
        const fromChats = chats
          .filter((c) => c.id && !c.id.endsWith('@g.us') && c.id !== 'status@broadcast')
          .map((c) => ({ jid: c.id!, name: c.name ?? undefined }));
        if (fromChats.length) {
          try { db.upsertContacts(fromChats); } catch (err) { this.options.logger.error({ err }, 'history contacts upsert failed'); }
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const entry = this.options.whitelist.get(remoteJid);
        if (!entry) {
          if (!this.loggedUnknownJids.has(remoteJid)) {
            this.loggedUnknownJids.add(remoteJid);
            const isGroup = remoteJid.endsWith('@g.us');
            const senderJid =
              (typeof msg.key.participant === 'string' && msg.key.participant)
              || remoteJid;
            const senderName = await this.nameResolver.resolve(senderJid, isGroup ? remoteJid : undefined);
            const extracted = this.extractMessageContent(msg);
            const phone = '+' + senderJid.split('@')[0];
            this.options.logger.warn(
              { jid: remoteJid, sender: senderName || phone, contentPreview: extracted?.content?.slice(0, 80) },
              'Message from non-whitelisted conversation (first message logged)',
            );
          } else {
            this.options.logger.debug({ jid: remoteJid }, 'Message dropped: not whitelisted');
          }
          continue;
        }

        const formatted = await this.processMessage(msg, remoteJid, entry);
        if (formatted) {
          this.options.onMessage(formatted);
        }
      }
    });
  }

  private async processMessage(
    msg: any,
    remoteJid: string,
    entry: WhitelistEntry,
  ): Promise<FormattedMessage | null> {
    const isGroup = remoteJid.endsWith('@g.us');
    const senderJid =
      (typeof msg.key.participant === 'string' && msg.key.participant)
      || remoteJid;

    const senderName = await this.nameResolver.resolve(senderJid, isGroup ? remoteJid : undefined);
    const displaySenderName = senderName || '+' + senderJid.split('@')[0];
    const groupName = isGroup ? await this.nameResolver.getGroupName(remoteJid) : undefined;
    const mentions = this.extractMentionIds(msg.message);
    const mentionNames = await this.nameResolver.resolveMentions(mentions, isGroup ? remoteJid : undefined);
    const botJid = this.sock?.user?.id as string | undefined;
    const botLid = this.sock?.user?.lid as string | undefined;
    const isMentioned = this.isBotMentioned(mentions, botJid, botLid);

    const timestamp = msg.messageTimestamp
      ? new Date(Number(String(msg.messageTimestamp)) * 1000)
      : new Date();

    const timeStr = this.formatTime(timestamp);
    const prefix = isGroup && groupName
      ? `[${timeStr} ${displaySenderName} | ${groupName}] `
      : `[${timeStr} ${displaySenderName}] `;

    const messageKey = this.toMessageKeyReference(msg.key, remoteJid);
    const messageId = messageKey.id;
    const reactionContext = this.extractReactionContext(msg.message);

    if (reactionContext) {
      const reaction = await this.resolveReactionEvent(reactionContext, remoteJid, isGroup ? remoteJid : undefined);
      const content = prefix + this.formatReactionContent(reaction);

      return {
        jid: remoteJid,
        senderJid,
        senderName: displaySenderName,
        content,
        timestamp,
        isGroup,
        isMentioned,
        mediaSaved: [],
        messageId,
        messageKey,
        reaction,
      };
    }

    const extracted = this.extractMessageContent(msg);
    if (!extracted) return null;

    const messageText = this.substituteMentions(extracted.content, mentionNames);
    const mediaSaved: SavedMedia[] = [];

    if (this.options.mediaEnabled) {
      const mediaResult = await this.downloadAndSaveMedia(msg, entry.label, timestamp);
      if (mediaResult) {
        mediaSaved.push(mediaResult.saved);
      }
    }

    const replyContext = this.extractReplyContext(msg.message);
    const replyTo = replyContext
      ? await this.resolveReplyReference(replyContext, remoteJid, isGroup ? remoteJid : undefined)
      : undefined;

    let content = prefix;
    if (replyTo) {
      content += this.formatReplyHeader(replyTo) + '\n';
    }
    content += messageText;

    if (mediaSaved.length > 0) {
      content += `\nSaved to: ${mediaSaved.map((m) => m.relativePath).join(', ')}`;
    }

    const formatted: FormattedMessage = {
      jid: remoteJid,
      senderJid,
      senderName: displaySenderName,
      content,
      timestamp,
      isGroup,
      isMentioned,
      mediaSaved,
      messageId,
      messageKey,
      replyTo,
    };

    this.rememberMessage(formatted, msg);

    if (isGroup) {
      this.bufferLookbehind(remoteJid, formatted);
    }

    return formatted;
  }

  getLookbehind(groupJid: string, excludeMessageId?: string): FormattedMessage[] {
    const messages = this.lookbehindBuffer.get(groupJid) || [];
    this.lookbehindBuffer.delete(groupJid);
    return excludeMessageId ? messages.filter((m) => m.messageId !== excludeMessageId) : messages;
  }

  markForwarded(msg: FormattedMessage | MessageReference): void {
    const conversation = 'jid' in msg ? msg.jid : msg.conversation;
    const cached = this.messageReferences.get(this.referenceKey(conversation, msg.messageId));
    if (cached) cached.forwardedToMcp = true;
    msg.forwardedToMcp = true;
  }

  private bufferLookbehind(groupJid: string, msg: FormattedMessage): void {
    const now = Date.now();
    const buffer = this.lookbehindBuffer.get(groupJid) || [];
    const pruned = buffer.filter((m) => now - m.timestamp.getTime() < 3 * 60 * 1000);
    pruned.push(msg);
    this.lookbehindBuffer.set(groupJid, pruned);
  }

  private registerBotIdentity(): void {
    const user = this.sock?.user;
    if (!user) return;
    const jid = typeof user.id === 'string' ? user.id : undefined;
    const lid = typeof user.lid === 'string' ? user.lid : undefined;
    const name = (typeof user.name === 'string' && user.name.trim()) || undefined;
    if (jid && lid && name) {
      this.nameResolver.registerBot(jid, lid, name);
    }
  }

  private isBotMentioned(mentions: string[], botJid?: string, botLid?: string): boolean {
    return mentions.some((m) => {
      const canonical = this.canonicalJid(m);
      if (botJid && this.canonicalJid(botJid) === canonical) return true;
      if (botLid && this.canonicalJid(botLid) === canonical) return true;
      return false;
    });
  }

  private formatTime(date: Date): string {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  private canonicalJid(raw: string): string {
    const text = raw.trim().toLowerCase();
    const [localAndDevice, domain] = text.split('@', 2);
    const local = localAndDevice?.split(':', 1)[0] || '';
    return domain ? `${local}@${domain}` : local;
  }

  private substituteMentions(content: string, mentionNames: Map<string, string>): string {
    return content.replace(/@(\d+)(:\d+)?/g, (match, phone) => {
      const name = mentionNames.get(phone);
      return name ? `@${name}` : match;
    });
  }

  private extractMentionIds(message: unknown): string[] {
    const context = this.extractContextInfo(message);

    if (!Array.isArray(context?.mentionedJid)) return [];
    return (context.mentionedJid as unknown[]).filter((v): v is string => typeof v === 'string');
  }

  private extractContextInfo(message: unknown): Record<string, unknown> | undefined {
    const unwrapped = this.unwrapMessageContent(message) as Record<string, unknown> | null;
    if (!unwrapped || typeof unwrapped !== 'object') return undefined;

    const candidates = [
      unwrapped.extendedTextMessage,
      unwrapped.imageMessage,
      unwrapped.videoMessage,
      unwrapped.documentMessage,
      unwrapped.audioMessage,
      unwrapped.stickerMessage,
    ];

    for (const candidate of candidates) {
      const context = (candidate as Record<string, unknown> | undefined)?.contextInfo;
      if (context && typeof context === 'object') return context as Record<string, unknown>;
    }

    return undefined;
  }

  private extractReplyContext(message: unknown): RawReplyContext | null {
    const context = this.extractContextInfo(message);
    if (!context || typeof context.stanzaId !== 'string' || !context.stanzaId) return null;

    return {
      messageId: context.stanzaId,
      conversation: typeof context.remoteJid === 'string' ? context.remoteJid : undefined,
      participant: typeof context.participant === 'string' ? context.participant : undefined,
      quotedMessage: context.quotedMessage,
    };
  }

  private extractReactionContext(message: unknown): RawReactionContext | null {
    const unwrapped = this.unwrapMessageContent(message) as Record<string, unknown> | null;
    const reaction = unwrapped?.reactionMessage as Record<string, unknown> | undefined;
    if (!reaction || typeof reaction !== 'object') return null;

    const key = reaction.key as WAMessageKey | undefined;
    if (!key?.id) {
      this.options.logger.debug({ reaction }, 'Reaction message missing target key');
      return null;
    }

    const emoji = typeof reaction.text === 'string' ? reaction.text : '';
    return {
      emoji,
      removed: emoji.length === 0,
      key,
    };
  }

  private unwrapMessageContent(message: unknown): unknown {
    let current = message;
    while (current && typeof current === 'object') {
      const next =
        (current as any).ephemeralMessage?.message
        || (current as any).viewOnceMessage?.message
        || (current as any).viewOnceMessageV2?.message
        || (current as any).viewOnceMessageV2Extension?.message
        || (current as any).documentWithCaptionMessage?.message
        || (current as any).editedMessage?.message;
      if (!next || next === current) return current;
      current = next;
    }
    return current;
  }

  private extractMessageContent(msg: unknown): { content: string } | null {
    return this.extractContentFromMessage((msg as any)?.message);
  }

  private extractContentFromMessage(messageContent: unknown): { content: string } | null {
    const message = this.unwrapMessageContent(messageContent) as Record<string, unknown>;
    if (!message) return null;

    if (typeof message.conversation === 'string') {
      return { content: message.conversation };
    }

    const extendedText = message.extendedTextMessage as Record<string, unknown> | undefined;
    if (typeof extendedText?.text === 'string') {
      return { content: extendedText.text };
    }

    const imageMessage = message.imageMessage as Record<string, unknown> | undefined;
    if (imageMessage) {
      const caption = typeof imageMessage.caption === 'string' ? imageMessage.caption : '';
      return { content: `[Image${caption ? ': ' + caption : ''}]` };
    }

    const videoMessage = message.videoMessage as Record<string, unknown> | undefined;
    if (videoMessage) {
      const caption = typeof videoMessage.caption === 'string' ? videoMessage.caption : '';
      return { content: `[Video${caption ? ': ' + caption : ''}]` };
    }

    const documentMessage = message.documentMessage as Record<string, unknown> | undefined;
    if (documentMessage) {
      return { content: `[Document]` };
    }

    const audioMessage = message.audioMessage as Record<string, unknown> | undefined;
    if (audioMessage) {
      const isVoice = audioMessage.ptt === true;
      return { content: isVoice ? '[Voice Message]' : '[Audio]' };
    }

    return null;
  }

  private async resolveReplyReference(
    reply: RawReplyContext,
    currentConversation: string,
    groupJid?: string,
  ): Promise<MessageReference> {
    const conversation = reply.conversation || currentConversation;
    const cached = this.getCachedReference(conversation, reply.messageId);
    if (cached) return this.publicReference(cached);

    const preview = this.previewFromQuotedMessage(reply.quotedMessage, '[Quoted Message]');
    const senderName = reply.participant
      ? await this.nameResolver.resolve(reply.participant, groupJid)
      : undefined;

    return {
      messageId: reply.messageId,
      conversation,
      senderJid: reply.participant,
      senderName,
      preview,
      messageKey: {
        id: reply.messageId,
        remoteJid: conversation,
        fromMe: false,
        participant: reply.participant,
      },
    };
  }

  private async resolveReactionEvent(
    reaction: RawReactionContext,
    currentConversation: string,
    groupJid?: string,
  ): Promise<ReactionEvent> {
    const conversation = reaction.key.remoteJid || currentConversation;
    const messageId = reaction.key.id as string;
    const cached = this.getCachedReference(conversation, messageId);

    if (cached) {
      return {
        emoji: reaction.emoji,
        removed: reaction.removed,
        target: this.publicReference(cached),
      };
    }

    const participant = typeof reaction.key.participant === 'string' ? reaction.key.participant : undefined;
    const senderName = participant ? await this.nameResolver.resolve(participant, groupJid) : undefined;

    return {
      emoji: reaction.emoji,
      removed: reaction.removed,
      target: {
        messageId,
        conversation,
        senderJid: participant,
        senderName,
        preview: '[Unknown Message]',
        messageKey: this.toMessageKeyReference(reaction.key, conversation),
      },
    };
  }

  private formatReplyHeader(reference: MessageReference): string {
    const sender = reference.senderName || reference.senderJid || 'unknown';
    const id = this.shortMessageId(reference.messageId);
    if (reference.forwardedToMcp) {
      return `Replying to ${sender} (msg ${id})`;
    }
    return `Replying to ${sender} (msg ${id}): "${this.truncatePreview(reference.preview)}"`;
  }

  private formatReactionContent(reaction: ReactionEvent): string {
    const target = reaction.target;
    const sender = target.senderName || target.senderJid || 'unknown';
    const id = this.shortMessageId(target.messageId);
    const targetText = target.forwardedToMcp
      ? `${sender} (msg ${id})`
      : `${sender} (msg ${id}): "${this.truncatePreview(target.preview)}"`;

    if (reaction.removed) {
      return `Removed reaction from ${targetText}`;
    }

    return `Reacted ${reaction.emoji} to ${targetText}`;
  }

  private previewFromQuotedMessage(quotedMessage: unknown, fallback: string): string {
    const extracted = this.extractContentFromMessage(quotedMessage);
    return this.truncatePreview(extracted?.content || fallback);
  }

  private truncatePreview(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= REFERENCE_PREVIEW_LIMIT) return normalized;
    return normalized.slice(0, REFERENCE_PREVIEW_LIMIT - 3).trimEnd() + '...';
  }

  private shortMessageId(messageId: string): string {
    return messageId.length <= 8 ? messageId : messageId.slice(0, 8);
  }

  private rememberMessage(formatted: FormattedMessage, rawMessage: WAMessage): void {
    if (!formatted.messageId || formatted.messageId === 'unknown') return;

    this.pruneMessageReferences();

    this.messageReferences.set(this.referenceKey(formatted.jid, formatted.messageId), {
      messageId: formatted.messageId,
      conversation: formatted.jid,
      senderJid: formatted.senderJid,
      senderName: formatted.senderName,
      timestamp: formatted.timestamp,
      preview: this.previewFromFormattedContent(formatted),
      mediaPaths: formatted.mediaSaved.map((m) => m.relativePath),
      messageKey: formatted.messageKey,
      rawMessage,
      lastSeenAt: Date.now(),
      forwardedToMcp: false,
    });

    this.pruneMessageReferences();
  }

  private rememberOutboundMessage(
    conversation: string,
    text: string,
    rawMessage: WAMessage | undefined,
    imagePathLabel?: string,
  ): void {
    if (!rawMessage?.key?.id) return;

    const senderJid = typeof this.sock?.user?.id === 'string' ? this.sock.user.id : undefined;
    const senderName = (typeof this.sock?.user?.name === 'string' && this.sock.user.name.trim()) || 'me';
    const timestamp = rawMessage.messageTimestamp
      ? new Date(Number(String(rawMessage.messageTimestamp)) * 1000)
      : new Date();
    const preview = imagePathLabel
      ? `[Image${text ? ': ' + text : ''}]`
      : text;

    this.pruneMessageReferences();

    this.messageReferences.set(this.referenceKey(conversation, rawMessage.key.id), {
      messageId: rawMessage.key.id,
      conversation,
      senderJid,
      senderName,
      timestamp,
      preview: this.truncatePreview(preview),
      mediaPaths: [],
      messageKey: this.toMessageKeyReference(rawMessage.key, conversation),
      rawMessage,
      lastSeenAt: Date.now(),
      forwardedToMcp: true,
    });

    this.pruneMessageReferences();
  }

  private previewFromFormattedContent(msg: FormattedMessage): string {
    const withoutPrefix = msg.content.replace(/^\[[^\]]+\]\s*/, '');
    const lines = withoutPrefix.split('\n').filter((line) => line.trim().length > 0);
    const firstLine = msg.replyTo && lines.length > 1 ? lines[1] : lines[0] || withoutPrefix;
    return this.truncatePreview(firstLine);
  }

  private publicReference(cached: CachedMessageReference): MessageReference {
    return {
      messageId: cached.messageId,
      conversation: cached.conversation,
      senderJid: cached.senderJid,
      senderName: cached.senderName,
      timestamp: cached.timestamp,
      preview: cached.preview,
      mediaPaths: cached.mediaPaths,
      messageKey: cached.messageKey,
      forwardedToMcp: cached.forwardedToMcp,
    };
  }

  private getCachedReference(conversation: string, messageId: string): CachedMessageReference | undefined {
    this.pruneMessageReferences();
    return this.messageReferences.get(this.referenceKey(conversation, messageId));
  }

  private requireCachedReference(conversation: string, messageId: string): CachedMessageReference {
    const cached = this.getCachedReference(conversation, messageId);
    if (!cached) {
      throw new Error(`Referenced message ${messageId} is no longer available`);
    }
    return cached;
  }

  private referenceKey(conversation: string | undefined, messageId: string): string {
    return `${conversation || ''}:${messageId}`;
  }

  private pruneMessageReferences(): void {
    const now = Date.now();
    for (const [key, reference] of this.messageReferences) {
      if (now - reference.lastSeenAt > MESSAGE_REFERENCE_TTL_MS) {
        this.messageReferences.delete(key);
      }
    }

    while (this.messageReferences.size > MESSAGE_REFERENCE_MAX) {
      const oldest = this.messageReferences.keys().next().value as string | undefined;
      if (!oldest) break;
      this.messageReferences.delete(oldest);
    }
  }

  private toMessageKeyReference(key: WAMessageKey, fallbackRemoteJid: string): MessageKeyReference {
    return {
      id: key.id || 'unknown',
      remoteJid: key.remoteJid || fallbackRemoteJid,
      fromMe: key.fromMe === true,
      participant: typeof key.participant === 'string' ? key.participant : undefined,
    };
  }

  private async downloadAndSaveMedia(
    msg: unknown,
    channelLabel: string,
    timestamp: Date,
  ): Promise<{ saved: SavedMedia } | null> {
    if (!this.sock) return null;

    const fullMsg = msg as any;
    const mediaMsg = fullMsg.message?.imageMessage
      || fullMsg.message?.videoMessage
      || fullMsg.message?.audioMessage
      || fullMsg.message?.documentMessage;

    if (!mediaMsg) return null;

    try {
      const buffer = await downloadMediaMessage(
        fullMsg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage },
      );
      if (!buffer) return null;

      const mediaType = mediaMsg.mimetype || 'application/octet-stream';
      const originalName = typeof mediaMsg.fileName === 'string' ? mediaMsg.fileName : null;
      const messageId = fullMsg.key.id || 'unknown';

      const saved = saveMedia(
        this.options.mediaBaseDir,
        channelLabel,
        timestamp,
        buffer as Buffer,
        mediaType,
        originalName,
        messageId,
      );

      if (saved) {
        this.options.logger.info(
          { path: saved.relativePath, channel: channelLabel },
          'Media saved',
        );
      }

      return saved ? { saved } : null;
    } catch (err) {
      this.options.logger.error({ err }, 'Failed to download and save media');
      return null;
    }
  }

  async sendMessage(
    to: string,
    text: string,
    imageBase64?: string,
    imageMimeType?: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp');
    }

    const quoted = replyToMessageId
      ? this.requireCachedReference(to, replyToMessageId).rawMessage
      : undefined;
    let sent: WAMessage | undefined;

    if (imageBase64) {
      sent = await this.sock.sendMessage(to, {
        image: Buffer.from(imageBase64, 'base64'),
        mimetype: imageMimeType || 'image/jpeg',
        caption: text || undefined,
      }, quoted ? { quoted } : undefined);
      this.rememberOutboundMessage(to, text, sent, 'image');
      return;
    }

    sent = await this.sock.sendMessage(to, { text }, quoted ? { quoted } : undefined);
    this.rememberOutboundMessage(to, text, sent);
  }

  async sendReaction(to: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp');
    }

    if (emoji.includes('\n') || emoji.length > 32) {
      throw new Error('Reaction emoji must be a short single-line string');
    }

    const target = this.requireCachedReference(to, messageId);
    const sent = await this.sock.sendMessage(to, {
      react: {
        text: emoji,
        key: target.rawMessage.key,
      },
    });
    this.rememberOutboundMessage(to, emoji ? `Reacted ${emoji}` : 'Removed reaction', sent);
  }

  async listGroups(): Promise<Array<{ jid: string; subject: string }>> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp');
    }
    const all = await this.sock.groupFetchAllParticipating();
    return Object.entries(all).map(([jid, meta]) => ({
      jid,
      subject: meta.subject ?? '',
    }));
  }

  private persistContacts(contacts: Array<Partial<{ id: string; name: string; notify: string; verifiedName: string }>>): void {
    const db = this.options.contactsDb;
    if (!db) return;
    const records = contacts
      .filter((c) => c.id && !c.id.endsWith('@g.us') && c.id !== 'status@broadcast')
      .map((c) => ({
        jid: c.id!,
        name: c.name ?? undefined,
        notify: c.notify ?? undefined,
        verifiedName: c.verifiedName ?? undefined,
      }));
    if (!records.length) return;
    try {
      db.upsertContacts(records);
    } catch (err) {
      this.options.logger.error({ err }, 'persistContacts failed');
    }
  }

  private persistGroups(groups: Array<{ id: string; subject?: string; owner?: string; creation?: number; size?: number }>): void {
    const db = this.options.contactsDb;
    if (!db) return;
    const records = groups
      .filter((g) => g.id && g.subject)
      .map((g) => ({
        jid: g.id,
        subject: g.subject!,
        owner: g.owner,
        creation: g.creation,
        size: g.size,
      }));
    if (!records.length) return;
    try {
      db.upsertGroups(records);
    } catch (err) {
      this.options.logger.error({ err }, 'persistGroups failed');
    }
  }

  private async maybeInitialGroupSync(): Promise<void> {
    const db = this.options.contactsDb;
    if (!db) return;
    if (db.countGroups() > 0) {
      this.options.logger.info({ groups: db.countGroups() }, 'group table populated; skipping initial sync');
      return;
    }
    this.options.logger.info('group table empty; running initial sync');
    await this.syncGroups();
  }

  async syncGroups(): Promise<number> {
    const db = this.options.contactsDb;
    if (!db) return 0;
    if (!this.sock) throw new Error('Not connected to WhatsApp');
    const all = await this.sock.groupFetchAllParticipating();
    const records = Object.entries(all).map(([jid, meta]) => ({
      jid,
      subject: meta.subject ?? '',
      owner: meta.owner ?? undefined,
      creation: typeof meta.creation === 'number' ? meta.creation : undefined,
      size: typeof meta.size === 'number' ? meta.size : undefined,
    }));
    const written = db.upsertGroups(records);
    db.setMeta('last_group_sync_at', String(Date.now()));
    this.options.logger.info({ groups: written }, 'group sync completed');
    return written;
  }

  contactsDbCounts(): { contacts: number; groups: number } | undefined {
    const db = this.options.contactsDb;
    if (!db) return undefined;
    return { contacts: db.countContacts(), groups: db.countGroups() };
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }
}
