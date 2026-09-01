import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const TelegramAccountSchema = z
  .object({
    id: z.string().describe('Account identifier'),
    label: z.string().describe('Account display name'),
    status: z.enum(['connected', 'disconnected', 'error']).describe('Connection status'),
    rateLimitRemaining: z.number().describe('Remaining rate limit slots'),
  })
  .meta({ id: 'TelegramAccountDto' });

const TelegramStatusResponseSchema = z
  .object({
    enabled: z.boolean().describe('Telegram storage enabled'),
    connected: z.boolean().describe('Connected to Telegram'),
    chatId: z.string().describe('Telegram chat/channel ID'),
    chatTitle: z.string().describe('Chat/channel title'),
    totalFiles: z.number().describe('Total files stored'),
    totalSizeBytes: z.number().describe('Total size in bytes'),
    accounts: z.array(TelegramAccountSchema).describe('Configured accounts'),
  })
  .meta({ id: 'TelegramStatusResponseDto' });

const TelegramConfigSchema = z
  .object({
    enabled: z.boolean().describe('Enable/disable Telegram storage'),
    mode: z.enum(['local-only', 'telegram-primary', 'hybrid', 'backup-only']).describe('Storage mode'),
    chatId: z.string().optional().describe('Target chat/channel ID'),
    encryptionEnabled: z.boolean().optional().describe('Enable TDENC2 encryption'),
    cacheSizeMb: z.number().optional().describe('Cache size in MB'),
    cacheTtlHours: z.number().optional().describe('Cache TTL in hours'),
    concurrentUploads: z.number().optional().describe('Max concurrent uploads'),
    concurrentDownloads: z.number().optional().describe('Max concurrent downloads'),
  })
  .meta({ id: 'TelegramConfigDto' });

const TelegramConfigResponseSchema = z
  .object({
    success: z.boolean().describe('Operation success'),
    configId: z.string().optional().describe('Configuration ID'),
  })
  .meta({ id: 'TelegramConfigResponseDto' });

const TelegramMigrateRequestSchema = z
  .object({
    userId: z.string().optional().describe('Specific user ID to migrate'),
    dryRun: z.boolean().describe('Dry run without actual upload'),
    concurrency: z.number().describe('Number of concurrent uploads'),
    includeThumbnails: z.boolean().describe('Include thumbnails'),
    includeEncodedVideo: z.boolean().describe('Include encoded videos'),
  })
  .meta({ id: 'TelegramMigrateRequestDto' });

const TelegramMigrationProgressSchema = z
  .object({
    completed: z.number().describe('Files completed'),
    total: z.number().describe('Total files'),
    percentage: z.number().describe('Progress percentage'),
    currentFile: z.string().describe('Current file being processed'),
    bytesUploaded: z.number().describe('Bytes uploaded'),
    bytesTotal: z.number().describe('Total bytes'),
    speed: z.string().describe('Upload speed'),
    eta: z.string().describe('Estimated time remaining'),
  })
  .meta({ id: 'TelegramMigrationProgressSchema' });

const TelegramMigrateResponseSchema = z
  .object({
    migrationId: z.string().describe('Migration ID'),
    status: z.enum(['pending', 'running', 'completed', 'failed']).describe('Migration status'),
    progress: TelegramMigrationProgressSchema.describe('Migration progress'),
    errors: z.array(z.string()).describe('Error messages'),
  })
  .meta({ id: 'TelegramMigrateResponseDto' });

const TelegramCacheStatsSchema = z
  .object({
    memoryCache: z
      .object({
        sizeMb: z.number().describe('Memory cache size in MB'),
        entries: z.number().describe('Number of entries'),
        hitRate: z.number().describe('Cache hit rate'),
      })
      .describe('Memory cache stats'),
    diskCache: z
      .object({
        sizeMb: z.number().describe('Disk cache size in MB'),
        entries: z.number().describe('Number of entries'),
        hitRate: z.number().describe('Cache hit rate'),
      })
      .describe('Disk cache stats'),
    totalSizeMb: z.number().describe('Total cache size in MB'),
  })
  .meta({ id: 'TelegramCacheStatsDto' });

const TelegramCacheClearSchema = z
  .object({
    olderThanHours: z.number().optional().describe('Clear entries older than N hours'),
    userId: z.string().optional().describe('Clear cache for specific user'),
  })
  .meta({ id: 'TelegramCacheClearDto' });

const TelegramCacheClearResponseSchema = z
  .object({
    cleared: z.number().describe('Number of entries cleared'),
    freedBytes: z.number().describe('Bytes freed'),
  })
  .meta({ id: 'TelegramCacheClearResponseDto' });

export class TelegramStatusResponseDto extends createZodDto(TelegramStatusResponseSchema) {}
export class TelegramConfigDto extends createZodDto(TelegramConfigSchema) {}
export class TelegramConfigResponseDto extends createZodDto(TelegramConfigResponseSchema) {}
export class TelegramMigrateRequestDto extends createZodDto(TelegramMigrateRequestSchema) {}
export class TelegramMigrateResponseDto extends createZodDto(TelegramMigrateResponseSchema) {}
export class TelegramCacheStatsDto extends createZodDto(TelegramCacheStatsSchema) {}
export class TelegramCacheClearDto extends createZodDto(TelegramCacheClearSchema) {}
export class TelegramCacheClearResponseDto extends createZodDto(TelegramCacheClearResponseSchema) {}
