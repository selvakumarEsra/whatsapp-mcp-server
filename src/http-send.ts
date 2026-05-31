import { createServer, IncomingMessage, ServerResponse } from 'http';
import { writeFileSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import pino from 'pino';
import { WhatsAppClient } from './whatsapp.js';
import { ContactsDb } from './contacts-db.js';

export interface HttpSendOptions {
  port: number;
  tokenFile: string;
  whitelist: Set<string>;
  client: WhatsAppClient;
  logger: pino.Logger;
  contactsDb?: ContactsDb;
}

interface SendRequest {
  conversation?: string;
  text?: string;
  replyToMessageId?: string;
  imageBase64?: string;
  imageMimeType?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, payload: object): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function startHttpSend(options: HttpSendOptions): void {
  const token = randomBytes(24).toString('hex');
  writeFileSync(options.tokenFile, token, { mode: 0o600 });
  try {
    chmodSync(options.tokenFile, 0o600);
  } catch {
    // best effort
  }

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/groups') {
      try {
        const groups = await options.client.listGroups();
        reply(res, 200, { groups });
      } catch (err) {
        options.logger.error({ err }, 'HTTP /groups failed');
        reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/sync/groups') {
      try {
        const written = await options.client.syncGroups();
        reply(res, 200, { written });
      } catch (err) {
        options.logger.error({ err }, 'HTTP /sync/groups failed');
        reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/db/stats') {
      const stats = options.client.contactsDbCounts();
      if (!stats) {
        reply(res, 404, { error: 'database not configured' });
        return;
      }
      reply(res, 200, stats);
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/dedup/check')) {
      if (!options.contactsDb) {
        reply(res, 404, { error: 'database not configured' });
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) {
        reply(res, 400, { error: 'id query param required' });
        return;
      }
      reply(res, 200, { id, forwarded: options.contactsDb.wasForwarded(id) });
      return;
    }

    if (req.method === 'POST' && req.url === '/dedup/mark') {
      if (!options.contactsDb) {
        reply(res, 404, { error: 'database not configured' });
        return;
      }
      let body: { id?: string; source?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        reply(res, 400, { error: 'invalid json' });
        return;
      }
      if (typeof body.id !== 'string' || typeof body.source !== 'string') {
        reply(res, 400, { error: 'id and source are required strings' });
        return;
      }
      const inserted = options.contactsDb.markForwarded(body.id, body.source);
      reply(res, 200, { id: body.id, source: body.source, inserted });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/send') {
      reply(res, 404, { error: 'not found' });
      return;
    }

    let body: SendRequest;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      reply(res, 400, { error: 'invalid json' });
      return;
    }

    const { conversation, text, replyToMessageId, imageBase64, imageMimeType } = body;
    if (typeof conversation !== 'string' || typeof text !== 'string') {
      reply(res, 400, { error: 'conversation and text are required strings' });
      return;
    }
    if (!options.whitelist.has(conversation)) {
      reply(res, 403, { error: `conversation ${conversation} is not whitelisted` });
      return;
    }

    try {
      await options.client.sendMessage(conversation, text, imageBase64, imageMimeType, replyToMessageId);
      options.logger.info({ jid: conversation, preview: text.slice(0, 80) }, 'HTTP send delivered');
      reply(res, 200, { status: 'sent' });
    } catch (err) {
      options.logger.error({ err, jid: conversation }, 'HTTP send failed');
      reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on('error', (err) => {
    options.logger.error({ err }, 'HTTP send server error');
  });

  server.listen(options.port, '127.0.0.1', () => {
    options.logger.info({ port: options.port, tokenFile: options.tokenFile }, 'HTTP send endpoint listening');
  });
}
