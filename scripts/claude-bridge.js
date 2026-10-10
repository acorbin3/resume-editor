// Claude bridge: a tiny HTTP wrapper around `claude -p` for running the app in Docker
// against the Claude Code login on this machine. Start it on the host:
//
//   npm run bridge            # listens on 127.0.0.1:4848
//
// and point the container at it with CLAUDE_BRIDGE_URL=http://host.docker.internal:4848
// (docker-compose.yml does this by default) plus the same CLAUDE_BRIDGE_TOKEN on both sides.
//
// This uses your personal Claude subscription. Anthropic's terms allow that for your own
// use, not for serving other people; use an API key for anything public.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { runClaudeCli, claudeCliAvailable } from "../lib/claude-cli.js";

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT) || 4848;
const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || "";
const MAX_BODY = 40 * 1024 * 1024;

if (!(await claudeCliAvailable())) {
  console.error("The `claude` CLI isn't on PATH. Install Claude Code and sign in first.");
  process.exit(1);
}
if (!TOKEN) {
  console.error(`Set CLAUDE_BRIDGE_TOKEN in .env (for example: ${randomBytes(16).toString("hex")}) and use the same value in the container.`);
  process.exit(1);
}

let running = 0;
const server = createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/healthz") return json(200, { ok: true, running });
  if (req.method !== "POST" || req.url !== "/run") return json(404, { error: "Not found" });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "Bad token" });

  let raw = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return json(413, { error: "Request too large" });
    raw += chunk;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Bad JSON" });
  }
  const files = (body.files || []).map((f) => ({ name: String(f.name), data: Buffer.from(String(f.data), "base64") }));
  const started = Date.now();
  running++;
  try {
    const result = await runClaudeCli({
      system: String(body.system || ""),
      prompt: String(body.prompt || ""),
      files,
      model: String(body.model || "claude-opus-5-5"),
      effort: String(body.effort || "medium"),
    });
    console.log(`${new Date().toISOString()} run ok ${Math.round((Date.now() - started) / 1000)}s ${files.length} file(s)`);
    json(200, result);
  } catch (err) {
    console.error(`${new Date().toISOString()} run failed: ${err.message}`);
    json(500, { error: err.message });
  } finally {
    running--;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude bridge listening on http://${HOST}:${PORT} (token required)`);
  console.log("Container side: CLAUDE_BRIDGE_URL=http://host.docker.internal:" + PORT);
});
