import { registerSW } from 'virtual:pwa-register'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/theme-context'
import { markStale, onChunkLoadError } from './utils/app-update'
import './index.css'
import { watchIPadWindow } from './utils/ipad-window'

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
)
