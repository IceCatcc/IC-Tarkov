/**
 * Web 端账号相关接口（注册 / 登录 / 登出 / 改密 / 数据导入）。
 *
 * 仅 Web 构建使用：桌面端没有账号体系，因此这套接口**不**放进 `tauri.ts` 的统一数据层
 * （放进去会破坏两套实现的一致性校验）。调用方需要自行用 `isWeb()` 判平台。
 */
import { request, upload } from './http'
import type { QuestMode } from '../types'

export interface AuthUser {
  id: number
  username: string
}

/** 当前登录用户；未登录返回 null */
export async function fetchMe(): Promise<AuthUser | null> {
  const r = await request<{ user: AuthUser | null }>('GET', '/api/auth/me')
  return r.user ?? null
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await request<{ user: AuthUser }>('POST', '/api/auth/login', { username, password })
  return r.user
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const r = await request<{ user: AuthUser }>('POST', '/api/auth/register', { username, password })
  return r.user
}

export async function logout(): Promise<void> {
  await request('POST', '/api/auth/logout')
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await request('POST', '/api/auth/password', { oldPassword, newPassword })
}

/* ---------------- 账号数据概览与导入 ---------------- */

export interface ModeCount {
  quests: number
  completed: number
  collected: number
  unlocked: number
}

export interface AccountSummary {
  /** 三个模式都没有任何进度（用于判断是否需要引导导入） */
  empty: boolean
  modes: Record<QuestMode, ModeCount>
}

export async function getAccountSummary(): Promise<AccountSummary> {
  return request<AccountSummary>('GET', '/api/account/summary')
}

export interface ModeImportStat {
  mode: QuestMode
  quests: number
  completed: number
  collected: number
  unlocked: number
  objectives: number
  activities: number
}

export interface ImportOutcome {
  replace: boolean
  modes: ModeImportStat[]
  settingsImported: boolean
  filesUsed: string[]
  warnings: string[]
}

/**
 * 上传桌面端数据。
 * @param files 导出包 zip，或 quest_state.*.json / collected.*.json / settings.json
 * @param replace true = 覆盖（迁移场景推荐）；false = 补充（只增不删）
 */
export async function importDataFiles(
  files: File[],
  replace: boolean,
  onProgress?: (ratio: number) => void,
): Promise<ImportOutcome> {
  return upload<ImportOutcome>('/api/import', files, { mode: replace ? 'replace' : 'merge' }, onProgress)
}
