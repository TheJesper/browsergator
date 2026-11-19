#!/usr/bin/env node
// Browser check of the dashboard, run against the single-file sample page so it needs no server.
//
//   node scripts/build.mjs --web --demo && node scripts/ui-check.cjs
//
// Playwright is not a dependency of this package: the check runs where it is installed and reports
// "skipped" where it is not. It drives the page the way a person would (keys, clicks, typing) and
// asserts what they would see: views, quick entry, dialogs, copy contents, focus, narrow layout.

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('ui-check: skipped (Playwright is not installed)');
  process.exit(0);
}

const page_ = resolve(__dirname, '..', 'dist', 'demo', 'index.html');
if (!existsSync(page_)) {
  console.error('ui-check: dist/demo/index.html is missing. Run: node scripts/build.mjs --web --demo');
  process.exit(1);
}
const URL_ = pathToFileURL(page_).href;

const results = [];
let failures = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${!pass && detail ? `\n        ${detail}` : ''}`);
}

async function open(browser, { width = 1280, height = 900, theme = 'light', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  });
  await page.goto(URL_);
  await page.waitForSelector('.row');
  return { context, page, errors, requests };
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const menuItem = (page, text) => page.locator('.menu .menu-item', { hasText: text }).first();
const dialogGone = (page) => page.waitForSelector('dialog[open]', { state: 'detached', timeout: 3000 }).then(() => true, () => false);
const mainText = (page) => page.locator('#main').innerText();

const VIEWS = [
  ['1', 'queue', '.queue'],
  ['2', 'board', '.cards'],
  ['3', 'timeline', '.tl'],
  ['4', 'table', '.tbl'],
  ['5', 'costs', '.spend'],
  ['6', 'history', '.hist-row']
];

async function views(browser) {
  console.log('\nViews and themes');
  for (const theme of ['light', 'dark']) {
    const { context, page, errors, requests } = await open(browser, { theme });
    for (const [key, name, selector] of VIEWS) {
      await page.keyboard.press(key);
      const shown = (await page.$(selector)) !== null;
      const hash = new URL(page.url()).hash.replace('#', '');
      const current = await page.locator('.tabs [aria-current="page"]').innerText();
      check(`${theme}: key ${key} shows ${name}`, shown && (hash === name || (name === 'queue' && hash === '')) && current.toLowerCase().startsWith(name), `shown=${shown} hash=${hash} current=${current}`);
      check(`${theme}: ${name} fits 1280 without sideways scroll`, (await overflow(page)) <= 0);
    }
    const scheme = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = scheme.match(/\d+/g).map(Number);
    check(`${theme}: page ground follows the system theme`, theme === 'dark' ? r + g + b < 200 : r + g + b > 600, scheme);
    check(`${theme}: no script errors`, errors.length === 0, errors.join(' | '));
    check(`${theme}: sample page makes no network requests`, requests.length === 0, requests.join(' | '));
    await context.close();
  }
}

async function narrow(browser) {
  console.log('\nPhone width');
  for (const theme of ['light', 'dark']) {
    const { context, page, errors } = await open(browser, { width: 400, height: 800, theme });
    for (const [key, name, selector] of VIEWS) {
      await page.keyboard.press(key);
      await page.waitForSelector(selector);
      check(`${theme} 400px: ${name} does not scroll sideways`, (await overflow(page)) <= 0, `overflow ${await overflow(page)}px`);
    }
    await page.keyboard.press('1');
    await page.locator('.row .row-name').first().click();
    await page.waitForSelector('.insp');
    const box = await page.locator('.insp').boundingBox();
    check(`${theme} 400px: details fit the screen`, box !== null && box.x >= 0 && box.x + box.width <= 400.5, JSON.stringify(box));
    // An overlay as tall as its content cannot be scrolled: everything below the fold would be out of reach.
    const reach = await page.evaluate(() => {
      const insp = document.querySelector('.insp');
      const last = [...insp.querySelectorAll('.insp-sec')].at(-1);
      last.scrollIntoView();
      const rect = last.getBoundingClientRect();
      return { bottom: insp.getBoundingClientRect().bottom, scrolls: insp.scrollHeight > insp.clientHeight, lastTop: rect.top, viewport: innerHeight };
    });
    check(`${theme} 400px: details end at the screen edge and scroll to their last section`, reach.bottom <= reach.viewport + 0.5 && reach.scrolls && reach.lastTop < reach.viewport, JSON.stringify(reach));
    await page.keyboard.press('Escape');
    await page.keyboard.press('u');
    await page.waitForSelector('dialog[open]');
    const dialog = await page.locator('dialog[open]').boundingBox();
    check(`${theme} 400px: quick entry fits the screen`, dialog !== null && dialog.x >= 0 && dialog.x + dialog.width <= 400.5, JSON.stringify(dialog));
    await page.keyboard.press('Escape');
    check(`${theme} 400px: no script errors`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
}

async function quickEntry(browser) {
  console.log('\nQuick entry');
  const { context, page, errors } = await open(browser);
  await page.keyboard.press('u');
  await page.waitForSelector('dialog[open]');
  check('U opens quick entry with the input focused', await page.evaluate(() => document.activeElement?.id === 'quick-input'));
  await page.keyboard.type('suno 1200 left resets in 9d');
  await page.waitForSelector('.palette-preview.ok');
  const preview = await page.locator('.palette-preview').innerText();
  check('the preview spells out used and left before saving', /1,300 credits used/.test(preview) && /1,200 credits left/.test(preview) && /in 9d/.test(preview), preview);
  await page.keyboard.press('Enter');
  check('Enter saves and closes', await dialogGone(page));
  const row = page.locator('.row[data-id="suno:credits"], .row[data-id^="suno"]').first();
  const text = (await row.count()) ? await row.innerText() : await mainText(page);
  check('the row shows the new reading', /48%/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));

  await page.keyboard.press('u');
  await page.waitForSelector('dialog[open]');
  await page.keyboard.type('claude 50%');
  await page.waitForFunction(() => document.querySelectorAll('dialog[open] .cands > *').length > 0, null, { timeout: 3000 }).catch(() => undefined);
  const candidates = await page.locator('dialog[open] .cands > *').count();
  check('an ambiguous name lists the meters it could mean', candidates >= 2, `candidates=${candidates}`);
  await page.keyboard.press('Escape');
  check('Esc closes without saving', await dialogGone(page));

  await page.keyboard.press('u');
  await page.waitForSelector('dialog[open]');
  await page.keyboard.type('nosuchthing 50%');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check('an unknown name stays open and says why', (await page.$('dialog[open]')) !== null && !/ok/.test((await page.locator('.palette-preview').getAttribute('class')) ?? ''));
  await page.keyboard.press('Escape');
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function inspector(browser) {
  console.log('\nInspector');
  const { context, page, errors } = await open(browser);
  const first = page.locator('.row .row-name').first();
  await first.click();
  await page.waitForSelector('.insp');
  check('a row opens its details and says so to assistive tech', (await first.getAttribute('aria-expanded')) === 'true');
  const chartMarks = await page.locator('.insp .chart svg').count();
  check('details draw the window chart', chartMarks >= 1);
  await page.fill('#insp-update', '70%');
  await page.waitForTimeout(200);
  const preview = await page.locator('.insp .preview').innerText();
  check('inline update previews the reading', /70%/.test(preview), preview);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /70%/.test(document.querySelector('.insp .facts')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => undefined);
  check('inline update saves', /70%/.test(await page.locator('.insp .facts').innerText()));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  check('Esc closes the details', (await page.$('.insp')) === null);
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function copying(browser) {
  console.log('\nCopy');
  const { context, page, errors } = await open(browser);
  await page.keyboard.press('c');
  await page.waitForSelector('.toast');
  const brief = await clipboard(page);
  check('C copies a Markdown brief', brief.startsWith('#') && /Claude Max/.test(brief) && /Use now/i.test(brief), brief.slice(0, 120));
  check('copying is confirmed on screen', /cop/i.test(await page.locator('.toast').first().innerText()));

  const copyButton = page.locator('.row [aria-label^="Copy "]').first();
  const wanted = [
    ['Copy status line', (text) => /^Claude Max, Weekly limit: /.test(text) && !text.includes('\n')],
    ['Copy as Markdown', (text) => /Claude Max/.test(text) && /\*\*|^#|^- /m.test(text)],
    ['Copy as JSON', (text) => JSON.parse(text) && /claude-max:weekly/.test(text)],
    ['Copy agent prompt', (text) => /Claude Max/.test(text) && text.length > 120]
  ];
  for (const [label, valid] of wanted) {
    await copyButton.click();
    await menuItem(page, label).click();
    await page.waitForTimeout(120);
    const text = await clipboard(page);
    let pass;
    try {
      pass = Boolean(valid(text));
    } catch {
      pass = false;
    }
    check(`${label} puts the right thing on the clipboard`, pass, text.slice(0, 140));
  }

  await page.keyboard.press('4');
  await page.waitForSelector('.tbl');
  for (const [label, valid] of [
    ['CSV', (text) => text.split('\n').length > 3 && text.split('\n')[0].includes(',')],
    ['Markdown', (text) => text.split('\n').length > 3 && text.startsWith('|') && /\| ?-{3}/.test(text)]
  ]) {
    const button = page.getByRole('button', { name: label, exact: true });
    if ((await button.count()) === 0) {
      check(`the table offers ${label}`, false, 'no such button');
      continue;
    }
    await button.click();
    await page.waitForTimeout(120);
    const text = await clipboard(page);
    check(`the table copies as ${label}`, valid(text), text.slice(0, 100));
  }

  // Without clipboard access the text is offered for manual copying instead of being lost.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  });
  await page.keyboard.press('1');
  await page.keyboard.press('c');
  await page.waitForSelector('dialog[open] textarea', { timeout: 3000 }).catch(() => undefined);
  const manual = await page.$('dialog[open] textarea');
  check('a refused clipboard falls back to selectable text', manual !== null && /Claude Max/.test(await manual.inputValue()));
  await page.keyboard.press('Escape');
  check('no script errors', errors.filter((message) => !/denied/.test(message)).length === 0, errors.join(' | '));
  await context.close();
}

async function managing(browser) {
  console.log('\nAdd, edit, snooze, delete, connect');
  const { context, page, errors } = await open(browser);

  // Add from the catalog.
  await page.keyboard.press('a');
  await page.waitForSelector('dialog[open]');
  await page.fill('#add-search', 'udio');
  await page.locator('dialog[open] .provider', { hasText: 'Udio' }).click();
  const add = page.locator('dialog[open] .btn.primary');
  await page.waitForFunction(() => !document.querySelector('dialog[open] .btn.primary')?.disabled, null, { timeout: 3000 }).catch(() => undefined);
  await add.click();
  check('a catalog subscription is added', (await dialogGone(page)) && /Udio/.test(await mainText(page)));

  // Add a custom one.
  await page.keyboard.press('a');
  await page.waitForSelector('dialog[open]');
  await page.locator('dialog[open] .provider', { hasText: 'Something else' }).click();
  await page.fill('#add-label', 'Check Custom');
  await page.fill('dialog[open] input[id$="-label"]:not(#add-label)', 'Fast hours');
  await page.selectOption('dialog[open] select[id$="-unit"]', 'hours');
  await page.fill('dialog[open] input[id$="-limit"]', '15');
  await page.locator('dialog[open] .btn.primary').click();
  check('a custom subscription is added', (await dialogGone(page)) && /Check Custom/.test(await mainText(page)), await page.locator('dialog[open] .err').innerText().catch(() => ''));

  // Refuse an incomplete one, in place.
  await page.keyboard.press('a');
  await page.waitForSelector('dialog[open]');
  await page.locator('dialog[open] .provider', { hasText: 'Something else' }).click();
  await page.fill('#add-label', '');
  const disabled = await page.locator('dialog[open] .btn.primary').isDisabled();
  if (!disabled) await page.locator('dialog[open] .btn.primary').click();
  await page.waitForTimeout(150);
  check('an incomplete subscription is refused in the dialog', (await page.$('dialog[open]')) !== null);
  await page.keyboard.press('Escape');

  // Edit. (A new subscription opens in the details pane, which takes over the row's own actions.)
  await page.keyboard.press('Escape');
  const row = page.locator('.row', { hasText: 'Check Custom' }).first();
  await row.locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'Edit subscription').click();
  await page.waitForSelector('dialog[open]');
  const label = page.locator('dialog[open] input').first();
  await label.fill('Check Renamed');
  await page.locator('dialog[open] .btn.primary').click();
  check('an edit is saved', (await dialogGone(page)) && /Check Renamed/.test(await mainText(page)));

  // Snooze.
  const urgent = page.locator('.row').first();
  const urgentId = await urgent.getAttribute('data-id');
  await urgent.locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'For a day').click();
  await page.waitForTimeout(200);
  const firstNow = await page.locator('.row').first().getAttribute('data-id');
  check('a snoozed quota leaves the top of the queue', firstNow !== urgentId, `still first: ${firstNow}`);
  check('a snoozed quota stays on screen', /Snoozed/i.test(await mainText(page)));

  // Delete, with a confirmation that can be declined.
  const target = page.locator('.row', { hasText: 'Check Renamed' }).first();
  await target.locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'Delete').click();
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  await dialogGone(page);
  check('declining the confirmation keeps the subscription', /Check Renamed/.test(await mainText(page)));
  await page.locator('.row', { hasText: 'Check Renamed' }).first().locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'Delete').click();
  await page.waitForSelector('dialog[open]');
  await page.locator('dialog[open] .btn.danger, dialog[open] .btn.primary').last().click();
  await dialogGone(page);
  check('confirming removes it', !/Check Renamed/.test(await mainText(page)));

  // Connect panel.
  await page.locator('[aria-label="Menu"]').click();
  await menuItem(page, 'Connect agents').click();
  await page.waitForSelector('dialog[open] .snip');
  const panel = await page.locator('dialog[open]').innerText();
  check('the connect panel has MCP, status line and skill snippets', /mcp/i.test(panel) && /statusline/i.test(panel) && /skill/i.test(panel));
  await page.locator('dialog[open] .snip .btn.small').first().click();
  await page.waitForTimeout(120);
  check('a snippet copies', /tokengator/i.test(await clipboard(page)), (await clipboard(page)).slice(0, 120));
  await page.keyboard.press('Escape');
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function reminders(browser) {
  console.log('\nReminders panel');
  const { context, page, errors } = await open(browser);
  // Nothing may ask for notification permission before the person chooses to switch it on.
  await page.evaluate(() => {
    window.__asked = 0;
    const ask = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args) => {
      window.__asked += 1;
      return ask(...args);
    };
  });
  await page.locator('[aria-label="Menu"]').click();
  await menuItem(page, 'Reminders').click();
  await page.waitForSelector('dialog[open]');
  const panel = page.locator('dialog[open]');
  const text = await panel.innerText();
  check('the panel lists every route: tab, this computer, phone or chat, calendar', ['In this browser tab', 'On this computer', 'On your phone or in a chat', 'In your calendar'].every((title) => text.includes(title)));
  check('on sample data it says which routes need the local service', /Needs the local service/.test(text));
  check('opening the panel asks for no permission', (await page.evaluate(() => window.__asked)) === 0);
  await panel.locator('.collector', { hasText: 'In this browser tab' }).getByRole('button').click();
  await page.waitForTimeout(250);
  check('switching the tab route on is what asks for permission', (await page.evaluate(() => window.__asked)) === 1);
  check('the tab route says it stays quiet on sample data', /Quiet while this page shows sample data/.test(await panel.innerText()));
  await panel.locator('button', { hasText: 'Copy as .ics' }).click();
  await page.waitForTimeout(150);
  const ics = await clipboard(page);
  check('the calendar copies as an iCalendar document', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('BEGIN:VEVENT') && ics.trimEnd().endsWith('END:VCALENDAR'), ics.slice(0, 60));
  await page.keyboard.press('Escape');
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function keyboard(browser) {
  console.log('\nKeyboard only');
  const { context, page, errors } = await open(browser);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  const second = await page.locator('.row .row-name').nth(1).getAttribute('data-id');
  check('J moves focus down the rows', (await page.evaluate(() => document.activeElement?.getAttribute('data-id'))) === second);
  await page.keyboard.press('k');
  const firstId = await page.locator('.row .row-name').first().getAttribute('data-id');
  check('K moves it back', (await page.evaluate(() => document.activeElement?.getAttribute('data-id'))) === firstId);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.insp');
  check('Enter opens the focused row', true);
  await page.keyboard.press('Escape');
  check('Esc returns focus to the row', (await page.evaluate(() => document.activeElement?.getAttribute('data-id'))) === firstId);

  await page.keyboard.press('/');
  check('/ focuses the filter', await page.evaluate(() => document.activeElement?.id === 'filter'));
  await page.keyboard.type('suno');
  await page.waitForTimeout(150);
  const rows = await page.locator('.row').count();
  check('typing filters the rows', rows >= 1 && (await page.locator('.row', { hasText: 'Suno' }).count()) === rows, `rows=${rows}`);
  check('view keys are typed, not acted on, inside the filter', await (async () => {
    await page.keyboard.type('3');
    return (await page.inputValue('#filter')) === 'suno3' && (await page.$('.tl')) === null;
  })());
  await page.keyboard.press('Escape');
  check('Esc clears the filter', (await page.inputValue('#filter')) === '');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  await page.keyboard.press('?');
  await page.waitForSelector('dialog[open]');
  check('? lists the shortcuts', /shortcut/i.test(await page.locator('dialog[open]').innerText()));
  check('focus is inside the dialog', await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement) ?? false));
  await page.keyboard.press('Escape');
  await dialogGone(page);

  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.keyboard.press('t');
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('T switches the theme', before !== after && (after === 'dark' || after === 'light'), `${before} -> ${after}`);

  await page.keyboard.press('s');
  await page.waitForSelector('.toast');
  check('S changes the order and says which', /order|sort|first|soon|risk|name/i.test(await page.locator('.toast').last().innerText()));

  // Tab reaches every control in the bar, and every one shows a focus ring.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const seen = [];
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { tag: el.tagName, ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none' };
    }));
  }
  const focused = seen.filter(Boolean);
  check('Tab walks the controls', focused.length >= 12, `${focused.length} stops`);
  check('every stop shows a focus ring', focused.every((stop) => stop.ring), JSON.stringify(focused.filter((stop) => !stop.ring)));

  check('the tab title counts what needs using', /^\(\d+\) /.test(await page.title()), await page.title());
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function motion(browser) {
  console.log('\nReduced motion');
  const { context, page } = await open(browser, { reducedMotion: 'reduce' });
  await page.locator('.row .row-name').first().click();
  await page.waitForSelector('.insp');
  const moving = await page.evaluate(() => {
    const seconds = (value) => Math.max(...value.split(',').map((part) => (part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part) || 0)));
    return [...document.querySelectorAll('.row, .insp, .tab, .btn, .seg-used, .seg-exp, .fbar-now')]
      .map((el) => getComputedStyle(el))
      .filter((style) => seconds(style.transitionDuration) > 0.02 || (style.animationName !== 'none' && seconds(style.animationDuration) > 0.02)).length;
  });
  check('nothing animates when motion is reduced', moving === 0, `${moving} moving elements`);
  await context.close();
}

// Sample quotas are invented, so no real notification may ever be raised for them: not with the tab
// route switched on, and not with permission already granted.
async function sampleStaysQuiet(browser) {
  console.log('\nSample data and notifications');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__raised = [];
    class Quiet {
      constructor(title) {
        window.__raised.push(title);
      }
      static requestPermission() {
        return Promise.resolve('granted');
      }
    }
    Quiet.permission = 'granted';
    window.Notification = Quiet;
    localStorage.setItem('tokengator.prefs.v1', JSON.stringify({ notify: true }));
  });
  const page = await context.newPage();
  await page.goto(URL_);
  await page.waitForSelector('.row');
  await page.waitForTimeout(400);
  const useNow = await page.locator('.tabs .count').innerText().catch(() => '0');
  const raised = await page.evaluate(() => window.__raised);
  check('the sample has quotas to use now', Number(useNow) > 0, `count ${useNow}`);
  check('no notification is raised for sample data', raised.length === 0, raised.join(' | '));
  await context.close();
}

// What the design review found: where the eye lands, and what a narrow list keeps.
async function designed(browser) {
  console.log('\nDesign review findings');
  const { context, page, errors } = await open(browser);
  const rgb = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);

  const urgent = await page.evaluate(() => {
    const style = (selector) => {
      const el = document.querySelector(selector);
      return el ? { background: getComputedStyle(el).backgroundColor, size: parseFloat(getComputedStyle(el).fontSize) } : null;
    };
    return {
      urgentRow: style('.row.r-use-now'),
      quietRow: style('.row.r-quiet'),
      urgentCountdown: style('.row.r-use-now .row-reset .v'),
      urgentLeft: style('.row.r-use-now .row-left .v'),
      quietCountdown: style('.row.r-quiet .row-reset .v'),
      quietLeft: style('.row.r-quiet .row-left .v'),
      tinted: document.querySelectorAll('.row.r-use-now').length,
      underUseNow: [...document.querySelectorAll('.group')][0]?.querySelectorAll('.row').length ?? 0
    };
  });
  check('only the rows to use now are tinted', urgent.tinted > 0 && urgent.tinted === urgent.underUseNow && rgb(urgent.urgentRow.background).length === 3 && urgent.quietRow.background === 'rgba(0, 0, 0, 0)', JSON.stringify(urgent));
  check('in an urgent row the countdown is the largest figure, elsewhere the share left is', urgent.urgentCountdown.size > urgent.urgentLeft.size && urgent.quietLeft.size > urgent.quietCountdown.size, JSON.stringify(urgent));

  const bar = await page.evaluate(() => {
    const proj = document.querySelector('.fbar .seg-proj');
    const stale = document.querySelector('.fbar.uncertain .fbar-track');
    return {
      projection: proj ? { background: getComputedStyle(proj).backgroundColor, outline: getComputedStyle(proj).boxShadow } : null,
      stale: stale ? { opacity: getComputedStyle(stale).opacity, filter: getComputedStyle(stale).filter } : null
    };
  });
  check('the projection is an outline, not a fill', bar.projection !== null && bar.projection.background === 'rgba(0, 0, 0, 0)' && /inset/.test(bar.projection.outline), JSON.stringify(bar.projection));
  check('a stale bar is washed out, not faded', bar.stale !== null && bar.stale.opacity === '1' && /saturate/.test(bar.stale.filter), JSON.stringify(bar.stale));

  // A click on a figure opens the row, and nothing else changes.
  const leftBefore = await page.locator('.row .row-left .v').first().innerText();
  await page.locator('.row .row-left').first().click();
  await page.waitForSelector('.insp');
  check('clicking the share left opens the row and leaves the figure as it was', (await page.locator('.row .row-left .v').first().innerText()) === leftBefore);
  const valueShown = await page.evaluate(() => {
    const value = document.querySelector('.row .row-value');
    return value ? getComputedStyle(value).display !== 'none' && value.getBoundingClientRect().width > 0 : false;
  });
  check('the value at risk stays on the row beside the open details at 1280px', valueShown);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Every menu item is in view.
  await page.click('[aria-label="Menu"]');
  await page.waitForSelector('.menu');
  const menu = await page.evaluate(() => {
    const el = document.querySelector('.menu');
    const last = [...el.querySelectorAll('.menu-item')].at(-1).getBoundingClientRect();
    return { scrolls: el.scrollHeight > el.clientHeight + 1, lastBottom: last.bottom, menuBottom: el.getBoundingClientRect().bottom, viewport: innerHeight };
  });
  check('the main menu shows its last item whole', !menu.scrolls && menu.lastBottom <= menu.menuBottom && menu.menuBottom <= menu.viewport, JSON.stringify(menu));
  await page.keyboard.press('Escape');

  // Without tier headings every row names its own state.
  await page.click('#sort-button');
  await menuItem(page, 'Soonest reset').click();
  const chips = await page.evaluate(() => ({ rows: document.querySelectorAll('.row').length, chips: document.querySelectorAll('.row .row-name .state').length }));
  check('in any other order every row carries its state', chips.rows > 3 && chips.chips === chips.rows, JSON.stringify(chips));
  await page.click('#sort-button');
  await menuItem(page, 'Use first').click();
  check('under the tier headings the heading carries it', (await page.locator('.row .row-name .state').count()) === 0);

  // The table's header stays under the app bar when the table is scrolled.
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.keyboard.press('4');
  await page.waitForSelector('.tbl');
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(150);
  const head = await page.evaluate(() => ({ top: document.querySelector('.tbl thead th').getBoundingClientRect().top, bar: document.querySelector('header.bar').getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  check('the table header stays under the app bar while the table scrolls', Math.abs(head.top - head.bar) <= 1.5 && head.overflow <= 0, JSON.stringify(head));
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();

  // Phone: the list starts in the top half and the toolbar is one line.
  const phone = await open(browser, { width: 400, height: 860 });
  const layout = await phone.page.evaluate(() => ({
    firstRow: document.querySelector('.row').getBoundingClientRect().top,
    toolbar: document.querySelector('.toolbar').getBoundingClientRect().height,
    value: getComputedStyle(document.querySelector('.row .row-value')).display,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  check('at 400px the list starts in the top half of the screen', layout.firstRow < 440 && layout.toolbar < 60 && layout.overflow <= 0, JSON.stringify(layout));
  check('at 400px a row still shows its value at risk', layout.value !== 'none', layout.value);
  await phone.page.keyboard.press('3');
  await phone.page.waitForSelector('.tl-grid');
  const ticks = await phone.page.evaluate(() => [...document.querySelectorAll('.tl-tick')].filter((tick) => getComputedStyle(tick).display !== 'none').map((tick) => tick.getBoundingClientRect()).map((box) => [box.left, box.right]));
  check('at 400px no two axis labels of the Timeline overlap', ticks.every((box, index) => index === 0 || box[0] >= ticks[index - 1][1] - 0.5), JSON.stringify(ticks));
  await phone.context.close();
}

// What the accessibility review found, each pinned by a check.
async function accessible(browser) {
  console.log('\nAccessibility review findings');
  const phone = await open(browser, { width: 400, height: 800 });
  const page = phone.page;

  // Below the docking width the details pane is a dialog: focus starts in it and cannot reach what it covers.
  await page.keyboard.press('j');
  const rowId = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.insp');
  const modal = await page.evaluate(() => ({
    inside: document.querySelector('.insp').contains(document.activeElement),
    role: document.querySelector('.insp').getAttribute('role'),
    behind: ['header.bar', '.summary', '.toolbar', '#main'].every((selector) => document.querySelector(selector).inert),
    scrim: document.querySelector('.scrim').tabIndex
  }));
  check('at 400px the open details pane takes focus and makes the page behind it inert', modal.inside && modal.role === 'dialog' && modal.behind && modal.scrim === -1, JSON.stringify(modal));
  let escaped = 0;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement !== document.body && !document.querySelector('.insp').contains(document.activeElement))) escaped += 1;
  }
  check('Tab never lands on a control hidden behind the pane', escaped === 0, `${escaped} stops outside`);
  await page.locator('#insp-update').focus();
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => ({ pane: document.querySelector('.insp') !== null, focus: document.activeElement?.getAttribute('data-id'), inert: document.querySelector('#main').inert }));
  check('Esc in the Update field closes the pane and returns focus to its row', !closed.pane && closed.focus === rowId && !closed.inert, JSON.stringify(closed));

  // The filter is reachable at phone width, by its button and by "/".
  await page.keyboard.press('/');
  const filter = await page.evaluate(() => ({ focused: document.activeElement?.id, shown: getComputedStyle(document.querySelector('.filter')).display !== 'none', expanded: document.querySelector('.filter-toggle').getAttribute('aria-expanded') }));
  check('at 400px "/" opens the filter field and focuses it', filter.focused === 'filter' && filter.shown && filter.expanded === 'true', JSON.stringify(filter));
  await page.keyboard.type('suno');
  await page.waitForTimeout(150);
  check('the phone filter filters', (await page.locator('.row').count()) === (await page.locator('.row', { hasText: 'Suno' }).count()));
  await page.keyboard.press('Escape');
  check('Esc clears it and returns focus to its button', (await page.evaluate(() => document.activeElement?.classList.contains('filter-toggle') ?? false)) && (await page.locator('.row').count()) > 3);

  // Moving up the list never parks focus under the sticky header.
  for (let i = 0; i < 14; i += 1) await page.keyboard.press('j');
  let covered = 0;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('k');
    if (await page.evaluate(() => document.activeElement.getBoundingClientRect().top < document.querySelector('header.bar').getBoundingClientRect().bottom - 1)) covered += 1;
  }
  check('moving up with K never hides the focused row under the header', covered === 0, `${covered} covered`);
  check('no script errors at 400px', phone.errors.length === 0, phone.errors.join(' | '));
  await phone.context.close();

  // 320px is 1280px at 400% zoom: nothing may need sideways scrolling.
  const small = await open(browser, { width: 320, height: 640 });
  for (const [key, name, selector] of VIEWS) {
    await small.page.keyboard.press(key);
    await small.page.waitForSelector(selector);
    await small.page.waitForTimeout(120);
    check(`320px: ${name} does not scroll sideways`, (await overflow(small.page)) <= 0, `overflow ${await overflow(small.page)}px`);
  }
  await small.context.close();

  const { context, page: desk, errors } = await open(browser);
  // Figures and their annotations are separate words for a screen reader and the clipboard.
  const stat = await desk.evaluate(() => [...document.querySelectorAll('.stat dd')].map((dd) => dd.textContent));
  // "about $39 80% used", never "about $3980% used"; "$23.10 + $82.05 in credits", never "$23.10+ ...".
  const apart = (text) => (!/% used$/.test(text) || / \d+% used$/.test(text)) && (!text.includes('+') || text.includes(' + '));
  check('a figure and its annotation do not run together', stat.every(apart) && stat.some((text) => / \d+% used$/.test(text)), JSON.stringify(stat));
  // The row's name for a screen reader carries its tags.
  const named = await desk.evaluate(() => [...document.querySelectorAll('.row')].filter((row) => row.querySelector('.tag')).map((row) => ({ tag: row.querySelector('.tag').textContent, label: row.querySelector('.row-name').getAttribute('aria-label') })));
  check('a row\'s accessible name includes its tags', named.length > 0 && named.every((row) => row.label.includes(row.tag)), JSON.stringify(named.slice(0, 2)));

  // Tab from a menu continues from the button that opened it.
  await desk.locator('#sort-button').focus();
  await desk.keyboard.press('Enter');
  await desk.waitForSelector('.menu');
  await desk.keyboard.press('Tab');
  const afterMenu = await desk.evaluate(() => ({ menu: document.querySelector('.menu') !== null, tag: document.activeElement?.tagName, inToolbar: document.activeElement?.closest('.toolbar') !== null }));
  check('Tab in a menu closes it and carries on from its button', !afterMenu.menu && afterMenu.inToolbar, JSON.stringify(afterMenu));

  // Focus rings are drawn inside boxes that would clip them, and a menu item shows one.
  await desk.locator('#sort-button').focus();
  await desk.keyboard.press('Enter');
  await desk.waitForSelector('.menu');
  const ring = await desk.evaluate(() => ({ style: getComputedStyle(document.activeElement).outlineStyle, offset: getComputedStyle(document.activeElement).outlineOffset, width: getComputedStyle(document.activeElement).outlineWidth }));
  check('the focused menu item has a focus ring', ring.style === 'solid' && ring.offset === '-2px' && ring.width === '2px', JSON.stringify(ring));
  await desk.keyboard.press('Escape');

  // Single-key shortcuts can be switched off; arrow keys and Esc still work.
  await desk.click('[aria-label="Menu"]');
  await menuItem(desk, 'Single-key shortcuts').click();
  await desk.locator('.tabs .tab').first().focus();
  await desk.keyboard.press('2');
  await desk.keyboard.press('t');
  const off = await desk.evaluate(() => ({ board: document.querySelector('.cards') !== null, theme: document.documentElement.getAttribute('data-theme') }));
  check('with single-key shortcuts off, 2 and T do nothing', !off.board && off.theme === null, JSON.stringify(off));
  await desk.keyboard.press('ArrowDown');
  check('arrow keys still move through the rows', (await desk.evaluate(() => document.activeElement?.getAttribute('data-nav'))) === 'row');
  await desk.click('[aria-label="Menu"]');
  await menuItem(desk, 'Single-key shortcuts').click();
  await desk.locator('.tabs .tab').first().focus();
  await desk.keyboard.press('2');
  check('switched back on, 2 shows the Board', (await desk.$('.cards')) !== null);
  await desk.keyboard.press('1');

  // A message raised while a dialog is open is inside that dialog, where it can be read and announced.
  await desk.click('[aria-label="Menu"]');
  await menuItem(desk, 'Connect agents').click();
  await desk.waitForSelector('dialog[open]');
  await desk.locator('dialog[open] .snip .btn.small').first().click();
  await desk.waitForSelector('.toast');
  check('a toast raised from a dialog is shown inside it', await desk.evaluate(() => document.querySelector('dialog[open]').contains(document.querySelector('.toast'))));
  await desk.keyboard.press('Escape');
  check('and the region returns to the page when the dialog closes', await desk.evaluate(() => document.querySelector('.toasts').parentElement === document.body));

  // The Add dialog keeps focus on the category that was chosen, and moves on to the plan after a provider.
  await desk.keyboard.press('a');
  await desk.waitForSelector('dialog[open]');
  const coding = desk.locator('dialog[open] .chip-btn', { hasText: 'Coding' });
  await coding.focus();
  await desk.keyboard.press('Enter');
  check('choosing a category in Add keeps focus on it', (await desk.evaluate(() => document.activeElement?.textContent)) === 'Coding');
  await desk.locator('dialog[open] .provider').first().focus();
  await desk.keyboard.press('Enter');
  check('choosing a provider moves focus to its plans', await desk.evaluate(() => document.activeElement?.getAttribute('type') === 'radio'));
  await desk.keyboard.press('Escape');

  // A snoozed row keeps its text at full strength.
  check('no row is faded as a whole', await desk.evaluate(() => [...document.querySelectorAll('.row')].every((row) => getComputedStyle(row).opacity === '1')));
  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();

  // Contrast themes: states that were fills or shadows are restated with system colours and outlines.
  const forced = await browser.newContext({ viewport: { width: 1280, height: 900 }, forcedColors: 'active' });
  const high = await forced.newPage();
  await high.goto(URL_);
  await high.waitForSelector('.row');
  const marks = await high.evaluate(() => {
    const style = (selector) => {
      const el = document.querySelector(selector);
      return el ? { outline: getComputedStyle(el).outlineStyle, background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage, border: getComputedStyle(el).borderBottomStyle } : null;
    };
    return { projection: style('.fbar .seg-proj'), expiring: style('.row.r-quiet .fbar .seg-exp'), tab: style('.tab[aria-current="page"]'), chip: style('.chip-btn[aria-pressed="true"]'), plain: style('.chip-btn[aria-pressed="false"]') };
  });
  check('forced colours: the projection is an outline, since shadows are dropped', marks.projection?.outline === 'solid', JSON.stringify(marks.projection));
  check('forced colours: the expiring share is still hatched', /repeating-linear-gradient/.test(marks.expiring?.image ?? ''), JSON.stringify(marks.expiring));
  check('forced colours: the current view and a pressed chip are marked', marks.tab?.border === 'solid' && marks.chip?.background !== marks.plain?.background, JSON.stringify({ tab: marks.tab, chip: marks.chip, plain: marks.plain }));
  await forced.close();
}

// What the independent review found in the dashboard's logic, each pinned by a check.
async function reviewed(browser) {
  console.log('\nReview findings');
  const { context, page, errors } = await open(browser);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#main [data-nav="row"]')].map((row) => row.dataset.id));
  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}${el.id ? `#${el.id}` : ''}:${(el.getAttribute('title') ?? el.textContent ?? '').trim().slice(0, 40)}` : 'none';
  });

  // The Timeline follows the chosen order like every other view.
  await page.click('#sort-button');
  await menuItem(page, 'Most value at risk').click();
  check('choosing an order from the menu leaves focus on the Sort button', (await active()).startsWith('BUTTON#sort-button'), await active());
  const queueOrder = await rows();
  await page.keyboard.press('3');
  await page.waitForSelector('.tl-grid');
  // Rows inside the horizon come first and later ones after; within each group the chosen order holds.
  const onAxis = await page.evaluate(() => [...document.querySelectorAll('.tl-grid [data-nav="row"]')].map((row) => row.dataset.id));
  const expected = queueOrder.filter((id) => onAxis.includes(id));
  const chronological = await page.evaluate(() => [...document.querySelectorAll('.tl-grid [data-nav="row"]')].length);
  check('the Timeline lists rows in the chosen order', onAxis.length > 2 && chronological > 2 && JSON.stringify(onAxis) === JSON.stringify(expected), `${onAxis.join(',')} vs ${expected.join(',')}`);
  await page.click('#sort-button');
  await menuItem(page, 'Use first').click();
  await page.keyboard.press('1');

  // Focus survives a redraw.
  await page.locator('.tabs .tab', { hasText: 'Board' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cards');
  check('activating a view tab keeps focus on it', /^BUTTON:Board/.test(await active()), await active());
  await page.locator('.tabs .tab', { hasText: 'Queue' }).focus();
  await page.keyboard.press('Enter');
  const chip = page.locator('.chips .chip-btn', { hasText: 'Coding' });
  await chip.focus();
  await page.keyboard.press('Enter');
  check('activating a category keeps focus on it', /^BUTTON:Coding/.test(await active()), await active());
  await page.locator('.chips .chip-btn', { hasText: 'All' }).click();

  // An open menu owns the keyboard, and what changed under it is drawn when it closes.
  await page.click('#sort-button');
  await page.keyboard.press('2');
  await page.keyboard.press('Escape');
  check('a view key pressed over an open menu changes nothing', (await page.$('.cards')) === null && !/board/.test(await page.evaluate(() => location.hash)));

  // The details pane keeps its place when the page is redrawn.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.locator('.row .row-name').first().click();
  await page.waitForSelector('.insp');
  await page.evaluate(() => { document.querySelector('.insp').scrollTop = 400; });
  await page.keyboard.press('t'); // a preference change redraws everything
  await page.waitForTimeout(150);
  const kept = await page.evaluate(() => document.querySelector('.insp').scrollTop);
  check('a redraw keeps the details pane scrolled where it was', kept >= 380, `scrollTop ${kept}`);
  await page.keyboard.press('t');
  await page.locator('.insp .insp-close, .insp [aria-label="Close details"]').first().evaluate((el) => el.focus());
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Changing a window's length keeps the reset time shown in the form.
  const claude = page.locator('.row', { hasText: 'Claude Max' }).first();
  await claude.locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'Edit subscription').click();
  await page.waitForSelector('dialog[open]');
  const length = page.locator('dialog[open] input[id$="-every"]').first();
  const shownReset = await page.locator('dialog[open] input[id$="-resets"]').first().inputValue();
  await length.fill('5');
  await page.locator('dialog[open] .btn.primary').click();
  await dialogGone(page);
  const weeklyRow = await page.locator('.row', { hasText: 'Claude Max' }).first().innerText();
  check('changing a window length keeps its reset time', shownReset !== '' && !/set the reset time/i.test(weeklyRow), weeklyRow.replace(/\s+/g, ' ').slice(0, 140));

  // A Save that was refused part-way does not repeat what it already did.
  const gpt = page.locator('.row', { hasText: 'ChatGPT Plus' }).first();
  await gpt.locator('[aria-label^="More actions"]').click();
  await menuItem(page, 'Edit subscription').click();
  await page.waitForSelector('dialog[open]');
  const addMeter = page.locator('dialog[open] button', { hasText: 'Add a meter' });
  await addMeter.click();
  await page.locator('dialog[open] fieldset.meter-form').last().locator('input[id$="-label"]').fill('Extra A');
  await addMeter.click();
  const second = page.locator('dialog[open] fieldset.meter-form').last();
  await second.locator('input[id$="-label"]').fill('Extra B');
  await second.locator('select[id$="-unit"]').selectOption('credits');
  await page.locator('dialog[open] .btn.primary').click();
  await page.waitForTimeout(200);
  check('a meter without a limit is refused before anything is sent', (await page.$('dialog[open]')) !== null && /limit/i.test(await page.locator('dialog[open] .err').innerText()));
  await second.locator('input[id$="-limit"]').fill('500');
  await page.locator('dialog[open] .btn.primary').click();
  await dialogGone(page);
  await page.keyboard.press('2');
  await page.waitForSelector('.cards');
  const card = await page.locator('.card', { hasText: 'ChatGPT Plus' }).first().innerText();
  check('saving again adds each new meter once', (card.match(/Extra A/g) ?? []).length === 1 && (card.match(/Extra B/g) ?? []).length === 1, card.replace(/\s+/g, ' ').slice(0, 200));
  await page.keyboard.press('1');

  // The copied line always says how much is left.
  const behind = page.locator('.row', { hasText: 'Monthly API credits' }).first();
  if ((await behind.count()) > 0) {
    await behind.locator('[aria-label^="Copy "]').click();
    await menuItem(page, 'Copy status line').click();
    await page.waitForTimeout(120);
    const line = await clipboard(page);
    check('a behind-pace status line says what is left', /Behind pace: .+ left, about \d+% will expire, resets in/.test(line), line);
  } else check('a behind-pace status line says what is left', false, 'the sample has no behind-pace row');

  // With names hidden, no account name is readable anywhere on the page or in a menu.
  await page.click('[aria-label="Menu"]');
  await menuItem(page, 'Hide names').click();
  const labels = await page.evaluate(() => [...new Set([...document.querySelectorAll('.row-name .a > span:first-child')].map((el) => el.textContent.trim()))].filter(Boolean));
  const leaks = async () =>
    page.evaluate((names) => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (!names.some((name) => text.includes(name) || text.includes(name.toLowerCase().replace(/\s+/g, '-')))) continue;
        let hidden = false;
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (getComputedStyle(el).filter.includes('blur') || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') hidden = true;
        }
        if (!hidden) out.push(text.trim().slice(0, 60));
      }
      return out;
    }, labels);
  check('hiding names leaves none readable on the page', labels.length > 3 && (await leaks()).length === 0, (await leaks()).join(' | '));
  await page.locator('.row .row-name').first().click();
  await page.waitForSelector('.insp');
  check('hiding names covers the details pane', (await leaks()).length === 0, (await leaks()).join(' | '));
  await page.keyboard.press('Escape');
  await page.locator('.row').first().hover();
  await page.locator('.row [aria-label^="More actions"]').first().click();
  await page.waitForSelector('.menu');
  check('hiding names covers the menus', /Delete this subscription/.test(await page.locator('.menu').innerText()) && (await leaks()).length === 0, (await leaks()).join(' | '));
  await page.keyboard.press('Escape');

  check('hiding names replaces the letters of every chip', await page.evaluate(() => [...document.querySelectorAll('.mono')].every((chip) => getComputedStyle(chip).fontSize === '0px' && getComputedStyle(chip, '::before').content.includes('·'))));

  // A category nothing belongs to any more does not hide every quota.
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('tokengator.prefs.v1') ?? '{}');
    localStorage.setItem('tokengator.prefs.v1', JSON.stringify({ ...prefs, category: 'other', privacy: false, view: 'queue' }));
  });
  await page.reload();
  await page.waitForSelector('#main');
  await page.waitForTimeout(300);
  check('a category that is no longer in use stops filtering', (await page.locator('.row').count()) > 3, await mainText(page).then((text) => text.slice(0, 80)));

  check('no script errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await views(browser);
    await narrow(browser);
    await quickEntry(browser);
    await inspector(browser);
    await copying(browser);
    await managing(browser);
    await reminders(browser);
    await keyboard(browser);
    await motion(browser);
    await sampleStaysQuiet(browser);
    await designed(browser);
    await accessible(browser);
    await reviewed(browser);
  } catch (error) {
    failures += 1;
    console.error(`\nui-check: stopped early: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    await browser.close();
  }
  const passed = results.filter((result) => result.pass).length;
  console.log(`\nui-check: ${passed} passed, ${results.length - passed} failed${failures > results.length - passed ? ' (and stopped early)' : ''}`);
  process.exit(failures === 0 ? 0 : 1);
})();
