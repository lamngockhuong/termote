import { Fragment, type ReactNode } from 'react'
import { useT, useTourT } from './i18n-context'
import type { MessageKey } from './messages/en'
import type { Vars } from './translate'

// How each tag a message may hold is drawn: <b>…</b> in the message calls
// tags.b with the text between
export type Tags = Record<string, (children: string) => ReactNode>

const TAG = /<(\w+)>(.*?)<\/\1>/g

// text with each known <tag>…</tag> drawn by its function; an unknown tag
// shows its text alone. Never HTML: the message stays text.
export function renderTags(text: string, tags: Tags): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const draw = tags[m[1]]
    out.push(<Fragment key={m.index}>{draw ? draw(m[2]) : m[2]}</Fragment>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// A message holding markup: <Trans k="welcome.keys" tags={{ kbd: (s) => <kbd>{s}</kbd> }} />
// tour reads it in the welcome screen's and the tour's language.
export function Trans({
  k,
  vars,
  tags,
  tour = false,
}: {
  k: MessageKey
  vars?: Vars
  tags: Tags
  tour?: boolean
}) {
  const app = useT()
  const welcome = useTourT()
  const { t } = tour ? welcome : app
  return <>{renderTags(t(k, vars), tags)}</>
}
