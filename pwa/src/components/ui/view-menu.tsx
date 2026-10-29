import { LayoutDashboard } from 'lucide-react'
import { useT } from '../../i18n/i18n-context'
import { Menu, MenuGroup, MenuItem, MenuItemRadio } from './menu'
import type { ViewOption } from './view-switcher'

interface Props<T extends string> {
  views: ViewOption<T>[]
  value: T
  onChange: (id: T) => void
  // Adds the overview of every agent, below the views
  onOpenOverview?: () => void
}

// The mobile header's view switch: one button showing the current view's icon
// that opens a menu of every view, leaving the session chip its room.
// Renders nothing while only one view is available and there is no overview.
export function ViewMenu<T extends string>({
  views,
  value,
  onChange,
  onOpenOverview,
}: Props<T>) {
  const { t } = useT()
  if (views.length < 2 && !onOpenOverview) return null
  const current = views.find((v) => v.id === value) ?? views[0]
  return (
    <Menu
      tourAnchor="view-menu"
      label={t('shell.view.current', { name: current.label })}
      trigger={<current.Icon size={17} aria-hidden="true" />}
    >
      <MenuGroup label={t('shell.view')}>
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
      {onOpenOverview && (
        <MenuGroup label={t('shell.view.agents')}>
          <MenuItem
            icon={<LayoutDashboard size={17} />}
            onSelect={onOpenOverview}
          >
            {t('common.overview')}
          </MenuItem>
        </MenuGroup>
      )}
    </Menu>
  )
}
