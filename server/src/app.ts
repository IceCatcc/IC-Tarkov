import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { requireUser } from './auth/session.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerProgressRoutes } from './routes/progress.js'
import { registerGameRoutes } from './routes/game.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerDataRoutes } from './routes/data.js'
import { registerImportRoutes } from './routes/import.js'
import { registerWsRoutes } from './routes/ws.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // 仅在显式声明 development 时启用彩色输出（避免生产环境缺失 pino-pretty 导致启动失败）
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
  })

  await app.register(cookie)
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true })
  }
  await app.register(websocket)
  // 数据导入：单文件上限 32MB，最多 10 个文件
  await app.register(multipart, {
    limits: { fileSize: 32 * 1024 * 1024, files: 10 },
  })

  // 健康检查（不需要登录，供反向代理 / 容器探针使用）
  app.get('/api/health', async () => ({ ok: true, time: Date.now() }))

  // 未登录可访问
  registerAuthRoutes(app)
  registerWsRoutes(app)

  // 其余业务接口一律要求登录
  await app.register(async (scope) => {
    scope.addHook('preHandler', requireUser)
    registerProgressRoutes(scope)
    registerGameRoutes(scope)
    registerSettingsRoutes(scope)
    registerDataRoutes(scope)
    registerImportRoutes(scope)
  })

  // 静态前端（构建产物存在时托管；开发环境由 Vite dev server 负责）
  if (config.clientDist && fs.existsSync(config.clientDist)) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      index: ['index.html'],
      // 带 hash 的构建产物可长期缓存；index.html 不缓存
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('cache-control', 'no-cache')
        else res.setHeader('cache-control', 'public, max-age=604800')
      },
    })
    // SPA 回退：非 /api 的 GET 未命中时一律返回 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return reply.type('text/html').send(fs.createReadStream(`${config.clientDist}/index.html`))
    })
    app.log.info(`[app] 已托管前端产物：${config.clientDist}`)
  } else {
    app.log.warn(`[app] 未找到前端产物（${config.clientDist}），仅提供 API`)
  }

  return app
}
