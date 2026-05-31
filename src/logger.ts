import pino from 'pino';
import { mkdirSync, truncateSync } from 'fs';
import { dirname } from 'path';

export function createLogger(level: string, logFile: string): pino.Logger {
  const logDir = dirname(logFile);
  mkdirSync(logDir, { recursive: true });

  try {
    truncateSync(logFile);
  } catch {
    // file may not exist yet
  }

  const destination = pino.destination({ dest: logFile, sync: true });
  return pino({ level }, destination);
}
