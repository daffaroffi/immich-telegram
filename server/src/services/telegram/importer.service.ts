import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssetType, ChecksumAlgorithm, JobName } from 'src/enum.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

export interface TelegramImportFile {
  messageId: number;
  fileName: string;
  size: number;
  date: Date;
}

export interface TelegramImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * One-time import of files that already live in the Telegram storage chat
 * (uploaded manually or via other Telegram-drive style tools before Immich
 * existed). Every document that does not have a telegram_ref row yet is
 * downloaded, decrypted when the vault key is configured, written into the
 * owner's upload tree and registered as a normal asset, so it shows up in the
 * Immich timeline. The telegram_ref row is created as well, so the regular
 * sync/restore machinery keeps treating the file as its own.
 */
@Injectable()
export class TelegramImporterService {
  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private assetRepository: AssetRepository,
    private jobRepository: JobRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramImporterService.name);
  }

  async importExisting(
    ownerId: string,
    options: { limit?: number; dryRun?: boolean } = {},
  ): Promise<TelegramImportResult> {
    const config = this.configRepository.getEnv().telegram;
    if (!config.enabled) {
      throw new Error('Telegram storage is not enabled');
    }

    const files = await this.listChatDocuments(options.limit ?? 500);
    const result: TelegramImportResult = { scanned: files.length, imported: 0, skipped: 0, failed: 0, errors: [] };
    const vaultKey = config.vaultKey;

    for (const file of files) {
      try {
        if (await this.refRepository.hasByMessageId(file.messageId)) {
          result.skipped++;
          continue;
        }
        if (options.dryRun) {
          result.imported++;
          continue;
        }
        const imported = await this.importFile(ownerId, file, vaultKey);
        if (imported) {
          result.imported++;
        } else {
          result.skipped++;
        }
      } catch (error: unknown) {
        result.failed++;
        const detail = error instanceof Error ? error.message : String(error);
        result.errors.push(`message ${file.messageId} (${file.fileName}): ${detail}`);
        this.logger.error(`Telegram import failed for message ${file.messageId} (${file.fileName}): ${detail}`);
      }
    }

    this.logger.log(
      `Telegram import finished: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`,
    );
    return result;
  }

  /** Documents in the storage chat, oldest first. */
  async listChatDocuments(limit: number): Promise<TelegramImportFile[]> {
    const config = this.configRepository.getEnv().telegram;
    const messages = await this.mtproto.listChatMessages(limit);
    const files: TelegramImportFile[] = [];

    for (const message of messages) {
      const doc = (message as any)?.document;
      if (!doc) {
        continue;
      }
      const attributes: any[] = (doc.attributes ?? []) as any[];
      const name = attributes.map((a) => a.fileName).find(Boolean) ?? `telegram-${(message as any).id}.bin`;
      files.push({
        messageId: (message as any).id,
        fileName: name,
        size: Number(doc.size ?? 0),
        date: new Date((message as any).date * 1000),
      });
    }

    return files.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  private async importFile(ownerId: string, file: TelegramImportFile, vaultKey: Buffer | null): Promise<boolean> {
    const workDir = await mkdtemp(join(tmpdir(), 'tg-import-'));
    const downloadPath = join(workDir, 'part.bin');
    try {
      await this.mtproto.downloadFile(file.messageId, downloadPath);

      let plainPath = downloadPath;
      if (vaultKey) {
        const decryptedPath = join(workDir, 'plain.bin');
        try {
          await this.crypto.decryptFile(downloadPath, decryptedPath, vaultKey);
          plainPath = decryptedPath;
        } catch {
          // raw (unencrypted) document — keep the downloaded bytes as-is
          plainPath = downloadPath;
        }
      }

      const info = await stat(plainPath);
      if (info.size === 0) {
        return false;
      }

      await this.registerAsset(ownerId, file, plainPath, info.size, vaultKey !== null);
      return true;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async registerAsset(
    ownerId: string,
    file: TelegramImportFile,
    plainPath: string,
    size: number,
    encrypted: boolean,
  ): Promise<void> {
    const { StorageCore } = await import('src/cores/storage.core.js');
    const { mimeTypes } = await import('src/utils/mime-types.js');

    const assetId = randomUUID();
    const safeName = file.fileName.replace(/[^\w.\-]+/g, '_');
    const dot = safeName.lastIndexOf('.');
    const extension = dot > 0 ? safeName.slice(dot) : '.bin';
    const folder = StorageCore.getNestedFolder('upload' as never, ownerId, assetId);
    await mkdir(folder, { recursive: true });
    const targetPath = join(folder, assetId + extension);
    await copyFile(plainPath, targetPath);

    const bytes = await readFile(targetPath);
    const checksum = createHash('sha1').update(bytes).digest();
    const fileDate = file.date;

    await this.assetRepository.create({
      id: assetId,
      ownerId,
      libraryId: null,
      type: mimeTypes.assetType(safeName),
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      originalPath: targetPath,
      fileCreatedAt: fileDate,
      fileModifiedAt: fileDate,
      localDateTime: fileDate,
      originalFileName: safeName,
      isFavorite: false,
      isOffline: false,
      isExternal: false,
      isEdited: false,
      duration: null,
      livePhotoVideoId: null,
      visibility: 'timeline' as never,
      status: 'active' as never,
    });

    await this.assetRepository.upsertExif({
      exif: { assetId, fileSizeInByte: size },
      lockedPropertiesBehavior: 'override',
    });

    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: assetId, source: 'upload' } });

    await this.refRepository.createPart({
      assetId,
      partIndex: 0,
      totalParts: 1,
      messageId: file.messageId,
      chatId: this.configRepository.getEnv().telegram.chatId,
      size,
      checksum: checksum.toString('hex'),
      encrypted,
    });

    this.logger.log(`Imported telegram message ${file.messageId} (${safeName}, ${size}B) as asset ${assetId}`);
  }
}
