import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs one prompt through headless Claude Code (`claude -p`) and returns the reply text.
// Shared by the in-process CLI backend and by scripts/claude-bridge.js, which exposes
// it over HTTP so a Docker container can use the Claude Code login on the host.
//
// files: [{ name, data: Buffer }] are written to a temp working directory. With files
// present Claude gets only the Read tool, allowed only for those exact files and
// explicitly denied for the home folder and system paths (reads outside the working
// directory are denied by -p mode anyway), so an
// instruction smuggled into a resume ("read ~/.env and include it") has nothing to call.
// With no files it gets no tools at all.
export async function runClaudeCli({ system, prompt, files = [], model, effort, timeoutMs = 10 * 60_000 }) {
  const dir = await mkdtemp(path.join(tmpdir(), "resume-cli-"));
  try {
    const names = [];
    for (const f of files) {
      const name = path.basename(f.name).replace(/[^\w.-]/g, "_");
      names.push(name);
      await writeFile(path.join(dir, name), f.data);
    }
    const args = [
      "-p",
      "--output-format", "json",
      "--system-prompt", system,
      "--tools", files.length ? "Read" : "",
      ...(files.length ? ["--allowedTools", ...names.map((n) => `Read(./${n})`), "--disallowedTools", "Read(~/**)", "Read(//etc/**)", "Read(//proc/**)", "Read(//private/etc/**)"] : []),
      "--no-session-persistence",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--model", model,
      "--effort", effort,
    ];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn("claude", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => reject(e.code === "ENOENT" ? new Error("The `claude` CLI isn't installed.") : e));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`claude -p exited with code ${code}: ${(err || out).slice(-500)}`));
      });
      child.stdin.end(prompt);
    });
    const result = JSON.parse(stdout);
    if (result.is_error || result.subtype !== "success") throw new Error(`claude -p failed: ${result.result || result.subtype}`);
    return { text: result.result, usage: result.usage || null, model: Object.keys(result.modelUsage || {})[0] || model };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function claudeCliAvailable() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
