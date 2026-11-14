#!/usr/bin/env node
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdir, readdir, lstat, writeFile, unlink, open } from 'node:fs/promises';
import { parseOptions, loopbackUrl } from './lib/options.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true }
];
const HELP = 'Usage: node capture.mjs (--root DIR | --url http://127.0.0.1:PORT/) --out DIR [--label initial|final] [--timeout-ms 45000] [--overwrite]';
const require = createRequire(import.meta.url);

function optionalIcon(url) {
  try { return /\/(?:favicon\.(?:ico|png|svg)|apple-touch-icon(?:-\d+x\d+)?\.png)$/iu.test(new URL(url).pathname); }
  catch { return false; }
}

async function collectViewport(browser, target, viewport, report, save, remaining) {
  const started = Date.now();
  const result = {
    name: viewport.name,
    viewport: { width: viewport.width, height: viewport.height },
    screenshot: `${viewport.name}.png`, fullPageScreenshot: `${viewport.name}-full.png`,
    navigation: {}, consoleErrors: [], pageErrors: [], requestFailures: [],
    httpErrors: [], ignoredResourceFailures: [], blockedRequests: []
  };
  report.viewports.push(result);
  const context = await browser.newContext({
    viewport: result.viewport, deviceScaleFactor: 1,
    isMobile: viewport.mobile, hasTouch: viewport.mobile,
    reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block'
  });
  try {
    // Scope every browser network request to the page's explicit origin.
    await context.route('**/*', async route => {
      const url = route.request().url();
      let allowed = false;
      try { allowed = loopbackUrl(url).origin === target.origin; } catch { /* blocked below */ }
      if (!allowed) {
        result.blockedRequests.push({ url, resourceType: route.request().resourceType() });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const comparable = new URL(url);
      comparable.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      if (comparable.origin === target.origin) socket.connectToServer();
      else {
        result.blockedRequests.push({ url: url.href, resourceType: 'websocket' });
        socket.close();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(10000, remaining()));
    page.on('pageerror', error => result.pageErrors.push({ message: error.message }));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const item = { message: message.text(), location: message.location() };
      if (optionalIcon(item.location.url) && /404|failed to load resource/iu.test(item.message)) {
        result.ignoredResourceFailures.push({ ...item, reason: 'Optional browser icon' });
      } else result.consoleErrors.push(item);
    });
    page.on('requestfailed', request => {
      const item = { url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText };
      if (optionalIcon(item.url)) result.ignoredResourceFailures.push({ ...item, reason: 'Optional browser icon' });
      else result.requestFailures.push(item);
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      const item = { url: response.url(), status: response.status(), resourceType: response.request().resourceType() };
      if (response.status() === 404 && optionalIcon(item.url)) {
        result.ignoredResourceFailures.push({ ...item, reason: 'Optional browser icon' });
      } else result.httpErrors.push(item);
    });
    try {
      const response = await page.goto(target.href, { waitUntil: 'load', timeout: Math.min(15000, remaining()) });
      result.navigation = { url: page.url(), status: response?.status() ?? null, ok: response?.ok() ?? false };
    } catch (error) {
      result.navigation = { url: page.url(), ok: false, error: error.message };
    }
    // Settle ordinary fetch-driven content without hanging on polling or streaming apps.
    await page.waitForLoadState('networkidle', { timeout: Math.min(2000, remaining()) }).catch(() => {});
    // Await fonts when possible, but never let one unavailable font consume the full run.
    await page.evaluate(() => Promise.race([
      document.fonts?.ready,
      new Promise(done => setTimeout(done, 1500))
    ])).catch(() => {});
    result.diagnostics = await page.evaluate(() => {
      const root = document.documentElement;
      const label = element => (
        element.getAttribute('aria-label') || element.getAttribute('title')
        || element.innerText || element.getAttribute('alt') || ''
      ).trim().replace(/\s+/gu, ' ').slice(0, 160);
      const describe = element => ({
        tag: element.tagName.toLowerCase(), id: element.id || null,
        label: label(element), href: element.getAttribute('href')
      });
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
      const links = [...document.querySelectorAll('a[href]')].filter(visible);
      const candidates = [...document.querySelectorAll('body *')].slice(0, 5000);
      const overflow = candidates.filter(element => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        return rect.right > root.clientWidth + 1 || rect.left < -1;
      }).slice(0, 20).map(element => ({
        ...describe(element), left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right)
      }));
      return {
        title: document.title, readyState: document.readyState,
        viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
        innerWidth, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
        documentHeight: root.scrollHeight,
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
        horizontalOverflowCandidates: overflow,
        controls: {
          visibleButtons: buttons.length, visibleLinks: links.length,
          buttonsWithoutObservedLabel: buttons.filter(element => !label(element) && !element.value).slice(0, 20).map(describe),
          linksWithoutObservedLabel: links.filter(element => !label(element) && !element.querySelector('img[alt]')).slice(0, 20).map(describe),
          placeholderLinks: links.filter(element => ['', '#'].includes(element.getAttribute('href'))).slice(0, 20).map(describe),
          missingLocalAnchorTargets: links.filter(element => {
            const href = element.getAttribute('href');
            if (!href?.startsWith('#') || href.length < 2) return false;
            let id;
            try { id = decodeURIComponent(href.slice(1)); } catch { return true; }
            return !document.getElementById(id) && !document.getElementsByName(id).length;
          }).slice(0, 20).map(describe)
        },
        brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0)
          .slice(0, 20).map(image => ({ src: image.currentSrc || image.src, alt: image.alt })),
        diagnosticLimits: { overflowElementsInspected: candidates.length, maxListedItems: 20 }
      };
    });
    remaining();
    const png = await page.screenshot({ fullPage: false, animations: 'disabled', timeout: remaining() });
    remaining();
    await save(result.screenshot, png);
    const fullPng = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: remaining() });
    remaining();
    await save(result.fullPageScreenshot, fullPng);
    if (viewport.name === 'desktop') {
      result.detailScrollY = await page.evaluate(() => {
        const section = document.querySelector('[data-design-detail]') || document.querySelectorAll('main > section, body > section')[1];
        const target = section ? section.getBoundingClientRect().top + scrollY : Math.min(innerHeight * 0.85, (document.documentElement.scrollHeight - innerHeight) / 2);
        scrollTo({ top: Math.max(0, target), behavior: 'instant' });
        return scrollY;
      });
      await page.waitForLoadState('networkidle', { timeout: Math.min(1000, remaining()) }).catch(() => {});
      result.detailScreenshot = 'desktop-detail.png';
      await save(result.detailScreenshot, await page.screenshot({ fullPage: false, animations: 'disabled', timeout: remaining() }));
    }
    result.durationMs = Date.now() - started;
  } finally { await context.close().catch(() => {}); }
}

