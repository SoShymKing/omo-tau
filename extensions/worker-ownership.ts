import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { NativeInput } from "./native-input";
import { queryPosixProcesses } from "./posix-worker";

type LaunchPolicy = { readonly mode: "direct" } |
  { readonly mode: "posix-compiled" } |
  { readonly mode: "windows-bootstrap"; readonly image: string };
type ProcessIdentity = {
  readonly pid: number;
  readonly parent: number;
  readonly image: string;
  readonly created: string;
};
// Binding lifetime follows the original native handle, including conversation changes.
type Owner = {
  readonly policy: LaunchPolicy;
  readonly ready: Promise<void>;
  launcher: ProcessIdentity | null;
  engine: ProcessIdentity | null;
  admitted: number | null;
  closing: Promise<void> | null;
  readonly input?: NativeInput;
  identityRequest: Promise<Record<string, unknown>> | null;
  identity: { readonly pid: number; readonly instance: string } | null;
  closed: boolean;
};

function imagePath(value: string) {
  return realpathSync(value).replaceAll("/", "\\").toLowerCase();
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function live(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null && alive(child.pid);
}

export function workerLaunchPolicy(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): LaunchPolicy {
  const script = args[0];
  const scriptEntrypoint = !!script && /\.(?:[cm]?js|ts)$/.test(script) && existsSync(script);
  if (process.platform !== "win32") {
    if (scriptEntrypoint || (process.platform !== "linux" && process.platform !== "darwin")) return { mode: "direct" };
    const canonical = join(env.HOME || homedir(), ".omo", "binary-runtime", "5.1.62", "omo");
    const modeIndex = args.indexOf("--mode");
    if (basename(executable) !== "omo" || modeIndex < 0 || args[modeIndex + 1] !== "rpc" ||
        realpathSync(executable) !== realpathSync(canonical))
      throw new Error("Unsupported worker launch topology");
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(realpathSync(executable)), "package.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "omo" ||
        !("version" in manifest) || manifest.version !== "5.1.62" ||
        Object.keys(env).some(key => /^(?:SENPI_ENGINE_TRUST(?:_HOP)?|SENPI_PRIVATE_FDS|OMO_PROVISIONED_HANDOFF)$/i.test(key) &&
          env[key] !== undefined))
      throw new Error("Unsupported compiled OmO worker launch contract");
    return { mode: "posix-compiled" };
  }
  if (/^(?:bun|node)(?:\.exe)?$/i.test(basename(executable)) && scriptEntrypoint) return { mode: "direct" };
  const home = env.HOME || env.USERPROFILE || homedir();
  const canonical = join(home, ".omo", "binary-runtime", "5.1.62", "omo.exe");
  const modeIndex = args.indexOf("--mode");
  if (basename(executable).toLowerCase() !== "omo.exe" || scriptEntrypoint ||
      modeIndex < 0 || args[modeIndex + 1] !== "rpc" || imagePath(executable) !== imagePath(canonical)) {
    throw new Error("Unsupported worker launch topology");
  }
  const manifest: unknown = JSON.parse(readFileSync(join(dirname(realpathSync(executable)), "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "omo" ||
      !("version" in manifest) || manifest.version !== "5.1.62" ||
      Object.keys(env).some(key => /^(?:SENPI_ENGINE_TRUST|SENPI_ENGINE_TRUST_HOP)$/i.test(key) && env[key] !== undefined)) {
    throw new Error("Unsupported compiled OmO worker launch contract");
  }
  return { mode: "windows-bootstrap", image: imagePath(executable) };
}

function systemExecutable(relative: string) {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === "SYSTEMROOT");
  if (!key || !process.env[key]) throw new Error("Windows SystemRoot is unavailable");
  return join(process.env[key], "System32", relative);
}

function queryProcesses(pids: readonly number[]): Promise<Map<number, ProcessIdentity>> {
  if (pids.some(pid => !validPid(pid))) return Promise.reject(new Error("Invalid process identity"));
  const filter = [...new Set(pids)].map(pid => `ProcessId = ${pid}`).join(" OR ");
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(
    Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;
      image=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().Ticks.ToString()}
    }) | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile(systemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 }, (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const parsed: unknown = JSON.parse(stdout || "[]");
          const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
          const identities = new Map<number, ProcessIdentity>();
          for (const row of rows) {
            if (!row || typeof row !== "object" ||
                !("pid" in row) || typeof row.pid !== "number" || !validPid(row.pid) ||
                !("parent" in row) || typeof row.parent !== "number" || !Number.isSafeInteger(row.parent) ||
                !("image" in row) || typeof row.image !== "string" || !row.image ||
                !("created" in row) || typeof row.created !== "string" || !/^\d+$/.test(row.created) ||
                !pids.includes(row.pid) || identities.has(row.pid)) throw new Error("Invalid OS process identity");
            identities.set(row.pid, { pid: row.pid, parent: row.parent, image: imagePath(row.image), created: row.created });
          }
          resolve(identities);
        } catch (error: unknown) { reject(error); }
      });
  });
}

function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (!live(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener("exit", done); resolve(false); }, timeout);
    child.once("exit", done);
  });
}

function waitForClose(child: ChildProcess, owner: Owner): Promise<boolean> {
  if (owner.closed) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener("close", done); resolve(false); }, 5000);
    child.once("close", done);
  });
}

export class WorkerOwnership {
  private readonly owners = new WeakMap<ChildProcess, Owner>();

