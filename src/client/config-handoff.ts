/** Optional same-page handoff; plugins remain independently installable. */
export const BEFORE_SNAPSHOT_EVENT = 'dsh-webdav-sync:before-snapshot'
export const APPLIED_EVENT = 'dsh-webdav-sync:applied'

/** Let browser-owned configuration settle on disk before a snapshot reads it. */
export function beforeSnapshot(): Promise<void> | undefined {
  if (typeof window === 'undefined') return
  const pending: Promise<unknown>[] = []
  window.dispatchEvent(new CustomEvent(BEFORE_SNAPSHOT_EVENT, {
    detail: { waitUntil: (operation: Promise<unknown>) => { pending.push(operation) } },
  }))
  if (pending.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('模型配置保存超时，请重试同步')), 30_000)
  })
  return Promise.race([Promise.all(pending), timeout]).then(() => undefined).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** A completed local apply is a reason to pull now, not a new local edit. */
export function notifyApplied(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPLIED_EVENT))
}
