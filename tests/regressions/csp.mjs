/**
 * The editor under its real Content-Security-Policy.
 *
 * The temptation with a CSP is to write one, watch the console fill with
 * violations, and add sources until it goes quiet -- which reliably ends in
 * `script-src 'unsafe-eval' https:` and a policy that stops nothing. So this
 * test works the other way round: it takes the exact policy the collab server
 * sends in production, applies it to a page the server does not control, and
 * requires that the editor does its whole job under it with ZERO violations.
 *
 * A violation here is a finding about the editor, not a reason to widen the
 * policy. The one relaxation -- `style-src 'unsafe-inline'` -- is in the
 * policy because painting a document IS writing style attributes, and that is
 * argued in collab-src/index.ts rather than discovered here.
 *
 * The policy is read from the live server rather than copied, so the two
 * cannot drift apart without this test noticing.
 *
 *   node tests/regressions/csp.mjs
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

// -- The policy the server actually sends -------------------------------
say('The policy under test comes from the server, not from this file');
const res = await fetch(COLLAB + '/', { redirect: 'manual' });
const served = res.headers.get('content-security-policy');
check(!!served, 'the collab server sends a Content-Security-Policy on HTML');
if (!served) {
    console.log('\n  \x1b[41;37m FAIL \x1b[0m  no policy to test\n');
    process.exit(1);
}

// Every directive we expect to have an opinion about. A policy that omits one
// silently falls back to default-src, which is fine -- until someone widens
// default-src for an unrelated reason and quietly unlocks all of them.
const directives = Object.fromEntries(
    served.split(';').map((d) => d.trim()).filter(Boolean)
        .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')]; }));

for (const d of ['default-src', 'script-src', 'style-src', 'font-src', 'img-src',
    'connect-src', 'worker-src', 'frame-ancestors', 'object-src', 'base-uri', 'form-action']) {
    check(d in directives, `${d} is stated explicitly`);
}
check(directives['object-src'] === "'none'", 'object-src is none, so no plugins ever', directives['object-src']);
check(!/unsafe-eval/.test(directives['script-src'] ?? ''), 'script-src does not permit eval', directives['script-src']);
check(!/\bhttps:(\s|$)|\*/.test(directives['script-src'] ?? ''), 'script-src names no wildcard', directives['script-src']);
check(!/fonts\.googleapis|fonts\.gstatic|https:\/\//.test(directives['font-src'] ?? ''),
    'font-src permits no external font host', directives['font-src']);
check((directives['frame-ancestors'] ?? '') !== '*',
    'frame-ancestors is not a wildcard, so the editor cannot be clickjacked',
    directives['frame-ancestors']);

// -- The editor under it ------------------------------------------------
const browser = await chromium.launch();

/**
 * Serve the editor's own pages with the production policy bolted on.
 * `frame-ancestors` is dropped: it is meaningless on a top-level document and
 * some browsers log that as a violation, which would be noise, not a finding.
 */
const policy = served.split(';').map((d) => d.trim())
    .filter((d) => !d.startsWith('frame-ancestors')).join('; ');

async function underPolicy(run) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const violations = [];

    // Only the document itself. Re-fetching every asset through the route
    // handler is both unnecessary -- a CSP is delivered on the document and
    // governs everything it loads -- and actively wrong: blob: and data:
    // requests have no origin server for `route.fetch()` to ask.
    await page.route('**/*', async (route, request) => {
        if (request.resourceType() !== 'document') return route.continue();
        try {
            const r = await route.fetch();
            await route.fulfill({
                response: r,
                headers: { ...r.headers(), 'content-security-policy': policy },
            });
        } catch {
            await route.continue();
        }
    });

    // Chromium reports every refusal to the console, and fires the
    // securitypolicyviolation event in the page. Take both: the event carries
    // the directive that did the blocking, which is what makes a failure
    // actionable instead of just alarming.
    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
        });
    });
    page.on('console', (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 200));
    });

    try {
        await run(page);
        violations.push(...(await page.evaluate(() => window.__cspViolations ?? [])));
    } finally {
        await ctx.close();
    }
    return violations;
}

// -- Loading ------------------------------------------------------------
{
    say('The editor loads under the policy');
    let mounted = false;
    const v = await underPolicy(async (page) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
        await page.waitForTimeout(6000);
        mounted = true;
    });
    check(mounted, 'the app mounts, so the bundle was not refused');
    check(v.length === 0, 'and nothing was blocked', v.join('\n         '));
}

// -- Doing the actual job -----------------------------------------------
{
    say('Opening, rendering and editing a Word document under the policy');
    let text = '';
    let painted = 0;
    const v = await underPolicy(async (page) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => !!document.querySelector('input[type=file]'), { timeout: 120000 });
        await page.setInputFiles('input[type=file]', join(FIX, 'complex.docx'));
        await page.waitForFunction(() => {
            const pm = document.querySelector('.ProseMirror');
            return pm && pm.innerText.length > 150;
        }, { timeout: 180000 });
        await page.waitForTimeout(8000);

        // Images from the .docx become blob:/data: URLs; the painter draws to
        // canvas. Both are directives that a careless policy breaks silently:
        // the document still "opens", it is just blank where the pictures were.
        painted = await page.evaluate(() =>
            document.querySelectorAll('.layout-painter img, .layout-painter canvas, .ProseMirror img').length);

        await page.evaluate(() => {
            const pm = document.querySelector('.ProseMirror');
            pm.focus();
            const r = document.createRange(); r.selectNodeContents(pm); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await page.keyboard.type('TYPED_UNDER_CSP ', { delay: 20 });
        await page.waitForTimeout(2500);
        text = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '');
    });

    check(text.includes('TYPED_UNDER_CSP'), 'the document is editable under the policy');
    check(painted > 0, 'and its images rendered, so blob:/data: are permitted where needed', `found ${painted}`);
    check(v.length === 0, 'nothing was blocked while opening and editing', v.join('\n         '));
}

await browser.close();
console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} CSP checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} CSP checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
