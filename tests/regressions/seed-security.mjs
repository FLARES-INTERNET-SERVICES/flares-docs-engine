/**
 * Security regression tests for room initialisation.
 *
 * Shipped, `POST /api/rooms/:id/seed` took no credential: anyone who
 * learned a room id could replace the document every participant was
 * about to open. These lock that shut and keep it shut.
 *
 * Tokens are forged here with raw crypto rather than a library, so the
 * test is checking the server's verification rather than agreeing with
 * the server's own signing code.
 *
 *   node tests/regressions/seed-security.mjs
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLAB = process.env.COLLAB_URL ?? 'http://localhost:8080';
// Matches CASUAL_JWT_SECRET in docker-compose.yml.
const SECRET = process.env.CASUAL_JWT_SECRET
    ?? 'change-me-in-any-real-deployment';

let checks = 0;
let failures = 0;
const pass = (m) => { checks++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const fail = (m, d) => { checks++; failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? ` -- ${d}` : ''}`); };
const check = (c, m, d) => (c ? pass(m) : fail(m, d));
const say = (m) => console.log(`\n\x1b[1;37m== ${m}\x1b[0m`);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Hand-roll an HS256 JWT so we control every claim. */
function forge(claims, { secret = SECRET, alg = 'HS256' } = {}) {
    const header = b64({ alg, typ: 'JWT' });
    const body = b64(claims);
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = (room) => ({
    room, op: 'initialize_room', can_seed: true, iat: now(), exp: now() + 300,
});

const docx = await readFile(join(process.cwd(), 'fixtures', 'docs', 'basic.docx'));

async function newRoom() {
    const res = await fetch(`${COLLAB}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    return res.json();
}

async function seed(room, token, bytes = docx) {
    const form = new FormData();
    form.append('file', new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }), 'basic.docx');
    return fetch(`${COLLAB}/api/rooms/${encodeURIComponent(room)}/seed`, {
        method: 'POST',
        headers: token ? { 'x-seed-token': token } : undefined,
        body: form,
    });
}

say('The server issues a capability token with each room');
const created = await newRoom();
check(typeof created.roomId === 'string' && created.roomId.length > 0, 'a room id was returned');
check(typeof created.seedToken === 'string' && created.seedToken.split('.').length === 3,
    'a signed seed token was returned alongside it');

say('Rejected: no token');
{
    // A fresh room per case: a negative test that accidentally succeeds
    // must not leave the next one facing an already-seeded room and
    // reporting a misleading 409.
    const res = await seed((await newRoom()).roomId, null);
    check(res.status === 401, 'unauthenticated seed is refused', `got HTTP ${res.status}`);
}

say('Rejected: a token minted for a different room');
{
    const other = await newRoom();
    const res = await seed((await newRoom()).roomId, other.seedToken);
    check(res.status === 401, "another room's token cannot seed this one", `got HTTP ${res.status}`);
}

say('Rejected: tampered payload');
{
    // Take a valid token, extend its expiry by a year, keep the original
    // signature. This is the attack the signature exists to stop.
    //
    // An earlier version of this test "tampered" by re-encoding the SAME
    // claims, which reproduced the original token byte for byte (same
    // key order, same second, so same iat/exp) and was accepted -- quite
    // correctly, since nothing had actually been altered. The lesson:
    // a tampering test has to change something.
    const room = (await newRoom()).roomId;
    const good = (await newRoom()).seedToken; // any validly-signed token
    const [h, payload, sig] = good.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    claims.exp = now() + 31_536_000;
    claims.room = room;
    const res = await seed(room, `${h}.${b64(claims)}.${sig}`);
    check(res.status === 401, 'a re-written payload is refused', `got HTTP ${res.status}`);
}

say('Rejected: signed with the wrong key');
{
    const room = (await newRoom()).roomId;
    const res = await seed(room, forge(validClaims(room), { secret: 'not-the-real-secret-at-all' }));
    check(res.status === 401, 'a token signed with another key is refused', `got HTTP ${res.status}`);
}

say('Rejected: alg=none');
{
    const room = (await newRoom()).roomId;
    const header = b64({ alg: 'none', typ: 'JWT' });
    const body = b64(validClaims(room));
    const res = await seed(room, `${header}.${body}.`);
    check(res.status === 401, 'an unsigned alg=none token is refused', `got HTTP ${res.status}`);
}

say('Rejected: expired');
{
    const room = (await newRoom()).roomId;
    const expired = forge({
        room, op: 'initialize_room', can_seed: true,
        iat: now() - 3600, exp: now() - 60,
    });
    const res = await seed(room, expired);
    check(res.status === 401, 'an expired token is refused', `got HTTP ${res.status}`);
}

say('Rejected: right room, wrong capability');
{
    const room = (await newRoom()).roomId;
    const wrongOp = forge({
        room, op: 'read_document', can_seed: false,
        iat: now(), exp: now() + 300,
    });
    check((await seed(room, wrongOp)).status === 401,
        'a token without the seed capability is refused');
}

say('Accepted: the genuine token, once');
{
    const first = await seed(created.roomId, created.seedToken);
    check(first.status === 200, 'the room owner can seed the room', `got HTTP ${first.status}`);

    // Replay. Same valid token, same room, second time.
    const replay = await seed(created.roomId, created.seedToken);
    check(replay.status === 409, 'replaying the same token cannot replace the document',
        `got HTTP ${replay.status}`);
}

say('One-time initialisation under a concurrent race');
{
    const room = (await newRoom()).roomId;
    // Twenty clients reaching the same fresh room at the same instant.
    const results = await Promise.all(
        Array.from({ length: 20 }, () =>
            fetch(`${COLLAB}/api/rooms/${room}/claim-init`, { method: 'POST' })
                .then((r) => r.json())
                .catch(() => ({ won: false }))
        )
    );
    const winners = results.filter((r) => r.won === true).length;
    check(winners === 1, 'exactly one of 20 concurrent claims wins', `${winners} winners`);
}

say('Unknown room');
{
    const res = await seed(`no-such-room-${randomUUID().slice(0, 8)}`, created.seedToken);
    check(res.status === 404 || res.status === 401, 'seeding a non-existent room fails',
        `got HTTP ${res.status}`);
}

console.log(failures === 0
    ? `\n  \x1b[42;30m PASS \x1b[0m  ${checks} security checks\n`
    : `\n  \x1b[41;37m FAIL \x1b[0m  ${failures} of ${checks} security checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
