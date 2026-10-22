/**
 * The manual backup section of the card: export and import, one row each.
 *
 * It sits under 同步内容 and answers a question the sync itself cannot: how to
 * move this setup to a computer that has no account, no address and no network.
 * Both rows are one file each way, so both stay shut until they are asked for —
 * a passphrase field on screen at all times would read as a setting to keep,
 * when it is one file's one question. Each row is a name with one glyph right
 * after it (a box with an arrow leaving it for 导出, the same box with the arrow
 * going in for 导入) and a sentence under the two, so the row says what it does
 * and carries the way to do it in one line. The two glyphs are one drawing with
 * one thing changed — {@link BackupGlyph} holds the box and both arrows — because
 * a matched pair reads as two directions of one act, where two unrelated
 * pictograms read as two unrelated features.
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

import { useRef, type ReactNode } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Part } from '../wire.ts'
import type { CardActions, CardState } from './card-store.ts'
import type { WebdavSyncKey } from './locales.ts'
import { BackupGlyph } from './BackupGlyph.tsx'
import css from './WebdavSyncCard.module.css'

/**
 * The ✕ of one removable report, shaped exactly like the card's own
 * {@link PromptClose}: the two panels render the same control so a person meets
 * one removal gesture, not two. Kept local to this file because the card's own
 * component is not exported — the card passes its reports' clear-downs through
 * the same {@link CardActions} either way.
 */
function PromptClose({ t, onClick }: { t: (key: WebdavSyncKey) => string; onClick: () => void }) {
  return (
    <Tooltip label={t('promptDismiss')} side="top" portal>
      <Button
        variant="ghost"
        size="sm"
        className={css.promptClose}
        icon={<IconCloseOutlineRegular />}
        aria-label={t('promptDismiss')}
        onClick={onClick}
      />
    </Tooltip>
  )
}

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
 * What one row's action needs: its name, its glyph, and the form it opens.
 */
interface RowActionProps {
  /** The tooltip and the accessible name — the two words the row is about. */
  label: string
  /** The glyph: the box with its arrow going out, or the same box coming in. */
  icon: ReactNode
  /** Whether a write is in flight. */
  disabled: boolean
  /** Whether this row's form is open. */
  open: boolean
  /** The id of the form the action opens. */
  controls: string
  /** Open the form, or shut it again. */
  onClick: () => void
}

/**
 * One row's action: a glyph on the title line, not a worded button at the row's
 * right end.
 *
 * It sits immediately after the title it acts on, the way 「选择目录」 sits after
 * 附加目录's name: the row is one file and one gesture, and a reader who has found
 * the sentence has already found what to press. The two words are still there —
 * in the tooltip and in the accessible name — because a box is not a word, and
 * the failure mode of an unlabelled icon is a guess.
 *
 * @param props - the name, the glyph, the row's state and the form it opens.
 * @returns the button, with its tooltip.
 */
function RowAction({ label, icon, disabled, open, controls, onClick }: RowActionProps) {
  return (
    <Tooltip label={label} side="top" portal>
      <Button
        variant="ghost"
        size="sm"
        className={css.backupIcon}
        icon={icon}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onClick}
      />
    </Tooltip>
  )
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
    <section className={css.section}>
      <h4 className={css.legend}>{t('backupLegend')}</h4>

      <div className={css.backupRow}>
        <span className={css.backupText}>
          <span className={css.backupHead}>
            <span className={css.backupTitle}>{t('exportTitle')}</span>
            <RowAction
              label={t('exportAction')}
              icon={<BackupGlyph direction="out" />}
              disabled={busy}
              open={state.exportOpen}
              controls="webdav-sync-export-form"
              onClick={() => (state.exportOpen ? props.closeExport() : props.openExport())}
            />
          </span>
          <span className={css.backupHint}>{t('exportHint')}</span>
        </span>
      </div>

      {state.exportOpen && (
        <div id="webdav-sync-export-form" className={css.backupForm} aria-busy={state.busy === 'export'}>
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
          <span className={css.backupHead}>
            <span className={css.backupTitle}>{t('importTitle')}</span>
            <RowAction
              label={t('importAction')}
              icon={<BackupGlyph direction="in" />}
              disabled={busy}
              open={state.importOpen}
              controls="webdav-sync-import-form"
              onClick={() => (state.importOpen ? props.closeImport() : props.openImport())}
            />
          </span>
          <span className={css.backupHint}>{t('importHint')}</span>
        </span>
      </div>

      {state.importOpen && (
        <div id="webdav-sync-import-form" className={css.backupForm} aria-busy={state.busy === 'import'}>
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
            <label className={css.fieldLabel} htmlFor="webdav-sync-import-file">{t('importFileLabel')}</label>
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
                id="webdav-sync-import-file"
                aria-label={t('importFileLabel')}
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
        <div className={css.promptRow}>
          <p className={css.note} role="status">
            {t('exportDone', {
              file: state.exported.file,
              size: sizeText(state.exported.size),
              parts: names(state.exported.parts),
            })}
          </p>
          {/* The report is this browser's memory of one write; taking it down is
            * local, and the next export replaces it anyway. */}
          <PromptClose t={t} onClick={() => props.closeExportReport()} />
        </div>
      )}

      {state.imported !== undefined && (
        <div className={css.note} role="status">
          <div className={css.promptRow}>
            <span>
              {state.imported.here.length > 0
                ? t('importDone', { parts: names(state.imported.here) })
                : t('importSame', { parts: names(state.imported.same) })}
            </span>
            <PromptClose t={t} onClick={() => props.closeImportReport()} />
          </div>
          {state.imported.pendingInstall && <p className={css.note}>{t('importPending')}</p>}
          {state.imported.saved !== undefined && (
            <p className={css.note}>{t('noticeSaved', { dir: state.imported.saved })}</p>
          )}
        </div>
      )}
    </section>
  )
}
