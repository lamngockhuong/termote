import { GitPullRequest } from 'lucide-react'
import type { JobCISummary } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { CI_WORST_TONE, CI_WORST_WORDS } from '../utils/job-ci'

// A job's pull requests on its card, coloured by the worst one: its number
// ("#12") or how many there are ("2 PRs"). Every client sees it; none
// shows a check's name.
export function JobPRChip({ summary }: { summary?: JobCISummary }) {
  const { t } = useT()
  const worst = summary?.worst
  if (!summary || !worst || summary.count === 0) return null
  const numbers = (summary.numbers ?? []).map((n) => `#${n}`).join(', ')
  const text =
    summary.count === 1 && summary.numbers?.length
      ? `#${summary.numbers[0]}`
      : t('jobs.ci.count', { count: summary.count })
  return (
    <span
      role="img"
      aria-label={t('jobs.ci.chipLabel', {
        numbers,
        state: t(CI_WORST_WORDS[worst]),
      })}
      data-testid="job-pr-chip"
      data-worst={worst}
      className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-1.5 font-term text-[11px] leading-[18px] ${CI_WORST_TONE[worst]}`}
    >
      <GitPullRequest aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
      <span className="truncate">· {t(CI_WORST_WORDS[worst])}</span>
    </span>
  )
}
