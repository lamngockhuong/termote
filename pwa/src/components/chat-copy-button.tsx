import { Check, Copy, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { IconButton } from './ui/button'

// Copies text from the Chat view (a code block, an answer) and shows how it
// went on the button itself for a moment: the view has no toast of its own.
export function CopyButton({
  text,
  label,
  className = '',
}: {
  // Read on click
  text: () => string
  label: string
  className?: string
}) {
  const { t } = useT()
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(id)
  }, [state])
  const copy = () => {
    navigator.clipboard.writeText(text()).then(
      () => setState('done'),
      () => setState('failed'),
    )
  }
  const title =
    state === 'done'
      ? t('chat.copy.done')
      : state === 'failed'
        ? t('chat.copy.failed')
        : label
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
