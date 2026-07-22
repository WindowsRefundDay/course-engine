#!/usr/bin/env node
/**
 * One-command local course bootstrap.
 *
 * Discover a nearby course source, compile it deterministically, validate it,
 * activate the exact artifact, start the learner frontend, and open it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "services", "engine");
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FRONTEND_URL = "http://localhost:3003/";
const API_URL = "http://127.0.0.1:8000";

const VISUAL_QA_MODES = new Set(["auto", "enabled", "disabled"]);

export type BootstrapOptions = {
  source?: string;
  courseDir?: string;
  reconfigure?: boolean;
  nonInteractive?: boolean;
  noOpen?: boolean;
  visualQa?: "auto" | "enabled" | "disabled";
  overrides?: Record<string, string>;
  /** Internal test hook: override the browser automation runner. */
  _browserAutomationRunner?: BrowserAutomationRunner;
};

type BootstrapResult = {
  ok: boolean;
  status: "ready" | "blocked" | "skipped";
  stage?: string;
  courseId?: string;
  version?: number;
  title?: string;
  error?: string;
  visualQaRan?: boolean;
  visualQaSkippedReason?: string;
  smokeChecks?: { ok: boolean; reason?: string };
};

export type BrowserAutomationRunner = "playwright" | "puppeteer" | "chrome" | null;

function hasCommand(name: string): boolean {
  return spawnSync("command", ["-v", name], { shell: true, stdio: "ignore" }).status === 0;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

async function waitForUrl(url: string, attempts = 30, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return true;
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function parseArgs(argv: string[]): BootstrapOptions {
  const options: BootstrapOptions = { overrides: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source" || arg === "-s") {
      options.source = argv[++i];
    } else if (arg === "--course-dir" || arg === "-c") {
      options.courseDir = argv[++i];
    } else if (arg === "--reconfigure") {
      options.reconfigure = true;
    } else if (arg === "--non-interactive" || arg === "-n") {
      options.nonInteractive = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--visual-qa") {
      const mode = argv[++i] as "auto" | "enabled" | "disabled";
      if (!VISUAL_QA_MODES.has(mode)) {
        throw new Error(`--visual-qa must be one of: auto, enabled, disabled`);
      }
      options.visualQa = mode;
    } else if (arg.startsWith("--set") && arg.includes("=")) {
      const [key, value] = arg.slice(2).split("=", 1)[0].includes("=")
        ? arg.slice(2).split("=", 2)
        : [arg.slice(2), argv[++i]];
      if (options.overrides) options.overrides[key] = value;
    } else if (arg.startsWith("--set-") && arg.includes("=")) {
      const [key, value] = arg.slice(6).split("=", 2);
      if (options.overrides) options.overrides[key] = value;
    }
  }
  return options;
}

function chromiumExecutable(): string | null {
  const env = process.env.COURSE_ENGINE_CHROMIUM;
  if (env) return env;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]) {
    if (hasCommand(name)) return name;
  }
  return null;
}

export function detectBrowserAutomation(): BrowserAutomationRunner {
  // Prefer real browser automation libraries that can check the page and console.
  // Verify the package is resolvable from the project root so the temp script can import it.
  try {
    const localPlaywright = run("node", ["-e", "console.log(require.resolve('playwright'))"], { cwd: PROJECT_ROOT, stdio: "pipe" });
    if (localPlaywright.status === 0) return "playwright";
  } catch {
    // Ignore.
  }
  try {
    const localPuppeteer = run("node", ["-e", "console.log(require.resolve('puppeteer'))"], { cwd: PROJECT_ROOT, stdio: "pipe" });
    if (localPuppeteer.status === 0) return "puppeteer";
  } catch {
    // Ignore.
  }
  // A Chromium/Chrome binary alone is enough for a headless DOM check, but it
  // cannot reliably collect console logs or emulate learner interactions.
  if (chromiumExecutable()) return "chrome";
  return null;
}

async function writeTempScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "course-engine-qa-"));
  const path = join(dir, "qa.mjs");
  await writeFile(path, content, "utf8");
  return path;
}

