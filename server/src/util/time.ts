/** 与桌面端一致的本地时间字符串：`YYYY-MM-DD HH:mm:ss` */
export function nowSql(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 把 DATETIME 字符串转成毫秒时间戳（按本地时区解释） */
export function sqlToMs(s: string | null): number {
  if (!s) return 0
  return new Date(s.replace(' ', 'T')).getTime()
}
