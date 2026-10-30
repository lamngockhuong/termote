import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type { PromptTemplate } from '../hooks/use-mux-api'
import { refreshTemplates, templateById } from '../hooks/use-prompt-templates'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { requestDraftInsert } from '../utils/chat-draft'
import { onPaneRemap } from '../utils/pane-remap'
import {
  fillTemplate,
  MAX_TEMPLATE_TEXT,
  type TemplateVariable,
  templateBytes,
  templateVariables,
} from '../utils/prompt-templates'
import {
  fetchBranch,
  knownTemplateValues,
} from '../utils/resolve-template-vars'
import {
  onTemplateFill,
  type TemplateFill,
  takeTemplateFill,
} from '../utils/template-fill-request'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

// What the pane holds now, from App's snapshot: null when it is gone
export interface FillPane {
  agent?: string
  // Its Herdr worktree group's branch
  branch?: string
}

interface Props {
  pane: (paneId: string) => FillPane | null
  // What the terminal has selected now, when it shows paneId ('' otherwise)
  terminalText: (paneId: string) => string
  notify: (message: string) => void
}

interface Open {
  fill: TemplateFill
  template: PromptTemplate
  vars: TemplateVariable[]
  values: Record<TemplateVariable, string>
  sources: Record<TemplateVariable, string>
  // The fields the user changed: their source no longer says where they
  // came from
  edited: Partial<Record<TemplateVariable, boolean>>
  // The branch is being read from the server
  branchLoading: boolean
}

const LABEL: Record<TemplateVariable, MessageKey> = {
  input: 'chat.fill.var.input',
  file: 'chat.fill.var.file',
  selection: 'chat.fill.var.selection',
  branch: 'chat.fill.var.branch',
}

// The views a value can come from, named by the key of their line
// (utils/resolve-template-vars.ts, the selections); any other source is a
// file's path
const VIEWS: ReadonlySet<string> = new Set<MessageKey>([
  'chat.fill.from.file',
  'chat.fill.from.terminal',
  'chat.fill.from.chat',
  'chat.fill.from.git',
  'chat.fill.from.worktree',
])

// Where a value came from, as its field says it
const sourceText = (source: string, t: Translate<MessageKey>) =>
  VIEWS.has(source) ? t(source as MessageKey) : t('chat.fill.from', { source })

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'

