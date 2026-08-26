/**
 * The exact failure this spike exists to fix:
 *
 *   open a Word DOCX -> Share -> a second browser joins -> BOTH see the
 *   imported content -> both edit -> changes converge -> save -> Word.
 *
 * Run against the source build (vite on 5195) with the collab server on
 * 3200.  Usage:  node tests/imported-docx-collaboration.mjs [fixture]
 *
 * The canonical Y state is read with an INDEPENDENT node client rather
 * than inferred from the editor UI. An editor reporting on its own
 * collaboration is not evidence.
 */
import { chromium } from 'playwright';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

const APP = process.env.APP_URL ?? 'http://localhost:5196';
const COLLAB = process.env.COLLAB_URL ?? 'http://localhost:8080';
const FIXTURE = process.argv[2] ?? 'structured.docx';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// What must survive the whole round trip, per fixture.
const MARKERS = {
    'basic.docx': ['Sample Document', 'unordered list', 'Closing paragraph'],
    'structured.docx': ['Structured Document', 'Discussion', 'Table'],
    'complex.docx': ['Spanning header across four columns', 'Vertical merge', 'Second section'],
    'large.docx': ['Large document', 'Chapter 1'],
};
const keep = MARKERS[FIXTURE] ?? [];

let checks = 0;
let failures = 0;
const pass = (m) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const fail = (m, d) => { checks++; failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? ` -- ${d}` : ''}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));
const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);
const norm = (s) => s.replace(/\s+/g, ' ');

/**
 * Document text only.
 *
 * `innerText` on the editing surface also picks up y-prosemirror's
 * presence decorations -- each remote caret renders a widget carrying
 * the peer's display name. Those differ per client by construction
 * (different name, different caret position), so comparing raw
 * innerText between two clients reports a convergence failure on a
 * document that has in fact converged. Strip them before reading.
 */
const surfaceText = (page) => page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
    if (!pm) return '';
    const clone = pm.cloneNode(true);
    clone.querySelectorAll(
        '[class*="yjs-cursor"], [class*="yjs-selection"], .ProseMirror-widget'
    ).forEach((n) => n.remove());
    return clone.innerText || clone.textContent || '';
});

/** Read the room's canonical Y state from outside the browser. */
async function readRoom(room) {
    const ydoc = new Y.Doc();
    const p = new HocuspocusProvider({
        url: COLLAB.replace(/^http/, 'ws') + '/yjs',
        name: room,
        document: ydoc,
        WebSocketPolyfill: WebSocket,
        connect: true,
    });
    await new Promise((r) => { p.on('synced', () => r()); setTimeout(r, 8000); });
    await new Promise((r) => setTimeout(r, 1500));
    const frag = ydoc.getXmlFragment('prosemirror');
    const out = {
        length: frag.length,
        text: frag.toString().replace(/<[^>]*>/g, ' '),
        bytes: Y.encodeStateAsUpdate(ydoc).byteLength,
    };
    p.destroy();
    ydoc.destroy();
    return out;
}

const browser = await chromium.launch();
const mk = async () => (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

const errorsA = [];
const A = await mk();
A.on('pageerror', (e) => errorsA.push(e.message.slice(0, 160)));

say(`${FIXTURE} -- author opens the document`);
await A.goto(APP, { waitUntil: 'domcontentloaded' });
await A.waitForTimeout(18000);
await A.setInputFiles('input[type=file]', join(FIX, FIXTURE));
await A.waitForFunction(() => {
    const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
    return pm && pm.innerText.length > 200;
}, { timeout: 120000 }).catch(() => {});
await A.waitForTimeout(4000);

const authorBefore = await surfaceText(A);
check(authorBefore.length > 200, `author sees the imported document (${authorBefore.length} chars)`);
const missingBefore = keep.filter((k) => !norm(authorBefore).includes(norm(k)));
check(missingBefore.length === 0, `all ${keep.length} content markers present before sharing`,
    missingBefore.join(', '));

say('Share');
await A.getByRole('button', { name: 'Share', exact: true }).click();
await A.waitForFunction(
    () => [...document.querySelectorAll('input')].some((i) => (i.value || '').includes('room=')),
    { timeout: 60000 }).catch(() => {});
const shareUrl = await A.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find((x) => (x.value || '').includes('room='));
    return i ? i.value : null;
});
check(!!shareUrl, 'a share link was produced', String(shareUrl));
const room = shareUrl ? new URL(shareUrl).searchParams.get('room') : null;
console.log(`         room=${room}`);

const stored = await fetch(`${COLLAB}/api/rooms/${room}/seed`);
const seedBytes = Buffer.from(await stored.arrayBuffer());
check(stored.ok && seedBytes.subarray(0, 2).toString() === 'PK',
    `the room stored a real .docx seed (${(seedBytes.length / 1024).toFixed(0)} KB)`);

say('Author joins the collaborative room');
await A.getByRole('button', { name: /Join the session/i }).click();
await A.waitForTimeout(22000);
check(A.url().includes(`room=${room}`), 'author is in the room it created', A.url().slice(0, 90));

