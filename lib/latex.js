import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { assertSafeTex } from "./texguard.js";

const run = promisify(execFile);

// LaTeX can read any file it can open (\\input{...}), and resume content comes from
// uploads and Claude. Compile inside a macOS sandbox that can't read or write the
// home folder, except tectonic's package cache. Compiles run in the system temp dir.
const HOME = homedir();
const SANDBOX = `(version 1)
(allow default)
(deny file-read-data file-write* (subpath "${HOME}"))
(allow file-read-data file-write* (subpath "${HOME}/Library/Caches/TectonicProject.Tectonic"))`;
const useSandbox = process.platform === "darwin";

// Compile a .tex string with tectonic. Returns { ok, pdf, synctex, pages, log }.
export async function compileTex(tex) {
  assertSafeTex(tex); // no file access, code execution, or command obfuscation, whoever wrote it
  const dir = await mkdtemp(path.join(tmpdir(), "resume-"));
  try {
    const texPath = path.join(dir, "resume.tex");
    await writeFile(texPath, tex);
    let log = "";
    try {
      const args = ["--chatter", "minimal", "--untrusted", "--synctex", "resume.tex"];
      const r = await run(useSandbox ? "sandbox-exec" : "tectonic", useSandbox ? ["-p", SANDBOX, "tectonic", ...args] : args, {
        cwd: dir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      log = r.stdout + r.stderr;
    } catch (err) {
      log = (err.stdout || "") + (err.stderr || "") || String(err);
      return { ok: false, log: trimLog(log) };
    }
    const pdf = await readFile(path.join(dir, "resume.pdf"));
    const synctex = await readFile(path.join(dir, "resume.synctex.gz")).catch(() => null);
    const pages = await countPages(path.join(dir, "resume.pdf"));
    return { ok: true, pdf, synctex, pages, log: trimLog(log) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function countPages(pdfPath) {
  try {
    const { stdout } = await run("pdfinfo", [pdfPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Parse a gzipped SyncTeX file into records for the main input file:
// [page, line, x, y, w, h, d] in PDF points from the page's top-left (y is the baseline).
// Boxes have w/h/d; point records (kerns, glue, current points) have w = h = d = 0.
const SP_PER_BP = 65781.76;
export function parseSynctex(gz) {
  const text = gunzipSync(gz).toString("utf8");
  const lines = text.split("\n");
  let unit = 1;
  let mainTag = "1";
  let i = 0;
  for (; i < lines.length && lines[i] !== "Content:"; i++) {
    const l = lines[i];
    if (l.startsWith("Unit:")) unit = Number(l.slice(5)) || 1;
    const m = l.match(/^Input:(\d+):(.*)$/);
    if (m && m[2].endsWith("resume.tex")) mainTag = m[1];
  }
  const scale = unit / SP_PER_BP;
  const round = (v) => Math.round(v * scale * 100) / 100;
  const out = [];
  let page = 0;
  const rec = /^[\[(vhxkg$](\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l[0] === "{") {
      page = Number(l.slice(1));
      continue;
    }
    const m = l.match(rec);
    if (!m || m[1] !== mainTag) continue;
    const [, , line, x, y, w = 0, h = 0, d = 0] = m;
    out.push([page, Number(line), round(x), round(y), round(w), round(h), round(d)]);
  }
  return out;
}

// Keep the error-relevant tail so it fits in a prompt.
function trimLog(log) {
  const lines = log.split("\n");
  const errIdx = lines.findIndex((l) => l.startsWith("error:") || l.startsWith("!"));
  const slice = errIdx >= 0 ? lines.slice(Math.max(0, errIdx - 5), errIdx + 40) : lines.slice(-60);
  return slice.join("\n").slice(0, 6000);
}

// Plain-text version of a PDF (keeps column layout). Returns "" if extraction fails.
export async function pdfToText(pdfBuffer) {
  const dir = await mkdtemp(path.join(tmpdir(), "resume-txt-"));
  try {
    await writeFile(path.join(dir, "in.pdf"), pdfBuffer);
    const { stdout } = await run("pdftotext", ["-layout", "in.pdf", "-"], { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
    return stdout.replace(/\f/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkTools() {
  const missing = [];
  for (const [bin, args] of [["tectonic", ["--version"]], ["pdfinfo", ["-v"]], ["pdftotext", ["-v"]]]) {
    try {
      await run(bin, args);
    } catch (err) {
      if (err.code === "ENOENT") missing.push(bin);
    }
  }
  return missing;
}
