#!/usr/bin/env node
// End-to-end check of a built Tokengator: starts the real service on a temporary home, drives it over
// HTTP and MCP, and watches the dashboard in a real browser.
//
//   npm run build && node scripts/e2e.cjs
//
// Needs Playwright with Chromium available to `require`. It is a verification script, not part of
// `npm test`: the unit and integration suites cover the same behaviour without a browser.

const { spawn } = require('node:child_process');
const { createServer, request } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

async function waitFor(fn, ms = 6000, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep trying until the deadline
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

async function main() {
  const { chromium } = require('playwright');
  const home = mkdtempSync(join(tmpdir(), 'tokengator-e2e-'));
  const port = 4900 + Math.floor(Math.random() * 400);
  const origin = `http://127.0.0.1:${port}`;
  // A stand-in for the user's own reminder address (an ntfy server on this computer).
  const posts = [];
  const receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      posts.push({ title: req.headers.title, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((done) => receiver.listen(0, '127.0.0.1', done));
  const notifyUrl = `http://127.0.0.1:${receiver.address().port}/e2e-secret-topic`;
  const env = { ...process.env, TOKENGATOR_HOME: home, TOKENGATOR_LOG: 'warn', TOKENGATOR_NOTIFY_URL: notifyUrl };
  // Asynchronous on purpose: the receiver above lives in this process and has to answer while a command runs.
  const cli = (...args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(root, 'dist/cli/main.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
  // fetch does not let a caller choose the Host header, which is the whole point of this check.
  const statusWithHost = (path, host) =>
    new Promise((done) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { Host: host }, agent: false }, (res) => {
        res.resume();
        done(res.statusCode);
      });
      req.on('error', () => done(0));
      req.end();
    });
  const server = spawn(process.execPath, [join(root, 'dist/cli/main.js'), 'serve', '--port', String(port), '--no-collectors'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => (stderr += chunk));

  const api = async (method, path, body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  };

  let browser;
  try {
    check('service starts', Boolean(await waitFor(async () => (await fetch(`${origin}/healthz`)).ok)));

    // -- HTTP API ---------------------------------------------------------------
    const added = await api('POST', '/api/accounts', { preset: { provider: 'claude', plan: 'max' } });
    check('add an account from the catalog over HTTP', added.status === 201, `status ${added.status}`);
    const suno = await api('POST', '/api/accounts', { preset: { provider: 'suno', plan: 'pro', billingDay: 12 } });
    check('add a billing-cycle account with its billing day', suno.status === 201 && suno.body.account.meters[0].reset.kind === 'monthly');
    const quick = await api('POST', '/api/quick', { text: 'claude weekly 62% resets in 14h' });
    check('quick update over HTTP', quick.status === 200 && quick.body.saved === true, quick.body && quick.body.preview);
    const rebinding = await statusWithHost('/api/state', 'evil.example');
    check('a foreign Host header is refused', rebinding === 403, `status ${rebinding}`);
    const crossSite = await fetch(`${origin}/api/quick`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"text":"claude 1%"}' }).then((r) => r.status);
    check('a cross-site write is refused', crossSite === 403, `status ${crossSite}`);

    // -- reminders and the command line, on the same state file ---------------------
    const calendar = await fetch(`${origin}/api/calendar.ics`);
    const ics = (await calendar.text()).replace(/\r\n /g, '');
    check('the calendar lists the coming reset', calendar.headers.get('content-type').startsWith('text/calendar') && ics.includes('SUMMARY:Use up Claude Max: weekly limit resets'));
    const status = (await api('GET', '/api/reminders')).body.reminders;
    check('the reminder status names the host of the address and not the address', status.webhook.configured && status.webhook.host === '127.0.0.1' && !JSON.stringify(status).includes('e2e-secret-topic'));
    const dry = await cli('notify', '--dry-run');
    check('notify --dry-run prints what is due', dry.status === 0 && dry.stdout.startsWith('Use Claude Max now'), dry.stdout.split('\n')[1]);
    const sent = await cli('notify', '--no-desktop');
    check('notify delivers the reminder to the address', sent.status === 0 && posts.length === 1 && posts[0].title === 'Use Claude Max now' && posts[0].body.includes('38% left of the weekly limit'));
    const again = await cli('notify', '--no-desktop');
    check('a second run has nothing to raise', again.status === 0 && again.stdout.trim() === 'Nothing is due.' && posts.length === 1);
    check('nothing the command printed repeats the address', !(dry.stdout + dry.stderr + sent.stdout + sent.stderr).includes('e2e-secret-topic'));
    const gate = await cli('status', '--check');
    check('status --check exits 2 while something needs using', gate.status === 2 && gate.stdout.includes('Claude Max'));
    const feed = await cli('calendar', '--days', '3');
    check('calendar prints an iCalendar document', feed.status === 0 && feed.stdout.startsWith('BEGIN:VCALENDAR\r\n') && feed.stdout.includes('BEGIN:VEVENT'));

    // -- dashboard ----------------------------------------------------------------
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.goto(origin);
    await page.waitForSelector('.row');
    check('the queue opens on what needs using', (await page.textContent('.group-head h2')).includes('Use now'));
    check('the summary counts it', (await page.textContent('.summary-line')).includes('needs using now'));
    check('the title carries the count', (await page.title()).startsWith('(1)'));
    check('the row shows the reading', (await page.textContent('.row')).includes('38%'));

    // -- MCP over HTTP, and the dashboard following along --------------------------
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'tokengator-e2e', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    const tools = await client.listTools();
    check('MCP lists its tools', tools.tools.some((tool) => tool.name === 'what_to_use') && tools.tools.some((tool) => tool.name === 'report_usage'), `${tools.tools.length} tools`);
    const first = await client.callTool({ name: 'what_to_use', arguments: {} });
    check('what_to_use puts the expiring quota first', JSON.stringify(first.structuredContent || first.content).includes('Claude'));
    const reported = await client.callTool({ name: 'report_usage', arguments: { account: 'suno', remaining: 1200, resetsInMinutes: 60 * 30 } });
    check('report_usage stores an agent reading', !reported.isError);
    const live = await waitFor(async () => (await page.textContent('#main')).includes('1,200 credits left'), 5000);
    check('the dashboard shows the agent reading within five seconds', Boolean(live));
    const state = (await api('GET', '/api/state')).body.state;
    const sunoMeter = state.accounts.find((account) => account.providerId === 'suno').meters[0];
    check('the reading is marked as reported by an agent', sunoMeter.source.kind === 'agent', JSON.stringify(sunoMeter.source));
    await client.close();

    // -- keyboard, quick entry, copy ------------------------------------------------
    await page.keyboard.press('3');
    await page.waitForSelector('.tl');
    check('key 3 shows the timeline and the address says so', page.url().endsWith('#timeline'));
    await page.keyboard.press('1');
    await page.keyboard.press('u');
    await page.waitForSelector('#quick-input');
    await page.keyboard.type('claude weekly 70%');
    const preview = await waitFor(async () => ((await page.textContent('.palette-preview')) || '').includes('70% used') && (await page.textContent('.palette-preview')));
    check('quick entry previews before saving', Boolean(preview), preview || '');
    await page.keyboard.press('Enter');
    const saved = await waitFor(async () => (await page.textContent('.row')).includes('30%'), 5000);
    check('quick entry saves and the row follows', Boolean(saved));
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    const clipboard = await waitFor(() => page.evaluate(() => navigator.clipboard.readText()).then((text) => (text.includes('# AI quota brief') ? text : null)), 3000);
    check('C copies the Markdown brief', Boolean(clipboard));
    const brief = await fetch(`${origin}/api/brief`).then((r) => r.text());
    check('the copied brief matches the service brief in substance', Boolean(clipboard) && brief.includes('Claude Max') && clipboard.includes('Claude Max'));

    // -- the reminders panel against the real service -------------------------------
    await page.locator('[aria-label="Menu"]').click();
    await page.locator('.menu .menu-item', { hasText: 'Reminders' }).click();
    await page.waitForSelector('dialog[open]');
    const panel = await page.locator('dialog[open]').innerText();
    check('the reminders panel shows the address by host only', panel.includes('Posting to 127.0.0.1') && !panel.includes('e2e-secret-topic'));
    const before = posts.length;
    await page.locator('dialog[open] button', { hasText: 'Send a test' }).click();
    const tested = await waitFor(() => posts.length > before && posts[posts.length - 1].title === 'Tokengator reminders work', 5000);
    check('"Send a test" reaches the address', Boolean(tested));
    const outcome = await waitFor(async () => (await page.locator('dialog[open] [role="status"]').innerText()).includes('Your address: test sent'), 5000);
    check('the panel reports the outcome of the test per route', Boolean(outcome), await page.locator('dialog[open] [role="status"]').innerText().catch(() => ''));
    await page.keyboard.press('Escape');

    // -- narrow screen ----------------------------------------------------------------
    await page.setViewportSize({ width: 400, height: 820 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal scrolling at 400 pixels', overflow <= 0, `${overflow}px`);
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    receiver.close();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    if (stderr.trim()) console.log(`service stderr:\n${stderr.trim().split('\n').slice(-8).join('\n')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
