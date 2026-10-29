import { type FormEvent, useId, useRef, useState } from 'react'
import { type PromptTemplate, RequestError } from '../hooks/use-mux-api'
import {
  createPromptTemplate,
  updatePromptTemplate,
} from '../hooks/use-prompt-templates'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import {
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATE_TEXT,
  normalizeText,
  templateBytes,
  templateErrorText,
  templateProblem,
  VARIABLES,
} from '../utils/prompt-templates'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // The template to change; null makes a new one
  template: PromptTemplate | null
  onClose: () => void
}

const HINT: Record<(typeof VARIABLES)[number], MessageKey> = {
  file: 'settings.templates.varFile',
  selection: 'settings.templates.varSelection',
  branch: 'settings.templates.varBranch',
  input: 'settings.templates.varInput',
}

// What a refused save offers: another device changed the template (take
// theirs, or save over it) or deleted it (save this one as new)
type Refusal =
  | { kind: 'conflict'; theirs: PromptTemplate }
  | { kind: 'gone' }
  | { kind: 'other'; text: string }

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'

// Makes or changes a prompt template. The limits and hidden characters are
// checked here first; the server's answer is final.
export function TemplateEditor({ template, onClose }: Props) {
  const { t } = useT()
  const [base, setBase] = useState(template)
  const [name, setName] = useState(template?.name ?? '')
  const [text, setText] = useState(template?.text ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [saving, setSaving] = useState(false)
  // The field an error is about, marked invalid and pointing at it
  const [bad, setBad] = useState<'name' | 'text' | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const bytes = templateBytes(normalizeText(text))

  const save = async (over: PromptTemplate | null = base) => {
    const p = templateProblem(name, text, t)
    if (p) {
      setProblem(p.message)
      setBad(p.field)
      setRefusal(null)
      return
    }
    setProblem(null)
    setBad(null)
    setRefusal(null)
    setSaving(true)
    try {
      if (over)
        await updatePromptTemplate(over.id, {
          name,
          text,
          updated: over.updated,
        })
      else await createPromptTemplate({ name, text })
      onClose()
    } catch (err) {
      setSaving(false)
      if (
        err instanceof RequestError &&
        err.code === 'conflict' &&
        err.template
      )
        setRefusal({ kind: 'conflict', theirs: err.template })
      else if (err instanceof RequestError && err.code === 'not_found')
        setRefusal({ kind: 'gone' })
      else {
        setRefusal({ kind: 'other', text: templateErrorText(err, t) })
        if (err instanceof RequestError)
          setBad(
            err.field === 'name' || err.field === 'text' ? err.field : null,
          )
      }
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save()
  }

  // Puts {{v}} where the caret is in the text
  const insertVariable = (v: string) => {
    const box = textRef.current as HTMLTextAreaElement
    const token = `{{${v}}}`
    const start = box.selectionStart
    const next = text.slice(0, start) + token + text.slice(box.selectionEnd)
    setText(next)
    requestAnimationFrame(() => {
      box.focus()
      box.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={
        base
          ? t('settings.editName', { name: visibleUnsafe(base.name) })
          : t('settings.templates.newTitle')
      }
      focusOnOpen={() => nameRef.current?.focus()}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={`${ids}-name`} className="text-sm text-fg-muted">
          {t('settings.name')}
        </label>
        <input
          ref={nameRef}
          id={`${ids}-name`}
          type="text"
          value={name}
          // The limit is in characters, checked on save; maxLength counts
          // an emoji as two
          maxLength={MAX_TEMPLATE_NAME * 2}
          autoComplete="off"
          aria-invalid={bad === 'name' || undefined}
          aria-describedby={bad === 'name' ? `${ids}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
          className={`${FIELD} h-9 pointer-coarse:h-touch`}
        />
        <label htmlFor={`${ids}-text`} className="text-sm text-fg-muted">
          {t('settings.templates.text')}
        </label>
        <textarea
          ref={textRef}
          id={`${ids}-text`}
          value={text}
          rows={8}
          spellCheck={false}
          aria-invalid={bad === 'text' || undefined}
          aria-describedby={
            bad === 'text' ? `${ids}-size ${ids}-error` : `${ids}-size`
          }
          onChange={(e) => setText(e.target.value)}
          className={`${FIELD} py-1.5 font-term text-[13px]`}
        />
        <p
          id={`${ids}-size`}
          className={`m-0 text-[12px] ${bytes > MAX_TEMPLATE_TEXT ? 'text-danger' : 'text-fg-muted'}`}
        >
          {t('settings.templates.size', {
            used: Math.ceil(bytes / 1024),
            max: MAX_TEMPLATE_TEXT / 1024,
          })}
        </p>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-fg-muted">
            {t('settings.templates.insertVariable')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {VARIABLES.map((v) => (
              <Button
                key={v}
                size="sm"
                variant="secondary"
                onClick={() => insertVariable(v)}
                aria-label={t('settings.templates.insert', {
                  token: `{{${v}}}`,
                  hint: t(HINT[v]),
                })}
              >
                <span className="font-term">{`{{${v}}}`}</span>
              </Button>
            ))}
          </div>
          <p className="m-0 text-[12px] text-fg-muted">
            {t('settings.templates.filledIn', {
              list: VARIABLES.map((v) => `{{${v}}} ${t(HINT[v])}`).join(', '),
            })}
          </p>
        </div>
        {(problem || refusal?.kind === 'other') && (
          <p
            id={`${ids}-error`}
            role="alert"
            className="m-0 text-sm text-danger"
          >
            {problem ?? (refusal as { text: string }).text}
          </p>
        )}
        {refusal?.kind === 'conflict' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="m-0 text-sm text-danger">
              {t('settings.changedElsewhere')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setBase(refusal.theirs)
                  setName(refusal.theirs.name)
                  setText(refusal.theirs.text)
                  setRefusal(null)
                }}
              >
                {t('settings.loadTheirs')}
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  setBase(refusal.theirs)
                  void save(refusal.theirs)
                }}
              >
                {t('settings.keepMine')}
              </Button>
            </div>
          </div>
        )}
        {refusal?.kind === 'gone' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="m-0 text-sm text-danger">
              {t('settings.deletedElsewhere')}
            </p>
            <Button
              size="sm"
              className="self-start"
              disabled={saving}
              onClick={() => {
                setBase(null)
                void save(null)
              }}
            >
              {t('settings.saveAsNew')}
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {t('settings.save')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
