import { execFile } from "node:child_process";

type ProcessRow = { readonly pid: number; readonly parent: number; readonly group: number };

export function queryPosixProcesses(pids: readonly number[]): Promise<Map<number, ProcessRow>> {
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff))
    return Promise.reject(new Error("Invalid POSIX process identity"));
  const requested = [...new Set(pids)];
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-p", requested.join(","), "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
      { env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 16384 }, (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const rows = new Map<number, ProcessRow>();
          for (const line of stdout.trim().split("\n").filter(Boolean)) {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
            if (!match) throw new Error("Malformed POSIX process row");
            const [pid, parent, group] = match.slice(1).map(Number);
            if (![pid, parent, group].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) ||
                !group || !requested.includes(pid) || rows.has(pid))
              throw new Error("Unexpected POSIX process row");
            rows.set(pid, { pid, parent, group });
          }
          resolve(rows);
        } catch (error: unknown) { reject(error); }
      });
  });
}
