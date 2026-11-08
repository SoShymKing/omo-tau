# Tau UI contract

## Session continuation

Keep the existing toolbar and stream-status row. A session awaiting human input
shows "Waiting for input" instead of Connected or background Working. When
automatic updates are held, the row says "Session paused. Send a message to
continue." Other human waits direct the reader to the latest message. The
existing Send action remains the primary action; no hold is released merely by
opening or selecting a session.

Reuse the row's theme tokens and wrapping; continuation guidance uses the
existing 13px body scale and primary text, as does the waiting status label's
ink, for readable contrast in both themes. No new control, animation
or scroll owner. Keep the waiting state on snapshot, reconnect and return to a
session, and clear it when authoritative status releases the wait. Ordinary
Working statistics and question forms keep their existing behavior. Verify
Night/Clean at desktop and phone widths.

## Chat attachments

Preserve the existing chat and tool-card surfaces. Reuse glass, border, text,
radius-md and duration tokens; attachment spacing is 8px/12px and text is 13px.
Images and local files occupy a separate wrapping row above the message text,
in source order, with 12px gaps. Thumbnails fit within 160px by 160px, retaining
their natural proportions without cropping or upscaling. Do not force a square
frame, percentage image height, message width or flex growth. The 720px/85%
message limit is a maximum only: short text and small attachments shrink the
bubble to their content. Use 8px card padding and the neutral border/glass/radius.
The thumbnail button has a 44px minimum touch target and centers smaller images
without stretching them. Multiple images and long text wrap within the message.
File labels retain their own row.
Composer images keep their existing square card size and contained image.
Their Remove control stays visible with a 44px touch target. File chips keep
their existing compact shape. Add no card entrance or scale animation.
Chat shows only the image preview or a 44px file button, never a Download action.
Clicking opens a native modal with filename, Download and Close controls.
Images are enlarged without cropping. Files show size and safe text/image/PDF
previews; unsupported or oversized text files show details and download instead.
Text is rendered as text, not HTML. Closing cancels pending file-preview requests.
Escape closes the modal and restores focus, including touch input.
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
On touch devices with a coarse pointer and no hover, the workspace path field uses
the existing 16px mobile input scale, including landscape orientations.

## 4. Spacing and layout
Reuse .dialog's 28px padding, 420px maximum width and 90% width; 8px action gaps and 16px field spacing. The native workspace dialog is viewport bounded, scrolls internally when needed, and keeps 16px outer clearance on small screens.

## 5. Components
Workspace creation reuses .dialog, .dialog-title, .dialog-message, .dialog-input and .dialog-actions. Its native dialog provides modal focus containment, Escape cancellation and background inertness. Fields have visible labels. Recent workspaces remain in a native datalist. A visible Subfolders group previews the entered directory or matches a partial child name; buttons choose an absolute path and drill down without submitting. The group uses existing glass/border/text tokens, 8px gaps, 12px padding, 13px text and 44px rows, with a 176px internally scrolling list. Loading/empty/error status is announced politely; errors do not disable new-folder creation. Down from the field focuses the first directory; Up/Down move between rows; Enter selects. Input changes and modal closure cancel stale lookups. Folder creation is explicitly opt-in. Errors are inline role=alert. Submit disables immediately during creation; success navigates only after server acknowledgement. Cancel restores focus to New session.

The workspace preview always starts with a `..` button targeting the displayed directory's parent, including empty and filtered lists. It reuses the directory row and keyboard behavior. At a filesystem root, `..` keeps the same root.

## 6. Motion and interaction
Reuse --duration and --ease for inherited controls. No new animation. Reduced motion disables inherited sheet animation for this dialog. Controls have 44px minimum height, visible focus and disabled states. Escape does not abort the background chat while this modal is open.
On touch devices, opening the workspace dialog, browsing folders and recovering
from failed creation focus the non-editable heading, not the path field. The
heading is the native dialog autofocus target so the field never gains transient
focus on opening. Direct field taps still edit normally. Desktop retains initial
path focus and the existing folder keyboard navigation. Do not disable pinch zoom.

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
Session selection stays on the same origin. Select the target row and show
cached or independently fetched recent history immediately, while preparing
the actual session in parallel. The visible file owns its editable draft and
attachments; only the latest acknowledged snapshot authorizes commands.
Preparing or failed previews cannot send, abort or change worker settings.
Failure keeps the target history and draft with a native Retry action.
Discard superseded history, events and acknowledgements, including A/B/A.

