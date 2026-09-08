import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * 顶层错误边界：任何子组件渲染期抛错都会被捕获，
 * 用可读的错误信息替代整屏黑（移动端无 devtools 时尤其重要）。
 * 出错后会显示 message + stack，便于截图/复制反馈。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染出错：', error, info)
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div className="fixed inset-0 z-[9999] overflow-auto bg-[#0d1117] p-6 text-[13px] text-red-300">
          <div className="mb-3 text-[15px] font-semibold text-red-400">界面渲染出错</div>
          <div className="mb-3 text-red-200">{error.message || String(error)}</div>
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-red-400/80">
            {error.stack}
          </pre>
          <button
            onClick={() => location.reload()}
            className="mt-4 rounded-lg border border-red-400/50 px-4 py-2 text-[13px] text-red-200 hover:bg-red-400/10"
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
