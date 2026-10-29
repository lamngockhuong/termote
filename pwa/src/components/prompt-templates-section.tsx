import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { type PromptTemplate, RequestError } from '../hooks/use-mux-api'
import { usePromptTemplates } from '../hooks/use-prompt-templates'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { saveMadeFile } from '../utils/download-file'
import {
  exportFile,
  firstLine,
  MAX_IMPORT_FILE,
  parseImport,
  type TemplateEntry,
  templateErrorText,
} from '../utils/prompt-templates'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { TemplateEditor } from './template-editor'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

interface Props {
  // View-only role: the templates are read and exported, never changed
  readOnly?: boolean
}

// A delete waiting to be confirmed; again: the template changed on another
// device since it was shown, asked a second time with it as it is now
type Deleting = { template: PromptTemplate; again?: boolean }

// An import waiting to be confirmed, with what the server says it does
interface Importing {
  list: TemplateEntry[]
  added: string[]
  replaced: string[]
}

// Settings > Prompt templates: every device of this server shares them.
// Read again when shown: another device may have changed them.
export function PromptTemplatesSection({ readOnly = false }: Props) {
  const { t } = useT()
  const store = usePromptTemplates()
  const { refresh } = store
  const canWrite = !readOnly && !store.readOnly
  // undefined: no editor; null: a new template
  const [editing, setEditing] = useState<PromptTemplate | null | undefined>()
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [importing, setImporting] = useState<Importing | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  // An import is being checked or saved: no second one meanwhile
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tell = (p: string | null, d: string | null = null) => {
    setProblem(p)
    setDone(d)
  }

  // Opens the editor; what was said about the last action no longer holds
  const edit = (tpl: PromptTemplate | null) => {
    tell(null)
    setEditing(tpl)
  }

  const remove = async ({ template }: Deleting) => {
    setDeleting(null)
    try {
      await store.remove(template)
      tell(null, t('settings.deleted', { name: visibleUnsafe(template.name) }))
    } catch (err) {
      if (
        err instanceof RequestError &&
        err.code === 'conflict' &&
        err.template
      )
        setDeleting({ template: err.template, again: true })
      else if (err instanceof RequestError && err.code === 'not_found') {
        // Gone already: what the user wanted
        tell(
          null,
          t('settings.deleted', { name: visibleUnsafe(template.name) }),
        )
        void refresh()
      } else
        tell(
          err instanceof RequestError && err.code
            ? templateErrorText(err, t)
            : t('settings.templates.deleteFailed'),
        )
    } finally {
      // The row and its button are gone: keep the place in the list
      newRef.current?.focus()
    }
  }

  const exportAll = () => {
    const f = exportFile(store.templates)
    saveMadeFile(
      new File([f.text], f.name, { type: 'application/json' }),
    ).catch(() => tell(t('settings.templates.exportFailed')))
  }

  // Asks the server what list would add and replace, then the user
  const check = async (list: TemplateEntry[]) => {
    try {
      const preview = await store.previewImport(list)
      setImporting({ list, ...preview })
    } catch (err) {
      tell(importErrorText(err, t))
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    tell(null)
    if (file.size > MAX_IMPORT_FILE) {
      tell(
        t('settings.templates.fileTooLarge', {
          size: MAX_IMPORT_FILE / 1024 / 1024,
        }),
      )
      return
    }
    setBusy(true)
    try {
      let json: string
      try {
        json = await file.text()
      } catch {
        tell(t('settings.templates.readFileFailed'))
        return
      }
      const parsed = parseImport(json, t)
      if (!parsed.ok) tell(parsed.error)
      else await check(parsed.templates)
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (i: Importing) => {
    setImporting(null)
    setBusy(true)
    try {
      const r = await store.importAll(i.list, i.replaced)
      tell(
        null,
        t('settings.templates.imported', {
          added: r.added,
          replaced: r.replaced,
        }),
      )
    } catch (err) {
      if (err instanceof RequestError && err.code === 'import_changed') {
        // Changed since the check: check again and ask again
        tell(templateErrorText(err, t))
        await check(i.list)
      } else tell(importErrorText(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        {t('settings.templates.intro')}
      </p>
      {readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          {t('settings.templates.viewOnly')}
        </p>
      )}
      {!readOnly && store.readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          {t('settings.templates.newer')}
        </p>
      )}
      {(problem || (store.error && !store.loaded)) && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem ?? t('settings.templates.readFailed')}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      {store.loaded && store.templates.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {t('settings.templates.none')}
        </p>
      )}
      {store.templates.length > 0 && (
        <ul
          aria-label={t('settings.group.templates')}
          className="m-0 flex list-none flex-col p-0"
        >
          {store.templates.map((tpl) => {
            const name = visibleUnsafe(tpl.name)
            return (
              <li
                key={tpl.id}
                className="flex min-h-12 items-center gap-2 border-b border-border py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[15px] text-fg">{name}</p>
                  <p className="m-0 truncate text-[12px] text-fg-muted">
                    {visibleUnsafe(firstLine(tpl.text))}
                  </p>
                </div>
                {canWrite && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => edit(tpl)}
                      aria-label={t('settings.editName', { name })}
                    >
                      {t('settings.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeleting({ template: tpl })}
                      aria-label={t('settings.deleteName', { name })}
                    >
                      {t('settings.delete')}
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {canWrite && (
          <Button ref={newRef} variant="secondary" onClick={() => edit(null)}>
            {t('settings.templates.new')}
          </Button>
        )}
        {canWrite && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {t('settings.templates.import')}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={store.templates.length === 0}
          onClick={exportAll}
        >
          {t('settings.templates.export')}
        </Button>
      </div>
      {canWrite && (
        <>
          <p className="m-0 text-[12px] text-fg-muted">
            {t('settings.templates.exportFirst')}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label={t('settings.templates.file')}
            className="hidden"
            onChange={onFile}
          />
        </>
      )}
      {editing !== undefined && (
        <TemplateEditor
          template={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        title={
          deleting?.again
            ? t('settings.deleteAgain')
            : t('settings.deleteTitle', {
                name: visibleUnsafe(deleting?.template.name ?? ''),
              })
        }
        confirmLabel={t('settings.delete')}
        destructive
        defaultAction={deleting?.again ? 'cancel' : 'confirm'}
        onConfirm={() => remove(deleting as Deleting)}
        onCancel={() => setDeleting(null)}
      >
        <p className="m-0">
          {t('settings.deleteBody', {
            name: visibleUnsafe(deleting?.template.name ?? ''),
          })}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={!!importing}
        title={t('settings.templates.importTitle')}
        confirmLabel={t('settings.templates.importConfirm')}
        onConfirm={() => runImport(importing as Importing)}
        onCancel={() => setImporting(null)}
      >
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {importing && importing.added.length > 0 && (
            <NameList
              title={t('settings.templates.added')}
              names={importing.added}
            />
          )}
          {importing && importing.replaced.length > 0 && (
            <NameList
              title={t('settings.templates.replaced')}
              names={importing.replaced}
            />
          )}
          <p className="m-0 text-[12px] text-fg-muted">
            {t('settings.templates.noUndo')}
          </p>
        </div>
      </ConfirmDialog>
    </div>
  )
}

function NameList({ title, names }: { title: string; names: string[] }) {
  const { t } = useT()
  return (
    <div>
      <p className="m-0 text-sm font-medium text-fg">
        {t('settings.templates.listCount', { title, count: names.length })}
      </p>
      <ul aria-label={title} className="m-0 list-disc pl-5 text-sm text-fg">
        {names.map((n) => (
          <li key={n}>{visibleUnsafe(n)}</li>
        ))}
      </ul>
    </div>
  )
}

// A refused import, naming the template when the server says which
function importErrorText(err: unknown, t: Translate<MessageKey>): string {
  const text = templateErrorText(err, t)
  return err instanceof RequestError && err.index !== undefined
    ? t('settings.templates.at', { n: err.index + 1, problem: text })
    : text
}
