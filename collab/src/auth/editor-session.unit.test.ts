import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  EditorSessionRefused,
  SessionLedger,
  editorSessionSecretFromEnv,
  parseRevocations,
  verifyEditorSession,
} from './editor-session.js';

const SECRET = 'x'.repeat(32);
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const sign = (claims: object, secret = SECRET) =>
  jwt.sign(claims, secret, { algorithm: 'HS256', noTimestamp: true });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EditorSessionRefused, String(err));
    return err.why;
  }
  return null;
};

describe('editorSessionSecretFromEnv', () => {
  it('stops a production server with no key', () => {
    assert.throws(() => editorSessionSecretFromEnv({ NODE_ENV: 'production' }), /OFFICE_SIGNING_SECRET/);
  });

  it('stops a production server with a short key', () => {
    assert.throws(
      () => editorSessionSecretFromEnv({ NODE_ENV: 'production', OFFICE_SIGNING_SECRET: 'short' }),
      /OFFICE_SIGNING_SECRET/,
    );
  });

  it('runs without sessions only outside production', () => {
    assert.equal(editorSessionSecretFromEnv({ NODE_ENV: 'development' }), null);
    assert.equal(editorSessionSecretFromEnv({ NODE_ENV: 'production', OFFICE_SIGNING_SECRET: SECRET }), SECRET);
  });
});

describe('verifyEditorSession', () => {
  const good = () => ({ sid: 's', room: 'r', perm: 'view', exp: inAnHour() });

  it('returns the claims of a good token', () => {
    assert.equal(verifyEditorSession(sign(good()), 'r', SECRET).perm, 'view');
  });

  it('says why it refused, for the log', () => {
    assert.equal(refusal(() => verifyEditorSession(null, 'r', SECRET)), 'not_a_token');
    assert.equal(refusal(() => verifyEditorSession('anon', 'r', SECRET)), 'not_a_token');
    assert.equal(refusal(() => verifyEditorSession(sign(good(), 'y'.repeat(32)), 'r', SECRET)), 'not_a_token');
    assert.equal(refusal(() => verifyEditorSession(sign({ ...good(), exp: 1 }), 'r', SECRET)), 'expired');
    assert.equal(refusal(() => verifyEditorSession(sign({ ...good(), room: 'other' }), 'r', SECRET)), 'wrong_room');
    assert.equal(refusal(() => verifyEditorSession(sign({ ...good(), perm: 'owner' }), 'r', SECRET)), 'malformed');
    assert.equal(refusal(() => verifyEditorSession(sign({ ...good(), sid: 5 }), 'r', SECRET)), 'malformed');
  });

  it('accepts only HS256', () => {
    const hs512 = jwt.sign(good(), SECRET, { algorithm: 'HS512', noTimestamp: true });
    assert.equal(refusal(() => verifyEditorSession(hs512, 'r', SECRET)), 'not_a_token');
  });

  it('refuses a token with no expiry', () => {
    const { exp: _exp, ...forever } = good();
    assert.equal(refusal(() => verifyEditorSession(sign(forever), 'r', SECRET)), 'malformed');
  });
});

describe('SessionLedger', () => {
  const claims = (sid: string, exp = inAnHour()) => ({ sid, room: 'r', perm: 'edit' as const, exp });

  it('closes a live connection when its session is revoked, once', () => {
    const ledger = new SessionLedger();
    let closed = 0;
    ledger.admit('a', claims('s'), () => closed++);
    assert.equal(ledger.revoke([{ sid: 's', exp: inAnHour() }]), 1);
    assert.equal(ledger.revoke([{ sid: 's', exp: inAnHour() }]), 0);
    assert.equal(closed, 1);
    assert.equal(ledger.isRevoked('s'), true);
  });

  it('closes a connection that arrives after its session was revoked', () => {
    const ledger = new SessionLedger();
    let closed = 0;
    ledger.revoke([{ sid: 's', exp: inAnHour() }]);
    ledger.admit('a', claims('s'), () => closed++);
    assert.equal(closed, 1);
    assert.equal(ledger.liveCount(), 0);
  });

  it('closes a connection whose token ran out before it was admitted', () => {
    const ledger = new SessionLedger();
    let closed = 0;
    ledger.admit('a', claims('s', Math.floor(Date.now() / 1000) - 1), () => closed++);
    assert.equal(closed, 1);
  });

  it('does not close a connection that has already gone', () => {
    const ledger = new SessionLedger();
    let closed = 0;
    ledger.admit('a', claims('s'), () => closed++);
    ledger.release('a');
    ledger.revoke([{ sid: 's', exp: inAnHour() }]);
    assert.equal(closed, 0);
  });

  it('forgets a revocation once the token could not work anyway', () => {
    let now = 1_000_000;
    const ledger = new SessionLedger(() => now);
    ledger.revoke([{ sid: 's', exp: now / 1000 + 10 }]);
    assert.equal(ledger.isRevoked('s'), true);
    now += 11_000;
    assert.equal(ledger.isRevoked('s'), false);
  });
});

describe('parseRevocations', () => {
  it('takes a list of sessions, and nothing else', () => {
    assert.deepEqual(parseRevocations({ sessions: [{ sid: 'a', exp: 1 }] }), [{ sid: 'a', exp: 1 }]);
    assert.deepEqual(parseRevocations({ sessions: [] }), []);
    for (const bad of [null, {}, { sessions: 'x' }, { sessions: [{ sid: 'a' }] }, { sessions: [{ exp: 1 }] }, { sessions: [null] }]) {
      assert.equal(parseRevocations(bad), null);
    }
  });
});
