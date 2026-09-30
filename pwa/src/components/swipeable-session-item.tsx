import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { Session } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'

interface Props {
  session: Session
  isActive: boolean
  onSelect: () => void
  onEdit: () => void
  onRemove: () => void
  canRemove: boolean
  canEdit: boolean
}

const ACTION_WIDTH = 70
const SWIPE_THRESHOLD = 25

export function SwipeableSessionItem({
  session,
  isActive,
  onSelect,
  onEdit,
  onRemove,
  canRemove,
  canEdit,
}: Props) {
  const [offsetX, setOffsetX] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const touchStartRef = useRef({ x: 0, y: 0, time: 0 })
  const startOffsetRef = useRef(0)
  const isDraggingRef = useRef(false)

  const maxLeft = canRemove ? -ACTION_WIDTH : 0
  const maxRight = canEdit ? ACTION_WIDTH : 0

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      }
      startOffsetRef.current = offsetX
      isDraggingRef.current = false
      setIsAnimating(false)
    },
    [offsetX],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y

      // Determine if horizontal swipe (only on first significant movement)
      if (!isDraggingRef.current && Math.abs(deltaX) > 10) {
        // If more horizontal than vertical, start dragging
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          isDraggingRef.current = true
        }
      }

      if (isDraggingRef.current) {
        e.preventDefault() // Prevent scroll when swiping horizontally
        const newOffset = startOffsetRef.current + deltaX
        const clampedOffset = Math.max(
          maxLeft * 1.2,
          Math.min(maxRight * 1.2, newOffset),
        )
        setOffsetX(clampedOffset)
      }
    },
    [maxLeft, maxRight],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaTime = Date.now() - touchStartRef.current.time
      const velocity = deltaX / deltaTime // px/ms

      setIsAnimating(true)

      if (isDraggingRef.current) {
        // Determine final position
        let finalOffset = 0

        if (velocity < -0.3 && canRemove) {
          finalOffset = maxLeft
        } else if (velocity > 0.3 && canEdit) {
          finalOffset = maxRight
          /* v8 ignore start */
        } else if (offsetX < -SWIPE_THRESHOLD && canRemove) {
          finalOffset = maxLeft
        } else if (offsetX > SWIPE_THRESHOLD && canEdit) {
          finalOffset = maxRight
        }
        /* v8 ignore stop */

        setOffsetX(finalOffset)
      } else {
        // It was a tap
        if (Math.abs(deltaX) < 10) {
          if (offsetX !== 0) {
            setOffsetX(0)
          } else {
            onSelect()
          }
        }
      }

      isDraggingRef.current = false
    },
    [offsetX, maxLeft, maxRight, canRemove, canEdit, onSelect],
  )

  const handleEdit = () => {
    setIsAnimating(true)
    setOffsetX(0)
    setTimeout(onEdit, 100)
  }

  const handleRemove = () => {
    setIsAnimating(true)
    setOffsetX(0)
    setTimeout(onRemove, 100)
  }

  return (
    <div className="relative isolate overflow-hidden rounded-control ui-native:rounded-none">
      {/* Action buttons layer */}
      <div className="absolute inset-0 z-0 flex justify-between">
        {canEdit && (
          <button
            type="button"
            onClick={handleEdit}
            aria-label={`Edit ${session.name}`}
            className="flex h-full w-[70px] items-center justify-center bg-accent text-accent-fg active:opacity-90"
          >
            <Pencil size={20} aria-hidden="true" />
          </button>
        )}
        <div className="flex-1" />
        {canRemove && (
          <button
            type="button"
            onClick={handleRemove}
            aria-label={`Remove ${session.name}`}
            className="flex h-full w-[70px] items-center justify-center bg-danger text-white active:opacity-90 dark:text-bg"
          >
            <Trash2 size={20} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Main content */}
      <div
        data-active={isActive}
        className="relative z-10 bg-bg ui-native:bg-surface-raised"
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isAnimating ? 'transform 200ms ease-out' : 'none',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* The accent tint is translucent: it sits on the opaque layer above,
            which hides the action buttons. */}
        <div
          aria-current={isActive ? 'true' : undefined}
          className={`flex h-14 min-w-0 select-none items-center gap-3 px-3 text-left text-fg ${
            isActive
              ? 'bg-accent-soft ui-terminal:bg-surface-raised ui-terminal:shadow-[inset_2px_0_0_var(--color-accent)]'
              : ''
          }`}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface text-[18px] ui-native:bg-bg">
            {session.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-[15px] ui-terminal:font-label ui-terminal:text-[14px] ${isActive ? 'font-semibold' : ''}`}
            >
              {session.name}
            </span>
            {session.description && (
              <span className="block truncate text-[12px] text-fg-muted">
                {session.description}
              </span>
            )}
          </span>
          <AgentStatusBadge status={session.agentStatus} size={16} />
        </div>
      </div>
    </div>
  )
}
