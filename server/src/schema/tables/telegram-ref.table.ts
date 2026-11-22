import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryColumn,
  Table,
  Timestamp,
  type Generated,
  type Int8,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('telegram_ref')
export class TelegramRefTable {
  @PrimaryColumn({ type: 'uuid' })
  assetId!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  asset!: AssetTable;

  @Column({ type: 'integer' })
  messageId!: number;

  @Column({ type: 'bigint' })
  chatId!: Int8;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'character varying', nullable: true })
  checksum!: string | null;

  @Column({ type: 'boolean', default: true })
  encrypted!: boolean;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  uploadedAt!: Generated<Timestamp>;
}
