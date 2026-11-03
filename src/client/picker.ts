/**
 * Asking the deployment for a directory, or for a file.
 *
 * Two dialogs exist for directories and the card does not care which one
 * answers:
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
 * A file is different: the browser's own file dialog hands back a `File`, not a
 * path, and only the desktop shell knows where that file is on disk. Its
 * preload answers with `__DSH_HOST_PATHS__.pathFor(file)` — Electron's
 * `webUtils.getPathForFile` — and a plain web GUI simply has no way to answer,
 * which the card says instead of guessing a path.
 *
 * @module webdav-sync/client/picker
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** A directory chooser: the chosen absolute path, or `null` when cancelled. */
export type DirectoryChooser = () => Promise<string | null>

/** A file chooser: the chosen absolute path, or `null` when cancelled. */
export type FileChooser = () => Promise<string | null>

/** The desktop preload bridge, as much of it as this card uses. */
interface DesktopPicker {
  pick?: () => Promise<string | null>
}

/** The desktop preload's file-path bridge. */
interface DesktopPaths {
  pathFor?: (file: File) => string
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

/**
 * The host path of a file the browser dialog handed back, or `undefined` when
 * this window cannot know it.
 *
 * The bridge is only present in the desktop shell; a plain browser has no way to
 * map a `File` back to a path, and neither does a `File` that was never on this
 * disk. Both come back as `undefined`, which the caller reports instead of
 * inventing a path.
 *
 * @param file - the file the dialog returned.
 * @returns its absolute path, or `undefined`.
 */
export function hostFilePath(file: File): string | undefined {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: DesktopPaths }).__DSH_HOST_PATHS__
  if (typeof bridge?.pathFor !== 'function') return undefined
  try {
    const path = bridge.pathFor(file)
    return typeof path === 'string' && path.trim() !== '' ? path : undefined
  } catch {
    // `getPathForFile` throws for a `File` no disk path backs; that is the same
    // answer as no bridge at all.
    return undefined
  }
}

/**
 * Build the file chooser: the browser's file dialog, then the desktop shell's
 * path for the file it returned.
 *
 * @returns the chooser; it rejects when this window cannot name the file's path.
 */
export function fileChooser(): FileChooser {
  return async () => {
    const file = await askForFile()
    if (file === null) return null
    const path = hostFilePath(file)
    if (path === undefined) throw new Error('this window cannot tell where the file is on disk')
    return path
  }
}

/**
 * Open the browser's file dialog and wait for one file.
 *
 * The input is created per call and removed again, so a cancelled dialog (which
 * reports itself with `cancel` on Chromium and with nothing at all on some
 * shells) never leaves an element behind that the next call would stack on.
 *
 * @returns the chosen file, or `null` when the dialog was cancelled.
 */
function askForFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    let settled = false
    const done = (file: File | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => done(null))
    document.body.append(input)
    input.click()
  })
}
