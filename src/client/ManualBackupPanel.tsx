/**
 * The manual backup section of the card: export and import, one row each.
 *
 * It sits under 同步内容 and answers a question the sync itself cannot: how to
 * move this setup to a computer that has no account, no address and no network.
 * Both rows are one file each way, so both stay shut until they are asked for —
 * a passphrase field on screen at all times would read as a setting to keep,
 * when it is one file's one question.
 *
 * The file itself is the same sealed envelope the server holds, so a manual
 * export can be imported by any other copy of this plugin and nothing new has to
 * be trusted with the plaintext.
 *
 * The export is written by the host half: this half cannot save a file (the
 * desktop shell cancels browser downloads), so it names a folder and the host
 * writes there. The import travels the other way — this half reads the picked
 * file, because only it can see one, and the host decrypts the text it is given.
 *
 * @module webdav-sync/client/ManualBackupPanel
 */

import { useRef } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Part } from '../wire.ts'
import type { CardActions, CardState } from './card-store.ts'
import type { WebdavSyncKey } from './locales.ts'
import css from './WebdavSyncCard.module.css'

/** What the section needs from the card that hosts it. */
export interface ManualBackupPanelProps extends CardActions {
  /** The bound dictionary lookup. */
  t: (key: WebdavSyncKey, params?: Record<string, unknown>) => string
  /** The card's snapshot: the two forms and the two reports live in it. */
  state: CardState
  /** Whether a write is in flight, which disables both rows. */
  busy: boolean
  /** Names one part in this reader's language, for the two reports. */
  partName: (part: Part) => string
}

/**
 * A byte count as something a reader can compare at a glance.
 *
 * @param bytes - the file's size.
 * @returns e.g. 「812 B」 or 「1.4 KiB」.
 */
function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * The manual backup section.
 *
 * @param props - the card's snapshot, its actions and the dictionary.
 * @returns the section.
 */
export function ManualBackupPanel(props: ManualBackupPanelProps) {
  const { t, state, busy, partName } = props
  const file = useRef<HTMLInputElement>(null)
  const names = (parts: Part[]): string => parts.map((part) => partName(part)).join('、')

  return (
    <section>
      <h4 className={css.legend}>{t('backupLegend')}</h4>

      <div className={css.backupRow}>
        <span className={css.backupText}>
          <span className={css.backupTitle}>{t('exportTitle')}</span>
          <span className={css.backupHint}>{t('exportHint')}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={css.backupAction}
          disabled={busy}
          aria-expanded={state.exportOpen}
          onClick={() => (state.exportOpen ? props.closeExport() : props.openExport())}
        >
          {t('exportAction')}
        </Button>
      </div>

      {state.exportOpen && (
        <div className={css.backupForm}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="webdav-sync-export-passphrase">
              {t('exportPassphraseLabel')}
            </label>
            <p className={css.fieldHint}>{t('exportPassphraseHint')}</p>
            <Input
              id="webdav-sync-export-passphrase"
              type="password"
              value={state.exportPassphrase}
              autoComplete="new-password"
              onChange={(event) => props.editExport('passphrase', event.target.value)}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="webdav-sync-export-dir">
              {t('exportDirLabel')}
            </label>
            <p className={css.fieldHint}>{t('exportDirHint')}</p>
            <div className={css.backupPathRow}>
              <Input
                id="webdav-sync-export-dir"
                value={state.exportDir}
                placeholder={t('exportDirPlaceholder')}
                onChange={(event) => props.editExport('dir', event.target.value)}
              />
              <Button variant="outline" size="sm" disabled={busy} onClick={() => props.pickExportDir()}>
                {t('exportDirChoose')}
              </Button>
            </div>
          </div>
          <div className={css.backupFormFooter}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => props.runExport()}>
              {state.busy === 'export' ? t('working') : t('exportConfirm')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => props.closeExport()}>
              {t('exportCancel')}
            </Button>
          </div>
        </div>
      )}

      <div className={css.backupRow}>
        <span className={css.backupText}>
          <span className={css.backupTitle}>{t('importTitle')}</span>
          <span className={css.backupHint}>{t('importHint')}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={css.backupAction}
          disabled={busy}
          aria-expanded={state.importOpen}
          onClick={() => (state.importOpen ? props.closeImport() : props.openImport())}
        >
          {t('importAction')}
        </Button>
      </div>

      {state.importOpen && (
        <div className={css.backupForm}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="webdav-sync-import-passphrase">
              {t('importPassphraseLabel')}
            </label>
            <p className={css.fieldHint}>{t('importPassphraseHint')}</p>
            <Input
              id="webdav-sync-import-passphrase"
              type="password"
              value={state.importPassphrase}
              autoComplete="new-password"
              onChange={(event) => props.editImport('passphrase', event.target.value)}
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('importFileLabel')}</span>
            <p className={css.fieldHint}>{t('importFileHint')}</p>
            {/*
              * The browser's own picker, not a path field: this half can only
              * read a file it was handed, so the row names the file it read
              * rather than a path the host would have to resolve.
              */}
            <div className={css.backupPathRow}>
              <span className={css.backupFileName}>
                {state.importName === '' ? t('importNoFile') : state.importName}
              </span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => file.current?.click()}>
                {t('importFileChoose')}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".prop,application/json"
                className={css.backupFileInput}
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  // The same file picked twice must read again: a refused input
                  // keeps its value, so it has to be cleared either way.
                  event.target.value = ''
                  if (picked !== undefined) props.pickFile(picked)
                }}
              />
            </div>
          </div>
          <div className={css.backupFormFooter}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => props.runImport()}>
              {state.busy === 'import' ? t('working') : t('importConfirm')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => props.closeImport()}>
              {t('importCancel')}
            </Button>
          </div>
        </div>
      )}

      {state.exported !== undefined && (
        <p className={css.note} role="status">
          {t('exportDone', {
            file: state.exported.file,
            size: sizeText(state.exported.size),
            parts: names(state.exported.parts),
          })}
        </p>
      )}

      {state.imported !== undefined && (
        <div className={css.note} role="status">
          {state.imported.here.length > 0 ? (
            <p className={css.note}>{t('importDone', { parts: names(state.imported.here) })}</p>
          ) : (
            <p className={css.note}>{t('importSame', { parts: names(state.imported.same) })}</p>
          )}
          {state.imported.pendingInstall && <p className={css.note}>{t('importPending')}</p>}
          {state.imported.saved !== undefined && (
            <p className={css.note}>{t('noticeSaved', { dir: state.imported.saved })}</p>
          )}
        </div>
      )}
    </section>
  )
}
