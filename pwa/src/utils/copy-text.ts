// Puts text on the device clipboard. The Clipboard API needs a secure
// context (HTTPS or localhost), so a page opened over plain HTTP on the LAN
// falls back to copying a hidden textarea's selection; so does a writeText
// the browser refused. Call it from a user gesture: Safari and Firefox let a
// page write the clipboard only then.
export async function copyText(text: string): Promise<'ok' | 'failed'> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return 'ok'
    } catch {
      // Refused (no permission, document not focused): try the fallback.
    }
  }
  return copyWithTextarea(text) ? 'ok' : 'failed'
}

// Copies text through a hidden textarea and execCommand('copy'), then gives
// focus and the page's selection back.
function copyWithTextarea(text: string): boolean {
  const previous = document.activeElement as HTMLElement | null
  // Never null in a document shown in a window
  const selection = document.getSelection() as Selection
  const ranges: Range[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    ranges.push(selection.getRangeAt(i).cloneRange())
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // In the page but out of sight, and too small to scroll it on iOS.
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.width = '1px'
  area.style.height = '1px'
  area.style.opacity = '0'
  area.style.fontSize = '16px'
  // Inside the open modal dialog when there is one (the Select text
  // sheet): showModal makes the rest of the page inert, where the textarea
  // could take neither focus nor a selection.
  const host =
    previous?.closest('dialog[open]') ??
    document.querySelector('dialog[open]') ??
    document.body
  host.appendChild(area)
  let ok = false
  try {
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    area.remove()
    // Focus first: focusing an element can move the selection.
    /* v8 ignore next */
    previous?.focus({ preventScroll: true })
    if (ranges.length) {
      selection.removeAllRanges()
      for (const r of ranges) selection.addRange(r)
    }
  }
  return ok
}
