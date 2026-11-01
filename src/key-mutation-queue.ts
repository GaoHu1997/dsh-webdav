/**
 * One index's mutation lease in the model plugin's existing globalThis queue.
 * The Symbol, Map protocol and Windows casefold intentionally match the model
 * queue. No model import or default path: callers pass the checked index target.
 * This coordinates one execution realm only, not Workers or other processes.
 */
import { resolve } from 'node:path'

const KEY_MUTATION_QUEUES = Symbol.for('dsh-model-think-level.key-mutation-queues')
type QueueRegistry = typeof globalThis & {
  [KEY_MUTATION_QUEUES]?: Map<string, Promise<void>>
}
const registry = globalThis as QueueRegistry
const queues = registry[KEY_MUTATION_QUEUES] ??= new Map<string, Promise<void>>()

export function keyMutationTarget(file: string): string {
  const absolute = resolve(file)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Hold through current reads, backup and commit; always release in finally. */
export async function acquireKeyMutation(file: string): Promise<() => void> {
  const key = keyMutationTarget(file)
  const previous = queues.get(key) ?? Promise.resolve()
  let releaseTurn: () => void = () => {}
  const turn = new Promise<void>(done => { releaseTurn = done })
  queues.set(key, turn)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    if (queues.get(key) === turn) queues.delete(key)
    releaseTurn()
  }
}
