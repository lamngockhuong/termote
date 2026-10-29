import {
  Bell,
  CircleAlert,
  Download,
  Smartphone,
  SquareTerminal,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react'
import { useDialogModal } from '../hooks/use-dialog-modal'
import { useRestoreFocus } from '../hooks/use-restore-focus'
import { LOCALES, type Locale } from '../i18n'
import { useTourT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { NextAction, NotifyState, WelcomeFacts } from '../utils/welcome'
import { BrandMark } from './brand-mark'
import { Button, IconButton } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'

// The parts of the app this device can use, for "What you can do here"
export interface WelcomeAreas {
  chat: boolean
  files: boolean
  tasks: boolean
  panes: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  // A bottom sheet on phones, a dialog in two columns on desktop
  mobile: boolean
  host: string
  version: string
  backend: string
  facts: WelcomeFacts
  readOnly: boolean
  notify: NotifyState
  // Desktop: whether sign-in is on (caps.auth); undefined leaves the row out
  signIn?: boolean
  areas: WelcomeAreas
  // Desktop: the keys of the command palette and of Go to file, as shown
  keys: { commands?: string; files?: string }
  onLanguage: (locale: Locale) => void
  onAction: (action: NextAction) => void
  onPrimary: () => void
  // The tour, when it can run here
  onTour?: () => void
}

// How the backends are written
const BACKEND_NAMES: Record<string, string> = {
  tmux: 'tmux',
  psmux: 'psmux',
  herdr: 'Herdr',
  zellij: 'Zellij',
}

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'EN', vi: 'VI' }

// The first-run screen: what this install is, what to do next, and where
// things are. It only shows what it is given; WelcomeHost gathers it.
export function WelcomeSheet({ isOpen, ...rest }: Props) {
  if (!isOpen) return null
  return <OpenWelcome {...rest} />
}

function OpenWelcome({
  onClose,
  mobile,
  host,
  version,
  backend,
  facts,
  readOnly,
  notify,
  signIn,
  areas,
  keys,
  onLanguage,
  onAction,
  onPrimary,
  onTour,
}: Omit<Props, 'isOpen'>) {
  const { t, locale } = useTourT()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useRestoreFocus()
  // A stable callback: the host passes a new function at each render, and
  // a new one would run useDialogModal again (showModal on an open dialog)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = useCallback(() => onCloseRef.current(), [])
  useDialogModal(dialogRef, true, close)
  // showModal focuses the first control (the EN | VI switch, with a ring
  // on a phone); the dialog itself takes it, and its title is read out
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])
  const pressedScrim = useRef(false)

  const backendName = BACKEND_NAMES[backend] ?? backend
  const intro = (
    <p className="m-0 text-sm leading-relaxed text-fg-muted">
      <Trans
        tour
        k="welcome.intro"
        vars={{ version, host, backend: backendName }}
        tags={{
          host: (s) => <span className="font-mono text-fg">{s}</span>,
        }}
      />
      {mobile && ` ${t(readOnly ? 'welcome.introView' : 'welcome.introType')}`}
    </p>
  )

  const setup = (
    <Section title={t('welcome.setup')}>
      <dl className="m-0 rounded-panel border border-border bg-surface ui-native:border-0 ui-native:bg-surface-raised">
        <Row label={t('welcome.backend')}>
          <span className="font-mono">{backendName}</span>
        </Row>
        <Row label={t('welcome.sessions')}>
          {facts.sessions === 0 ? (
            <span className="text-warning">{t('welcome.sessionsNone')}</span>
          ) : (
            `${t('welcome.sessionCount', { count: facts.sessions })} · ${t(
              'welcome.paneCount',
              { count: facts.panes },
            )}`
          )}
        </Row>
        {facts.waiting.length > 0 && (
          <Row label={t('welcome.waiting')}>
            <span className="text-warning">
              {t('welcome.agentCount', { count: facts.waiting.length })}
            </span>
          </Row>
        )}
        <Row label={t('welcome.device')}>
          {t(readOnly ? 'welcome.viewOnly' : 'welcome.canType')}
        </Row>
        {notify !== 'unsupported' && (
          <Row label={t('welcome.notifications')}>
            {t(notify === 'on' ? 'welcome.on' : 'welcome.off')}
          </Row>
        )}
        {!mobile && signIn !== undefined && (
          <Row label={t('welcome.signIn')}>
            {t(signIn ? 'welcome.on' : 'welcome.off')}
          </Row>
        )}
      </dl>
    </Section>
  )

  const next = facts.next.length > 0 && (
    <Section title={t('welcome.next')}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {facts.next.map((action) => (
          <ActionCard
            key={action.kind}
            action={action}
            onAction={() => onAction(action)}
          />
        ))}
      </ul>
    </Section>
  )

  const area = (name: string, desc: MessageKey) => (
    <li key={name} className="flex gap-2.5 text-sm leading-snug">
      <span aria-hidden="true" className="font-mono text-accent">
        ›
      </span>
      <span>
        <b className="font-semibold">{name}</b>: {t(desc)}
      </span>
    </li>
  )
  const areaList = (
    <Section title={t('welcome.areas')}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {mobile &&
          area(
            t('common.terminal'),
            readOnly ? 'welcome.areaTerminalView' : 'welcome.areaTerminal',
          )}
        {areas.chat &&
          area(
            t('common.chat'),
            readOnly ? 'welcome.areaChatView' : 'welcome.areaChat',
          )}
        {areas.files &&
          !readOnly &&
          area(t('common.files'), 'welcome.areaFiles')}
        {areas.tasks &&
          !readOnly &&
          area(t('common.tasks'), 'welcome.areaTasks')}
        {!mobile && areas.panes && area(t('common.panes'), 'welcome.areaPanes')}
        {mobile && area(t('welcome.gestures'), 'welcome.areaGestures')}
        {readOnly && (
          <li className="text-sm leading-snug text-fg-muted">
            {t('welcome.areaViewNote')}
          </li>
        )}
      </ul>
    </Section>
  )

  const keyRows = [
    { label: t('common.commandPalette'), key: keys.commands },
    { label: t('welcome.keyFiles'), key: keys.files },
  ].filter((k) => k.key)
  const keyList = !mobile && keyRows.length > 0 && (
    <Section title={t('welcome.keys')}>
      <dl className="m-0 flex flex-col gap-2">
        {keyRows.map((k) => (
          <div
            key={k.label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <dt>{k.label}</dt>
            <dd className="m-0">
              <kbd className="rounded-[4px] border border-border-strong bg-bg px-1.5 py-0.5 font-mono text-xs">
                {k.key}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  )

  const primary = (
    <Button
      variant="primary"
      className={mobile ? 'w-full' : ''}
      onClick={onPrimary}
    >
      {t(
        facts.primary === 'waiting'
          ? 'welcome.openWaiting'
          : 'welcome.openTerminal',
      )}
    </Button>
  )
  const tour = onTour && (
    <Button className={mobile ? 'w-full' : ''} onClick={onTour}>
      {t('welcome.tour')}
    </Button>
  )
  const again = (
    <p className="m-0 text-center text-xs text-fg-subtle">
      {t('welcome.again')}
    </p>
  )

  const language = (
    <SegmentedControl
      label={t('welcome.language')}
      value={locale}
      onChange={onLanguage}
      options={LOCALES.map((l) => ({
        value: l,
        content: <span className="font-mono text-xs">{LANGUAGE_NAMES[l]}</span>,
        label: LANGUAGE_NAMES[l],
      }))}
    />
  )

  const layout = mobile
    ? 'mb-0 mt-auto max-h-[calc(var(--app-height)*0.94)] w-full max-w-none rounded-t-sheet border-t pb-safe starting:translate-y-8'
    : 'm-auto max-h-[90vh] w-[90vw] max-w-3xl rounded-sheet border starting:scale-95'

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="welcome"
      data-layout={mobile ? 'sheet' : 'dialog'}
      className={`fixed inset-0 z-50 flex-col overflow-hidden border-border bg-bg p-0 text-fg shadow-xl outline-none backdrop:bg-overlay open:flex transition-[opacity,translate,scale] duration-(--duration-base) ease-emphasized starting:opacity-0 ui-native:border-0 ui-native:bg-surface ${layout}`}
      onPointerDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (pressedScrim.current && e.target === e.currentTarget) close()
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 md:px-7 md:pt-5">
        <span className="flex items-center gap-1.5 font-mono text-[13px] font-semibold text-accent">
          <BrandMark className="size-4" />
          {/* i18n-ignore: the product's name */}
          termote
        </span>
        <div className="flex items-center gap-1">
          {language}
          {mobile ? (
            <Button variant="ghost" onClick={close}>
              {t('common.skip')}
            </Button>
          ) : (
            <IconButton aria-label={t('common.close')} onClick={close}>
              <X size={18} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain px-4 pb-4 md:px-7">
        <div className="flex flex-col gap-2 pb-5 pt-2">
          <h1
            id={titleId}
            className="m-0 text-2xl font-bold leading-tight ui-terminal:font-label ui-terminal:text-xl"
          >
            {t(mobile ? 'welcome.titleMobile' : 'welcome.titleDesktop')}
          </h1>
          {intro}
        </div>
        {mobile ? (
          <div className="flex flex-col gap-5">
            {setup}
            {next}
            {areaList}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-7">
            <div className="flex flex-col gap-5">
              {setup}
              {next}
            </div>
            <div className="flex flex-col gap-5">
              {areaList}
              {keyList}
            </div>
          </div>
        )}
      </div>
      {mobile ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 pb-4 pt-3">
          {primary}
          {tour}
          {again}
        </div>
      ) : (
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-7 py-4">
          {again}
          <div className="flex gap-2">
            {tour}
            {primary}
          </div>
        </div>
      )}
    </dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-mono text-[11px] font-normal uppercase tracking-wider text-fg-subtle">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 text-sm first:border-t-0">
      <dt className="flex-1 text-fg-muted">{label}</dt>
      <dd className="m-0 font-medium">{children}</dd>
    </div>
  )
}

const ACTION_ICONS = {
  waiting: CircleAlert,
  start: SquareTerminal,
  notify: Bell,
  install: Download,
  pair: Smartphone,
}

function ActionCard({
  action,
  onAction,
}: {
  action: NextAction
  onAction: () => void
}) {
  const { t } = useTourT()
  const Icon = ACTION_ICONS[action.kind]
  const text: Record<NextAction['kind'], [MessageKey, MessageKey, MessageKey]> =
    {
      waiting: [
        'welcome.waitingTitle',
        'welcome.waitingDesc',
        'welcome.waitingAction',
      ],
      start: ['welcome.startTitle', 'welcome.startDesc', 'welcome.startAction'],
      notify: [
        'welcome.notifyTitle',
        'welcome.notifyDesc',
        'welcome.notifyAction',
      ],
      install: [
        'welcome.installTitle',
        'welcome.installDesc',
        'welcome.installAction',
      ],
      pair: ['welcome.pairTitle', 'welcome.pairDesc', 'welcome.pairAction'],
    }
  const [title, desc, button] = text[action.kind]
  const vars =
    action.kind === 'waiting'
      ? { agent: action.agent.agent, tab: action.agent.tab }
      : undefined
  // iPhone Safari has no prompt to call: it says where to tap instead
  const ios = action.kind === 'install' && action.how === 'ios'
  // The first card is the one to do: filled; the next one outlined
  const filled = action.kind === 'waiting' || action.kind === 'start'
  return (
    <li className="flex items-center gap-3 rounded-panel border border-border bg-surface px-3.5 py-3 ui-native:border-0 ui-native:bg-surface-raised">
      <Icon size={20} aria-hidden="true" className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{t(title, vars)}</div>
        <div className="text-[13px] text-fg-muted">
          {t(ios ? 'welcome.installIos' : desc)}
        </div>
      </div>
      {!ios && (
        <Button variant={filled ? 'primary' : 'secondary'} onClick={onAction}>
          {t(button)}
        </Button>
      )}
    </li>
  )
}
