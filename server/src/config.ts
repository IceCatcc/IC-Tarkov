import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** server/ 根目录（tsx 跑 src/ 与 node 跑 dist/ 都解析到同一处） */
const here = path.dirname(fileURLToPath(import.meta.url))
export const serverRoot = path.resolve(here, '..')

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'ic_tarkov',
    autoCreate: bool(process.env.DB_AUTO_CREATE, true),
    poolSize: int(process.env.DB_POOL_SIZE, 10),
  },

  /** 游戏数据落盘目录：data/tarkov-api（原始 JSON）、data/derived（派生索引）、data/uploads（用户上传） */
  dataDir: path.resolve(serverRoot, process.env.DATA_DIR ?? 'data'),
  /**
   * 随仓库携带的种子数据（src-tauri/resources）：首次启动时复制到 data/tarkov-api。
   * 容器部署时由 SEED_DIR 指向镜像内拷贝的副本。
   */
  seedDir: process.env.SEED_DIR
    ? path.resolve(serverRoot, process.env.SEED_DIR)
    : path.resolve(serverRoot, '..', 'src-tauri', 'resources'),
  /** 前端构建产物目录；留空则不托管静态前端 */
  clientDist: process.env.CLIENT_DIST
    ? path.resolve(serverRoot, process.env.CLIENT_DIST)
    : path.resolve(serverRoot, '..', 'src-react', 'dist'),

  session: {
    cookieName: 'ict_sid',
    ttlDays: int(process.env.SESSION_TTL_DAYS, 30),
  },

  /** 游戏数据缓存过期时间（秒）：超过则启动时后台静默同步 */
  dataSyncIntervalSecs: 7 * 24 * 3600,
} as const

export const paths = {
  rawDir: path.join(config.dataDir, 'tarkov-api'),
  derivedDir: path.join(config.dataDir, 'derived'),
  uploadDir: path.join(config.dataDir, 'uploads'),
  sqlDir: path.join(serverRoot, 'sql'),
}
