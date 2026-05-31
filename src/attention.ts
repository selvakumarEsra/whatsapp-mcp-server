import pino from 'pino';

const ATTENTION_TIMEOUT_MS = 3 * 60 * 1000;

export class AttentionManager {
  private windows = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
  private logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger;
  }

  isActive(groupJid: string): boolean {
    return this.windows.has(groupJid);
  }

  open(groupJid: string, label: string): void {
    const existing = this.windows.get(groupJid);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.windows.delete(groupJid);
      this.logger.info({ groupJid, label }, 'Attention window expired');
    }, ATTENTION_TIMEOUT_MS);

    this.windows.set(groupJid, { timer });

    if (!existing) {
      this.logger.info({ groupJid, label }, 'Attention window opened');
    }
  }

  reset(groupJid: string): void {
    const existing = this.windows.get(groupJid);
    if (!existing) return;

    clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.windows.delete(groupJid);
      this.logger.info({ groupJid }, 'Attention window expired');
    }, ATTENTION_TIMEOUT_MS);

    existing.timer = timer;
    this.logger.debug({ groupJid, remainingMs: ATTENTION_TIMEOUT_MS }, 'Attention window reset');
  }

  shouldForward(groupJid: string, isMentioned: boolean): boolean {
    if (isMentioned) return true;
    return this.windows.has(groupJid);
  }

  destroy(): void {
    for (const w of this.windows.values()) {
      clearTimeout(w.timer);
    }
    this.windows.clear();
  }
}
