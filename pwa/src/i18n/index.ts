// The languages the PWA is written in, and which of them the whole app
// speaks. A language is added to APP_LOCALES once every area is translated;
// until then it covers only the welcome screen and the tour.
export const LOCALES = ['en', 'vi'] as const
export type Locale = (typeof LOCALES)[number]

export const APP_LOCALES: readonly Locale[] = ['en']

// What Settings keeps: a language, or auto to follow the browser's
export type LanguageSetting = 'auto' | Locale
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = [
  'auto',
  ...LOCALES,
]

// A saved language, kept only when it is one this version knows
export function resolveLanguage(value: unknown): LanguageSetting {
  return LANGUAGE_SETTINGS.includes(value as LanguageSetting)
    ? (value as LanguageSetting)
    : 'auto'
}

// The browser's first language, when it is Vietnamese; English otherwise
export function detectLocale(languages: readonly string[]): Locale {
  return languages[0]?.toLowerCase().startsWith('vi') ? 'vi' : 'en'
}

export interface Locales {
  // The welcome screen and the tour: any language the user picked
  tourLocale: Locale
  // The rest of the app: the picked language once the app speaks it
  appLocale: Locale
}

export function resolveLocales({
  setting,
  navigatorLanguages,
  appLocales = APP_LOCALES,
}: {
  setting: LanguageSetting
  navigatorLanguages: readonly string[]
  appLocales?: readonly Locale[]
}): Locales {
  const tourLocale =
    setting === 'auto' ? detectLocale(navigatorLanguages) : setting
  return {
    tourLocale,
    appLocale: appLocales.includes(tourLocale) ? tourLocale : 'en',
  }
}

// The browser's languages; none where the browser does not say
export function browserLanguages(): readonly string[] {
  return navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean)
}
