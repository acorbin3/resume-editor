import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./db.js";

const run = promisify(execFile);

// One git repository per resume, holding a single file, resume.tex. Every saved
// version is a commit; the versions table maps version numbers to commit SHAs.
// Git gives history, diffs, and revert for free, and leaves room for branches
// (tailored variants per job) later.
const ROOT = path.join(DATA_DIR, "repos");

const dirFor = (resumeId) => {
  if (!/^[0-9a-f-]{36}$/.test(resumeId)) throw new Error("bad resume id");
  return path.join(ROOT, resumeId);
};

// Author identity for commits; nothing user-identifying goes into git metadata.
const ENV = { ...process.env, GIT_AUTHOR_NAME: "resume-editor", GIT_AUTHOR_EMAIL: "resume-editor@localhost", GIT_COMMITTER_NAME: "resume-editor", GIT_COMMITTER_EMAIL: "resume-editor@localhost" };

async function git(dir, args) {
  const { stdout } = await run("git", args, { cwd: dir, env: ENV, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

export async function init(resumeId) {
  const dir = dirFor(resumeId);
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

// Commit a new resume.tex and return the commit SHA.
export async function commit(resumeId, tex, message) {
  const dir = dirFor(resumeId);
  await writeFile(path.join(dir, "resume.tex"), tex);
  await git(dir, ["add", "resume.tex"]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", message || "Update"]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

export async function read(resumeId, sha) {
  return git(dirFor(resumeId), ["show", `${sha}:resume.tex`]);
}

export async function remove(resumeId) {
  await rm(dirFor(resumeId), { recursive: true, force: true });
}