A persistent polite status region above history distinguishes preparation,
history-loading trouble and failed startup. Reuse glass, border, secondary
text, 13px type and 8px/16px spacing; Retry uses a native 44px control.
Do not move focus, add entrance animation or change existing theme tokens.
Cache whole recent pages only, with bounded count/bytes and their opaque byte cursor.
Reconcile authoritative history on acknowledgement without losing local drafts
or the older records already loaded in the current view.

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

Read persisted history backwards from a frozen file extent. Continue before the
oldest loaded byte offset, without scanning the prefix again. File identity and
byte offsets identify records, including identical records without entry IDs.
Keep the entry/byte page budgets; one oversized atomic record can exceed the
HTTP budget. Ignore an incomplete trailing write.

One click continues through result-only or bookkeeping pages until older content
appears or the beginning of the file is reached. Preserve the current view's
older prefix on readiness and reconnect. Fill any intervening gap before applying
the new snapshot, buffer its live events, and cancel that work on session change.

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

## 14. Session ordering

A labelled native select below the sidebar search offers Default and Latest.
Default preserves favourites and collapsible workspace groups. Latest is one
global list ordered by the last submitted user instruction or chat time;
sessions without a usable input timestamp use creation time. Opening a session,
assistant/tool output and title updates do not change this order.
Confirmed user-message events update the cached input time and existing rows
without reloading the list. Drafts, pending queued input and failed sends do not
change the order. Reconnected history restores missed input times. Preserve
search results, selection and focused title editors during row moves.
Favourites retain their star without
pinning or duplicating rows. Save the selected mode in browser local storage.
Reuse the existing glass, border, primary/secondary text and medium-radius tokens,
system font, 13px control text, 8px/12px spacing and 44px minimum control height.
The control has a visible focus ring and uses 16px text on narrow screens.

In Latest, show the same last-input time beside the workspace basename on each row. Keep the
time visible while long workspace names ellipsize; the full path is available
in the workspace tooltip. Render paths as text. Default retains creation-time
labels. Searching, selected rows and context actions work in both modes;
message-search results remain a separate section. Add no animation or dependency.
Verify both modes and long paths in Night/Clean at desktop and phone widths.

## 15. Completed task lists

The composer task panel shows only unfinished lists. Pending and in-progress
items keep it visible, including while the agent is idle or awaiting input.
Completed, abandoned, cancelled and failed items are terminal; unknown statuses
stay visible rather than silently hiding work.

When a nonempty list becomes terminal, retain its phases, task text and status
in a collapsed native Tasks details/summary in the chronological chat history.
Reuse the Activity summary, glass surface, neutral border, text and radius tokens,
and the existing task rows. The summary has a 44px target and shows progress
and the outcome as text. Expanded history uses the chat scroll owner, not a
nested scrolling panel. Long content wraps; untrusted text uses textContent.

Repeated snapshots do not duplicate a completion. Saved canonical task entries
restore records on reload, session changes and earlier-history loading. New
unfinished lists restore the composer panel without removing older records.
If older history is not loaded, snapshot state updates the live-state baseline
without adding an out-of-order record. Its saved entry supplies the record when
that history page is loaded.
Native keyboard disclosure preserves open state during live updates, does not
move focus, and adds no animation or dependency. Verify Night/Clean at phone
and desktop widths. Existing application-wide accessibility debt is unchanged.

## 16. Live stream status

Keep the existing Working status and indicator in the toolbar. While the selected
session runs, a full-width second toolbar row shows the stream-update count and
last server receipt time in English. Count message_update and tool_execution_update
events, not tokens or transport frames. Reset at agent_start. Restore the
server-owned values on reload, reconnect and session selection.

Reuse the toolbar's 11px type, secondary text, 12px gaps and inherited font.
Use tabular numbers, allow the two fields to wrap, and keep the existing measured
header clearance for history. Show a waiting label before the first update.
Use a semantic time element for the local clock time and show elapsed seconds.
Refresh only the elapsed label once per second while running; hide the row and
stop its timer when idle, disconnected or previewing another session.
No new animation, dependency, focus movement or per-update live announcement.
Verify waiting, receiving and stopped states in Night/Clean at phone and desktop
widths. Existing application-wide accessibility and performance debt is unchanged.

