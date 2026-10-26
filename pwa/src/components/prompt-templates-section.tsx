import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { type PromptTemplate, RequestError } from '../hooks/use-mux-api'
import { usePromptTemplates } from '../hooks/use-prompt-templates'
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
  const t = usePromptTemplates()
  const { refresh } = t
  const canWrite = !readOnly && !t.readOnly
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
      await t.remove(template)
      tell(null, `Deleted ${visibleUnsafe(template.name)}`)
    } catch (err) {
      if (
        err instanceof RequestError &&
        err.code === 'conflict' &&
        err.template
      )
        setDeleting({ template: err.template, again: true })
      else if (err instanceof RequestError && err.code === 'not_found') {
        // Gone already: what the user wanted
        tell(null, `Deleted ${visibleUnsafe(template.name)}`)
        void refresh()
      } else
        tell(
          err instanceof RequestError && err.code
            ? templateErrorText(err)
            : 'Could not delete the template',
        )
    } finally {
      // The row and its button are gone: keep the place in the list
      newRef.current?.focus()
    }
  }

  const exportAll = () => {
    const f = exportFile(t.templates)
    saveMadeFile(
      new File([f.text], f.name, { type: 'application/json' }),
    ).catch(() => tell('Could not export the templates'))
  }

  // Asks the server what list would add and replace, then the user
  const check = async (list: TemplateEntry[]) => {
    try {
      const preview = await t.previewImport(list)
      setImporting({ list, ...preview })
    } catch (err) {
      tell(importErrorText(err))
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    tell(null)
    if (file.size > MAX_IMPORT_FILE) {
      tell(`The file is larger than ${MAX_IMPORT_FILE / 1024 / 1024} MB`)
      return
    }
    setBusy(true)
    try {
      let json: string
      try {
        json = await file.text()
      } catch {
        tell('Could not read the file')
        return
      }
      const parsed = parseImport(json)
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
      const r = await t.importAll(i.list, i.replaced)
      tell(null, `Imported: ${r.added} added, ${r.replaced} replaced`)
    } catch (err) {
      if (err instanceof RequestError && err.code === 'import_changed') {
        // Changed since the check: check again and ask again
        tell(templateErrorText(err))
        await check(i.list)
      } else tell(importErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        Saved on this server, shared by every device that signs in to it. Insert
        one from the Chat: the Templates button, the / list or the command
        palette.
      </p>
      {readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          This device is view only: the templates can be read and exported.
        </p>
      )}
      {!readOnly && t.readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          Saved by a newer Termote; update it to change templates.
        </p>
      )}
      {(problem || (t.error && !t.loaded)) && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem ?? 'Could not read the templates'}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      {t.loaded && t.templates.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">No templates yet.</p>
      )}
      {t.templates.length > 0 && (
        <ul
          aria-label="Prompt templates"
          className="m-0 flex list-none flex-col p-0"
        >
          {t.templates.map((tpl) => {
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
                      aria-label={`Edit ${name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeleting({ template: tpl })}
                      aria-label={`Delete ${name}`}
                    >
                      Delete
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
            New template
          </Button>
        )}
        {canWrite && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Import…
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={t.templates.length === 0}
          onClick={exportAll}
        >
          Export
        </Button>
      </div>
      {canWrite && (
        <>
          <p className="m-0 text-[12px] text-fg-muted">
            Export first to keep a copy: an import cannot be undone.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="Templates file to import"
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
            ? 'Changed on another device: delete anyway?'
            : `Delete ${visibleUnsafe(deleting?.template.name ?? '')}?`
        }
        confirmLabel="Delete"
        destructive
        defaultAction={deleting?.again ? 'cancel' : 'confirm'}
        onConfirm={() => remove(deleting as Deleting)}
        onCancel={() => setDeleting(null)}
      >
        <p className="m-0">
          Every device of this server loses{' '}
          {visibleUnsafe(deleting?.template.name ?? '')}.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={!!importing}
        title="Import templates?"
        confirmLabel="Import"
        onConfirm={() => runImport(importing as Importing)}
        onCancel={() => setImporting(null)}
      >
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {importing && importing.added.length > 0 && (
            <NameList title="New" names={importing.added} />
          )}
          {importing && importing.replaced.length > 0 && (
            <NameList
              title="Replaces the existing template"
              names={importing.replaced}
            />
          )}
          <p className="m-0 text-[12px] text-fg-muted">
            An import cannot be undone.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  )
}

function NameList({ title, names }: { title: string; names: string[] }) {
  return (
    <div>
      <p className="m-0 text-sm font-medium text-fg">
        {title} ({names.length})
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
function importErrorText(err: unknown): string {
  const text = templateErrorText(err)
  return err instanceof RequestError && err.index !== undefined
    ? `Template ${err.index + 1}: ${text}`
    : text
}
