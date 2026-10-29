// Prompt templates: their variables, filling them in, and the JSON file
// they are exported to and imported from. The limits are the server's
// (server/template_store.go), checked here first so the editor and an
// import say what is wrong before anything is sent.

import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'

export const VARIABLES = ['file', 'selection', 'branch', 'input'] as const
export type TemplateVariable = (typeof VARIABLES)[number]

export const MAX_TEMPLATES = 100
// In characters (code points), as the server counts runes
export const MAX_TEMPLATE_NAME = 64
// In bytes: the Chat composer's limit, so an inserted template can be sent
export const MAX_TEMPLATE_TEXT = 16 * 1024
// An import file read from disk: 100 templates of the largest size, JSON
// escaped, fit (the server's body limit is 100 × 40 KiB; the list is sent
// again unindented)
export const MAX_IMPORT_FILE = 4 * 1024 * 1024

const encoder = new TextEncoder()
export const templateBytes = (s: string) => encoder.encode(s).length

const VARIABLE = /\{\{(file|selection|branch|input)\}\}/g

// The variables text uses, each once, in the order they first appear
export function templateVariables(text: string): TemplateVariable[] {
  const seen = new Set<TemplateVariable>()
  for (const m of text.matchAll(VARIABLE)) seen.add(m[1] as TemplateVariable)
  return [...seen]
}

// text with each variable replaced by its value, taken as it is: a value
// holding $& or {{input}} is not read again. An unknown {{name}} stays.
export function fillTemplate(
  text: string,
  values: Partial<Record<TemplateVariable, string>>,
): string {
  return text
    .split(VARIABLE)
    .map((part, i) => (i % 2 ? (values[part as TemplateVariable] ?? '') : part))
    .join('')
}

// Characters the server refuses, as it does: controls (the text keeps tab
// and newline), format characters but the joiners (bidi marks, zero width
// space, BOM), tags and the variation selectors supplement.
export const HIDDEN =
  /(?![\u200c\u200d])(?:[\p{Cc}\p{Cf}]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}])/gu

export interface HiddenChar {
  // Index in the string, in characters (code points), and the character
  // as U+XXXX
  index: number
  codePoint: string
}

// The characters of text the server refuses; tab and newline only when
// multiline is false (a name)
export function hiddenChars(text: string, multiline = true): HiddenChar[] {
  const out: HiddenChar[] = []
  for (const m of text.matchAll(HIDDEN)) {
    if (multiline && (m[0] === '\t' || m[0] === '\n')) continue
    out.push({
      index: [...text.slice(0, m.index)].length,
      codePoint: `U+${(m[0].codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`,
    })
  }
  return out
}

// Line breaks as the server stores them
export const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n')

// name trimmed as the server trims it (Go's strings.TrimSpace: Unicode
// white space, which a BOM is not)
export const trimName = (name: string) =>
  name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

export interface TemplateProblem {
  field: 'name' | 'text'
  message: string
}

// What keeps name and text from being saved, or null
export function templateProblem(
  name: string,
  text: string,
  t: Translate<MessageKey>,
): TemplateProblem | null {
  const n = trimName(name)
  const body = normalizeText(text)
  const length = [...n].length
  if (length === 0)
    return { field: 'name', message: t('settings.templates.nameIt') }
  if (length > MAX_TEMPLATE_NAME)
    return {
      field: 'name',
      message: t('settings.nameTooLong', { max: MAX_TEMPLATE_NAME }),
    }
  const inName = hiddenChars(n, false)
  if (inName.length)
    return {
      field: 'name',
      message: t('settings.nameHidden', { code: inName[0].codePoint }),
    }
  if (body === '')
    return { field: 'text', message: t('settings.templates.empty') }
  if (templateBytes(body) > MAX_TEMPLATE_TEXT)
    return {
      field: 'text',
      message: t('settings.templates.tooLarge', {
        max: MAX_TEMPLATE_TEXT / 1024,
      }),
    }
  const inText = hiddenChars(body)
  if (inText.length)
    return {
      field: 'text',
      message: t('settings.templates.textHidden', {
        code: inText[0].codePoint,
        index: inText[0].index + 1,
      }),
    }
  return null
}

export interface TemplateEntry {
  name: string
  text: string
}

