import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import type { Insertable, Updateable } from 'kysely';
import { asUuid } from 'src/utils/database.js';

export interface TelegramRef {
  assetId: string;
  messageId: number;
  chatId: number;
  size: number;
  checksum: string | null;
  encrypted: boolean;
  uploadedAt: Date;
}

export interface TelegramRefCreate {
  assetId: string;
  messageId: number;
  chatId: bigint;
  size: number;
  checksum?: string | null;
  encrypted?: boolean;
}

export class TelegramRefRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(ref: TelegramRefCreate): Promise<void> {
    const values = {
      assetId: asUuid(ref.assetId),
      messageId: ref.messageId,
      chatId: Number(ref.chatId),
      size: ref.size,
      checksum: ref.checksum ?? null,
      encrypted: ref.encrypted ?? true,
    };
    const updateValues = {
      messageId: ref.messageId,
      chatId: Number(ref.chatId),
      size: ref.size,
      checksum: ref.checksum ?? null,
      encrypted: ref.encrypted ?? true,
    };
    await this.db
      .insertInto('telegram_ref')
      .values(values as never)
      .onConflict((oc) => oc.column('assetId').doUpdateSet(updateValues as never))
      .execute();
  }

  async get(assetId: string): Promise<TelegramRef | undefined> {
    return this.db
      .selectFrom('telegram_ref')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst();
  }

  async getByMessageId(messageId: number): Promise<TelegramRef | undefined> {
    return this.db.selectFrom('telegram_ref').selectAll().where('messageId', '=', messageId).executeTakeFirst();
  }

  async delete(assetId: string): Promise<void> {
    await this.db.deleteFrom('telegram_ref').where('assetId', '=', asUuid(assetId)).execute();
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('telegram_ref')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async list(limit = 100): Promise<TelegramRef[]> {
    return this.db.selectFrom('telegram_ref').selectAll().orderBy('uploadedAt', 'desc').limit(limit).execute();
  }

  /** Return asset ids that have a local file but no telegram_ref row yet. */
  async listUnbacked(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('telegram_ref', 'telegram_ref.assetId', 'asset.id')
      .where('telegram_ref.assetId', 'is', null)
      .select(['asset.id'])
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /** Assets that still need a telegram backup, with the path to upload from. */
  async listPendingUpload(limit: number): Promise<{ assetId: string; originalPath: string }[]> {
    return this.db
      .selectFrom('asset')
      .leftJoin('telegram_ref', 'telegram_ref.assetId', 'asset.id')
      .where('telegram_ref.assetId', 'is', null)
      .where('asset.originalPath', 'is not', null)
      .select(['asset.id as assetId', 'asset.originalPath as originalPath'])
      .limit(limit)
      .execute();
  }
}