import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { IconPicker } from './icon-picker'
import { Button } from './ui/button'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'

interface Props {
  onAdd: (name: string, icon: string) => void
  onClose: () => void
}

// A new tab's name and icon, in a panel under the header's tab bar (the
// sidebar's own form is not on screen there). Enter adds, Escape or a press
// outside closes; the icon sheet it opens is inside it.
export function NewTabForm({ onAdd, onClose }: Props) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('💻')
  const ref = useRef<HTMLFormElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element
      // + toggles the form itself
      if (
        ref.current!.contains(target) ||
        target.closest('[data-new-tab-toggle]')
      )
        return
      closeRef.current()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  return (
    <form
      ref={ref}
      aria-label={t('shell.tabs.newForm')}
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onAdd(name.trim(), icon)
        onClose()
      }}
      onKeyDown={(e) => {
        // Escape in the icon sheet closes only the sheet; one that ends an
        // IME composition closes nothing
        if (
          e.key !== 'Escape' ||
          e.nativeEvent.isComposing ||
          (e.target as Element).closest('dialog')
        )
          return
        e.preventDefault()
        onClose()
      }}
      className="absolute right-0 top-full z-40 mt-1 flex w-72 flex-col gap-2 rounded-panel border border-border bg-surface-raised p-2 shadow-xl ui-native:border-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconPicker value={icon} onChange={setIcon} />
        <input
          type="text"
          aria-label={t('shell.sidebar.sessionName')}
          placeholder={t('shell.sidebar.sessionName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT_CLASSES}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="flex-1">
          {t('shell.sidebar.add')}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
