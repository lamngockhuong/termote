import { Bot, CircleAlert, LoaderCircle } from 'lucide-react'
import type { SessionSummary, SidebarFilter } from '../utils/session-filter'
import { SegmentedControl, type SegmentOption } from './ui/segmented-control'

interface Props {
  summary: SessionSummary
  filter: SidebarFilter
  onChange: (filter: SidebarFilter) => void
}

type Icon = typeof Bot

const sessionCount = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`

function segment(
  value: SidebarFilter,
  name: string,
  Icon: Icon,
  active: string,
  n: number,
): SegmentOption<SidebarFilter> {
  const label = `${name}, ${sessionCount(n)}`
  return { value, label, content: countContent(Icon, active, n, label) }
}

// Icon and count, so four segments fit the sidebar; the label names it, and
// the title shows that name on hover. A zero count is drawn muted and still;
// any other takes the segment's active classes (Working spins, as its badge
// does). The size is even: an odd one spins visibly off its centre.
function countContent(Icon: Icon, active: string, n: number, label: string) {
  return (
    <span title={label} className="flex items-center gap-1 tabular-nums">
      <Icon
        size={14}
        aria-hidden="true"
        className={`shrink-0 ${n > 0 ? active : 'text-fg-subtle'}`}
      />
      {n}
    </span>
  )
}

// Counts of sessions by agent state above the session list; picking one
// lists only those sessions.
export function AgentFilterBar({ summary, filter, onChange }: Props) {
  const options: SegmentOption<SidebarFilter>[] = [
    { value: 'all', content: 'All', label: 'All sessions' },
    segment(
      'needs-you',
      'Needs you',
      CircleAlert,
      'text-danger',
      summary.blocked,
    ),
    segment(
      'working',
      'Working',
      LoaderCircle,
      'text-warning motion-safe:animate-spin',
      summary.working,
    ),
    segment('agents', 'Agents', Bot, 'text-fg-muted', summary.agents),
  ]
  return (
    <SegmentedControl
      label="Filter sessions"
      options={options}
      value={filter}
      onChange={onChange}
      className="flex w-full [&>button]:flex-1"
    />
  )
}
