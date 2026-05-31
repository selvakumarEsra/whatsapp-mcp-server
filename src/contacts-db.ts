import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import pino from 'pino';

export interface ContactRecord {
  jid: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}

export interface GroupRecord {
  jid: string;
  subject: string;
  owner?: string;
  creation?: number;
  size?: number;
}

export class ContactsDb {
  private db: DatabaseSync;
  private logger: pino.Logger;
  private upsertContactStmt: StatementSync;
  private upsertGroupStmt: StatementSync;
  private countContactsStmt: StatementSync;
  private countGroupsStmt: StatementSync;
  private getMetaStmt: StatementSync;
  private setMetaStmt: StatementSync;
  private wasForwardedStmt: StatementSync;
  private markForwardedStmt: StatementSync;

  constructor(file: string, logger: pino.Logger) {
    this.logger = logger;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        verified_name TEXT,
        last_synced_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS groups (
        jid TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        owner TEXT,
        creation INTEGER,
        size INTEGER,
        last_synced_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forwarded_messages (
        message_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forwarded_sent_at ON forwarded_messages(sent_at);
    `);

    this.upsertContactStmt = this.db.prepare(`
      INSERT INTO contacts (jid, name, notify, verified_name, last_synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, contacts.name),
        notify = COALESCE(excluded.notify, contacts.notify),
        verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
        last_synced_at = excluded.last_synced_at
    `);

    this.upsertGroupStmt = this.db.prepare(`
      INSERT INTO groups (jid, subject, owner, creation, size, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        subject = excluded.subject,
        owner = COALESCE(excluded.owner, groups.owner),
        creation = COALESCE(excluded.creation, groups.creation),
        size = COALESCE(excluded.size, groups.size),
        last_synced_at = excluded.last_synced_at
    `);

    this.countContactsStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM contacts`);
    this.countGroupsStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM groups`);
    this.getMetaStmt = this.db.prepare(`SELECT value FROM sync_state WHERE key = ?`);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO sync_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.wasForwardedStmt = this.db.prepare(`SELECT 1 FROM forwarded_messages WHERE message_id = ?`);
    this.markForwardedStmt = this.db.prepare(`
      INSERT INTO forwarded_messages (message_id, source, sent_at) VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `);
  }

  wasForwarded(messageId: string): boolean {
    return this.wasForwardedStmt.get(messageId) !== undefined;
  }

  markForwarded(messageId: string, source: string): boolean {
    const result = this.markForwardedStmt.run(messageId, source, Date.now());
    const changes = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
    return changes > 0;
  }

  upsertContacts(records: ContactRecord[]): number {
    if (records.length === 0) return 0;
    const now = Date.now();
    let written = 0;
    const txn = this.db.prepare('BEGIN');
    txn.run();
    try {
      for (const r of records) {
        if (!r.jid) continue;
        this.upsertContactStmt.run(
          r.jid,
          r.name ?? null,
          r.notify ?? null,
          r.verifiedName ?? null,
          now,
        );
        written++;
      }
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
    return written;
  }

  upsertGroups(records: GroupRecord[]): number {
    if (records.length === 0) return 0;
    const now = Date.now();
    let written = 0;
    const txn = this.db.prepare('BEGIN');
    txn.run();
    try {
      for (const r of records) {
        if (!r.jid || !r.subject) continue;
        this.upsertGroupStmt.run(
          r.jid,
          r.subject,
          r.owner ?? null,
          r.creation ?? null,
          r.size ?? null,
          now,
        );
        written++;
      }
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
    return written;
  }

  countContacts(): number {
    return (this.countContactsStmt.get() as { n: number }).n;
  }

  countGroups(): number {
    return (this.countGroupsStmt.get() as { n: number }).n;
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