## 17. Chat scroll containment

The messages panel owns vertical chat scrolling and contains absolutely positioned
descendants, including KaTeX's hidden MathML accessibility content. Long histories
must not extend the outer document below the viewport. Keep MathML available to
assistive technology and preserve existing message geometry, manual reading and
bottom-follow behavior. Verify Night/Clean at phone and desktop widths.
Viewport resizing keeps the chat at the bottom while following output.
It must not resume following or move the reading anchor while manually paused.

## 18. Hidden file panel containment

The application shell clips horizontal overflow without becoming a scroll owner.
The file panel keeps its existing width, glass surface and collapse transition,
but its controls are inert while collapsed, including before JavaScript starts.
Opening restores ordinary keyboard access. Closing from inside the panel returns
focus to its toolbar toggle before making the panel inert; session changes use
the same collapsed state.

Tab from the composer must skip hidden file controls without moving the outer
document or pushing the open session sidebar off screen. Verify initial load,
open/close and session changes, plus viewport-bounded page width in Night/Clean
at phone and desktop widths. No dependency, new visual token or redesign.

## 19. Conversation sets and on-demand tool details

The conversation-v1 view groups each instruction with its responses and Activity.
A set may span bounded history pages. Its initiating instruction is a sidecar,
not an inserted history entry or an acknowledgement of an equal-text draft.
Show the instruction once, including before its original history entry is loaded.
Keep physical byte positions, chronological order and the reader's anchor.
An earlier-history action retains the starting partial set's key and loads
bounded pages until merged metadata marks that target complete or history ends.
Visible content and a five-page count do not stop conversation-v1 loading.
Without a local partial set, the global action captures the first earlier page's
target key. Completing that target leaves any different older partial set for
the next action, even when its entries arrive on the target's boundary page.
Show one native Load earlier messages action: beside the oldest partial set's
polite status text when available, otherwise in the global history position.
Loading disables that action. Failure shows one visible cause with role=alert
at its owner and offers Retry there, retaining the cursor and loaded content.
Exhausting history removes stale partial notices, including on an empty page.
Session changes cancel pending requests and stale replies cannot update the view.
Legacy history stops at visible progress or five invisible bounded pages per
action; if history remains, show continuation text and retain its opaque cursor.
Reuse the global button's neutral theme surface, 13px type, 8px/16px padding
and 44px target. The action keeps a 230px width bounded by its container
so loading and retry labels do not resize them. The notice wraps with an 8px
gap and uses primary text for errors. No new animation or dependency.
Primary action: load earlier messages. Priorities: missing-history status,
the load/retry action, then the existing Activity and reply content.
Required content: partial status, load/loading/retry/continuation states and
all previously loaded messages. Add no set decoration or extra status card.
Layout: existing chat flow; the messages panel owns vertical scrolling;
the notice and button wrap within the response width without a nested scroller.
Keep 20px of top clearance below the measured header height, including a wrapped
phone toolbar, so the global history action and its focus ring remain visible.

Sets are internal groups, not visible cards. Keep the existing chat flow:
no set background, border, padding, numbering, divider or special spacing.
Use the ordinary 6px message gap within and between sets. Response columns
use the available chat width at phone and desktop sizes. The messages panel
remains the scroll owner. Add no entrance animation or focus movement.

Closed Activity keeps model counts without creating tool headers or bodies.
Opening Activity creates headers but makes no detail request. A native,
keyboard-accessible tool toggle fetches and creates only that tool's body.
Closing cancels pending details; reopening uses a byte-bounded preview cache.
Live updates change summary status while only explicitly open bodies refresh.
Restore explicit disclosure choices after reconnecting.

View responses bound argument and output previews, omit inline attachment data,
and show truncation explicitly. Copy output can fetch complete output while its
body is closed. Files and URL images use the existing attachment renderer;
inline attachment downloads are explicit. Errors and Retry remain at the tool.
Session changes invalidate pending details before they can update another view.
Raw clients keep their existing history contract; only the app opts into this view.

## 20. Agents status panel

### Selected workflow brief and limits

Extend Tau's quiet neutral glass sidebar with one selected workflow and one shared
inspector. Herdr supplies behavior only. Retain Tau's inherited system font, theme
colors, radius tokens, 13px body/12px caption/16px title scale, 8/12/16px spacing,
44px controls, 360px desktop slot and existing 768px phone overlay. The Agents
panel remains the only vertical scroll owner; graph and inspector never scroll
independently. No new motion, font, dependency, zoom or canvas.

