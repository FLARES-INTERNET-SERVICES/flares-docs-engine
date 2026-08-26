/**
 * Crash recovery, and the promise a save makes.
 *
 * The bug this exists to stop coming back: a document that saved perfectly
 * greeted its author on every reload with
 *
 *     Unsaved changes from lesson.docx (36 min ago) — restore them?
 *
 * while the same screen said "Saved to Drive". A student should never be told
 * both that their work is safe and that an older copy of it might need
 * rescuing.
 *
 * Root cause: the editor writes a whole-document .docx to IndexedDB every 30
 * seconds while dirty, and NOTHING ever acknowledges it. A successful
 * server-side save is invisible to it. It is also keyed per ORIGIN rather than
 * per document, so one document's draft is offered against another.
 *
 *   node tests/regressions/recovery.mjs
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL ?? 'http://localhost:5196';
const COLLAB = process.env.COLLAB_URL ?? 'http://localhost:8080';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let checks = 0;
let failures = 0;
const pass = (m) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const fail = (m, d) => { checks++; failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? ` -- ${d}` : ''}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));
const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);

const surfaceText = (page) => page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return '';
    const c = pm.cloneNode(true);
    c.querySelectorAll('[class*="yjs-cursor"], [class*="yjs-selection"]').forEach((n) => n.remove());
    return c.innerText || '';
});

/** Is the restore banner on screen? */
const restoreBanner = (page) => page.evaluate(() =>
    /restore them\?|Unsaved changes from/i.test(document.body.innerText));

/** What is actually in the editor's IndexedDB recovery store. */
const recoveryStore = (page) => page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('casual-docs');
    open.onerror = () => resolve({ error: 'open failed' });
    open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('autosave')) return resolve({ keys: [] });
        const tx = db.transaction('autosave', 'readonly');
        const req = tx.objectStore('autosave').getAllKeys();
        req.onsuccess = () => resolve({ keys: [...req.result].map(String) });
        req.onerror = () => resolve({ error: 'read failed' });
    };
}));

const typeInto = async (page, text) => {
    await page.bringToFront();
    await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        pm.focus();
        const r = document.createRange(); r.selectNodeContents(pm); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.type(text, { delay: 20 });
};

const browser = await chromium.launch();
const contexts = [];
const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    contexts.push(c);
    return c.newPage();
};

/** Open a fixture, share it, and join the room. */
async function sharedRoom(fixture = 'structured.docx') {
    const A = await mk();
    await A.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
    await A.setInputFiles('input[type=file]', join(FIX, fixture));
    await A.waitForFunction(() => {
        const pm = document.querySelector('.ProseMirror');
        return pm && pm.innerText.length > 150;
    }, { timeout: 180000 });
    await A.waitForTimeout(3000);
    await A.getByRole('button', { name: 'Share', exact: true }).click();
    await A.waitForFunction(
        () => [...document.querySelectorAll('input')].some((i) => (i.value || '').includes('room=')),
        { timeout: 90000 });
    const url = await A.evaluate(() => [...document.querySelectorAll('input')]
        .find((x) => (x.value || '').includes('room=')).value);
    await A.getByRole('button', { name: /Join the session/i }).click();
    await A.waitForTimeout(22000);

    // The Flares host asks for minimal chrome and declares that it owns
    // durability; without that parameter the editor is standalone and its own
    // safety net is correct.
    return { A, url, hosted: url + '&chrome=minimal' };
}

// ── The bug ────────────────────────────────────────────────────────────
{
    say('A document that saved does not ask to be rescued');
    const { hosted } = await sharedRoom();

    const A = await mk();
    await A.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(24000);

    await typeInto(A, 'SAVED_WORK_MARKER ');
    // Past the editor's 30-second autosave tick, which is when the old
    // behaviour wrote the record that came back to haunt the next reload.
    await A.waitForTimeout(38000);

    const store = await recoveryStore(A);
    check(!store.error, 'the recovery store is readable', store.error);
    check((store.keys ?? []).length === 0,
        'a hosted document writes no local .docx copy at all',
        `keys: ${(store.keys ?? []).join(', ')}`);

    await A.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(26000);

    check(!(await restoreBanner(A)),
        'no restore banner after a reload — the work is safe and the UI says so');
    const after = await surfaceText(A);
    check(after.includes('SAVED_WORK_MARKER'), 'the typed work is there');
    check((after.match(/SAVED_WORK_MARKER/g) || []).length === 1,
        'and it is there exactly once, not restored on top of itself');

    for (const c of contexts.splice(0)) await c.close();
}

