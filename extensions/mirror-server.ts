/**
 * Mirror Server Extension
 * 
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 * 
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the Tau web UI
 * - Sends full state snapshot on client connect (messages, model, etc.)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as net from "node:net";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";

const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TAU_SETTINGS_PATH = path.join(USER_HOME, ".omo", "agent", "settings.json");

// Load tau settings from ~/.omo/agent/settings.json (falls back to env vars)
function loadTauSettings(): { port: number; host: string; autoStart: boolean; user: string; pass: string; authEnabled?: boolean; projectsDir?: string } {
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(TAU_SETTINGS_PATH, "utf8")).tau || {};
  } catch {}
  return {
    port: parseInt(process.env.TAU_MIRROR_PORT || settings.port || "3001"),
    host: process.env.TAU_HOST || settings.host || "0.0.0.0",
    autoStart: !(
      process.env.TAU_DISABLED === "1" || process.env.TAU_DISABLED === "true" ||
      settings.disabled === true
    ),
    user: process.env.TAU_USER || settings.user || "",
    pass: process.env.TAU_PASS || settings.pass || "",
    authEnabled: settings.authEnabled,
    projectsDir: process.env.TAU_PROJECTS_DIR || settings.projectsDir,
  };
}

const TAU_SETTINGS = loadTauSettings();
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const TAU_AUTO_START = TAU_SETTINGS.autoStart;
const AUTH_USER = TAU_SETTINGS.user;
const AUTH_PASS = TAU_SETTINGS.pass;
const AUTH_CONFIGURED = !!(AUTH_USER && AUTH_PASS);
let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
// @ts-ignore — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

function findPublicDir(): string {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string) => {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    // 1) Common extension-relative paths
    addCandidate(path.resolve(__dirname, "public"));
    addCandidate(path.resolve(__dirname, "../public"));

    // 2) Installed package path (for npm-installed extension execution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-mirror/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}

    // 3) Development fallback from current working directory
    addCandidate(path.resolve(process.cwd(), "public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/tau-mirror/public"));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }

    // Keep previous fallback behavior
    return path.resolve(process.cwd(), "public");
}
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, ".omo", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, "sessions");
const INSTANCES_DIR = path.join(USER_HOME, ".omo", "tau-instances");

type JsonObject = Record<string, unknown>;
type Reply = (message: JsonObject) => void;
type Snapshot = JsonObject & {
  type: "mirror_sync";
  sessionFile: string;
  cwd: string;
  epoch: string;
  seq: number;
  isStreaming: boolean;
};
// These records are mutable process state, not session-owned extension resources.
type LiveSession = {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  kind: "terminal" | "worker";
  snapshot: Snapshot;
  socket: net.Socket | null;
  connected: boolean;
  pending: number;
  idleTimer: NodeJS.Timeout | null;
  child: ChildProcess | null;
  startedAt: string;
};
type ClientSelection = {
  sessionId: string | null;
  pendingSessionId: string | null;
  revision: number;
  alive: boolean;
  buffer: JsonObject[] | null;
};
type GatewayDiscovery = {
  pid: number;
  pipe: string;
  token: string;
  ready: boolean;
};
type TauRuntime = {
  scope: AsyncResource;
  server: http.Server | null;
  wss: WebSocketServer | null;
  ipcServer: net.Server | null;
  peer: net.Socket | null;
  discovery: GatewayDiscovery | null;
  discoveryWatch: fs.FSWatcher | null;
  heartbeat: NodeJS.Timeout | null;
  clients: Set<WebSocket>;
  selections: Map<WebSocket, ClientSelection>;
  sessions: Map<string, LiveSession>;
  openings: Map<string, Promise<LiveSession>>;
  children: Map<string, ChildProcess>;
  starting: Map<string, {
    resolve: (session: LiveSession) => void;
    reject: (error: Error) => void;
    child: ChildProcess;
  }>;
  requests: Map<string, {
    resolve: (message: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    socket: net.Socket;
  }>;
  local: {
    snapshot: () => Snapshot;
    execute: (reply: Reply, command: JsonObject) => Promise<void>;
    shutdown: () => void;
  } | null;
  localSessionId: string | null;
  stopped: boolean;
};

declare global {
  var __tauMirrorRuntime: TauRuntime | undefined;
}

// OMO replaces extension instances on /new, /resume and /reload. The gateway
// belongs to the process, and all long-lived resources inherit this scope.
const runtime: TauRuntime = globalThis.__tauMirrorRuntime ??= {
  scope: new AsyncResource("tau-gateway"),
  server: null, wss: null, ipcServer: null, peer: null, discovery: null,
  discoveryWatch: null, heartbeat: null,
  clients: new Set(), selections: new Map(), sessions: new Map(),
  openings: new Map(), children: new Map(), starting: new Map(),
  requests: new Map(), local: null, localSessionId: null, stopped: false,
};
const DISCOVERY_FILE = path.join(INSTANCES_DIR, "gateway.lock");
const IPC_NAME = createHash("sha256").update(path.resolve(INSTANCES_DIR)).digest("hex").slice(0, 20);
const IPC_PATH = process.platform === "win32"
  ? `\\\\.\\pipe\\tau-${IPC_NAME}` : path.join(INSTANCES_DIR, "gateway.sock");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isObject(error) || error.code !== "ESRCH";
  }
}

function readDiscovery(): GatewayDiscovery | null {
  if (!fs.existsSync(DISCOVERY_FILE)) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
    if (!isObject(value) || typeof value.pid !== "number" ||
        typeof value.pipe !== "string" || typeof value.token !== "string" ||
        typeof value.ready !== "boolean") return null;
    return { pid: value.pid, pipe: value.pipe, token: value.token, ready: value.ready };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null; // The elected owner is still writing its discovery record.
    throw error;
  }
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isObject(value) || typeof value.sessionFile !== "string" ||
      !value.sessionFile || typeof value.cwd !== "string" ||
      typeof value.epoch !== "string" || typeof value.seq !== "number" ||
      typeof value.isStreaming !== "boolean" || !Array.isArray(value.entries)) {
    throw new Error("Invalid session snapshot");
  }
  return {
    ...value, type: "mirror_sync", sessionFile: value.sessionFile,
    cwd: value.cwd, epoch: value.epoch, seq: value.seq, isStreaming: value.isStreaming,
  };
}

function sendFrame(socket: net.Socket, frame: JsonObject) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(frame) + "\n");
}

function receiveFrames(socket: net.Socket, receive: (frame: JsonObject) => void) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    // A local peer may send image-bearing commands and full history snapshots.
    if (buffer.length > 64 * 1024 * 1024) {
      socket.destroy(new Error("Tau IPC frame is too large"));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (!isObject(frame) || typeof frame.type !== "string") throw new Error("Invalid Tau IPC frame");
        receive(frame);
      } catch (error: unknown) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  });
}

// Instance registry — tracks all running Tau servers
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = {
    port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString(),
    ipcPath: runtime.discovery?.pipe,
  };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function unregisterInstance() {
  try { fs.unlinkSync(path.join(INSTANCES_DIR, `${process.pid}.json`)); } catch {}
}

function getRunningInstances(): Array<{ port: number; pid: number; sessionFile: string; cwd: string; startedAt: string; ownerPid?: number }> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: any[] = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
  return instances;
}

/**
 * Kill zombie Tau instances — processes that are alive but orphaned
 * (e.g. tmux pane was killed without session_shutdown firing).
 * A zombie is detected by checking if the process has a controlling terminal.
 * If it doesn't, the HTTP server is the only thing keeping it alive.
 */
