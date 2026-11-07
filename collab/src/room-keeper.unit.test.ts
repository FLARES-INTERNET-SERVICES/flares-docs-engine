/**
 * What a room may be filled with, and what must never happen to what it holds.
 *
 *   node --import tsx --test src/room-keeper.unit.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { InMemoryStorage, RedisStorage, type DocStorage } from './storage.js';
import { RoomDeleted, RoomKeeper, RoomStorageUnavailable, RoomWritesPaused } from './room-keeper.js';

/** A document as the editor's sync plugin would encode it. */
function docWith(...paragraphs: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prosemirror');

  for (const text of paragraphs) {
    const paragraph = new Y.XmlElement('paragraph');
    if (text !== '') paragraph.insert(0, [new Y.XmlText(text)]);
    fragment.push([paragraph]);
  }

  return doc;
}

const encode = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);

function textOf(update: Uint8Array | Y.Doc): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update instanceof Y.Doc ? encode(update) : update);
  const paragraphs = doc.getXmlFragment('prosemirror').toArray() as Y.XmlElement[];
  const text = paragraphs
    .map((p) => (p.toArray() as Y.XmlText[]).map((t) => t.toString()).join(''))
    .filter((t) => t !== '');
  doc.destroy();
  return text.sort().join('|');
}

const decoded = (state: string | undefined) => new Uint8Array(Buffer.from(state ?? '', 'base64'));

/** Counts what actually reaches the store. */
class CountingStorage extends InMemoryStorage {
  saves = 0;
  deletes = 0;

  override async save(room: string, update: Uint8Array) {
    this.saves++;
    await super.save(room, update);
  }

  override async delete(room: string) {
    this.deletes++;
    await super.delete(room);
  }
}

function keeperOver(storage: DocStorage, live = new Map<string, Y.Doc>(), now?: () => number) {
  const unloaded: string[] = [];
  const keeper = new RoomKeeper(
    storage,
    async (room) => live.get(room),
    async (room) => {
      unloaded.push(room);
      live.delete(room);
    },
    { storageTimeoutMs: 80, now },
  );

  return { keeper, live, unloaded };
}

describe('a room with nothing stored', () => {
  it('stays missing when handed nothing, and creates nothing', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);

    const result = await keeper.prepare('r', {});

    assert.equal(result.outcome, 'missing');
    assert.equal(result.exists, false);
    assert.equal(storage.saves, 0);
    assert.equal(await storage.has('r'), false);
  });

  it('is restored from the durable state, byte for byte', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const durable = encode(docWith('the essay'));

    const result = await keeper.prepare('r', { state: durable });

    assert.equal(result.outcome, 'restored');
    assert.deepEqual(await storage.load('r'), durable);
  });

  it('is seeded from a file only when there is no durable state', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    let conversions = 0;
    const seed = async () => { conversions++; return encode(docWith('from the file')); };

    const result = await keeper.prepare('r', { seed });

    assert.equal(result.outcome, 'seeded');
    assert.equal(conversions, 1);
    assert.equal(textOf((await storage.load('r'))!), 'from the file');
  });

  it('prefers the durable state to the file', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);

    const result = await keeper.prepare('r', {
      state: encode(docWith('newer, from the durable state')),
      seed: async () => encode(docWith('older, from the file')),
    });

    assert.equal(result.outcome, 'restored');
    assert.equal(textOf((await storage.load('r'))!), 'newer, from the durable state');
  });

  it('is initialized once, however many ask at the same moment', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    let conversions = 0;

    const results = await Promise.all(Array.from({ length: 25 }, () => keeper.prepare('r', {
      seed: async () => {
        conversions++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return encode(docWith('one copy of this'));
      },
    })));

    assert.equal(conversions, 1, 'the file was converted once');
    assert.equal(storage.saves, 1, 'the room was written once');
    assert.equal(results.filter((r) => r.outcome === 'seeded').length, 1);
    assert.equal(results.filter((r) => r.outcome === 'stored').length, 24);
    assert.equal(textOf((await storage.load('r'))!), 'one copy of this');
  });

  it('is initialized once from a blank file too, without gathering empty paragraphs', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);

    await Promise.all(Array.from({ length: 10 }, () => keeper.prepare('r', {
      seed: async () => encode(docWith('')),
    })));

    assert.equal(storage.saves, 1);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await storage.load('r'))!);
    assert.equal(doc.getXmlFragment('prosemirror').length, 1, 'one empty paragraph');
  });

  it('runs rooms independently of one another', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const slow = keeper.prepare('slow', { seed: async () => { await held; return encode(docWith('slow')); } });
    const quick = await keeper.prepare('quick', { state: encode(docWith('quick')) });

    assert.equal(quick.outcome, 'restored');
    release();
    assert.equal((await slow).outcome, 'seeded');
  });
});

