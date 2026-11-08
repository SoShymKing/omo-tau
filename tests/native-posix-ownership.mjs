import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WorkerOwnership, workerLaunchPolicy } from "../extensions/worker-ownership.ts";
import { NativeInput } from "../extensions/native-input.ts";
import { queryWorkerProcesses } from "../extensions/worker-process.ts";

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
const closedWithin = (child, milliseconds) => once(child, "close", { signal: AbortSignal.timeout(milliseconds) });
const killFixture = pid => {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
let root;
try {
  root = mkdtempSync(join(tmpdir(), "tau-native-ownership-"));
  const home = join(root, "home");
  const canonical = join(home, ".omo/binary-runtime/5.1.62");
  mkdirSync(canonical, { recursive: true });
  const image = join(canonical, "omo");
  writeFileSync(image, "");
  writeFileSync(join(canonical, "package.json"), JSON.stringify({ name: "omo", version: "5.1.62" }));
  assert.equal(workerLaunchPolicy(image, ["--mode", "rpc"], { HOME: home }).mode, "compiled");
  for (const key of ["SENPI_ENGINE_TRUST", "SENPI_ENGINE_TRUST_HOP", "SENPI_PRIVATE_FDS", "OMO_PROVISIONED_HANDOFF"])
    assert.throws(() => workerLaunchPolicy(image, ["--mode", "rpc"], { HOME: home, [key]: "" }));
  assert.equal(workerLaunchPolicy(executable, [fixture, "--mode", "rpc"], { HOME: home }).mode, "direct");
  for (const mode of realFailure ? ["exec", "missing", "failed-syscall"] : ["exec", "missing"]) {
    for (const behavior of mode === "exec" ? ["graceful", "stubborn", "silent"] :
      ["graceful", "stubborn", "silent", "owner-death"]) {
      let child, lines, facts, startupTimer;
      let nativeClosed = false;
      const registry = join(root, `${mode}-${behavior}-pids.jsonl`);
      try {
        child = spawn(executable, [fixture, mode, behavior === "owner-death" ? "stubborn" : behavior], {
          env: { ...process.env, TAU_NATIVE_PIDS: registry }, detached: true, stdio: ["pipe", "pipe", "pipe"],
        });
        child.once("close", () => { nativeClosed = true; });
        lines = createInterface({ input: child.stderr });
        const started = new Promise((resolve, reject) => {
          child.once("error", reject);
          startupTimer = setTimeout(() => reject(new Error("Native fixture startup timed out")), 5000);
          lines.on("line", line => {
            let value;
            try { value = JSON.parse(line); }
            catch (error) { reject(error); return; }
            if (value.engine) { clearTimeout(startupTimer); resolve(value); }
            else log(value);
          });
        });
        // Observe either rejection immediately even if initial OS capture fails.
        void started.catch(() => {});
        const input = new NativeInput(child);
        const ownership = new WorkerOwnership();
        await ownership.track(child, { mode: "compiled", image }, input);
        facts = await started;
        const admit = pid => ownership.admit(child, pid, { current: () => true, commit: () => {} });
        const rows = await queryWorkerProcesses([child.pid, facts.engine, facts.qa]);
        assert.equal(child.pid === facts.engine, mode === "exec");
        for (const row of rows.values()) assert.equal(row.group, child.pid);
        assert.equal(rows.get(facts.qa).parent, facts.engine);
        if (behavior !== "silent") {
          assert.equal(await admit(facts.qa), false);
          assert.equal(await admit(facts.engine), true);
          assert.equal(await admit(facts.engine), true);
          assert.equal(await admit(facts.qa), false);
          assert.equal((await input.send({ type: "get_state" })).data.pid, facts.engine);
        }
        if (behavior === "owner-death") {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
          await assert.rejects(ownership.close(child, false), /cleanup identity unavailable/);
          process.kill(facts.engine, 0);
          log({ event: "stale-group-not-signaled", mode, ...facts });
          const closed = closedWithin(child, 5000);
          killFixture(facts.engine);
          killFixture(facts.qa);
          await closed;
        } else {
          let pending;
          if (behavior === "silent") {
            const send = input.send.bind(input);
            let identityStarted;
            const identitySent = new Promise(resolve => { identityStarted = resolve; });
            input.send = command => {
              const request = send(command);
              if (command.type === "extension_request" && command.name === "tau.workerIdentity.v1") identityStarted();
              return request;
            };
            pending = admit(facts.engine).then(
              accepted => ({ accepted }), error => ({ error: error.message }));
            await Promise.race([identitySent, pending.then(() => {
              throw new Error("Admission settled before native identity send");
            })]);
          }
          const closed = closedWithin(child, 12000);
          const closing = ownership.close(child, true);
          assert.equal(await admit(facts.engine), false);
          await closing;
          await closed;
          if (pending) assert((await pending).error, "Unanswered native identity must reject on native close");
        }
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
        if (child) {
          const closed = nativeClosed ? Promise.resolve() : closedWithin(child, 5000);
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            // This test still owns the live dedicated leader.
            process.kill(-child.pid, "SIGKILL");
          }
          if (existsSync(registry)) {
            // Only recorded fixture children; never a stale numeric group.
            const recorded = readFileSync(registry, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
            for (const pid of new Set(recorded.flatMap(record => [record.engine, record.qa]))) killFixture(pid);
          }
          await closed;
        }
      }
    }
  }
  log({ event: "complete", nativePosix: true, compiledOmoVerified: false,
    failedSyscall: realFailure ? "executed" : "NOT_RUN: requires Node >= 26.1; no injected throw substituted" });
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
}
