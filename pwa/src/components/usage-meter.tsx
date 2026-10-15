import { type UsageLevel, usageLevel } from '../utils/usage-format'

const FILL: Record<UsageLevel, string> = {
  normal: 'bg-fg-muted',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

interface Props {
  // 0 to 100
  percent: number
  // What is measured, read by a screen reader ("Context", "5h limit")
  label: string
  // What a screen reader reads as the value ("~72%, 144k of 200k tokens")
  valueText: string
  className?: string
}

// A thin bar of how much of something is used, coloured by how close it is
// to full.
export function UsageMeter({ percent, label, valueText, className }: Props) {
  const value = Math.min(100, Math.max(0, percent))
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot take the theme's tokens in every browser
    <span
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      data-level={usageLevel(value)}
      className={`block h-1 overflow-hidden rounded-full bg-surface-raised ${className ?? ''}`}
    >
      <span
        className={`block h-full rounded-full ${FILL[usageLevel(value)]}`}
        style={{ width: `${value}%` }}
      />
    </span>
  )
}
