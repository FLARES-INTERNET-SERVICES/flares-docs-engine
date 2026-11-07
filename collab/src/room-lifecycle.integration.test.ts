/**
 * A room's life, over the real socket and the real routes.
 *
 * Who may bring a room into being, what cleanup may do to it, how it ends, and what
 * a token is worth at each point. Starts the real server in its own process. What
 * Redis itself does with an expiry, and a real restart with stored state, are proven
 * with a real Redis in tools/office-lab/casual-docs-repair/tests/docs-recovery.mjs.
 *
 *   node --import tsx --test src/room-lifecycle.integration.test.ts
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { attachHocuspocus } from './yjs.js';
import { RoomRegistry } from './rooms.js';
import { InMemoryStorage } from './storage.js';
import { SessionLedger } from './auth/editor-session.js';

const PORT = 3913;
const COLD_PORT = 3914;
const SIGNING_SECRET = randomBytes(32).toString('hex');
const SERVICE_TOKEN = randomBytes(32).toString('hex');

type Server = { process: ChildProcess; http: string; ws: string; log: () => string };

async function startServer(port: number, env: Record<string, string> = {}): Promise<Server> {
  let log = '';
  const child = spawn(process.env.COLLAB_NODE ?? process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      REDIS_URL: '',
      OFFICE_SIGNING_SECRET: SIGNING_SECRET,
      CASUAL_JWT_SECRET: SERVICE_TOKEN,
      CASUAL_PERSONAL_MODE: 'none',
      RATE_LIMIT_ENABLED: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { log += d; });
  child.stderr!.on('data', (d) => { log += d; });

  const http = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${http}/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - started > 45000 || child.exitCode !== null) {
      throw new Error(`the server did not start:\n${log}`);
    }
    await sleep(100);
  }

  return { process: child, http, ws: `ws://127.0.0.1:${port}/yjs`, log: () => log };
}

let server: Server;

// A provider left open keeps trying to reconnect, and this process never exits.
const openClients: Array<{ provider: HocuspocusProvider }> = [];

afterEach(() => {
  for (const client of openClients.splice(0)) {
    client.provider.destroy();
  }
});

// Rooms forgotten almost at once, so the collector's next sweep finds them.
before(async () => {
  server = await startServer(PORT, { ROOM_TTL_MIN: '0.002' });
  await sync(server);
});

after(() => {
  server?.process.kill();
});

const room = () => `room-${randomBytes(6).toString('hex')}`;
const auth = { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' };
const inHours = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

let counter = 0;
function token(name: string, perm: 'edit' | 'view' = 'edit', sid = `s-${++counter}`, secret = SIGNING_SECRET): string {
  return jwt.sign({ sid, room: name, perm, exp: inHours(1) }, secret, { algorithm: 'HS256', noTimestamp: true });
}

function sync(target: Server, sessions: Array<{ sid: string; exp: number }> = []) {
  return fetch(`${target.http}/internal/sessions/revoke`, { method: 'POST', headers: auth, body: JSON.stringify({ sessions }) });
}

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  if (text !== '') paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('prosemirror').push([paragraph]);
  return doc;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const encoded = (text: string) => base64(Y.encodeStateAsUpdate(docWith(text)));

async function prepare(name: string, body: Record<string, unknown>, target = server) {
  const response = await fetch(`${target.http}/internal/rooms/${name}/prepare`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function stateOf(name: string, known?: string, target = server) {
  const query = known ? `?known=${known}` : '';
  const response = await fetch(`${target.http}/internal/rooms/${name}/state${query}`, { headers: auth });
  assert.equal(response.status, 200);
  return (await response.json()) as { exists: boolean; state?: string; fingerprint?: string; hasContent?: boolean; unchanged?: boolean };
}

function textIn(state: string | undefined): string {
  if (!state) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(state, 'base64')));
  const text = doc.getXmlFragment('prosemirror').toString().replace(/<[^>]*>/g, '');
  doc.destroy();
  return text;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The client the editor uses, reporting what happened to it. */