// ── Close and reopen ───────────────────────────────────────────────────
{
    say('Closing the tab and coming back');
    const { hosted } = await sharedRoom('basic.docx');

    const A = await mk();
    await A.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(24000);
    await typeInto(A, 'CLOSED_AND_REOPENED ');
    await A.waitForTimeout(34000);
    await A.context().close();
    contexts.pop();

    const B = await mk();
    await B.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await B.waitForTimeout(26000);

    check(!(await restoreBanner(B)), 'no restore prompt after closing and reopening');
    check((await surfaceText(B)).includes('CLOSED_AND_REOPENED'), 'the work came back');

    for (const c of contexts.splice(0)) await c.close();
}

// ── Several saves ──────────────────────────────────────────────────────
{
    say('Typing, saving, typing again');
    const { hosted } = await sharedRoom('basic.docx');

    const A = await mk();
    await A.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(24000);

    await typeInto(A, 'FIRST_PASS ');
    await A.waitForTimeout(33000);
    await typeInto(A, 'SECOND_PASS ');
    await A.waitForTimeout(33000);

    await A.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(26000);

    const text = await surfaceText(A);
    check(!(await restoreBanner(A)), 'still no restore prompt after several saves');
    check(text.includes('FIRST_PASS') && text.includes('SECOND_PASS'), 'both passes survived');
    check((text.match(/FIRST_PASS/g) || []).length === 1, 'nothing was duplicated');

    for (const c of contexts.splice(0)) await c.close();
}

// ── Two tabs ───────────────────────────────────────────────────────────
{
    say('The same person in two tabs');
    const { hosted } = await sharedRoom('basic.docx');

    const one = await mk();
    await one.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await one.waitForTimeout(24000);
    const two = await mk();
    await two.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await two.waitForTimeout(24000);

    await typeInto(one, 'TAB_ONE_WROTE ');
    await one.waitForTimeout(34000);

    await two.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await two.waitForTimeout(26000);

    check(!(await restoreBanner(two)), 'the second tab is not offered a stale rollback');
    check((await surfaceText(two)).includes('TAB_ONE_WROTE'),
        'and it has the other tab\'s work, not an older copy of its own');

    for (const c of contexts.splice(0)) await c.close();
}

// ── Closing the tab must not accuse the editor of losing work ──────────
{
    say('Closing a saved document says nothing alarming');
    const { hosted } = await sharedRoom('basic.docx');

    const A = await mk();
    await A.goto(hosted, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(24000);
    await typeInto(A, 'ABOUT_TO_LEAVE ');
    await A.waitForTimeout(34000);

    // `beforeunload` fired on the editor's local dirty flag, which in a
    // collaborative room says nothing about whether the work is safe and is
    // true seconds after every keystroke. The result was a native "Changes you
    // made may not be saved" on a document that had reached Drive -- a modal
    // contradicting the "Saved to Drive" on the same screen, and the scarier
    // of the two because the browser said it rather than us.
    //
    // Playwright auto-dismisses dialogs, so counting them is how we see one.
    let dialogs = 0;
    A.on('dialog', (d) => { dialogs++; void d.dismiss(); });

    const left = await A.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        // `returnValue` is a legacy property that exists on every Event and
        // starts life `true` here, so its VALUE proves nothing -- only a
        // change to it does. Read it before and after and compare, rather
        // than testing it against the empty string a real BeforeUnloadEvent
        // happens to start with.
        const before = e.returnValue;
        window.dispatchEvent(e);
        return {
            prevented: e.defaultPrevented,
            returnValueChanged: e.returnValue !== before,
        };
    });

    check(!left.prevented && !left.returnValueChanged,
        'leaving a hosted document raises no "unsaved changes" prompt',
        JSON.stringify(left));
    check(dialogs === 0, 'and no dialog appeared', `saw ${dialogs}`);

    for (const c of contexts.splice(0)) await c.close();
}

// ── The standalone editor keeps its safety net ─────────────────────────
{
    say('Without a host, the editor still protects itself');
    const { url } = await sharedRoom('basic.docx');

    // No `chrome=minimal`: nobody has claimed durability, so the editor's own
    // recovery is the only thing standing between the user and a crash. It
    // must still be there.
    const A = await mk();
    await A.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(24000);
    await typeInto(A, 'STANDALONE_WORK ');
    await A.waitForTimeout(38000);

    const store = await recoveryStore(A);
    const keys = store.keys ?? [];
    check(keys.length > 0, 'a standalone editor does keep a local copy', `keys: ${keys.join(', ')}`);
    check(keys.some((k) => k.startsWith('doc:')),
        `and it is scoped to the document, not one slot per origin (${keys.join(', ')})`);

    for (const c of contexts.splice(0)) await c.close();
}

for (const c of contexts) await c.close().catch(() => {});
await browser.close();
console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} recovery checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} recovery checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
