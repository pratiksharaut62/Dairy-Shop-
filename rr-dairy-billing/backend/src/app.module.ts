import { Controller, Get, Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { JwtModule } from '@nestjs/jwt'
import { ThrottlerModule } from '@nestjs/throttler'
import { DbModule } from './db/db.module'
import { ErrorFilter } from './common/http'
import { AuthGuard, Public } from './auth/permissions'
import { AuthService } from './auth/auth.service'
import { AuthController, UsersController } from './auth/auth.controller'
import { CategoriesController, StoreController } from './modules/store.controller'
import { CatalogController } from './modules/catalog.controller'
import { CustomersController, SuppliersController } from './modules/people.controller'
import { BillsController } from './modules/bills.controller'
import { ExpensesController, PurchasesController, SessionsController, StockController } from './modules/operations.controller'
import { SyncController } from './modules/sync.controller'
import { DairyController } from './modules/dairy.controller'
import { BackupsController } from './modules/backups.controller'
import { AdminController, DeviceHealthController } from './modules/health.controller'
import { DbService } from './db/db.service'

@Controller('health')
class HealthController {
  constructor(private readonly db: DbService) {}
  @Public() @Get()
  async health() {
    await this.db.query('SELECT 1')
    return { ok: true, time: Date.now() }
  }
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? ''
  if (secret.length < 32) throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (try: openssl rand -hex 32)')
  return secret
}

@Module({
  imports: [
    DbModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    JwtModule.register({
      global: true,
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_TTL_SECONDS ?? 43_200) },
    }),
  ],
  controllers: [
    HealthController, AuthController, UsersController, StoreController, CategoriesController, CatalogController,
    CustomersController, SuppliersController, BillsController, StockController, ExpensesController, PurchasesController,
    SessionsController, SyncController, BackupsController, DeviceHealthController, AdminController,
    DairyController,
  ],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
