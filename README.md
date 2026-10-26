# Tau

A web UI for OMO terminal sessions. Mirror your terminal, resume saved conversations, and run multiple chats through one browser address. No separate server to start.

![Tau dark mode](docs/images/dark.png)

![Tau terracotta theme](docs/images/terracotta.png)

![Settings](docs/images/settings.png)

![Commands](docs/images/commands.png)

## What it does

Tau connects to your running OMO session and gives you a second view in the browser. Same session, same messages, same tools — just a different screen. Type in the terminal or the browser, both stay in sync.

- **Live mirroring** — streams messages, tool calls, and thinking blocks in real-time
- **Works on any device** — open it on your phone, tablet, or another monitor
- **Resumable sessions** — continue past conversations or run several chats at once
- **One Tau server** — the extension serves every chat through one HTTP/WebSocket port
- **Browser interaction** — answer agent questions, inspect tool activity, and open or download generated files

## OMO integration

Tau runs as an OMO extension, with a shared session gateway, workspace chat workers, and browser question forms. Session management and question forms use OMO's APIs; the connected OMO version must support those APIs to expose the corresponding features.

Tau can access and control your OMO session and local files. The default bind address is `0.0.0.0`, and authentication is optional. Use `TAU_HOST=127.0.0.1` for local-only access, or configure authentication before allowing other devices to connect. Do not expose it directly to the public internet.

## Install

This is an OMO fork of Tau. The original project is no longer maintained.
Install this fork from a local Git checkout with `omo install`.

With OMO, Git, and npm available, run:

```bash
git clone https://github.com/SoShymKing/omo-tau.git
cd omo-tau
npm install
omo install ./
```

`npm install` installs Tau's dependencies. `omo install ./` registers the local
checkout with OMO. Keep that directory in place and restart OMO after installation.

## Usage

1. Start OMO normally in your terminal with Tau installed.
2. Run `/tau` to open the browser, or open the URL shown in the status bar (default: `http://localhost:3001`).
3. Use the current conversation, select a saved session, or create a chat in another workspace.

Type `/qr` in the terminal to show a QR code and scan it to access via your phone. The phone must be able to reach the computer running Tau; a localhost-only bind is not reachable from another device.

## Features

### Chat
- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Collapsible **Activity** groups for tool calls and thinking, separate from answer text
- Image attachments (paste, drag & drop, or button)
- Image previews with an expanded viewer and download action
- Open and download local file links from messages and tool results
- Copy any message with one click
- Inline diff viewer for edit tool calls (red/green lines)
- Scroll-to-bottom button with new message indicator
- Message queuing — type while the agent is working, messages queue and auto-send
- Desktop Enter sends; Shift+Enter inserts a newline. On touch devices, Enter inserts a newline and **Send** submits
- During a response, the composer shows **Send** when a draft or attachment is ready, otherwise **Abort**
- Reading older messages pauses automatic scrolling; submitting a message resumes following the conversation

### Session Management
- Browse all past sessions grouped by project
- Full-text search across all session history with highlighted snippets
- **Default** sorting groups sessions by project; **Latest** shows sessions across projects by last modified time
- Live session marked with a green dot
- Select a historical session to resume it in its original workspace
- New chats and resumed sessions share the same Tau address; switching does not stop background responses
- Additional OMO terminals register with the existing gateway instead of opening another Tau server
- Session-specific drafts and queued messages stay with their originating conversation
- Saved history appears before a resumed chat worker finishes starting; sending waits until the session is ready
- Recent history loads first, with **Load earlier messages** for older entries
- Unviewed, idle chat workers stop after a 30-second grace period; terminal sessions and unfinished work are not evicted
- Inline session rename
- Favourite sessions, tags, and filtering

### Agent questions
- Answer supported agent question requests in a nonmodal panel while keeping chat available
- Single-choice and multiple-choice answers, custom text, and optional comments
- Submit or cancel a request from the browser; resolved requests disappear from the panel
- Answer drafts stay with their session when switching chats or reconnecting
- Sessions without question-control support can still use ordinary chat

### Slash commands
- Type a command directly in the message box, or open **Commands** beside it.
- Search the palette, select a command, edit its arguments, then press Enter or Send.
  Sending `/` by itself also opens the palette.
- Tau provides `/help`, `/name <name>`, `/stats`, `/compact [instructions]`,
  `/model`, `/settings`, `/abort`, and `/export`.
- The palette also discovers the connected OMO session's extension commands, prompt
  templates, and skills. Skill commands keep their `/skill:name` spelling.
  They run with command/template expansion enabled; ordinary chat stays literal.
- Unknown commands and invalid arguments report an error without clearing the
  message. Send attachments separately. Agent commands submitted during a
  response use follow-up delivery.
- Terminal-only built-ins are not automatically available in the browser.
  Commands requiring terminal-specific UI still depend on OMO's support.
- Escape closes the palette; arrow keys navigate and Enter selects. Existing
  Compact, Export HTML, Session Stats, and tool expansion actions remain available.

### Model & Thinking
- Model picker with search/filter and keyboard support
- Thinking level toggle (off/low/medium/high)
- Token usage percentage with context window visualiser
- Cost tracking per session

### Voice Input
- Mic button in the input area using the browser's Web Speech API when supported
- Live transcription into the textarea
- Pulses red while recording
- Speech processing depends on the browser; Tau does not force on-device recognition

### File Browser
- Right sidebar with lazy-loaded file tree
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### Compaction
- Manual context compaction with status display
- Auto-compaction support

