// Zero-dependency static file server. Keeps the project build-free while still
// honouring the PORT that a host such as Railway injects.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "0.0.0.0";

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

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("Method not allowed");
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

server.listen(PORT, HOST, () => {
  console.log(`Chat Chat Revolution serving on http://${HOST}:${PORT}`);
});