describe('a room that already holds something', () => {
  it('is not touched by a durable state it already covers', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    const doc = docWith('first');
    const older = encode(doc);
    (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' and more')]);
    const newer = encode(doc);
    await storage.save('r', newer);
    storage.saves = 0;

    const result = await keeper.prepare('r', { state: older });

    assert.equal(result.outcome, 'stored');
    assert.equal(storage.saves, 0, 'nothing was written');
    assert.deepEqual(await storage.load('r'), newer);
  });

  it('keeps text typed since the snapshot, when open, and sends nobody anything', async () => {
    const storage = new InMemoryStorage();
    const { keeper, live } = keeperOver(storage);
    const doc = docWith('first');
    const older = encode(doc);
    (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' typed just now')]);
    live.set('r', doc);
    let updates = 0;
    doc.on('update', () => { updates++; });

    const result = await keeper.prepare('r', { state: older });

    assert.equal(result.outcome, 'live');
    assert.equal(updates, 0);
    assert.ok(textOf(doc).includes('typed just now'), 'what was typed is still there');
  });

  it('does not bring back text someone deleted', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const doc = docWith('delete me');
    const beforeDeleting = encode(doc);
    doc.getXmlFragment('prosemirror').delete(0, 1);
    await storage.save('r', encode(doc));

    await keeper.prepare('r', { state: beforeDeleting });

    assert.equal(textOf((await storage.load('r'))!), '', 'the deletion survived an older snapshot');
  });

  it('catches up when the store has fallen behind the durable state', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const doc = docWith('first');
    await storage.save('r', encode(doc));
    (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' durable')]);

    const result = await keeper.prepare('r', { state: encode(doc) });

    assert.equal(result.outcome, 'merged');
    assert.ok(textOf((await storage.load('r'))!).includes('durable'));
  });

  it('gives the people connected what was missing, without a reconnect', async () => {
    const storage = new InMemoryStorage();
    const { keeper, live } = keeperOver(storage);
    const replacement = docWith('');
    live.set('r', replacement);
    let updates = 0;
    replacement.on('update', () => { updates++; });

    const result = await keeper.prepare('r', { state: encode(docWith('the real document')) });

    assert.equal(result.outcome, 'merged');
    assert.equal(updates, 1);
    assert.equal(textOf(replacement), 'the real document');
  });

  it('never drops either side when two histories have diverged', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('in the room')));

    const result = await keeper.prepare('r', { state: encode(docWith('in the durable state')) });

    assert.equal(result.outcome, 'merged');
    assert.equal(textOf((await storage.load('r'))!), 'in the durable state|in the room');
  });

  it('does not use the file if the room holds content', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('real work')));
    storage.saves = 0;
    let conversions = 0;

    const result = await keeper.prepare('r', {
      seed: async () => { conversions++; return encode(docWith('an old file')); },
    });

    assert.equal(result.outcome, 'stored');
    assert.equal(conversions, 0);
    assert.equal(storage.saves, 0);
  });

  it('does not use the file over content in an open room either', async () => {
    const storage = new InMemoryStorage();
    const { keeper, live } = keeperOver(storage);
    live.set('r', docWith('real work, open'));
    let conversions = 0;

    const result = await keeper.prepare('r', {
      seed: async () => { conversions++; return encode(docWith('an old file')); },
    });

    assert.equal(result.outcome, 'live');
    assert.equal(conversions, 0);
    assert.equal(textOf(live.get('r')!), 'real work, open');
  });

  it('fills a room left empty when someone chooses the file', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('')));

    const result = await keeper.prepare('r', { seed: async () => encode(docWith('from the file')) });

    assert.equal(result.outcome, 'seeded');
    assert.equal(textOf((await storage.load('r'))!), 'from the file');
  });

  it('leaves an empty room as it is when the chosen file is blank as well', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('')));
    storage.saves = 0;

    const result = await keeper.prepare('r', { seed: async () => encode(docWith('')) });

    assert.equal(result.outcome, 'stored');
    assert.equal(storage.saves, 0);
  });

  it('preserves a genuinely empty document as empty', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const empty = encode(docWith(''));

    const result = await keeper.prepare('r', { state: empty });

    assert.equal(result.outcome, 'restored');
    assert.equal(result.exists && !result.unchanged && result.hasContent, false);
    assert.deepEqual(await storage.load('r'), empty);
  });

  it('answers without the bytes when the host already has them', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const durable = encode(docWith('held'));
    const first = await keeper.prepare('r', { state: durable });
    assert.ok(first.exists && !first.unchanged);
    assert.equal(textOf(decoded(first.state)), 'held');

    const second = await keeper.prepare('r', { state: durable, known: first.fingerprint });

    assert.ok(second.exists && second.unchanged);
  });
});