const authorInRoom = await surfaceText(A);
check(authorInRoom.length > 200, `author still sees the document after joining (${authorInRoom.length} chars)`);
const lostOnJoin = keep.filter((k) => !norm(authorInRoom).includes(norm(k)));
check(lostOnJoin.length === 0, 'author kept the imported content through the transition',
    lostOnJoin.length ? `LOST: ${lostOnJoin.join(', ')}` : '');

const yAfterAuthor = await readRoom(room);
console.log(`         canonical Y: ${yAfterAuthor.length} nodes, ${yAfterAuthor.bytes} bytes`);
check(yAfterAuthor.length > 1, 'the imported document reached the canonical shared state');
const yMissing = keep.filter((k) => !norm(yAfterAuthor.text).includes(norm(k)));
check(yMissing.length === 0, 'canonical Y state carries the imported content',
    yMissing.length ? `LOST: ${yMissing.join(', ')}` : '');

say('Second user joins');
const B = await mk();
await B.goto(shareUrl, { waitUntil: 'domcontentloaded' });
await B.waitForTimeout(26000);
const peer = await surfaceText(B);
check(peer.length > 200, `collaborator sees content (${peer.length} chars)`,
    peer.length <= 200 ? 'collaborator joined room but imported document state was not hydrated' : '');
const peerMissing = keep.filter((k) => !norm(peer).includes(norm(k)));
check(peerMissing.length === 0, `collaborator sees all ${keep.length} imported markers`,
    peerMissing.length ? `LOST: ${peerMissing.join(', ')}` : '');

say('Two-way live editing');
const typeInto = async (page, text) => {
    await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
        pm.focus();
        const r = document.createRange();
        r.selectNodeContents(pm);
        r.collapse(true);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
    });
    await page.keyboard.type(text, { delay: 22 });
};

await typeInto(A, 'ALAN_COLLAB_EDIT ');
await A.waitForTimeout(9000);
check((await surfaceText(B)).includes('ALAN_COLLAB_EDIT'), "user B received user A's edit");

await typeInto(B, 'GRACE_COLLAB_EDIT ');
await B.waitForTimeout(9000);
check((await surfaceText(A)).includes('GRACE_COLLAB_EDIT'), "user A received user B's edit");

say('Convergence');
await A.waitForTimeout(4000);
const finalA = norm(await surfaceText(A));
const finalB = norm(await surfaceText(B));
let convergeDetail = '';
if (finalA !== finalB) {
    let i = 0;
    while (i < finalA.length && i < finalB.length && finalA[i] === finalB[i]) i++;
    const show = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
    convergeDetail = `A=${finalA.length} B=${finalB.length}; first difference at ${i}
` +
        `           A: ${show(finalA)}
           B: ${show(finalB)}`;
}
check(finalA === finalB, 'both clients converged on identical text', convergeDetail);
const dupA = (finalA.match(/ALAN_COLLAB_EDIT/g) || []).length;
check(dupA === 1, 'no duplication of content', `ALAN marker appears ${dupA} times`);
const survived = keep.filter((k) => norm(finalA).includes(norm(k)));
check(survived.length === keep.length, 'original imported content survived collaboration',
    `${survived.length}/${keep.length}`);

say('Persistence -- both leave, then reopen');
await A.context().close();
await B.context().close();
await new Promise((r) => setTimeout(r, 6000));
const C = await mk();
await C.goto(shareUrl, { waitUntil: 'domcontentloaded' });
await C.waitForTimeout(26000);
const reopened = await surfaceText(C);
check(reopened.includes('ALAN_COLLAB_EDIT') && reopened.includes('GRACE_COLLAB_EDIT'),
    "reopening the room returns both users' edits");
const reopenMissing = keep.filter((k) => !norm(reopened).includes(norm(k)));
check(reopenMissing.length === 0, 'reopening returns the original imported content',
    reopenMissing.join(', '));

say('Export the collaborative state to .docx');
// Through the application's own File -> Save, so this measures the path
// a user actually takes rather than a test-only hook.
const outPath = join(RESULTS, `collab-${FIXTURE}`);
try {
    await C.getByRole('button', { name: 'File', exact: true }).click();
    await C.waitForTimeout(1200);
    const [download] = await Promise.all([
        C.waitForEvent('download', { timeout: 90000 }),
        C.getByRole('menuitem', { name: /^Save/ }).first().click(),
    ]);
    await download.saveAs(outPath);
    const out = await readFile(outPath);
    check(out.length > 0, `File -> Save produced ${(out.length / 1024).toFixed(0)} KB`);
    check(out.subarray(0, 2).toString() === 'PK', 'the export is a real OOXML package');
} catch (err) {
    fail('exporting the collaborative state to .docx', String(err).slice(0, 160));
}

say('Console health');
check(errorsA.length === 0, 'no page errors during the flow', errorsA.slice(0, 2).join(' | '));

await browser.close();
console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} checks -- ${FIXTURE}\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} checks failed -- ${FIXTURE}\n`);
process.exit(failures === 0 ? 0 : 1);
