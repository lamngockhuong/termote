import type { Locale } from '../i18n'

// Where the app's language is kept for public/notify-sw.js, which words a
// push in it even with no page open (Cache Storage, which the worker and the
// page share). Equal to LOCALE_CACHE and LOCALE_URL there.
export const LOCALE_CACHE = 'termote-prefs'
export const LOCALE_URL = '/__locale'

// Keeps locale for the worker. Nothing happens where Cache Storage is
// missing or refused: the worker then speaks English.
export async function keepNotifyLocale(locale: Locale): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(LOCALE_CACHE)
    await cache.put(LOCALE_URL, new Response(locale))
  } catch {
    // A private window may refuse storage
  }
}
