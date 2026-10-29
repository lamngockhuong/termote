import { FolderTree } from 'lucide-react'
import type { FilesPlace } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Menu, MenuGroup, MenuItemRadio } from './ui/menu'

interface Props {
  places: FilesPlace[]
  // The Place shown, absent for the pane's folder
  place?: string
  onPick: (place: string | undefined) => void
}

// What Files shows, next to its root: the pane's folder, or one of the
// folders the operator allowed (termote start --allow-path). Shown only
// when there is one.
export function PlacesMenu({ places, place, onPick }: Props) {
  const { t } = useT()
  if (!places.length) return null
  const shown = places.find((p) => p.id === place)
  return (
    <Menu
      label={
        shown
          ? t('files.places.shown', { name: visibleUnsafe(shown.name) })
          : t('files.places')
      }
      trigger={<FolderTree size={15} aria-hidden="true" />}
      triggerSize="sm"
    >
      <MenuGroup label={t('files.places.group')}>
        <MenuItemRadio checked={!shown} onSelect={() => onPick(undefined)}>
          {t('files.places.pane')}
        </MenuItemRadio>
        {places.map((p) => (
          <MenuItemRadio
            key={p.id}
            checked={p.id === shown?.id}
            title={p.path}
            onSelect={() => onPick(p.id)}
          >
            {visibleUnsafe(p.name)}
          </MenuItemRadio>
        ))}
      </MenuGroup>
    </Menu>
  )
}
