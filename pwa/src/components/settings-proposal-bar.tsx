import { useT } from '../i18n/i18n-context'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

interface Props {
  count: number
  onView: () => void
  onDismiss: () => void
}

// An agent proposed settings (termote settings propose): how many would
// change on this browser, to review or dismiss. A line under the top bar,
// never over the terminal.
export function SettingsProposalBar({ count, onView, onDismiss }: Props) {
  const { t } = useT()
  return (
    <Banner
      action={
        <>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t('shell.settingsProposal.dismiss')}
          </Button>
          <Button variant="primary" size="sm" onClick={onView}>
            {t('shell.settingsProposal.view')}
          </Button>
        </>
      }
    >
      {t('shell.settingsProposal.body', { count })}
    </Banner>
  )
}