Workflow DAG starts open so opening Agents exposes its selector and graph
immediately. Preserve an explicit user collapse across updates and panel reopen;
only construction sets the default. Native Workflow select, Follow running
button and keyed node buttons precede
the inspector. Decorative SVG routes prerequisite-to-dependent edges around
fixed cards. Geometry tokens extend the panel system: minimum width is three
44px targets, height two targets, gap 16px and gutter 12px. Logical ranks wrap
into physical rows at available width. Status words accompany any color.
The inspector shows prompt, exact dependencies, model/state/activity/counters
and descendants proven by tau_ancestry, never by graph edges.

Task counts deduplicate task IDs independently of selected-run node counts.
DAG-linked tasks and proven descendants have no duplicate primary article.
Terminal standalone tasks use a native Completed disclosure. Unknown, ready
empty, cached/unverified, incomplete coverage and disconnected states remain
distinct. Cached running records never appear as live toolbar activity or tick.
Manual run/node/scroll pauses follow; explicit Follow resumes within that run.
Follow never changes inspector selection, focus or chat scrolling.

Presentation bounds are 64 runs/options and remembered node selections, 200
nodes/400 unique edges per run, 200 primary task rows, 100 inspector descendants,
32000 characters per inspector field and 128000 mounted text characters total.
Keep panel elements below 4000. Exceeding global linkage bounds shows one bounded
Observed tasks fallback. Oversize runs show counts/limits, without partial graph.
Cycles, missing edges and conflicting duplicates show inspectable bounded node
lists without SVG. Omitted counts and text truncation remain visible.

Only selected graph DOM exists. Structural signatures reuse prepared topology
and layout on status changes; only width changes recompute geometry. All panel
mutation, resize, clock and follow work requires visible and document-visible.
Hidden replacements retain latest state only; reopening flushes synchronously.
Closed DAG defers graph work. One connected live clock updates elapsed text
only. Session switches invalidate state immediately and clear DOM at next allowed
flush. Removed focused controls release focus before detach; the mobile focus
trap includes select. Destroy releases listeners, observer and timer.

The primary action remains sending a chat instruction. The optional Agents view
shows, in order, running or waiting work, each task's model/state/elapsed time
and recent activity, then completed tasks and a collapsible DAG. Toolbar order
is Agents, Files, Settings. Keep existing neutral glass/border/text/radius tokens,
system typography, 8px/12px/16px spacing and 44px interactive targets. Do not copy
the terminal screenshot's colors, fixed-width text or terminal key hints.

Layout: one optional right sidebar shares the Agents and Files slot; its active
body owns vertical scrolling and the chat keeps its existing messages scroll
owner. Desktop Agents is about 360px wide. At the existing 768px breakpoint it
is a viewport-bounded overlay with a backdrop and visible Close control. Never
stack two right panels, scroll the outer document, or create a horizontal page
overflow. Long task and model labels wrap inside the panel.

The panel starts closed without a valid saved preference. Save the selected
mode and open preference separately; a session switch may close it transiently
without erasing the user's choice. Opening Files selects its body and keeps
existing file insertion behavior. Closing or switching bodies moves focus to
the appropriate toolbar trigger before making the old body inert. Both bodies
are inert when closed, including before JavaScript. Escape closes the panel
before any chat abort. Settings and native dialogs retain their precedence.

Use authoritative OMO task and DAG replacements for the selected parent only.
No observed snapshot means unknown, not an empty/completed list. Known empty,
truncation, unavailable state and disconnected/stale data have distinct text.
Reconnect restores the latest observed state through the ordinary session
snapshot. Register the observer before session_start to capture initial state;
do not promise a cold read of emissions that predate extension registration.

Render external task/model/activity/dependency strings as text. Preserve DAG
disclosure choices across updates. One visible-panel clock updates elapsed
labels; stop it while hidden, disconnected or switching sessions. Terminal
task elapsed time freezes at its last lifecycle update. Do not invent absent
metrics or move focus on state updates. Add no entrance animation or dependency.
Verify Night/Clean at phone and desktop widths, populated/empty/unknown states,
live completion, reconnect, session isolation, Files switching and keyboard
focus. Existing unrelated application-wide accessibility debt is unchanged.