  track(child: ChildProcess, policy: LaunchPolicy, input?: NativeInput): Promise<void> {
    const ready = policy.mode === "windows-bootstrap" ? this.captureLauncher(child, policy) : Promise.resolve();
    const owner: Owner = { policy, ready, launcher: null, engine: null, admitted: null, closing: null,
      input, identityRequest: null, identity: null, closed: false };
    this.owners.set(child, owner);
    child.once("close", () => { owner.closed = true; });
    return ready;
  }

  private async captureLauncher(child: ChildProcess, policy: LaunchPolicy) {
    if (!live(child)) throw new Error("Worker launcher is not live");
    const rows = await queryProcesses([child.pid]);
    const owner = this.owners.get(child);
    const launcher = rows.get(child.pid);
    if (!owner || !live(child) || policy.mode !== "windows-bootstrap" || launcher?.image !== policy.image)
      throw new Error("Worker launcher identity is unavailable");
    owner.launcher = launcher;
  }

  matches(child: ChildProcess, pid: number): boolean {
    const owner = this.owners.get(child);
    return !!owner && !owner.closing && live(child) && owner.admitted === pid && alive(pid);
  }

  async admit(child: ChildProcess, pid: number, registration?: {
    readonly current: () => boolean;
    readonly commit: () => void;
  }): Promise<boolean> {
    const owner = this.owners.get(child);
    const current = () => this.owners.get(child) === owner && !!owner && !owner.closing &&
      !owner.closed && !child.killed && live(child) && (!registration || registration.current());
    if (!owner || !validPid(pid) || !current()) return false;
    if (owner.policy.mode === "posix-compiled") {
      if (!owner.input) return false;
      if (!owner.identityRequest) {
        // Keep the underlying request until it settles, even if every waiting socket expires.
        owner.identityRequest = owner.input.send({ type: "extension_request", name: "tau.workerIdentity.v1" })
          .finally(() => { owner.identityRequest = null; });
      }
      const response = await owner.identityRequest;
      if (!current()) return false;
      const identity = response.data;
      if (response.type !== "response" || response.command !== "extension_request" || response.success !== true ||
          !identity || typeof identity !== "object" || !("version" in identity) || identity.version !== 1 ||
          !("pid" in identity) || typeof identity.pid !== "number" || !validPid(identity.pid) || identity.pid !== pid ||
          !("instance" in identity) || typeof identity.instance !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.instance)) return false;
      if (!live(child)) return false;
      const rows = await queryPosixProcesses([child.pid, identity.pid]);
      if (!current()) return false;
      const original = rows.get(child.pid), engine = rows.get(identity.pid);
      if (!original || !engine || (engine.pid !== child.pid && engine.parent !== child.pid) ||
          original.group !== child.pid || engine.group !== child.pid ||
          (owner.identity && (owner.identity.pid !== identity.pid || owner.identity.instance !== identity.instance))) return false;
      owner.identity = { pid: identity.pid, instance: identity.instance };
      owner.admitted = pid;
      registration?.commit();
      return true;
    }
    await owner.ready;
    if (!current() || !live(child)) return false;
    if (owner.policy.mode === "direct") {
      if (pid !== child.pid) return false;
      owner.admitted = pid;
      registration?.commit();
      return true;
    }
    if (pid === child.pid) return false;
    const rows = await queryProcesses([child.pid, pid]);
    const launcher = rows.get(child.pid), engine = rows.get(pid);
    if (!current() || !live(child) || !alive(pid) || !launcher || !engine ||
        launcher.created !== owner.launcher?.created || launcher.image !== owner.policy.image ||
        engine.image !== owner.policy.image || engine.parent !== child.pid ||
        BigInt(engine.created) < BigInt(launcher.created) ||
        (owner.engine && (owner.engine.pid !== pid || owner.engine.created !== engine.created))) return false;
    owner.engine = engine;
    owner.admitted = pid;
    registration?.commit();
    return true;
  }

  close(child: ChildProcess, graceful: boolean): Promise<void> {
    const owner = this.owners.get(child);
    if (!owner) return Promise.reject(new Error("Unknown worker owner"));
    if (owner.closing) return owner.closing;
    // Defer the async body so closing is visible even to synchronous EOF handlers.
    owner.closing = Promise.resolve().then(async () => {
      child.stdin?.end();
      if (owner.policy.mode === "posix-compiled") {
        if (await waitForClose(child, owner)) return;
        // Only the still-owned original handle authorizes the numeric group.
        if (this.owners.get(child) !== owner || !live(child) || child.killed)
          throw new Error("POSIX worker owner exited before native pipes closed; cleanup identity unavailable");
        process.kill(-child.pid, "SIGKILL");
        if (!await waitForClose(child, owner)) throw new Error("POSIX worker native close timed out");
        return;
      }
      if (graceful) await waitForExit(child, 5000);
      if (owner.policy.mode === "direct") {
        if (live(child)) child.kill();
      } else {
        await owner.ready;
        const identities = [owner.launcher, owner.engine].filter((row): row is ProcessIdentity => row !== null);
        const rows = await queryProcesses(identities.map(row => row.pid));
        const target = live(child) ? owner.launcher : owner.engine;
        const current = target && rows.get(target.pid);
        if (current && target && current.created === target.created && current.image === target.image) {
          await new Promise<void>((resolve, reject) => {
            execFile(systemExecutable("taskkill.exe"), ["/PID", String(target.pid), "/T", "/F"],
              { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 }, error => error ? reject(error) : resolve());
          });
        } else if (target && alive(target.pid)) {
          throw new Error("Worker termination identity changed");
        }
      }
      if (!await waitForExit(child, 5000)) throw new Error("Worker termination timed out");
    });
    return owner.closing;
  }
}
