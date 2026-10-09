import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Each resume is a folder under data/: meta.json, source.pdf, source.txt, v<N>.tex, v<N>.pdf, v<N>.synctex.gz
const DATA_DIR = path.resolve("data");

const dirFor = (id) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
  return path.join(DATA_DIR, id);
};

export async function createResume(sourcePdf, filename, sourceText = "") {
  const id = randomUUID();
  const dir = dirFor(id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "source.pdf"), sourcePdf);
  await writeFile(path.join(dir, "source.txt"), sourceText);
  const meta = {
    id,
    filename,
    name: filename.replace(/\.pdf$/i, ""),
    createdAt: new Date().toISOString(),
    current: 0,
    versions: [],
    messages: [],
  };
  await saveMeta(meta);
  return meta;
}

export async function getMeta(id) {
  return JSON.parse(await readFile(path.join(dirFor(id), "meta.json"), "utf8"));
}

export async function saveMeta(meta) {
  await writeFile(path.join(dirFor(meta.id), "meta.json"), JSON.stringify(meta, null, 2));
}

export async function deleteResume(id) {
  await rm(dirFor(id), { recursive: true, force: true });
}

// { text, pdf } for the uploaded original. text is "" for resumes uploaded before extraction existed.
export async function getSource(id) {
  const dir = dirFor(id);
  const pdf = await readFile(path.join(dir, "source.pdf"));
  const text = await readFile(path.join(dir, "source.txt"), "utf8").catch(() => "");
  return { text, pdf };
}

export async function addVersion(meta, { tex, pdf, synctex, pages, label }) {
  const n = meta.versions.length + 1;
  const dir = dirFor(meta.id);
  await writeFile(path.join(dir, `v${n}.tex`), tex);
  await writeFile(path.join(dir, `v${n}.pdf`), pdf);
  if (synctex) await writeFile(path.join(dir, `v${n}.synctex.gz`), synctex);
  meta.versions.push({ n, label, pages, createdAt: new Date().toISOString() });
  meta.current = n;
  await saveMeta(meta);
  return n;
}

export async function getTex(id, n) {
  return readFile(path.join(dirFor(id), `v${n}.tex`), "utf8");
}

export async function getSynctex(id, n) {
  return readFile(path.join(dirFor(id), `v${n}.synctex.gz`)).catch(() => null);
}

export async function saveSynctex(id, n, synctex) {
  await writeFile(path.join(dirFor(id), `v${n}.synctex.gz`), synctex);
}

export function pdfPath(id, n) {
  return path.join(dirFor(id), `v${n}.pdf`);
}

export async function listResumes() {
  await mkdir(DATA_DIR, { recursive: true });
  const out = [];
  for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const m = await getMeta(entry.name);
      out.push({ id: m.id, name: m.name, createdAt: m.createdAt, versions: m.versions.length });
    } catch {}
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