### PWA
- Installable as a standalone app on iOS, Android, and macOS
- Custom app icons
- Service worker with network-first caching

## Configuration

Settings are read from the `tau` object in `~/.omo/agent/settings.json`. Environment variables override the corresponding settings; disabling auto-start through either source takes precedence.

Set environment variables before starting OMO:

| Variable          | Default     | Description                                                                  |
|-------------------|-------------|------------------------------------------------------------------------------|
| `TAU_MIRROR_PORT` | `3001`      | Server port                                                                  |
| `TAU_HOST`        | `0.0.0.0`   | Bind address. Set to `127.0.0.1` to restrict to localhost only               |
| `TAU_STATIC_DIR`  | *(bundled)* | Override static files path                                                   |
| `TAU_DISABLED`    | `0`         | Set to `1` or `true` to disable auto-start (Tau stays installed)             |
| `TAU_PROJECTS_DIR` | *(none)*   | Directory whose subdirectories appear in the project launcher               |
| `TAU_USER`        | *(none)*    | HTTP Basic Auth username (both `TAU_USER` and `TAU_PASS` required to enable) |
| `TAU_PASS`        | *(none)*    | HTTP Basic Auth password                                                     |
| `PI_CODING_AGENT_DIR` | `~/.omo/agent` | OMO agent directory used to locate sessions                          |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Override the session store directly          |

The `PI_CODING_AGENT_*` names above are the environment variables currently read by Tau for OMO's session storage.

Tau lists sessions from every workspace under the session store. Gateway discovery files live in `~/.omo/tau-instances`; local processes communicate through a named pipe on Windows or a Unix socket on other platforms.

For example, merge this into `~/.omo/agent/settings.json`:

```json
{
  "tau": {
    "port": 3001,
    "host": "127.0.0.1",
    "disabled": false,
    "projectsDir": "~/Projects"
  }
}
```

`projectsDir` is optional and supplies project launcher entries; it does not limit which workspaces you can select for new chats. The settings path stays `~/.omo/agent/settings.json` even when the session directory is overridden.

### New chats and workspaces

Click **New session** in the sidebar, choose a workspace directory, then click
**Create chat**. The path refers to the computer running Tau, even when the
browser is on a phone. Existing workspace paths appear as suggestions. Select
**Create the folder if it does not exist** to start in a new directory.

Each new chat runs in an independent OMO RPC process, using the current model and
thinking level. A running terminal session is reused when selected; saved
sessions can be resumed in a worker in their original workspace. Chat requests
and the file browser follow the selected session's workspace.

All chats share the gateway's HTTP/WebSocket port. Switching sessions does not
open another Tau server or stop background responses. Unviewed, idle workers
stop after a 30-second grace period; streaming, queued work, active wake sources,
and pending questions keep them alive. Workers stop when the gateway process
that created them exits. Saved conversations remain in the session store.

### Authentication

Tau supports optional HTTP Basic Auth (browser-native login popup).

**1. Set credentials** — add to `~/.omo/agent/settings.json`:

```json
{
  "tau": {
    "user": "omo",
    "pass": "your-password"
  }
}
```

Or set `TAU_USER` and `TAU_PASS` in OMO's environment before starting it.

**2. Toggle on/off** — authentication is enabled by default when both credentials are configured, unless `tau.authEnabled` is `false`. A "Require login" toggle appears in Settings within the Tau web UI. The setting persists across restarts.

Both HTTP and WebSocket connections are gated when enabled. The `/api/health` endpoint remains open for monitoring.

### Start / Stop

Control Tau at runtime without uninstalling:

```
/taustop     Stop Tau in this process
/taustart    Start or reconnect Tau in this process
```

To prevent Tau from auto-starting (e.g. in multi-session or dev container workflows):

```bash
TAU_DISABLED=1 omo
```

In PowerShell:

```powershell
$env:TAU_DISABLED = "1"
omo
```

You can still start Tau manually with `/taustart` in that OMO session.

## How it works

Tau is an OMO extension that starts an HTTP + WebSocket gateway inside an OMO process. Other OMO terminal sessions and chat workers register with that gateway over local IPC. Browser clients select a session, and the gateway routes commands and events to its owning OMO process.

```
Browser (Tau)
    |
    | HTTP + WebSocket on :3001
    |
Tau gateway inside an OMO process
    |-- Local OMO terminal session
    |-- Other OMO terminal sessions (local IPC)
    `-- OMO chat workers in selected workspaces (local IPC)
```

There's no separate server to run. The extension auto-loads with OMO unless disabled. The gateway belongs to its OMO host process, so replacing a conversation does not replace the server.

## Development

Use the local checkout registered with `omo install ./` in the
[installation steps](#install).

Edit the files in `public/`, then refresh the browser. There is no frontend build
step. Set `TAU_STATIC_DIR` to an absolute path if you want an installed extension
to serve a different copy of `public/`.

After editing `extensions/mirror-server.ts`, clear the jiti cache on Windows and
restart OMO:

```powershell
Remove-Item "$env:LOCALAPPDATA\Temp\jiti" -Recurse -Force -ErrorAction SilentlyContinue
```

### Tests

Tests live in `tests/` and use Bun's test runner. Browser tests also use
`Bun.WebView`, which must be available in your Bun installation.

```bash
bun test
# Or run a focused test:
bun test tests/session-sidebar.test.js
```

## License

MIT
