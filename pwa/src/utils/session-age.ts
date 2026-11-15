import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { formatAgo } from './format-ago'

// How long ago a session of the history was last active: minutes and hours
// as formatAgo says them, then whole days. An unreadable time says nothing.
export function sessionAge(
  updatedAt: string,
  now: number,
  t: Translate<MessageKey>,
): string {
  const at = Date.parse(updatedAt)
  if (Number.isNaN(at)) return ''
  const ms = Math.max(0, now - at)
  const days = Math.floor(ms / 86_400_000)
  return days >= 1 ? t('chat.history.days', { n: days }) : formatAgo(ms, t)
}
