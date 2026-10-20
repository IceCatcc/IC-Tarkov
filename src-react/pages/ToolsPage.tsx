import { useState, type ReactNode } from 'react'
import { CraftTool } from '../components/CraftTool'

/** 工具定义：新增工具时在 TOOLS 里加一项，并在 renderTool 里补对应组件 */
interface ToolDef {
  key: string
  name: string
  /** 工具卡片上的一句话说明 */
  desc: string
  icon: ReactNode
}

const TOOLS: ToolDef[] = [
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
]

function renderTool(key: string): ReactNode {
  switch (key) {
    case 'craft':
      return <CraftTool />
    default:
      return null
  }
}

/** 工具页：工具卡片列表；点卡片进入工具界面，左上角返回按钮回到列表 */
export function ToolsPage() {
  const [active, setActive] = useState<string | null>(null)
  const tool = TOOLS.find((t) => t.key === active) ?? null

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

      {/* 内容区：工具列表 / 当前工具界面 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {tool ? (
          renderTool(tool.key)
        ) : (
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
        )}
      </div>
    </div>
  )
}
