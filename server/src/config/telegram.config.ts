/**
 * Telegram Storage Configuration
 * Configuration types for Telegram MTProto storage integration
 */

export interface TelegramAccountConfig {
  id: string;
  apiId: number;
  apiHash: string;
  sessionPath: string;
  chatId: bigint;
  label: string;
}

export interface TelegramStorageConfig {
  enabled: boolean;
  accounts: TelegramAccountConfig[];
  encryptionEnabled: boolean;
  vaultKey?: Buffer;
  cacheSizeMb: number;
  cacheTtlHours: number;
  concurrentUploads: number;
  concurrentDownloads: number;
  uploadDelayMs: number;
  maxRetries: number;
}

export interface TelegramFileInfo {
  messageId: number;
  fileId: string;
  fileSize: number;
  chatId: bigint;
}

export interface Tdenc2KeySlot {
  kind: 'vault' | 'passphrase' | 'recovery';
  slotId: number;
  kdfAlgorithm: number;
  argon2Memory: number;
  argon2Iterations: number;
  argon2Parallelism: number;
  salt: Buffer;
  wrapNonce: Buffer;
  wrappedDek: Buffer;
}

export interface Tdenc2Header {
  magic: string;
  version: number;
  fileUuid: Buffer;
  cipherSuite: number;
  headerLength: number;
  chunkSize: number;
  slotTableLength: number;
  metadataLength: number;
  plaintextLength: bigint;
  noncePrefix: Buffer;
  headerAuth: Buffer;
  keySlots: Tdenc2KeySlot[];
  encryptedMetadata?: Buffer;
}

export interface TelegramCacheEntry {
  key: string;
  filePath: string;
  size: number;
  lastAccessed: Date;
  hitCount: number;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramStorageConfig = {
  enabled: false,
  accounts: [],
  encryptionEnabled: true,
  cacheSizeMb: 5120,
  cacheTtlHours: 168, // 1 week
  concurrentUploads: 4,
  concurrentDownloads: 8,
  uploadDelayMs: 1000,
  maxRetries: 3,
};

export const TDENC2_CONSTANTS = {
  MAGIC: 'TDENC2',
  VERSION: 2,
  CIPHER_SUITE_XCHACHA20_POLY1305: 1,
  DEFAULT_CHUNK_SIZE: 1048576, // 1 MiB
  KEY_SIZE: 32,
  NONCE_SIZE: 24,
  POLY1305_TAG_SIZE: 16,
  ARGON2_MEMORY_DEFAULT: 65536, // 64 MiB
  ARGON2_ITERATIONS_DEFAULT: 3,
  ARGON2_PARALLELISM_DEFAULT: 4,
} as const;
