# Design Guidelines

The logo, its colours and where each asset goes: [brand-identity.md](brand-identity.md).

## Interface Styles and Tokens

Three interface styles (Neutral, the default; Terminal; Native) are chosen in Settings →
Appearance and applied at once. The style is independent of the theme (light, dark, system),
which is set in the "More" overflow menu.

Why tokens: every component takes its colours, radii, fonts and motion from one semantic set, so
a new style or theme is a new token block, not a component change.

- Owner: `pwa/src/index.css`. One `--tm-*` block per style, each with a light and a dark set;
  `@theme inline` maps them to the Tailwind names (`bg-surface`, `text-fg-muted`,
  `rounded-control`, ...). Components use those names, never raw `--tm-*` values or hard-coded
  colours.
- Selection: `data-ui-style` on `<html>` plus the `dark` class. Neutral applies when the
  attribute is missing or unknown. The style list and the fallback live in `pwa/src/ui-style.ts`.
- No flash: an inline script in `pwa/index.html` sets `data-ui-style` before the app runs. It
  duplicates `resolveUiStyle`; `pwa/src/theme-tokens.test.ts` keeps the two in step.
- Where the styles differ structurally, use the `ui-terminal:`, `ui-native:` and `ui-neutral:`
  variants, and keep them to a few classes per component.
- The terminal background (`bg-term`), `<body>`, the `theme-color` meta tag and the manifest
  follow the tokens (`syncThemeColor` in `ui-style.ts`).

### Token groups

| Group    | Tokens                                                               |
| -------- | -------------------------------------------------------------------- |
| Surfaces | `bg`, `surface`, `surface-raised`, `overlay`, `term-bg`              |
| Text     | `fg`, `fg-muted`, `fg-subtle`                                        |
| Lines    | `border`, `border-strong`                                            |
| Accent   | `accent`, `accent-fg`, `accent-soft`                                 |
| Status   | `success`, `warning`, `danger`, `info`                               |
| Shape    | `radius-control`, `radius-panel`, `radius-sheet` (differ per style)  |
| Type     | `font-ui`, `font-label` (Terminal labels are monospace)              |
| Motion   | `ease-standard`, `ease-emphasized`, `duration-fast`, `duration-base` |

Values per style and theme are in `pwa/src/index.css`; do not copy them here.

### Contrast

- Text tokens and the ANSI colours are chosen for WCAG AA (4.5:1) on each style's terminal
  background. In light themes the bright ANSI colours are darker than the normal ones so they
  stay distinct.
- Interactive elements have visible focus states.

### Theme

- Theme context provides `theme`, `setTheme`, `resolvedTheme`; options `light`, `dark`, `system`.
- Tailwind v4 reads its configuration from `index.css`; there is no `tailwind.config.js`.

## Typography

- UI: system font stack (`--tm-font-sans`). Terminal: monospace (`--tm-font-mono`), with a
  bundled Symbols Nerd Font for icon glyphs.
- Terminal font size: 6px to 24px, default 14px. Pinch gesture, or the font buttons in the header
  (desktop) or the "More" menu (mobile). The buttons show only in the terminal view: Chat, Files
  and Changes use fixed sizes.

## UI Primitives

Shared building blocks live in `pwa/src/components/ui/`; screens compose them instead of
restyling raw elements. Each is written against the tokens, so it is correct in every style.

