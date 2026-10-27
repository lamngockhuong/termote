// Scrollbars that take room beside the content (Windows, Linux, macOS set to
// always show them) are replaced in index.css by thin ones. Overlay
// scrollbars (macOS by default, phones) float over the content and hide on
// their own: they are left as the system draws them. Measured, not guessed
// from the platform, so a Mac set to always show scrollbars counts as classic.
// Marks <html> with data-classic-scrollbars, which index.css reads.

// The width a scrolling box loses to its scrollbar, in px: 0 for overlay ones
export function scrollbarWidth(doc: Document): number {
  const probe = doc.createElement('div')
  probe.style.cssText =
    'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll'
  doc.body.append(probe)
  const width = probe.offsetWidth - probe.clientWidth
  probe.remove()
  return width
}

export function markClassicScrollbars(doc: Document = document) {
  if (scrollbarWidth(doc) > 0)
    doc.documentElement.dataset.classicScrollbars = ''
}
