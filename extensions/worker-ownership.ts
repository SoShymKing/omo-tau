import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { NativeInput } from "./native-input";
import { queryWorkerProcesses, terminateWorkerProcesses, workerImagePath, type ProcessFacts } from "./worker-process";

type LaunchPolicy = { readonly mode: "direct" } |
  { readonly mode: "compiled"; readonly image: string };
type Identity = { readonly pid: number; readonly instance: string };
type Admission = { readonly current: () => boolean; readonly commit: () => void };
// Ownership follows the original native handle, including conversation changes.
type Owner = {
  readonly policy: LaunchPolicy;
  readonly input: NativeInput | undefined;
  ready: Promise<void>;
  original: ProcessFacts | null;
  engine: ProcessFacts | null;
  pin: Identity | null;
  identity: Promise<Record<string, unknown>> | null;
  admitted: number | null;
  nativeClosed: boolean;
  closing: Promise<void> | null;
};

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function live(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && !child.killed && child.exitCode === null &&
    child.signalCode === null && alive(child.pid);
}

export function workerLaunchPolicy(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): LaunchPolicy {
  const script = args[0];
  const scriptEntrypoint = !!script && /\.(?:[cm]?js|ts)$/.test(script) && existsSync(script);
  if (/^(?:bun|node)(?:\.exe)?$/i.test(basename(executable)) && scriptEntrypoint) return { mode: "direct" };
  const home = env.HOME || env.USERPROFILE || homedir();
  const leaf = process.platform === "win32" ? "omo.exe" : "omo";
  const canonical = join(home, ".omo", "binary-runtime", "5.1.62", leaf);
  const modeIndex = args.indexOf("--mode");
  if (!["win32", "linux", "darwin"].includes(process.platform) ||
      (process.platform === "win32" ? basename(executable).toLowerCase() : basename(executable)) !== leaf || scriptEntrypoint ||
      modeIndex < 0 || args[modeIndex + 1] !== "rpc" || workerImagePath(executable) !== workerImagePath(canonical)) {
    throw new Error("Unsupported worker launch topology");
  }
  const manifest: unknown = JSON.parse(readFileSync(join(dirname(realpathSync(executable)), "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "omo" ||
      !("version" in manifest) || manifest.version !== "5.1.62" ||
      Object.keys(env).some(key =>
        /^(?:SENPI_ENGINE_TRUST|SENPI_ENGINE_TRUST_HOP|SENPI_PRIVATE_FDS|OMO_PROVISIONED_HANDOFF)$/i.test(key) &&
        env[key] !== undefined)) {
    throw new Error("Unsupported compiled OmO worker launch contract");
  }
  return { mode: "compiled", image: workerImagePath(executable) };
}

function parseIdentity(response: Record<string, unknown>): Identity {
  const data = response.data;
  if (response.type !== "response" || response.command !== "extension_request" || response.success !== true ||
      !data || typeof data !== "object" || !("version" in data) || data.version !== 1 ||
      !("pid" in data) || typeof data.pid !== "number" || !validPid(data.pid) ||
      !("instance" in data) || typeof data.instance !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.instance)) {
    throw new Error("Invalid native worker identity");
  }
  return { pid: data.pid, instance: data.instance };
}

function waitFor(child: ChildProcess, event: "exit" | "close", settled: () => boolean, timeout: number): Promise<boolean> {
  if (settled()) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener(event, done); resolve(false); }, timeout);
    child.once(event, done);
  });
}

export class WorkerOwnership {
  private readonly owners = new WeakMap<ChildProcess, Owner>();

  track(child: ChildProcess, policy: LaunchPolicy, input?: NativeInput): Promise<void> {
    const owner: Owner = { policy, input, ready: Promise.resolve(), original: null, engine: null,
      pin: null, identity: null, admitted: null, nativeClosed: false, closing: null };
    this.owners.set(child, owner);
    child.once("close", () => { owner.nativeClosed = true; });
    if (policy.mode === "compiled") owner.ready = this.captureOriginal(child, owner);
    return owner.ready;
  }

  private async captureOriginal(child: ChildProcess, owner: Owner) {
    if (!live(child)) throw new Error("Worker launcher is not live");
    const rows = await queryWorkerProcesses([child.pid]);
    const original = rows.get(child.pid);
    if (this.owners.get(child) !== owner || !live(child) || owner.nativeClosed || !original ||
        owner.policy.mode !== "compiled" ||
        (original.image !== null && original.image !== owner.policy.image) ||
        (original.group !== null && original.group !== child.pid)) {
      throw new Error("Worker launcher identity is unavailable");
    }
    owner.original = original;
  }