describe('a change that only deletes', () => {
  /** The same document, before and after deleting part of it. No new structs, so one vector. */
  function beforeAndAfterDeleting() {
    const doc = docWith('KEEP REMOVE');
    const before = encode(doc);
    const text = (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(5, 6);
    const after = encode(doc);

    return { doc, before, after };
  }

  const vectorOf = (update: Uint8Array) => Buffer.from(Y.encodeStateVectorFromUpdate(update));

  it('really does not move the state vector, which is why it cannot be the test', () => {
    const { before, after } = beforeAndAfterDeleting();

    assert.deepEqual(vectorOf(before), vectorOf(after));
    assert.notDeepEqual(Buffer.from(before), Buffer.from(after));
  });

  it('reaches a stored room that is behind on it', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const { before, after } = beforeAndAfterDeleting();
    await storage.save('r', before);

    const result = await keeper.prepare('r', { state: after });

    assert.equal(result.outcome, 'merged');
    assert.equal(textOf((await storage.load('r'))!), 'KEEP ');
  });

  it('reaches an open room that is behind on it, and the people connected to it', async () => {
    const { keeper, live } = keeperOver(new InMemoryStorage());
    const { before, after } = beforeAndAfterDeleting();
    const room = new Y.Doc();
    Y.applyUpdate(room, before);
    live.set('r', room);
    let updates = 0;
    room.on('update', () => { updates++; });

    const result = await keeper.prepare('r', { state: after });

    assert.equal(result.outcome, 'merged');
    assert.equal(updates, 1);
    assert.equal(textOf(room), 'KEEP ');
  });

  it('is not undone in a stored room by an older durable state', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    const { before, after } = beforeAndAfterDeleting();
    await storage.save('r', after);
    storage.saves = 0;

    const result = await keeper.prepare('r', { state: before });

    assert.equal(result.outcome, 'stored');
    assert.equal(storage.saves, 0);
    assert.equal(textOf((await storage.load('r'))!), 'KEEP ');
  });

  it('is not undone in an open room by an older durable state', async () => {
    const { keeper, live } = keeperOver(new InMemoryStorage());
    const { doc, before } = beforeAndAfterDeleting();
    live.set('r', doc);
    let updates = 0;
    doc.on('update', () => { updates++; });

    const result = await keeper.prepare('r', { state: before });

    assert.equal(result.outcome, 'live');
    assert.equal(updates, 0);
    assert.equal(textOf(doc), 'KEEP ');
  });

  it('merges with text typed on the other side, in either direction', async () => {
    const { before, after } = beforeAndAfterDeleting();
    const typed = new Y.Doc();
    Y.applyUpdate(typed, before);
    ((typed.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'NEW ');
    const withTyping = encode(typed);

    for (const [stored, durable] of [[after, withTyping], [withTyping, after]] as const) {
      const storage = new InMemoryStorage();
      const { keeper } = keeperOver(storage);
      await storage.save('r', stored);

      const result = await keeper.prepare('r', { state: durable });

      assert.equal(result.outcome, 'merged');
      assert.equal(textOf((await storage.load('r'))!), 'NEW KEEP ');
    }
  });

  it('keeps two different deletions when each side has one the other lacks', async () => {
    const start = docWith('ONE TWO THREE');
    const textIn = (doc: Y.Doc) => (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, encode(start));
    Y.applyUpdate(right, encode(start));
    textIn(left).delete(0, 4);
    textIn(right).delete(8, 5);
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(left));

    const result = await keeper.prepare('r', { state: encode(right) });

    assert.equal(result.outcome, 'merged');
    assert.equal(textOf((await storage.load('r'))!), 'TWO ');
  });

  it('settles: asking again with what came back changes nothing', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    const { before, after } = beforeAndAfterDeleting();
    await storage.save('r', before);
    await keeper.prepare('r', { state: after });
    const settled = (await storage.load('r'))!;
    storage.saves = 0;

    const result = await keeper.prepare('r', { state: settled });

    assert.equal(result.outcome, 'stored');
    assert.equal(storage.saves, 0);
  });
});

