// End-to-end smoke test (Task 14): builds are served with `vite preview`, driven with Playwright.
// Run with `npm run smoke` (which builds first). Exits non-zero on any failed check or console error.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', 'out');
const STYLE_IDS = ['wooden', 'model', 'brick'];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vite preview did not start at ${url}`);
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}/`;
const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));
let browser;
try {
  await waitForServer(base);
  mkdirSync(outDir, { recursive: true });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  // Clear the autosave so every run starts from an empty layout.
  await page.goto(base + '?test');
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + '?test');
  await page.waitForFunction(() => !!window.__app);

  const box = await page.locator('canvas.tl-canvas').boundingBox();
  /** Page coordinates of a world point on the canvas. */
  const toPage = (w) => page.evaluate(({ w, box }) => {
    const { camera: c } = window.__app;
    const size = window.__app.viewSize();
    return { x: box.x + (w.x - c.cx) * c.zoom + size.x / 2, y: box.y + (w.y - c.cy) * c.zoom + size.y / 2 };
  }, { w, box });

  // 1. A circle of eight medium curves via the palette and keep-placing.
  await page.click('[data-piece="curve-m-45"]');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (let i = 0; i < 8; i++) await page.mouse.click(at.x, at.y); // the follow-on ghost stays under the cursor
  const circle = await page.evaluate(() => ({ pieces: __app.doc.layout.pieces.length, open: __app.doc.graph.open.length }));
  check('eight curves close a circle', circle.pieces === 8 && circle.open === 0, JSON.stringify(circle));

  // 2. Add a train on the track and run it from its panel.
  await page.keyboard.press('Escape');
  await page.click('[data-action="train"]');
  const p0 = await page.evaluate(() => { const p = __app.doc.layout.pieces[3]; return { x: p.x, y: p.y }; });
  const onTrack = await toPage(p0);
  await page.mouse.move(onTrack.x, onTrack.y);
  await page.mouse.click(onTrack.x, onTrack.y);
  const trains = await page.evaluate(() => __app.doc.layout.trains.length);
  check('one train placed', trains === 1, `trains=${trains}`);
  const run = page.locator('.tl-panel [data-action="run"]');
  const hasRun = (await run.count()) === 1;
  check('train panel has a Run button', hasRun);
  if (trains === 1 && hasRun) {
    const before = await page.evaluate(() => JSON.stringify(__app.doc.layout.trains[0].head));
    await run.click();
    const running = await page.evaluate(() => __app.doc.layout.trains[0].running);
    check('Run sets running', running === true);
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => JSON.stringify(__app.doc.layout.trains[0].head));
    check('running train moved', before !== after, `${before} -> ${after}`);
  }

  // 3. Undo everything.
  for (let i = 0; i < 50 && (await page.evaluate(() => __app.history.canUndo)); i++) await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => ({ canUndo: __app.history.canUndo, pieces: __app.doc.layout.pieces.length }));
  check('Ctrl-Z empties the history and the layout', !undone.canUndo && undone.pieces === 0, JSON.stringify(undone));

  // 4. Redo once.
  await page.keyboard.press('Control+Shift+Z');
  const redone = await page.evaluate(() => __app.doc.layout.pieces.length);
  check('Ctrl-Shift-Z redoes one piece', redone === 1, `pieces=${redone}`);

  // Redo the rest so the screenshots show the circle and train.
  for (let i = 0; i < 50 && (await page.evaluate(() => __app.history.canRedo)); i++) await page.keyboard.press('Control+Shift+Z');

  // 5. Every style, with a screenshot each.
  for (const id of STYLE_IDS) {
    await page.selectOption('select[data-action="style"]', id);
    const style = await page.evaluate(() => __app.style);
    check(`style ${id} selected`, style === id);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(outDir, `smoke-${id}.png`) });
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  check('smoke run completed', false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser?.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: all checks passed');
