import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEISHU_FIXTURE_SECRET, launchFeishuFixture } from "./testing/feishu-fixture.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const fx = await launchFeishuFixture();
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const code = await fx.api("POST", "/api/auth/pairing", { label: "Feishu UI fixture", scopes: ["admin", "client"] });
  ui = await mountPreview(fx.fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__feishu.html", title: "Isolated Feishu connection",
    extraRoutes: [
      { path: "/api/feishu", handler: (req, res) => fx.route(req, res) },
      { path: "/api/connectors/catalog", handler: (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: true, mode: "self-hosted", source: "curated", cards: [
        { slug: "slack", label: "Slack", blurb: "Channels and messages", logo: null, domain: "slack.com", categories: ["Communication"] },
      ] })) },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} })) },
    ],
  });
  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  const launched = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined, args: ["--use-mock-keychain", "--no-sandbox"] });
  browser = launched;
  const context = await launched.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  const paired = await page.evaluate(async (pairingCode: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairingCode, cookie: true, label: "Feishu UI" }) })).status, code.code);
  assert.equal(paired, 200);
  await page.reload();
  const out = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-feishu-ui-evidence";
  mkdirSync(out, { recursive: true });
  const card = page.locator('[data-app-tile="feishu"]');
  const search = page.getByRole("textbox", { name: "Search apps", exact: true });
  const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: join(out, `${name}.png`) }); };
  await card.getByRole("button", { name: "Connect Feishu", exact: true }).waitFor();
  await search.fill("la"); await card.waitFor({ state: "visible" }); await shot("01-lark-search-daylight");
  for (const query of ["飞书", "feishu", "lark"]) { await search.fill(query); await card.waitFor({ state: "visible" }); }
  await search.fill(""); await page.locator('[data-apps-category="Communication"]').click(); await card.waitFor({ state: "visible" });
  await card.getByRole("button", { name: "Connect Feishu", exact: true }).click();
  await card.getByLabel("App ID", { exact: true }).fill("cli_0123456789abcdef");
  await card.getByLabel("App secret", { exact: true }).fill("wrong-secret");
  await card.getByLabel("Allowed user open IDs", { exact: true }).fill("ou_alice");
  await card.getByLabel("Bot", { exact: true }).selectOption({ index: 1 });
  await card.getByRole("button", { name: "Save and connect", exact: true }).click();
  await card.getByRole("alert").waitFor(); await shot("02-refused-credentials");
  assert.equal(fx.service.status().saved, false);
  await card.getByLabel("App secret", { exact: true }).fill(FEISHU_FIXTURE_SECRET);
  await shot("03-configuration-form");
  await card.getByRole("button", { name: "Save and connect", exact: true }).click();
  await page.locator('[data-app-tile="feishu"][data-feishu-state="connected"]').waitFor();
  assert.equal(await card.locator('input[type="password"]').count(), 0);
  assert.equal((await page.content()).includes(FEISHU_FIXTURE_SECRET), false);
  await shot("04-connected-daylight");
  await page.evaluate(() => document.documentElement.setAttribute("data-skin", "midnight"));
  await shot("05-connected-midnight");
  await page.setViewportSize({ width: 390, height: 844 }); await card.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot("06-connected-narrow");
  await card.getByRole("button", { name: "Feishu options", exact: true }).click();
  await page.locator('[role="menuitem"][data-menu-key="disconnect"]').click();
  await card.getByRole("button", { name: "Connect Feishu", exact: true }).waitFor();
  assert.equal(fx.service.status().saved, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => { const module = "/src/lib/i18n.ts"; await (await import(module)).loadLocale("zh"); document.documentElement.setAttribute("data-skin", "daylight"); });
  await search.fill("飞书");
  await card.getByRole("button", { name: "连接飞书", exact: true }).waitFor();
  await shot("07-chinese-search");
  assert.deepEqual(errors, []);
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: true, fixture: fx.fixture.info, status: fx.service.status(), errors, liveFeishuTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: out, fixture: fx.fixture.info, liveFeishuTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await fx.close();
}
