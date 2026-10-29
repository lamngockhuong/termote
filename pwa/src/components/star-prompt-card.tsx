import { Star } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { APP_INFO } from '../utils/app-info'
import { finishStarPrompt, isStarPromptPending } from '../utils/star-prompt'
import { Button, FOCUS_RING } from './ui/button'

// Asked once after an update, in Settings only, so it never covers a
// terminal. Following the link or declining it ends it for good; nothing in
// the app depends on a star.
export function StarPromptCard({ version }: { version: string }) {
  const { t } = useT()
  const [shown, setShown] = useState(isStarPromptPending)
  if (!shown) return null

  const finish = () => {
    finishStarPrompt()
    setShown(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-info/12 px-3 py-2">
      <p className="m-0 min-w-0 flex-1 basis-40 text-[13px] text-fg">
        {t('settings.star.prompt', { version })}
      </p>
      <div className="flex items-center gap-2">
        <a
          href={APP_INFO.repository}
          target="_blank"
          rel="noopener noreferrer"
          onClick={finish}
          onAuxClick={finish}
          className={`inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline ${FOCUS_RING}`}
        >
          <Star size={16} aria-hidden="true" />
          {t('settings.star.link')}
          <span className="sr-only"> {t('settings.newTab')}</span>
        </a>
        <Button variant="ghost" size="sm" onClick={finish}>
          {t('settings.star.decline')}
        </Button>
      </div>
    </div>
  )
}
