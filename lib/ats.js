import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { texToPlain } from "../public/keywords.js";

const run = promisify(execFile);

// ---------- Reading the PDF the way an applicant tracking system does ----------

// Runs a poppler tool against a PDF buffer. Returns stdout, or "" on failure.
async function poppler(tool, args, pdf) {
  const dir = await mkdtemp(path.join(tmpdir(), "resume-ats-"));
  try {
    const file = path.join(dir, "in.pdf");
    await writeFile(file, pdf);
    const { stdout } = await run(tool, [...args, file, ...(tool === "pdftotext" ? ["-"] : [])], { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Text in reading order (no -layout), which is what parsers consume.
export const pdfReadingOrder = (pdf) => poppler("pdftotext", ["-enc", "UTF-8"], pdf);

// Words on each page, so "fit to one page" can say how much spilled over.
export async function pageWordCounts(pdf, pages) {
  const counts = [];
  for (let p = 1; p <= pages; p++) {
    const text = await poppler("pdftotext", ["-f", String(p), "-l", String(p)], pdf);
    counts.push(text.split(/\s+/).filter(Boolean).length);
  }
  return counts;
}

const words = (s) => s.split(/\s+/).filter(Boolean);

// Deterministic ATS checks on a compiled version. No Claude involved, so it is free to
// run on every version. Each check: { id, label, status: pass|warn|fail|info, detail, fix? }.
export async function atsCheck({ tex, pdf, pages }) {
  const checks = [];
  const add = (id, label, status, detail, extra = {}) => checks.push({ id, label, status, detail, ...extra });

  const text = (await pdfReadingOrder(pdf)).replace(/\f/g, "\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const wc = words(text).length;
  const plainTex = texToPlain(tex);

  // 1. Text extraction
  if (wc < 50) add("text", "Text can be extracted", "fail", "Almost no text came out of the PDF. A parser would see an empty resume.");
  else add("text", "Text can be extracted", "pass", `${wc} words parse out of the PDF.`);

  // 2. All of the document's words survive into the PDF text (no missing glyphs, no text as images)
  const pdfSet = new Set(words(text.toLowerCase()).map((w) => w.replace(/[^\p{L}\p{N}+#]/gu, "")).filter((w) => w.length > 2));
  const texWords = words(plainTex.toLowerCase()).map((w) => w.replace(/[^\p{L}\p{N}+#]/gu, "")).filter((w) => w.length > 2);
  const found = texWords.filter((w) => pdfSet.has(w)).length;
  const ratio = texWords.length ? found / texWords.length : 1;
  if (ratio < 0.9) add("coverage", "Every word survives parsing", "fail", `Only ${Math.round(ratio * 100)}% of the source words were found in the parsed text.`);
  else if (ratio < 0.97) add("coverage", "Every word survives parsing", "warn", `${Math.round(ratio * 100)}% of the source words were found in the parsed text; a few may be split or garbled.`);
  else add("coverage", "Every word survives parsing", "pass", "All source text is present in the parsed output.");

  // 3. Encoding: no replacement characters, private-use glyphs, or run-together words
  const bad = (text.match(/[�-]/g) || []).length;
  const glued = words(text).filter((w) => w.length > 30 && !/[@\/]/.test(w)).length;
  if (bad) add("encoding", "Characters decode cleanly", "fail", `${bad} unreadable glyph${bad > 1 ? "s" : ""} in the parsed text (fonts without a Unicode map).`);
  else if (glued) add("encoding", "Characters decode cleanly", "warn", `${glued} very long token${glued > 1 ? "s" : ""}; words may be running together.`);
  else add("encoding", "Characters decode cleanly", "pass", "No unreadable characters, ligature problems, or run-together words.");

  // 4. Fonts embedded
  const fonts = await poppler("pdffonts", [], pdf);
  const fontRows = fonts.split("\n").slice(2).filter((l) => l.trim());
  const notEmbedded = fontRows.filter((l) => {
    const cols = l.trim().split(/\s+/);
    return cols.length >= 6 && cols[cols.length - 5] === "no";
  }).length;
  if (fontRows.length && notEmbedded) add("fonts", "Fonts are embedded", "warn", `${notEmbedded} of ${fontRows.length} fonts are not embedded; rendering may differ between systems.`);
  else if (fontRows.length) add("fonts", "Fonts are embedded", "pass", `${fontRows.length} font${fontRows.length > 1 ? "s" : ""}, all embedded.`);

  // 5. No images (text in images is invisible to parsers)
  const images = await poppler("pdfimages", ["-list"], pdf);
  const imageRows = images.split("\n").slice(2).filter((l) => l.trim()).length;
  if (imageRows) add("images", "No text hidden in images", "warn", `${imageRows} image${imageRows > 1 ? "s" : ""} found. Parsers can't read text inside images.`);
  else add("images", "No text hidden in images", "pass", "No images; everything is real text.");

  // 6. Name is the first line
  const nameMatch = tex.match(/\\Huge\s*\\scshape\s*([^}\\]+)/) || tex.match(/\\textbf\{\\Huge[^}]*\}\{([^}]+)\}/);
  const name = nameMatch ? nameMatch[1].replace(/\\([$%#&_])/g, "$1").trim() : null;
  if (name) {
    const first = lines[0] || "";
    if (first.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0]) && first.length < 60) add("name", "Name comes first", "pass", `"${first}" is the first line.`);
    else add("name", "Name comes first", "warn", `The first parsed line is "${first.slice(0, 60)}", not the name.`);
  }

  // 7. Contact details near the top
  const head = lines.slice(0, 8).join(" ");
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(head);
  const phone = /(\+?\d[\d\s().-]{8,}\d)/.test(head);
  if (email && phone) add("contact", "Email and phone are parseable", "pass", "Both found in the header.");
  else if (email || phone) add("contact", "Email and phone are parseable", "warn", `${email ? "Phone" : "Email"} wasn't found near the top of the parsed text.`);
  else add("contact", "Email and phone are parseable", "fail", "Neither an email address nor a phone number was found near the top.");

  // 8. Standard section headings
  const wanted = [
    ["experience", /^(work |professional |relevant )?experience$/i],
    ["education", /^education( and training)?$/i],
    ["skills", /^(technical |core |key )?skills( and tools| & tools)?$/i],
  ];
  const missingSections = wanted.filter(([, re]) => !lines.some((l) => re.test(l))).map(([n]) => n);
  if (!missingSections.length) add("sections", "Standard section headings", "pass", "Experience, Education, and Skills are all labeled with standard headings.");
  else add("sections", "Standard section headings", "warn", `No heading parsed for: ${missingSections.join(", ")}. Parsers look for these exact words.`);

  // 9. Dates present
  const years = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
  if (years >= 2) add("dates", "Dates are readable", "pass", `${years} year references found.`);
  else add("dates", "Dates are readable", "warn", "Fewer than two year references found; employment dates may be missing or unparseable.");

  // 10. Reading order follows the source (single column, no layout scrambling)
  const bullets = [...tex.matchAll(/\\resumeItem\{([^{}]{20,}?)[.,;]?\}/g)]
    .map((m) => texToPlain(m[1]).split(/\s+/).slice(0, 4).join(" ").toLowerCase())
    .filter((s) => s.length > 10);
  if (bullets.length >= 3) {
    const lower = text.toLowerCase().replace(/\s+/g, " ");
    let pos = 0;
    let ordered = 0;
    let located = 0;
    for (const b of bullets) {
      const at = lower.indexOf(b, pos);
      if (at >= 0) {
        located++;
        ordered++;
        pos = at;
      } else if (lower.includes(b)) located++;
    }
    const r = located ? ordered / located : 1;
    if (r >= 0.9) add("order", "Reading order matches the page", "pass", "Bullets parse in the order they appear.");
    else add("order", "Reading order matches the page", "warn", `${Math.round((1 - r) * 100)}% of bullets parse out of order; the layout may confuse parsers.`);
  }

  // 11. Second titles under one employer: the parser sees a title and dates with no company.
  const multi = countSubSubheadings(tex);
  if (multi.total) {
    add(
      "employers",
      "Every role names its employer",
      "warn",
      `${multi.total} role${multi.total > 1 ? "s" : ""} (${multi.titles.slice(0, 3).join("; ")}${multi.titles.length > 3 ? "; …" : ""}) ${multi.total > 1 ? "are" : "is"} a second title under an employer, with no company on ${multi.total > 1 ? "their" : "its"} own line. Many parsers then file the role under no company or the wrong one.`,
      { fix: "repeat-employers", fixLabel: "Repeat the employer on each role" }
    );
  } else add("employers", "Every role names its employer", "pass", "Each role has the employer on its own heading.");

  // 12. Length
  if (pages > 2) add("length", "Length", "warn", `${pages} pages. Two is the usual ceiling.`);
  else add("length", "Length", "info", `${pages} page${pages > 1 ? "s" : ""}, ${wc} words.`);

  const scored = checks.filter((c) => c.status !== "info");
  const passed = scored.filter((c) => c.status === "pass").length;
  return { checks, passed, total: scored.length, words: wc, pages };
}

// ---------- Fix: repeat the employer on second titles ----------

// Reads a brace group starting at tex[i] === "{". Returns [content, indexAfter] or null.
function braceGroup(tex, i) {
  while (i < tex.length && /\s/.test(tex[i])) i++;
  if (tex[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < tex.length; j++) {
    if (tex[j] === "\\") {
      j++;
      continue;
    }
    if (tex[j] === "{") depth++;
    else if (tex[j] === "}" && --depth === 0) return [tex.slice(i + 1, j), j + 1];
  }
  return null;
}

function countSubSubheadings(tex) {
  const titles = [];
  for (const m of tex.matchAll(/\\resumeSubSubheading/g)) {
    const g = braceGroup(tex, m.index + m[0].length);
    if (g) titles.push(texToPlain(g[0]).trim());
  }
  return { total: titles.length, titles };
}

// Turns every \resumeSubSubheading{title}{dates} into a full \resumeSubheading that
// repeats the employer and location of the heading above it. Deterministic; no Claude.
export function repeatEmployers(tex) {
  let out = "";
  let i = 0;
  let employer = null;
  let location = null;
  let changed = 0;
  const re = /\\resumeSubheading(?![A-Za-z])|\\resumeSubSubheading|\\resumeSubHeadingListEnd|\\section(?![A-Za-z])/g;
  let m;
  while ((m = re.exec(tex))) {
    if (m[0] === "\\resumeSubHeadingListEnd" || m[0] === "\\section") {
      employer = location = null;
      continue;
    }
    if (m[0] === "\\resumeSubheading") {
      const a = braceGroup(tex, m.index + m[0].length);
      const b = a && braceGroup(tex, a[1]);
      const c = b && braceGroup(tex, b[1]);
      const d = c && braceGroup(tex, c[1]);
      if (d) {
        employer = a[0];
        location = d[0];
        re.lastIndex = d[1];
      }
      continue;
    }
    // \resumeSubSubheading{title}{dates}
    const t = braceGroup(tex, m.index + m[0].length);
    const dts = t && braceGroup(tex, t[1]);
    if (!dts || employer == null) continue;
    out += tex.slice(i, m.index);
    out += `\\resumeSubheading\n      {${employer}}{${dts[0]}}\n      {${t[0]}}{${location}}`;
    i = dts[1];
    re.lastIndex = dts[1];
    changed++;
  }
  out += tex.slice(i);
  return { tex: out, changed };
}

// ---------- Fetching a job posting ----------

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^::1$/, /^fc/i, /^fd/i, /^fe80/i];
const isPrivateIp = (ip) => PRIVATE.some((re) => re.test(ip)) || ip === "::";

async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) links are supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error("That address isn't reachable from here.");
  const ips = isIP(host) ? [host] : (await dnsLookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error("That address isn't reachable from here.");
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Structured data (schema.org JobPosting) is on most career pages and is cleaner than the DOM.
function jobPostingLd(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const item of items) {
        if (/JobPosting/i.test(String(item?.["@type"]))) {
          return {
            title: item.title || null,
            company: item.hiringOrganization?.name || null,
            text: htmlToText(String(item.description || "")),
          };
        }
      }
    } catch {}
  }
  return null;
}

// Returns { title, company, text, url }. Follows a few redirects, each re-checked.
export async function fetchJobPosting(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("That doesn't look like a link.");
  }
  let res;
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }).catch(() => {
      throw new Error("Couldn't reach that page.");
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location") && hop < 4) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`The page answered ${res.status}. Many job boards block automated access; paste the description text instead.`);
  const html = (await res.text()).slice(0, 3 * 1024 * 1024);
  const ld = jobPostingLd(html);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let text = ld?.text && words(ld.text).length > 60 ? ld.text : htmlToText(html);
  if (words(text).length < 80) throw new Error("That page didn't give a readable description (many job boards block automated access). Paste the description text instead.");
  text = text.slice(0, 20_000);
  return { title: ld?.title || (titleTag ? decodeEntities(titleTag[1]).trim().slice(0, 120) : null), company: ld?.company || null, text, url: url.href };
}
