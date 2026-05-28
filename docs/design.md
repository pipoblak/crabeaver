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

## Empty states

Every list with zero items must show an empty state:
- Centered vertically if it has `flex-1`
- `text-[11px]` in `--text-dim`
- Short explanation + action hint
- No icons (keep it minimal)