function cleanupZombieInstances() {
  if (process.platform === "win32") return;
  if (!fs.existsSync(INSTANCES_DIR)) return;
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Skip our own process
      if (info.pid === process.pid) continue;
      // Check if process is alive
      try {
        process.kill(info.pid, 0);
      } catch {
        // Already dead — clean up
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
        continue;
      }
      // Use shared zombie detection
      if (isZombieProcess(info.pid, info.ownerPid)) {
        console.log(`[Mirror] Killing zombie Tau instance (PID ${info.pid}, port ${info.port})`);
        process.kill(info.pid, "SIGTERM");
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
}

function isZombieProcess(pid: number, ownerPid?: number): boolean {
  if (process.platform === "win32") return false;
  if (ownerPid) {
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return false;
    }
  }
  try {
    const { execSync } = require("node:child_process");
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim();
    return !tty || tty === "??" || tty === "-";
  } catch {
    return true;
  }
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function saveTauSetting(key: string, value: any) {
  try {
    const settings = JSON.parse(fs.readFileSync(TAU_SETTINGS_PATH, "utf8"));
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.writeFileSync(TAU_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch {}
}

function checkBasicAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  return decoded.slice(0, colon) === AUTH_USER && decoded.slice(colon + 1) === AUTH_PASS;
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Tau"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default function (pi: ExtensionAPI) {
  const clients = runtime.clients;
  let latestCtx: ExtensionContext | null = null;
  const epoch = randomUUID();
  let seq = 0;
  let streamingMessage: unknown = null;
  const toolExecutions = new Map<string, JsonObject>();
  const recentMessages: JsonObject[] = [];
  const wakeSources = new Map<string, number>();

  function stopWorkspaceChildren() {
    for (const child of runtime.children.values()) {
      child.stdin?.end();
      const timer = runtime.scope.runInAsyncScope(() => setTimeout(() => child.kill(), 5000));
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }

  function sessionDescriptor(session: LiveSession) {
    const address = runtime.server?.address();
    return {
      sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd,
      pid: session.pid, kind: session.kind,
      status: session.connected ? "ready" : "disconnected",
      isStreaming: session.snapshot.isStreaming,
      epoch: session.snapshot.epoch,
      port: address && typeof address === "object" ? address.port : PORT,
      startedAt: session.startedAt,
    };
  }

  function announceSession(session: LiveSession) {
    const message = { type: "session_status", ...sessionDescriptor(session) };
    for (const client of clients) sendTo(client, message);
  }

  function reevaluateIdle(session: LiveSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (session.kind !== "worker" || !session.child || !session.connected ||
        session.pending || session.snapshot.isStreaming || session.snapshot.hasPendingMessages ||
        session.snapshot.activeWakeSources || session.snapshot.waitingForInput ||
        [...runtime.selections.values()].some(selection =>
          selection.sessionId === session.sessionId || selection.pendingSessionId === session.sessionId)) return;
    session.idleTimer = runtime.scope.runInAsyncScope(() => setTimeout(() => {
      session.idleTimer = null;
      if (!session.pending && !session.snapshot.isStreaming && !session.snapshot.activeWakeSources &&
          ![...runtime.selections.values()].some(selection =>
            selection.sessionId === session.sessionId || selection.pendingSessionId === session.sessionId)) {
        session.child?.stdin?.end();
      }
    }, 30000));
    session.idleTimer.unref();
  }

  function rememberSession(snapshot: Snapshot, pid: number, socket: net.Socket | null, nonce?: string) {
    const key = fileKey(snapshot.sessionFile);
    const previous = runtime.sessions.get(key);
    if (previous && previous.pid !== pid && processAlive(previous.pid)) {
      throw new Error("This session is already running in another OMO process");
    }
    // A terminal can replace its conversation without replacing the gateway.
    for (const [oldKey, old] of runtime.sessions) {
      if (old.pid === pid && oldKey !== key) {
        if (old.idleTimer) clearTimeout(old.idleTimer);
        runtime.sessions.delete(oldKey);
        old.connected = false;
        announceSession(old);
      }
    }
    const session: LiveSession = previous ?? {
      sessionId: randomUUID(), sessionFile: snapshot.sessionFile, cwd: snapshot.cwd,
      pid, kind: nonce ? "worker" : "terminal", snapshot, socket,
      connected: true, pending: 0, idleTimer: null, child: null,
      startedAt: new Date().toISOString(),
    };
    session.snapshot = snapshot;
    session.socket = socket;
    session.connected = true;
    session.pid = pid;
    session.kind = nonce ? "worker" : "terminal";
    session.cwd = snapshot.cwd;
    if (nonce) session.child = runtime.children.get(nonce) ?? null;
    runtime.sessions.set(key, session);
    announceSession(session);
    reevaluateIdle(session);
    return session;
  }

  function requestSession(session: LiveSession, command: JsonObject): Promise<JsonObject> {
    if (!session.connected) return Promise.reject(new Error("This session is temporarily unavailable"));
    session.pending++;
    const response = session.socket
      ? new Promise<JsonObject>((resolve, reject) => {
        const socket = session.socket;
        if (!socket) { reject(new Error("Session disconnected")); return; }
        const requestId = randomUUID();
        const timer = runtime.scope.runInAsyncScope(() => setTimeout(() => {
          runtime.requests.delete(requestId);
          reject(new Error("Session command timed out"));
        }, 30000));
        runtime.requests.set(requestId, { resolve, reject, timer, socket });
        sendFrame(socket, { type: "command", requestId, command });
      })
      : new Promise<JsonObject>((resolve, reject) => {
        const local = runtime.local;
        if (!local) { reject(new Error("Original session is being replaced")); return; }
        local.execute(resolve, command).catch(reject);
      });
    return response.then(message => ({ ...message, sessionId: session.sessionId })).finally(() => {
      session.pending--;
      reevaluateIdle(session);
    });
  }

  async function routeCommand(command: JsonObject) {
    if (command.type === "get_auth" || command.type === "set_auth") {
      return new Promise<JsonObject>((resolve, reject) => {
        if (!runtime.local) { reject(new Error("Gateway session is unavailable")); return; }
        runtime.local.execute(resolve, command).catch(reject);
      });
    }
    if (typeof command.sessionId !== "string") throw new Error("Select a session before sending commands");
    const session = [...runtime.sessions.values()].find(value => value.sessionId === command.sessionId);
    if (!session) throw new Error("Session is no longer available");
    return requestSession(session, command);
  }

  function publishSession(session: LiveSession, message: JsonObject) {
    const scoped = { ...message, sessionId: session.sessionId };
    for (const client of clients) {
      const selection = runtime.selections.get(client);
      if (selection?.pendingSessionId === session.sessionId && selection.buffer) selection.buffer.push(scoped);
      else if (selection?.sessionId === session.sessionId) sendTo(client, scoped);
    }
  }

  function registerLocal() {
    if (!runtime.local) return;
    const snapshot = runtime.local.snapshot();
    if (runtime.peer) {
      sendFrame(runtime.peer, {
        type: "register", token: runtime.discovery?.token,
        pid: process.pid, nonce: process.env.TAU_WORKER_NONCE, snapshot,
      });
    } else if (runtime.server) {
      const session = rememberSession(snapshot, process.pid, null);
      runtime.localSessionId = session.sessionId;
      updateInstanceSession(snapshot.sessionFile);
    }
  }

  function acceptPeer(socket: net.Socket) {
    let session: LiveSession | null = null;
    const authenticated = runtime.scope.runInAsyncScope(() => setTimeout(() => socket.destroy(), 10000));
    receiveFrames(socket, frame => {
      if (frame.type === "register") {
        if (!runtime.discovery || frame.token !== runtime.discovery.token ||
            typeof frame.pid !== "number") throw new Error("Invalid local session registration");
        clearTimeout(authenticated);
        const nonce = typeof frame.nonce === "string" ? frame.nonce : undefined;
        session = rememberSession(parseSnapshot(frame.snapshot), frame.pid, socket, nonce);
        sendFrame(socket, { type: "registered", sessionId: session.sessionId });
        if (nonce) {
          runtime.starting.get(nonce)?.resolve(session);
          runtime.starting.delete(nonce);
        }
        return;
      }
      if (!session) throw new Error("Register the session first");
      if (frame.type === "response" && typeof frame.requestId === "string" && isObject(frame.message)) {
        const pending = runtime.requests.get(frame.requestId);
        if (pending?.socket === socket) {
          clearTimeout(pending.timer);
          runtime.requests.delete(frame.requestId);
          if (frame.message.type === "mirror_sync") session.snapshot = parseSnapshot(frame.message);
          pending.resolve(frame.message);
        }
      } else if (frame.type === "publish" && isObject(frame.message)) {
        if (isObject(frame.status) && typeof frame.status.isStreaming === "boolean") {
          session.snapshot = { ...session.snapshot, ...frame.status, isStreaming: frame.status.isStreaming };
        }
        publishSession(session, frame.message);
        announceSession(session);
        reevaluateIdle(session);
      } else if (frame.type === "unregister") {
        session.connected = false;
        announceSession(session);
      }
    });
    socket.on("error", error => console.error("[Tau IPC]", error.message));
    socket.on("close", () => {
      clearTimeout(authenticated);
      if (session?.socket === socket) {
        session.connected = false;
        announceSession(session);
      }
      for (const [id, pending] of runtime.requests) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer);
        runtime.requests.delete(id);
        pending.reject(new Error("Session connection closed"));
      }
    });
  }

  function connectPeer(discovery: GatewayDiscovery) {
    if (runtime.peer && !runtime.peer.destroyed) { registerLocal(); return; }
    runtime.discovery = discovery;
    runtime.peer = runtime.scope.runInAsyncScope(() => net.createConnection(discovery.pipe));
    const socket = runtime.peer;
    socket.on("connect", registerLocal);
    receiveFrames(socket, frame => {
      if (frame.type === "registered" && typeof frame.sessionId === "string") {
        runtime.localSessionId = frame.sessionId;
        console.log(`[Mirror] Session registered with Tau gateway (PID ${discovery.pid}); no new server started.`);
      } else if (frame.type === "command" && typeof frame.requestId === "string" && isObject(frame.command)) {
        const requestId = frame.requestId;
        if (!runtime.local) throw new Error("Session is being replaced");
        void runtime.local.execute(message => sendFrame(socket, { type: "response", requestId, message }), frame.command)
          .catch(error => sendFrame(socket, {
            type: "response", requestId,
            message: { type: "response", id: frame.command && isObject(frame.command) ? frame.command.id : undefined,
              success: false, error: error instanceof Error ? error.message : String(error) },
          }));
      }
    });
    socket.on("error", error => console.error("[Tau IPC] Gateway connection:", error.message));
    socket.on("close", () => {
      if (runtime.peer === socket) runtime.peer = null;
      runtime.localSessionId = null;
      // An owned worker without its gateway must not become an orphan server.
      if (process.env.TAU_WORKER_NONCE) runtime.local?.shutdown();
    });
  }

  function createWorkspaceSession(cwd: string, sessionFile?: string): Promise<LiveSession> {
    const discovery = runtime.discovery;
    if (!runtime.server || !discovery) return Promise.reject(new Error("Tau gateway is not ready"));
    const entrypoint = process.argv[1];
    const args = entrypoint && /\.(?:[cm]?js|ts)$/.test(entrypoint) && fs.existsSync(entrypoint)
      ? [entrypoint] : [];
    args.push("--mode", "rpc");
    const sessionDir = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    args.push("--session-dir", path.join(SESSIONS_DIR, sessionDir));
    if (sessionFile) args.push("--session", sessionFile);
    if (process.argv.includes("--no-extensions") || process.argv.includes("-ne")) {
      args.push("--no-extensions");
    }
    const extensions = new Set([path.join(__dirname, "mirror-server.ts")]);
    for (let index = 1; index < process.argv.length; index++) {
      if (process.argv[index] === "--extension" || process.argv[index] === "-e") {
        const extension = process.argv[++index];
        if (extension) extensions.add(extension.startsWith("builtin:") ? extension : path.resolve(extension));
      }
    }
    for (const extension of extensions) args.push("--extension", extension);
    const defaults = runtime.local?.snapshot();
    if (!sessionFile && isObject(defaults?.model) &&
        typeof defaults.model.provider === "string" && typeof defaults.model.id === "string") {
      args.push("--provider", defaults.model.provider, "--model", defaults.model.id);
    }
    if (!sessionFile && typeof defaults?.thinkingLevel === "string") args.push("--thinking", defaults.thinkingLevel);
    const nonce = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TAU_DISABLED: "0",
      TAU_GATEWAY_PIPE: discovery.pipe,
      TAU_GATEWAY_TOKEN: discovery.token,
      TAU_GATEWAY_PID: String(process.pid),
      TAU_WORKER_NONCE: nonce,
    };
    delete env.PI_SUBAGENT_CHILD;
    delete env.TAU_WORKSPACE_CHILD;
    const child = runtime.scope.runInAsyncScope(() => spawn(process.execPath, args, {
      cwd, env, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    runtime.children.set(nonce, child);
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-2000);
    });
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        runtime.starting.delete(nonce);
        child.removeListener("error", onError);
      };
      const fail = (message: string) => {
        finish();
        const error = new Error(message);
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(error);
          return;
        }
        child.once("exit", () => reject(error));
        child.kill();
      };
      const onError = (error: Error) => fail(error.message);
      runtime.starting.set(nonce, { child, reject: error => fail(error.message), resolve: session => {
        finish();
        resolve(session);
      } });
      child.once("exit", (code: number | null) => {
        const startup = runtime.starting.get(nonce);
        if (startup) fail(`Chat process exited (${code}): ${diagnostics || "No startup diagnostics"}`);
        runtime.children.delete(nonce);
        for (const [key, session] of runtime.sessions) {
          if (session.child !== child) continue;
          if (session.idleTimer) clearTimeout(session.idleTimer);
          session.connected = false;
          announceSession(session);
          runtime.sessions.delete(key);
        }
      });
      const timer = runtime.scope.runInAsyncScope(() => setTimeout(() => fail(`Chat startup timed out. ${diagnostics}`), 30000));
      child.stdout?.resume(); // Native RPC events are not a second source of Tau events.
      child.once("error", onError);
    });
  }

  async function openSession(file: string): Promise<LiveSession> {
    if (!path.isAbsolute(file)) throw new Error("Choose an absolute session path");
    const resolved = fs.realpathSync(file);
    const root = fs.realpathSync(SESSIONS_DIR);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(".." + path.sep) || relative === ".." ||
        path.isAbsolute(relative) || path.extname(resolved) !== ".jsonl" || !fs.statSync(resolved).isFile()) {
      throw new Error("Choose a session from the session history");
    }
    const key = fileKey(resolved);
    const active = runtime.sessions.get(key);
    if (active?.connected) return active;
    if (active && processAlive(active.pid)) throw new Error("This session is running but its connection is unavailable");
    const opening = runtime.openings.get(key);
    if (opening) return opening;
    const descriptor = fs.openSync(resolved, "r");
    let cwd: string;
    try {
      const buffer = Buffer.alloc(65536);
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const header: unknown = JSON.parse(buffer.toString("utf8", 0, length).split("\n")[0]);
      if (!isObject(header) || header.type !== "session" || typeof header.cwd !== "string" ||
          !path.isAbsolute(header.cwd) || !fs.statSync(header.cwd).isDirectory()) {
        throw new Error("Session workspace is unavailable");
      }
      cwd = fs.realpathSync(header.cwd);
    } finally {
      fs.closeSync(descriptor);
    }
    const promise = createWorkspaceSession(cwd, resolved);
    runtime.openings.set(key, promise);
    try { return await promise; }
    finally { runtime.openings.delete(key); }
  }

  // Pending RPC-style requests from browser (id -> resolver)
  const pendingRequests = new Map<string, (response: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket | Reply, data: JsonObject) {
    if (typeof ws === "function") ws(data);
    else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: JsonObject) {
    if (!runtime.local) return;
    seq++;
    const status = {
      isStreaming: latestCtx ? !latestCtx.isIdle() : false,
      hasPendingMessages: latestCtx ? !latestCtx.isIdle() : false,
      activeWakeSources: [...wakeSources.values()].some(count => count > 0),
    };
    const message = { ...data, epoch, seq };
    if (runtime.peer) {
      sendFrame(runtime.peer, { type: "publish", status, message });
      return;
    }
    const file = latestCtx?.sessionManager.getSessionFile();
    const session = file ? runtime.sessions.get(fileKey(file)) : undefined;
    if (!session) return;
    session.snapshot = { ...session.snapshot, ...status, epoch, seq };
    publishSession(session, message);
    announceSession(session);
    reevaluateIdle(session);
  }

  async function selectClient(ws: WebSocket, command: JsonObject) {
    const selection = runtime.selections.get(ws);
    if (!selection) return;
    const revision = ++selection.revision;
    const previous = selection.sessionId;
    try {
      if (typeof command.sessionFile !== "string") throw new Error("Choose a session file");
      const session = await openSession(command.sessionFile);
      if (revision !== selection.revision || ws.readyState !== WebSocket.OPEN) {
        reevaluateIdle(session);
        return;
      }
      selection.pendingSessionId = session.sessionId;
      selection.buffer = [];
      const snapshot = parseSnapshot(await requestSession(session, { type: "mirror_sync_request" }));
      if (revision !== selection.revision || ws.readyState !== WebSocket.OPEN) {
        reevaluateIdle(session);
        return;
      }
      selection.sessionId = session.sessionId;
      selection.pendingSessionId = null;
      sendTo(ws, { ...snapshot, id: command.id, sessionId: session.sessionId });
      const buffered = selection.buffer;
      selection.buffer = null;
      for (const message of buffered ?? []) {
        if (message.epoch === snapshot.epoch && typeof message.seq === "number" && message.seq > snapshot.seq) sendTo(ws, message);
      }
      if (previous) {
        const old = [...runtime.sessions.values()].find(value => value.sessionId === previous);
        if (old) reevaluateIdle(old);
      }
      reevaluateIdle(session);
    } catch (error: unknown) {
      if (revision !== selection.revision) return;
      selection.pendingSessionId = null;
      selection.buffer = null;
      sendTo(ws, {
        type: "response", command: "select_session", id: command.id, success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let mirrorUrl = "";
  let tailscaleUrl = "";

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    runtime.stopped = true;
    stopWorkspaceChildren();
    if (runtime.heartbeat) {
      clearInterval(runtime.heartbeat);
      runtime.heartbeat = null;
    }
    runtime.discoveryWatch?.close();
    runtime.discoveryWatch = null;
    if (runtime.wss) {
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      runtime.selections.clear();
      runtime.wss.close();
      runtime.wss = null;
    }
    if (runtime.server) {
      runtime.server.close();
      runtime.server = null;
    }
    if (runtime.ipcServer) {
      for (const session of runtime.sessions.values()) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.socket?.end();
      }
      runtime.ipcServer.close();
      runtime.ipcServer = null;
    }
    if (runtime.discovery?.pid === process.pid) {
      if (readDiscovery()?.pid === process.pid) fs.unlinkSync(DISCOVERY_FILE);
      if (process.platform !== "win32" && fs.existsSync(IPC_PATH)) fs.unlinkSync(IPC_PATH);
    }
    runtime.peer?.end();
    runtime.peer = null;
    runtime.sessions.clear();
    unregisterInstance();
    mirrorUrl = "";
    tailscaleUrl = "";
  }

  // ═══════════════════════════════════════
  // /tau-stop and /tau-start commands
  // ═══════════════════════════════════════
  pi.registerCommand("taustop", {
    description: "Stop the Tau mirror server",
    handler: async (_args, ctx) => {
      if (!runtime.server && !runtime.peer) {
        ctx.ui.notify("Tau is not running", "warning");
        return;
      }
      stopServer();
      ctx.ui.setStatus("mirror", "");
      ctx.ui.notify("Tau mirror server stopped", "info");
      console.log("[Mirror] Server stopped via /taustop");
    },
  });

  pi.registerCommand("taustart", {
    description: "Start the Tau mirror server",
    handler: async (_args, ctx) => {
      if (runtime.server || runtime.peer) {
        ctx.ui.notify(`Tau is already running at ${mirrorUrl}`, "warning");
        return;
      }
      if (startServer(ctx)) {
        ctx.ui.notify("Tau mirror server starting...", "info");
      }
    },
  });

  // ═══════════════════════════════════════
  // /qr command — show QR code to connect
  // ═══════════════════════════════════════
  pi.registerCommand("tau", {
    description: "Open Tau web UI in browser",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const { exec } = require("node:child_process");
      exec(`open "${mirrorUrl}"`);
      ctx.ui.notify(`Opened ${mirrorUrl}`, "info");
    },
  });

  pi.registerCommand("qr", {
    description: "Show QR code for Tau mirror URL",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const qrPageUrl = `${mirrorUrl}/api/qr`;
      ctx.ui.notify(`Tau: ${mirrorUrl}  •  QR: ${qrPageUrl}`, "info");
      // Open in default browser
      const { exec } = require("node:child_process");
      exec(`open "${qrPageUrl}"`);
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "auto_compaction_start", "auto_compaction_end",
    "auto_retry_start", "auto_retry_end",
    "model_select", "agent_settled",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      latestCtx = ctx;
      if (eventType === "message_start" && event.message?.role === "assistant") {
        streamingMessage = event.message;
      } else if (eventType === "message_update") {
        streamingMessage = event.message;
      } else if (eventType === "message_end") {
        if (isObject(event.message)) recentMessages.push(event.message);
        if (event.message?.role === "assistant") streamingMessage = null;
      } else if (eventType === "tool_execution_start") {
        toolExecutions.set(event.toolCallId, {
          toolCallId: event.toolCallId, toolName: event.toolName, args: event.args,
          status: "pending", output: "", isError: false,
        });
      } else if (eventType === "tool_execution_update") {
        const tool = toolExecutions.get(event.toolCallId);
        if (tool) {
          tool.status = "streaming";
          tool.output = event.partialResult;
        }
      } else if (eventType === "tool_execution_end") {
        const tool = toolExecutions.get(event.toolCallId);
        if (tool) {
          tool.status = event.isError ? "error" : "complete";
          tool.output = event.result;
          tool.isError = !!event.isError;
        }
      } else if (eventType === "agent_start") {
        toolExecutions.clear();
      }

      // Forward event to all connected browser clients
      // Wrap in { type: "event", event: ... } to match the existing frontend protocol
      broadcast({ type: "event", event: { type: eventType, ...event } });
    });
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    if (runtime.server) updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  const onWakeSources = (value: unknown) => {
    if (!isObject(value) || typeof value.source !== "string" || typeof value.activeCount !== "number") return;
    wakeSources.set(value.source, value.activeCount);
    broadcast({ type: "event", event: { type: "wake_source_state", ...value } });
  };
  const unsubscribeWakeSources = pi.events.on("wake_source_state", onWakeSources);

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: any) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    const sessionName = pi.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      pi.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find(m => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = title.substring(0, spaceIdx > 20 ? spaceIdx : 57) + "…";
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  function buildStateSnapshot(ctx: ExtensionContext): Snapshot {
    // Get session entries for message history
    const entries: unknown[] = [...ctx.sessionManager.getEntries()];
    for (let index = recentMessages.length - 1; index >= 0; index--) {
      const message = recentMessages[index];
      if (entries.some(entry => isObject(entry) && isObject(entry.message) &&
          entry.message.timestamp === message.timestamp && entry.message.role === message.role)) {
        recentMessages.splice(index, 1);
      }
    }
    for (const message of recentMessages) entries.push({ type: "message", message });

    // Get model info
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile() || "";

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      epoch, seq,
      cwd: ctx.cwd,
      entries,
      model,
      thinkingLevel,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
      streamingMessage,
      toolExecutions: [...toolExecutions.values()],
      pendingDialogs: [],
      activeWakeSources: [...wakeSources.values()].some(count => count > 0),
      hasPendingMessages: !ctx.isIdle(),
      startedAt: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket | Reply, command: any) {
    const id = command.id;
    const ctx = latestCtx;

    const success = (cmd: string, data?: any) => {
      const resp: any = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    try {
      switch (command.type) {
        // ─── Prompting ───
        case "prompt": {
          if (ctx && !ctx.isIdle()) {
            const behavior = command.streamingBehavior || "steer";
            if (behavior === "steer") {
              pi.sendUserMessage(command.message, { deliverAs: "steer" });
            } else {
              pi.sendUserMessage(command.message, { deliverAs: "followUp" });
            }
          } else {
            // Build content with optional images
            if (command.images?.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              const content: any[] = [{ type: "text", text: command.message || "(see attached image)" }];
              for (const img of command.images) {
                if (!img.data || typeof img.data !== "string") {
                  console.error("[mirror-server] Skipping image: missing or invalid data");
                  continue;
                }
                // Strip data URL prefix if accidentally included
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                console.log(`[mirror-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`);
                const imageBlock = {
                  type: "image" as const,
                  data: data,
                  mimeType: mimeType,
                };
                // Defensive: verify mimeType is actually set (debug crash where it was missing)
                if (!imageBlock.mimeType) {
                  console.error(`[mirror-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`);
                  imageBlock.mimeType = "image/png";
                }
                content.push(imageBlock);
              }
              // Only send content array if we actually have images, otherwise just text
              const hasImages = content.some((c: any) => c.type === "image");
              if (hasImages) {
                pi.sendUserMessage(content);
              } else {
                pi.sendUserMessage(command.message);
              }
            } else {
              pi.sendUserMessage(command.message);
            }
          }
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          pi.sendUserMessage(command.message, { deliverAs: "steer" });
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          pi.sendUserMessage(command.message, { deliverAs: "followUp" });
          sendTo(ws, success("follow_up"));
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: pi.getThinkingLevel(),
            isStreaming: !ctx.isIdle(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: pi.getSessionName(),
            autoCompactionEnabled: true, // Extension can't easily check this
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          sendTo(ws, success("get_available_models", { models }));
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          const model = models.find(
            (m: any) => m.provider === command.provider && m.id === command.modelId
          );
          if (!model) {
            sendTo(ws, error("set_model", `Model not found: ${command.provider}/${command.modelId}`));
            break;
          }
          const ok = await pi.setModel(model);
          if (!ok) {
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }
          sendTo(ws, success("set_model", model));
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: any) => m.provider === currentModel.provider && m.id === currentModel.id
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          await pi.setModel(nextModel);
          sendTo(ws, success("cycle_model", {
            model: nextModel,
            thinkingLevel: pi.getThinkingLevel(),
          }));
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          const levels = ["off", "minimal", "low", "medium", "high"];
          const current = pi.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          pi.setThinkingLevel(next as any);
          const actual = pi.getThinkingLevel();
          sendTo(ws, success("cycle_thinking_level", { level: actual }));
          break;
        }

        case "set_thinking_level": {
          pi.setThinkingLevel(command.level);
          sendTo(ws, success("set_thinking_level"));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0, assistantMessages = 0, toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(ws, success("get_session_stats", {
            sessionFile: ctx.sessionManager.getSessionFile(),
            userMessages,
            assistantMessages,
            toolCalls,
            totalMessages: entries.length,
            tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
          }));
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          pi.setSessionName(name);
          sendTo(ws, success("set_session_name"));
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: any) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: any) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${err.message}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const { execSync } = require("node:child_process");
            const args = command.outputPath
              ? `"${sessionFile}" "${command.outputPath}"`
              : `"${sessionFile}"`;
            const output = execSync(`pi --export ${args}`, { cwd: process.cwd(), timeout: 30000, encoding: "utf-8" });
            // pi prints the output path
            const result = output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Commands & Files ───
        case "get_commands": {
          sendTo(ws, success("get_commands", { commands: pi.getCommands() }));
          break;
        }

        case "run_slash_command": {
          if (!ctx) {
            sendTo(ws, error("run_slash_command", "No context available"));
            break;
          }
          const text = typeof command.message === "string" ? command.message.trim() : "";
          const match = /^\/([^\s]+)(?:\s|$)/.exec(text);
          if (!match || !pi.getCommands().some((entry) => entry.name === match[1])) {
            sendTo(ws, error("run_slash_command", "Unknown command. Open Commands to see available commands."));
            break;
          }
          if (command.images?.length) {
            sendTo(ws, error("run_slash_command", "Send attachments separately from commands."));
            break;
          }
          pi.sendUserMessage(text, {
            expandPromptTemplates: true,
            ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
          });
          sendTo(ws, success("run_slash_command"));
          break;
        }

        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: AUTH_CONFIGURED, enabled: authEnabled }));
          break;
        }

        case "set_auth": {
          if (!AUTH_CONFIGURED) {
            sendTo(ws, error("set_auth", "No credentials configured. Set tau.user and tau.pass in ~/.omo/agent/settings.json"));
            break;
          }
          authEnabled = !!command.enabled;
          saveTauSetting("authEnabled", authEnabled);
          broadcast({ type: "event", event: { type: "auth_changed", enabled: authEnabled } });
          sendTo(ws, success("set_auth", { enabled: authEnabled }));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: any) {
      sendTo(ws, error(command.type || "unknown", e.message || String(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = (req.url || "/").split("?")[0];

    // Auth gate — exempt /api/health for monitoring
    if (authEnabled && urlPath !== "/api/health" && !checkBasicAuth(req)) {
      sendAuthRequired(res);
      return;
    }

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/qr") {
      if (!mirrorUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not ready" }));
        return;
      }
      const qrPromises = [QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 })];
      if (tailscaleUrl) qrPromises.push(QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }));
      Promise.all(qrPromises).then((dataUrls: string[]) => {
        const tsSection = tailscaleUrl && dataUrls[1]
          ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${dataUrls[1]}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}
img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style>
</head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${dataUrls[0]}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
      }).catch((e: any) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "mirror", mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform }));
      return;
    }

    if (urlPath === "/api/workspace" && req.method === "GET") {
      const sessionId = new URL(req.url || "/", "http://localhost").searchParams.get("sessionId");
      const session = [...runtime.sessions.values()].find(value => value.sessionId === sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        cwd: session?.cwd || runtime.local?.snapshot().cwd || process.cwd(),
        sessionFile: session?.sessionFile || runtime.local?.snapshot().sessionFile,
      }));
      return;
    }

    if (urlPath === "/api/sessions/new" && req.method === "POST") {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== `https://${req.headers.host}`) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Create chats from the Tau page on this server" }));
        return;
      }
      let body = "";
      let tooLarge = false;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > 16384) {
          tooLarge = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request is too large" }));
        }
      });
      req.on("end", async () => {
        if (tooLarge) return;
        let cwd: string;
        try {
          const input: unknown = JSON.parse(body);
          if (!input || typeof input !== "object" ||
              !("directory" in input) || typeof input.directory !== "string" ||
              !input.directory.trim() ||
              ("createDirectory" in input && typeof input.createDirectory !== "boolean")) {
            throw new Error("Choose a workspace directory");
          }
          const directory = input.directory.trim();
          const expanded = directory === "~" ? USER_HOME
            : /^~[/\\]/.test(directory) ? path.join(USER_HOME, directory.slice(2)) : directory;
          if (!path.isAbsolute(expanded)) throw new Error("Enter an absolute directory path");
          if ("createDirectory" in input && input.createDirectory === true) {
            fs.mkdirSync(expanded, { recursive: true });
          }
          if (!fs.statSync(expanded).isDirectory()) throw new Error("Path is not a directory");
          cwd = fs.realpathSync(expanded);
        } catch (error: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid workspace" }));
          return;
        }
        try {
          const session = await createWorkspaceSession(cwd);
          if (res.destroyed) {
            session.child?.stdin?.end();
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd,
          }));
        } catch (error: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not start chat" }));
        }
      });
      return;
    }

    // File preview — serve image bytes for thumbnail display in the browser
    if ((urlPath === "/api/file/preview" || urlPath.startsWith("/api/file/preview?")) && req.method === "GET") {
      const previewUrl = new URL(`http://localhost${req.url}`);
      const filePath = previewUrl.searchParams.get("path");
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const IMAGE_PREVIEW_MIMES: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
      };
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeType = IMAGE_PREVIEW_MIMES[ext];
      if (!mimeType) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a previewable image" }));
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Not a file");
        res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "max-age=60" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        instances: getRunningInstances(),
        sessions: [...runtime.sessions.values()].map(sessionDescriptor),
      }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/projects/launch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { path: projectPath } = JSON.parse(body);
          if (!projectPath || typeof projectPath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          // Resolve ~ in path
          const resolved = projectPath.startsWith("~")
            ? path.join(process.env.HOME || "", projectPath.slice(1))
            : projectPath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }
          const { execSync } = require("node:child_process");
          const escaped = resolved.replace(/'/g, "'\\''");
          execSync(`osascript -e 'tell app "iTerm2" to create window with default profile command "cd '"'"'${escaped}'"'"' && pi"'`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const sessionId = filesUrl.searchParams.get("sessionId");
        const selected = [...runtime.sessions.values()].find(value => value.sessionId === sessionId);
        const workspace = selected?.cwd || runtime.local?.snapshot().cwd || process.cwd();
        const explicitPath = filesUrl.searchParams.get("path");
        const directoriesOnly = filesUrl.searchParams.get("directories") === "1";
        let prefix = "";
        let dirPath = explicitPath || workspace;
        if (directoriesOnly) {
          const typed = explicitPath?.trim() || workspace;
          const expanded = typed === "~" ? USER_HOME
            : /^~[/\\]/.test(typed) ? path.join(USER_HOME, typed.slice(2)) : typed;
          dirPath = path.resolve(workspace, /^[A-Za-z]:$/.test(expanded) ? expanded + path.sep : expanded);
          if (!/[/\\]$/.test(typed) && (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory())) {
            prefix = path.basename(dirPath);
            dirPath = path.dirname(dirPath);
          }
        }
        serveFileList(res, dirPath, directoriesOnly, prefix);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // File browser: open file natively
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          if (process.platform === "win32") {
            const { exec } = await import("node:child_process");
            const safe = fp.replace(/'/g, "''").replace(/"/g, '');
            exec(`powershell -NoProfile -WindowStyle Hidden -Command "& { $wsh = New-Object -ComObject WScript.Shell; $wsh.Run('explorer \\"${safe}\\"', 1, $false) }"`, (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else if (process.platform === "darwin") {
            execFile("open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else {
            execFile("xdg-open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      serveSessionFile(res, sessionMatch[1], sessionMatch[2]);
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const command: unknown = JSON.parse(body);
          if (!isObject(command) || typeof command.type !== "string") throw new Error("Invalid session command");
          const response = await routeCommand(command);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== `https://${req.headers.host}`) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Open sessions from the Tau page on this server" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const input: unknown = JSON.parse(body);
          if (!isObject(input) || typeof input.sessionFile !== "string") throw new Error("Choose a session file");
          const session = await openSession(input.sessionFile);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd }));
        } catch (error: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    // Session delete
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          fs.unlinkSync(filePath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    try {
      const { execSync } = require("node:child_process");
      // Get tmux pane PIDs
      const paneOutput = execSync("tmux list-panes -a -F '#{pane_pid}' 2>/dev/null", { encoding: "utf8" });
      const tmuxFiles = new Set<string>();

      for (const shellPid of paneOutput.trim().split("\n").filter(Boolean)) {
        try {
          // Find Pi (node) processes that are children of tmux shells
          const children = execSync(`pgrep -P ${shellPid} 2>/dev/null`, { encoding: "utf8" });
          for (const pid of children.trim().split("\n").filter(Boolean)) {
            // Check what .jsonl files this process has open
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep '\\.jsonl'`, { encoding: "utf8" });
            for (const line of lsofOut.trim().split("\n").filter(Boolean)) {
              const match = line.match(/\/.+\.jsonl$/);
              if (match) tmuxFiles.add(match[0]);
            }
          }
        } catch { /* no match */ }
      }
      return tmuxFiles;
    } catch {
      return new Set();
    }
  }

  function serveProjectsList(res: http.ServerResponse) {
    const projectsDir = TAU_SETTINGS.projectsDir;
    if (!projectsDir) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }

    const resolved = projectsDir.startsWith("~")
      ? path.join(process.env.HOME || "", projectsDir.slice(1))
      : projectsDir;

    if (!fs.existsSync(resolved)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [], error: "Directory not found" }));
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const instances = getRunningInstances();

      // Build session count + recency map from session history
      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
          // Check if this session dir maps to a subdirectory of the projects folder
          if (!decodedPath.startsWith(resolved + "/") && !decodedPath.startsWith(resolved)) continue;

          const sessionDir = path.join(SESSIONS_DIR, dir.name);
          const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          let lastMtime = 0;
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(sessionDir, f));
              if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
            } catch {}
          }
          sessionInfo.set(decodedPath, { count: files.length, lastActive: lastMtime });
        }
      }

      const projects = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
          const isActive = instances.some(i => i.cwd === fullPath);
          return {
            name: e.name,
            path: fullPath,
            sessionCount: info.count,
            lastActive: info.lastActive || null,
            active: isActive,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      const live = [...runtime.sessions.values()].map(sessionDescriptor).filter(instance => instance.sessionFile &&
        path.dirname(path.dirname(instance.sessionFile)) === path.resolve(SESSIONS_DIR));
      const tmuxFiles = getTmuxSessionFiles();
      const readline = await import("node:readline");
      const dirEntries = fs.existsSync(SESSIONS_DIR)
        ? fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) : [];
      const projects: any[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");

        const sessions: any[] = [];

        for (const file of files) {
          try {
            const filePath = path.join(projectDir, file);
            const parsed = await parseSessionFile(filePath, readline, live.some(instance => instance.sessionFile === filePath));
            if (parsed) {
              const stat = fs.statSync(filePath);
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...parsed, file, filePath, mtime: stat.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          projects.push({ path: sessions[0].cwd || decodedPath, dirName: dir.name, sessions });
        }
      }

      for (const instance of live) {
        const dirName = path.basename(path.dirname(instance.sessionFile));
        let project = projects.find(project => project.dirName === dirName);
        if (!project) {
          project = { path: instance.cwd, dirName, sessions: [] };
          projects.push(project);
        }
        if (project.sessions.some((session: { filePath: string }) => session.filePath === instance.sessionFile)) continue;
        project.sessions.unshift({
          file: path.basename(instance.sessionFile), filePath: instance.sessionFile,
          cwd: instance.cwd, name: "New chat", timestamp: instance.startedAt,
          mtime: Date.parse(instance.startedAt),
        });
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.mtime || 0;
        const bTime = b.sessions[0]?.mtime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    const filePath = path.join(SESSIONS_DIR, dirName, file);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try { entries.push(JSON.parse(buffer)); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: any, includeEmpty = false) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: any = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: any) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch { /* skip */ }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    if (!includeEmpty && userMessageCount <= 1 && lineCount <= 8) return null; // pipe mode

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
    ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
    "venv", ".venv", "env", ".env.local",
    ".omo", "coverage", ".nyc_output", ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string, directoriesOnly = false, prefix = "") {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (!directoriesOnly && entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (!directoriesOnly && IGNORED_NAMES.has(entry.name)) continue;
        if (directoriesOnly) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
          const match = process.platform === "win32" ? prefix.toLowerCase() : prefix;
          if (!name.startsWith(match)) continue;
        }

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);
          if (directoriesOnly && !stat.isDirectory()) continue;

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: directoriesOnly || entry.isDirectory(),
            size: directoriesOnly || entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip inaccessible */ }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, parentPath: path.dirname(dirPath), items }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text && text.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch { /* skip line */ }
            }

            rl.close();
            stream.destroy();

            if (matches.length > 0) {
              results.push({
                filePath,
                project: decodedPath,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch { /* skip file */ }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer(ctx: ExtensionContext) {
    runtime.stopped = false;
    if (runtime.server || runtime.peer) {
      registerLocal();
      return false;
    }
    const workerPipe = process.env.TAU_GATEWAY_PIPE;
    const workerToken = process.env.TAU_GATEWAY_TOKEN;
    if (workerPipe && workerToken) {
      connectPeer({ pid: Number(process.env.TAU_GATEWAY_PID), pipe: workerPipe, token: workerToken, ready: true });
      return false;
    }
    const discovery = readDiscovery();
    if (discovery && processAlive(discovery.pid)) {
      if (discovery.ready) connectPeer(discovery);
      else waitForGateway();
      return false;
    }
    if (discovery && fs.existsSync(DISCOVERY_FILE)) fs.unlinkSync(DISCOVERY_FILE);
    // A server from before the gateway upgrade still owns its port.
    const existing = getRunningInstances().find(instance => instance.pid !== process.pid);
    if (existing) {
      console.log(`[Mirror] Tau already running on port ${existing.port} (PID ${existing.pid}), skipping startup.`);
      ctx.ui.notify(`Tau already running on port ${existing.port}; no new server started.`, "info");
      return false;
    }
    fs.mkdirSync(INSTANCES_DIR, { recursive: true, mode: 0o700 });
    let lock: number;
    try {
      lock = fs.openSync(DISCOVERY_FILE, "wx", 0o600);
    } catch (error: unknown) {
      if (isObject(error) && error.code === "EEXIST") {
        waitForGateway();
        return false;
      }
      throw error;
    }
    const elected: GatewayDiscovery = { pid: process.pid, pipe: IPC_PATH, token: randomUUID(), ready: false };
    runtime.discovery = elected;
    try { fs.writeFileSync(lock, JSON.stringify(elected)); }
    finally { fs.closeSync(lock); }
    if (process.platform !== "win32" && fs.existsSync(IPC_PATH)) fs.unlinkSync(IPC_PATH);
    runtime.ipcServer = runtime.scope.runInAsyncScope(() => net.createServer(acceptPeer));
    runtime.ipcServer.on("error", error => {
      console.error("[Tau IPC] Could not start gateway:", error.message);
      stopServer();
    });
    runtime.scope.runInAsyncScope(() => runtime.ipcServer?.listen(IPC_PATH, () => {
      if (process.platform !== "win32") fs.chmodSync(IPC_PATH, 0o600);
      elected.ready = true;
      fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(elected), { mode: 0o600 });
      startHttpServer(ctx);
    }));
    return true;
  }

  function waitForGateway() {
    if (runtime.discoveryWatch) return;
    const attach = () => {
      const discovery = readDiscovery();
      if (!discovery?.ready || !processAlive(discovery.pid)) return;
      runtime.discoveryWatch?.close();
      runtime.discoveryWatch = null;
      connectPeer(discovery);
    };
    runtime.discoveryWatch = runtime.scope.runInAsyncScope(() => fs.watch(INSTANCES_DIR, attach));
    attach(); // Subscribe before observing the state to avoid a lost ready edge.
  }

  function startHttpServer(ctx: ExtensionContext) {
    const server = runtime.scope.runInAsyncScope(() => http.createServer(serveStaticFile));
    const wss = runtime.scope.runInAsyncScope(() => new WebSocketServer({ noServer: true }));
    runtime.server = server;
    runtime.wss = wss;

    server.on("upgrade", (request, socket, head) => {
      if (authEnabled && !checkBasicAuth(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Tau\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url === "/ws") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      console.log("[Mirror] Browser client connected");
      clients.add(ws);
      const selection: ClientSelection = {
        sessionId: null, pendingSessionId: null, revision: 0, alive: true, buffer: null,
      };
      runtime.selections.set(ws, selection);

      ws.on("pong", () => {
        selection.alive = true;
      });

      const original = [...runtime.sessions.values()].find(session => session.pid === process.pid);
      sendTo(ws, {
        type: "state", isStreaming: false, mode: "gateway",
        defaultSessionId: original?.sessionId, defaultSessionFile: original?.sessionFile,
      });

      ws.on("message", (data) => {
        try {
          const command: unknown = JSON.parse(data.toString());
          if (!isObject(command) || typeof command.type !== "string") throw new Error("Invalid session command");
          if (command.type === "select_session") {
            void selectClient(ws, command);
          } else {
            void routeCommand(command).then(message => sendTo(ws, message)).catch(error => sendTo(ws, {
              type: "response", command: command.type, id: command.id, sessionId: command.sessionId,
              success: false, error: error instanceof Error ? error.message : String(error),
            }));
          }
        } catch (error: unknown) {
          sendTo(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });

      ws.on("close", () => {
        console.log("[Mirror] Browser client disconnected");
        clients.delete(ws);
        runtime.selections.delete(ws);
        for (const session of runtime.sessions.values()) {
          if (session.sessionId === selection.sessionId || session.sessionId === selection.pendingSessionId) reevaluateIdle(session);
        }
      });

      ws.on("error", (e) => {
        console.error("[Mirror] Client error:", e);
        clients.delete(ws);
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    runtime.heartbeat = runtime.scope.runInAsyncScope(() => setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          continue;
        }

        const selection = runtime.selections.get(client);
        if (!selection?.alive) {
          client.terminate();
          clients.delete(client);
          continue;
        }

        selection.alive = false;
        try { client.ping(); } catch {}
      }
    }, 20000));

    const tryListen = (port: number, maxAttempts = 10) => {
      runtime.scope.runInAsyncScope(() => server.listen({ port, host: HOST, exclusive: true }, () => {
        const address = server.address();
        if (address && typeof address === "object") onListening(address.port);
      }));
      server.once("error", (err: Error) => {
        if (isObject(err) && err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          console.log(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          server.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[Mirror] Failed to start server:`, err.message);
          stopServer();
        }
      });
    };

    const onListening = (port: number) => {
      const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

      let localIp = "localhost";
      let tailscaleIp = "";

      if (!isLoopback) {
        // Get local IP for display — prefer en0/en1 (WiFi/Ethernet) over bridges/VPNs
        const nets = require("node:os").networkInterfaces();
        let fallbackIp = "";
        const preferred = ["en0", "en1"];
        for (const name of preferred) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        if (localIp === "localhost") {
          for (const name of Object.keys(nets)) {
            if (name.startsWith("bridge") || name.startsWith("utun") || name.startsWith("lo")) continue;
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal && (net.address.startsWith("192.168.") || net.address.startsWith("10."))) {
                localIp = net.address;
                break;
              }
            }
            if (localIp !== "localhost") break;
          }
        }
        if (localIp === "localhost" && fallbackIp) localIp = fallbackIp;

        // Detect Tailscale IP (100.x.x.x CGNAT range)
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal && net.address.startsWith("100.")) {
              tailscaleIp = net.address;
              break;
            }
          }
          if (tailscaleIp) break;
        }
      }

      mirrorUrl = `http://${localIp}:${port}`;
      tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : "";
      console.log(`[Mirror] Tau mirror server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`);
      ctx.ui.setStatus("mirror", `Mirror: ${localIp}:${port}${tailscaleIp ? ` • TS: ${tailscaleIp}:${port}` : ""}`);

      // Register this instance
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());
      registerLocal();

      ctx.ui.notify(`Tau mirror: ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}  •  /qr for QR code`, "info");
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      console.log("[Mirror] Subagent child process detected (PI_SUBAGENT_CHILD=1), skipping auto-start.");
      return;
    }

    if (!TAU_AUTO_START) {
      console.log("[Mirror] Tau auto-start disabled (TAU_DISABLED=1). Use /tau-start to start manually.");
      return;
    }

    if ("session" in pi && isObject(pi.session) && typeof pi.session.persistHeaderNow === "function") {
      await pi.session.persistHeaderNow();
    }
    runtime.local = {
      snapshot: () => buildStateSnapshot(latestCtx ?? ctx),
      execute: handleCommand,
      shutdown: () => (latestCtx ?? ctx).shutdown(),
    };
    startServer(ctx);
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async (event) => {
    unsubscribeWakeSources();
    if ("reason" in event && event.reason !== "quit") {
      if (runtime.peer) sendFrame(runtime.peer, { type: "unregister" });
      runtime.local = null;
      return;
    }
    stopServer();
    runtime.local = null;
    console.log("[Mirror] Server shut down");
  });
}
