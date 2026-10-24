/**
 * The browser half's only network surface: plain `fetch` against the host
 * half's own routes. Every call answers `{ ok: true, ... }` or
 * `{ ok: false, error }` — never a rejection — so a card renders a failure
 * where the button was instead of leaving an unhandled promise behind.
 *
 * The messages the host raises are written for a person to read ("there is no
 * folder dsh-webdav on the WebDAV server: make it there first"), so they are
 * passed through verbatim; the fallback `HTTP <status>` only covers a response
 * that carried no message at all.
 */

import type {
  CheckResult,
  ConfigureBody,
  DismissBody,
  ExportBody,
  ExportResult,
  ImportBody,
  ImportResult,
  InstallResult,
  MessageResult,
  PreviewResult,
  StatusResult,
  SyncBody,
  SyncResult,
} from '../wire.ts'
import {
  PARTS,
  ROUTE_CHECK,
  ROUTE_CONFIG,
  ROUTE_DISMISS,
  ROUTE_EXPORT,
  ROUTE_IMPORT,
  ROUTE_INSTALL,
  ROUTE_OFF,
  ROUTE_PREVIEW,
  ROUTE_RESTORE,
  ROUTE_STATUS,
  ROUTE_SYNC,
  ROUTE_UNDO,
  ROUTE_UPLOAD,
} from '../wire.ts'

/**
 * One answered call: its body, or the message explaining why there is none.
 *
 * `ok` here is the transport's own word for "the host answered this request".
 * It is deliberately not merged into the body: two of the bodies carry an `ok`
 * of their own — a check and a plugin install both succeed at being delivered
 * while reporting that the thing they did did not work — and folding the two
 * into one field meant the transport's `true` overwrote the body's `false`. The
 * card then painted a refused sign-in and a failed install as successes. The
 * body is handed over untouched under `data`, so both fields can be read.
 */
export type Call<T> = { ok: true; data: T } | { ok: false; error: string }

/** Send one JSON request and fold every failure into a message. */
async function send<T>(method: 'GET' | 'POST', url: string, body?: unknown, signal?: AbortSignal): Promise<Call<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      // A GET with no body must not send one: the host reads a body only when
      // there are bytes, and `null` would be a body.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: protocolError(response.status, method, url, true) }
  }
  if (!response.ok) {
    const text = isRecord(payload) ? payload.error : undefined
    return { ok: false, error: typeof text === 'string' && text.trim() !== '' ? text : protocolError(response.status, method, url) }
  }
  if (!isRecord(payload)) {
    return { ok: false, error: `插件接口 ${method} ${url} 返回的数据不完整，请刷新页面后重试` }
  }
  return { ok: true, data: payload as T }
}

/** A host/proxy error is not a WebDAV failure; do not retry a write behind the person's back. */
function protocolError(status: number, method: string, url: string, nonJson = false): string {
  const prefix = `插件接口 ${method} ${url} 返回 HTTP ${status}${nonJson ? '，响应不是 JSON' : ''}`
  if (status === 401 || status === 403) return `${prefix}：请从当前 DSH 重新打开配置页面，恢复登录后再试`
  if (status === 404 || status === 405) {
    return `${prefix}：当前宿主未提供此接口或不接受该请求方式。请刷新页面；仍失败时请重载插件或重启 DSH，确认前端与宿主插件为同一版本`
  }
  return `${prefix}，操作未确认成功。请稍后重试`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function partList(value: unknown): boolean {
  return Array.isArray(value) && value.every((part) => PARTS.includes(part))
}

/** Bound status reads (including the body), without timing out long sync writes. */
export async function requestStatus(): Promise<Call<StatusResult>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Call<StatusResult>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: '读取同步状态超时（10 秒）' })
      controller.abort()
    }, 10_000)
  })
  try {
    const answer = await Promise.race([
      send<StatusResult>('GET', ROUTE_STATUS, undefined, controller.signal),
      timeout,
    ])
    // A payload without a configuration view is not a status this card can
    // draw — most plausibly a host of another version answered, the same skew
    // the write routes refuse below. Saying so here keeps the draft and the
    // last known view instead of crashing on a field the card assumes.
    if (answer.ok && !isRecord((answer.data as { config?: unknown }).config)) {
      return { ok: false, error: '状态接口返回的数据不完整，请刷新页面并确认前端与宿主插件为同一版本' }
    }
    return answer
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long a write action may take before the card stops waiting for it.
 *
 * A long sync is a legitimate thing — big directories over a slow line — so
 * this is a ceiling rather than a snappy timeout, high enough that no honest
 * action trips it. Below it, a request swallowed by a dead proxy would leave
 * the card's buttons disabled forever, with a refresh as the only way out and
 * no way to tell whether the host is still working.
 */
const ACTION_TIMEOUT_MS = 10 * 60_000

/** One action-sized request: the transport, with a ceiling on the wait. */
async function action<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Call<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS)
  const aborted = new Promise<Call<T>>((resolve) => {
    controller.signal.addEventListener('abort', () => {
      resolve({
        ok: false,
        error: `等待宿主回答超过 ${ACTION_TIMEOUT_MS / 60000} 分钟，本次操作已放弃等待：宿主可能仍在执行，请稍后刷新状态查看结果`,
      })
    }, { once: true })
  })
  try {
    return await Promise.race([send<T>(method, url, body, controller.signal), aborted])
  } finally {
    clearTimeout(timer)
  }
}

