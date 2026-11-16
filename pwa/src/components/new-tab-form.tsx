import { type Ref, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { DEFAULT_TAB_ICON } from '../types/session'
import { joinFatherTab } from '../utils/father-tab'
import { imeComposing } from '../utils/ime-composing'
import { IconPicker } from './icon-picker'
import { Button } from './ui/button'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'

interface Props {
  // icon: only one the user picked
  onAdd: (name: string, icon?: string) => void
  // byPress: a press outside closed it, so the focus stays where it went
  onClose: (byPress?: boolean) => void
  // The name field, for a key asking for the form while it is open
  nameRef?: Ref<HTMLInputElement>
  // Presses on these do not close it (+ toggles it itself)
  toggleSelector?: string
  // Set: the form asks for a FatherTab too (optional), offering these; the
  // name it adds then starts with the one typed ("review/PR 1")
  fathers?: readonly string[]
  // The FatherTab the field starts with
  father?: string
  // The FatherTab field takes the focus, not the name (a new FatherTab)
  focusFather?: boolean
  // The edge of what it hangs under that it lines up with (default: end)
  align?: 'start' | 'end'
}

// A new tab's name and icon, in a panel under the header's tab bar (the
// sidebar's own form is not on screen there). Enter adds, Escape or a press
// outside closes; the icon sheet it opens is inside it.
export function NewTabForm({
  onAdd,
  onClose,
  nameRef,
  toggleSelector,
  fathers,
  father: firstFather = '',
  focusFather = false,
  align = 'end',
}: Props) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [father, setFather] = useState(firstFather)
  const listId = useId()
  const [icon, setIcon] = useState<string>()
  const ref = useRef<HTMLFormElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element
      if (
        ref.current!.contains(target) ||
        (toggleSelector && target.closest(toggleSelector))
      )
        return
      closeRef.current(true)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [toggleSelector])

  return (
    <form
      ref={ref}
      aria-label={t('shell.tabs.newForm')}
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onAdd(joinFatherTab(father.trim() || undefined, name.trim()), icon)
        onClose()
      }}
      onKeyDown={(e) => {
        // Escape in the icon sheet closes only the sheet; one that ends an
        // IME composition closes nothing
        if (
          e.key !== 'Escape' ||
          imeComposing(e) ||
          (e.target as Element).closest('dialog')
        )
          return
        e.preventDefault()
        onClose()
      }}
      className={`absolute top-full z-40 mt-1 flex w-72 flex-col gap-2 rounded-panel border border-border bg-surface-raised p-2 shadow-xl ui-native:border-0 ${align === 'start' ? 'left-0' : 'right-0'}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconPicker
          value={icon ?? DEFAULT_TAB_ICON}
          onChange={setIcon}
          auto={icon === undefined}
          onAuto={() => setIcon(undefined)}
        />
        <input
          type="text"
          aria-label={t('shell.sidebar.sessionName')}
          placeholder={t('shell.sidebar.sessionName')}
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT_CLASSES}
          autoFocus={!focusFather}
        />
      </div>
      {fathers && (
        <>
          <input
            type="text"
            aria-label={t('shell.fatherTabs.field')}
            placeholder={t('shell.fatherTabs.field')}
            list={listId}
            value={father}
            onChange={(e) => setFather(e.target.value)}
            className={INPUT_CLASSES}
            autoFocus={focusFather}
          />
          <datalist id={listId}>
            {fathers.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="flex-1">
          {t('shell.sidebar.add')}
        </Button>
        <Button size="sm" onClick={() => onClose()}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
