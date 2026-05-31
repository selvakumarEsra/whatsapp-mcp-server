import { readFileSync } from 'fs';

export interface WhitelistEntry {
  type: 'dm' | 'group';
  label: string;
}

export interface MediaConfig {
  enabled: boolean;
  baseDir: string;
  sendRoot?: string;
}

export interface LoggingConfig {
  level: string;
  file: string;
}

export interface HttpSendConfig {
  port: number;
  tokenFile: string;
}

export interface DatabaseConfig {
  file: string;
  groupSyncIntervalHours?: number;
}

export interface AppConfig {
  conversations: Record<string, WhitelistEntry>;
  authDir: string;
  media: MediaConfig;
  logging: LoggingConfig;
  contacts?: Record<string, string>;
  http?: HttpSendConfig;
  database?: DatabaseConfig;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.WHATSAPP_CONFIG;
  if (!configPath) {
    throw new Error('WHATSAPP_CONFIG env var is not set');
  }

  return JSON.parse(readFileSync(configPath, 'utf-8'));
}
