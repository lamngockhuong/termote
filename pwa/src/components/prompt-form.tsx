import { useId, useState } from 'react'
import {
  type FormValue,
  MAX_FREE_TEXT_BYTES,
  type PromptField,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'

// An OpenCode form (a question it asks, or a form a tool or MCP server
// opened) answered all at once. The server checks every value again and
// OpenCode checks the rest (formats, lengths), so the checks here are for
// the user: what is missing or out of range shows before anything is sent.

const encoder = new TextEncoder()

// What a field holds while it is filled in: text as typed (numbers too), a
// checkbox's state, or the options picked.
type Draft = Record<string, string | boolean | string[]>

const INPUT =
  'min-h-touch w-full rounded-control border border-border bg-bg px-3 py-2 text-[15px] text-fg focus-visible:border-accent focus-visible:outline-none aria-invalid:border-danger'

const INPUT_TYPES: Record<string, string> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local',
}

function initialDraft(fields: PromptField[]): Draft {
  const draft: Draft = {}
  for (const f of fields) {
    const d = f.default
    if (f.type === 'boolean') draft[f.key] = d === true
    else if (f.type === 'multiselect')
      draft[f.key] = Array.isArray(d) ? d.map(String) : []
    else draft[f.key] = d === undefined ? '' : String(d)
  }
  return draft
}

// The value a field sends, undefined when it is left empty
function fieldValue(
  f: PromptField,
  held: Draft[string],
): FormValue | undefined {
  if (f.type === 'boolean') return held === true
  if (f.type === 'multiselect') {
    const list = held as string[]
    return list.length > 0 ? list : undefined
  }
  const text = held as string
  if (text.trim() === '') return undefined
  return f.type === 'string' ? text : Number(text)
}

// A field shows while every one of its conditions holds; on a multiselect
// "eq" is one of the options picked (as OpenCode 2.3.0 checks it)
function shown(f: PromptField, values: Record<string, FormValue | undefined>) {
  return (f.when ?? []).every((w) => {
    const v = values[w.key]
    const eq = Array.isArray(v) ? v.includes(w.value as string) : v === w.value
    return w.op === 'eq' ? eq : !eq
  })
}

type Problem =
  | { key: 'required' }
  | { key: 'integer' }
  | { key: 'range'; min?: number; max?: number }
  | { key: 'items'; min?: number; max?: number }
  | { key: 'length' }
  | { key: 'chars'; min?: number; max?: number }

function problemOf(f: PromptField, v: FormValue | undefined): Problem | null {
  if (v === undefined) return f.required ? { key: 'required' } : null
  if (f.type === 'number' || f.type === 'integer') {
    // A number input holds a number or nothing (the browser drops the rest)
    const n = v as number
    if (f.type === 'integer' && !Number.isInteger(n)) return { key: 'integer' }
    if (
      (f.minimum !== undefined && n < f.minimum) ||
      (f.maximum !== undefined && n > f.maximum)
    )
      return { key: 'range', min: f.minimum, max: f.maximum }
    return null
  }
  const texts = Array.isArray(v) ? v : [String(v)]
  if (texts.some((s) => encoder.encode(s).length > MAX_FREE_TEXT_BYTES))
    return { key: 'length' }
  // In characters as OpenCode counts them (UTF-16 units)
  if (
    typeof v === 'string' &&
    ((f.minLength !== undefined && v.length < f.minLength) ||
      (f.maxLength !== undefined && v.length > f.maxLength))
  )
    return { key: 'chars', min: f.minLength, max: f.maxLength }
  if (
    Array.isArray(v) &&
    ((f.minItems !== undefined && v.length < f.minItems) ||
      (f.maxItems !== undefined && v.length > f.maxItems))
  )
    return { key: 'items', min: f.minItems, max: f.maxItems }
  return null
}

// The messages of a bound, by what is bounded
const WHICH = { range: 'Range', items: 'Items', chars: 'Chars' } as const

interface Props {
  fields: PromptField[]
  busy: boolean
  onSend: (answer: Record<string, FormValue>) => void
}