| Primitive                    | Note                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Button` / `IconButton`      | `IconButton` requires `aria-label`                                                                                               |
| `Sheet`                      | Bottom sheet on phones, centred dialog on desktop; Escape, close button or scrim press closes it and focus returns to the opener |
| `Menu`                       | Arrow keys, Home and End move over items; closes on Escape, focus leaving, outside press                                         |
| `Switch`, `SegmentedControl` | `SegmentedControl` uses a roving tabindex                                                                                        |
| `ViewSwitcher`               | Desktop header tabs with labels; renders nothing while only one view exists                                                      |
| `ViewMenu`                   | Mobile header: one button with the current view's icon (`View: <name>`) opening a menu of views; nothing below two views         |
| `Banner`                     | Inline status message                                                                                                            |

## Layout

### Breakpoints

| Breakpoint | Width   | Layout                                                                 |
| ---------- | ------- | ---------------------------------------------------------------------- |
| Mobile     | < 768px | Header with session chip, sessions bottom sheet, keyboard toolbar      |
| Desktop    | ≥ 768px | Session tabs in the header row, collapsible sidebar, fullscreen toggle |

There is no bottom navigation: the terminal takes that height.

### Mobile

```text
┌──────────────────────────────────────────┐
│ Header: session chip · More (⋯)          │
├──────────────────────────────────────────┤
│ Terminal                                 │
├──────────────────────────────────────────┤
│ Keyboard Toolbar                         │
└──────────────────────────────────────────┘
```

- The session chip (name, agent badge, connection dot; "Open sessions menu") opens the sessions
  list as a bottom sheet with "New session", scrolled to the current session. Pinned under the title while the list scrolls: the
  current session on one line (Edit, Move up/down and Delete in its ⋯ menu) and the agent filter
  (All, Needs you, Working, Agents); the other rows keep swipe.
  Creating a session closes the sheet.
- The "More" menu holds font size, theme, Settings, Help & gestures, About, Copy link and Clear
  cache & reload.

### Desktop

```text
┌──────────┬───────────────────────────────────────────┐
│ Sidebar  │ Session tabs · font · fullscreen · More   │
│(collapse)├─────────────────────────────┬─────────────┤
│          │ Terminal / view             │ Side panel  │
│          │                             │ (Files,     │
│          ├─────────────────────────────┤  Changes)   │
│          │ Input area (toolbar, Chat)  │             │
└──────────┴─────────────────────────────┴─────────────┘
```

- The input area (key toolbar, Chat composer, view-only bar) sits under the view's column only, so
  the sidebar and the side panel run the full height; a maximized side panel covers it too.
- The Chat conversation and composer share one centred column of at most 896px (`CHAT_COLUMN`);
  the reader's own messages sit on the right, as wide as their text up to 85%.
- Scrollbars are 8px with a clear track and no arrows where there is a mouse (`pointer: fine`);
  touch screens keep the system's overlay scrollbars. The sidebar's lists show the thumb only on
  hover or with focus inside (`.scrollbar-hover`); tab rows hide theirs (`.scrollbar-hide`) and a
  vertical wheel scrolls them sideways.
- An open menu sits in the top layer (Popover API), so a scrolling list such as the sidebar never
  cuts it; near the bottom of the screen it opens upward, and scrolling the list under it closes it.
- A tab is a `role="tab"` button with a sibling close button; Delete closes the focused tab.
- Settings uses a two-column dialog with a group rail; on a phone it is a full-screen sheet.

### Views

Views of a pane are listed in `pwa/src/app-views.ts`: Terminal, Chat (Claude Code in the pane),
Files and Changes (when the server reports the pane's directory). Below two available views the
switcher stays hidden. Another view covers the terminal (invisible, inert) instead of unmounting
it, so the stream and the multiplexer window size are kept. Each pane comes back on the view and
desktop side panel it was left on (`pwa/src/utils/pane-view.ts`, sessionStorage, following a tmux
id shift); a pane never shown opens on the terminal without a panel.

The agent overview (`#/overview`) is a screen of its own, not a view of a pane: it covers the panes
(left mounted and inert, as a view covers the terminal) and hides the bottom bar. It opens from the
sidebar's button (desktop) or the view menu (mobile), closes with its button, `Esc`, Back or by
picking a session, and survives a reload. Cards are sorted blocked, working, done, idle, the longest
in its state first; a card opens its pane on the Chat view (an agent with one) or the terminal. Its
filter is its own and counts agents, not sessions. Times are server time (`clockOffset`), shown
coarse and refreshed every 30 s; "≥" marks a state the server found the agent already in.

