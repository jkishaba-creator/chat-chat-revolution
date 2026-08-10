import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("http://localhost:4173/index.html", { waitUntil: "networkidle" });

await page.waitForFunction(() => window.ccr?.game.phase === "plan");
await page.fill("#say", "rru");
await page.waitForTimeout(500);
await page.screenshot({ path: ".polariumcode/screenshots/plan-path.png" });

await page.evaluate(() => { window.ccr.game.round = 9; });
await page.waitForFunction(() => window.ccr.game.phase === "plan" && window.ccr.game.round >= 10, null, { timeout: 40000 });
await page.waitForTimeout(700);
await page.screenshot({ path: ".polariumcode/screenshots/late-round.png" });

await page.waitForFunction(() => window.ccr.game.phase === "impact", null, { timeout: 40000 });
await page.waitForTimeout(560);
await page.screenshot({ path: ".polariumcode/screenshots/impact.png" });

// Force the endgame: leave one bot standing, then let the round resolve.
await page.evaluate(() => {
  const g = window.ccr.game;
  g.players.filter((p) => p.bot).slice(2).forEach((p) => { p.alive = false; p.spectating = true; });
});
await page.waitForFunction(() => window.ccr.game.phase === "gameover", null, { timeout: 90000 });
await page.waitForTimeout(300);
await page.screenshot({ path: ".polariumcode/screenshots/gameover.png" });

const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await mob.goto("http://localhost:4173/index.html", { waitUntil: "networkidle" });
await mob.waitForTimeout(4000);
await mob.screenshot({ path: ".polariumcode/screenshots/mobile.png", fullPage: true });

console.log(errors.length ? errors.join("\n") : "no console errors");
await browser.close();