function connect(name: string, value: string, target = server) {
  const doc = new Y.Doc();
  const events = { refused: 0, synced: 0, closes: [] as number[] };
  const provider = new HocuspocusProvider({
    url: target.ws,
    name,
    document: doc,
    token: value,
    WebSocketPolyfill: WebSocket as never,
    preserveConnection: false,
    onAuthenticationFailed: () => { events.refused++; },
    onSynced: () => { events.synced++; },
    onClose: ({ event }) => { events.closes.push(event.code); },
  } as never);
  const client = { doc, provider, events, text: () => doc.getXmlFragment('prosemirror').toString().replace(/<[^>]*>/g, '') };
  openClients.push(client);
  return client;
}

describe('nothing but the host can bring a room into being', () => {
  it('refuses a good token for a room with nothing stored', async () => {
    const name = room();
    const client = connect(name, token(name));

    await until(() => client.events.refused > 0, 'a refusal');

    assert.equal(client.events.synced, 0);
    client.provider.destroy();
  });

  it('leaves nothing behind after refusing', async () => {
    const name = room();
    const client = connect(name, token(name));
    await until(() => client.events.refused > 0, 'a refusal');
    client.provider.destroy();
    await sleep(100);

    assert.equal((await stateOf(name)).exists, false);
  });

  it('does not retry a refusal on its own', async () => {
    const name = room();
    const before = (server.log().match(/refused a connection/g) ?? []).length;
    const client = connect(name, token(name));
    await until(() => client.events.refused > 0, 'a refusal');

    await sleep(1500);

    const refusals = (server.log().match(/refused a connection/g) ?? []).length - before;
    assert.equal(refusals, 1, 'one refusal, not a loop');
    client.provider.destroy();
  });

  it('admits the same token once the host has filled the room', async () => {
    const name = room();
    const value = token(name);
    const refused = connect(name, value);
    await until(() => refused.events.refused > 0, 'a refusal');
    refused.provider.destroy();

    assert.equal((await prepare(name, { state: encoded('the essay') })).body.outcome, 'restored');

    const client = connect(name, value);
    await until(() => client.events.synced > 0, 'a sync');
    await until(() => client.text() === 'the essay', 'the text');
    client.provider.destroy();
  });

  it('gives a viewer who arrives first the document, not a blank page', async () => {
    const name = room();
    await prepare(name, { state: encoded('read this') });

    const viewer = connect(name, token(name, 'view'));

    await until(() => viewer.text() === 'read this', 'the text');
    viewer.provider.destroy();
  });

  it('keeps a genuinely empty document empty and open', async () => {
    const name = room();
    await prepare(name, { state: encoded('') });

    const client = connect(name, token(name));
    await until(() => client.events.synced > 0, 'a sync');

    assert.equal(client.text(), '');
    assert.equal((await stateOf(name)).hasContent, false);
    client.provider.destroy();
  });

  it('initializes once for simultaneous opens, including their sockets', async () => {
    const name = room();
    // One document: the host hands over the same durable state each time.
    const durable = encoded('only once');
    const results = await Promise.all(Array.from({ length: 12 }, () => prepare(name, { state: durable })));

    assert.equal(results.filter((r) => r.body.outcome === 'restored').length, 1);
    assert.equal(results.filter((r) => r.body.outcome === 'stored').length, 11);

    const clients = Array.from({ length: 6 }, () => connect(name, token(name)));
    await Promise.all(clients.map((c) => until(() => c.text() === 'only once', 'the text')));

    await sleep(200);
    for (const c of clients) {
      assert.equal(c.text(), 'only once', 'exactly one copy');
      c.provider.destroy();
    }
  });
});

describe('the prepare route', () => {
  it('requires the service credential', async () => {
    const name = room();
    const response = await fetch(`${server.http}/internal/rooms/${name}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: encoded('forged') }),
    });

    assert.equal(response.status, 401);
    assert.equal((await stateOf(name)).exists, false);
  });

  it('does not accept the signing key as the credential', async () => {
    const response = await fetch(`${server.http}/internal/rooms/${room()}/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SIGNING_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: encoded('forged') }),
    });

    assert.equal(response.status, 401);
  });

  for (const [what, body] of [
    ['a non-string state', { state: 42 }],
    ['an empty state', { state: '' }],
    ['a non-string file', { docx: {} }],
    ['a non-string fingerprint', { known: 7 }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`rejects ${what}`, async () => {
      assert.equal((await prepare(room(), body)).status, 400);
    });
  }

  it('reports a file it cannot read, and leaves the room as it was', async () => {
    const name = room();
    const result = await prepare(name, { docx: base64(new TextEncoder().encode('not a word document')) });

    assert.equal(result.status, 422);
    assert.equal(result.body.error, 'unusable_document');
    assert.equal((await stateOf(name)).exists, false);
  });

  it('reports a state it cannot read, and leaves the room as it was', async () => {
    const name = room();
    await prepare(name, { state: encoded('real work') });

    const result = await prepare(name, { state: base64(new Uint8Array([255, 255, 255, 255, 9])) });

    assert.equal(result.status, 422);
    assert.equal(textIn((await stateOf(name)).state), 'real work');
  });
});

