import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Configure Playwright platform overrides for Android/Linux compatibility
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), '.cache', 'ms-playwright');
}
if (process.platform === 'android' && !process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'ubuntu-22.04-arm64';
}

function resolve(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u;
  }
  return u;
}

// Global browser session state
let browser = null;
let context = null;
let activePage = null;
let pages = [];
let pwModule = null;

async function getPlaywright() {
  if (!pwModule) {
    pwModule = await import('playwright');
  }
  return pwModule;
}

async function ensurePage() {
  if (!browser) {
    await web_launch({ headless: false });
  }
  if (!activePage || activePage.isClosed()) {
    if (!context) {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
    }
    activePage = await context.newPage();
    pages = context.pages();
  }
  return activePage;
}

async function getLocator(page, selector) {
  if (!selector || typeof selector !== 'string') {
    throw new Error('selector or text is required');
  }
  const sel = selector.trim();

  // 1. Direct CSS/XPath selector if it clearly starts with special selector syntax
  if (/^[#.[\]>:~*+^$|]|^xpath=|^css=|\/\//.test(sel)) {
    return page.locator(sel).first();
  }

  // 2. Try getByText (exact or substring)
  try {
    const byText = page.getByText(sel, { exact: false });
    if (await byText.count() > 0) return byText.first();
  } catch {}

  // 3. Try getByRole with common interactive roles
  for (const role of ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio']) {
    try {
      const byRole = page.getByRole(role, { name: sel });
      if (await byRole.count() > 0) return byRole.first();
    } catch {}
  }

  // 4. Try getByPlaceholder / getByLabel / getByTitle / getByAltText
  try {
    const byPlaceholder = page.getByPlaceholder(sel);
    if (await byPlaceholder.count() > 0) return byPlaceholder.first();
  } catch {}
  try {
    const byLabel = page.getByLabel(sel);
    if (await byLabel.count() > 0) return byLabel.first();
  } catch {}
  try {
    const byTitle = page.getByTitle(sel);
    if (await byTitle.count() > 0) return byTitle.first();
  } catch {}
  try {
    const byAlt = page.getByAltText(sel);
    if (await byAlt.count() > 0) return byAlt.first();
  } catch {}

  // 5. Try text= selector
  try {
    const textLoc = page.locator(`text="${sel}"`);
    if (await textLoc.count() > 0) return textLoc.first();
  } catch {}

  // 6. Fallback to general locator
  return page.locator(sel).first();
}

/* ========================================================================= */
/* 1. BROWSER CORE (3 tools)                                                 */
/* ========================================================================= */

export async function web_launch(args = {}) {
  const pw = await getPlaywright();
  let headless = args.headless !== undefined ? !!args.headless : false;
  if (browser) {
    try { await browser.close(); } catch {}
  }

  const launchOptions = {
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  try {
    browser = await pw.chromium.launch(launchOptions);
  } catch (err) {
    // If visible window fails (e.g. no DISPLAY on headless server/Termux), fallback to headless
    if (!headless) {
      try {
        launchOptions.headless = true;
        headless = true;
        browser = await pw.chromium.launch(launchOptions);
      } catch (fallbackErr) {
        if (fallbackErr.message.includes("doesn't exist")) {
          throw new Error(`Chromium executable not found. Run 'npx playwright install chromium' to download.`);
        }
        throw new Error(`Failed to launch browser: ${fallbackErr.message}`);
      }
    } else {
      if (err.message.includes("doesn't exist")) {
        throw new Error(`Chromium executable not found. Run 'npx playwright install chromium' to download.`);
      }
      throw err;
    }
  }

  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  activePage = await context.newPage();
  pages = [activePage];

  return `Browser launched successfully (headless: ${headless}). Ready.`;
}

export async function web_close() {
  if (!browser) return 'Browser is not currently running.';
  try {
    await browser.close();
  } finally {
    browser = null;
    context = null;
    activePage = null;
    pages = [];
  }
  return 'Browser closed.';
}

export async function web_new_tab(args = {}) {
  if (!browser) await web_launch();
  activePage = await context.newPage();
  pages = context.pages();
  const tabIdx = pages.indexOf(activePage) + 1;
  if (args.url) {
    const targetUrl = normalizeUrl(args.url);
    await activePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `Opened tab ${tabIdx} at ${activePage.url()} — "${await activePage.title()}"`;
  }
  return `Opened new tab (tab ${tabIdx}).`;
}

/* ========================================================================= */
/* 2. NAVIGATION (3 tools)                                                   */
/* ========================================================================= */

export async function web_goto(args = {}) {
  if (!args.url) return 'Error: url required';
  const page = await ensurePage();
  const targetUrl = normalizeUrl(args.url);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return `Navigated to ${page.url()} — title: "${await page.title()}"`;
}

export async function web_back() {
  const page = await ensurePage();
  await page.goBack({ timeout: 15000 });
  return `Navigated back to ${page.url()} — title: "${await page.title()}"`;
}

export async function web_reload() {
  const page = await ensurePage();
  await page.reload({ timeout: 30000 });
  return `Page reloaded: ${page.url()} — title: "${await page.title()}"`;
}

/* ========================================================================= */
/* 3. ACTION (7 tools)                                                       */
/* ========================================================================= */

export async function web_click(args = {}) {
  if (!args.selector) return 'Error: selector required';
  const page = await ensurePage();
  const loc = await getLocator(page, args.selector);
  await loc.click({ timeout: 10000 });
  return `Clicked "${args.selector}"`;
}

export async function web_dblclick(args = {}) {
  if (!args.selector) return 'Error: selector required';
  const page = await ensurePage();
  const loc = await getLocator(page, args.selector);
  await loc.dblclick({ timeout: 10000 });
  return `Double-clicked "${args.selector}"`;
}

export async function web_fill(args = {}) {
  if (!args.selector) return 'Error: selector required';
  const page = await ensurePage();
  const loc = await getLocator(page, args.selector);
  const text = String(args.text ?? '');
  await loc.fill(text, { timeout: 10000 });
  return `Filled "${args.selector}" with "${text}"`;
}

export async function web_press(args = {}) {
  if (!args.key) return 'Error: key required';
  const page = await ensurePage();
  await page.keyboard.press(String(args.key));
  return `Pressed key: ${args.key}`;
}

export async function web_hover(args = {}) {
  if (!args.selector) return 'Error: selector required';
  const page = await ensurePage();
  const loc = await getLocator(page, args.selector);
  await loc.hover({ timeout: 10000 });
  return `Hovered over "${args.selector}"`;
}

export async function web_drag(args = {}) {
  if (!args.from_selector || !args.to_selector) return 'Error: from_selector and to_selector required';
  const page = await ensurePage();
  const fromLoc = await getLocator(page, args.from_selector);
  const toLoc = await getLocator(page, args.to_selector);
  await fromLoc.dragTo(toLoc, { timeout: 10000 });
  return `Dragged from "${args.from_selector}" to "${args.to_selector}"`;
}

export async function web_scroll(args = {}) {
  const page = await ensurePage();
  const dir = String(args.direction || 'down').toLowerCase();
  const amount = parseInt(args.amount) || 500;
  const deltaY = (dir === 'up' ? -1 : 1) * Math.abs(amount);
  await page.evaluate((y) => window.scrollBy(0, y), deltaY);
  return `Scrolled ${dir} by ${Math.abs(amount)}px`;
}

/* ========================================================================= */
/* 4. READ (4 tools)                                                         */
/* ========================================================================= */

export async function web_screenshot(args = {}) {
  const page = await ensurePage();
  const dir = path.join(os.homedir(), '.levi', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = args.path ? resolve(args.path) : path.join(dir, `screenshot-${Date.now()}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  return `Screenshot saved to ${outPath}`;
}

export async function web_get_text(args = {}) {
  const page = await ensurePage();
  if (args.selector) {
    const loc = await getLocator(page, args.selector);
    const text = await loc.innerText({ timeout: 10000 });
    return text.trim() || '(element has no text)';
  }
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  return bodyText.slice(0, 3000) || '(page has no body text)';
}

export async function web_get_url() {
  const page = await ensurePage();
  const title = await page.title();
  return `URL: ${page.url()}\nTitle: "${title}"`;
}

export async function web_wait(args = {}) {
  const page = await ensurePage();
  const timeout = parseInt(args.timeout) || 10000;
  const sel = args.selector ? String(args.selector).trim() : null;
  if (!sel) {
    await page.waitForTimeout(Math.min(timeout, 10000));
    return `Waited ${Math.min(timeout, 10000)}ms`;
  }
  if (/^\d+$/.test(sel)) {
    const ms = Math.min(parseInt(sel), 30000);
    await page.waitForTimeout(ms);
    return `Waited ${ms}ms`;
  }
  const loc = await getLocator(page, sel);
  await loc.waitFor({ state: 'visible', timeout });
  return `Waited for "${sel}" (element is visible)`;
}

/* ========================================================================= */
/* CENTRAL DISPATCHER                                                        */
/* ========================================================================= */

export async function runBrowserTool(name, args = {}) {
  try {
    switch (name) {
      case 'web_launch': return await web_launch(args);
      case 'web_close': return await web_close(args);
      case 'web_new_tab': return await web_new_tab(args);
      case 'web_goto': return await web_goto(args);
      case 'web_back': return await web_back(args);
      case 'web_reload': return await web_reload(args);
      case 'web_click': return await web_click(args);
      case 'web_dblclick': return await web_dblclick(args);
      case 'web_fill': return await web_fill(args);
      case 'web_press': return await web_press(args);
      case 'web_hover': return await web_hover(args);
      case 'web_drag': return await web_drag(args);
      case 'web_scroll': return await web_scroll(args);
      case 'web_screenshot': return await web_screenshot(args);
      case 'web_get_text': return await web_get_text(args);
      case 'web_get_url': return await web_get_url(args);
      case 'web_wait': return await web_wait(args);
      default: return `Error: unknown web browser tool: ${name}`;
    }
  } catch (err) {
    return `Error in ${name}: ${err.message}`;
  }
}
