import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'

// How long ago, in whole minutes then hours: "just now", "3 min ago",
// "2 h ago".
export function formatAgo(ms: number, t: Translate<MessageKey>): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('tasks.ago.now')
  if (min < 60) return t('tasks.ago.minutes', { n: min })
  return t('tasks.ago.hours', { n: Math.floor(min / 60) })
}