export function PromptForm({ fields, busy, onSend }: Props) {
  const { t } = useT()
  const id = useId()
  const [draft, setDraft] = useState(() => initialDraft(fields))
  // Problems show once a send was tried, not while the form is filled in
  const [tried, setTried] = useState(false)
  const set = (key: string, v: Draft[string]) =>
    setDraft((d) => ({ ...d, [key]: v }))

  const values: Record<string, FormValue | undefined> = {}
  for (const f of fields) values[f.key] = fieldValue(f, draft[f.key])
  const visible = fields.filter((f) => shown(f, values))
  const problems = new Map<string, Problem>()
  for (const f of visible) {
    const p = problemOf(f, values[f.key])
    if (p) problems.set(f.key, p)
  }

  const say = (p: Problem) => {
    switch (p.key) {
      case 'range':
      case 'items':
      case 'chars': {
        const which = WHICH[p.key]
        if (p.min !== undefined && p.max !== undefined)
          return t(`chat.form.between${which}`, { min: p.min, max: p.max })
        if (p.min !== undefined)
          return t(`chat.form.atLeast${which}`, { min: p.min })
        return t(`chat.form.atMost${which}`, { max: p.max as number })
      }
      case 'length':
        return t('chat.prompt.limit', { limit: MAX_FREE_TEXT_BYTES })
      default:
        return t(`chat.form.${p.key}`)
    }
  }

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        const first = visible.findIndex((f) => problems.has(f.key))
        if (first >= 0) {
          // To the first field to fix: a group's first input, or the input
          const el = document.getElementById(`${id}-${first}`) as HTMLElement
          const input =
            el.tagName === 'INPUT'
              ? el
              : (el.querySelector('input') as HTMLInputElement)
          input.focus()
          return
        }
        const answer: Record<string, FormValue> = {}
        for (const f of visible) {
          const v = values[f.key]
          if (v !== undefined) answer[f.key] = v
        }
        onSend(answer)
      }}
    >
      {visible.map((f, i) => {
        // By position: a key may hold a space, which would split an id list
        const fid = `${id}-${i}`
        const problem = tried ? problems.get(f.key) : undefined
        const problemId = `${fid}-problem`
        return (
          <FieldBox
            key={f.key}
            field={f}
            id={fid}
            held={draft[f.key]}
            busy={busy}
            invalid={!!problem}
            describedBy={problem ? problemId : undefined}
            onChange={(v) => set(f.key, v)}
          >
            {problem && (
              <p id={problemId} className="text-[12px] text-danger">
                {say(problem)}
              </p>
            )}
          </FieldBox>
        )
      })}
      <Button type="submit" variant="primary" disabled={busy}>
        {t('chat.prompt.send')}
      </Button>
    </form>
  )
}

interface FieldProps {
  field: PromptField
  id: string
  held: Draft[string]
  busy: boolean
  invalid: boolean
  describedBy?: string
  onChange: (v: Draft[string]) => void
  children: React.ReactNode
}

