import { registerSW } from 'virtual:pwa-register'
import type { ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/theme-context'
import { I18nProvider } from './i18n/i18n-context'
import { APP_INFO } from './utils/app-info'
import { markStale, onChunkLoadError } from './utils/app-update'
import { markClassicScrollbars } from './utils/classic-scrollbars'
import { guardContextMenu } from './utils/context-menu-guard'
import { registerInstallPrompt } from './utils/install-prompt'
import './index.css'
import { watchIPadWindow } from './utils/ipad-window'
import { recordVersion } from './utils/star-prompt'

window.addEventListener('vite:preloadError', onChunkLoadError)

watchIPadWindow()
// Chromium may offer the install before the welcome screen asks for it
registerInstallPrompt()
markClassicScrollbars()
guardContextMenu()
// Before the first render, so Settings knows the page was just updated
recordVersion(APP_INFO.version)

function render(app: ReactNode) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <ThemeProvider>
      <I18nProvider>{app}</I18nProvider>
    </ThemeProvider>,
  )
}

// The demo build (--mode demo) answers the app's requests in the browser and
// registers no service worker. MODE is replaced at build time, so the release
// build drops this branch and the demo's chunk with it.
if (import.meta.env.MODE === 'demo') {
  import('./demo/install-demo').then(({ installDemo, DemoShell }) => {
    installDemo()
    render(
      <DemoShell>
        <App />
      </DemoShell>,
    )
  }, onChunkLoadError)
} else {
  // A new service worker waits; the update banner offers the reload. When
  // another tab lets it take over, onNeedReload replaces Workbox's reload of
  // this tab, which would lose an unsaved edit here.
  registerSW({
    immediate: true,
    onNeedRefresh: markStale,
    onNeedReload: markStale,
  })
  render(<App />)
}
