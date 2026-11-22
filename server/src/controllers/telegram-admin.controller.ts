import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';
import { TelegramSyncService } from 'src/services/telegram/sync.service.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/telegram')
export class TelegramAdminController {
  constructor(
    private sync: TelegramSyncService,
    private refRepository: TelegramRefRepository,
    private mtproto: TelegramMtprotoService,
  ) {}

  @Get('status')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Telegram storage status',
    history: new HistoryBuilder().added('v3.4'),
  })
  async status(@Auth() _auth: AuthDto) {
    return {
      check: 'ok' as const,
      ...this.sync.status(),
      backedUpCount: await this.refRepository.count(),
    };
  }

  @Post('backfill')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @Endpoint({
    summary: 'Queue all unbacked assets for telegram sync',
    history: new HistoryBuilder().added('v3.4'),
  })
  async backfill(@Auth() _auth: AuthDto) {
    const unbacked = await this.sync.backfill(5000);
    return { unbacked };
  }
}