# Tau command UI

This change extends the existing vanilla-JavaScript command palette, not the application shell.

## Tokens
Use `--bg-frosted`, `--bg-glass`, `--bg-glass-hover`, `--bg-glass-active`,
`--text-primary`, `--text-secondary`, `--text-dim`, `--border`, `--border-hover`,
`--radius-md`, `--radius-lg`, `--shadow-lg`, `--shadow-inset`, `--duration`, and
`--ease` from `public/style.css`. Night and Clean use the existing theme values.
Typography inherits the application font; command rows use the existing 13px
label and 11px description scale. Spacing follows the existing 6px list inset,
10px row gap, and 12px/16px panel padding.

## Components and states
- Existing command button: keyboard accessible; opens the searchable palette.
- Palette: centered frosted sheet, bounded by the viewport, internally scrolling list.
- Search: labelled native input, visible keyboard focus, empty-result message.
- Command row: native button, slash spelling and description, hover/pressed/focus states.
- Composer: command arguments remain editable; failed execution retains the draft.

## Interaction and accessibility
Escape dismisses and restores focus. Arrow keys navigate rows; Enter selects.
Tab stays within the open palette. Selecting a slash command prepares it in
the composer; Send or Enter runs the same path as direct typing. No command
executes merely because a row was highlighted. Existing palette actions retain
their direct behavior. Long names wrap; rows have a minimum 44px touch target.
Reduced-motion users receive no palette entrance animation.
The search field uses 16px text on mobile to avoid focus-triggered viewport zoom.

## Scope and accepted debt
Preserve the application's current theme and shared component styles.
Unrelated application-wide accessibility or performance debt is not changed.
Verify the changed palette in Night/Clean at desktop and mobile widths.
