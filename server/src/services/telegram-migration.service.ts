import { Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ConfigRepository } from 'src/repositories/config.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { TelegramMtprotoService } from 'src/services/telegram-mtproto.service';
import { TelegramEncryptionService } from 'src/services/telegram-encryption.service';
import { TelegramRateLimitService } from 'src/services/telegram-rate-limit.service';
import { DB } from 'src/schema';

interface MigrationProgress {
  migrationId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: {
    completed: number;
    total: number;
    percentage: number;
    currentFile: string;
    bytesUploaded: number;
    bytesTotal: number;
    speed: string;
    eta: string;
  };
  errors: string[];
}

interface MigrationOptions {
  userId?: string;
  dryRun: boolean;
  concurrency: number;
  includeThumbnails: boolean;
  includeEncodedVideo: boolean;
}

/**
 * Telegram Migration Service
 * Handles migration of existing local files to Telegram storage
 */
@Injectable()
export class TelegramMigrationService {
  private readonly logger = new Logger(TelegramMigrationService.name);
  private migrations: Map<string, MigrationProgress> = new Map();

  constructor(
    private configRepository: ConfigRepository,
    private storageRepository: StorageRepository,
    private telegramMtproto: TelegramMtprotoService,
    private telegramEncryption: TelegramEncryptionService,
    private telegramRateLimit: TelegramRateLimitService,
    @InjectKysely() private db: Kysely<DB>,
  ) {}

  /**
   * Start migration of local files to Telegram
   */
  async startMigration(options: MigrationOptions): Promise<MigrationProgress> {
    const migrationId = `mig_${Date.now()}`;

    const progress: MigrationProgress = {
      migrationId,
      status: 'pending',
      progress: {
        completed: 0,
        total: 0,
        percentage: 0,
        currentFile: '',
        bytesUploaded: 0,
        bytesTotal: 0,
        speed: '0 MB/s',
        eta: 'Calculating...',
      },
      errors: [],
    };

    this.migrations.set(migrationId, progress);

    // Start migration in background
    this.runMigration(migrationId, options).catch((error) => {
      this.logger.error(`Migration ${migrationId} failed`, error);
      progress.status = 'failed';
      progress.errors.push(error.message);
    });

    return progress;
  }

  private async runMigration(migrationId: string, options: MigrationOptions): Promise<void> {
    const progress = this.migrations.get(migrationId);
    if (!progress) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    progress.status = 'running';
    this.logger.log(`Starting migration ${migrationId}`);

    try {
      const filesToMigrate = await this.getFilesToMigrate(options);
      progress.progress.total = filesToMigrate.length;
      progress.progress.bytesTotal = filesToMigrate.reduce((sum, f) => sum + f.size, 0);

      const startTime = Date.now();
      let totalBytesUploaded = 0;

      for (const file of filesToMigrate) {
        if (options.dryRun) {
          this.logger.log(`[DRY RUN] Would migrate: ${file.path}`);
          progress.progress.completed++;
          continue;
        }

        progress.progress.currentFile = file.path;

        try {
          // Read file
          const buffer = await this.storageRepository.readFile(file.path);

          // Encrypt if enabled
          const vaultKey = this.getVaultKey();
          let dataToUpload = buffer;

          // Upload to Telegram
          await this.telegramRateLimit.waitForUploadSlot();
          try {
            const result = await this.telegramMtproto.uploadFile(dataToUpload, file.path);

            // Store mapping in database
            await this.storeFileMapping(file.path, file.assetId, result.messageId);

            this.logger.log(`Migrated: ${file.path} -> message_id: ${result.messageId}`);

            totalBytesUploaded += file.size;
          } finally {
            this.telegramRateLimit.releaseUploadSlot();
          }

          progress.progress.completed++;
          progress.progress.bytesUploaded = totalBytesUploaded;

          // Calculate speed and ETA
          const elapsedMs = Date.now() - startTime;
          const speedBytesPerMs = totalBytesUploaded / elapsedMs;
          const remainingBytes = progress.progress.bytesTotal - totalBytesUploaded;
          const etaMs = remainingBytes / speedBytesPerMs;

          progress.progress.speed = `${(speedBytesPerMs * 1000 / 1024 / 1024).toFixed(1)} MB/s`;
          progress.progress.eta = `${Math.round(etaMs / 1000 / 60)} minutes`;
          progress.progress.percentage = Math.round((progress.progress.completed / progress.progress.total) * 100);

        } catch (error) {
          const errorMsg = `Failed to migrate ${file.path}: ${error}`;
          this.logger.error(errorMsg);
          progress.errors.push(errorMsg);
        }
      }

      progress.status = 'completed';
      this.logger.log(`Migration ${migrationId} completed`);
    } catch (error) {
      progress.status = 'failed';
      throw error;
    }
  }

  private async getFilesToMigrate(options: MigrationOptions): Promise<{ path: string; size: number; assetId: string }[]> {
    const query = this.db
      .selectFrom('asset')
      .innerJoin('asset_file', 'asset.id', 'asset_file.assetId')
      .select([
        'asset.id as assetId',
        'asset_file.path as path',
      ])
      .where('asset_file.type', '=', 'original' as any)
      .where('asset.isOffline', '=', false);

    if (options.userId) {
      query.where('asset.ownerId', '=', options.userId);
    }

    const results = await query.execute();

    // Get file sizes using storage repository
    const filesWithSize: { path: string; size: number; assetId: string }[] = [];
    for (const result of results) {
      try {
        const stat = await this.storageRepository.stat(result.path);
        filesWithSize.push({
          path: result.path,
          size: stat.size,
          assetId: result.assetId,
        });
      } catch (error) {
        this.logger.warn(`Failed to get size for ${result.path}: ${error}`);
      }
    }

    return filesWithSize;
  }

  private async storeFileMapping(originalPath: string, assetId: string, messageId: number): Promise<void> {
    // Store the mapping in telegram_storage table
    // Using raw SQL since telegram_storage table is not in the Kysely schema
    await sql`
      INSERT INTO telegram_storage (
        asset_id, 
        original_message_id, 
        chat_id, 
        uploaded_at
      ) VALUES (
        ${assetId}, 
        ${messageId}, 
        ${parseInt(process.env.TELEGRAM_CHANNEL_ID || '0')},
        NOW()
      )
      ON CONFLICT (asset_id) 
      DO UPDATE SET 
        original_message_id = ${messageId},
        uploaded_at = NOW()
    `.execute(this.db);
  }

  private getVaultKey(): Buffer {
    const vaultKeyHex = process.env.TELEGRAM_VAULT_KEY;
    if (vaultKeyHex) {
      return Buffer.from(vaultKeyHex, 'hex');
    }
    // Generate new vault key
    return this.telegramEncryption.generateVaultKey();
  }

  /**
   * Get migration progress
   */
  getMigrationProgress(migrationId: string): MigrationProgress | undefined {
    return this.migrations.get(migrationId);
  }

  /**
   * Get all migrations
   */
  getAllMigrations(): MigrationProgress[] {
    return Array.from(this.migrations.values());
  }

  /**
   * Restore files from Telegram to local storage
   */
  async restoreFromTelegram(options: {
    assetIds?: string[];
    targetPath: string;
  }): Promise<void> {
    this.logger.log(`Restoring files from Telegram to ${options.targetPath}`);

    // TODO: Implement restore logic
    // 1. Get message IDs from database
    // 2. Download from Telegram
    // 3. Decrypt if encrypted
    // 4. Save to target path
  }
}
