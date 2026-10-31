import { useT } from '../i18n/i18n-context'
import type { MetaToken, Session, SessionPane } from '../types/session'
import { visibleUnsafe } from '../utils/unsafe-chars'

// The chips shown before the rest collapse into "+N"
export const META_SHOWN = 3

interface Props {
  tokens?: MetaToken[]
  className?: string
}

// The metadata a Herdr plugin or tool reported for a workspace or a pane:
// text from outside termote, so only ever text (never markup, never a
// link), drawn faint with a dashed border unlike termote's own badges, and
// titled with where it comes from.
export function MetaChips({ tokens, className = '' }: Props) {
  const { t } = useT()
  if (!tokens?.length) return null
  const text = (m: MetaToken) =>
    `${visibleUnsafe(m.key)}: ${visibleUnsafe(m.value)}`
  const title = [t('shell.meta.source'), ...tokens.map(text)].join('\n')
  const rest = tokens.length - META_SHOWN
  return (
    <span
      data-meta-chips
      title={title}
      className={`inline-flex min-w-0 shrink items-center gap-1 overflow-hidden ${className}`}
    >
      {tokens.slice(0, META_SHOWN).map((m) => (
        <span
          key={m.key}
          className="max-w-[120px] shrink-0 truncate rounded-full border border-dashed border-border px-1.5 text-[10px] leading-4 text-fg-subtle"
        >
          {text(m)}
        </span>
      ))}
      {rest > 0 && (
        <span className="shrink-0 text-[10px] leading-4 text-fg-subtle">
          {t('shell.meta.more', { n: rest })}
        </span>
      )}
    </span>
  )
}

// The pane of a one-pane tab, which has no pane strip to show its name and
// metadata
export function onlyPaneOf(session: Session): SessionPane | undefined {
  const pane = session.panes?.length === 1 ? session.panes[0] : undefined
  return pane?.name || pane?.meta ? pane : undefined
}

// A one-pane tab's pane name and metadata, on a line under the tab's name
export function OnlyPaneLine({ pane }: { pane?: SessionPane }) {
  if (!pane) return null
  return (
    <span
      data-only-pane
      className="flex min-w-0 items-center gap-1.5 text-[12px] font-normal text-fg-muted"
    >
      {pane.name && (
        <span className="min-w-0 truncate">{visibleUnsafe(pane.name)}</span>
      )}
      <MetaChips tokens={pane.meta} />
    </span>
  )
}
