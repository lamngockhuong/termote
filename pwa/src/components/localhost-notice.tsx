import { useT } from '../i18n/i18n-context'
import { loopbackAddress } from '../utils/loopback-address'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

interface Props {
  onDismiss: () => void
}

// Offers a page opened through localhost the same page at 127.0.0.1 (why:
// utils/loopback-address.ts). That is another origin: the sign-in cookie,
// local settings and drafts do not follow, and an installed app keeps its
// address, so it has to be installed again there.
export function LocalhostNotice({ onDismiss }: Props) {
  const { t } = useT()
  const link = loopbackAddress()
  if (!link) return null
  return (
    <Banner
      variant="warning"
      action={
        <>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t('shell.localhost.dismiss')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => window.location.assign(link)}
          >
            {t('shell.localhost.open')}
          </Button>
        </>
      }
    >
      {t('shell.localhost.body')}
    </Banner>
  )
}
