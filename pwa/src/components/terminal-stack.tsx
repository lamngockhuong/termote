import {
  type ComponentProps,
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useT } from '../i18n/i18n-context'
import type { SessionPane, TabLayout } from '../types/session'
import {
  layoutFontFits,
  layoutFontSize,
  measureCell,
  paneBox,
  zoomedPane,
} from '../utils/layout-view'
import { focusTerminal } from '../utils/terminal-bridge'
import { terminalFontFamily } from '../utils/terminal-font'
import {
  MIN_FONT_SIZE,
  type TerminalHandle,
  TerminalView,
} from './terminal-view'

type ViewProps = Omit<
  ComponentProps<typeof TerminalView>,
  'fixedFontSize' | 'onLayoutSignal' | 'ref'
>

interface Props {
  // What every terminal gets; paneId is the active pane's stream (undefined:
  // no stream at all), the rest are the active pane's settings.
  view: ViewProps
  // The tab's panes and the one this page works on
  panes: SessionPane[]
  activePaneId?: string
  // Where the panes sit on the desktop
  layout?: TabLayout
  // Everything but the font allows the layout view (layoutViewWanted)
  layoutWanted: boolean
  // Each pane of a Herdr tab is a terminal of its own: the active one keeps
  // its terminal (and stream) when the layout view comes and goes.
  perPane: boolean
  // Panes running an agent take bracketed pastes (herdr, zellij)
  agentPaste: boolean
  terminalRef: MutableRefObject<TerminalHandle | null>
  onSelect?: (paneId: string) => void
  onLayoutShownChange?: (shown: boolean) => void
  // The layout may have changed: read the snapshot again
  onLayoutSignal?: () => void
}

