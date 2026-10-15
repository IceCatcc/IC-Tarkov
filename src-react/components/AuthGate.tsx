import { useState } from 'react'
import { fetchMe, getAccountSummary, login, register } from '../api/web-account'
import { ImportPanel } from './ImportPanel'

type Tab = 'login' | 'register'
type Step = 'auth' | 'import'

/**
 * Web 端登录门禁：未登录时整屏接管，登录成功后才挂载主界面。
 *
 * 首次登录且账号为空的用户，会多一步「导入桌面端数据」的引导
 * （老用户迁移的主要路径，避免登录后看到空列表不知所措）。
 */
export function AuthGate({ onAuthed }: { onAuthed: () => void }) {
  const [tab, setTab] = useState<Tab>('login')
  const [step, setStep] = useState<Step>('auth')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    const name = username.trim()
    if (!name || !password) {
      setError('请输入用户名与密码')
      return
    }
    if (tab === 'register' && password !== password2) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (tab === 'login') await login(name, password)
      else await register(name, password)
      // 已登录：确认会话生效，再看这个账号是否已有数据
      if (!(await fetchMe())) throw new Error('登录状态未生效，请重试')
      const summary = await getAccountSummary()
      if (summary.empty) setStep('import')
      else onAuthed()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full h-9 rounded border border-line bg-ink-700 px-3 text-[13px] text-[#e6edf3] outline-none transition-colors hover:border-amber/50 focus:border-amber/60'

  return (
    <div className="h-full w-full flex items-center justify-center bg-ink-900 px-4">
      <div className="w-[420px] max-w-full rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
          <div className="flex items-center gap-2">
            <img src="/icons/icon.png" alt="" className="w-7 h-7 rounded" />
            <span className="text-[17px] font-semibold text-[#e6edf3]">IC Tarkov</span>
          </div>
          <div className="mt-1.5 text-[13px] text-muted">
            {step === 'auth'
              ? '登录后即可访问你的任务进度、地图与收藏数据'
              : '检测到这是一个新账号，可以直接导入桌面端的本地数据'}
          </div>
        </div>

        <div className="px-6 py-5">
          {step === 'auth' ? (
            <>
              <div className="flex gap-1 mb-4">
                {(['login', 'register'] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTab(t)
                      setError(null)
                    }}
                    className={`flex-1 h-8 rounded text-[13px] transition-colors border ${
                      tab === t
                        ? 'bg-amber/15 text-[#d4a174] border-amber/60'
                        : 'text-muted border-transparent hover:text-[#e6edf3] hover:bg-ink-700'
                    }`}
                  >
                    {t === 'login' ? '登录' : '注册'}
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] text-muted mb-1">用户名</label>
                  <input
                    className={inputClass}
                    value={username}
                    autoComplete="username"
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-muted mb-1">密码</label>
                  <input
                    className={inputClass}
                    type="password"
                    value={password}
                    autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                </div>
                {tab === 'register' && (
                  <div>
                    <label className="block text-[12px] text-muted mb-1">确认密码</label>
                    <input
                      className={inputClass}
                      type="password"
                      value={password2}
                      autoComplete="new-password"
                      onChange={(e) => setPassword2(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void submit()}
                    />
                  </div>
                )}
                {tab === 'register' && (
                  <div className="text-[12px] text-muted">
                    用户名 3-32 位（中英文 / 数字 / 下划线 / 连字符），密码至少 6 位。
                  </div>
                )}
              </div>

              {error && <div className="mt-3 text-[13px] text-red-400">{error}</div>}

              <button
                onClick={() => void submit()}
                disabled={busy}
                className="mt-5 w-full h-9 rounded bg-amber text-black text-[14px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? '请稍候…' : tab === 'login' ? '登录' : '注册并登录'}
              </button>
            </>
          ) : (
            <ImportPanel onImported={onAuthed} onSkip={onAuthed} />
          )}
        </div>
      </div>
    </div>
  )
}
