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
  // Each segment's words beside its count ("Needs you · 1"), where there is
  // room for them (the overview); the sidebar shows the icons alone
  labelled?: boolean
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
  words?: string,
  dot?: string,
): SegmentOption<SidebarFilter> {
  const label = `${name}, ${count}`
  return {
    value,
    label,
    content: countContent(Icon, active, n, label, words, dot),
  }
}

// Icon and count, so four segments fit the sidebar; the label names it, and
// the title shows that name on hover. A zero count is drawn muted and still;
// any other takes the segment's active classes (Working spins, as its badge
// does). The size is even: an odd one spins visibly off its centre.
// With its words (a chip): a dot in the state's colour, then "Needs you · 1"
function countContent(
  Icon: Icon,
  active: string,
  n: number,
  label: string,
  words?: string,
  dot?: string,
) {
  if (words)
    return (
      <span className="flex items-center gap-1.5 tabular-nums">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${dot}`}
        />
        {words}
      </span>
    )
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
  labelled = false,
}: Props) {
  const { t } = useT()
  const words = WORDS[unit]
  const count = (n: number) => t(words.count, { count: n })
  const shown = (name: string, n: number) =>
    labelled ? t('tasks.filter.labelled', { name, count: n }) : undefined
  const options: SegmentOption<SidebarFilter>[] = [
    {
      value: 'all',
      content: labelled
        ? t('tasks.filter.labelled', {
            name: t('tasks.filter.all'),
            count: summary.agents,
          })
        : t('tasks.filter.all'),
      label: t(words.all),
    },
    segment(
      'needs-you',
      t('tasks.filter.needsYou'),
      CircleAlert,
      'text-danger',
      summary.blocked,
      count(summary.blocked),
      shown(t('tasks.filter.needsYou'), summary.blocked),
      'bg-danger',
    ),
    segment(
      'working',
      t('tasks.filter.working'),
      LoaderCircle,
      'text-warning motion-safe:animate-spin',
      summary.working,
      count(summary.working),
      shown(t('tasks.filter.working'), summary.working),
      'bg-warning',
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
      variant={labelled ? 'chips' : 'segments'}
      className={labelled ? '' : 'flex w-full [&>button]:flex-1'}
    />
  )
}
