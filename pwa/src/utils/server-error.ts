import { en, type MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'

// The sentence for a code the server sends (errors.<code>); errors.unknown
// for a code this version does not know, so the server's own text never
// reaches the screen through a code.
export function errorKey(code: string): MessageKey {
  const key = `errors.${code}`
  return Object.hasOwn(en, key) ? (key as MessageKey) : 'errors.unknown'
}

// What a refusal tells the user. One without a code (an input error, or the
// generic answer to a failed command) has no sentence to look up: its
// message is shown as the server wrote it.
export function serverErrorText(
  err: { code: string; message: string },
  t: Translate<MessageKey>,
): string {
  return err.code ? t(errorKey(err.code)) : err.message
}
