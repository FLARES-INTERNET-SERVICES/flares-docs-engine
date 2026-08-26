/**
 * What survives a crash, and what does not.
 *
 * "Persistence works" is not an answer a school can plan around. The
 * question is how many seconds of a student's writing a hard kill costs,
 * so this measures the window rather than asserting a boolean.
 *
 * The server is killed with `docker kill` (SIGKILL), not `stop` -- a
 * graceful stop runs the shutdown drain, which is exactly the path that
 * would NOT run in a crash, an OOM, or a node eviction.
 *
 *   node tests/regressions/durability.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5196';
const COLLAB = process.env.COLLAB_URL ?? 'http://localhost:8080';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let checks = 0;
let failures = 0;
const pass = (m) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const fail = (m, d) => { checks++; failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? ` -- ${d}` : ''}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));
const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);

const dc = (...args) => execFileSync('docker', ['compose', ...args], { encoding: 'utf8' });
const redis = (...args) => dc('exec', '-T', 'redis', 'redis-cli', ...args).trim();

const waitForServer = async () => {
    for (let i = 0; i < 90; i++) {
        try {
            const r = await fetch(`${COLLAB}/health`);
            if (r.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
};

const surfaceText = (page) => page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
    if (!pm) return '';
    const clone = pm.cloneNode(true);
    clone.querySelectorAll('[class*="yjs-cursor"], [class*="yjs-selection"], .ProseMirror-widget')
        .forEach((n) => n.remove());
    return clone.innerText || clone.textContent || '';
});
const focusStart = (page) => page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
    pm.focus();
    const r = document.createRange(); r.selectNodeContents(pm); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});

const browser = await chromium.launch();
const contexts = [];
const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    contexts.push(c);
    return c.newPage();
};

// ── Set a room up and get two people editing it ────────────────────────
say('A shared document with edits from two people');
const A = await mk();
await A.goto(APP, { waitUntil: 'domcontentloaded' });
await A.waitForTimeout(17000);
await A.setInputFiles('input[type=file]', join(FIX, 'structured.docx'));
await A.waitForFunction(() => {
    const pm = document.querySelector('.ProseMirror');
    return pm && pm.innerText.length > 150;
}, { timeout: 180000 }).catch(() => {});
await A.waitForTimeout(4000);
await A.getByRole('button', { name: 'Share', exact: true }).click();
await A.waitForFunction(
    () => [...document.querySelectorAll('input')].some((i) => (i.value || '').includes('room=')),
    { timeout: 90000 });
const shareUrl = await A.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find((x) => (x.value || '').includes('room='));
    return i.value;
});
const room = new URL(shareUrl).searchParams.get('room');
await A.getByRole('button', { name: /Join the session/i }).click();
await A.waitForTimeout(24000);

const B = await mk();
await B.goto(shareUrl, { waitUntil: 'domcontentloaded' });
await B.waitForTimeout(24000);

await A.bringToFront(); await focusStart(A);
await A.keyboard.type('ALAN_BEFORE_CRASH ', { delay: 20 });
await A.waitForTimeout(4000);
await B.bringToFront(); await focusStart(B);
await B.keyboard.type('GRACE_BEFORE_CRASH ', { delay: 20 });
await B.waitForTimeout(6000);

check((await surfaceText(B)).includes('ALAN_BEFORE_CRASH'), 'both edits are live before the crash');

const key = `${process.env.ROOM_PREFIX ?? "casual:room:"}${room}`;
const exists = redis('EXISTS', key);
check(exists === '1', `durable state was written for the room (${key})`, `EXISTS=${exists}`);
const size = redis('STRLEN', key);
console.log(`         persisted Y state: ${(Number(size) / 1024).toFixed(0)} KB`);

// ── Hard kill ──────────────────────────────────────────────────────────
say('SIGKILL the collaboration server');
dc('kill', '-s', 'SIGKILL', process.env.COLLAB_SERVICE ?? 'app');
await new Promise((r) => setTimeout(r, 3000));
let dead = false;
try { await fetch(`${COLLAB}/health`); } catch { dead = true; }
check(dead, 'the server is actually down');

// Clients are now talking to nothing. What do they show?
const duringOutage = await surfaceText(A);
check(duringOutage.includes('ALAN_BEFORE_CRASH'),
    'a connected client keeps showing the document during the outage');

say('Restart');
dc('up', '-d', process.env.COLLAB_SERVICE ?? 'app');
const back = await waitForServer();
check(back, 'the server came back');

// ── Does the work come back? ───────────────────────────────────────────
say('Reopen the room from a cold client');
const C = await mk();
await C.goto(shareUrl, { waitUntil: 'domcontentloaded' });
await C.waitForTimeout(28000);
const recovered = await surfaceText(C);
// If the client could not bootstrap at all, say so plainly rather than
// reporting three content failures that all mean the same thing.
const panel = await C.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    return { hasEditor: !!pm, body: document.body.innerText.slice(0, 200).split('\n').join(' | ') };
});
console.log(`         editor mounted: ${panel.hasEditor}`);
if (!panel.hasEditor) console.log(`         page says: ${panel.body}`);
console.log(`         recovered text starts: ${JSON.stringify(recovered.slice(0, 70))}`);

check(recovered.includes('Structured Document'),
    'the imported Word content survived the crash');
check(recovered.includes('ALAN_BEFORE_CRASH'), "user A's edits survived the crash");
check(recovered.includes('GRACE_BEFORE_CRASH'), "user B's edits survived the crash");
check(!recovered.includes('ALAN_BEFORE_CRASHALAN_BEFORE_CRASH'), 'nothing was duplicated by recovery');

// ── How wide is the window? ────────────────────────────────────────────
//
// Type, then kill after a measured delay. Whatever is missing afterwards
// is what a crash at that moment costs.
say('Durability window');
const windows = [0, 300, 700, 1500];
const results = [];

for (const delay of windows) {
    const P = await mk();
    await P.goto(shareUrl, { waitUntil: 'domcontentloaded' });
    await P.waitForTimeout(26000);
    const marker = `WINDOW_${delay}`;
    const ready = await P.evaluate(() => !!document.querySelector('.ProseMirror'));
    if (!ready) {
        console.log(`         ${delay}ms: client never mounted; skipping`);
        await P.context().close();
        results.push({ delay, survived: null });
        continue;
    }
    await P.bringToFront(); await focusStart(P);
    await P.keyboard.type(marker, { delay: 0 });
    await new Promise((r) => setTimeout(r, delay));

    dc('kill', '-s', 'SIGKILL', process.env.COLLAB_SERVICE ?? 'app');
    await new Promise((r) => setTimeout(r, 2500));
    await P.context().close();
    dc('up', '-d', process.env.COLLAB_SERVICE ?? 'app');
    await waitForServer();
    await new Promise((r) => setTimeout(r, 3000));

    const Q = await mk();
    await Q.goto(shareUrl, { waitUntil: 'domcontentloaded' });
    await Q.waitForTimeout(26000);
    const survived = (await surfaceText(Q)).includes(marker);
    await Q.context().close();
    results.push({ delay, survived });
    console.log(`         killed ${delay}ms after typing -> ${survived ? '\x1b[32mkept\x1b[0m' : '\x1b[31mLOST\x1b[0m'}`);
}

const firstSafe = results.find((r) => r.survived === true);
console.log();
if (firstSafe) {
    console.log(`         edits are durable roughly ${firstSafe.delay}ms after typing`);
} else {
    console.log('         no tested delay was durable');
}
check(results.some((r) => r.survived === true),
    'edits become durable within a bounded, measurable window');
console.log(`DURABILITY_JSON ${JSON.stringify(results)}`);

for (const c of contexts) await c.close().catch(() => {});
await browser.close();

console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} durability checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} durability checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
