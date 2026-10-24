import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

describe("authenticated local file HTTP endpoint", () => {
  let root: string;
  let base: string;
  let firstCwd: string;
  let secondCwd: string;
  let firstId: string;
  let secondId: string;
  const children: ChildProcess[] = [];
  const authorization = `Basic ${Buffer.from("files:download-test").toString("base64")}`;
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
  const unicodeName = "\ud55c\uae00 caf\u00e9 (report)'!.txt";

  function launch(file: string, signal: RegExp) {
    const proc = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/mirror-host.mjs"), file], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env, HOME: root, USERPROFILE: root,
        PI_CODING_AGENT_DIR: path.join(root, ".omo/agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, ".omo/agent/sessions"),
        TAU_HOST: "127.0.0.1", TAU_MIRROR_PORT: "0", TAU_DISABLED: "0",
        TAU_USER: "files", TAU_PASS: "download-test",
        TAU_STATIC_DIR: path.resolve(import.meta.dir, "../public"),
        PI_SUBAGENT_CHILD: "", TAU_GATEWAY_PIPE: "", TAU_GATEWAY_TOKEN: "",
        TAU_WORKER_NONCE: "", TAU_GATEWAY_PID: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(proc);
    return new Promise<string>((resolve, reject) => {
      if (!proc.stdout) { reject(new Error("Missing child stdout")); return; }
      let diagnostics = "";
      proc.stderr?.on("data", data => { diagnostics += String(data); });
      const timer = setTimeout(() => reject(new Error(`Missing startup signal: ${diagnostics}`)), 15000);
      createInterface({ input: proc.stdout }).on("line", line => {
        if (!signal.test(line)) return;
        clearTimeout(timer);
        resolve(line);
      });
      proc.once("error", error => { clearTimeout(timer); reject(error); });
      proc.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Early host exit ${code}: ${diagnostics}`));
      });
    });
  }

  function fileUrl(filePath?: string, sessionId: string | null = firstId, download = false) {
    const url = new URL("/api/file", base);
    if (filePath !== undefined) url.searchParams.set("path", filePath);
    if (sessionId !== null) url.searchParams.set("sessionId", sessionId);
    if (download) url.searchParams.set("download", "1");
    return url;
  }

  function request(filePath?: string, sessionId: string | null = firstId, method = "GET", download = false) {
    return fetch(fileUrl(filePath, sessionId, download), { method, headers: { authorization } });
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tau-file-test-"));
    firstCwd = path.join(root, "first");
    secondCwd = path.join(root, "second");
    const sessions = path.join(root, ".omo/agent/sessions/project");
    await Promise.all([firstCwd, secondCwd, sessions].map(dir => mkdir(dir, { recursive: true })));
    await Promise.all([
      writeFile(path.join(firstCwd, "same.txt"), "first workspace"),
      writeFile(path.join(secondCwd, "same.txt"), "second workspace"),
      writeFile(path.join(firstCwd, "only-first.txt"), "no fallback"),
      writeFile(path.join(firstCwd, "pixel.png"), image),
      writeFile(path.join(firstCwd, "document.pdf"), "%PDF-1.7\n%%EOF\n"),
      writeFile(path.join(firstCwd, "unknown.bin"), binary),
      writeFile(path.join(firstCwd, "active.html"), "<script>alert(1)</script>"),
      writeFile(path.join(firstCwd, "active.svg"), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      writeFile(path.join(firstCwd, "data.json"), '{"safe":true}'),
      writeFile(path.join(firstCwd, unicodeName), "Unicode \ud55c\uae00 bytes"),
      writeFile(path.join(root, "outside.txt"), "outside the selected workspace"),
      writeFile(path.join(root, "100%.txt"), "literal percent"),
    ]);
    const firstSession = path.join(sessions, "first.jsonl");
    const secondSession = path.join(sessions, "second.jsonl");
    await writeFile(firstSession, JSON.stringify({ type: "session", id: "first", cwd: firstCwd }) + "\n");
    await writeFile(secondSession, JSON.stringify({ type: "session", id: "second", cwd: secondCwd }) + "\n");
    const ready = await launch(firstSession, /QA_READY/);
    base = `http://127.0.0.1:${ready.split(" ").pop()}`;
    await launch(secondSession, /Session registered with Tau gateway/);
    const response = await fetch(`${base}/api/instances`, { headers: { authorization } });
    expect(response.status).toBe(200);
    const result = await response.json();
    const first = result.sessions.find((session: { cwd: string }) => session.cwd === firstCwd);
    const second = result.sessions.find((session: { cwd: string }) => session.cwd === secondCwd);
    if (!first || !second) throw new Error("Fixture sessions did not register");
    firstId = first.sessionId;
    secondId = second.sessionId;
    expect(firstId).not.toBe(secondId);
  }, 30000);

  afterAll(async () => {
    for (const proc of children.reverse()) {
      if (proc.exitCode !== null || proc.signalCode !== null) continue;
      const exited = once(proc, "exit", { signal: AbortSignal.timeout(5000) });
      proc.stdin?.end();
      try { await exited; } catch (error) { proc.kill(); throw error; }
    }
    if (root) await rm(root, { recursive: true, force: true });
  }, 15000);

  test("authenticates before validating file requests", async () => {
    const response = await fetch(fileUrl("same.txt"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect((await fetch(`${base}/api/file`, { method: "HEAD" })).status).toBe(401);
    expect((await fetch(`${base}/api/file`, { headers: { authorization: "Basic invalid" } })).status).toBe(401);
  });

  test("streams exact image bytes with safe inline headers", async () => {
    const response = await request("pixel.png");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(image.length));
    expect(response.headers.get("content-disposition")).toStartWith("inline;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  test("HEAD returns GET metadata without bytes", async () => {
    const get = await request("pixel.png");
    const head = await request("pixel.png", firstId, "HEAD");
    expect(head.status).toBe(200);
    for (const header of ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options", "content-security-policy"]) {
      expect(head.headers.get(header)).toBe(get.headers.get(header));
    }
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    await get.arrayBuffer();
  });

  test("resolves relative paths against the exact selected runtime cwd", async () => {
    expect(await (await request("same.txt", firstId)).text()).toBe("first workspace");
    expect(await (await request("same.txt", secondId)).text()).toBe("second workspace");
    expect((await request("only-first.txt", secondId)).status).toBe(404);
  });

  test("requires a known runtime session even for absolute paths", async () => {
    for (const filePath of ["same.txt", path.join(firstCwd, "same.txt")]) {
      expect((await request(filePath, null)).status).toBe(400);
      expect((await request(filePath, "unknown")).status).toBe(404);
      expect((await request(filePath, "first")).status).toBe(404);
    }
  });

  test("allows local absolute, parent-relative, home, and file URL paths", async () => {
    const outside = path.join(root, "outside.txt");
    const localUrl = pathToFileURL(outside);
    const localhostUrl = new URL(localUrl);
    localhostUrl.hostname = "localhost";
    for (const filePath of [outside, "../outside.txt", "~/outside.txt", localUrl.href, localhostUrl.href]) {
      const response = await request(filePath, secondId);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("outside the selected workspace");
    }
    expect(await (await request(path.join(root, "100%.txt"))).text()).toBe("literal percent");
  });

  test("keeps PDF and text inline, with text served as plain text", async () => {
    const pdf = await request("document.pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toStartWith("inline;");
    expect(await pdf.text()).toBe("%PDF-1.7\n%%EOF\n");
    const text = await request("data.json");
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("content-disposition")).toStartWith("inline;");
    expect(await text.text()).toBe('{"safe":true}');
  });

  test("forces downloads and preserves Unicode filenames with filename*", async () => {
    const response = await request(unicodeName, firstId, "GET", true);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).toStartWith("attachment;");
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    const encoded = disposition.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe(unicodeName);
    expect(encoded).not.toMatch(/['()*]/);
    expect(await response.text()).toBe("Unicode \ud55c\uae00 bytes");
    const head = await request("pixel.png", firstId, "HEAD", true);
    expect(head.headers.get("content-disposition")).toStartWith("attachment;");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("does not preview unknown binary files or active HTML and SVG", async () => {
    for (const [filePath, contentType] of [
      ["unknown.bin", "application/octet-stream"],
      ["active.html", "text/html"],
      ["active.svg", "image/svg+xml"],
    ]) {
      const response = await request(filePath);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-disposition")).toStartWith("attachment;");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (filePath === "unknown.bin") expect(bytes).toEqual(binary);
      else expect(bytes.length).toBeGreaterThan(0);
    }
  });

  test("reports missing files and directories without terminating the server", async () => {
    expect((await request("missing.txt")).status).toBe(404);
    expect((await request(".")).status).toBe(400);
    const head = await request("missing.txt", firstId, "HEAD");
    expect(head.status).toBe(404);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await request("same.txt")).status).toBe(200);
  });

  test("rejects absent, malformed, and non-file paths", async () => {
    for (const filePath of [undefined, "", "\0", "C:relative.txt", "https://example.com/a", "file:///bad%zz", "file:///bad%00"]) {
      expect((await request(filePath)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/file?sessionId=${firstId}&path=%zz`, { headers: { authorization } })).status).toBe(400);
  });

  test("rejects UNC, device, and remote file URL paths before filesystem access", async () => {
    for (const filePath of [
      "\\\\server\\share\\file.txt", "//server/share/file.txt", "\\/server/share/file.txt",
      "\\\\?\\UNC\\server\\share\\file.txt", "\\\\.\\pipe\\name",
      "file://server/share/file.txt", "file:////server/share/file.txt",
    ]) {
      expect((await request(filePath)).status).toBe(400);
    }
  });

  test("rejects unsupported methods with Allow metadata", async () => {
    const response = await request("same.txt", firstId, "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
