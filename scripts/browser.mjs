#!/usr/bin/env node
//
// Browser driver — persistent Chromium with daemon mode.
//
// First call (or `start`): launches Chromium with remote debugging
// on a fixed port, writing the PID to /tmp/cc-browser.pid. Subsequent
// calls connect via CDP to the running browser, so page state (URL,
// scroll, focused element, alerts) survives across Bash invocations.
//
// Use `stop` to kill the daemon.
//
// Usage:
//   node scripts/browser.mjs start                # idempotent
//   node scripts/browser.mjs navigate <url>
//   node scripts/browser.mjs screenshot [out.png]
//   node scripts/browser.mjs click "<selector|text>"
//   node scripts/browser.mjs fill "<selector>" "<text>"
//   node scripts/browser.mjs press <Key>          # Enter, Tab, Escape
//   node scripts/browser.mjs eval "<js expr>"
//   node scripts/browser.mjs text                 # visible text on page
//   node scripts/browser.mjs url
//   node scripts/browser.mjs wait <selector>      # wait until visible
//   node scripts/browser.mjs stop

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { argv, exit } from 'node:process';
import { spawn as cpSpawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';

const PROFILE = '/tmp/cc-browser-profile';
const PID_FILE = '/tmp/cc-browser.pid';
const PORT = 9222;
const CDP_URL = `http://localhost:${PORT}`;
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DEFAULT_SCREENSHOT = '/tmp/browser-screenshot.png';

const [, , cmd, ...args] = argv;

if (!cmd) {
  console.error('Commands: start, navigate, screenshot, click, fill, press, eval, text, url, wait, stop');
  exit(2);
}

function daemonRunning() {
  if (!existsSync(PID_FILE)) return false;
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ensureStarted() {
  if (daemonRunning()) return;
  if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });
  const proc = cpSpawn(EXEC, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-blink-features=AutomationControlled',
    '--ignore-certificate-errors',
    '--headless=new',
    '--window-size=1280,800',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  proc.unref();
  writeFileSync(PID_FILE, String(proc.pid));
  // Wait for CDP endpoint to come up.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${CDP_URL}/json/version`);
      if (r.ok) { console.log(`Started Chromium daemon (pid=${proc.pid}, port=${PORT})`); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Chromium daemon failed to come up on port ' + PORT);
}

if (cmd === 'stop') {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    rmSync(PID_FILE, { force: true });
  }
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  console.log('Stopped + profile cleared.');
  exit(0);
}

await ensureStarted();

if (cmd === 'start') exit(0);

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0] ?? await browser.newContext();
let page = ctx.pages()[0] ?? await ctx.newPage();
// Pick the page that has a real URL (Chromium opens about:blank initially).
const real = ctx.pages().find(p => p.url() && p.url() !== 'about:blank' && !p.url().startsWith('chrome://'));
if (real) page = real;

try {
  switch (cmd) {
    case 'navigate': {
      const url = args[0];
      if (!url) throw new Error('navigate requires a URL');
      console.log(`→ ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
      console.log(`url: ${page.url()}`);
      console.log(`title: ${(await page.title()).slice(0, 120)}`);
      break;
    }
    case 'screenshot': {
      const out = args[0] || DEFAULT_SCREENSHOT;
      await page.screenshot({ path: out, fullPage: false });
      console.log(`saved: ${out}`);
      break;
    }
    case 'click': {
      const target = args[0];
      if (!target) throw new Error('click requires a selector or text');
      try {
        await page.click(target, { timeout: 5000 });
      } catch {
        await page.getByText(target, { exact: false }).first().click({ timeout: 5000 });
      }
      await page.waitForTimeout(700);
      console.log(`clicked: ${target}`);
      console.log(`url: ${page.url()}`);
      break;
    }
    case 'fill': {
      const [sel, text] = args;
      if (!sel || text === undefined) throw new Error('fill requires <selector> <text>');
      await page.fill(sel, text, { timeout: 5000 });
      console.log(`filled: ${sel}`);
      break;
    }
    case 'press': {
      const key = args[0];
      if (!key) throw new Error('press requires a key');
      await page.keyboard.press(key);
      console.log(`pressed: ${key}`);
      break;
    }
    case 'eval': {
      const expr = args[0];
      if (!expr) throw new Error('eval requires JS');
      const r = await page.evaluate(expr);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'text': {
      const t = await page.evaluate(() => document.body?.innerText ?? '');
      console.log(t.slice(0, 4000));
      break;
    }
    case 'url': {
      console.log(page.url());
      break;
    }
    case 'wait': {
      const sel = args[0];
      if (!sel) throw new Error('wait requires a selector');
      await page.waitForSelector(sel, { timeout: 15000 });
      console.log(`visible: ${sel}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
} catch (err) {
  console.error(`ERROR: ${err.message.split('\n')[0]}`);
  exit(1);
} finally {
  // Don't close ctx/browser — disconnect leaves the daemon alive.
  await browser.close();
}
