// The website's GoatCounter events (astro.config.mjs puts this in every
// page's head): whether visitors open the demo, copy an install command or
// go to the repository. GoatCounter's script counts the page views; it sets
// no cookie and skips localhost. The demo (/demo/) is the PWA's own page and
// counts nothing.

// The event a click on el counts, or null
function eventName(el) {
  if (el instanceof HTMLAnchorElement) {
    const url = new URL(el.href, location.href)
    if (url.origin === location.origin && url.pathname.startsWith('/demo/'))
      return 'demo-open'
    if (
      url.hostname === 'github.com' &&
      url.pathname.toLowerCase().startsWith('/lamngockhuong/termote')
    )
      return 'github-click'
    return null
  }
  // The copy button of a code block (Expressive Code) holds the block's text
  const code = el.closest('.copy') && el.getAttribute('data-code')
  if (code && /install\.(sh|ps1)|brew install/.test(code)) return 'install-copy'
  return null
}

document.addEventListener('click', (e) => {
  const gc = window.goatcounter
  if (!gc?.count || !(e.target instanceof Element)) return
  const el = e.target.closest('a[href], button')
  const name = el && eventName(el)
  if (name) gc.count({ path: name, event: true })
})
