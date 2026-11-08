import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WorkerOwnership, workerLaunchPolicy } from "../extensions/worker-ownership.ts";
import { NativeInput } from "../extensions/native-input.ts";
import { queryPosixProcesses } from "../extensions/posix-worker.ts";

if (process.platform !== "linux" && process.platform !== "darwin") {
  console.error("NATIVE_NOT_RUN: real Linux/macOS ps, process groups and execve required");
  process.exit(77);
}
const executable = process.argv[2];
assert(executable?.startsWith("/"), "Pass an explicit absolute Node path");
const fixture = fileURLToPath(new URL("./fixtures/native-posix.mjs", import.meta.url));
const execute = (command, args) => new Promise((resolve, reject) => execFile(command, args,
  { env: process.env, timeout: 2000, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
const version = await execute(executable, ["--version"]);
const [major, minor] = version.slice(1).split(".").map(Number);
const realFailure = major > 26 || (major === 26 && minor >= 1);
const log = value => console.log(JSON.stringify({ platform: process.platform, node: version, ...value }));
async function closedWithin(child, milliseconds) {
  return once(child, "close", { signal: AbortSignal.timeout(milliseconds) });
}
const root = mkdtempSync(join(tmpdir(), "tau-native-ownership-"));
try {
  const home = join(root, "home");
  const canonical = join(home, ".omo/binary-runtime/5.1.62");
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, "omo"), "");
  writeFileSync(join(canonical, "package.json"), JSON.stringify({ name: "omo", version: "5.1.62" }));
  assert.equal(workerLaunchPolicy(join(canonical, "omo"), ["--mode", "rpc"], { HOME: home }).mode, "posix-compiled");
  for (const key of ["SENPI_ENGINE_TRUST", "SENPI_ENGINE_TRUST_HOP", "SENPI_PRIVATE_FDS", "OMO_PROVISIONED_HANDOFF"])
    assert.throws(() => workerLaunchPolicy(join(canonical, "omo"), ["--mode", "rpc"], { HOME: home, [key]: "" }));
  assert.equal(workerLaunchPolicy(executable, [fixture, "--mode", "rpc"], { HOME: home }).mode, "direct");
  for (const mode of realFailure ? ["exec", "missing", "failed-syscall"] : ["exec", "missing"]) {
    for (const behavior of mode === "exec" ? ["graceful", "stubborn", "silent"] :
      ["graceful", "stubborn", "silent", "owner-death"]) {
      const child = spawn(executable, [fixture, mode, behavior === "owner-death" ? "stubborn" : behavior], {
        env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let lines, facts, startupTimer;
      let nativeClosed = false;
      child.once("close", () => { nativeClosed = true; });
      try {
        const input = new NativeInput(child);
        const ownership = new WorkerOwnership();
        await ownership.track(child, { mode: "posix-compiled" }, input);
        lines = createInterface({ input: child.stderr });
        facts = await new Promise((resolve, reject) => {
          startupTimer = setTimeout(() => reject(new Error("Native fixture startup timed out")), 5000);
          lines.on("line", line => {
            let value;
            try { value = JSON.parse(line); }
            catch (error) { reject(error); return; }
            if (value.engine) { clearTimeout(startupTimer); resolve(value); }
            else log(value);
          });
        });
        const rows = await queryPosixProcesses([child.pid, facts.engine, facts.qa]);
        assert.equal(child.pid === facts.engine, mode === "exec");
        for (const row of rows.values()) assert.equal(row.group, child.pid);
        assert.equal(rows.get(facts.qa).parent, facts.engine);
        if (behavior !== "silent") {
          assert.equal(await ownership.admit(child, facts.qa), false);
          assert.equal(await ownership.admit(child, facts.engine), true);
          assert.equal(await ownership.admit(child, facts.engine), true);
          assert.equal(await ownership.admit(child, facts.qa), false);
          assert.equal((await input.send({ type: "get_state" })).data.pid, facts.engine);
        }
        if (behavior === "owner-death" && mode !== "exec") {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
          await assert.rejects(ownership.close(child, false), /cleanup identity unavailable/);
          process.kill(facts.engine, 0);
          log({ event: "stale-group-not-signaled", mode, ...facts });
          const closed = closedWithin(child, 5000);
          process.kill(facts.engine, "SIGKILL");
          process.kill(facts.qa, "SIGKILL");
          await closed;
        } else {
          const closed = closedWithin(child, 12000);
          const pending = behavior === "silent" ? ownership.admit(child, facts.engine).then(
            accepted => ({ accepted }), error => ({ error: error.message })) : null;
          const closing = ownership.close(child, true);
          assert.equal(await ownership.admit(child, facts.engine), false);
          await closing;
          await closed;
          if (pending) assert((await pending).error, "Unanswered native identity must reject on native close");
        }
        // A single real OS observation distinguishes terminated zombies from survivors.
        const statuses = await new Promise((resolve, reject) => execFile("/bin/ps",
          ["-p", [...new Set([child.pid, facts.engine, facts.qa])].join(","), "-o", "stat="],
          { env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 16384 },
          (error, out) => error && !(error.code === 1 && !out.trim()) ? reject(error) : resolve(out.trim())));
        assert(statuses.split("\n").filter(Boolean).every(status => status.trim().startsWith("Z")));
        log({ event: "native-owner-pass", mode, behavior, original: child.pid, ...facts,
          rows: [...rows.values()], remainingStatuses: statuses });
      } finally {
        clearTimeout(startupTimer);
        lines?.close();
        const closed = nativeClosed ? Promise.resolve() : closedWithin(child, 5000);
        if (child.exitCode === null && child.signalCode === null) {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } else if (!nativeClosed && facts) {
          // Only this test's recorded fixtures, never a stale process group.
          for (const pid of new Set([facts.engine, facts.qa])) {
            try { process.kill(pid, "SIGKILL"); }
            catch (error) {
              if (!(error instanceof Error) || error.code !== "ESRCH") throw error;
            }
          }
        }
        await closed;
      }
    }
  }
  log({ event: "complete", nativePosix: true, compiledOmoVerified: false,
    failedSyscall: realFailure ? "executed" : "NOT_RUN: requires Node >= 26.1; no injected throw substituted" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
