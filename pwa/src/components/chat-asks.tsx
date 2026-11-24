import { useOpenAsks } from '../hooks/use-jobs'
import { OverviewAsks } from './overview-asks'

interface Props {
  paneId: string
  // Server time minus this device's (ms)
  clockOffset: number
}

// The questions the orchestrator in this pane asked that wait for the user,
// above the composer of its chat: answered here as in the overview's Plan.
// Only the asks whose orchestrator still runs in this pane; a view-only
// device reads no pane of an ask, and shows none. The box stays mounted
// while its pane's asks come and go (hidden while empty), so the note that
// an answer went out outlives the ask it answered.
export function ChatAsks({ paneId, clockOffset }: Props) {
  const { open, readOnly } = useOpenAsks()
  const mine = readOnly
    ? []
    : open.filter(
        (a) => a.live?.status === 'running' && a.live.paneId === paneId,
      )
  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto border-t border-border px-3 py-2 empty:hidden">
      <OverviewAsks
        asks={mine}
        readOnly={false}
        now={Date.now() + clockOffset}
      />
    </div>
  )
}