async function runBrowserAutomation(
  url: string,
  runner: BrowserAutomationRunner,
): Promise<{ ran: boolean; consoleErrors?: string[]; reason?: string }> {
  if (!runner) {
    return { ran: false, reason: "No browser automation tooling detected" };
  }

  if (runner === "chrome") {
    const chrome = chromiumExecutable();
    if (!chrome) {
      return { ran: false, reason: "No Chromium/Chrome executable found" };
    }
    // Chrome headless can dump DOM but cannot reliably collect console logs.
    const result = run(chrome, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--dump-dom",
      "--virtual-time-budget=5000",
      "--run-all-compositor-stages-before-draw",
      url,
    ], { stdio: "pipe", env: { ...process.env, NODE_ENV: "test" } });
    if (result.status !== 0) {
      return { ran: false, reason: `Chrome headless failed: ${result.stderr || result.stdout || "unknown error"}` };
    }
    const dom = result.stdout || "";
    const hasLearnerMarker = dom.includes('id="lesson-title"') || dom.includes('class="empty-state"');
    if (!hasLearnerMarker) {
      return { ran: false, reason: "Headless Chrome did not render expected learner markers" };
    }
    return { ran: true, consoleErrors: [] };
  }

  if (runner === "playwright") {
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire('file:///__project_root__/package.json');
      const { chromium } = require('playwright');
      const url = process.argv[2];
      const errors = [];
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForSelector('#lesson-title, .empty-state, .blocked', { timeout: 5000 }).catch(() => {});
        const hasLearner = await page.locator('#lesson-title').count() > 0 || await page.locator('.empty-state').count() > 0;
        if (!hasLearner) {
          console.error('No learner page marker found');
          process.exit(1);
        }
        console.log(JSON.stringify({ ran: true, consoleErrors: errors }));
      } finally {
        await browser.close();
      }
    `.replace("file:///__project_root__/package.json", `file://${PROJECT_ROOT}/package.json`);
    const path = await writeTempScript(script);
    try {
      const result = run("node", ["--experimental-strip-types", path, url], { stdio: "pipe" });
      if (result.status !== 0) {
        return { ran: false, reason: `Playwright check failed: ${result.stderr || result.stdout || "unknown error"}` };
      }
      const lastLine = result.stdout.trim().split("\n").pop();
      const parsed = JSON.parse(lastLine || "{}");
      return { ran: true, consoleErrors: parsed.consoleErrors ?? [] };
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  }

  if (runner === "puppeteer") {
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire('file:///__project_root__/package.json');
      const puppeteer = require('puppeteer');
      const url = process.argv[2];
      const errors = [];
      const browser = await puppeteer.launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        const hasLearner = await page.evaluate(() => Boolean(document.querySelector('#lesson-title') || document.querySelector('.empty-state')));
        if (!hasLearner) {
          console.error('No learner page marker found');
          process.exit(1);
        }
        console.log(JSON.stringify({ ran: true, consoleErrors: errors }));
      } finally {
        await browser.close();
      }
    `.replace("file:///__project_root__/package.json", `file://${PROJECT_ROOT}/package.json`);
    const path = await writeTempScript(script);
    try {
      const result = run("node", ["--experimental-strip-types", path, url], { stdio: "pipe" });
      if (result.status !== 0) {
        return { ran: false, reason: `Puppeteer check failed: ${result.stderr || result.stdout || "unknown error"}` };
      }
      const lastLine = result.stdout.trim().split("\n").pop();
      const parsed = JSON.parse(lastLine || "{}");
      return { ran: true, consoleErrors: parsed.consoleErrors ?? [] };
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  }

  return { ran: false, reason: "Unsupported browser automation runner" };
}