describe('a room with people in it', () => {
  it('is not overwritten by an older snapshot', async () => {
    const name = room();
    const original = docWith('first');
    await prepare(name, { state: base64(Y.encodeStateAsUpdate(original)) });
    const editor = connect(name, token(name));
    await until(() => editor.text() === 'first', 'the text');

    const paragraph = editor.doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    paragraph.insert(1, [new Y.XmlText(' typed live')]);
    await until(async () => textIn((await stateOf(name)).state).includes('typed live'), 'the edit');

    const result = await prepare(name, { state: base64(Y.encodeStateAsUpdate(original)) });

    assert.equal(result.body.outcome, 'live');
    assert.ok(textIn((await stateOf(name)).state).includes('typed live'));
    assert.ok(editor.text().includes('typed live'));
    editor.provider.destroy();
  });

  it('receives what a restore adds, without reconnecting', async () => {
    const name = room();
    await prepare(name, { state: encoded('') });
    const editor = connect(name, token(name));
    await until(() => editor.events.synced > 0, 'a sync');
    const closesBefore = editor.events.closes.length;

    const result = await prepare(name, { state: encoded('came back') });

    assert.equal(result.body.outcome, 'merged');
    await until(() => editor.text().includes('came back'), 'the restored text');
    assert.equal(editor.events.closes.length, closesBefore);
    editor.provider.destroy();
  });
});

describe('cleanup', () => {
  it('leaves stored state alone when a room is forgotten', async () => {
    const name = room();
    await prepare(name, { state: encoded('still here') });
    const value = token(name);
    const editor = connect(name, value);
    await until(() => editor.text() === 'still here', 'the text');
    editor.provider.destroy();
    await until(async () => (await (await fetch(`${server.http}/api/rooms/${name}/info`, { headers: auth })).status) === 200, 'it to be registered');

    // The collector sweeps every 30 seconds, and this server forgets idle rooms at once.
    await until(async () => (await fetch(`${server.http}/api/rooms/${name}/info`, { headers: auth })).status === 404, 'the room to be forgotten', 40000);

    const state = await stateOf(name);
    assert.equal(state.exists, true, 'what was stored is still stored');
    assert.equal(textIn(state.state), 'still here');

    const again = connect(name, value);
    await until(() => again.text() === 'still here', 'the text, reopened');
    again.provider.destroy();
  });
});

describe('deleting a document', () => {
  const remove = (name: string, headers: Record<string, string> = auth) =>
    fetch(`${server.http}/internal/rooms/${name}`, { method: 'DELETE', headers: { authorization: headers.authorization ?? '' } });

  it('requires the service credential', async () => {
    const name = room();
    await prepare(name, { state: encoded('keep me') });

    assert.equal((await remove(name, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await stateOf(name)).exists, true);
  });

  it('closes open sockets, removes what is stored, and refuses the same token afterwards', async () => {
    const name = room();
    await prepare(name, { state: encoded('confidential') });
    const value = token(name);
    const editor = connect(name, value);
    await until(() => editor.text() === 'confidential', 'the text');

    assert.equal((await remove(name)).status, 200);

    assert.equal((await stateOf(name)).exists, false);
    await until(() => editor.events.refused > 0, 'the open editor to be refused when it reconnects');

    const stale = connect(name, value);
    await until(() => stale.events.refused > 0, 'the stale token to be refused');
    assert.equal(stale.text(), '');
    assert.equal((await stateOf(name)).exists, false, 'and nothing came back');
    editor.provider.destroy();
    stale.provider.destroy();
  });

  it('is not undone by the last edit being saved late', async () => {
    const name = room();
    await prepare(name, { state: encoded('confidential') });
    const editor = connect(name, token(name));
    await until(() => editor.text() === 'confidential', 'the text');

    // Sits in the save debounce when the deletion arrives.
    (editor.doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' more')]);
    await until(async () => textIn((await stateOf(name)).state).includes('more'), 'the edit');
    await remove(name);

    await sleep(900);

    assert.equal((await stateOf(name)).exists, false, 'the debounced save did not bring it back');
    editor.provider.destroy();
  });

  it('cannot be undone by preparing it again', async () => {
    const name = room();
    await prepare(name, { state: encoded('confidential') });
    await remove(name);

    const result = await prepare(name, { state: encoded('confidential') });

    assert.equal(result.status, 410);
    assert.equal((await stateOf(name)).exists, false);
  });

  it('can be repeated', async () => {
    const name = room();
    await prepare(name, { state: encoded('x') });

    assert.equal((await remove(name)).status, 200);
    assert.equal((await remove(name)).status, 200);
  });
});