function FieldBox(props: FieldProps) {
  const { field: f, id, children } = props
  const { t } = useT()
  const title = visibleUnsafe(f.title || f.key)
  const required = f.required && (
    <span className="text-fg-muted"> ({t('chat.form.requiredMark')})</span>
  )
  const description = f.description && (
    <span className="block whitespace-pre-wrap break-words text-[12px] font-normal text-fg-muted">
      {visibleUnsafe(f.description)}
    </span>
  )
  // A list of options is a group with its title as legend; one input has a
  // label of its own
  if (f.options?.length) {
    return (
      <fieldset
        id={id}
        className="space-y-1"
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
      >
        <legend className="text-sm font-medium text-fg">
          {title}
          {required}
          {description}
        </legend>
        <Choices {...props} />
        {children}
      </fieldset>
    )
  }
  return (
    <div className="space-y-1">
      {f.type === 'boolean' ? (
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            id={id}
            type="checkbox"
            checked={props.held === true}
            disabled={props.busy}
            onChange={(e) => props.onChange(e.target.checked)}
            className="mt-1 accent-accent"
          />
          <span>
            <span className="font-medium">{title}</span>
            {description}
          </span>
        </label>
      ) : (
        <>
          <label htmlFor={id} className="block text-sm font-medium text-fg">
            {title}
            {required}
            {description}
          </label>
          <input
            id={id}
            type={
              f.type === 'string'
                ? (INPUT_TYPES[f.format ?? ''] ?? 'text')
                : 'number'
            }
            inputMode={
              f.type === 'integer'
                ? 'numeric'
                : f.type === 'number'
                  ? 'decimal'
                  : undefined
            }
            step={
              f.type === 'integer' ? 1 : f.type === 'number' ? 'any' : undefined
            }
            min={f.minimum}
            max={f.maximum}
            value={props.held as string}
            placeholder={
              f.placeholder ? visibleUnsafe(f.placeholder) : undefined
            }
            disabled={props.busy}
            aria-invalid={props.invalid || undefined}
            aria-describedby={props.describedBy}
            onChange={(e) => props.onChange(e.target.value)}
            className={INPUT}
          />
        </>
      )}
      {children}
    </div>
  )
}

// A field's options: one of them (string) or several (multiselect), and the
// field's own text when it takes other answers (custom).
function Choices({ field: f, id, held, busy, onChange }: FieldProps) {
  const { t } = useT()
  const multi = f.type === 'multiselect'
  // Only a field with options has them listed
  const options = f.options as NonNullable<PromptField['options']>
  const listed = (v: string) => options.some((o) => o.value === v)
  const picked = multi ? (held as string[]) : [held as string]
  // Text typed for "Other": for a single choice it is the value itself
  const [other, setOther] = useState(() =>
    multi ? '' : listed(held as string) ? '' : (held as string),
  )
  const [otherOn, setOtherOn] = useState(other !== '')
  const toggle = (v: string) => {
    if (!multi) {
      setOtherOn(false)
      onChange(v)
      return
    }
    const list = held as string[]
    onChange(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  }
  // Other text added to a multiselect, shown so it can be taken off again
  const extra = multi ? picked.filter((v) => !listed(v)) : []
  return (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label
          key={o.value}
          className="flex items-start gap-2 rounded-control px-1 py-1.5 text-sm text-fg hover:bg-surface"
        >
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={id}
            checked={picked.includes(o.value) && (multi || !otherOn)}
            disabled={busy}
            onChange={() => toggle(o.value)}
            className="mt-1 accent-accent"
          />
          <span className="min-w-0 break-words">
            {visibleUnsafe(o.label || o.value)}
            {o.detail && (
              <span className="block break-words text-[12px] text-fg-muted">
                {visibleUnsafe(o.detail)}
              </span>
            )}
          </span>
        </label>
      ))}
      {extra.map((v) => (
        <label
          key={v}
          className="flex items-start gap-2 rounded-control px-1 py-1.5 text-sm text-fg"
        >
          <input
            type="checkbox"
            checked
            disabled={busy}
            onChange={() => toggle(v)}
            className="mt-1 accent-accent"
          />
          <span className="min-w-0 break-words">{visibleUnsafe(v)}</span>
        </label>
      ))}
      {f.custom && (
        <div className="flex items-center gap-2">
          {!multi && (
            <input
              type="radio"
              name={id}
              aria-label={t('chat.prompt.other')}
              checked={otherOn}
              disabled={busy}
              onChange={() => {
                setOtherOn(true)
                onChange(other)
              }}
              className="accent-accent"
            />
          )}
          <input
            type="text"
            value={other}
            aria-label={t('chat.form.otherAnswer')}
            placeholder={t('chat.prompt.other')}
            disabled={busy}
            onChange={(e) => {
              setOther(e.target.value)
              if (!multi) {
                setOtherOn(true)
                onChange(e.target.value)
              }
            }}
            className={INPUT}
          />
          {multi && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !other.trim() || picked.includes(other)}
              onClick={() => {
                onChange([...picked, other])
                setOther('')
              }}
            >
              {t('chat.form.add')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
