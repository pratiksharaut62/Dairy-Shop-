import type { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { json, raw } from 'express'

/** Shared by main.ts and the e2e tests so both run the exact same HTTP configuration. */
export function configureApp(app: NestExpressApplication) {
  app.set('trust proxy', 1) // behind Render/Railway/Fly/nginx: real client IP for rate limiting
  app.use(helmet())
  app.use(json({ limit: '5mb' }))
  // Whole-store backups arrive as raw gzip bytes, far bigger than a normal JSON request.
  app.use('/api/backups', raw({ type: 'application/octet-stream', limit: '45mb' }))

  const allowed = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  app.enableCors({
    // The desktop app (Tauri) is same-app, not cross-origin; its webview origin is tauri://localhost or http://tauri.localhost.
    origin: (origin, cb) => {
      const tauri = !origin || /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/.test(origin)
      cb(null, tauri || allowed.includes(origin))
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Checksum', 'X-Device', 'X-Kind', 'X-Counts', 'X-Raw-Bytes'],
    exposedHeaders: ['X-Checksum'],
    maxAge: 86_400,
  })
  app.setGlobalPrefix('api')
}