export async function runSmokeChecks(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, reason: `Learner frontend returned HTTP ${response.status}` };
    }
    const html = await response.text();
    if (!html.includes('id="lesson-title"') && !html.includes('class="empty-state"') && !html.includes('Preparing your course')) {
      return { ok: false, reason: "Rendered page did not contain expected learner shell markers" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveVisualQa(
  mode: "auto" | "enabled" | "disabled",
  runner: BrowserAutomationRunner,
): { shouldRun: boolean; required: boolean; reason?: string } {
  if (mode === "disabled") {
    return { shouldRun: false, required: false, reason: "Visual QA disabled by request" };
  }
  if (mode === "enabled") {
    if (!runner) {
      return { shouldRun: false, required: true, reason: "Visual QA required but browser automation is unavailable" };
    }
    return { shouldRun: true, required: true };
  }
  // auto
  if (!runner) {
    return { shouldRun: false, required: false, reason: "Browser automation not available; visual QA skipped" };
  }
  return { shouldRun: true, required: false };
}

export async function runVisualQa(url: string, runner?: BrowserAutomationRunner): Promise<{ ran: boolean; reason?: string }> {
  const selectedRunner = runner ?? detectBrowserAutomation();
  if (!selectedRunner) {
    return { ran: false, reason: "No browser automation tooling detected in this environment" };
  }
  const result = await runBrowserAutomation(url, selectedRunner);
  if (!result.ran) {
    return { ran: false, reason: result.reason };
  }
  if (result.consoleErrors && result.consoleErrors.length > 0) {
    return { ran: false, reason: `Console errors detected: ${result.consoleErrors.slice(0, 3).join("; ")}` };
  }
  return { ran: true };
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  // 1. Dependency checks.
  if (!hasCommand("node")) {
    return { ok: false, status: "blocked", stage: "dependencies", error: "Node.js is required but not found" };
  }
  if (!hasCommand("python3") && !hasCommand("python")) {
    return { ok: false, status: "blocked", stage: "dependencies", error: "Python 3 is required but not found" };
  }
  if (!hasCommand("uv") && !hasCommand("uvicorn")) {
    return { ok: false, status: "blocked", stage: "dependencies", error: "uv is required for the local engine" };
  }

  // 2. Configure / discover / compile / activate via the engine CLI.
  const courseDir = options.courseDir ? resolve(options.courseDir) : join(PROJECT_ROOT, "courses", "auto-discovered");
  const bootstrapArgs = ["--non-interactive", "--course-dir", courseDir, "--project-root", PROJECT_ROOT];
  if (options.source) bootstrapArgs.push("--source", options.source);
  if (options.reconfigure) bootstrapArgs.push("--reconfigure");
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    bootstrapArgs.push("--set", `${key}=${value}`);
  }

  const bootstrapResult = run(
    "python3",
    ["-m", "course_engine.cli", "bootstrap", ...bootstrapArgs],
    { cwd: PROJECT_ROOT, env: { PYTHONPATH: ENGINE_DIR }, stdio: "pipe" },
  );

  if (bootstrapResult.status !== 0) {
    let parsed: { status?: string; stage?: string; error?: string } = {};
    try {
      parsed = JSON.parse(bootstrapResult.stderr || bootstrapResult.stdout || "{}") as typeof parsed;
    } catch {
      parsed = {};
    }
    return {
      ok: false,
      status: "blocked",
      stage: parsed.stage ?? "bootstrap",
      error: parsed.error ?? (bootstrapResult.stderr || bootstrapResult.stdout || "Bootstrap failed"),
    };
  }

  let activation: { status: string; course_id?: string; version?: number; title?: string } = { status: "ready" };
  try {
    activation = JSON.parse(bootstrapResult.stdout || "{}") as typeof activation;
  } catch {
    activation = { status: "ready" };
  }

  // 3. Start API server in the background.
  const apiProc = spawn(
    "uv",
    ["run", "--project", ENGINE_DIR, "uvicorn", "course_engine.api:app", "--host", "127.0.0.1", "--port", "8000"],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONPATH: ENGINE_DIR },
      stdio: "ignore",
      detached: true,
    },
  );
  apiProc.unref();

  const apiReady = await waitForUrl(`${API_URL}/health`);
  if (!apiReady) {
    return { ok: false, status: "blocked", stage: "api", error: "Engine API did not become ready" };
  }

  // 4. Start frontend dev server in the background.
  const frontendProc = spawn("npm", ["run", "dev"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
    detached: true,
  });
  frontendProc.unref();

  const frontendReady = await waitForUrl(FRONTEND_URL);
  if (!frontendReady) {
    return { ok: false, status: "blocked", stage: "frontend", error: "Learner frontend did not become ready" };
  }

  // 5. Smoke checks (always available, separate from visual QA).
  const smoke = await runSmokeChecks(FRONTEND_URL);

  // 6. Visual QA.
  const visualQaMode = options.visualQa ?? "auto";
  const runner = options._browserAutomationRunner ?? detectBrowserAutomation();
  const decision = resolveVisualQa(visualQaMode, runner);
  let visualQaResult: { ran: boolean; reason?: string } = { ran: false, reason: decision.reason };
  if (decision.shouldRun) {
    visualQaResult = await runVisualQa(FRONTEND_URL, runner);
  }
  if (decision.required && !visualQaResult.ran) {
    return { ok: false, status: "blocked", stage: "visual-qa", error: visualQaResult.reason ?? "Visual QA required but unavailable" };
  }

  // 7. Open browser.
  if (!options.noOpen && hasCommand("open")) {
    spawn("open", [FRONTEND_URL], { stdio: "ignore" }).unref();
  }

  return {
    ok: true,
    status: "ready",
    courseId: activation.course_id,
    version: activation.version,
    title: activation.title,
    visualQaRan: visualQaResult.ran,
    visualQaSkippedReason: visualQaResult.reason,
    smokeChecks: smoke,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv);
    const result = await bootstrap(options);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
