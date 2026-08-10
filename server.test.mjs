/**
 * Guards the static server's file exposure rules.
 *
 * server.js hosts its own project directory, which is where .env lives once
 * chat mode is configured, so "is this file reachable over HTTP" is a security
 * question, not a cosmetic one. Run with: npm run test:server
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = "AIzaCANARY_NOT_A_REAL_KEY_000000000000";
const envPath = new URL("./.env", import.meta.url).pathname;

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
};

// Only create a throwaway .env when the developer does not already have one.
const hadEnv = existsSync(envPath);
if (!hadEnv) writeFileSync(envPath, `YOUTUBE_API_KEY=${CANARY}\n`, { mode: 0o600 });

const child = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CHAT_SOURCE: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});

const ready = new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => { if (String(d).includes("serving")) resolve(); });
  child.stderr.on("data", (d) => reject(new Error(String(d))));
  setTimeout(() => reject(new Error("server did not start")), 8000);
});

try {
  await ready;

  const get = async (path) => {
    const res = await fetch(BASE + path, { redirect: "manual" });
    return { status: res.status, body: await res.text() };
  };

  console.log("private files are not served");
  for (const path of [
    "/.env", "/.env.example", "/.gitignore", "/.git/config",
    "/%2e%65nv", "/foo/../.env", "/./.env", "/.ENV",
  ]) {
    const { status, body } = await get(path);
    check(`${path} is refused`, status >= 400, `status=${status}`);
    check(`${path} leaks no key`, !body.includes("AIza"), "response contained a key-shaped string");
  }

  console.log("\ngame files are still served");
  for (const path of ["/", "/index.html", "/live.html", "/styles.css", "/src/main.js", "/chat/bridge.js"]) {
    const { status } = await get(path);
    check(`${path} is served`, status === 200, `status=${status}`);
  }

  console.log("\nmalformed requests do not crash the server");
  for (const path of ["/%", "/%zz", "/foo%00.js"]) {
    const { status } = await get(path);
    check(`${path} handled`, status >= 400, `status=${status}`);
  }
  const alive = await get("/");
  check("still serving after malformed burst", alive.status === 200, `status=${alive.status}`);
} finally {
  child.kill("SIGTERM");
  if (!hadEnv) rmSync(envPath, { force: true });
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall server checks passed");
process.exit(failures ? 1 : 0);
