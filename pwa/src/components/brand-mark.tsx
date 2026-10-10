// The Prompt Owl symbol (assets/branding/termote/logo/symbol-knockout.svg):
// one path whose eyes and beak are holes, so it takes the text colour and
// shows the surface through them in every style and theme. Inline rather
// than an image file, which the service worker would precache.
const OWL =
  'M28 20 L166 62 L304 20 L282 68 L297 91 L286 203 Q283 226 261 237 L166 280 L71 237 Q49 226 46 203 L35 91 L50 68 ZM68 103 L112 135 L68 167 L68 146 L88 135 L68 124 ZM264 103 L220 135 L264 167 L264 146 L244 135 L264 124 ZM145 175 L187 175 L166 211 Z'

interface Props {
  className?: string
}

// Decorative: the app's name is already the document title
export function BrandMark({ className }: Props) {
  return (
    <svg
      viewBox="28 20 276 260"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark"
    >
      <path fill="currentColor" fillRule="evenodd" d={OWL} />
    </svg>
  )
}
