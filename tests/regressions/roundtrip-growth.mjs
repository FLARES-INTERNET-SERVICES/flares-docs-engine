/**
 * Does an exported document grow every time it goes round again?
 *
 * A one-time size increase is a cost. A multiplier applied on every
 * save is a countdown: 14 MB -> 29 -> 58 -> 116. This measures which
 * one we have, because the answer decides whether the candidate is
 * viable at all.
 *
 * Each iteration is a full collaborative cycle -- share the previous
 * export, join the room, edit, export again -- because that is the path
 * a school document actually takes, and the single-user save path is
 * already known to be byte-stable.
 *
 *   node tests/regressions/roundtrip-growth.mjs [fixture] [rounds]
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const APP = process.env.APP_URL ?? 'http://localhost:5196';
const FIXTURE = process.argv[2] ?? 'structured.docx';
const ROUNDS = Number(process.argv[3] ?? 10);
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), 'results');
const stem = FIXTURE.replace('.docx', '');

const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);

/** Media inventory of a .docx, without unzipping to disk. */
async function inventory(path) {
    const { default: JSZip } = await import(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..',
            'docx-editor', 'node_modules', 'jszip', 'lib', 'index.js')
    ).catch(() => ({ default: null }));
    const size = (await stat(path)).size;
    if (!JSZip) return { size, media: null, distinct: null };
    const zip = await JSZip.loadAsync(await readFile(path));
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !zip.files[n].dir);
    const hashes = new Set();
    for (const n of media) {
        hashes.add(createHash('sha256').update(await zip.files[n].async('nodebuffer')).digest('hex'));
    }
    return { size, media: media.length, distinct: hashes.size };
}

const browser = await chromium.launch();
const rows = [];

const base = join(process.cwd(), 'fixtures', 'docs', FIXTURE);
const first = await inventory(base);
rows.push({ round: 'original', ...first });
console.log(`original: ${(first.size / 1024).toFixed(0)} KB, media=${first.media}, distinct=${first.distinct}`);

let input = base;

for (let round = 1; round <= ROUNDS; round++) {
    say(`Round ${round}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const A = await ctx.newPage();
    let outPath = null;

    try {
        await A.goto(APP, { waitUntil: 'domcontentloaded' });
        await A.waitForTimeout(17000);
        await A.setInputFiles('input[type=file]', input);
        await A.waitForFunction(() => {
            const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
            return pm && pm.innerText.length > 100;
        }, { timeout: 180000 }).catch(() => {});
        await A.waitForTimeout(5000);

        await A.getByRole('button', { name: 'Share', exact: true }).click();
        await A.waitForFunction(
            () => [...document.querySelectorAll('input')].some((i) => (i.value || '').includes('room=')),
            { timeout: 90000 });
        await A.getByRole('button', { name: /Join the session/i }).click();
        await A.waitForTimeout(24000);

        // A real edit each round, so this measures the working path
        // rather than a no-op re-save.
        await A.evaluate(() => {
            const pm = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
            pm.focus();
            const r = document.createRange(); r.selectNodeContents(pm); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await A.keyboard.type(`R${round} `, { delay: 25 });
        await A.waitForTimeout(6000);

        await A.getByRole('button', { name: 'File', exact: true }).click();
        await A.waitForTimeout(1200);
        const [download] = await Promise.all([
            A.waitForEvent('download', { timeout: 180000 }),
            A.getByRole('menuitem', { name: /^Save/ }).first().click(),
        ]);
        outPath = join(RESULTS, `growth-${stem}-r${round}.docx`);
        await download.saveAs(outPath);
    } catch (err) {
        console.log(`  round ${round} FAILED: ${String(err).slice(0, 140)}`);
        await ctx.close();
        break;
    }
    await ctx.close();

    const inv = await inventory(outPath);
    const prev = rows[rows.length - 1];
    const factor = inv.size / prev.size;
    rows.push({ round, ...inv, factor });
    console.log(`  ${(inv.size / 1024).toFixed(0)} KB  media=${inv.media} distinct=${inv.distinct}  ` +
        `(x${factor.toFixed(2)} vs previous, x${(inv.size / first.size).toFixed(2)} vs original)`);

    input = outPath;
}

await browser.close();

say(`Growth — ${FIXTURE}`);
console.log('  round     size (KB)   media  distinct   vs prev   vs original');
for (const r of rows) {
    const vsPrev = r.factor ? `x${r.factor.toFixed(2)}` : '—';
    const vsOrig = `x${(r.size / first.size).toFixed(2)}`;
    console.log(`  ${String(r.round).padEnd(9)} ${(r.size / 1024).toFixed(0).padStart(9)} ` +
        `${String(r.media ?? '?').padStart(7)} ${String(r.distinct ?? '?').padStart(9)} ` +
        `${vsPrev.padStart(9)} ${vsOrig.padStart(13)}`);
}

await writeFile(join(RESULTS, `growth-${stem}.json`), JSON.stringify(rows, null, 2));

// The verdict this test exists to deliver.
//
// Judge ABSOLUTE growth per round, not the ratio. A document gaining a
// fixed 99 KB every cycle shows a decaying ratio -- 1.73, 1.42, 1.29 --
// purely because the denominator is growing, and a ratio-based test
// reads that decay as "settling down". It is not settling down; it is a
// straight line with no ceiling. Linear is not bounded.
const completed = rows.filter((r) => typeof r.round === 'number');
if (completed.length >= 3) {
    const deltas = [];
    for (let i = 1; i < rows.length; i++) deltas.push(rows[i].size - rows[i - 1].size);
    const lateDeltas = deltas.slice(-3);
    const avgLate = lateDeltas.reduce((a, b) => a + b, 0) / lateDeltas.length;
    const firstDelta = deltas[0];
    const pctOfOriginal = (avgLate / first.size) * 100;
    console.log();
    console.log(`  per-round growth (KB): ${deltas.map((d) => (d / 1024).toFixed(0)).join(', ')}`);
    if (avgLate > first.size * 0.02) {
        const at100 = ((first.size + avgLate * 100) / 1048576).toFixed(1);
        console.log(`  [41;37m UNBOUNDED [0m  every round adds ~${(avgLate / 1024).toFixed(0)} KB ` +
            `(${pctOfOriginal.toFixed(0)}% of the original). After 100 saves: ~${at100} MB.`);
    } else if (firstDelta > first.size * 0.1) {
        console.log(`  [43;30m ONE-TIME [0m  +${(firstDelta / 1024).toFixed(0)} KB on first export, ` +
            `then ~${(avgLate / 1024).toFixed(0)} KB per round`);
    } else {
        console.log(`  [42;30m STABLE [0m  no meaningful growth across ${completed.length} rounds`);
    }
}
