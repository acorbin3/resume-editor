import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./db.js";

// Content-addressed store for binary artifacts (uploaded PDFs, rendered PDFs, SyncTeX).
// Keys are sha256 hex, so identical content is stored once and nothing is ever
// overwritten. Replace put/get/pathFor with S3/R2 calls to move off local disk.
const ROOT = path.join(DATA_DIR, "blobs");

export const keyFor = (buf) => createHash("sha256").update(buf).digest("hex");

export function pathFor(key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("bad blob key");
  return path.join(ROOT, key.slice(0, 2), key);
}

export async function put(buf) {
  const key = keyFor(buf);
  const p = pathFor(key);
  try {
    await access(p);
  } catch {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, buf);
  }
  return key;
}

export const get = (key) => readFile(pathFor(key));

// Deletes every blob whose key isn't in `keep`. Called after a user deletes their data so
// nothing of theirs lingers on disk; content shared with another user's resume is kept
// because it is still referenced.
export async function sweep(keep) {
  let removed = 0;
  let dirs = [];
  try {
    dirs = await readdir(ROOT);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const key of await readdir(path.join(ROOT, d)).catch(() => [])) {
      if (/^[0-9a-f]{64}$/.test(key) && !keep.has(key)) {
        await unlink(path.join(ROOT, d, key)).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}
