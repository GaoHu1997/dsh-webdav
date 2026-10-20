/**
 * Asking the deployment for a directory.
 *
 * Two dialogs exist and the card does not care which one answers:
 *
 * - the desktop shell's own bridge (`globalThis.__DSH_DIRECTORY_PICKER__`),
 *   which is the same one the native directory picker prefers — it opens on the
 *   display the window is on and needs no service at all;
 * - the workspace service's `pickDirectory()`, which reaches the host's
 *   chooser and is what a plain web GUI has.
 *
 * Neither is guaranteed here, and the card must survive that: the workspace
 * service is read through `ctx.get` rather than injected, because a hard
 * `uiWorkspace` inject would take the whole card down on a deployment that
 * shows no workspace surface. A chooser that finds nothing rejects, and the
 * caller turns that into a row the path can be typed into.
 *
 * @module webdav-sync/client/picker
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** A directory chooser: the chosen absolute path, or `null` when cancelled. */
export type DirectoryChooser = () => Promise<string | null>

/** The desktop preload bridge, as much of it as this card uses. */
interface DesktopPicker {
  pick?: () => Promise<string | null>
}

/** The workspace service, as much of it as this card uses. */
interface WorkspacePicker {
  pickDirectory?: () => Promise<string | null>
}

/**
 * Build the chooser for whatever this deployment has.
 *
 * @param ctx - the client context, used only to look the workspace service up.
 * @returns the chooser; it rejects when no dialog can be reached.
 */
export function directoryChooser(ctx: ClientContext): DirectoryChooser {
  // `ctx.get` is typed against the merged service map, and the workspace
  // package is not a dependency of this one, so the lookup goes through a
  // narrow cast instead of a type-only import that would not resolve.
  const lookup = ctx.get.bind(ctx) as unknown as (name: string) => unknown
  return async () => {
    const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: DesktopPicker }).__DSH_DIRECTORY_PICKER__
    if (typeof bridge?.pick === 'function') return await bridge.pick()
    const workspace = lookup('uiWorkspace') as WorkspacePicker | undefined
    if (typeof workspace?.pickDirectory === 'function') return await workspace.pickDirectory()
    throw new Error('no directory chooser is available here')
  }
}
