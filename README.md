# Tau

A web UI that mirrors your [Pi](https://github.com/badlogic/pi-mono) terminal session in the browser. No separate server — it runs as a Pi extension inside your existing process.

![Tau dark mode](docs/images/dark.png)

![Tau terracotta theme](docs/images/terracotta.png)

![Settings](docs/images/settings.png)

![Commands](docs/images/commands.png)

## What it does

Tau connects to your running Pi TUI and gives you a second view in the browser. Same session, same messages, same tools — just a different screen. Type in the terminal or the browser, both stay in sync.

- **Live mirroring** — streams messages, tool calls, and thinking blocks in real-time
- **Works on any device** — open it on your phone, tablet, or another monitor
- **Resumable sessions** — continue past conversations or run several chats at once
- **One Tau server** — the extension serves every chat through one HTTP/WebSocket port

## Project status: retired

Tau is no longer maintained. No further features, bug fixes, or releases are planned, and new contributions will not be reviewed or merged. The code remains available under the [MIT license](LICENSE) for anyone who wants to fork it.

The installation and usage instructions below are retained for reference. Tau can access and control your Pi session; do not expose it to the public internet. Authentication is optional and the default bind address is `0.0.0.0`. See [#65](https://github.com/deflating/tau/issues/65) for the outstanding security cleanup.

## Install

```bash
pi install npm:tau-mirror
```

Or from git:

```bash
pi install git:github.com/deflating/tau
```

## Usage

1. Start Pi normally in your terminal
2. Open the URL shown in the status bar (default: `http://localhost:3001`)
3. That's it

Type `/qr` in the terminal to show a QR code and scan it to access via your phone.

## Features

### Chat
- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls (red/green lines)
- Scroll-to-bottom button with new message indicator
- Message queuing — type while the agent is working, messages queue and auto-send

### Session Management
- Browse all past sessions grouped by project
- Full-text search across all session history with highlighted snippets
- Sorted by last modified (most recent first)
- Live session marked with a green dot
- Select a historical session to resume it in its original workspace
- New chats and resumed sessions share the same Tau address; switching does not stop background responses
- Additional OMO terminals register with the existing gateway instead of opening another Tau server
- Session-specific drafts and queued messages stay with their originating conversation
- Unviewed, idle chat workers stop after a 30-second grace period; terminal sessions and unfinished work are not evicted
- Inline session rename
- Favourite sessions, tags, and filtering

### Slash commands
- Type a command directly in the message box, or open **Commands** beside it.
- Search the palette, select a command, edit its arguments, then press Enter or Send.
  Sending `/` by itself also opens the palette.
- Tau provides `/help`, `/name <name>`, `/stats`, `/compact [instructions]`,
  `/model`, `/settings`, `/abort`, and `/export`.
- The palette also discovers the connected agent's extension commands, prompt
  templates, and skills. Skill commands keep their `/skill:name` spelling.
  They run with command/template expansion enabled; ordinary chat stays literal.
- Unknown commands and invalid arguments report an error without clearing the
  message. Send attachments separately. Agent commands submitted during a
  response use follow-up delivery.
- Terminal-only built-ins are not automatically available in the browser.
  Commands requiring terminal-specific UI still depend on the agent's support.
- Escape closes the palette; arrow keys navigate and Enter selects. Existing
  Compact, Export HTML, Session Stats, and tool expansion actions remain available.

### Model & Thinking
- Model picker with search/filter and keyboard support
- Thinking level toggle (off/low/medium/high)
- Token usage percentage with context window visualiser
- Cost tracking per session

### Voice Input
- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea
- Pulses red while recording

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

Environment variables (set before starting Pi):

| Variable          | Default     | Description                                                                  |
|-------------------|-------------|------------------------------------------------------------------------------|
| `TAU_MIRROR_PORT` | `3001`      | Server port                                                                  |
| `TAU_HOST`        | `0.0.0.0`   | Bind address. Set to `127.0.0.1` to restrict to localhost only               |
| `TAU_STATIC_DIR`  | *(bundled)* | Override static files path                                                   |
| `TAU_DISABLED`    | `0`         | Set to `1` to disable Tau (it stays installed but won't start the server)    |
| `TAU_USER`        | *(none)*    | HTTP Basic Auth username (both `TAU_USER` and `TAU_PASS` required to enable) |
| `TAU_PASS`        | *(none)*    | HTTP Basic Auth password                                                     |
| `PI_CODING_AGENT_DIR` | `~/.omo/agent` | Agent directory used to locate sessions                              |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Override the session store directly          |

Tau lists sessions from every workspace under the session store. Running instances are registered in `~/.omo/tau-instances`.

### New chats and workspaces

Click **New session** in the sidebar, choose a workspace directory, then click
**Create chat**. The path refers to the computer running Tau, even when the
browser is on a phone. Existing workspace paths appear as suggestions. Select
**Create the folder if it does not exist** to start in a new directory.

Each chat runs in an independent RPC process, using the current model and
thinking level. Tau waits for that process to be ready before opening its page.
The original chat remains available in the sidebar; selecting a running chat
opens its owning Tau instance so chat requests and the file browser use the
same workspace.

New chats use their own Tau ports, which must be reachable from the browser.
Their processes stop when the Tau instance that created them stops, including
its child chats. Saved conversations remain in the session store.

### Authentication

Tau supports optional HTTP Basic Auth (browser-native login popup).

**1. Set credentials** — add to `~/.omo/agent/settings.json`:

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Or via environment variables: `TAU_USER=pi TAU_PASS=secret pi`

**2. Toggle on/off** — once credentials are configured, a "Require login" toggle appears in Settings within the Tau web UI. Flip it on to start requiring authentication, off to open it back up. The setting persists across restarts.

Both HTTP and WebSocket connections are gated when enabled. The `/api/health` endpoint remains open for monitoring.

### Start / Stop

Control Tau at runtime without uninstalling:

```
/tau-stop     Stop the mirror server
/tau-start    Start it again
```

To prevent Tau from auto-starting (e.g. in multi-session or dev container workflows):

```bash
TAU_DISABLED=1 pi
```

You can still start it manually with `/tau-start` in that session.

## How it works

Tau is a [Pi extension](https://github.com/badlogic/pi-mono#extensions) that starts an HTTP + WebSocket server inside the Pi process. The extension subscribes to all Pi events and forwards them to connected browser clients. Commands from the browser are executed via the extension API against the same agent session.

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│  Pi TUI     │     │  Pi Process                  │     │  Browser    │
│  (terminal) │◄───►│                              │◄───►│  (Tau)      │
│             │     │  tau extension               │     │             │
└─────────────┘     │    ↳ HTTP + WS on :3001      │     └─────────────┘
                    └──────────────────────────────┘
```

There's no separate server to run. The extension auto-loads when Pi starts and shuts down when Pi exits.

## Development

Clone and point the extension at the local static files:

```bash
git clone https://github.com/deflating/tau.git
cd tau
TAU_STATIC_DIR=$(pwd)/public pi
```

Edit the files in `public/` — refresh the browser to see changes.

## License

MIT
