import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useDevices } from '../hooks/use-devices'
import { useSettings } from '../hooks/use-settings'
import type { Session } from '../types/session'
import {
  installOffer,
  onInstallOfferChange,
  promptInstall,
} from '../utils/install-prompt'
import { notificationSupport } from '../utils/notify-permission'
import {
  buildWelcomeFacts,
  type NextAction,
  type NotifyState,
  shouldShowWelcome,
  type WaitingAgent,
  WELCOME_VERSION,
} from '../utils/welcome'
import { type WelcomeAreas, WelcomeSheet } from './welcome-sheet'

// Waited for the first session list before the welcome screen gives up for
// this visit (the server unreachable): it then shows at the next one
export const WELCOME_READY_MS = 5000

interface Props {
  // The first session list and the server's caps are in
  ready: boolean
  // Not now: a focus window, or a link to a pane (from a notification) whose
  // prompt the screen would cover. It shows at the next visit.
  suppressed: boolean
  // Raised by Settings › Show welcome screen
  openRequest: number
  mobile: boolean
  backend: string
  sessions: Session[]
  readOnly: boolean
  // caps.auth; caps.devices for a device that may pair others
  signIn?: boolean
  devices: boolean
  areas: WelcomeAreas
  version: string
  keys: { commands?: string; files?: string }
  onOpenPane: (agent: WaitingAgent) => void
  onOpenTerminal: () => void
  onStartSession: () => void
  // Opens Settings at a group: notifications, devices
  onOpenSettings: (group: string) => void
  onTour?: () => void
}

function notifyState(on: boolean): NotifyState {
  const support = notificationSupport()
  if (support === 'unsupported') return 'unsupported'
  return on && support === 'granted' ? 'on' : 'off'
}

// Decides once per visit whether this device sees the welcome screen, marks
// it seen the moment it opens (a flaky connection must not bring it back at
// every visit), and gathers what it states from the app as it is.
export function WelcomeHost({
  ready,
  suppressed,
  openRequest,
  ...rest
}: Props) {
  const { settings, updateSetting } = useSettings()
  const [open, setOpen] = useState(false)
  const decided = useRef(false)
  const seen = settings.welcomeSeenVersion

  useEffect(() => {
    if (decided.current) return
    if (suppressed) {
      decided.current = true
      return
    }
    if (!ready) {
      const timer = setTimeout(() => {
        decided.current = true
      }, WELCOME_READY_MS)
      return () => clearTimeout(timer)
    }
    decided.current = true
    if (!shouldShowWelcome(seen)) return
    setOpen(true)
    updateSetting('welcomeSeenVersion', WELCOME_VERSION)
  }, [ready, suppressed, seen, updateSetting])

  useEffect(() => {
    if (openRequest > 0) setOpen(true)
  }, [openRequest])

  if (!open) return null
  return <OpenWelcomeHost {...rest} onClose={() => setOpen(false)} />
}

// Mounted only while the screen shows: the paired devices are read then
function OpenWelcomeHost({
  mobile,
  backend,
  sessions,
  readOnly,
  signIn,
  devices,
  areas,
  version,
  keys,
  onOpenPane,
  onOpenTerminal,
  onStartSession,
  onOpenSettings,
  onTour,
  onClose,
}: Omit<Props, 'ready' | 'suppressed' | 'openRequest'> & {
  onClose: () => void
}) {
  const { settings, updateSetting } = useSettings()
  const install = useSyncExternalStore(onInstallOfferChange, installOffer)
  const paired = useDevices(!mobile && devices).devices
  const notify = notifyState(settings.notifyAgents)
  const facts = buildWelcomeFacts({
    sessions,
    readOnly,
    notify,
    install,
    desktop: !mobile,
    pairedDevices: devices ? paired?.length : undefined,
  })

  const then = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const onAction = (action: NextAction) => {
    switch (action.kind) {
      case 'waiting':
        return then(() => onOpenPane(action.agent))()
      case 'start':
        return then(onStartSession)()
      case 'notify':
        return then(() => onOpenSettings('sessions'))()
      case 'install':
        // The prompt runs in this click; the screen stays for what is left
        return void promptInstall()
      case 'pair':
        return then(() => onOpenSettings('devices'))()
    }
  }

  return (
    <WelcomeSheet
      isOpen
      onClose={onClose}
      mobile={mobile}
      host={window.location.host}
      version={version}
      backend={backend}
      facts={facts}
      readOnly={readOnly}
      notify={notify}
      signIn={signIn}
      areas={areas}
      keys={keys}
      onLanguage={(locale) => updateSetting('language', locale)}
      onAction={onAction}
      onPrimary={then(() =>
        facts.primary === 'waiting'
          ? onOpenPane(facts.waiting[0])
          : onOpenTerminal(),
      )}
      onTour={onTour && then(onTour)}
    />
  )
}