// The export file: names and texts only, unindented, so 100 templates of
// the largest size stay under MAX_IMPORT_FILE.
export function exportFile(
  list: TemplateEntry[],
  now = new Date(),
): { name: string; text: string } {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return {
    name: `termote-templates-${day}.json`,
    text: JSON.stringify({
      v: 1,
      templates: list.map(({ name, text }) => ({ name, text })),
    }),
  }
}

export type ParsedImport =
  | { ok: true; templates: TemplateEntry[] }
  | { ok: false; error: string }

// The templates of an export file, or what is wrong with it. What the
// server would add or replace is asked of it (a dry run), never worked out
// here.
export function parseImport(
  json: string,
  t: Translate<MessageKey>,
): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: t('settings.templates.notJson') }
  }
  const file = data as { v?: unknown; templates?: unknown } | null
  if (typeof file !== 'object' || file === null || Array.isArray(file))
    return { ok: false, error: t('settings.templates.notTemplates') }
  if (file.v !== 1)
    return { ok: false, error: t('settings.templates.otherVersion') }
  if (!Array.isArray(file.templates))
    return { ok: false, error: t('settings.templates.notTemplates') }
  if (file.templates.length === 0)
    return { ok: false, error: t('settings.templates.fileEmpty') }
  if (file.templates.length > MAX_TEMPLATES)
    return {
      ok: false,
      error: t('settings.templates.fileTooMany', {
        count: file.templates.length,
        max: MAX_TEMPLATES,
      }),
    }
  const templates: TemplateEntry[] = []
  const names = new Set<string>()
  for (const [i, entry] of file.templates.entries()) {
    const n = i + 1
    if (typeof entry?.name !== 'string' || typeof entry?.text !== 'string')
      return { ok: false, error: t('settings.templates.noNameOrText', { n }) }
    const problem = templateProblem(entry.name, entry.text, t)
    if (problem)
      return {
        ok: false,
        error: t('settings.templates.at', { n, problem: problem.message }),
      }
    const name = trimName(entry.name)
    const key = name.toLowerCase()
    if (names.has(key))
      return { ok: false, error: t('settings.templates.sameNameAt', { n }) }
    names.add(key)
    templates.push({ name, text: normalizeText(entry.text) })
  }
  return { ok: true, templates }
}

// The templates whose name has a word starting with query, or starts with
// it once spaces are left out of both ("codere", "code r" and "Code review"
// find "Code review"), case aside. The / list's query stops at a space, so
// a name of several words is found by any one of them.
export function matchTemplates<T extends { name: string }>(
  list: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  const joined = q.replace(/\s+/g, '')
  return list.filter((t) => {
    const name = t.name.toLowerCase()
    return (
      name.replace(/\s+/g, '').startsWith(joined) ||
      name.split(/[\s\-_/.:]+/).some((w) => w.startsWith(q))
    )
  })
}

// The first line of a template's text, cut to max characters with an
// ellipsis, for a row's second line
export function firstLine(text: string, max = 80): string {
  const chars = [...text.split('\n', 1)[0]]
  return chars.length > max
    ? `${chars.slice(0, max - 1).join('')}…`
    : chars.join('')
}

// What a refused template change tells the user, by the server's code
export function templateErrorText(
  err: unknown,
  t: Translate<MessageKey>,
): string {
  const e = err as { code?: string; message?: string; field?: string } | null
  switch (e?.code) {
    case 'name_taken':
      return t('settings.templates.nameTaken')
    case 'too_many':
      return t('settings.templates.tooMany', { max: MAX_TEMPLATES })
    case 'invalid_template':
      return t('settings.notSaved', { message: e.message ?? '' })
    case 'duplicate_name':
      return t('settings.templates.duplicateName')
    case 'conflict':
      return t('settings.changedElsewhere')
    case 'not_found':
      return t('settings.deletedElsewhere')
    case 'newer_format':
      return t('settings.templates.newerFormat')
    case 'view_only':
      return t('settings.viewOnly')
    case 'templates_unavailable':
      return t('settings.templates.unavailable')
    case 'busy':
      return t('settings.templates.busy')
    case 'too_large':
      return t('settings.tooLarge')
    case 'import_changed':
      return t('settings.templates.importChanged')
    default:
      return t('settings.templates.saveFailed')
  }
}
