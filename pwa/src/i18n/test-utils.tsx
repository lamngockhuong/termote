import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Locale } from '.'
import { I18nContext } from './i18n-context'

// Renders ui with both the app and the welcome screen in locale
export function renderWithLocale(ui: ReactElement, locale: Locale) {
  return render(
    <I18nContext.Provider value={{ tourLocale: locale, appLocale: locale }}>
      {ui}
    </I18nContext.Provider>,
  )
}
