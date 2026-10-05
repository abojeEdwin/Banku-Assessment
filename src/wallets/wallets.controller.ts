import { Controller, Get, Param } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get(':id')
  getWallet(@Param('id') id: string) {
    return this.walletsService.getWallet(id);
  }
}
