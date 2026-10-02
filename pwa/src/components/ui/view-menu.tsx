import { Menu, MenuGroup, MenuItemRadio } from './menu'
import type { ViewOption } from './view-switcher'

interface Props<T extends string> {
  views: ViewOption<T>[]
  value: T
  onChange: (id: T) => void
}

// The mobile header's view switch: one button showing the current view's icon
// that opens a menu of every view, leaving the session chip its room.
// Renders nothing while only one view is available.
export function ViewMenu<T extends string>({
  views,
  value,
  onChange,
}: Props<T>) {
  if (views.length < 2) return null
  const current = views.find((v) => v.id === value) ?? views[0]
  return (
    <Menu
      label={`View: ${current.label}`}
      trigger={<current.Icon size={17} aria-hidden="true" />}
    >
      <MenuGroup label="View">
        {views.map(({ id, label, Icon }) => (
          <MenuItemRadio
            key={id}
            checked={id === current.id}
            icon={<Icon size={17} />}
            onSelect={() => onChange(id)}
          >
            {label}
          </MenuItemRadio>
        ))}
      </MenuGroup>
    </Menu>
  )
}
