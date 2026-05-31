import pino from 'pino';

interface ContactIndex {
  byJid: Map<string, string>;
  byPhone: Map<string, string>;
}

export class NameResolver {
  private contacts: ContactIndex = { byJid: new Map(), byPhone: new Map() };
  private groups = new Map<string, { names: Map<string, string>; lidToPhone: Map<string, string> }>();
  private groupNames = new Map<string, string>();
  private sock: unknown;
  private logger: pino.Logger;

  constructor(sock: unknown, logger: pino.Logger) {
    this.sock = sock;
    this.logger = logger;
  }

  ingestContacts(contacts: unknown[]): void {
    for (const contact of contacts) {
      if (!contact || typeof contact !== 'object') continue;
      const c = contact as Record<string, unknown>;
      const name =
        (typeof c.name === 'string' && c.name.trim())
        || (typeof c.notify === 'string' && c.notify.trim())
        || (typeof c.verifiedName === 'string' && c.verifiedName.trim());
      if (!name) continue;
      this.rememberContact(c.id, name);
      this.rememberContact(c.lid, name);
      this.rememberContact(c.phoneNumber, name);
    }
  }

  registerBot(jid: string, lid: string, name: string): void {
    this.rememberContact(jid, name);
    this.rememberContact(lid, name);
  }

  loadConfigContacts(contacts: Record<string, string>): void {
    for (const [phone, name] of Object.entries(contacts)) {
      this.contacts.byPhone.set(phone, name);
    }
  }

  async resolve(jid: string, groupJid?: string): Promise<string | undefined> {
    if (groupJid?.endsWith('@g.us')) {
      await this.ensureGroupData(groupJid);
    }
    const canonical = this.canonicalJid(jid);
    const group = groupJid ? this.groups.get(groupJid) : undefined;

    return group?.names.get(canonical)
      || this.contacts.byJid.get(canonical)
      || this.contacts.byPhone.get(canonical.split('@')[0])
      || (group ? this.resolveViaLidToPhone(group, canonical) : undefined);
  }

  async resolveMentions(mentions: string[], groupJid?: string): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const mention of mentions) {
      const phone = this.canonicalJid(mention).split('@')[0];
      const resolved = await this.resolve(mention, groupJid);
      if (resolved) {
        names.set(phone, resolved);
      } else if (groupJid) {
        const group = this.groups.get(groupJid);
        const lidToPhone = group?.lidToPhone.get(this.canonicalJid(mention));
        if (lidToPhone) names.set(phone, lidToPhone);
      }
    }
    return names;
  }

  async getGroupName(groupJid: string): Promise<string | undefined> {
    if (this.groupNames.has(groupJid)) return this.groupNames.get(groupJid);
    const sock = this.sock as any;
    if (!sock) return undefined;
    try {
      const metadata = await sock.groupMetadata(groupJid);
      if (metadata?.subject) {
        this.groupNames.set(groupJid, metadata.subject);
        return metadata.subject;
      }
    } catch (err) {
      this.logger.error({ err, groupJid }, 'Failed to fetch group name');
    }
    return undefined;
  }

  private rememberContact(raw: unknown, name: string): void {
    if (typeof raw !== 'string' || !raw) return;
    const canonical = this.canonicalJid(raw);
    this.contacts.byJid.set(canonical, name);
    this.contacts.byPhone.set(canonical.split('@')[0], name);
  }

  private async ensureGroupData(groupJid: string): Promise<void> {
    if (this.groups.has(groupJid)) return;
    const sock = this.sock as any;
    if (!sock) return;
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const names = new Map<string, string>();
      const lidToPhone = new Map<string, string>();
      for (const p of metadata?.participants || []) {
        const name =
          (typeof p.name === 'string' && p.name.trim())
          || (typeof p.notify === 'string' && p.notify.trim())
          || (typeof p.verifiedName === 'string' && p.verifiedName.trim());
        if (name) {
          if (p.id) names.set(this.canonicalJid(p.id), name);
          if (p.lid) names.set(this.canonicalJid(p.lid), name);
          if (p.phoneNumber) names.set(this.canonicalJid(p.phoneNumber), name);
        }
        if (p.id && p.phoneNumber) {
          lidToPhone.set(this.canonicalJid(p.id), this.canonicalJid(p.phoneNumber).split('@')[0]);
        }
      }
      this.groups.set(groupJid, { names, lidToPhone });
    } catch (err) {
      this.logger.error({ err }, 'Failed to fetch group metadata');
    }
  }

  private resolveViaLidToPhone(group: { lidToPhone: Map<string, string> }, canonical: string): string | undefined {
    const phone = group.lidToPhone.get(canonical);
    return phone ? this.contacts.byPhone.get(phone) : undefined;
  }

  private canonicalJid(raw: string): string {
    const text = raw.trim().toLowerCase();
    const [localAndDevice, domain] = text.split('@', 2);
    const local = localAndDevice?.split(':', 1)[0] || '';
    return domain ? `${local}@${domain}` : local;
  }
}
