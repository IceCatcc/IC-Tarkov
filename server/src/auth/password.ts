import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>

// 用 Node 内置 scrypt，省掉 bcrypt 的原生编译依赖（Windows / 容器镜像都省事）
const N = 16384
const r = 8
const p = 1
const KEYLEN = 64
const MAXMEM = 64 * 1024 * 1024

/** 生成 `scrypt$N$r$p$salt$hash` 格式的口令哈希 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(plain, salt, KEYLEN, { N, r, p, maxmem: MAXMEM })
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

/** 校验口令；存储格式非法或口令不符均返回 false（定时安全比较） */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const rr = Number(parts[2])
  const pp = Number(parts[3])
  if (!Number.isFinite(n) || !Number.isFinite(rr) || !Number.isFinite(pp)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch {
    return false
  }
  const actual = await scrypt(plain, salt, expected.length, {
    N: n,
    r: rr,
    p: pp,
    maxmem: MAXMEM,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
