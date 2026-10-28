import { registerSW } from 'virtual:pwa-register'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/theme-context'
import { APP_INFO } from './utils/app-info'
import { markStale, onChunkLoadError } from './utils/app-update'
import { markClassicScrollbars } from './utils/classic-scrollbars'
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
markClassicScrollbars()
// Before the first render, so Settings knows the page was just updated
recordVersion(APP_INFO.version)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
)
