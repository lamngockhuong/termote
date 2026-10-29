import type { Locale } from '.'

// Values put into a message's {name} placeholders. count also picks the
// plural form: the key with _one or _other, as i18next names them.
export type Vars = Record<string, string | number>

export type Translate<K extends string> = (key: K, vars?: Vars) => string

// {name} replaced by vars.name; a placeholder without a value stays as it is
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

// The message for key in messages: its plural form for vars.count when it
// has one (the locale's category, else _other), else the key itself
function lookup(
  messages: Record<string, string>,
  locale: Locale,
  key: string,
  vars?: Vars,
): string | undefined {
  if (typeof vars?.count === 'number') {
    const category = new Intl.PluralRules(locale).select(vars.count)
    const plural = messages[`${key}_${category}`] ?? messages[`${key}_other`]
    if (plural !== undefined) return plural
  }
  return messages[key]
}

// t(key, vars) for locale: a key this locale lacks is read in English, and
// one English lacks too is shown as the key (a warning in development)
export function createT<K extends string>(
  messages: Record<string, string>,
  fallback: Record<string, string>,
  locale: Locale,
): Translate<K> {
  return (key, vars) => {
    const text =
      lookup(messages, locale, key, vars) ?? lookup(fallback, 'en', key, vars)
    if (text === undefined) {
      if (import.meta.env.DEV) console.warn(`i18n: no message for "${key}"`)
      return key
    }
    return interpolate(text, vars)
  }
}
