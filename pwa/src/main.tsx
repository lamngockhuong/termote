import { registerSW } from 'virtual:pwa-register'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/theme-context'
import './index.css'

// autoUpdate: a new service worker takes over and the page reloads on its own.
registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
)
