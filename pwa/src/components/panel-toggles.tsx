import { FOCUS_RING } from './ui/button'
import type { ViewOption } from './ui/view-switcher'

interface Props {
  views: ViewOption<string>[]
  // The view in the side panel, if any
  open: string | null
  onToggle: (id: string | null) => void
}

// Desktop: the views shown in the side panel next to the terminal (files,
// changes), one at a time. A pressed button closes its panel. Sized like the
// view switcher beside it.
export function PanelToggles({ views, open, onToggle }: Props) {
  if (views.length === 0) return null
  return (
    <fieldset
      aria-label="Side panel"
      className="flex shrink-0 gap-0.5 border border-border bg-surface p-0.5 rounded-control ui-native:rounded-full ui-native:border-0"
    >
      {views.map(({ id, label, Icon }) => {
        const pressed = open === id
        return (
          <button
            key={id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onToggle(pressed ? null : id)}
            title={pressed ? `Close ${label}` : label}
            className={`relative before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] flex h-7 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-[12px] ui-native:rounded-full pointer-coarse:h-9 ${FOCUS_RING} ${
              pressed
                ? 'bg-surface-raised text-fg shadow-sm ui-terminal:bg-accent-soft ui-terminal:text-accent ui-terminal:shadow-none'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="ui-terminal:font-label">{label}</span>
          </button>
        )
      })}
    </fieldset>
  )
}