Above the cards, "Needs you" shows one waiting dialog at a time, answered with the Chat view's
dialog card. The card on top is pinned: a newcomer joins the end. An answer never moves on by
itself: once the dialog has closed the card says "Answered", Next stays disabled for a moment, and
Next (or Skip) shows the next one with its title focused, so a repeated tap never answers another
agent's dialog. A wait is known by its pane and `since`: a skipped one stays out while it lasts
(and can be shown again), an answered one for 10 s, the time the snapshot may lag the answer; a pane
still blocked after that waits on a new dialog and comes back in. Only that card's dialog is polled. A view-only
device sees it without buttons; an agent the server cannot answer gets only Open terminal; Zellij's
`busy` keeps the card to try again. A working agent quiet for the "Stuck agent" setting (default 10
minutes, its running subagents' writes count) is marked with an hourglass and a line, never colour
alone, and never notified.

A card shows how full the agent's context is as a thin bar (`UsageMeter`, `role="meter"`), the share
and the tokens of the window (`72% 144k/200k`); `~` marks a window assumed (Claude Code whose
transcript, argv and request rows show no model with a window of its own), explained in its title. Bars and their numbers stay neutral below 70%, turn `warning`
from 70% and `danger` from 90%. Above "Needs you", a strip lists each Codex account the agents use:
a bar per rate limit window (`5h`, `7d`), its share, when it resets ("resets 14:30", "resets Mon
09:00", "resets 28/10") and how old the numbers are; numbers older than 30 minutes are dimmed. It
wraps instead of scrolling sideways and is absent without a Codex account.

The header shows a small chip for the open pane's agent: `ctx 72% · 7d 95%` (the limit only for
Codex, the fullest window), its border and text coloured by the fuller part (the text only in the native
style, which draws no border), framed and sized like the view switcher beside it; on a phone only the fuller part. It opens the overview with focus on its pane's card, bordered in accent until focus leaves
the card, and reads only its own pane (`/api/mux/overview?pane=`, never
while it is off or the pane has no agent). Limits older than 30 minutes, or of a window past its
reset, are left out. It is turned off in Settings → Sessions → "Agent usage in the header".

A card's **History** button (`aria-expanded`) opens its last hour as a strip of statuses, cut from the
activity log by the pane's key so a moved tmux window or a renamed Zellij session keeps its own; the
time before the first event, or after the agent went, stays blank. Blocked is striped and idle hollow,
and the legend names each with its status icon. A Claude card also lists its subagents (read every 3 s,
only while open): an icon per status, a running one glowing by opacity under `motion-safe:` only, a
guess marked "(guessed)", 20 at most; closed, the button keeps the count. The header's **Activity**
button opens every status change, newest first, filtered by the status changed to: a column beside the
cards from 1280 px, a sheet below. A row opens its pane under its current id, found by key; a pane that
has gone is plain text.

## Gestures (Mobile)

| Gesture     | Action           | Terminal Command |
| ----------- | ---------------- | ---------------- |
| Swipe left  | Cancel/interrupt | Ctrl+C           |
| Swipe right | Tab completion   | Tab              |
| Swipe up    | Scroll down      | PageDown         |
| Swipe down  | Scroll up        | PageUp           |
| Long press  | Paste clipboard  | Paste            |
| Pinch in    | Decrease font    | -                |
| Pinch out   | Increase font    | -                |

### Gesture Zone

- Covers terminal area only
- Uses Hammer.js for recognition
- Disabled on desktop (mouse interactions)

## Keyboard Toolbar

### Button Groups

1. **Bottom row**: keyboard, text input (IME), Esc, Ctrl, ↑, ↓, Enter, Tab, in a sideways
   scroller whose edge fades (`mask-image`) while it hides keys; the **Extra keys** button (⋯) is
   pinned at the right, outside the scroller, so it is always on screen
2. **Expanded rows** (⋯), at most three, labelled: **Actions** (mobile: Clear, Cancel, Clear
   line, Exit); **Text · Scroll** (command history, paste, attach image, select text, tmux copy
   mode, scroll up/down); **Navigate** (Shift, ⇧Tab, ←/→, Home/End, PgUp/PgDn, Del/Bksp, Ins).
   They close when the on-screen keyboard opens and when the command history opens, so neither
   stacks with them over the whole terminal
3. **Ctrl and Ctrl+Shift combos**: float above the toolbar while the modifier is on, in both
   modes, so pressing Ctrl does not resize the terminal and make a running TUI redraw

There is no Quick actions sheet and no floating button.

### Button Style

- Every key is one Keycap; pressed state is exposed through `aria-pressed`
- Touch-friendly: 44px tap target on touch screens
- Haptic feedback on tap (if supported)

## Accessibility

### Touch Targets

- Minimum 44x44px on touch screens (`pointer-coarse:` variants, `--spacing-touch`); smaller
  with a mouse
- Spacing: 8px between interactive elements

### Names and focus

- Icon-only controls carry an `aria-label`; radios, switches and selects have accessible names
- Sheets and menus close on Escape and return focus to the control that opened them

### Motion

- A global `prefers-reduced-motion: reduce` rule in `index.css` finishes animations and
  transitions at once
- Haptic feedback opt-in

## Icons

- Lucide React icons; emoji for session icons (user-selectable)
- Sizes are set per component (toolbar keys 18px, header 20px)

## Animation

- Durations and easing come from the motion tokens (`duration-fast`, `duration-base`,
  `ease-standard`, `ease-emphasized`); Terminal is the fastest style and Native the slowest
- Animate opacity, transform and colours
- Toasts appear near the top, with status colours, so they never cover the toolbar; a swipe up or
  sideways dismisses one, and holding it pauses its timer
- Sidebar: collapsible on desktop (icon-only when collapsed)
- Fullscreen: desktop only (Fullscreen API), toggle in the header, syncs with F11/Esc
