// Import resumes from the pre-database layout (data/<uuid>/meta.json, source.pdf,
// vN.tex, vN.pdf, vN.synctex.gz) into the SQLite + git + blob store, owned by one user.
//
//   node --no-warnings=ExperimentalWarning scripts/migrate-legacy.js you@example.com
//
// The user must already exist (sign up in the app first). Migrated folders are moved
// to data/legacy-imported/ so the script is safe to re-run.
import { readdir, readFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { db, DATA_DIR } from "../lib/db.js";
import * as store from "../lib/store.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/migrate-legacy.js <email of the owning account>");
  process.exit(1);
}
const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!user) {
  console.error(`No account for ${email}. Create it in the app first.`);
  process.exit(1);
}

const done = path.join(DATA_DIR, "legacy-imported");
await mkdir(done, { recursive: true });
let count = 0;
for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
  const dir = path.join(DATA_DIR, entry.name);
  let legacy;
  try {
    legacy = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
  } catch {
    continue;
  }
  const sourcePdf = await readFile(path.join(dir, "source.pdf"));
  const sourceText = await readFile(path.join(dir, "source.txt"), "utf8").catch(() => "");
  const meta = await store.createResume(user.id, sourcePdf, legacy.filename || `${legacy.name}.pdf`, sourceText);
  for (const v of legacy.versions) {
    const tex = await readFile(path.join(dir, `v${v.n}.tex`), "utf8");
    const pdf = await readFile(path.join(dir, `v${v.n}.pdf`));
    const synctex = await readFile(path.join(dir, `v${v.n}.synctex.gz`)).catch(() => null);
    await store.addVersion(meta, { tex, pdf, synctex, pages: v.pages, label: v.label });
  }
  store.addMessages(meta, legacy.messages || []);
  store.setCurrent(meta, legacy.current || meta.versions.length);
  await rename(dir, path.join(done, entry.name));
  console.log(`Imported "${legacy.name}" (${legacy.versions.length} versions) as ${meta.id}`);
  count++;
}
console.log(count ? `Done: ${count} resume(s) now owned by ${email}.` : "Nothing to import.");
