# Design Guidelines

## Color Palette

### Theme Modes

| Mode  | Background | Text      | Surface   |
| ----- | ---------- | --------- | --------- |
| Light | `#ffffff`  | `#18181b` | `#f4f4f5` |
| Dark  | `#18181b`  | `#fafafa` | `#27272a` |

### Tailwind Custom Colors

```js
colors: {
  surface: {
    light: '#ffffff',
    dark: '#18181b',
  },
}
```

### Theme Implementation

- `darkMode: 'class'` in Tailwind config
- Theme context provides: `theme`, `setTheme`, `resolvedTheme`
- Options: `light`, `dark`, `system`

## Typography

### Font Stack

- Primary: System fonts (native feel)
- Terminal: Monospace (xterm.js default)

### Terminal Font Size

- Range: 6px - 24px
- Default: 14px
- Controls: Pinch gesture or toolbar buttons

## Layout

### Breakpoints

| Breakpoint | Width   | Layout                                             |
| ---------- | ------- | -------------------------------------------------- |
| Mobile     | < 768px | Bottom nav, slide sidebar                          |
| Desktop    | ≥ 768px | Collapsible sidebar, top header, fullscreen toggle |

### Component Structure

```bash
┌──────────────────────────────────────────┐
│ Header (desktop) / Hidden (mobile)       │
├──────────────────────────────────────────┤
│ ┌──────────┐ ┌─────────────────────────┐ │
│ │ Sidebar  │ │ Terminal Frame          │ │
│ │(collapse)│ │                         │ │
│ │          │ │                         │ │
│ │          │ │                         │ │
│ └──────────┘ └─────────────────────────┘ │
├──────────────────────────────────────────┤
│ Keyboard Toolbar (mobile only)           │
├──────────────────────────────────────────┤
│ Bottom Navigation (mobile only)          │
└──────────────────────────────────────────┘
```

## Gestures (Mobile)

| Gesture     | Action                  | Terminal Command |
| ----------- | ----------------------- | ---------------- |
| Swipe left  | Cancel/interrupt        | Ctrl+C           |
| Swipe right | Tab completion          | Tab              |
| Swipe up    | Scroll up (copy mode)   | PageUp           |
| Swipe down  | Scroll down (copy mode) | PageDown         |
| Long press  | Paste clipboard         | Paste            |
| Pinch in    | Decrease font           | -                |
| Pinch out   | Increase font           | -                |

### Gesture Zone

- Covers terminal area only
- Uses Hammer.js for recognition
- Disabled on desktop (mouse interactions)

## Keyboard Toolbar

### Button Groups

1. **Modifiers**: Tab, Esc, Ctrl
2. **Arrows**: ↑, ↓, ←, →
3. **Ctrl Combos**: C, D, Z, L, A, E, U, K
4. **Scroll**: PageUp, PageDown, Copy Mode toggle

### Button Style

- Touch-friendly: min 44px tap target
- Visual feedback: active state
- Haptic feedback on tap (if supported)

## Accessibility

### Touch Targets

- Minimum: 44x44px (Apple HIG)
- Spacing: 8px between interactive elements

### Contrast

- Text: WCAG AA compliant (4.5:1 minimum)
- Interactive: Clear focus states

### Motion

- Respect `prefers-reduced-motion`
- Haptic feedback opt-in

## Icons

### Source

- Lucide React icons
- Emoji for session icons (user-selectable)

### Sizing

- Toolbar: 20px
- Navigation: 24px
- Header: 20px

## Animation

### Transitions

- Duration: 150-200ms
- Easing: `ease-in-out`
- Properties: opacity, transform, colors

### Sidebar

- Slide animation on mobile
- Collapsible on desktop (icon-only when collapsed, PanelLeftClose/PanelLeftOpen toggle)

### Fullscreen

- Desktop only (uses Fullscreen API)
- Toggle button in header (Maximize/Minimize icons)
- Syncs with browser fullscreen state (F11/Esc)
