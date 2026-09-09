/**
 * 任务 Wiki 站点（设置页「Wiki 站点」选择）。
 *
 * 链接统一在前端按模板生成（后端数据里的 wiki 字段只作兜底），
 * 这样切换站点即时生效，不必重建后端数据集。
 */

export type WikiSite = 'eftarkov' | 'tarkovbox' | 'custom'

/** 预设模板：`{taskid}` 处替换为任务 id（大小写不敏感） */
export const WIKI_TEMPLATES: Record<Exclude<WikiSite, 'custom'>, string> = {
  eftarkov: 'https://www.eftarkov.com/news/id/{taskid}.html',
  tarkovbox: 'https://www.tarkovbox.com/gamewiki/tasks/{taskid}',
}

/**
 * 按当前站点选择生成任务 Wiki 链接。
 * - `custom` 未填模板时返回 null（该任务不显示 Wiki 入口）
 * - 自定义模板里不含 `{taskid}` 时按原样返回（固定地址）
 */
export function buildWikiUrl(questId: string, site: WikiSite, custom: string): string | null {
  if (!questId) return null
  const tpl = site === 'custom' ? custom.trim() : WIKI_TEMPLATES[site]
  if (!tpl) return null
  return tpl.replace(/\{taskid\}/gi, questId)
}
