/**
 * Room permissions, attacked over the real socket.
 *
 * Starts the real server in its own process and speaks the wire protocol from raw
 * frames, because a person trying this would not be using the editor. Every check
 * reads the result back through `/internal/rooms/:id/state`, the same route the host
 * reads rooms with, so "refused" means the room did not change, not merely that a
 * refusal was sent.
 *
 *   node --import tsx --test src/auth/editor-session.integration.test.ts
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { HocuspocusProvider } from '@hocuspocus/provider';

const PORT = 3911;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/yjs`;
const SIGNING_SECRET = randomBytes(32).toString('hex');
const SERVICE_TOKEN = randomBytes(32).toString('hex');

// The wire protocol's message types.
const MSG = { sync: 0, awareness: 1, auth: 2, syncStatus: 8 } as const;
const SYNC = { step1: 0, step2: 1, update: 2 } as const;
const AUTH_REPLY = { denied: 1, authenticated: 2 } as const;

let server: ChildProcess;
let serverLog = '';

type Claims = { sid?: unknown; room?: unknown; perm?: unknown; exp?: unknown };

let sessionCounter = 0;
const inHours = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

/** A token as the host would sign it. */
function token(room: string, perm: string, overrides: Claims = {}, secret = SIGNING_SECRET): string {
  return jwt.sign(
    { sid: `session-${++sessionCounter}`, room, perm, sub: 'someone', exp: inHours(1), ...overrides },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

const newRoom = () => `room-${randomBytes(6).toString('hex')}`;

/** An update that adds `text` to a document, as a client's Y.Doc would encode it. */
function updateWriting(text: string, seed?: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  if (seed) Y.applyUpdate(doc, seed);
  const before = Y.encodeStateVector(doc);
  doc.getText('body').insert(0, text);
  return Y.encodeStateAsUpdate(doc, before);
}

function frame(room: string, write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, room);
  write(e);
  return encoding.toUint8Array(e);
}

const authFrame = (room: string, value: string) => frame(room, (e) => {
  encoding.writeVarUint(e, MSG.auth);
  encoding.writeVarUint(e, 0);
  encoding.writeVarString(e, value);
});

const syncFrame = (room: string, step: number, payload: Uint8Array) => frame(room, (e) => {
  encoding.writeVarUint(e, MSG.sync);
  encoding.writeVarUint(e, step);
  encoding.writeVarUint8Array(e, payload);
});

/** A client with nothing between it and the server. */
class RawClient {
  socket!: WebSocket;
  closeCode: number | null = null;
  authReplies: Array<{ room: string; kind: number; scope: string }> = [];
  syncStatuses: boolean[] = [];
  /** Updates this client was sent by the server, applied to a local doc. */
  doc = new Y.Doc();

  static async open(query = ''): Promise<RawClient> {
    const client = new RawClient();
    client.socket = new WebSocket(WS + query);
    client.socket.on('message', (data: Buffer) => client.receive(new Uint8Array(data)));
    client.socket.on('close', (code) => { client.closeCode = code; });
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', () => resolve());
      client.socket.once('error', reject);
    });
    return client;
  }

  private receive(data: Uint8Array) {
    const d = decoding.createDecoder(data);
    const room = decoding.readVarString(d);
    const type = decoding.readVarUint(d);

    if (type === MSG.auth) {
      const kind = decoding.readVarUint(d);
      const scope = decoding.hasContent(d) ? decoding.readVarString(d) : '';
      this.authReplies.push({ room, kind, scope });
    } else if (type === MSG.syncStatus) {
      this.syncStatuses.push(decoding.readVarUint(d) === 1);
    } else if (type === MSG.sync || type === 4) {
      const step = decoding.readVarUint(d);
      if (step === SYNC.step2 || step === SYNC.update) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(d));
      }
    }
  }

  send(bytes: Uint8Array) {
    this.socket.send(bytes);
  }

  /** Authenticate, and resolve with what the server said. */
  async auth(room: string, value: string) {
    const seen = this.authReplies.length;
    this.send(authFrame(room, value));
    await until(() => this.authReplies.length > seen, 'an auth reply');
    return this.authReplies[seen];
  }

  /** Ask for the room as a client joining would. */
  requestDocument(room: string) {
    this.send(syncFrame(room, SYNC.step1, Y.encodeStateVector(this.doc)));
  }

  text() {
    return this.doc.getText('body').toString();
  }

  close() {
    this.socket.terminate();
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** Long enough for anything sent to have been processed and saved. */
const settle = () => sleep(250);

type RoomReport = { exists: boolean; fingerprint?: string; state?: string };

async function roomState(room: string): Promise<RoomReport> {
  const response = await fetch(`${HTTP}/internal/rooms/${room}/state`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as RoomReport;
}

async function roomText(room: string): Promise<string> {
  const report = await roomState(room);
  if (!report.exists || !report.state) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(report.state, 'base64')));
  return doc.getText('body').toString();
}

