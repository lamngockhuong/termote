import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { measureAnchor, useAnchorRect } from '../hooks/use-anchor-rect'
import { useRestoreFocus } from '../hooks/use-restore-focus'
import { useTourT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import {
  type BubblePosition,
  placeBubble,
  type TourStep,
  visibleSteps,
} from '../utils/tour-steps'
import { Button } from './ui/button'

interface Props {
  // The steps for this layout; those whose element is not on screen when
  // the tour starts are left out
  steps: TourStep[]
  onClose: () => void
  // Desktop: the keys of the command palette and of Go to file, as shown
  keys: { commands?: string; files?: string }
}

// Room around the lit element
const PAD = 4

const KBD = (s: string) => (
  <kbd className="rounded-[4px] border border-border-strong px-1.5 font-mono text-xs text-fg">
    {s}
  </kbd>
)
const TAGS = {
  kbd: KBD,
  b: (s: string) => <b className="font-semibold">{s}</b>,
}

// Dims the app but one part of it, and says what that part does, a step
// at a time. A tap on the dimmed area does nothing (easy to hit by mistake
// on a phone): Skip, Esc or Done end it.
export function SpotlightTour({ steps: all, onClose, keys }: Props) {
  const { t } = useTourT()
  // Decided once, when the tour starts
  const [steps, setSteps] = useState<TourStep[] | null>(null)
  const [index, setIndex] = useState(0)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  )
  useRestoreFocus()

  useLayoutEffect(() => {
    const shown = visibleSteps(all, measureAnchor)
    if (shown.length === 0) onClose()
    else setSteps(shown)
  }, [all, onClose])

  const step = steps?.[index] ?? null
  const rect = useAnchorRect(step)

  // The bubble's size, for its place: measured after each render
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    const next = { width: el.offsetWidth, height: el.offsetHeight }
    setSize((prev) =>
      prev?.width === next.width && prev.height === next.height ? prev : next,
    )
  })

  // Each step takes focus once the bubble shows (hidden until measured,
  // it cannot take it before), so a screen reader reads its title
  const visible = size !== null
  useEffect(() => {
    if (step && visible) bubbleRef.current?.focus()
  }, [step, visible])

  // The step on screen, ahead of the render: two quick presses of → go two
  // steps
  const indexRef = useRef(0)
  const go = (to: number) => {
    indexRef.current = to
    setIndex(to)
  }
  // What the keys do, for the listener below
  const keysRef = useRef<{ next: () => void; back: () => void } | null>(null)

  // While it shows, the tour has the keyboard and the focus: a dialog
  // closing as it starts gives the focus back to its opener, so the keys
  // are read on the window, before anything else sees them, and focus
  // that leaves the bubble is brought back
  const shown = steps !== null
  useEffect(() => {
    if (!shown) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = bubbleRef.current as HTMLDivElement
      const actions = keysRef.current as NonNullable<typeof keysRef.current>
      const inside = el.contains(e.target as Node)
      const onButton = inside && (e.target as Element).tagName === 'BUTTON'
      // Nothing reaches the app behind: not the terminal, not a shortcut.
      // The browser's own keys (Alt+← goes back) are left to it.
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.stopPropagation()
        return
      }
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') actions.next()
      else if (e.key === 'ArrowLeft') actions.back()
      // Enter on one of its buttons presses that button
      else if (e.key === 'Enter' && !onButton) actions.next()
      else if (e.key === 'Tab') trapTab(el, e.shiftKey)
      else if (inside) return
      e.preventDefault()
      e.stopPropagation()
    }
    const keep = (e: FocusEvent) => {
      const el = bubbleRef.current as HTMLDivElement
      if (!el.contains(e.target as Node)) el.focus()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', keep)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', keep)
    }
  }, [shown, onClose])

  if (!steps || !step) return null
  const last = index === steps.length - 1
  const next = () =>
    indexRef.current === steps.length - 1 ? onClose() : go(indexRef.current + 1)
  const back = () => indexRef.current > 0 && go(indexRef.current - 1)
  keysRef.current = { next, back }

  // The part of the page on screen: on a phone the on-screen keyboard
  // takes the bottom of the window
  const viewport = {
    width: window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  }
  const lit = rect && {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  }
  const place: BubblePosition =
    lit && size
      ? placeBubble(lit, size, viewport, step.placement)
      : {
          top: (viewport.height - (size?.height ?? 0)) / 2,
          left: (viewport.width - (size?.width ?? 0)) / 2,
          side: null,
          arrow: 0,
        }

  return (
    <div className="fixed inset-0 z-50" data-testid="tour">
      {lit ? (
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="fixed rounded-panel shadow-[0_0_0_2px_var(--color-accent),0_0_0_9999px_var(--color-overlay)] motion-safe:transition-[top,left,width,height] motion-safe:duration-(--duration-base) motion-safe:ease-emphasized"
          style={lit}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 bg-overlay" />
      )}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-side={place.side ?? 'none'}
        className="fixed w-[min(360px,calc(100vw-32px))] rounded-panel border border-border-strong bg-surface p-4 text-fg shadow-xl outline-none ui-native:border-0 ui-native:bg-surface-raised"
        style={{
          top: place.top,
          left: place.left,
          visibility: size ? 'visible' : 'hidden',
        }}
      >
        {place.side && <Arrow side={place.side} at={place.arrow} />}
        <p className="sr-only" aria-live="polite">
          {t('tour.step', { n: index + 1, m: steps.length })}
        </p>
        <div className="mb-1.5 flex items-center justify-between">
          <span
            aria-hidden="true"
            className="font-mono text-[11px] text-fg-subtle"
          >
            {index + 1} / {steps.length}
          </span>
          {!last && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('tour.skip')}
            </Button>
          )}
        </div>
        <h2 id={titleId} className="m-0 mb-1.5 text-[17px] font-bold">
          {t(step.title)}
        </h2>
        {step.body && (
          <p className="m-0 mb-3 text-sm leading-relaxed text-fg-muted">
            <Trans tour k={step.body} tags={TAGS} />
          </p>
        )}
        {step.extra && <Extra kind={step.extra} keys={keys} />}
        <div className="mt-3 flex items-center justify-between">
          <div aria-hidden="true" className="flex gap-1.5">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={`size-1.5 rounded-full ${i === index ? 'bg-accent' : 'bg-border-strong'}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 && <Button onClick={back}>{t('common.back')}</Button>}
            <Button variant="primary" onClick={next}>
              {t(last ? 'common.done' : 'common.next')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Tab and Shift+Tab go round the bubble's buttons (from outside it: to
// its first or last)
function trapTab(bubble: HTMLElement, back: boolean) {
  const buttons = [...bubble.querySelectorAll('button')]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const to = back
    ? at <= 0
      ? buttons.length - 1
      : at - 1
    : at === buttons.length - 1
      ? 0
      : at + 1
  buttons[to]?.focus()
}

// A corner of the bubble pointing at what it talks about
const ARROW_EDGE = {
  bottom: 'top-[-6px] border-l border-t',
  top: 'bottom-[-6px] border-r border-b',
  right: 'left-[-6px] border-l border-b',
  left: 'right-[-6px] border-r border-t',
}

function Arrow({
  side,
  at,
}: {
  side: NonNullable<BubblePosition['side']>
  at: number
}) {
  const along = side === 'top' || side === 'bottom' ? 'left' : 'top'
  return (
    <span
      aria-hidden="true"
      data-testid="tour-arrow"
      className={`absolute size-3 rotate-45 border-border-strong bg-surface ui-native:bg-surface-raised ${ARROW_EDGE[side]}`}
      style={{ [along]: at - 6 }}
    />
  )
}

function Extra({
  kind,
  keys,
}: {
  kind: NonNullable<TourStep['extra']>
  keys: Props['keys']
}) {
  const { t } = useTourT()
  const rows = (items: [string, ReactNode][]) => (
    <dl className="m-0 flex flex-col gap-1.5 text-[13px]">
      {items.map(([name, what]) => (
        <div key={name} className="flex gap-2">
          <dt className="w-24 shrink-0 font-mono font-semibold text-fg">
            {name}
          </dt>
          <dd className="m-0 text-fg-muted">{what}</dd>
        </div>
      ))}
    </dl>
  )
  const view = (name: MessageKey, desc: MessageKey): [string, ReactNode] => [
    t(name),
    t(desc),
  ]
  switch (kind) {
    case 'views':
      return rows([
        view('common.terminal', 'tour.viewTerminal'),
        view('common.chat', 'tour.viewChat'),
        view('common.files', 'tour.viewFiles'),
        view('common.changes', 'tour.viewChanges'),
        view('common.tasks', 'tour.viewTasks'),
      ])
    case 'panelViews':
      return (
        <>
          {rows([
            view('common.terminal', 'tour.viewTerminal'),
            view('common.chat', 'tour.viewChat'),
            view('common.tasks', 'tour.viewTasks'),
          ])}
          <p className="m-0 mt-2 text-[13px] text-fg-muted">
            <Trans
              tour
              k="tour.viewsPanel"
              vars={{ files: t('common.files'), changes: t('common.changes') }}
              tags={TAGS}
            />
          </p>
        </>
      )
    case 'gestures':
      return (
        <>
          {rows([
            [t('tour.swipeLeft'), KBD('Ctrl+C')],
            [t('tour.swipeRight'), KBD('Tab')],
            [t('tour.drag'), t('tour.scroll')],
            [t('tour.pinch'), t('tour.fontSize')],
          ])}
          <p className="m-0 mt-2 text-[13px] text-fg-muted">
            {t('tour.gesturesFoot')}
          </p>
        </>
      )
    case 'keys':
      return (
        <>
          {rows(
            [
              [t('tour.allCommands'), keys.commands],
              [t('tour.goToFile'), keys.files],
            ]
              .filter(([, key]) => key)
              .map(([name, key]) => [name as string, KBD(key as string)]),
          )}
          <p className="m-0 mt-2 text-[13px] text-fg-muted">
            {t('tour.paletteFoot')}
          </p>
        </>
      )
  }
}
