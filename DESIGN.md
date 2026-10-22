# Tau UI contract

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
