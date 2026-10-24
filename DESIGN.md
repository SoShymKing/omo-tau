# Tau UI contract
## Chat attachments

Preserve the existing chat and tool-card surfaces. Reuse glass, border, text,
radius-md and duration tokens; attachment spacing is 8px/12px and text is 13px.
Image thumbnails are bounded to 240px by 200px without cropping. File labels wrap.
Each local file has an Open link and a separate Download link with 44px targets.
Images open a native modal dialog with a viewport-bounded, uncropped image,
filename, Download and Close controls. Escape closes it and restores focus.
Loading failures announce a visible error without removing download access.
No new animation or dependency. Verify user/assistant/tool attachments and the
viewer in Night/Clean at phone and desktop widths. Remote images retain their
original URLs; local paths resolve against the message's session, not a later
selection. Existing application-wide accessibility debt is outside this change.


## 1. Atmosphere and identity
Preserve Tau's quiet glass chat interface, compact sidebar, and theme-selected neutral surfaces. This feature extends existing dialog primitives; it does not redesign the application.

## 2. Color
Use the active theme in public/style.css: --bg-solid, --bg-frosted, --bg-glass, --bg-glass-hover, --text-primary, --text-secondary, --border, --border-hover, --accent, --accent-glow. Inline errors use primary text weight for contrast across themes and role=alert for announcement. Never hard-code a feature-specific palette. Night and Clean are the dark/light verification pair.

## 3. Typography
Inherit the existing system font. Dialog titles use the existing 16px/600 rule; labels, body, fields and controls use the existing 13px scale with 1.55 line height for explanations. Long paths wrap or scroll within their field.

## 4. Spacing and layout
Reuse .dialog's 28px padding, 420px maximum width and 90% width; 8px action gaps and 16px field spacing. The native workspace dialog is viewport bounded, scrolls internally when needed, and keeps 16px outer clearance on small screens.

## 5. Components
Workspace creation reuses .dialog, .dialog-title, .dialog-message, .dialog-input and .dialog-actions. Its native dialog provides modal focus containment, Escape cancellation and background inertness. Fields have visible labels. Recent workspaces remain in a native datalist. A visible Subfolders group previews the entered directory or matches a partial child name; buttons choose an absolute path and drill down without submitting. The group uses existing glass/border/text tokens, 8px gaps, 12px padding, 13px text and 44px rows, with a 176px internally scrolling list. Loading/empty/error status is announced politely; errors do not disable new-folder creation. Down from the field focuses the first directory; Up/Down move between rows; Enter selects. Input changes and modal closure cancel stale lookups. Folder creation is explicitly opt-in. Errors are inline role=alert. Submit disables immediately during creation; success navigates only after server acknowledgement. Cancel restores focus to New session.

The workspace preview always starts with a `..` button targeting the displayed directory's parent, including empty and filtered lists. It reuses the directory row and keyboard behavior. At a filesystem root, `..` keeps the same root.

## 6. Motion and interaction
Reuse --duration and --ease for inherited controls. No new animation. Reduced motion disables inherited sheet animation for this dialog. Controls have 44px minimum height, visible focus and disabled states. Escape does not abort the background chat while this modal is open.

## 7. Accessibility
Native dialog labelled by its heading, labelled text input and checkbox, announced inline errors, keyboard submission and cancellation, focus containment and restoration. Primary submit uses --text-primary over a neutral theme wash so Night's gray accent does not force white-on-gray text.

## 8. Accepted debt and scope
Existing application's unrelated icon sizes, historical styling and remote KaTeX scripts are unchanged. OpenCode is a behavioral reference (explicit directory, confirmed creation, then navigation), not a pixel target. No React tooling or added UI dependency is required.

## 9. Command palette

This change extends the existing vanilla-JavaScript command palette, not the application shell.

### Tokens
Use `--bg-frosted`, `--bg-glass`, `--bg-glass-hover`, `--bg-glass-active`,
`--text-primary`, `--text-secondary`, `--text-dim`, `--border`, `--border-hover`,
`--radius-md`, `--radius-lg`, `--shadow-lg`, `--shadow-inset`, `--duration`, and
`--ease` from `public/style.css`. Night and Clean use the existing theme values.
Typography inherits the application font; command rows use the existing 13px
label and 11px description scale. Spacing follows the existing 6px list inset,
10px row gap, and 12px/16px panel padding.

### Components and states
- Existing command button: keyboard accessible; opens the searchable palette.
- Palette: centered frosted sheet, bounded by the viewport, internally scrolling list.
- Search: labelled native input, visible keyboard focus, empty-result message.
- Command row: native button, slash spelling and description, hover/pressed/focus states.
- Composer: command arguments remain editable; failed execution retains the draft.