async function run() {
  const options = parseOptions(process.argv.slice(2), {
    values: ['--root', '--url', '--out', '--label', '--timeout-ms'], flags: ['--overwrite', '--help']
  });
  if (options['--help']) { console.log(HELP); return; }
  if (Boolean(options['--root']) === Boolean(options['--url']) || !options['--out']) throw new Error(HELP);
  const label = options['--label'] || 'final';
  if (!['initial', 'final'].includes(label)) throw new Error('Label must be initial or final.');
  const timeoutMs = Number(options['--timeout-ms'] || 45000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Timeout must be 1000–300000 milliseconds.');
  let target = options['--url'] ? loopbackUrl(options['--url']) : null;
  const out = resolve(options['--out']);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length && !options['--overwrite']) {
    throw new Error('Output directory is not empty. Use separate initial/final directories or explicitly pass --overwrite.');
  }
  const lockPath = join(out, '.capture.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('A capture lock exists in the output directory.');
    throw error;
  });
  const save = async (name, content) => {
    const file = join(out, name);
    const existing = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Refusing to replace non-regular evidence: ${name}`);
    await writeFile(file, content, { flag: options['--overwrite'] ? 'w' : 'wx' });
  };
  let server, browser, timer, launchPromise, serverPromise, workPromise;
  let cancelled = false;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`Total capture timeout exceeded (${timeoutMs} ms).`);
    return left;
  };
  const report = {
    schemaVersion: 1, label, capturedAt: new Date(started).toISOString(), status: 'incomplete',
    networkPolicy: 'Only the explicit loopback page origin is allowed; other network requests are blocked.',
    notes: [
      'These are observable browser diagnostics, not an aesthetic score.',
      'Complete means evidence collection finished. Exit code 0 does not certify a working or visually acceptable page; inspect every viewport report.',
      'Each viewport has a fixed first-screen PNG and a separate full-page PNG for content below the fold.',
      'Control labels are heuristic observations; clicks, form submission, accessibility and visual quality are not certified.',
      'Missing optional browser icons are recorded separately and do not count as resource failures.',
      'timeoutMs bounds collection; closing the browser and server can add a short teardown delay, included in durationMs.'
    ],
    timeoutMs, viewports: []
  };
  try {
    const work = async () => {
      let chromium;
      try { ({ chromium } = require('playwright')); }
      catch { throw new Error('Playwright is missing. Run pnpm install in this skill directory, then pnpm exec playwright install chromium.'); }
      if (!target) {
        serverPromise = startStaticServer({ root: options['--root'] });
        server = await serverPromise;
        if (cancelled) throw new Error('Capture was cancelled while starting the static server.');
        target = new URL(server.url);
      }
      report.target = { mode: options['--root'] ? 'static-root' : 'existing-server', url: target.href };
      launchPromise = chromium.launch({
        headless: true, timeout: Math.min(15000, remaining()),
        ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
      });
      browser = await launchPromise;
      if (cancelled) throw new Error('Capture was cancelled while launching the browser.');
      for (const viewport of VIEWPORTS) await collectViewport(browser, target, viewport, report, save, remaining);
      report.status = 'complete';
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        browser?.close().catch(() => {});
        server?.close().catch(() => {});
        reject(new Error(`Total capture timeout exceeded (${timeoutMs} ms).`));
      }, timeoutMs);
    });
    workPromise = work();
    await Promise.race([workPromise, timeout]);
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    cancelled = true;
    // Resolve startup handles before cleanup so a late launch cannot escape teardown.
    browser ||= await launchPromise?.catch(() => undefined);
    server ||= await serverPromise?.catch(() => undefined);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await workPromise?.catch(() => {});
    report.durationMs = Date.now() - started;
    report.summary = {
      viewportCount: report.viewports.length,
      failedNavigations: report.viewports.filter(item => !item.navigation.ok).length,
      horizontalOverflowViewports: report.viewports.filter(item => item.diagnostics?.horizontalOverflow).map(item => item.name),
      consoleErrorCount: report.viewports.reduce((sum, item) => sum + item.consoleErrors.length, 0),
      pageErrorCount: report.viewports.reduce((sum, item) => sum + item.pageErrors.length, 0),
      httpErrorCount: report.viewports.reduce((sum, item) => sum + item.httpErrors.length, 0),
      blockedRequestCount: report.viewports.reduce((sum, item) => sum + item.blockedRequests.length, 0)
    };
    try { await save('report.json', `${JSON.stringify(report, null, 2)}\n`); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
  console.log(`Capture ${report.status}: ${join(out, 'report.json')}`);
  if (report.error) console.error(report.error);
}

run().catch(error => { console.error(`Capture failed: ${error.message}`); process.exitCode = 1; });
