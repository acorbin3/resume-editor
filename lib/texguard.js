// Defense in depth for untrusted LaTeX and model output.
//
// Resume PDFs, job postings, and prompts are attacker-controlled, and Claude writes the
// LaTeX that we then compile. The compiler already runs restricted (tectonic --untrusted,
// plus a macOS sandbox that denies the home folder), but TeX has many ways to read files
// and reach the environment, so the document is also screened before it is compiled:
// anything that can open a file, run code, or obfuscate a command name is rejected
// outright. A resume never needs these.
//
// Secret-looking strings are also scrubbed from model output before it is stored or
// shown, in case an injected instruction got the model to echo something it saw.

const PREAMBLE_PACKAGES = new Set([
  "latexsym", "fullpage", "titlesec", "marvosym", "color", "xcolor", "verbatim", "enumitem", "hyperref",
  "fancyhdr", "babel", "tabularx", "fontenc", "inputenc", "geometry", "fontspec", "lmodern", "microtype",
  "amsmath", "amssymb", "graphicx", "charter", "helvet", "times", "mathptmx", "sourcesanspro", "roboto",
  "lato", "opensans", "noto", "libertine", "newtxtext", "newtxmath", "FiraSans", "setspace", "ragged2e",
  "multicol", "array", "booktabs", "xstring", "etoolbox", "pifont", "fontawesome5", "fontawesome", "academicons",
]);

// TeX primitives and macros that read or write files, run code, or hide what is being called.
const FORBIDDEN = [
  "input", "include", "InputIfFileExists", "@input", "openin", "openout", "read", "readline", "write", "immediate",
  "closein", "closeout", "jobname", "dump", "directlua", "latelua", "luaexec", "ShellEscape", "ShellEscapeWarning",
  "write18", "special", "pdffiledump", "pdffilesize", "pdffilemoddate", "pdfmdfivesum", "pdfshellescape",
  "pdfobj", "pdfannot", "pdfximage", "pdfrefximage", "includegraphics", "verbatiminput", "lstinputlisting",
  "csname", "expandafter", "scantokens", "catcode", "makeatletter", "lowercase", "uppercase", "detokenize",
  "openinput", "inputlineno", "filename", "CurrentFile", "import", "subimport", "subfile", "externaldocument",
  "lstset", "DeclareFontShape", "font", "iffileexists",
];
const forbiddenRe = new RegExp(`\\\\(?:${FORBIDDEN.map((c) => c.replace(/[@]/g, "\\$&")).join("|")})(?![A-Za-z@])`, "i");

// The one file read the template legitimately makes (pdfTeX's Unicode glyph map).
const ALLOWED_INPUTS = /\\input\{glyphtounicode\}/g;

export function checkTex(tex) {
  const noComments = tex.replace(/(^|[^\\])%.*$/gm, "$1").replace(ALLOWED_INPUTS, " ");
  if (/\^\^/.test(noComments)) return "the ^^ character escape";
  const m = noComments.match(forbiddenRe);
  if (m) return `\\${m[0].slice(1)}`;
  for (const pkg of noComments.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    for (const name of pkg[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!PREAMBLE_PACKAGES.has(name)) return `package "${name}"`;
    }
  }
  if (/\\(?:documentclass|usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*[\/.]/.test(noComments)) return "a class or package loaded by path";
  return null;
}

// Throws if the document uses anything a resume shouldn't.
export function assertSafeTex(tex) {
  const bad = checkTex(tex);
  if (bad) {
    const err = new Error(`The LaTeX uses ${bad}, which isn't allowed here. Resumes only need the template's commands.`);
    err.status = 422;
    throw err;
  }
}

// Patterns of common credentials. Replaced before output is stored or shown.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g, // Google OAuth secret
  /\bphc_[A-Za-z0-9]{30,}\b/g, // PostHog
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*["']?[A-Za-z0-9_\-\/+=.]{16,}/gi,
];

export function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
