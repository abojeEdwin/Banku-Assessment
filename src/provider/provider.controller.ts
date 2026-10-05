import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ProviderService } from './provider.service';
import { ProviderEventDto } from './dto/provider-event.dto';

@Controller('provider')
export class ProviderController {
  constructor(private readonly providerService: ProviderService) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  processEvent(@Body() event: ProviderEventDto) {
    const result = this.providerService.processEvent(event);
    return result;
  }
}
