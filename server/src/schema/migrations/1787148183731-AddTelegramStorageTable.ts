import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create telegram_storage table
  await sql`
    CREATE TABLE IF NOT EXISTS "telegram_storage" (
      -- Primary key (references asset table)
      "asset_id" UUID PRIMARY KEY REFERENCES "asset"("id") ON DELETE CASCADE,

      -- Telegram message IDs
      "original_message_id" BIGINT NOT NULL,
      "thumbnail_message_id" BIGINT,
      "preview_message_id" BIGINT,
      "encoded_video_message_id" BIGINT,

      -- Telegram metadata
      "chat_id" BIGINT NOT NULL,
      "file_id" VARCHAR(255),
      "telegram_file_size" BIGINT,

      -- Integrity
      "checksum" VARCHAR(255),
      "encryption_state" VARCHAR(20) DEFAULT 'encrypted',

      -- Timestamps
      "uploaded_at" TIMESTAMPTZ DEFAULT NOW(),
      "last_accessed_at" TIMESTAMPTZ
    );
  `.execute(db);

  // Create indexes for fast lookups
  await sql`CREATE INDEX IF NOT EXISTS "idx_telegram_storage_checksum" ON "telegram_storage"("checksum")`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "idx_telegram_storage_chat_id" ON "telegram_storage"("chat_id")`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "idx_telegram_storage_uploaded_at" ON "telegram_storage"("uploaded_at")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "telegram_storage"`.execute(db);
}