/** Store the address, account, passphrase and part switches. */
export function requestConfigure(body: ConfigureBody): Promise<Call<MessageResult>> {
  return action<MessageResult>('POST', ROUTE_CONFIG, body)
}

/** Reach the server once and say what is there, writing nothing anywhere. */
export function requestCheck(): Promise<Call<CheckResult>> {
  return action<CheckResult>('POST', ROUTE_CHECK, {})
}

/** Say what a sync would do, part by part, without touching anything. */
export function requestPreview(): Promise<Call<PreviewResult>> {
  return action<PreviewResult>('POST', ROUTE_PREVIEW, {})
}

/** Merge with the file on the server. */
export function requestSync(body: SyncBody = {}): Promise<Call<SyncResult>> {
  return action<SyncResult>('POST', ROUTE_SYNC, body)
}

/** Make this computer match the server, whatever changed here. */
export function requestRestore(): Promise<Call<SyncResult>> {
  return action<SyncResult>('POST', ROUTE_RESTORE, {})
}

/** Put this computer's setup back where a restore replaced it. */
export function requestUndo(): Promise<Call<SyncResult>> {
  return action<SyncResult>('POST', ROUTE_UNDO, {})
}

/** Write this computer's setup over a file that is not one of ours. */
export function requestUpload(): Promise<Call<SyncResult>> {
  return action<SyncResult>('POST', ROUTE_UPLOAD, {})
}

/** Fetch the plugins the profile now declares. */
export function requestInstall(): Promise<Call<InstallResult>> {
  return action<InstallResult>('POST', ROUTE_INSTALL, {})
}

/** Put a prompt away: the sync notice, or one recompute-on-read prompt by signature. */
export function requestDismiss(body: DismissBody = {}): Promise<Call<MessageResult>> {
  return action<MessageResult>('POST', ROUTE_DISMISS, body)
}

/** Stop syncing; the file on the server stays. */
export function requestOff(): Promise<Call<MessageResult>> {
  return action<MessageResult>('POST', ROUTE_OFF, {})
}

/** Write one sealed backup file into a folder this computer can reach. */
export async function requestExport(body: ExportBody): Promise<Call<ExportResult>> {
  const result = await action<ExportResult>('POST', ROUTE_EXPORT, body)
  if (!result.ok) return result
  const { file, size, parts } = result.data
  if (typeof file !== 'string' || file.trim() === '' || !Number.isSafeInteger(size) || size <= 0 || !partList(parts) || parts.length === 0) {
    return { ok: false, error: '导出接口未返回有效的文件路径、大小和内容清单，无法确认文件已生成。请刷新页面并确认前端与宿主插件为同一版本' }
  }
  return result
}

/** Open a picked backup file's text and put what it holds on this computer. */
export async function requestImport(body: ImportBody): Promise<Call<ImportResult>> {
  const result = await action<ImportResult>('POST', ROUTE_IMPORT, body)
  if (!result.ok) return result
  const { here, same, reloadNeeded, pendingInstall, created } = result.data
  if (!partList(here) || !partList(same) || typeof reloadNeeded !== 'boolean' || typeof pendingInstall !== 'boolean' || typeof created !== 'string' || created.trim() === '') {
    return { ok: false, error: '导入接口返回的数据不完整，无法确认操作结果。请检查当前配置并刷新页面，不要重复导入，确认前端与宿主插件为同一版本后再试' }
  }
  return result
}
