/**
 * Telegram Storage Entity
 * Maps Immich assets to Telegram message IDs
 */
export interface TelegramStorage {
  /**
   * Immich asset ID (primary key)
   */
  assetId: string;

  /**
   * Telegram message ID for the original file
   */
  originalMessageId: number;

  /**
   * Telegram message ID for the thumbnail
   */
  thumbnailMessageId: number | null;

  /**
   * Telegram message ID for the preview
   */
  previewMessageId: number | null;

  /**
   * Telegram message ID for the encoded video
   */
  encodedVideoMessageId: number | null;

  /**
   * Telegram chat/channel ID
   */
  chatId: number;

  /**
   * Telegram file_id for fast access
   */
  fileId: string | null;

  /**
   * File size in Telegram
   */
  telegramFileSize: number | null;

  /**
   * SHA1 checksum for verification
   */
  checksum: string | null;

  /**
   * Encryption state: 'encrypted', 'plain', etc.
   */
  encryptionState: string;

  /**
   * When the file was uploaded to Telegram
   */
  uploadedAt: Date;

  /**
   * Last time the file was accessed
   */
  lastAccessedAt: Date | null;
}

/**
 * Database table name
 */
export const TELEGRAM_STORAGE_TABLE = 'telegram_storage';

/**
 * SQL for creating the telegram_storage table
 */
export const CREATE_TELEGRAM_STORAGE_TABLE = `
CREATE TABLE IF NOT EXISTS ${TELEGRAM_STORAGE_TABLE} (
  -- Primary key (references asset table)
  asset_id UUID PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,

  -- Telegram message IDs
  original_message_id BIGINT NOT NULL,
  thumbnail_message_id BIGINT,
  preview_message_id BIGINT,
  encoded_video_message_id BIGINT,

  -- Telegram metadata
  chat_id BIGINT NOT NULL,
  file_id VARCHAR(255),
  telegram_file_size BIGINT,

  -- Integrity
  checksum VARCHAR(255),
  encryption_state VARCHAR(20) DEFAULT 'encrypted',

  -- Timestamps
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_telegram_storage_checksum ON ${TELEGRAM_STORAGE_TABLE}(checksum);
CREATE INDEX IF NOT EXISTS idx_telegram_storage_chat_id ON ${TELEGRAM_STORAGE_TABLE}(chat_id);
CREATE INDEX IF NOT EXISTS idx_telegram_storage_uploaded_at ON ${TELEGRAM_STORAGE_TABLE}(uploaded_at);
`;

/**
 * SQL for dropping the telegram_storage table
 */
export const DROP_TELEGRAM_STORAGE_TABLE = `DROP TABLE IF EXISTS ${TELEGRAM_STORAGE_TABLE};`;
