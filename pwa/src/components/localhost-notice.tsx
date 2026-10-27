import { useState } from 'react'
import {
  dismissLocalhostNotice,
  localhostNoticeDismissed,
  loopbackAddress,
} from '../utils/loopback-address'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

// Warns a page opened through localhost that every new connection waits
// for IPv6 first, and offers the same page at 127.0.0.1. An installed app
// keeps its address, so it has to be installed again from there.
export function LocalhostNotice() {
  const [link, setLink] = useState(() =>
    localhostNoticeDismissed() ? null : loopbackAddress(),
  )
  if (!link) return null
  return (
    <Banner
      variant="warning"
      action={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissLocalhostNotice()
              setLink(null)
            }}
          >
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
      slow each tab switch. Use 127.0.0.1 instead (an installed app has to be
      installed again from there).
    </Banner>
  )
}
