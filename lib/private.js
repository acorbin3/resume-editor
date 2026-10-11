// Private overlay loader. If a `private/` folder exists next to server.js (it is
// gitignored; keep it in its own private repo), its index.js is imported and its
// `install(app, ctx)` is called before the JSON body parser and auth middleware, so it
// can register raw-body webhooks and its own authenticated routes. Without the folder
// the app runs exactly as published.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "private");

export async function loadPrivate(app, ctx) {
  if (!existsSync(path.join(dir, "index.js"))) return null;
  const mod = await import(path.join(dir, "index.js"));
  const result = await mod.install(app, ctx);
  console.log(`Private overlay: ${result?.summary || "loaded"}`);
  return result;
}
