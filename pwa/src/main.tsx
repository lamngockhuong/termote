import { registerSW } from 'virtual:pwa-register'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/theme-context'
import { I18nProvider } from './i18n/i18n-context'
import { APP_INFO } from './utils/app-info'
import { markStale, onChunkLoadError } from './utils/app-update'
import { markClassicScrollbars } from './utils/classic-scrollbars'
import { registerInstallPrompt } from './utils/install-prompt'
import './index.css'
import { watchIPadWindow } from './utils/ipad-window'
import { recordVersion } from './utils/star-prompt'

// A new service worker waits; the update banner offers the reload. When
// another tab lets it take over, onNeedReload replaces Workbox's reload of
// this tab, which would lose an unsaved edit here.
registerSW({
  immediate: true,
  onNeedRefresh: markStale,
  onNeedReload: markStale,
})

window.addEventListener('vite:preloadError', onChunkLoadError)

watchIPadWindow()
// Chromium may offer the install before the welcome screen asks for it
registerInstallPrompt()
markClassicScrollbars()
// Before the first render, so Settings knows the page was just updated
recordVersion(APP_INFO.version)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider>
      <App />
    </I18nProvider>
  </ThemeProvider>,
)