async function revoke(sessions: Array<{ sid: string; exp: number }>, credential = SERVICE_TOKEN) {
  return fetch(`${HTTP}/internal/sessions/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });
}

/** A room holding `text`, written by a legitimate editor, who is then still connected. */
async function roomWith(text: string) {
  const room = newRoom();
  const editor = await RawClient.open();
  const reply = await editor.auth(room, token(room, 'edit'));
  assert.equal(reply.kind, AUTH_REPLY.authenticated);
  editor.send(syncFrame(room, SYNC.update, updateWriting(text)));
  await until(() => editor.syncStatuses.includes(true), 'the first write to be accepted');
  assert.equal(await roomText(room), text);
  return { room, editor };
}

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      REDIS_URL: '',
      OFFICE_SIGNING_SECRET: SIGNING_SECRET,
      CASUAL_JWT_SECRET: SERVICE_TOKEN,
      CASUAL_PERSONAL_MODE: 'none',
      RATE_LIMIT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => { serverLog += d; });
  server.stderr!.on('data', (d) => { serverLog += d; });

  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${HTTP}/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - started > 45000 || server.exitCode !== null) {
      throw new Error(`the server did not start:\n${serverLog}`);
    }
    await sleep(100);
  }
});

after(() => {
  server?.kill();
});

describe('a legitimate editor', () => {
  it('writes with an ordinary update, and the room keeps it', async () => {
    const { room, editor } = await roomWith('written by an editor');
    assert.equal(await roomText(room), 'written by an editor');
    editor.close();
  });

  it('writes with a sync step 2, and the room keeps it', async () => {
    const room = newRoom();
    const editor = await RawClient.open();
    await editor.auth(room, token(room, 'edit'));
    editor.send(syncFrame(room, SYNC.step2, updateWriting('synced in')));
    await until(() => editor.syncStatuses.includes(true), 'the sync to be accepted');
    assert.equal(await roomText(room), 'synced in');
    editor.close();
  });

  it('is told it may write', async () => {
    const room = newRoom();
    const editor = await RawClient.open();
    const reply = await editor.auth(room, token(room, 'edit'));
    assert.equal(reply.scope, 'read-write');
    editor.close();
  });
});

describe('a viewer', () => {
  it('reads what is in the room, and sees later edits arrive', async () => {
    const { room, editor } = await roomWith('for reading');
    const viewer = await RawClient.open();
    const reply = await viewer.auth(room, token(room, 'view'));
    assert.equal(reply.scope, 'readonly');
    viewer.requestDocument(room);
    await until(() => viewer.text() === 'for reading', 'the viewer to receive the document');

    editor.requestDocument(room);
    await until(() => editor.text() === 'for reading', 'the editor to sync');
    editor.send(syncFrame(room, SYNC.update, updateWriting('more ', Y.encodeStateAsUpdate(editor.doc))));
    await until(() => viewer.text().includes('more '), 'the viewer to receive a live edit');
    editor.close();
    viewer.close();
  });

  for (const [name, step] of [['an ordinary update', SYNC.update], ['a sync step 2', SYNC.step2]] as const) {
    it(`cannot change the room with ${name}`, async () => {
      const { room, editor } = await roomWith('original');
      const fingerprint = (await roomState(room)).fingerprint;

      const viewer = await RawClient.open();
      await viewer.auth(room, token(room, 'view'));
      viewer.send(syncFrame(room, step, updateWriting('VIEWER WAS HERE')));

      await until(() => viewer.syncStatuses.includes(false), 'the update to be refused');
      await settle();

      assert.equal(await roomText(room), 'original');
      assert.equal((await roomState(room)).fingerprint, fingerprint, 'the room changed by a byte');
      assert.ok(!viewer.syncStatuses.includes(true), 'the server claimed to accept it');
      editor.close();
      viewer.close();
    });
  }

  it('does not pass its refused update on to other people in the room', async () => {
    const { room, editor } = await roomWith('original');
    const otherViewer = await RawClient.open();
    await otherViewer.auth(room, token(room, 'view'));
    otherViewer.requestDocument(room);
    await until(() => otherViewer.text() === 'original', 'the other viewer to sync');

    const viewer = await RawClient.open();
    await viewer.auth(room, token(room, 'view'));
    viewer.send(syncFrame(room, SYNC.update, updateWriting('VIEWER WAS HERE')));
    await until(() => viewer.syncStatuses.includes(false), 'the update to be refused');
    await settle();

    assert.equal(otherViewer.text(), 'original');
    editor.close();
    viewer.close();
    otherViewer.close();
  });

  it('is refused even when the update was queued before it authenticated', async () => {
    const { room, editor } = await roomWith('original');
    const viewer = await RawClient.open();
    // Sent first: the server holds this until it knows who is talking.
    viewer.send(syncFrame(room, SYNC.update, updateWriting('QUEUED')));
    viewer.send(syncFrame(room, SYNC.step2, updateWriting('QUEUED TOO')));
    await viewer.auth(room, token(room, 'view'));
    await until(() => viewer.syncStatuses.filter((s) => !s).length === 2, 'both to be refused');
    await settle();
    assert.equal(await roomText(room), 'original');
    editor.close();
    viewer.close();
  });

  it('gets nothing for claiming to be a writer in the URL', async () => {
    const { room, editor } = await roomWith('original');
    const viewer = await RawClient.open('?role=edit&share=anything');
    const reply = await viewer.auth(room, token(room, 'view'));
    assert.equal(reply.scope, 'readonly');
    viewer.send(syncFrame(room, SYNC.update, updateWriting('SPOOFED')));
    await until(() => viewer.syncStatuses.includes(false), 'the update to be refused');
    assert.equal(await roomText(room), 'original');
    editor.close();
    viewer.close();
  });
});

describe('a connection with no valid session', () => {
  const invalid: Array<[string, (room: string) => string]> = [
    ['no token at all', () => ''],
    ['the placeholder an unconfigured editor sends', () => 'anon'],
    ['gibberish', () => 'not.a.token'],
    ['the wrong key', (room) => token(room, 'edit', {}, randomBytes(32).toString('hex'))],
    ['the service credential as its key', (room) => token(room, 'edit', {}, SERVICE_TOKEN)],
    ['a tampered permission', (room) => {
      const [h, , s] = token(room, 'view').split('.');
      const payload = Buffer.from(JSON.stringify({ sid: 'x', room, perm: 'edit', exp: inHours(1) })).toString('base64url');
      return `${h}.${payload}.${s}`;
    }],
    ['alg none', (room) => {
      const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ sid: 'x', room, perm: 'edit', exp: inHours(1) })).toString('base64url');
      return `${h}.${p}.`;
    }],
    ['an expired session', (room) => token(room, 'edit', { exp: inHours(-1) })],
    ['no session id', (room) => token(room, 'edit', { sid: '' })],
    ['an unknown permission', (room) => token(room, 'admin')],
    ['no permission', (room) => token(room, 'edit', { perm: undefined })],
    ['a session for another room', () => token(newRoom(), 'edit')],
  ];

  for (const [name, make] of invalid) {
    it(`is refused with ${name}, and changes nothing`, async () => {
      const { room, editor } = await roomWith('original');
      const fingerprint = (await roomState(room)).fingerprint;

      const intruder = await RawClient.open('?role=edit');
      intruder.send(syncFrame(room, SYNC.update, updateWriting('INTRUDER')));
      const reply = await intruder.auth(room, make(room));
      assert.equal(reply.kind, AUTH_REPLY.denied);

      intruder.requestDocument(room);
      await until(() => intruder.closeCode !== null, 'the socket to be closed');
      await settle();

      assert.equal(await roomText(room), 'original');
      assert.equal((await roomState(room)).fingerprint, fingerprint);
      assert.equal(intruder.text(), '', 'it was sent the document');
      editor.close();
    });
  }

  it('that never authenticates can neither write nor read', async () => {
    const { room, editor } = await roomWith('original');
    const silent = await RawClient.open('?role=edit');
    silent.send(syncFrame(room, SYNC.update, updateWriting('SILENT')));
    silent.requestDocument(room);
    await sleep(600);
    assert.equal(await roomText(room), 'original');
    assert.equal(silent.text(), '');
    silent.close();
    editor.close();
  });

  it('does not create a room by asking for one', async () => {
    const room = newRoom();
    const intruder = await RawClient.open();
    await intruder.auth(room, 'anon');
    await settle();
    assert.equal((await roomState(room)).exists, false);
    const registered = await fetch(`${HTTP}/api/rooms/${room}/info`);
    assert.equal(registered.status, 404, 'it was added to the registry');
    intruder.close();
  });
});

describe('room binding', () => {
  it('a session for one room opens only that room, on one socket', async () => {
    const mine = await roomWith('mine');
    const theirs = await roomWith('theirs');

    const client = await RawClient.open();
    const myToken = token(mine.room, 'edit');

    assert.equal((await client.auth(mine.room, myToken)).kind, AUTH_REPLY.authenticated);

    // The protocol multiplexes documents on a socket, so the second document is
    // authenticated separately. The same token must not carry over.
    client.send(syncFrame(theirs.room, SYNC.update, updateWriting('CROSSED OVER')));
    const second = await client.auth(theirs.room, myToken);
    assert.equal(second.kind, AUTH_REPLY.denied);
    await settle();

    assert.equal(await roomText(theirs.room), 'theirs');
    assert.equal(await roomText(mine.room), 'mine');
    client.close();
    mine.editor.close();
    theirs.editor.close();
  });

  it('a socket authenticated on one room cannot write to another without its own session', async () => {
    const mine = await roomWith('mine');
    const theirs = await roomWith('theirs');
    const client = await RawClient.open();
    await client.auth(mine.room, token(mine.room, 'edit'));
    client.send(syncFrame(theirs.room, SYNC.update, updateWriting('NO AUTH AT ALL')));
    await sleep(400);
    assert.equal(await roomText(theirs.room), 'theirs');
    client.close();
    mine.editor.close();
    theirs.editor.close();
  });
});

describe('a session running out', () => {
  it('ends the socket at expiry, so nothing can be written after it', async () => {
    const { room, editor } = await roomWith('original');
    const short = token(room, 'edit', { exp: Math.floor(Date.now() / 1000) + 2 });

    const client = await RawClient.open();
    await client.auth(room, short);
    client.send(syncFrame(room, SYNC.update, updateWriting('before expiry ')));
    await until(() => client.syncStatuses.includes(true), 'the write before expiry');

    await until(() => client.closeCode !== null, 'the server to end the session', 4000);
    assert.equal(client.closeCode, 4000);
    assert.ok((await roomText(room)).includes('before expiry '));
    const atExpiry = (await roomState(room)).fingerprint;

    const again = await RawClient.open();
    again.send(syncFrame(room, SYNC.update, updateWriting('AFTER EXPIRY')));
    assert.equal((await again.auth(room, short)).kind, AUTH_REPLY.denied, 'the expired token was accepted again');
    await settle();
    assert.equal((await roomState(room)).fingerprint, atExpiry);
    again.close();
    editor.close();
  });

  it('a real provider reconnects with a renewed token, keeping what was typed offline', async () => {
    const { room, editor } = await roomWith('');
    let current = token(room, 'edit', { exp: Math.floor(Date.now() / 1000) + 2 });
    const doc = new Y.Doc();
    const refused: string[] = [];
    const provider = new HocuspocusProvider({
      url: WS,
      name: room,
      document: doc,
      token: () => current,
      WebSocketPolyfill: WebSocket as never,
      onAuthenticationFailed: ({ reason }: { reason: string }) => refused.push(reason),
      preserveConnection: false,
      delay: 50,
      minDelay: 50,
      maxAttempts: 0,
    } as never);

    try {
      let dropped = false;
      provider.on('disconnect', () => { dropped = true; });

      await until(() => provider.isSynced, 'the provider to sync');
      doc.getText('body').insert(0, 'first ');
      await sleep(300);
      assert.equal(await roomText(room), 'first ');

      // The token is about to run out and the host has renewed it. The server ends
      // the old session regardless, and what is typed during the gap must survive.
      current = token(room, 'edit');
      await until(() => dropped, 'the server to end the old session', 4000);
      doc.getText('body').insert(doc.getText('body').length, 'second');

      const started = Date.now();
      while ((await roomText(room)) !== 'first second') {
        if (Date.now() - started > 8000) assert.fail(`the room holds: ${await roomText(room)}`);
        await sleep(50);
      }
      assert.deepEqual(refused, [], 'the renewed token was refused');
    } finally {
      provider.destroy();
      // A provider does not stop its socket's timers by itself.
      provider.configuration.websocketProvider.destroy();
      editor.close();
    }
  });

  it('a provider holding a dead token stops, and recovers when given a new one', async () => {
    const { room, editor } = await roomWith('');
    let current = token(room, 'edit', { exp: inHours(-1) });
    const refused: string[] = [];
    const provider = new HocuspocusProvider({
      url: WS,
      name: room,
      document: new Y.Doc(),
      token: () => current,
      WebSocketPolyfill: WebSocket as never,
      onAuthenticationFailed: ({ reason }: { reason: string }) => refused.push(reason),
      preserveConnection: false,
    } as never);

    try {
      await until(() => refused.length === 1, 'the provider to be refused');
      // The host may answer before or after the server closes the refused socket.
      // Both orders have to recover, so this is the awkward one: immediately.
      current = token(room, 'edit');
      await provider.connect();
      await until(() => provider.isSynced, 'the provider to recover');
      assert.equal(refused.length, 1);
    } finally {
      provider.destroy();
      // A provider does not stop its socket's timers by itself.
      provider.configuration.websocketProvider.destroy();
      editor.close();
    }
  });
});

describe('a refused client', () => {
  const refusals = () => (serverLog.match(/refused a connection/g) ?? []).length;

  for (const [name, config] of [
    ['this editor', { preserveConnection: false, token: 'anon' }],
    // What a tab left open across a deployment is running: no session token, and
    // the provider's default socket handling.
    ['an editor from before sessions', { token: 'anon' }],
  ] as const) {
    it(`does not hammer the server: ${name}`, async () => {
      const { room, editor } = await roomWith('original');
      const before = refusals();
      const provider = new HocuspocusProvider({
        url: WS,
        name: room,
        document: new Y.Doc(),
        WebSocketPolyfill: WebSocket as never,
        delay: 50,
        minDelay: 50,
        ...config,
      } as never);

      try {
        await until(() => refusals() > before, 'the first refusal');
        await sleep(3000);
        assert.equal(refusals() - before, 1, 'it kept trying');
      } finally {
        provider.destroy();
        provider.configuration.websocketProvider.destroy();
        editor.close();
      }
    });
  }
});

describe('a session being revoked', () => {
  it('closes the live socket, and the room keeps only what came before', async () => {
    const { room, editor } = await roomWith('original');
    const sid = 'to-be-revoked';
    const exp = inHours(1);
    const revokedToken = token(room, 'edit', { sid, exp });

    const client = await RawClient.open();
    await client.auth(room, revokedToken);

    const response = await revoke([{ sid, exp }]);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { closed: 1 });
    await until(() => client.closeCode !== null, 'the socket to be closed');
    assert.equal(client.closeCode, 4000);
    await settle();
    assert.equal(await roomText(room), 'original');

    // The token is still cryptographically good, and still refused.
    const again = await RawClient.open();
    assert.equal((await again.auth(room, revokedToken)).kind, AUTH_REPLY.denied);
    again.close();
    editor.close();
  });

  it('leaves other people, and other sessions of the same person, alone', async () => {
    const { room, editor } = await roomWith('original');
    const exp = inHours(1);
    const a = await RawClient.open();
    await a.auth(room, token(room, 'edit', { sid: 'tab-a', exp }));
    const b = await RawClient.open();
    await b.auth(room, token(room, 'edit', { sid: 'tab-b', exp }));

    assert.deepEqual(await (await revoke([{ sid: 'tab-a', exp }])).json(), { closed: 1 });
    await until(() => a.closeCode !== null, 'tab a to close');
    await settle();

    assert.equal(b.closeCode, null);
    assert.equal(editor.closeCode, null);
    b.send(syncFrame(room, SYNC.update, updateWriting('from b')));
    await until(() => b.syncStatuses.includes(true), 'tab b to go on writing');
    b.close();
    editor.close();
  });

  it('turns an editor into a viewer: they reconnect read-only with a new session', async () => {
    const { room, editor } = await roomWith('original');
    const exp = inHours(1);
    const client = await RawClient.open();
    await client.auth(room, token(room, 'edit', { sid: 'was-editor', exp }));
    await revoke([{ sid: 'was-editor', exp }]);
    await until(() => client.closeCode !== null, 'the socket to be closed');

    const reissued = await RawClient.open();
    const reply = await reissued.auth(room, token(room, 'view', { sid: 'now-viewer', exp }));
    assert.equal(reply.scope, 'readonly');
    reissued.send(syncFrame(room, SYNC.update, updateWriting('STILL TRYING')));
    await until(() => reissued.syncStatuses.includes(false), 'the update to be refused');
    assert.equal(await roomText(room), 'original');
    reissued.close();
    editor.close();
  });

  it('is idempotent, and may name a session with no socket', async () => {
    const exp = inHours(1);
    assert.deepEqual(await (await revoke([{ sid: 'nobody', exp }])).json(), { closed: 0 });
    assert.deepEqual(await (await revoke([{ sid: 'nobody', exp }])).json(), { closed: 0 });
  });

  it('requires the service credential', async () => {
    const { room, editor } = await roomWith('original');
    const exp = inHours(1);
    const client = await RawClient.open();
    await client.auth(room, token(room, 'edit', { sid: 'should-survive', exp }));

    assert.equal((await revoke([{ sid: 'should-survive', exp }], 'wrong')).status, 401);
    // A person's session token is not the service credential.
    assert.equal((await revoke([{ sid: 'should-survive', exp }], token(room, 'edit'))).status, 401);
    await settle();
    assert.equal(client.closeCode, null);
    client.close();
    editor.close();
  });

  it('refuses a request that is not a list of sessions', async () => {
    for (const body of [{}, { sessions: 'all' }, { sessions: [{ sid: '' , exp: 1 }] }, { sessions: [{ sid: 'x' }] }]) {
      const response = await fetch(`${HTTP}/internal/sessions/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  });
});