describe('when something fails', () => {
  it('leaves the room alone if the file will not convert', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);

    await assert.rejects(keeper.prepare('r', { seed: async () => { throw new Error('not a docx'); } }), /not a docx/);

    assert.equal(storage.saves, 0);
    assert.equal(await storage.has('r'), false);
  });

  it('leaves the room alone if the state will not decode', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('real work')));
    const before = await storage.load('r');
    storage.saves = 0;

    await assert.rejects(keeper.prepare('r', { state: new Uint8Array([255, 255, 255, 255, 1, 2, 3]) }));

    assert.equal(storage.saves, 0);
    assert.deepEqual(await storage.load('r'), before);
  });

  it('carries on after a failure: one bad request does not wedge the room', async () => {
    const { keeper } = keeperOver(new InMemoryStorage());

    await assert.rejects(keeper.prepare('r', { seed: async () => { throw new Error('nope'); } }));
    const result = await keeper.prepare('r', { state: encode(docWith('fine')) });

    assert.equal(result.outcome, 'restored');
  });

  it('says the store is unavailable rather than that the room is empty', async () => {
    const hung: DocStorage = {
      load: () => new Promise(() => undefined),
      has: () => new Promise(() => undefined),
      save: () => new Promise(() => undefined),
      delete: () => new Promise(() => undefined),
      confirmDurable: () => new Promise(() => undefined),
      loadBarrier: () => new Promise(() => undefined),
      saveBarrier: () => new Promise(() => undefined),
      close: async () => undefined,
    };
    const { keeper } = keeperOver(hung);

    await assert.rejects(keeper.prepare('r', { state: encode(docWith('x')) }), RoomStorageUnavailable);
    await assert.rejects(keeper.hasState('r'), RoomStorageUnavailable);
    await assert.rejects(keeper.read('r'), RoomStorageUnavailable);
    await assert.rejects(keeper.remove('r'), RoomStorageUnavailable);
  });

  it('says so for a store that errors, too', async () => {
    const broken = new InMemoryStorage();
    broken.has = async () => { throw new Error('connection reset'); };
    const { keeper } = keeperOver(broken);

    await assert.rejects(keeper.hasState('r'), RoomStorageUnavailable);
  });

  it('can still answer for an open room while the store is away', async () => {
    const hung = new InMemoryStorage();
    hung.has = () => new Promise(() => undefined);
    const { keeper, live } = keeperOver(hung);
    live.set('r', docWith('open'));

    assert.equal(await keeper.hasState('r'), true);
    assert.equal(textOf((await keeper.read('r'))!), 'open');
  });
});

describe('deleting a room', () => {
  it('closes it and removes what is stored', async () => {
    const storage = new CountingStorage();
    const { keeper, live, unloaded } = keeperOver(storage);
    await storage.save('r', encode(docWith('secret')));
    live.set('r', docWith('secret'));

    await keeper.remove('r');

    assert.deepEqual(unloaded, ['r']);
    assert.equal(await storage.has('r'), false);
    assert.equal(keeper.isDeleted('r'), true);
  });

  it('cannot be undone by preparing it again', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await keeper.remove('r');

    await assert.rejects(keeper.prepare('r', { state: encode(docWith('back from the dead')) }), RoomDeleted);

    assert.equal(await storage.has('r'), false);
  });

  it('can be repeated', async () => {
    const { keeper } = keeperOver(new InMemoryStorage());

    await keeper.remove('r');
    await keeper.remove('r');

    assert.equal(keeper.isDeleted('r'), true);
  });

  it('waits its turn behind a prepare already running', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const preparing = keeper.prepare('r', { seed: async () => { await held; return encode(docWith('late')); } });
    const removing = keeper.remove('r');
    release();
    await preparing.catch(() => undefined);
    await removing;

    assert.equal(await storage.has('r'), false, 'nothing was left behind by the prepare');
  });

  it('forgets about the deletion eventually, when no token could still be valid', async () => {
    let clock = 0;
    const { keeper } = keeperOver(new InMemoryStorage(), new Map(), () => clock);
    await keeper.remove('r');

    clock = 3 * 60 * 60 * 1000;

    assert.equal(keeper.isDeleted('r'), false);
  });

  it('does not affect another room', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('other', encode(docWith('kept')));

    await keeper.remove('r');

    assert.equal(keeper.isDeleted('other'), false);
    assert.equal(await storage.has('other'), true);
  });
});

