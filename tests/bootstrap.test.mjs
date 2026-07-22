import assert from "node:assert/strict";
import test from "node:test";

const {
  bootstrap,
  detectBrowserAutomation,
  resolveVisualQa,
  runSmokeChecks,
  runVisualQa,
} = await import("../scripts/bootstrap.ts");

const { staticFallbackEnabled } = await import("../app/active-course-api.ts");

test("bootstrap reports dependency blocker when uv is missing", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const result = await bootstrap({ nonInteractive: true, noOpen: true, visualQa: "disabled" });
  process.env.PATH = originalPath;
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.stage, "dependencies");
});

test("bootstrap module exports the bootstrap function", async () => {
  const mod = await import("../scripts/bootstrap.ts");
  assert.equal(typeof mod.bootstrap, "function");
});

test("detectBrowserAutomation returns a supported runner or null", () => {
  const runner = detectBrowserAutomation();
  assert.ok(runner === null || ["playwright", "puppeteer", "chrome"].includes(runner));
});

test("resolveVisualQa disabled skips without running", () => {
  const result = resolveVisualQa("disabled", "playwright");
  assert.equal(result.shouldRun, false);
  assert.equal(result.required, false);
  assert.match(result.reason, /disabled/i);
});

test("resolveVisualQa enabled requires automation and blocks when absent", () => {
  const withRunner = resolveVisualQa("enabled", "playwright");
  assert.equal(withRunner.shouldRun, true);
  assert.equal(withRunner.required, true);

  const withoutRunner = resolveVisualQa("enabled", null);
  assert.equal(withoutRunner.shouldRun, false);
  assert.equal(withoutRunner.required, true);
  assert.match(withoutRunner.reason, /required/i);
});

test("resolveVisualQa auto skips honestly when automation is absent", () => {
  const withRunner = resolveVisualQa("auto", "playwright");
  assert.equal(withRunner.shouldRun, true);
  assert.equal(withRunner.required, false);

  const withoutRunner = resolveVisualQa("auto", null);
  assert.equal(withoutRunner.shouldRun, false);
  assert.equal(withoutRunner.required, false);
  assert.match(withoutRunner.reason, /skipped/i);
});

test("runVisualQa honestly skips when no browser automation runner is provided", async () => {
  const result = await runVisualQa("http://localhost:3003/", null);
  assert.equal(result.ran, false);
  assert.ok(result.reason);
  assert.match(result.reason, /No browser automation/i);
});

test("runSmokeChecks is separate from visual QA and reports fetch failures honestly", async () => {
  const result = await runSmokeChecks("http://localhost:39999/not-running");
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test("static fallback is disabled by default", () => {
  assert.equal(staticFallbackEnabled(), false);
});
