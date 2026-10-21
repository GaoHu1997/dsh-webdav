/** Re-read local status while the full card is mounted, never run a sync. */
export function watchStatus(poll: () => void): () => void {
  const refresh = () => {
    if (document.visibilityState !== 'hidden') poll()
  }
  // A latched initial load cannot refresh a remounted card. Foreground/online
  // events also catch up immediately after suspended or throttled timers.
  refresh()
  const timer = setInterval(refresh, 15_000)
  window.addEventListener('focus', refresh)
  window.addEventListener('online', refresh)
  document.addEventListener('visibilitychange', refresh)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('online', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}
