import type { Locale } from '.'

// Dates and times in the locale's own way, through Intl

export function formatDateTime(date: Date | number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatDate(date: Date | number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

// seconds: with them ("2:03:27 PM"), for a log
export function formatTime(
  date: Date | number,
  locale: Locale,
  seconds = false,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeStyle: seconds ? 'medium' : 'short',
  }).format(date)
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value)
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

// How long ago date was, or how far ahead it is ("5 minutes ago", "in 2
// days"), in the largest whole unit; under a minute counts seconds
export function formatRelative(
  date: Date | number,
  locale: Locale,
  now: number = Date.now(),
): string {
  const diff = +date - now
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(Math.round(diff / 1000), 'second')
}
