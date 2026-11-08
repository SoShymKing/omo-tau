import { execFile, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export type ProcessFacts = {
  readonly pid: number;
  readonly parent: number;
  readonly image: string | null;
  readonly created: string | null;
  readonly group: number | null;
};
export type TerminationEvidence = {
  readonly original: ProcessFacts | null;
  readonly engine: ProcessFacts | null;
  readonly nativeClosed: boolean;
};

export function workerImagePath(value: string): string {
  const image = realpathSync(value);
  return process.platform === "win32" ? image.replaceAll("/", "\\").toLowerCase() : image;
}

function bounded(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}

function systemExecutable(relative: string) {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === "SYSTEMROOT");
  if (!key || !process.env[key]) throw new Error("Windows SystemRoot is unavailable");
  return join(process.env[key], "System32", relative);
}

export function queryWorkerProcesses(pids: readonly number[]): Promise<Map<number, ProcessFacts>> {
  if (!pids.length || pids.some(pid => !bounded(pid) || !pid))
    return Promise.reject(new Error("Invalid process identity"));
  const requested = [...new Set(pids)];
  const windows = process.platform === "win32";
  const filter = requested.map(pid => `ProcessId = ${pid}`).join(" OR ");
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(
    Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;
      image=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().Ticks.ToString()}
    }) | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile(windows ? systemExecutable("WindowsPowerShell/v1.0/powershell.exe") : "/bin/ps",
      windows ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")] :
        ["-p", requested.join(","), "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
      { env: windows ? process.env : { ...process.env, LC_ALL: "C" }, windowsHide: true,
        timeout: windows ? 5000 : 2000, maxBuffer: windows ? 32768 : 16384 }, (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const facts = new Map<number, ProcessFacts>();
          if (windows) {
            const parsed: unknown = JSON.parse(stdout || "[]");
            const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
            for (const row of rows) {
              if (!row || typeof row !== "object" ||
                  !("pid" in row) || typeof row.pid !== "number" || !bounded(row.pid) || !row.pid ||
                  !("parent" in row) || typeof row.parent !== "number" || !bounded(row.parent) ||
                  !("image" in row) || typeof row.image !== "string" || !row.image ||
                  !("created" in row) || typeof row.created !== "string" || !/^\d+$/.test(row.created) ||
                  !requested.includes(row.pid) || facts.has(row.pid)) throw new Error("Invalid OS process identity");
              facts.set(row.pid, { pid: row.pid, parent: row.parent, image: workerImagePath(row.image),
                created: row.created, group: null });
            }
          } else {
            for (const line of stdout.trim().split("\n").filter(Boolean)) {
              const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
              if (!match) throw new Error("Malformed POSIX process row");
              const [pid, parent, group] = match.slice(1).map(Number);
              if (![pid, parent, group].every(bounded) || !pid || !group ||
                  !requested.includes(pid) || facts.has(pid)) throw new Error("Unexpected POSIX process row");
              facts.set(pid, { pid, parent, group, image: null, created: null });
            }
          }
          resolve(facts);
        } catch (error: unknown) { reject(error); }
      });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function live(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && !child.killed && child.exitCode === null &&
    child.signalCode === null && alive(child.pid);
}

export async function terminateWorkerProcesses(
  child: ChildProcess,
  evidence: TerminationEvidence,
  current: () => boolean,
): Promise<void> {
  if (process.platform === "win32") {
    const captured = [evidence.original, evidence.engine].filter((row): row is ProcessFacts => row !== null);
    if (!evidence.original) throw new Error("Worker termination identity is unavailable");
    const rows = await queryWorkerProcesses(captured.map(row => row.pid));
    if (!current()) throw new Error("Worker termination owner changed");
    const target = live(child) ? evidence.original : evidence.engine;
    const observed = target && rows.get(target.pid);
    if (target && observed && target.created !== null && target.image !== null &&
        observed.created === target.created && observed.image === target.image) {
      if (!current()) throw new Error("Worker termination owner changed");
      await new Promise<void>((resolve, reject) => {
        execFile(systemExecutable("taskkill.exe"), ["/PID", String(target.pid), "/T", "/F"],
          { env: process.env, windowsHide: true, timeout: 5000, maxBuffer: 32768 },
          error => error ? reject(error) : resolve());
      });
    } else if (target && alive(target.pid)) throw new Error("Worker termination identity changed");
  } else {
    if (evidence.nativeClosed) return;
    if (!current() || !live(child)) throw new Error("Worker cleanup identity unavailable");
    const rows = await queryWorkerProcesses([child.pid]);
    if (!current() || !live(child) || rows.get(child.pid)?.group !== child.pid)
      throw new Error("Worker cleanup identity unavailable");
    process.kill(-child.pid, "SIGKILL");
  }
}
