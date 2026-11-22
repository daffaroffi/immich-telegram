/**
 * Telegram Storage Configuration
 * Mapping of environment variables to typed config (see PLAN-TELEGRAM-BACKEND.md).
 */

export interface TelegramStorageConfig {
  enabled: boolean;
  apiId: number;
  apiHash: string;
  chatId: bigint;
  sessionPath: string;
  vaultKey: Buffer | null;
  /** Upload budget per calendar day in megabytes. Telegram default: 2048. */
  dailyUploadLimitMb: number;
}

export const DEFAULT_TELEGRAM_CONFIG: Omit<TelegramStorageConfig, 'apiId' | 'apiHash' | 'chatId' | 'vaultKey'> = {
  enabled: false,
  sessionPath: '/config/telegram.session',
  dailyUploadLimitMb: 2048,
};

export interface TelegramFileInfo {
  messageId: number;
  chatId: bigint;
  fileSize: number;
}

/** Envelope magic/version for our own encryption format (NOT TDENC2-compatible). */
export const TG_ENC_CONSTANTS = {
  MAGIC: 'TGVAULT',
  VERSION: 1,
  CIPHER: 'aes-256-gcm' as const,
  KEY_SIZE: 32,
  IV_SIZE: 12,
  AUTH_TAG_SIZE: 16,
  CHUNK_SIZE: 1024 * 1024, // 1 MiB plaintext per chunk
} as const;
