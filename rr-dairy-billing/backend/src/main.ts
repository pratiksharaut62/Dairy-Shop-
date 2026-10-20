import './env'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { configureApp } from './setup'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  configureApp(app)
  const port = Number(process.env.PORT ?? 8080)
  await app.listen(port, '0.0.0.0')
  console.log(`RR Dairy API listening on :${port}`)
}
void bootstrap()