// The one dialog that fills a picked template's variables before its text
// goes into the Chat draft: never sent, the user sends it. A template
// without variables goes in as it is (the server refused hidden characters
// when it was saved).
export function TemplateFillDialog({ pane, terminalText, notify }: Props) {
  const { t } = useT()
  const [open, setOpen] = useState<Open | null>(null)
  const keepFocus = useRef(false)
  const ids = useId()
  const latest = useRef({ pane, terminalText, notify, t })
  latest.current = { pane, terminalText, notify, t }
  // The fill a late branch read belongs to
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    const start = () => {
      const fill = takeTemplateFill()
      if (!fill) return
      const { pane, terminalText, notify, t } = latest.current
      const template = templateById(fill.templateId)
      if (!template) {
        notify(t('chat.fill.deleted'))
        void refreshTemplates()
        return
      }
      const vars = templateVariables(template.text)
      if (vars.length === 0) {
        requestDraftInsert(
          fill.paneId,
          { text: template.text, at: fill.at },
          fill.agent,
        )
        return
      }
      const known = knownTemplateValues(fill.paneId, {
        terminalText: terminalText(fill.paneId),
        worktreeBranch: pane(fill.paneId)?.branch,
      })
      const branchLoading = vars.includes('branch') && !known.branch.value
      const next: Open = {
        fill,
        template,
        vars,
        values: {
          file: known.file.value,
          selection: known.selection.value,
          branch: known.branch.value,
          input: '',
        },
        sources: {
          file: known.file.source,
          selection: known.selection.source,
          branch: known.branch.source,
          input: '',
        },
        edited: {},
        branchLoading,
      }
      keepFocus.current = false
      setOpen(next)
      if (branchLoading)
        void fetchBranch(fill.paneId).then((branch) => {
          // Only into this fill, and only a field the user left alone
          setOpen((o) =>
            o && o.fill === fill
              ? {
                  ...o,
                  branchLoading: false,
                  ...(!o.edited.branch && {
                    values: { ...o.values, branch },
                    sources: {
                      ...o.sources,
                      branch: branch && 'chat.fill.from.git',
                    },
                  }),
                }
              : o,
          )
        })
    }
    start()
    return onTemplateFill(start)
  }, [])

  // The pane moved or went: the text would land in the wrong draft
  useEffect(
    () =>
      onPaneRemap((shift) => {
        if (openRef.current && shift.stale.has(openRef.current.fill.paneId))
          setOpen(null)
      }),
    [],
  )
  // Once the dialog is gone, what the user chose: the text into the draft
  // (the box takes the focus then: while a modal dialog is open, nothing
  // outside it can), or, closed without it, the focus back to the box when
  // it went nowhere (opened from the palette, which had it)
  const after = useRef<{ fill: TemplateFill; text?: string } | null>(null)
  useEffect(() => {
    const a = after.current
    if (open || !a) return
    after.current = null
    if (a.text !== undefined)
      requestDraftInsert(
        a.fill.paneId,
        { text: a.text, at: a.fill.at },
        a.fill.agent,
      )
    else if (document.activeElement === document.body)
      requestDraftInsert(a.fill.paneId, null, a.fill.agent)
  }, [open])

  // Its agent changed (or the pane is gone): the same
  const now = open && pane(open.fill.paneId)
  const gone = !!open && (!now || now.agent !== open.fill.agent)
  useEffect(() => {
    if (gone) setOpen(null)
  }, [gone])

  if (!open) return null
  const { template, vars, values, sources } = open
  const text = fillTemplate(template.text, values)
  const bytes = templateBytes(text)
  const tooLong = bytes > MAX_TEMPLATE_TEXT
  const id = (v: TemplateVariable) => `${ids}-${v}`
  // Your text first: it is the one always typed
  const fields = [...vars].sort(
    (a, b) => Number(b === 'input') - Number(a === 'input'),
  )

  const close = () => {
    after.current = { fill: open.fill }
    setOpen(null)
  }
  const insert = (e?: FormEvent) => {
    e?.preventDefault()
    after.current = { fill: open.fill, text }
    // The composer takes the focus to the draft
    keepFocus.current = true
    setOpen(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) insert(e)
  }
  const set = (v: TemplateVariable, value: string) =>
    setOpen({
      ...open,
      values: { ...values, [v]: value },
      edited: { ...open.edited, [v]: true },
    })

  return (
    <Sheet
      isOpen
      onClose={close}
      title={t('chat.fill.title', { name: visibleUnsafe(template.name) })}
      keepFocus={keepFocus}
      focusOnOpen={() => document.getElementById(id(fields[0]))?.focus()}
    >
      <form
        onSubmit={insert}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-3 p-4"
      >
        {fields.map((v) => {
          const loading = v === 'branch' && open.branchLoading
          const hint = loading
            ? t('chat.fill.readingBranch')
            : v === 'input' || open.edited[v]
              ? ''
              : sources[v]
                ? sourceText(sources[v], t)
                : t('chat.fill.nothing')
          const multi = v === 'input' || v === 'selection'
          const props = {
            id: id(v),
            value: values[v],
            'aria-describedby': hint ? `${id(v)}-hint` : undefined,
            'aria-busy': loading || undefined,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (
              e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
            ) => set(v, e.target.value),
          }
          return (
            <div key={v} className="flex flex-col gap-1">
              <label htmlFor={id(v)} className="text-sm text-fg-muted">
                {t(LABEL[v])}{' '}
                <span className="font-term text-[12px]">{`{{${v}}}`}</span>
              </label>
              {multi ? (
                <textarea {...props} rows={3} className={FIELD} />
              ) : (
                <input
                  {...props}
                  type="text"
                  className={`${FIELD} h-9 pointer-coarse:h-touch`}
                />
              )}
              {hint && (
                <p
                  id={`${id(v)}-hint`}
                  className="m-0 text-[12px] text-fg-muted"
                >
                  {hint}
                </p>
              )}
            </div>
          )
        })}
        <div className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">
            {t('chat.fill.preview')}
          </span>
          <pre
            data-testid="template-preview"
            className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-bg p-2.5 font-term text-[12px] text-fg"
          >
            {visibleUnsafe(text, true)}
          </pre>
          <p
            className={`m-0 text-[12px] ${tooLong ? 'text-danger' : 'text-fg-muted'}`}
          >
            {t(tooLong ? 'chat.fill.sizeTooLong' : 'chat.fill.size', {
              used: Math.ceil(bytes / 1024),
              max: MAX_TEMPLATE_TEXT / 1024,
            })}
          </p>
        </div>
        <p className="m-0 text-[12px] text-fg-muted">{t('chat.fill.note')}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('chat.fill.insert')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
