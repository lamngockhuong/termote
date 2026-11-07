// The browser's own context menu is blocked over the app's chrome (buttons,
// sidebar, header, the Files tree): in an installed PWA it offers little more
// than Back and Reload, and a stray Reload cuts the terminal's stream. It is
// kept where it is useful: in a field, on a link or an image, inside a region
// marked data-native-menu (text to read and copy) and while text is selected.
//
// The listener sits on the document in the bubble phase, so a handler below
// it decides first: one that opens its own menu calls preventDefault (tabs,
// tables, the terminal with its setting on), and one that wants the browser's
// menu stops the event before it gets here (the terminal with the setting off).

const NATIVE_MENU_SELECTOR =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), a[href], img, video, [data-native-menu]'

// True where the browser's menu stays: over selected text, or in an element
// that edits, links, shows media or is marked to keep it
export function keepsNativeMenu(
  node: EventTarget | null,
  selection: Selection | null,
): boolean {
  if (selection && !selection.isCollapsed && selection.toString() !== '')
    return true
  const el =
    node instanceof Element ? node : (node as Node | null)?.parentElement
  return !!el?.closest(NATIVE_MENU_SELECTOR)
}

// Returns the function that removes the listener
export function guardContextMenu(doc: Document = document): () => void {
  const onContextMenu = (e: Event) => {
    if (e.defaultPrevented) return
    if (!keepsNativeMenu(e.target, doc.getSelection())) e.preventDefault()
  }
  doc.addEventListener('contextmenu', onContextMenu)
  return () => doc.removeEventListener('contextmenu', onContextMenu)
}
