/**
 * The editor must not phone home. To anyone.
 *
 * A worksheet opened by a nine-year-old should not tell Google — or any other
 * third party — that it happened. A webfont request carries the reader's IP
 * address, and the Referer header names the document page they were on. That
 * is the whole reason this test exists; the load-time saving is a side effect.
 *
 * This is a regression fence, not a one-time audit. Vendored CSS is the usual
 * way an external font sneaks back in: the design system's tokens sheet
 * pulled Inter, JetBrains Mono, Manrope AND the full 3.8 MB Material Symbols
 * variable font through two @import lines nobody had looked at in months.
 * A grep would not have caught the transitive @import chain, so we drive a
 * real browser and record every request that leaves the origin.
 *
 *   node tests/regressions/no-external-requests.mjs
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

/**
 * Hosts the editor is allowed to talk to: itself, and the collaboration
 * service the deployment runs. Everything else is a finding.
 */
const allowed = new Set([new URL(APP).host, new URL(COLLAB).host]);

const browser = await chromium.launch();

/** Drive `run` against a fresh page and return every off-origin request. */
async function watch(run) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const external = [];
    const record = (url) => {
        let host;
        try { host = new URL(url).host; } catch { return; }
        // data:, blob: and about: have no host and never reach the network.
        if (host === '' || allowed.has(host)) return;
        external.push(url);
    };
    page.on('request', (r) => record(r.url()));
    // A request the browser refuses still proves the intent to make it, and a
    // CSP-blocked font is a bug we want reported rather than silently tolerated.
    page.on('requestfailed', (r) => record(r.url()));
    try {
        await run(page);
    } finally {
        await ctx.close();
    }
    return external;
}

const isFont = (u) => /fonts\.googleapis|fonts\.gstatic|\.woff2?(\?|$)|\.ttf(\?|$)|\.otf(\?|$)|type=font/i.test(u);

// ── Cold load ──────────────────────────────────────────────────────────
{
    say('Opening the editor for the first time');
    const ext = await watch(async (page) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
        // Webfont requests are made during layout, not at DOMContentLoaded.
        await page.waitForTimeout(8000);
    });

    check(ext.filter(isFont).length === 0,
        'a cold load fetches no font from anywhere but this origin',
        ext.filter(isFont).join('\n         '));
    check(ext.length === 0,
        'and makes no third-party request at all',
        ext.join('\n         '));
}

// ── With a real document open ──────────────────────────────────────────
{
    say('With a Word document open');
    // The document's own fonts are the interesting case: parseDocx reads the
    // font table and asks the loader for each family, which is exactly where
    // the CDN fetch used to be issued — one per family in the document.
    const ext = await watch(async (page) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
        await page.setInputFiles('input[type=file]', join(FIX, 'structured.docx'));
        await page.waitForFunction(() => {
            const pm = document.querySelector('.ProseMirror');
            return pm && pm.innerText.length > 150;
        }, { timeout: 180000 });
        await page.waitForTimeout(10000);
    });

    check(ext.filter(isFont).length === 0,
        'the document\'s fonts are resolved locally, not fetched',
        ext.filter(isFont).join('\n         '));
    check(ext.length === 0,
        'and opening a document tells no third party it happened',
        ext.join('\n         '));
}

// ── The text still renders in something ────────────────────────────────
{
    say('Removing the CDN did not leave the text unstyled');
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
    await page.setInputFiles('input[type=file]', join(FIX, 'structured.docx'));
    await page.waitForFunction(() => {
        const pm = document.querySelector('.ProseMirror');
        return pm && pm.innerText.length > 150;
    }, { timeout: 180000 });
    await page.waitForTimeout(6000);

    // The five metric-compatible faces are the ones that must be bundled: if
    // Carlito or Liberation Serif were only ever coming from the CDN, line
    // breaks would move and every exported document would repaginate.
    const faces = await page.evaluate(() =>
        [...document.fonts].map((f) => f.family.replace(/['"]/g, '')));
    for (const want of ['Carlito', 'Caladea', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono']) {
        check(faces.includes(want), `${want} is bundled, so layout is unchanged`, `have: ${[...new Set(faces)].join(', ')}`);
    }

    // Chrome text falls through to the native stack rather than Inter. That is
    // fine, but it must actually resolve to a real family, not to nothing.
    const chrome = await page.evaluate(() => {
        const el = document.querySelector('button') || document.body;
        return getComputedStyle(el).fontFamily;
    });
    check(/sans-serif|system-ui|-apple-system|Segoe/i.test(chrome),
        'UI text falls back to a native font stack', chrome);

    await ctx.close();
}

await browser.close();
console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} external-request checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} external-request checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
