import type { ComponentProps } from 'react'

// Keyboard focus ring shared by every primitive.
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE = `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium select-none transition-colors duration-(--duration-fast) ease-standard disabled:pointer-events-none disabled:opacity-50 ${FOCUS_RING}`

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary:
    'border border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-raised',
  ghost: 'text-fg-muted hover:bg-surface hover:text-fg',
  danger: 'text-danger hover:bg-danger/10',
}

// 32px / 36px with a mouse; 44px on touch screens (pointer: coarse).
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px] pointer-coarse:h-touch',
  md: 'h-9 px-3.5 text-sm pointer-coarse:h-touch',
}

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'size-8 pointer-coarse:size-touch',
  md: 'size-10 pointer-coarse:size-touch',
}

// className is appended, not merged: an override of a class the variant or
// size already sets (h-*, px-*) is not guaranteed to win.
interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  )
}

// An icon has no text, so the accessible name is required.
interface IconButtonProps extends Omit<ButtonProps, 'aria-label'> {
  'aria-label': string
}

export function IconButton({
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE} ${VARIANTS[variant]} ${ICON_SIZES[size]} ${className}`}
      {...props}
    />
  )
}