### Interaction and accessibility
Escape dismisses and restores focus. Arrow keys navigate rows; Enter selects.
Tab stays within the open palette. Selecting a slash command prepares it in
the composer; Send or Enter runs the same path as direct typing. No command
executes merely because a row was highlighted. Existing palette actions retain
their direct behavior. Long names wrap; rows have a minimum 44px touch target.
Reduced-motion users receive no palette entrance animation.
The search field uses 16px text on mobile to avoid focus-triggered viewport zoom.

### Scope and accepted debt
Preserve the application's current theme and shared component styles.
Unrelated application-wide accessibility or performance debt is not changed.

## 10. Session navigation

Keep the existing sidebar, composer, workspace dialog, tool cards and themes.
Session selection stays on the same origin and commits only after the gateway
acknowledges a usable session snapshot. Until then, preserve the current
conversation, selected row, draft and attachments. A failed selection reports
its error without replacing that state.

Restore partial assistant text, collapsed thinking, tool progress and Working
state when returning to a running session or reconnecting. Background replies
and queued messages belong to their original session. Disconnected sessions
cannot send messages. A successful rename updates the selected sidebar title.
Verify the changed palette in Night/Clean at desktop and mobile widths.

## 11. Nonmodal questions

Questions extend the composer, not the generic modal dialog. A single labelled
region above the chat form contains every pending request. Its fixed header
shows the pending count and a native collapse button; only the body scrolls.
The panel is bounded to 48dvh on desktop and 40dvh at the existing 768px narrow
breakpoint, so the ordinary composer remains available. Collapse never cancels.
This uses the bounded scroll-body-shell pattern: the body has min-height: 0,
overflow: auto, and an explicitly bounded parent.

Reuse the active theme's glass, border, primary/secondary text and accent tokens,
the system font, and --radius-md / --radius. The question primitive tokens
codify existing values: --question-space-xs: 4px, --question-space-sm: 8px,
--question-space-md: 12px, --question-space-lg: 16px,
--question-font: 13px, --question-title: 16px, --question-leading: 1.55,
and --question-target: 44px. No entrance animation or new palette.

Each request is a native form with fieldsets and legends, native labelled radios
or checkboxes, descriptive text, optional per-question text and a request comment.
Text controls inherit system typography (16px on narrow screens to avoid zoom).
Actions use the neutral dialog-button treatment and 44px targets. All controls
have visible keyboard focus. Pending, submitting, refused, offline and
unsupported states have visible status text; accepted acknowledgements close
their own request. Errors are
announced. Unsupported question control does not disable ordinary chat.

Do not move focus on arrival or state updates. Keep existing field nodes while
editing, preserve session-owned drafts on failures/navigation/disconnect, and
isolate Enter/Escape from chat submission/agent abort. Enter in text fields does
not submit; Submit and Cancel are explicit actions. Partial and comment-only
answers are valid; empty/untouched entries are omitted. Untrusted question text
is rendered only with DOM text nodes.

Accepted debt: no application-wide layout, typography, modal or accessibility
redesign; existing unrelated UI remains unchanged. Component and integrated-page
proof use the actual production renderer in Night/Clean, desktop/mobile.

## 12. Earlier session history

Show a native "Load earlier messages" button above the oldest loaded entry.
Reuse the neutral glass surface, border, primary/secondary text, medium radius,
13px label, 8px/16px spacing and 44px touch target from the existing controls.
Loading disables the button; a failed request offers retry in the same place.
Prepending a page preserves the reader's scroll position and existing live DOM.
Session changes cancel the previous history request. History stays chronological,
including tool results whose calls are in an earlier page.

## 13. Activity groups

Consecutive tool cards and thinking blocks share a collapsed native details/summary
disclosure, including live reasoning and thinking in messages that also have text.
Only assistant text and attachments remain in the reply bubble; user messages and
system notices also stay outside and preserve chronological boundaries. Empty
streaming reply placeholders have no layout footprint and never split a group.
Thinking updates and completion reuse the same disclosure node and open state.

The summary shows thinking/tool counts plus running/error counts, including when
closed. New activity preserves the reader's open/closed choice. Earlier history
joins adjacent groups without replacing live tool nodes or their disclosure state.
The existing Show thinking setting also hides thinking-only groups and counts.

Reuse glass, border, primary/secondary text and medium-radius tokens. Activity
spacing is 4px/8px/12px, text is 13px with 1.55 line height, the summary target is
44px, and its chevron is 12px. Expanded items form a vertical list with 4px gaps.
Use native keyboard disclosure and focus-visible styling, without height animation
or scroll-to-bottom on a manual toggle. Night/Clean and narrow/wide views are the
verification matrix. No new dependency or application-wide redesign.
