# Resume Editor

A small web app for rebuilding resumes in one consistent LaTeX template with Claude.

Upload a resume PDF. Claude rebuilds it in the house LaTeX template (Jake Gutierrez / sb2nov),
tectonic compiles it, and you tweak it with prompts while watching the PDF update.

## Setup

```bash
brew install tectonic poppler   # LaTeX compiler + pdftotext/pdfinfo
npm install                     # also builds the editor bundle
cp .env.example .env            # add ANTHROPIC_API_KEY, or leave it empty to use `claude -p`
npm start                       # http://localhost:3000
```

Needs Node 22+. Without an API key it shells out to [Claude Code](https://claude.com/claude-code)
(`claude -p`), so you need that installed and logged in.

## How it works

1. **Upload** a PDF, with optional first-pass instructions. `pdftotext -layout` extracts the text and Claude
   (Opus 5.5) turns it into a full `.tex` document using `template/template.tex` as the reference. If the PDF
   has little or no text (scanned or image-only), Claude reads the PDF itself instead.
2. **Compile** with tectonic. If compilation fails, the error log goes back to Claude for a fix
   (up to 2 tries). If "Keep it to one page" is checked and the result spills over, Claude tightens it once.
3. **Tweak** with prompts. Claude returns small find/replace edits (fast) or a full rewrite for big changes.
   The original resume text is sent along so you can ask to pull content back in.
   **Highlight text on the preview** to attach a comment to it. Comments queue up as numbered highlights
   and are added to your next prompt.
4. **Edit LaTeX by hand** in the code editor (Split or LaTeX view): syntax highlighting, line numbers,
   search (⌘F), and ⌘S to recompile. Compile errors are marked on the offending line.
   **Double-click** a word on the PDF to jump to its LaTeX line, or a line in the editor to flash its spot on
   the PDF. This uses the SyncTeX map tectonic writes on every compile (`v<N>.synctex.gz`).
5. **Versions**: every change is saved. Click any version to go back to it. Download the PDF or `.tex`.

Data lives in `data/<id>/` (source PDF, `vN.tex`, `vN.pdf`, `meta.json`).

## Files

- `server.js`: Express routes. Long operations stream NDJSON progress events.
- `lib/claude.js`: prompts and Claude calls (system prompt + template are prompt-cached).
- `lib/latex.js`: tectonic compile + page count.
- `lib/store.js`: on-disk storage.
- `public/`: the single-page UI. `public/syncmap.js` maps SyncTeX records to source lines and PDF rows.
- `editor/entry.js`: the CodeMirror setup, bundled to `public/vendor/editor.js`.
  After changing it, run `npm run build:editor`.
- `template/template.tex`: the house template. Edit this to change the look of every new resume.

## Config (.env)

- `ANTHROPIC_API_KEY`: optional. Without it, the app shells out to `claude -p` and uses your Claude Code login.
- `CLAUDE_MODEL`: default `claude-opus-5-5`.
- `CLAUDE_EFFORT`: `low` | `medium` (default) | `high`. Higher means better conversions but slower.
- `PORT`: default 3000 (this machine uses 4747).
- `HOST`: default `127.0.0.1`. The server only listens locally; the Cloudflare tunnel reaches it there.
- `APP_PASSWORD`: login password. If unset, there's no login (local use only).
- `SESSION_SECRET`: signs login cookies. Changing it signs everyone out.

## Running it as a service (macOS)

`deploy/` has examples for running it in the background and exposing it with a Cloudflare Tunnel:

1. Set `APP_PASSWORD` and `SESSION_SECRET` in `.env` (`openssl rand -hex 32` makes a good secret).
2. Copy `deploy/resume-editor.plist.example` to `~/Library/LaunchAgents/`, fill in the paths, and load it:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.resume-editor.plist`
   Restart after code or `.env` changes: `launchctl kickstart -k gui/$(id -u)/com.example.resume-editor`
3. Add the ingress rule from `deploy/cloudflared-ingress.example.yml` to your tunnel config, then route DNS:
   `cloudflared tunnel route dns <tunnel> resume.example.com`

The server only listens on `127.0.0.1`, so the tunnel is the only way in from outside.

## Security notes

- LaTeX can read files (`\input{...}`), so tectonic runs inside a macOS `sandbox-exec` profile that can't
  read or write your home folder (except tectonic's cache), with `--untrusted`.
- Without an API key, `claude -p` runs with no tools when it has text, or only Read inside a temp folder when it
  needs the PDF. Reads outside that folder are denied.
- Login attempts are limited to 10 failures per IP per 15 minutes.
- API-key requests use `fallbacks: "default"`, so if Claude declines a request, it's retried on a fallback model.

## License

MIT. The resume template is adapted from [sb2nov/resume](https://github.com/sb2nov/resume) and
Jake Gutierrez's resume template, both MIT licensed.
