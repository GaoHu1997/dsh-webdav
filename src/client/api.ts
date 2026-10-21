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
  ExportBody,
  ExportResult,
  ImportBody,
  ImportResult,
  InstallResult,
  MessageResult,
  PreviewResult,
  RouteError,
  StatusResult,
  SyncBody,
  SyncResult,
} from '../wire.ts'
import {
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
      headers: { 'content-type': 'application/json' },
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
    return { ok: false, error: `服务器返回了 HTTP ${response.status}，但响应不是 JSON` }
  }
  if (!response.ok) {
    const text = (payload as RouteError | null)?.error
    return { ok: false, error: typeof text === 'string' && text !== '' ? text : `服务器返回了 HTTP ${response.status}` }
  }
  return { ok: true, data: payload as T }
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
    return await Promise.race([
      send<StatusResult>('GET', ROUTE_STATUS, undefined, controller.signal),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Store the address, account, passphrase and part switches. */
export function requestConfigure(body: ConfigureBody): Promise<Call<MessageResult>> {
  return send<MessageResult>('POST', ROUTE_CONFIG, body)
}

/** Reach the server once and say what is there, writing nothing anywhere. */
export function requestCheck(): Promise<Call<CheckResult>> {
  return send<CheckResult>('POST', ROUTE_CHECK, {})
}

/** Say what a sync would do, part by part, without touching anything. */
export function requestPreview(): Promise<Call<PreviewResult>> {
  return send<PreviewResult>('POST', ROUTE_PREVIEW, {})
}

/** Merge with the file on the server. */
export function requestSync(body: SyncBody = {}): Promise<Call<SyncResult>> {
  return send<SyncResult>('POST', ROUTE_SYNC, body)
}

/** Make this computer match the server, whatever changed here. */
export function requestRestore(): Promise<Call<SyncResult>> {
  return send<SyncResult>('POST', ROUTE_RESTORE, {})
}

/** Put this computer's setup back where a restore replaced it. */
export function requestUndo(): Promise<Call<SyncResult>> {
  return send<SyncResult>('POST', ROUTE_UNDO, {})
}

/** Write this computer's setup over a file that is not one of ours. */
export function requestUpload(): Promise<Call<SyncResult>> {
  return send<SyncResult>('POST', ROUTE_UPLOAD, {})
}

/** Fetch the plugins the profile now declares. */
export function requestInstall(): Promise<Call<InstallResult>> {
  return send<InstallResult>('POST', ROUTE_INSTALL, {})
}

/** Put the last sync's notice away. */
export function requestDismiss(): Promise<Call<MessageResult>> {
  return send<MessageResult>('POST', ROUTE_DISMISS, {})
}

/** Stop syncing; the file on the server stays. */
export function requestOff(): Promise<Call<MessageResult>> {
  return send<MessageResult>('POST', ROUTE_OFF, {})
}

/** Write one sealed backup file into a folder this computer can reach. */
export function requestExport(body: ExportBody): Promise<Call<ExportResult>> {
  return send<ExportResult>('POST', ROUTE_EXPORT, body)
}

/** Open a picked backup file's text and put what it holds on this computer. */
export function requestImport(body: ImportBody): Promise<Call<ImportResult>> {
  return send<ImportResult>('POST', ROUTE_IMPORT, body)
}
