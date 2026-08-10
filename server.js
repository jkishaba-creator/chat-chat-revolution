// Zero-dependency static file server. Keeps the project build-free while still
// honouring the PORT that a host such as Railway injects.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./", import.meta.url)));

// Load .env if present, without a dependency. Real environment variables always
// win, so a host like Railway overrides the local file rather than the reverse.
function loadEnvFile() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "0.0.0.0";

// Chat mode is opt-in. With CHAT_SOURCE unset the server stays a pure static
// host and the solo game behaves exactly as before.
const CHAT_SOURCE = process.env.CHAT_SOURCE || "off";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Returns an absolute path inside ROOT, or null when the request is malformed
// or tries to escape the project directory.
function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null; // Malformed percent-encoding, e.g. "/%".
  }
  if (decoded.includes("\0")) return null;

  const rel = normalize(decoded);
  const full = join(ROOT, rel === "/" || rel === sep ? "index.html" : rel);
  return full === ROOT || full.startsWith(ROOT + sep) ? full : null;
}

let bridge = null;

async function startBridge() {
  if (CHAT_SOURCE === "off") return null;

  const { ChatBridge } = await import("./chat/bridge.js");
  let source;

  if (CHAT_SOURCE === "mock") {
    const { createMockSource } = await import("./chat/sources/mock.js");
    source = createMockSource();
  } else if (CHAT_SOURCE === "youtube") {
    const { createYouTubeSource } = await import("./chat/sources/youtube.js");
    source = createYouTubeSource({
      apiKey: process.env.YOUTUBE_API_KEY,
      video: process.env.YOUTUBE_VIDEO,
      dailyQuotaBudget: Number(process.env.YOUTUBE_QUOTA_BUDGET) || 9000,
    });
  } else {
    throw new Error(`Unknown CHAT_SOURCE ${JSON.stringify(CHAT_SOURCE)}. Use off, mock or youtube.`);
  }

  const started = new ChatBridge({ source });
  await started.start();
  console.log(`Chat bridge running on source "${source.name}"`);
  return started;
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  const path = (req.url || "/").split("?")[0];

  if (path === "/api/status") {
    const body = JSON.stringify(bridge ? bridge.status() : { source: "off", connected: false });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  if (path === "/api/stream") {
    if (!bridge) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Chat mode is off");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const remove = bridge.addClient(res);
    // Proxies drop idle streams, so send a comment heartbeat.
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    const cleanup = () => {
      clearInterval(beat);
      remove();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    return;
  }

  const file = safePath(req.url || "/");
  if (!file) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    const notFound = error.code === "ENOENT" || error.code === "EISDIR";
    if (!notFound) console.error(`500 ${req.url}:`, error.message);
    // Headers may already be out if the failure happened mid-response.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(notFound ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(notFound ? "Not found" : "Internal server error");
  }
});

// A single malformed request must never take the game offline.
server.on("clientError", (error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(PORT, HOST, async () => {
  console.log(`Chat Chat Revolution serving on http://${HOST}:${PORT}`);
  try {
    bridge = await startBridge();
  } catch (error) {
    // A bad chat config must not take the game offline; solo play still works.
    console.error(`Chat bridge failed to start: ${error.message}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (bridge) bridge.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
