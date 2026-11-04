import { X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { Banner } from '../components/ui/banner'
import { useT } from '../i18n/i18n-context'

// The strip above the demo saying what it is, with the way to the real
// thing. Hidden for the rest of the visit when dismissed: a reload of the
// tab keeps it hidden, a new visit shows it again.

const HIDDEN_KEY = 'termote-demo-banner'

const INSTALL_URL = {
  en: 'https://termote.ohnice.app/getting-started/',
  vi: 'https://termote.ohnice.app/vi/getting-started/',
}

function wasHidden(): boolean {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === 'hidden'
  } catch {
    return false
  }
}

export function DemoBanner({ onDismiss }: { onDismiss: () => void }) {
  const { t, locale } = useT()
  return (
    <Banner
      live={false}
      action={
        <>
          <a
            href={INSTALL_URL[locale]}
            className="shrink-0 rounded-control px-2 py-1 font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {t('shell.demo.install')}
          </a>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('shell.demo.dismiss')}
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </>
      }
    >
      {t('shell.demo.label')}
    </Banner>
  )
}

// The app under the banner: its height (--app-height, the whole viewport
// elsewhere) is what the banner leaves
export function DemoShell({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(wasHidden)
  const dismiss = () => {
    setHidden(true)
    try {
      sessionStorage.setItem(HIDDEN_KEY, 'hidden')
    } catch {
      // Storage blocked: hidden until the page reloads
    }
  }
  return (
    <div className="flex h-full flex-col">
      {!hidden && <DemoBanner onDismiss={dismiss} />}
      <div
        className="min-h-0 flex-1"
        style={{ '--app-height': '100%' } as CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}