describe('after a restart, until the host has said what it took back', () => {
  let cold: Server;

  before(async () => {
    cold = await startServer(COLD_PORT);
  });

  after(() => {
    cold?.process.kill();
  });

  it('refuses even a perfectly good token, then admits it once told', async () => {
    const name = room();
    await prepare(name, { state: encoded('held') }, cold);
    const value = token(name);

    const early = connect(name, value, cold);
    await until(() => early.events.refused > 0, 'a refusal while cold');
    assert.equal(early.events.synced, 0);
    early.provider.destroy();

    const revoked = token(name, 'edit', 'taken-back');
    assert.equal((await sync(cold, [{ sid: 'taken-back', exp: inHours(1) }])).status, 200);

    const admitted = connect(name, value, cold);
    await until(() => admitted.text() === 'held', 'the text');
    admitted.provider.destroy();

    const stale = connect(name, revoked, cold);
    await until(() => stale.events.refused > 0, 'the revoked token to be refused');
    assert.equal(stale.events.synced, 0);
    stale.provider.destroy();
  });
});

describe('what collab-server.patch guarded, without it', () => {
  // The smallest thing the seed route accepts: a zip's magic bytes, then anything.
  const zipLike = () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('PK\x03\x04REPLACEMENT_DOCUMENT')]), 'replacement.docx');
    return form;
  };

  it('nobody without the credential can create a room', async () => {
    const response = await fetch(`${server.http}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
  });

  it('the host, holding the credential, can', async () => {
    const response = await fetch(`${server.http}/api/rooms`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(response.status, 200);
    assert.ok(((await response.json()) as { roomId?: string }).roomId);
  });

  for (const [what, method, suffix] of [
    ['read a room\'s details', 'GET', '/info'],
    ['fetch a seed', 'GET', '/seed'],
    ['fetch a snapshot', 'GET', '/snapshot'],
    ['upload a snapshot', 'POST', '/snapshot'],
  ] as Array<[string, string, string]>) {
    it(`nobody without the credential can ${what}`, async () => {
      const response = await fetch(`${server.http}/api/rooms/${room()}${suffix}`, { method });
      assert.equal(response.status, 401);
    });
  }

  it('nobody without the credential can list rooms', async () => {
    assert.equal((await fetch(`${server.http}/api/rooms`)).status, 401);
  });

  it('a seed upload cannot replace a document: refused without the credential', async () => {
    const name = room();
    await prepare(name, { state: encoded('the real document') });
    const before = (await stateOf(name)).fingerprint;

    const response = await fetch(`${server.http}/api/rooms/${name}/seed`, { method: 'POST', body: zipLike() });

    assert.equal(response.status, 401);
    assert.equal((await stateOf(name)).fingerprint, before);
  });

  it('and even with it, an uploaded seed changes nothing anyone opens', async () => {
    const name = room();
    await prepare(name, { state: encoded('the real document') });
    const before = (await stateOf(name)).fingerprint;
    const created = (await (await fetch(`${server.http}/api/rooms`, { method: 'POST', headers: auth, body: '{}' })).json()) as { roomId: string };

    // A room the registry knows, because the seed route needs one.
    await prepare(created.roomId, { state: encoded('the real document') });
    const uploaded = await fetch(`${server.http}/api/rooms/${created.roomId}/seed`, {
      method: 'POST',
      headers: { authorization: auth.authorization },
      body: zipLike(),
    });
    assert.equal(uploaded.status, 200);

    const client = connect(created.roomId, token(created.roomId));
    await until(() => client.text() === 'the real document', 'the document');
    await sleep(200);
    assert.equal(client.text(), 'the real document');
    assert.equal((await stateOf(name)).fingerprint, before);
  });

  it('a host cannot replace content by handing over a file either', async () => {
    const name = room();
    await prepare(name, { state: encoded('work someone did') });
    const before = (await stateOf(name)).fingerprint;

    const result = await prepare(name, { docx: base64(new Uint8Array([80, 75, 3, 4])) });

    assert.equal(result.body.outcome, 'stored', 'the file was not even looked at');
    assert.equal((await stateOf(name)).fingerprint, before);
  });

  it('claim-init is gone: a browser cannot win the right to fill a room', async () => {
    const response = await fetch(`${server.http}/api/rooms/${room()}/claim-init`, { method: 'POST' });
    assert.equal(response.status, 401);
  });
});

describe('races too narrow to hit from outside', () => {
  /** The real wiring, in this process, over a storage these tests can misdirect. */
  async function harness(storage: InMemoryStorage) {
    const http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const ledger = new SessionLedger();
    ledger.revoke([]);
    const attached = attachHocuspocus(http, new RoomRegistry(), storage, '/yjs', {
      editorSessions: { secret: SIGNING_SECRET, ledger },
    });
    const port = (http.address() as AddressInfo).port;
    const target = { ws: `ws://127.0.0.1:${port}/yjs` } as Server;
    return {
      attached,
      target,
      close: async () => {
        await attached.close();
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
      },
    };
  }

  it('refuses a room whose state runs out between the check and the load, and creates nothing', async () => {
    class Vanishing extends InMemoryStorage {
      override async has() { return true; }
      override async load() { return null; }
    }
    const storage = new Vanishing();
    let saves = 0;
    const save = storage.save.bind(storage);
    storage.save = async (name, update) => { saves++; await save(name, update); };
    const { target, close } = await harness(storage);

    const name = room();
    const client = connect(name, token(name), target);
    await until(() => client.events.refused > 0, 'a refusal');
    await sleep(700);

    assert.equal(client.events.synced, 0, 'no document was handed over');
    assert.equal(saves, 0, 'and none was stored');
    client.provider.destroy();
    await close();
  });

  it('a barrier stores what was accepted before it answers, rather than leaving it to the debounce', async () => {
    const storage = new InMemoryStorage();
    const { attached, target, close } = await harness(storage);
    const name = room();
    await attached.keeper.prepare(name, { state: Y.encodeStateAsUpdate(docWith('')) });
    const client = connect(name, token(name), target);
    await until(() => client.events.synced > 0, 'a sync');
    const paragraph = client.doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText('JUST_ACCEPTED')]);
    await until(() => !client.provider.hasUnsyncedChanges, 'the acknowledgement');

    const report = await attached.pauseWrites();

    assert.equal(report.flushed, 1);
    assert.equal(report.flushFailed, 0);
    assert.ok(textIn(Buffer.from((await storage.load(name))!).toString('base64')).includes('JUST_ACCEPTED'), 'stored by the time it answered');
    client.provider.destroy();
    await close();
  });

  it('a barrier says so if it could not store an open room', async () => {
    const storage = new InMemoryStorage();
    const { attached, target, close } = await harness(storage);
    const name = room();
    await attached.keeper.prepare(name, { state: Y.encodeStateAsUpdate(docWith('')) });
    const client = connect(name, token(name), target);
    await until(() => client.events.synced > 0, 'a sync');
    storage.save = async () => { throw new Error('connection refused'); };

    const report = await attached.pauseWrites();

    assert.equal(report.flushed, 0);
    assert.equal(report.flushFailed, 1);
    client.provider.destroy();
    await close();
  });

  it('ignores a save that arrives after the document was deleted, whichever route it takes', async () => {
    const storage = new InMemoryStorage();
    const { attached, close } = await harness(storage);
    const name = room();
    const doc = docWith('deleted');
    await attached.keeper.remove(name);

    const hooks = attached.hocuspocus as unknown as { hooks: (hook: string, payload: unknown) => Promise<unknown> };
    await hooks.hooks('onChange', { documentName: name, document: doc });
    await sleep(700);
    assert.equal(await storage.has(name), false, 'a debounced save');

    await hooks.hooks('onDisconnect', { documentName: name, document: doc, clientsCount: 0, socketId: 'late' });
    await sleep(50);
    assert.equal(await storage.has(name), false, 'the save when the last person leaves');

    await close();
  });
});

