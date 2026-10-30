import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from 'react'
import { useSettings } from '../hooks/use-settings'
import { keepNotifyLocale } from '../utils/notify-locale'
import { browserLanguages, type Locale, type Locales, resolveLocales } from '.'
import { en, type MessageKey } from './messages/en'
import { vi } from './messages/vi'
import { createT, type Translate } from './translate'

// One t per locale, made once
const T: Record<Locale, Translate<MessageKey>> = {
  en: createT(en, en, 'en'),
  vi: createT(vi, en, 'vi'),
}

export function tFor(locale: Locale): Translate<MessageKey> {
  return T[locale]
}

// English everywhere until a provider says otherwise (a component rendered
// on its own, in a test)
export const I18nContext = createContext<Locales>({
  tourLocale: 'en',
  appLocale: 'en',
})

// The languages picked in Settings (or the browser's), for everything below;
// <html lang> and the words of a push notification follow the app's
export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings()
  const { tourLocale, appLocale } = resolveLocales({
    setting: settings.language,
    navigatorLanguages: browserLanguages(),
  })
  const value = useMemo(
    () => ({ tourLocale, appLocale }),
    [tourLocale, appLocale],
  )
  useEffect(() => {
    document.documentElement.lang = appLocale
    void keepNotifyLocale(appLocale)
  }, [appLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export interface UseT {
  t: Translate<MessageKey>
  locale: Locale
}

// The app's language
export function useT(): UseT {
  const { appLocale } = useContext(I18nContext)
  return { t: T[appLocale], locale: appLocale }
}

// The welcome screen's and the tour's language
export function useTourT(): UseT {
  const { tourLocale } = useContext(I18nContext)
  return { t: T[tourLocale], locale: tourLocale }
}
