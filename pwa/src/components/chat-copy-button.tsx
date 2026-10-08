import { Check, Copy, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IconButton } from './ui/button'

// Copies text from the Chat view (a code block, an answer) and shows how it
// went on the button itself for a moment: the view has no toast of its own.
export function CopyButton({
  text,
  label,
  className = '',
}: {
  // Read on click: a code block's text is taken from the rendered element
  text: () => string
  label: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])
  const copy = () => {
    navigator.clipboard.writeText(text()).then(
      () => setState('done'),
      () => setState('failed'),
    )
  }
  const title =
    state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label
  const Icon = state === 'done' ? Check : state === 'failed' ? X : Copy
  return (
    <IconButton
      size="sm"
      onClick={copy}
      aria-label={title}
      title={title}
      className={`text-fg-subtle ${className}`}
    >
      <Icon size={14} aria-hidden="true" />
    </IconButton>
  )
}
