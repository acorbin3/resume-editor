// Keyword matching shared by the server (scores) and the browser (live score as the
// user accepts suggestions). Pure functions, no DOM, no Node APIs.

// Rough plain text of a LaTeX body: commands dropped, their brace arguments kept,
// escapes undone. Good enough for "does this phrase appear in the resume".
export function texToPlain(tex) {
  let body = tex.includes("\\begin{document}") ? tex.slice(tex.indexOf("\\begin{document}")) : tex;
  body = body
    .replace(/(^|[^\\])%.*$/gm, "$1") // comments
    .replace(/\\\\/g, "\n")
    // Commands whose arguments are layout, not content.
    .replace(/\\(?:begin|end|vspace|hspace|color|setlength|addtolength|pagestyle|input|include|label|ref|hypersetup|fontsize)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g, " ")
    .replace(/\\(?:href|url)\{[^}]*\}/g, " ") // drop link targets, keep link text (next brace group stays)
    .replace(/\$[^$]{0,3}\$/g, " ") // tiny math like $|$ separators
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, " ") // \command[opt]
    .replace(/\\([$%#&_{}])/g, "$1")
    .replace(/[{}]/g, " ")
    .replace(/~/g, " ")
    .replace(/--/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return body;
}

const norm = (s) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-phrase match, tolerant of punctuation and spacing variants ("Node.js" ~ "NodeJS",
// "CI/CD" ~ "CI CD", "front-end" ~ "frontend").
export function hasKeyword(plainLower, term) {
  const t = norm(term);
  if (!t) return false;
  const loose = (s) => s.replace(/[\s.\-\/]+/g, "");
  const pattern = t
    .split(/[\s.\-\/]+/)
    .filter(Boolean)
    .map(esc)
    .join("[\\s.\\-\\/]*");
  const bounded = new RegExp(`(^|[^a-z0-9+#])${pattern}(?![a-z0-9])`, "i");
  if (bounded.test(plainLower)) return true;
  // Very short terms (C, Go, R) need the boundary check above; longer ones can fall back to a loose match.
  return t.length >= 6 && loose(plainLower).includes(loose(t));
}

// { pct, present: [...], missing: [...] } for a keyword list against a LaTeX document.
export function scoreKeywords(keywords, tex) {
  const plain = norm(texToPlain(tex));
  const present = [];
  const missing = [];
  for (const k of keywords) (hasKeyword(plain, k) ? present : missing).push(k);
  const total = present.length + missing.length;
  return { pct: total ? Math.round((present.length / total) * 100) : 0, present, missing };
}