// The terminal area: one terminal for the active pane (the pane strip picks
// it), or the layout view, a terminal per pane of a Herdr tab placed as the
// desktop shows them, all at the font the tab's area fits at. Both are one
// tree, so the active pane's terminal and stream outlive a switch between
// them, a pick of another pane and a zoom.
export function TerminalStack({
  view,
  panes,
  activePaneId,
  layout,
  layoutWanted,
  perPane,
  agentPaste,
  terminalRef,
  onSelect,
  onLayoutShownChange,
  onLayoutSignal,
}: Props) {
  const { t } = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  // The space the panes share. Kept while another view covers the terminal
  // or the side panel is dragged, as a single terminal keeps its size then:
  // the font, and whether the layout view shows, stay as they are.
  const [box, setBox] = useState({ width: 0, height: 0 })
  const coveredRef = useRef(view.covered)
  coveredRef.current = view.covered
  const measureRef = useRef(() => {})
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    measureRef.current = () => {
      if (coveredRef.current) return
      const { clientWidth: width, clientHeight: height } = el
      setBox((b) =>
        b.width === width && b.height === height ? b : { width, height },
      )
    }
    measureRef.current()
    const observer = new ResizeObserver(() => measureRef.current())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Uncovered: the space it has now
  useEffect(() => {
    if (!view.covered) measureRef.current()
  }, [view.covered])

  // The cell size of the terminal font, measured again once web fonts load
  const family = terminalFontFamily(view.fontFamily)
  const [fontsLoaded, setFontsLoaded] = useState(0)
  useEffect(() => {
    let live = true
    void document.fonts?.ready.then(() => live && setFontsLoaded((n) => n + 1))
    return () => {
      live = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontsLoaded measures again
  const cell = useMemo(() => measureCell(family), [family, fontsLoaded])

  const fontSize =
    layoutWanted && layout ? layoutFontSize(layout, box, cell) : 0
  const shownRef = useRef(false)
  const shown =
    layoutWanted && layoutFontFits(fontSize, MIN_FONT_SIZE, shownRef.current)
  useEffect(() => {
    shownRef.current = shown
    onLayoutShownChange?.(shown)
  }, [shown, onLayoutShownChange])

  const zoomed = shown ? zoomedPane(layout) : undefined
  const streamOn = view.paneId !== undefined

  // A zoom made on the desktop shows one pane: the page works on that one,
  // and on the pane it worked on before once the zoom ends. A pane picked
  // during the zoom is shown instead, and stays picked after it.
  const beforeZoomRef = useRef<string | undefined>(undefined)
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  // Only a zoom starting or ending moves the page
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (zoomed) {
      if (zoomed !== activePaneId) {
        beforeZoomRef.current = activePaneId
        selectRef.current?.(zoomed)
      }
      return
    }
    const before = beforeZoomRef.current
    beforeZoomRef.current = undefined
    if (before && before !== activePaneId && panes.some((p) => p.id === before))
      selectRef.current?.(before)
  }, [zoomed])
  const [pickedInZoom, setPickedInZoom] = useState(false)
  useEffect(() => {
    if (!zoomed || activePaneId === zoomed) setPickedInZoom(false)
    else if (activePaneId !== beforeZoomRef.current) {
      beforeZoomRef.current = undefined
      setPickedInZoom(true)
    }
  }, [activePaneId, zoomed])

  // The panes with a terminal: in the layout view every pane it places, else
  // the active one (keyed by itself on Herdr, so it stays as it is).
  const placed = shown && layout ? layout.panes : []
  const mounted: { key: string; id?: string }[] = shown
    ? placed.map((p) => ({ key: p.id, id: p.id }))
    : [
        {
          key: perPane && activePaneId ? activePaneId : 'pane',
          id: activePaneId,
        },
      ]
  const activeKey = shown || perPane ? activePaneId : 'pane'

  // The handles of the terminals; terminalRef is the active pane's
  const handles = useRef(new Map<string, TerminalHandle>())
  useLayoutEffect(() => {
    terminalRef.current =
      (activeKey !== undefined && handles.current.get(activeKey)) || null
  })

  // Whether the keyboard focus is in a terminal here. A terminal taken out
  // of the page (Herdr's strip opens another pane's) leaves the focus on the
  // body without a focusout, so this stays true then.
  const focusInRef = useRef(false)

  // Another pane picked (the strip, the palette, a zoom): keys go to it. In
  // the layout view also from the strip or nowhere; with one terminal only
  // when the one that had the focus was replaced. Not where the focus is
  // elsewhere on the page, as in a dialog.
  useEffect(() => {
    if (!activePaneId || !(shown || perPane)) return
    // A page with a body always has an active element
    const focused = document.activeElement as Element
    const fromHere =
      focused === document.body
        ? shown || focusInRef.current
        : !!boxRef.current?.contains(focused) ||
          (shown && !!focused.closest('[data-tour="pane-strip"]'))
    if (fromHere) focusTerminal(handles.current.get(activePaneId) ?? null)
  }, [activePaneId, shown, perPane])

  const label = (id: string) => panes.find((p) => p.id === id)?.label ?? id

  return (
    <div
      ref={boxRef}
      className="relative h-full overflow-hidden"
      onFocus={() => {
        focusInRef.current = true
      }}
      onBlur={(e) => {
        focusInRef.current = !!boxRef.current?.contains(e.relatedTarget)
      }}
    >
      {mounted.map(({ key, id }) => {
        const active = key === activeKey
        const rect = shown ? placed.find((p) => p.id === id) : undefined
        // Zoomed: the pane the page works on, the zoomed one unless another
        // was picked since
        const shownAlone =
          pickedInZoom && placed.some((p) => p.id === activePaneId)
            ? activePaneId
            : zoomed
        const hidden = !!zoomed && id !== shownAlone
        const style =
          rect && layout && !zoomed ? paneBox(layout, rect) : undefined
        const pane = panes.find((p) => p.id === id)
        return (
          <fieldset
            key={key}
            data-pane-id={shown ? id : undefined}
            aria-label={
              shown && id
                ? t('shell.layout.pane', { name: label(id) })
                : undefined
            }
            hidden={hidden}
            inert={hidden}
            className="absolute inset-0 m-0 min-w-0 overflow-hidden border-0 p-0"
            style={style}
            // A click, or the focus reaching its terminal, picks the pane
            onFocusCapture={
              shown && id && !active ? () => onSelect?.(id) : undefined
            }
          >
            {/* A box of its own: a fieldset gives a child no height to fill */}
            <div className="absolute inset-0">
              <TerminalView
                ref={(h) => {
                  if (h) handles.current.set(key, h)
                  else handles.current.delete(key)
                  if (key === activeKey) terminalRef.current = h
                }}
                {...view}
                paneId={!streamOn ? undefined : shown ? id : view.paneId}
                // Every pane sizes and fits at the layout's font; none drives
                // the pane size, the desktop keeps it
                fixedFontSize={shown ? fontSize : undefined}
                driveSize={shown ? false : view.driveSize}
                bracketedPaste={
                  active ? view.bracketedPaste : agentPaste && !!pane?.hasAgent
                }
                onConnectionStateChange={
                  active ? view.onConnectionStateChange : undefined
                }
                onLayoutSignal={shown ? onLayoutSignal : undefined}
              />
            </div>
            {shown && active && !zoomed && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent"
              />
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
