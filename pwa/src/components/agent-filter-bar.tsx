import { Bot, CircleAlert, LoaderCircle } from 'lucide-react'
import type { SessionSummary, SidebarFilter } from '../utils/session-filter'
import { SegmentedControl, type SegmentOption } from './ui/segmented-control'

interface Props {
  summary: SessionSummary
  filter: SidebarFilter
  onChange: (filter: SidebarFilter) => void
  // What is counted: sessions (the sidebar) or agents (the overview, which
  // lists only agents, so it has no Agents segment)
  unit?: 'session' | 'agent'
}

type Icon = typeof Bot

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

function segment(
  value: SidebarFilter,
  name: string,
  Icon: Icon,
  active: string,
  n: number,
  unit: string,
): SegmentOption<SidebarFilter> {
  const label = `${name}, ${count(n, unit)}`
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

// Counts of sessions (or agents) by agent state above the list; picking one
// lists only those.
export function AgentFilterBar({
  summary,
  filter,
  onChange,
  unit = 'session',
}: Props) {
  const options: SegmentOption<SidebarFilter>[] = [
    { value: 'all', content: 'All', label: `All ${unit}s` },
    segment(
      'needs-you',
      'Needs you',
      CircleAlert,
      'text-danger',
      summary.blocked,
      unit,
    ),
    segment(
      'working',
      'Working',
      LoaderCircle,
      'text-warning motion-safe:animate-spin',
      summary.working,
      unit,
    ),
  ]
  if (unit === 'session') {
    options.push(
      segment('agents', 'Agents', Bot, 'text-fg-muted', summary.agents, unit),
    )
  }
  return (
    <SegmentedControl
      label={`Filter ${unit}s`}
      options={options}
      value={filter}
      onChange={onChange}
      className="flex w-full [&>button]:flex-1"
    />
  )
}
