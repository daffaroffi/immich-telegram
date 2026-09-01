import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  TelegramCacheClearDto,
  TelegramCacheClearResponseDto,
  TelegramCacheStatsDto,
  TelegramConfigDto,
  TelegramConfigResponseDto,
  TelegramMigrateRequestDto,
  TelegramMigrateResponseDto,
  TelegramStatusResponseDto,
} from 'src/dtos/telegram-admin.dto';
import { ApiTag, Permission } from 'src/enum';
import { Authenticated } from 'src/middleware/auth.guard';
import { TelegramCacheService } from 'src/services/telegram-cache.service';
import { TelegramMigrationService } from 'src/services/telegram-migration.service';
import { TelegramMtprotoService } from 'src/services/telegram-mtproto.service';

@ApiTags(ApiTag.TelegramAdmin)
@Controller('admin/telegram')
export class TelegramAdminController {
  constructor(
    private telegramMtproto: TelegramMtprotoService,
    private telegramCache: TelegramCacheService,
    private telegramMigration: TelegramMigrationService,
  ) {}

  @Get('status')
  @Endpoint({
    summary: 'Get Telegram storage status',
    description: 'Get the current status of Telegram storage integration',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  async getStatus(): Promise<TelegramStatusResponseDto> {
    const connected = this.telegramMtproto.isConnected();
    const stats = this.telegramCache.getStats();
    const accounts = this.telegramMtproto.getAccountsStatus();

    return {
      enabled: process.env.TELEGRAM_STORAGE_ENABLED === 'true',
      connected,
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      chatTitle: 'Telegram Storage',
      totalFiles: stats.memoryCache.entries + stats.diskCache.entries,
      totalSizeBytes: (stats.totalSizeMb * 1024 * 1024) | 0,
      accounts,
    };
  }

  @Post('config')
  @Endpoint({
    summary: 'Configure Telegram storage',
    description: 'Update Telegram storage configuration',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  async updateConfig(@Body() dto: TelegramConfigDto): Promise<TelegramConfigResponseDto> {
    // Update environment variables
    if (dto.enabled !== undefined) {
      process.env.TELEGRAM_STORAGE_ENABLED = String(dto.enabled);
    }
    if (dto.cacheSizeMb !== undefined) {
      process.env.TELEGRAM_CACHE_SIZE_MB = String(dto.cacheSizeMb);
    }
    if (dto.cacheTtlHours !== undefined) {
      process.env.TELEGRAM_CACHE_TTL_HOURS = String(dto.cacheTtlHours);
    }

    return {
      success: true,
      configId: `config_${Date.now()}`,
    };
  }

  @Post('migrate')
  @Endpoint({
    summary: 'Start migration',
    description: 'Start migrating local files to Telegram storage',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async startMigration(@Body() dto: TelegramMigrateRequestDto): Promise<TelegramMigrateResponseDto> {
    const progress = await this.telegramMigration.startMigration({
      userId: dto.userId,
      dryRun: dto.dryRun,
      concurrency: dto.concurrency,
      includeThumbnails: dto.includeThumbnails,
      includeEncodedVideo: dto.includeEncodedVideo,
    });

    return progress;
  }

  @Get('migrate/:migrationId')
  @Endpoint({
    summary: 'Get migration progress',
    description: 'Get the progress of a running migration',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getMigrationProgress(@Param('migrationId') migrationId: string): TelegramMigrateResponseDto | null {
    const progress = this.telegramMigration.getMigrationProgress(migrationId);
    if (!progress) {
      return null;
    }
    return progress as TelegramMigrateResponseDto;
  }

  @Get('cache')
  @Endpoint({
    summary: 'Get cache stats',
    description: 'Get Telegram cache statistics',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  getCacheStats(): TelegramCacheStatsDto {
    return this.telegramCache.getStats();
  }

  @Post('cache/clear')
  @Endpoint({
    summary: 'Clear cache',
    description: 'Clear Telegram cache entries',
    history: new HistoryBuilder().added('v2.6.0').alpha('v2.6.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async clearCache(@Body() dto: TelegramCacheClearDto): Promise<TelegramCacheClearResponseDto> {
    return this.telegramCache.clear(dto.olderThanHours);
  }
}
