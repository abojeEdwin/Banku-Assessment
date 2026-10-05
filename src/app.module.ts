import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { ProviderController } from './provider/provider.controller';
import { ProviderService } from './provider/provider.service';
import { WalletsController } from './wallets/wallets.controller';
import { WalletsService } from './wallets/wallets.service';

@Module({
  imports: [],
  controllers: [AppController, ProviderController, WalletsController],
  providers: [AppService, DatabaseService, ProviderService, WalletsService],
})
export class AppModule {}
