import { IsString, IsInt, IsIn, IsNotEmpty, Min, Max } from 'class-validator';

export class ProviderEventDto {
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsString()
  @IsNotEmpty()
  transactionRef!: string;

  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  @IsString()
  @IsIn(['NGN'])
  currency!: string;

  @IsString()
  @IsIn(['pending', 'successful', 'failed'])
  status!: string;
}
