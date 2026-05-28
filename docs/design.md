# Design Guide

## Spacing scale

Always use multiples of 4px. Tailwind equivalents:

| Token  | px  | Tailwind  | Use                                      |
|--------|-----|-----------|------------------------------------------|
| xs     | 4   | `p-1`     | Icon padding, tight gaps                 |
| sm     | 8   | `p-2`     | Button padding, small gaps               |
| md     | 12  | `p-3`     | Input padding, medium gaps               |
| lg     | 16  | `p-4`     | Section padding, list item horizontal    |
| xl     | 20  | `p-5`     | Editor content padding                   |
| 2xl    | 24  | `p-6`     | Status bar side padding                  |

Section headers always: `px-4 pt-3 pb-1.5`  
List items always: `px-4 py-1.5`

## Typography scale

| Role            | Size  | Class                          |
|-----------------|-------|--------------------------------|
| Section label   | 11px  | `text-[11px] font-semibold tracking-widest uppercase` |
| Meta / caption  | 11px  | `text-[11px]`                  |
| Small UI        | 12px  | `text-[12px]`                  |
| Body / UI       | 13px  | `text-[13px]` (body default)   |
| Editor          | 14px  | `text-[14px]` monospace        |

Never use Tailwind's default `text-xs` (12px) or `text-sm` (14px) — use explicit px to stay in sync with VS Code's exact sizing.

## Color tokens (CSS variables)

```
--bg             Editor and main background
--sidebar-bg     Sidebar and panels
--activity-bg    Activity bar
--tab-active     Active tab background
--tab-inactive   Inactive tab strip background
--tab-accent     Active tab top border + buttons
--border         All dividers and outlines
--text           Primary text
--text-dim       Labels, placeholders, icons
--text-bright    Headings, active items, white text
--statusbar      Status bar background
--hover          Hover and selected state background
--error-bg       Error message background
--error-text     Error message text
```

Never use hardcoded colors in components. Always use a CSS variable.

## Component heights (fixed, never flexible)

| Component       | Height | Tailwind |
|-----------------|--------|----------|
| Tab bar item    | 36px   | `h-9`    |
| Activity button | 44px   | `h-11`   |
| Input / button  | 32px   | `h-8`    |
| Status bar      | 24px   | `h-6`    |

## Borders

- Dividers between regions: `border: 1px solid var(--border)`
- Active tab top: `border-top: 1px solid var(--tab-accent)`
- Modal: `border: 1px solid var(--border)` + `border-radius: 8px`
- Inputs: `border: 1px solid var(--border)`
- No border-radius on panels or sidebar

## Hover states

All interactive elements need both color AND background on hover:

```tsx
onMouseEnter={e => {
  e.currentTarget.style.color = 'var(--text)'
  e.currentTarget.style.background = 'var(--hover)'
}}
onMouseLeave={e => {
  e.currentTarget.style.color = 'var(--text-dim)'
  e.currentTarget.style.background = 'transparent'
}}
```

Icon-only buttons: color change only, no background.

## Transitions

Always: `transition-colors` (150ms default).  
Never animate layout (width, height, padding) unless intentional.

## Inputs

**Never use Tailwind padding/margin classes on any element** — `pt-*`, `pb-*`, `mt-*`, `gap-*`, `px-*`, `py-*` are silently ignored in this Tailwind v4 + Vite setup. Always use inline `style`. — browser resets and Tailwind v4 conflicts cause them to be ignored silently. Always use inline `style` for padding.

```tsx
// Correct
<input style={{ height: '32px', paddingLeft: '34px', paddingRight: '12px', ... }} />

// Wrong — px-3 may be silently ignored
<input className="h-8 px-3" />
```

Rules:
- Height: always `height: '32px'` (h-8)
- Background: `var(--sidebar-bg)` or `var(--bg)` depending on surface
- Border: `1px solid var(--border)`, on focus → `1px solid var(--tab-accent)`
- Border-radius: `4px` (`rounded` Tailwind class is fine here)
- `outline: 'none'` always — replaced by border color change on focus
- With leading icon: `paddingLeft: '34px'` to clear a 13px icon at left-3
- Focus ring via `onFocus`/`onBlur` handlers:
  ```tsx
  onFocus={e => (e.currentTarget.style.borderColor = 'var(--tab-accent)')}
  onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
  ```
- Icon inside input: positioned `absolute left-3`, `pointer-events-none`, `top-1/2 -translate-y-1/2`
- If icon changes state (e.g. spinner while loading), swap inside the same `<span>` wrapper
- Debounce async searches: 400ms via `useEffect` + `clearTimeout` — no submit button

## Empty states

Every list with zero items must show an empty state:
- Centered vertically if it has `flex-1`
- `text-[12px]` in `--text-dim`
- Short explanation + action hint
- No icons (keep it minimal)

## Lists

Two patterns — pick the right one:

### Nav list (sidebar, theme picker)
Rows that switch active state. Used for navigation.
- No border between rows
- Active: `borderLeft: '2px solid var(--tab-accent)'`, `background: var(--hover)`, `color: var(--text-bright)`
- Inactive: `borderLeft: '2px solid transparent'`, `color: var(--text)`
- Hover: background + color change (both)
- Padding: `padding: '5px 12px 5px 16px'` (left extra accounts for the 2px border)
- Font: 13px, `truncate` for overflow

### Result list (marketplace, search results)
Read-only rows with actions. Used for data/search results.
- Row `borderBottom: '1px solid var(--border)'`
- No card boxes — rows are the surface
- Row hover: `background: var(--hover)`
- Text hierarchy: `text-[13px] font-medium --text-bright` (title) → `text-[11px] --text-dim` (meta) → `text-[12px] --text-dim truncate` (description)
- Action button: right-aligned, 26px tall, ghost by default (outline only), fills on hover

## Buttons

Three variants — never invent others:

### Primary (destructive or main CTA)
```
background: var(--tab-accent)
color: var(--text-bright)
height: 32px, padding: 0 16px
```
Use sparingly. Only one per view.

### Ghost (default for most actions)
```
color: var(--tab-accent)
background: transparent
border: 1px solid var(--tab-accent)
height: 26px, padding: 0 10px
On hover: fill with --tab-accent, color → --text-bright
```
Use for row-level actions (Install, Edit, Delete).

### Text / icon-only
```
color: var(--text-dim)
background: transparent, no border
On hover: color → var(--text) only (no background)
```
Use in activity bar, toolbar icon buttons.
