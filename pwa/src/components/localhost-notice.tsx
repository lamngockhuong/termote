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
  const link = loopbackAddress()
  if (!link) return null
  return (
    <Banner
      variant="warning"
      action={
        <>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => window.location.assign(link)}
          >
            Open 127.0.0.1
          </Button>
        </>
      }
    >
      Opened through localhost: every connection tries IPv6 first, which can
      slow each tab switch. Use 127.0.0.1 instead. It is another address to the
      browser: you sign in again there, settings and unsaved drafts stay here,
      and an installed app has to be installed again.
    </Banner>
  )
}