  private current(child: ChildProcess, owner: Owner, admission: Admission): child is ChildProcess & { pid: number } {
    return this.owners.get(child) === owner && !owner.closing && !owner.nativeClosed &&
      live(child) && admission.current();
  }

  matches(child: ChildProcess, pid: number): boolean {
    const owner = this.owners.get(child);
    return !!owner && !owner.closing && !owner.nativeClosed && live(child) &&
      owner.admitted === pid && alive(pid);
  }

  async admit(child: ChildProcess, pid: number, admission: Admission): Promise<boolean> {
    const owner = this.owners.get(child);
    if (!owner || !validPid(pid) || !this.current(child, owner, admission)) return false;
    await owner.ready;
    if (!this.current(child, owner, admission)) return false;
    let identity: Identity | null = null;
    let engine: ProcessFacts | null = null;
    if (owner.policy.mode === "direct") {
      if (pid !== child.pid) return false;
    } else {
      if (!owner.input) throw new Error("Native worker identity is unavailable");
      if (!owner.identity) {
        const request = owner.input.send({ type: "extension_request", name: "tau.workerIdentity.v1" });
        owner.identity = request;
        // Keep the underlying request until settlement, including socket auth expiry.
        const settled = () => { if (owner.identity === request) owner.identity = null; };
        void request.then(settled, settled);
      }
      const response = await owner.identity;
      if (!this.current(child, owner, admission)) return false;
      const native = parseIdentity(response);
      identity = native;
      if (pid !== native.pid) return false;
      const pinned = () => !owner.pin || (owner.pin.pid === native.pid && owner.pin.instance === native.instance);
      if (!pinned()) return false;
      const rows = await queryWorkerProcesses([child.pid, identity.pid]);
      if (!this.current(child, owner, admission) || !pinned()) return false;
      const original = rows.get(child.pid);
      engine = rows.get(identity.pid) ?? null;
      const captured = owner.original;
      if (!captured || !original || !engine || !alive(identity.pid) ||
          (engine.pid !== original.pid && engine.parent !== original.pid) ||
          (captured.image !== null && (original.image !== captured.image || engine.image !== captured.image)) ||
          (captured.created !== null && (original.created !== captured.created || engine.created === null ||
            BigInt(engine.created) < BigInt(captured.created) ||
            (owner.engine !== null && owner.engine.created !== engine.created))) ||
          (captured.group !== null && (original.group !== captured.pid || engine.group !== captured.pid))) return false;
    }
    const previous = { pin: owner.pin, engine: owner.engine, admitted: owner.admitted };
    owner.pin = identity;
    owner.engine = engine;
    owner.admitted = pid;
    try { admission.commit(); }
    catch (error: unknown) {
      owner.pin = previous.pin;
      owner.engine = previous.engine;
      owner.admitted = previous.admitted;
      throw error;
    }
    return true;
  }

  close(child: ChildProcess, graceful: boolean): Promise<void> {
    const owner = this.owners.get(child);
    if (!owner) return Promise.reject(new Error("Unknown worker owner"));
    if (owner.closing) return owner.closing;
    // Publish closing before EOF can synchronously trigger registration.
    owner.closing = Promise.resolve().then(async () => {
      child.stdin?.end();
      if (owner.policy.mode === "compiled" && process.platform !== "win32")
        await waitFor(child, "close", () => owner.nativeClosed, 5000);
      else if (graceful)
        await waitFor(child, "exit", () => child.exitCode !== null || child.signalCode !== null, 5000);
      if (owner.policy.mode === "direct") {
        if (live(child)) child.kill();
        if (!await waitFor(child, "exit", () => child.exitCode !== null || child.signalCode !== null, 5000))
          throw new Error("Worker termination timed out");
      } else {
        // Capture errors remain startup errors; cleanup uses only independently retained authority.
        const capture = await owner.ready.then(() => ({ error: null }), (error: unknown) => ({ error }));
        if (capture.error && process.platform === "win32" && !owner.original) throw capture.error;
        await terminateWorkerProcesses(child,
          { original: owner.original, engine: owner.engine, nativeClosed: owner.nativeClosed },
          () => this.owners.get(child) === owner);
        if (!await waitFor(child, "close", () => owner.nativeClosed, 5000))
          throw new Error("Worker native close timed out");
      }
    });
    return owner.closing;
  }
}
