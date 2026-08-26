/**
 * Can you tell someone else is in the document with you?
 *
 * Two things a collaborative editor owes its user, and neither is decoration:
 *
 *   - whether it is connected (Connecting / Live / Disconnected), because the
 *     answer decides whether what they are typing is going anywhere;
 *   - who else is here, because two people editing the same paragraph without
 *     knowing it is how work gets overwritten.
 *
 * This exists because both were nearly lost to a chrome flag. A host that
 * draws its own header asks for `chrome=minimal`, which hid the editor's title
 * bar — and the presence cluster was in that same slot, so it went too. The
 * document stayed collaborative and stopped looking collaborative, which is
 * the worse of the two failures: nothing is broken, so nobody reports it.
 *
 * Presence is not chrome a host can supply for itself. The peer list exists
 * only inside the editor's own collaboration session; Flares, on the other
 * side of an iframe boundary, cannot see it.
 *
 *   node tests/regressions/presence.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL ?? 'http://localhost:5196';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
// Where docker-compose.yml lives — the repository root.
const LAB = join(HERE, '..', '..');

let checks = 0;
let failures = 0;
const pass = (m) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const fail = (m, d) => { checks++; failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? ` -- ${d}` : ''}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));
const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);

const browser = await chromium.launch();
const contexts = [];
const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    contexts.push(c);
    return c.newPage();
};

/** Open a fixture, share it, and return the room URL. */
async function sharedRoom(fixture = 'basic.docx') {
    const A = await mk();
    await A.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
    await A.setInputFiles('input[type=file]', join(FIX, fixture));
    await A.waitForFunction(() => {
        const pm = document.querySelector('.ProseMirror');
        return pm && pm.innerText.length > 100;
    }, { timeout: 180000 });
    await A.waitForTimeout(3000);
    await A.getByRole('button', { name: 'Share', exact: true }).click();
    await A.waitForFunction(
        () => [...document.querySelectorAll('input')].some((i) => (i.value || '').includes('room=')),
        { timeout: 90000 });
    const url = await A.evaluate(() => [...document.querySelectorAll('input')]
        .find((x) => (x.value || '').includes('room=')).value);
    await A.getByRole('button', { name: /Join the session/i }).click();
    await A.waitForTimeout(20000);
    return url + '&chrome=minimal';
}

/**
 * What the page says about presence.
 *
 * Counted by DOM rather than by reading text, because an avatar is usually
 * initials in a coloured circle and a text search for a name would also match
 * the name typed into the document.
 */
const presence = (page) => page.evaluate(() => {
    const text = document.body.innerText;
    // The presence cluster renders one element per peer with a background
    // colour assigned by the collaboration session.
    const cluster = document.querySelector(
        '[class*="presence" i], [data-testid*="presence" i], [class*="peer" i], [class*="avatar" i]'
    );
    const avatars = cluster
        ? cluster.querySelectorAll(':scope > *').length
        : document.querySelectorAll('[class*="avatar" i]').length;
    return {
        // The editor's own words, from StatusBadge: Connecting / Live /
        // Disconnected. Matched exactly rather than by a guess at synonyms:
        // a test looking for "offline" would call a screen that says
        // "Disconnected" a failure, and report a working editor as broken.
        live: /\bLive\b/.test(text),
        connecting: /\bConnecting\b/.test(text),
        disconnected: /\bDisconnected\b/.test(text),
        hasCluster: !!cluster,
        avatars,
        // Cursor decorations carry the other person's name and are the other
        // half of "who is here" — they say WHERE the person is.
        cursors: document.querySelectorAll('[class*="yjs-cursor" i]').length,
    };
});

// -- Two people, one document -------------------------------------------
{
    say('Two people in the same document');
    const room = await sharedRoom();

    const one = await mk();
    await one.goto(room, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await one.waitForTimeout(22000);

    const alone = await presence(one);
    check(alone.live, 'the first person is told they are connected', JSON.stringify(alone));

    const two = await mk();
    await two.goto(room, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await two.waitForTimeout(22000);

    // Both type, so each has a cursor the other can see.
    for (const [page, text] of [[one, 'FIRST_PERSON '], [two, 'SECOND_PERSON ']]) {
        await page.bringToFront();
        await page.evaluate(() => {
            const pm = document.querySelector('.ProseMirror');
            pm.focus();
            const r = document.createRange(); r.selectNodeContents(pm); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await page.keyboard.type(text, { delay: 25 });
        await page.waitForTimeout(2500);
    }
    await one.waitForTimeout(6000);

    const withCompany = await presence(one);
    check(withCompany.live, 'still connected', JSON.stringify(withCompany));
    check(withCompany.hasCluster,
        'and the presence cluster is on screen under minimal chrome',
        JSON.stringify(withCompany));
    check(withCompany.avatars >= 1,
        'showing at least one other person',
        `avatars: ${withCompany.avatars}`);

    // The other half of knowing who is here: where they are.
    const seen = await one.evaluate(() =>
        document.querySelector('.ProseMirror')?.innerText ?? '');
    check(seen.includes('SECOND_PERSON'),
        'and the other person\'s typing arrived');

    for (const c of contexts.splice(0)) await c.close();
}

// -- Losing the connection ----------------------------------------------
{
    say('When the connection goes');
    const room = await sharedRoom();

    const A = await mk();
    await A.goto(room, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForTimeout(22000);
    check((await presence(A)).live, 'connected to begin with');

    // Stop the collaboration server for real.
    //
    // `context.setOffline(true)` was the obvious move and it is the wrong one:
    // Chromium applies it to new requests and leaves an already-open WebSocket
    // alive, so the editor stays genuinely connected and correctly keeps
    // saying Live. The test passes or fails on nothing. Taking the server away
    // is also the failure people actually hit — a deploy, a crash, a restart —
    // and it is what the Disconnected state exists to describe.
    const compose = (...args) =>
        execFileSync('docker', ['compose', ...args], { cwd: LAB, stdio: 'pipe' });

    let stopped = false;
    try {
        compose('stop', 'docs');
        stopped = true;
        await A.waitForTimeout(15000);

        const dropped = await presence(A);
        check(!dropped.live,
            'the editor stops claiming to be Live once it is not',
            JSON.stringify(dropped));
        check(dropped.disconnected || dropped.connecting,
            'and says so in its own words, so a student knows to stop typing',
            JSON.stringify(dropped));
    } finally {
        if (stopped) {
            compose('start', 'docs');
            // The container reports healthy before the server finishes binding.
            await A.waitForTimeout(20000);
        }
    }

    const back = await presence(A);
    check(back.live, 'and it recovers on its own when the server returns', JSON.stringify(back));

    for (const c of contexts.splice(0)) await c.close();
}

for (const c of contexts) await c.close().catch(() => {});
await browser.close();
console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} presence checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} presence checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