describe('expiry of what is stored', () => {
  it('tells the storage only when the caller holds the same bytes', async () => {
    const name = room();
    const state = await prepare(name, { state: encoded('x') });
    const fingerprint = state.body.fingerprint as string;

    assert.equal((await stateOf(name, 'not-the-fingerprint')).unchanged, false);
    assert.equal((await stateOf(name, fingerprint)).unchanged, true);
  });
});

describe('a change that only deletes, over the real route', () => {
  function beforeAndAfter() {
    const doc = docWith('KEEP REMOVE');
    const before = base64(Y.encodeStateAsUpdate(doc));
    ((doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(5, 6);

    return { before, after: base64(Y.encodeStateAsUpdate(doc)) };
  }

  it('reaches a stored room behind on it', async () => {
    const name = room();
    const { before, after } = beforeAndAfter();
    await prepare(name, { state: before });

    const merged = await prepare(name, { state: after });

    assert.equal(merged.body.outcome, 'merged');
    assert.equal(textIn((await stateOf(name)).state), 'KEEP ');
  });

  it('reaches an open room behind on it, and whoever is in it', async () => {
    const name = room();
    const { before, after } = beforeAndAfter();
    await prepare(name, { state: before });
    const client = connect(name, token(name));
    await until(() => client.events.synced > 0, 'a sync');
    assert.equal(client.text(), 'KEEP REMOVE');

    const merged = await prepare(name, { state: after });

    assert.equal(merged.body.outcome, 'merged');
    await until(() => client.text() === 'KEEP ', 'the deletion to arrive');
    assert.equal(textIn((await stateOf(name)).state), 'KEEP ');
  });

  it('is not undone in a stored room by an older state', async () => {
    const name = room();
    const { before, after } = beforeAndAfter();
    await prepare(name, { state: after });

    const merged = await prepare(name, { state: before });

    assert.equal(merged.body.outcome, 'stored');
    assert.equal(textIn((await stateOf(name)).state), 'KEEP ');
  });

  it('is not undone in an open room by an older state', async () => {
    const name = room();
    const { before, after } = beforeAndAfter();
    await prepare(name, { state: after });
    const client = connect(name, token(name));
    await until(() => client.events.synced > 0, 'a sync');

    const merged = await prepare(name, { state: before });

    assert.equal(merged.body.outcome, 'live');
    await sleep(150);
    assert.equal(client.text(), 'KEEP ');
  });
});

describe('a write barrier, over the real socket', () => {
  // Its own server: a barrier applies to every room in the process.
  const BARRIER_PORT = 3915;
  let barred: Server;

  before(async () => {
    barred = await startServer(BARRIER_PORT);
    await sync(barred);
  });

  after(() => {
    barred?.process.kill();
  });

  afterEach(async () => {
    await setBarrier(false);
  });

  async function setBarrier(active: boolean) {
    const response = await fetch(`${barred.http}/internal/write-barrier`, { method: 'POST', headers: auth, body: JSON.stringify({ active }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const barrierNow = async () => (await (await fetch(`${barred.http}/internal/write-barrier`, { headers: auth })).json()) as Record<string, unknown>;

  /** A connected client writing one paragraph's worth, and whether it was acknowledged. */
  function type(client: ReturnType<typeof connect>, text: string) {
    const paragraph = client.doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    let node = paragraph.get(0) as Y.XmlText | undefined;
    if (!node) {
      node = new Y.XmlText();
      paragraph.insert(0, [node]);
    }
    node.insert(node.length, text);
  }

  it('needs the service credential', async () => {
    assert.equal((await fetch(`${barred.http}/internal/write-barrier`)).status, 401);
    assert.equal((await fetch(`${barred.http}/internal/write-barrier`, { method: 'POST', body: '{"active":true}', headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await barrierNow()).active, false, 'and nothing happened');
  });

  it('refuses anything but a clear instruction', async () => {
    assert.equal((await setBarrierBody({})).status, 400);
    assert.equal((await barrierNow()).active, false);

    function setBarrierBody(body: unknown) {
      return fetch(`${barred.http}/internal/write-barrier`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    }
  });

  it('stops a socket that is already connected, and tells it', async () => {
    const name = room();
    await prepare(name, { state: encoded('') }, barred);
    const client = connect(name, token(name), barred);
    await until(() => client.events.synced > 0, 'a sync');
    type(client, 'ACCEPTED');
    await until(() => !client.provider.hasUnsyncedChanges, 'the acknowledgement');

    const engaged = await setBarrier(true);
    assert.equal(engaged.body.active, true);
    const before = (await stateOf(name, undefined, barred)).fingerprint;

    type(client, 'REFUSED');
    await sleep(250);

    assert.equal(client.provider.hasUnsyncedChanges, true, 'it knows this has not been accepted');
    assert.equal((await stateOf(name, undefined, barred)).fingerprint, before);
    assert.equal(textIn((await stateOf(name, undefined, barred)).state), 'ACCEPTED');
  });

  it('stops a new session too, whatever its token says, and lets it read', async () => {
    const name = room();
    await prepare(name, { state: encoded('THE DOCUMENT') }, barred);
    await setBarrier(true);
    const before = (await stateOf(name, undefined, barred)).fingerprint;

    const client = connect(name, token(name, 'edit'), barred);
    await until(() => client.events.synced > 0, 'a sync');
    assert.equal(client.text(), 'THE DOCUMENT');
    type(client, ' FORGED');
    await sleep(250);

    assert.equal((await stateOf(name, undefined, barred)).fingerprint, before);
  });

  it('stores what was accepted before it, before it answers', async () => {
    const name = room();
    await prepare(name, { state: encoded('') }, barred);
    const client = connect(name, token(name), barred);
    await until(() => client.events.synced > 0, 'a sync');
    type(client, 'JUST_ACCEPTED');
    await until(() => !client.provider.hasUnsyncedChanges, 'the acknowledgement');

    const engaged = await setBarrier(true);

    assert.ok((engaged.body.flushed as number) >= 1, 'open rooms were stored');
    assert.equal(engaged.body.flushFailed, 0);
  });

  it('keeps one barrier when asked again', async () => {
    const first = await setBarrier(true);
    const second = await setBarrier(true);

    assert.equal(second.body.id, first.body.id);
    assert.equal((await barrierNow()).id, first.body.id);
  });

  it('leaves the routes a host saves with available', async () => {
    const name = room();
    await prepare(name, { state: encoded('SAVED') }, barred);
    await setBarrier(true);

    assert.equal(textIn((await stateOf(name, undefined, barred)).state), 'SAVED');
    assert.equal((await prepare(name, { state: encoded('MERGED FROM THE HOST') }, barred)).status, 200);
  });

  it('refuses to start a room from a file', async () => {
    await setBarrier(true);

    const prepared = await prepare(room(), { docx: base64(new Uint8Array([1, 2, 3])) }, barred);

    assert.equal(prepared.status, 503);
    assert.equal(prepared.body.error, 'writes_paused');
  });

  it('when it ends, what was refused goes through, because everyone reconnects', async () => {
    const name = room();
    await prepare(name, { state: encoded('') }, barred);
    const client = connect(name, token(name), barred);
    await until(() => client.events.synced > 0, 'a sync');
    await setBarrier(true);
    type(client, 'TYPED_BEHIND_IT');
    await sleep(250);

    await setBarrier(false);

    await until(() => !client.provider.hasUnsyncedChanges, 'the refused edit to go through');
    await until(async () => textIn((await stateOf(name, undefined, barred)).state) === 'TYPED_BEHIND_IT', 'it to reach the room');
    assert.equal((await barrierNow()).active, false);
  });

  it('a viewer goes back to being a viewer afterwards', async () => {
    const name = room();
    await prepare(name, { state: encoded('READ ME') }, barred);
    await setBarrier(true);
    await setBarrier(false);
    const before = (await stateOf(name, undefined, barred)).fingerprint;

    const viewer = connect(name, token(name, 'view'), barred);
    await until(() => viewer.events.synced > 0, 'a sync');
    type(viewer, ' FORGED');
    await sleep(250);

    assert.equal((await stateOf(name, undefined, barred)).fingerprint, before);
  });
});
