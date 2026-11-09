import { type ChangeEvent, useId, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { copyText } from '../utils/copy-text'
import { saveMadeFile } from '../utils/download-file'
import {
  applySettings,
  diffSettings,
  exportSettings,
  IMPORT_MAX_BYTES,
  type ImportError,
  parseImport,
  type SettingChange,
} from '../utils/settings-registry'
import { SettingsDiffDialog } from './settings-diff-dialog'
import { Button, FOCUS_RING } from './ui/button'

export const EXPORT_FILE_NAME = 'termote-settings.json'

const IMPORT_ERROR: Record<ImportError, MessageKey> = {
  json: 'settings.transfer.error.json',
  format: 'settings.transfer.error.format',
  version: 'settings.transfer.error.version',
  tooLarge: 'settings.transfer.error.tooLarge',
}

// Settings > Export & import: this browser's settings to a file or the
// clipboard, and back from either through the same before/after table a
// proposal shows. Device-only settings never travel.
export function SettingsTransferSection() {
  const { t } = useT()
  const pasteId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pasted, setPasted] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [rows, setRows] = useState<SettingChange[] | null>(null)

  const tell = (p: string | null, d: string | null = null) => {
    setProblem(p)
    setDone(d)
  }

  const save = () => {
    tell(null)
    saveMadeFile(
      new File([exportSettings()], EXPORT_FILE_NAME, {
        type: 'application/json',
      }),
    ).catch(() => tell(t('settings.transfer.saveFailed')))
  }

  const copy = async () => {
    const r = await copyText(exportSettings())
    if (r === 'ok') tell(null, t('settings.transfer.copied'))
    else tell(t('settings.transfer.copyFailed'))
  }

  const review = (text: string) => {
    const parsed = parseImport(text)
    if ('error' in parsed) {
      tell(t(IMPORT_ERROR[parsed.error], { size: IMPORT_MAX_BYTES / 1024 }))
      return
    }
    tell(null)
    setRows(diffSettings(parsed.values))
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > IMPORT_MAX_BYTES) {
      tell(
        t('settings.transfer.error.tooLarge', {
          size: IMPORT_MAX_BYTES / 1024,
        }),
      )
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      tell(t('settings.transfer.readFailed'))
      return
    }
    review(text)
  }

  const apply = () => {
    // Apply shows only with rows to apply
    /* v8 ignore next */
    if (!rows) return
    const count = applySettings(rows)
    setRows(null)
    setPasted('')
    tell(null, t('settings.transfer.applied', { count }))
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        {t('settings.transfer.intro')}
      </p>
      {problem && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={save}>
          {t('settings.transfer.save')}
        </Button>
        <Button variant="secondary" onClick={() => void copy()}>
          {t('settings.transfer.copy')}
        </Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()}>
          {t('settings.transfer.importFile')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label={t('settings.transfer.fileLabel')}
          onChange={(e) => void onFile(e)}
        />
      </div>
      <label htmlFor={pasteId} className="text-[13px] text-fg-muted">
        {t('settings.transfer.paste')}
      </label>
      <textarea
        id={pasteId}
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        rows={3}
        spellCheck={false}
        className={`w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-fg ${FOCUS_RING}`}
      />
      <div>
        <Button
          variant="secondary"
          disabled={!pasted.trim()}
          onClick={() => review(pasted)}
        >
          {t('settings.transfer.review')}
        </Button>
      </div>
      <SettingsDiffDialog
        isOpen={rows !== null}
        title={t('settings.diff.titleImport')}
        rows={rows ?? []}
        onApply={apply}
        onCancel={() => setRows(null)}
      />
    </div>
  )
}
