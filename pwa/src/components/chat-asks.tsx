import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOpenAsks } from '../hooks/use-jobs'
import { useT } from '../i18n/i18n-context'
import { OverviewAsks } from './overview-asks'
import { FOCUS_RING } from './ui/button'

interface Props {
  paneId: string
  // Server time minus this device's (ms)
  clockOffset: number
  // Workspaces hidden from what is drawn: the asks about their jobs are left
  // out
  hiddenGroupIds?: ReadonlySet<string>
}

// How far from the end still counts as the end (px)
const END_SLACK = 4

// The questions the orchestrator in this pane asked that wait for the user,
// above the composer of its chat: answered here as in the overview's Plan.
// Only the asks whose orchestrator still runs in this pane; a view-only
// device reads no pane of an ask, and shows none. The box stays mounted
// while its pane's asks come and go (hidden while empty), so the note that
// an answer went out outlives the ask it answered. Only the oldest ask shows
// until the user unfolds the others, so the conversation keeps its height.
// The box hides its scrollbar, a second one beside the conversation's: an
// arrow over its bottom edge says more is below, and scrolls to it. The box
// itself is positioned: an absolute descendant (a card's sr-only label) would
// otherwise belong to the chat's root, escape this box's clip and make the
// whole chat scroll by the height of the cards hidden below.
export function ChatAsks({ paneId, clockOffset, hiddenGroupIds }: Props) {
  const { t } = useT()
  const { open, readOnly } = useOpenAsks(hiddenGroupIds)
  const box = useRef<HTMLDivElement>(null)
  const [below, setBelow] = useState(false)
  const mine = readOnly
    ? []
    : open.filter(
        (a) => a.live?.status === 'running' && a.live.paneId === paneId,
      )

  const measure = useCallback((el: HTMLElement) => {
    setBelow(el.scrollHeight - el.scrollTop - el.clientHeight > END_SLACK)
  }, [])

  // The content grows when the list unfolds or an ask arrives, and the box
  // shrinks with the window: either may hide or reveal its end
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure(el))
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    return () => ro.disconnect()
  })

  return (
    <div className="relative shrink-0">
      <div
        ref={box}
        onScroll={(e) => measure(e.currentTarget)}
        className="scrollbar-hide relative max-h-[40vh] overflow-y-auto border-t border-border px-3 py-2 empty:hidden"
      >
        <OverviewAsks
          asks={mine}
          readOnly={false}
          collapsible
          now={Date.now() + clockOffset}
        />
      </div>
      {below && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-linear-to-t from-bg to-transparent pb-1.5">
          <button
            type="button"
            aria-label={t('jobs.asks.scrollMore')}
            title={t('jobs.asks.scrollMore')}
            onClick={() =>
              box.current?.scrollBy({
                top: box.current.clientHeight * 0.8,
                behavior: 'smooth',
              })
            }
            className={`pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-surface text-fg-muted shadow-sm hover:text-fg pointer-coarse:size-touch ${FOCUS_RING}`}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
