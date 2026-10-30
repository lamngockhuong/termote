import { Bot, CircleAlert, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
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

// The words for each unit counted
const WORDS = {
  session: {
    all: 'tasks.filter.allSessions',
    count: 'tasks.filter.sessions',
    label: 'tasks.filter.labelSessions',
  },
  agent: {
    all: 'tasks.filter.allAgents',
    count: 'tasks.filter.agents',
    label: 'tasks.filter.labelAgents',
  },
} as const satisfies Record<string, Record<string, MessageKey>>

function segment(
  value: SidebarFilter,
  name: string,
  Icon: Icon,
  active: string,
  n: number,
  count: string,
): SegmentOption<SidebarFilter> {
  const label = `${name}, ${count}`
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
  const { t } = useT()
  const words = WORDS[unit]
  const count = (n: number) => t(words.count, { count: n })
  const options: SegmentOption<SidebarFilter>[] = [
    { value: 'all', content: t('tasks.filter.all'), label: t(words.all) },
    segment(
      'needs-you',
      t('tasks.filter.needsYou'),
      CircleAlert,
      'text-danger',
      summary.blocked,
      count(summary.blocked),
    ),
    segment(
      'working',
      t('tasks.filter.working'),
      LoaderCircle,
      'text-warning motion-safe:animate-spin',
      summary.working,
      count(summary.working),
    ),
  ]
  if (unit === 'session') {
    options.push(
      segment(
        'agents',
        t('tasks.filter.agentsSegment'),
        Bot,
        'text-fg-muted',
        summary.agents,
        count(summary.agents),
      ),
    )
  }
  return (
    <SegmentedControl
      label={t(words.label)}
      options={options}
      value={filter}
      onChange={onChange}
      className="flex w-full [&>button]:flex-1"
    />
  )
}
