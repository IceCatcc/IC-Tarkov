import { useEffect, useState, type ReactNode } from 'react'
import { CraftTool } from '../components/CraftTool'
import { DisplayFilterTool } from '../components/DisplayFilterTool'
import { ItemsPage } from './ItemsPage'

/** 工具定义：新增工具时在 TOOLS 里加一项，并在 renderTool 里补对应组件 */
interface ToolDef {
  key: string
  name: string
  /** 工具卡片上的一句话说明 */
  desc: string
  icon: ReactNode
  /**
   * 工具自带整页布局（自己的滚动区、需要完整高度）：外层不再套 `px-4 pb-4` 的滚动容器，
   * 否则会出现双层滚动 / 内层 `h-full` 被压扁。物品图鉴属于这一类。
   */
  full?: boolean
}

const TOOLS: ToolDef[] = [
  {
    key: 'items',
    name: '物品图鉴',
    desc: '按类型 / 口径检索物品，查看任务需求、钥匙使用位置与背包格子',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" strokeLinejoin="round" />
        <path d="M4 7.5 12 12l8-4.5M12 12v9" strokeLinejoin="round" />
      </svg>
    ),
    full: true,
  },
  {
    key: 'craft',
    name: '配方查询',
    desc: '查一件物品的藏身处配方，或它作为材料参与的配方，并估算跳蚤市场价格与利润',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M9 3h6M10 3v6.2L5.4 18a2 2 0 0 0 1.7 3h9.8a2 2 0 0 0 1.7-3L14 9.2V3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7.3 14h9.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'display-filter',
    name: '显示器滤镜',
    desc: '按显示器调亮度 / 对比度 / RGB Gamma，方案可绑快捷键，只作用于选中的屏幕（全屏游戏同样生效）',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
        <path d="M9 20h6M12 16.5V20" strokeLinecap="round" />
        <path d="M7 13V9M12 13V7M17 13v-2" strokeLinecap="round" />
      </svg>
    ),
  },
]

function renderTool(key: string): ReactNode {
  switch (key) {
    case 'items':
      return <ItemsPage embedded />
    case 'craft':
      return <CraftTool />
    case 'display-filter':
      return <DisplayFilterTool />
    default:
      return null
  }
}

/**
 * 工具页：工具卡片列表 ↔ 工具界面两态容器。
 *
 * 打开过的工具会常驻挂载（只切 `display`），返回列表或切到别的工具时不销毁——
 * 物品图鉴的搜索 / 筛选 / 滚动位置、配方的查询结果因此都能保留。
 */
export function ToolsPage() {
  const [active, setActive] = useState<string | null>(null)
  const [opened, setOpened] = useState<string[]>([])
  const tool = TOOLS.find((t) => t.key === active) ?? null

  useEffect(() => {
    if (active) setOpened((prev) => (prev.includes(active) ? prev : [...prev, active]))
  }, [active])

  return (
    <div className="h-full flex flex-col">
      {/* 头部：打开工具时左上角显示返回按钮 */}
      <div className="shrink-0 flex items-center gap-2 px-4 pt-4 pb-3">
        {tool && (
          <button
            onClick={() => setActive(null)}
            title="返回工具列表"
            aria-label="返回工具列表"
            className="shrink-0 w-7 h-7 grid place-items-center rounded border border-line text-muted hover:text-[#e6edf3] hover:bg-ink-700"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 5 8 12l7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <h1 className="text-[17px] font-medium truncate">{tool ? tool.name : '工具'}</h1>
        {!tool && <span className="text-[13px] text-muted">共 {TOOLS.length} 个</span>}
      </div>

      {/* 内容区：工具列表 + 已打开的工具（后者常驻，仅切换显隐） */}
      <div className="flex-1 min-h-0">
        <div className={active ? 'hidden' : 'h-full overflow-y-auto px-4 pb-4'}>
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {TOOLS.map((t) => (
              <li key={t.key}>
                <button
                  onClick={() => setActive(t.key)}
                  className="w-full h-full text-left flex items-start gap-3 rounded-lg border border-line bg-ink-800 hover:border-amber/60 transition-colors px-4 py-3"
                >
                  <span className="shrink-0 w-10 h-10 grid place-items-center rounded-lg bg-amber/10 text-[#d4a174] border border-amber/30">
                    {t.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-[#e6edf3]">{t.name}</span>
                    <span className="block mt-0.5 text-[12px] leading-snug text-muted/80">
                      {t.desc}
                    </span>
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    className="shrink-0 w-4 h-4 mt-1 text-muted/60"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {opened.map((key) => {
          const def = TOOLS.find((t) => t.key === key)
          if (!def) return null
          return (
            <div
              key={key}
              className={def.full ? 'h-full' : 'h-full overflow-y-auto px-4 pb-4'}
              style={{ display: active === key ? 'block' : 'none' }}
            >
              {renderTool(key)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