describe('a write barrier', () => {
  it('stops a file starting a room, and says why', async () => {
    const storage = new CountingStorage();
    const { keeper } = keeperOver(storage);
    await keeper.pauseWrites();

    await assert.rejects(keeper.prepare('r', { seed: async () => encode(docWith('a new start')) }), RoomWritesPaused);

    assert.equal(storage.saves, 0);
  });

  it('still lets the host restore and merge what is already saved', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await keeper.pauseWrites();

    const result = await keeper.prepare('r', { state: encode(docWith('saved already')) });

    assert.equal(result.outcome, 'restored');
  });

  it('does not refuse a file nobody needed', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await storage.save('r', encode(docWith('real work')));
    await keeper.pauseWrites();

    const result = await keeper.prepare('r', { seed: async () => encode(docWith('never read')) });

    assert.equal(result.outcome, 'stored');
  });

  it('takes effect before anything has been written down', async () => {
    const hung = new InMemoryStorage();
    hung.saveBarrier = () => new Promise(() => undefined);
    const { keeper } = keeperOver(hung);

    await assert.rejects(keeper.pauseWrites(), RoomStorageUnavailable);

    assert.equal(keeper.writesPaused, true, 'refusing writes is what fails safe');
  });

  it('keeps one id when repeated, so a host can tell it held throughout', async () => {
    const { keeper } = keeperOver(new InMemoryStorage());

    const first = await keeper.pauseWrites();
    const second = await keeper.pauseWrites();

    assert.equal(second.id, first.id);
  });

  it('can be asked for again while the store is away', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    const first = await keeper.pauseWrites();
    storage.saveBarrier = () => new Promise(() => undefined);

    assert.equal((await keeper.pauseWrites()).id, first.id);
  });

  it('survives a restart, with the same id', async () => {
    const storage = new InMemoryStorage();
    const before = keeperOver(storage);
    const barrier = await before.keeper.pauseWrites();

    const after = keeperOver(storage);
    await after.keeper.restoreBarrier();

    assert.equal(after.keeper.writesPaused, true);
    assert.equal(after.keeper.writeBarrier?.id, barrier.id);
  });

  it('refuses writes after a restart until the store has said otherwise', async () => {
    const storage = new InMemoryStorage();
    let answer!: (value: string | null) => void;
    storage.loadBarrier = () => new Promise((resolve) => { answer = resolve; });
    const { keeper } = keeperOver(storage);

    const restoring = keeper.restoreBarrier();
    assert.equal(keeper.writesPaused, true, 'not known yet');

    answer(null);
    await restoring;
    assert.equal(keeper.writesPaused, false, 'there is none');
  });

  it('keeps refusing while the store is away after a restart, and keeps asking', async () => {
    const storage = new InMemoryStorage();
    storage.loadBarrier = async () => { throw new Error('connection refused'); };
    const { keeper } = keeperOver(storage);

    await keeper.restoreBarrier();
    keeper.stopRestoringBarrier();

    assert.equal(keeper.writesPaused, true);
  });

  it('ends only once the store has agreed', async () => {
    const storage = new InMemoryStorage();
    const { keeper } = keeperOver(storage);
    await keeper.pauseWrites();
    storage.saveBarrier = async () => { throw new Error('connection refused'); };

    await assert.rejects(keeper.resumeWrites(), RoomStorageUnavailable);

    assert.equal(keeper.writesPaused, true);
  });

  it('does not outlive being ended, across a restart', async () => {
    const storage = new InMemoryStorage();
    const before = keeperOver(storage);
    await before.keeper.pauseWrites();
    await before.keeper.resumeWrites();

    const after = keeperOver(storage);
    await after.keeper.restoreBarrier();

    assert.equal(after.keeper.writesPaused, false);
  });
});

describe('how long Redis keeps a room', () => {
  class FakeRedis {
    calls: unknown[][] = [];
    async set(...args: unknown[]) { this.calls.push(['set', ...args]); }
    async expire(...args: unknown[]) { this.calls.push(['expire', ...args]); }
  }

  it('expires on a timer by default, as before', async () => {
    const redis = new FakeRedis();

    await new RedisStorage(redis as never, 100).save('r', new Uint8Array([1]));

    assert.deepEqual(redis.calls[0]!.slice(2), [Buffer.from([1]), 'EX', 100]);
  });

  it('does not expire work a host has not read yet', async () => {
    const redis = new FakeRedis();

    await new RedisStorage(redis as never, 100, true).save('r', new Uint8Array([1]));

    assert.deepEqual(redis.calls[0]!.slice(2), [Buffer.from([1])], 'a plain SET, which also clears any earlier expiry');
  });

  it('starts the clock when the host shows it has a copy', async () => {
    const redis = new FakeRedis();

    await new RedisStorage(redis as never, 100, true).confirmDurable('r');

    assert.equal(redis.calls[0]![0], 'expire');
    assert.equal(redis.calls[0]![2], 100);
  });
});
