/**
 * Web 端与服务端通信的 HTTP 基础层。
 * 供 `api/web-impl.ts`（业务数据）与 `auth.ts`（账号）共用。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 服务端返回 401 时抛出的错误（前端据此切回登录页） */
export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401
}

async function readError(res: Response): Promise<ApiError> {
  let code = 'http_error'
  let message = `请求失败（${res.status}）`
  try {
    const j = (await res.json()) as { error?: string; message?: string }
    if (j?.error) code = j.error
    if (j?.message) message = j.message
  } catch {
    /* 非 JSON 错误体 */
  }
  return new ApiError(res.status, code, message)
}

/** 发一个 JSON 请求；非 2xx 抛 ApiError（带服务端的中文提示） */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res)
  if (res.status === 204) return undefined as unknown as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** 上传文件（multipart/form-data）；同样抛出带提示的 ApiError */
export async function upload<T>(
  path: string,
  files: File[],
  fields: Record<string, string> = {},
  onProgress?: (ratio: number) => void,
): Promise<T> {
  const form = new FormData()
  for (const f of files) form.append('file', f, f.name)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)

  // 用 XHR 而非 fetch：需要上传进度（导出包虽不大，但回显进度体验更好）
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path, true)
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onerror = () => reject(new ApiError(0, 'network_error', '网络错误，上传失败'))
    xhr.onload = () => {
      let parsed: unknown
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined
      } catch {
        parsed = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T)
        return
      }
      const j = parsed as { error?: string; message?: string } | undefined
      reject(new ApiError(xhr.status, j?.error ?? 'http_error', j?.message ?? `上传失败（${xhr.status}）`))
    }
    xhr.send(form)
  })
}
