import { FOCUS_RING } from './button'

// A switch needs a name: its own label, or the id of a visible one.
type Props = {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
} & (
  | { label: string; labelledBy?: never }
  | { labelledBy: string; label?: never }
)

export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled = false,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] shrink-0 items-center rounded-full transition-colors duration-(--duration-fast) disabled:opacity-50 ui-terminal:h-6 ui-terminal:w-10 ui-terminal:rounded-control ${FOCUS_RING} ${checked ? 'bg-accent' : 'bg-border-strong'}`}
    >
      <span
        aria-hidden="true"
        className={`absolute size-5.5 rounded-full bg-white shadow transition-transform duration-(--duration-fast) ease-standard ui-terminal:size-4.5 ui-terminal:rounded-[2px] ${checked ? 'translate-x-[23px] ui-terminal:translate-x-[19px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}
