import { useT } from '../i18n/i18n-context'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

interface Props {
  onEnglish: () => void
  onDismiss: () => void
}

// Tells a device that picked Vietnamese for the welcome screen and the tour,
// back when only those spoke it, that the whole app does now: once, with a
// way back to English.
export function LanguageNotice({ onEnglish, onDismiss }: Props) {
  const { t } = useT()
  return (
    <Banner
      action={
        <>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t('shell.languageNotice.dismiss')}
          </Button>
          <Button variant="primary" size="sm" onClick={onEnglish}>
            {t('shell.languageNotice.english')}
          </Button>
        </>
      }
    >
      {t('shell.languageNotice.body')}
    </Banner>
  )
}
