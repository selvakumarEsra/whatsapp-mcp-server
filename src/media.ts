import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function padDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function padTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}${m}${s}`;
}

export interface SavedMedia {
  path: string;
  relativePath: string;
}

export function saveMedia(
  baseDir: string,
  channelLabel: string,
  timestamp: Date,
  buffer: Buffer,
  mediaType: string,
  originalName?: string | null,
  messageId?: string,
): SavedMedia | null {
  const slug = slugify(channelLabel);
  const dateStr = padDate(timestamp);
  const timeStr = padTime(timestamp);

  let filename: string;
  if (originalName) {
    filename = `${timeStr}_${originalName}`;
  } else {
    const ext = mediaType.startsWith('image') ? '.jpg'
      : mediaType.startsWith('audio') ? '.ogg'
      : mediaType.startsWith('video') ? '.mp4'
      : '.bin';
    const id = messageId || 'unknown';
    filename = `${timeStr}_${mediaType.split('/')[0]}_${id}${ext}`;
  }

  const dir = join(baseDir, slug, dateStr);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  const fullPath = join(dir, filename);
  try {
    writeFileSync(fullPath, buffer);
  } catch {
    return null;
  }

  const relativePath = join(slug, dateStr, filename);
  return { path: fullPath, relativePath };
}
