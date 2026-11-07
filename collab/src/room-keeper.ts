import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { DocStorage } from './storage.js';
import { reportRoomState, roomStateHoldsContent, type RoomStateReport } from './room-state.js';

/**
 * Who may bring a room's stored state into being, and who may remove it.
 *
 * With a host in charge, a room never starts out empty. The host owns the durable
 * copy of each document and hands it over here before anyone connects, so a socket
 * reaching a room with nothing stored means something has gone wrong, and is refused.
 * That one rule is what stops a lost document silently reopening as a blank page that
 * then looks like the current version.
 *
 * Stored state is removed only when the host says the document has been deleted.
 * Idle cleanup, capacity eviction and restarts forget about a room in memory. None
 * of them touch what is stored.
 */

/** The store did not answer in time. Not the same as it holding nothing. */
export class RoomStorageUnavailable extends Error {
  constructor(cause?: unknown) {
    super(`room storage unavailable${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'RoomStorageUnavailable';
  }
}

/** The host deleted this document. A room is never brought back from that. */
export class RoomDeleted extends Error {
  constructor(room: string) {
    super(`room ${room} was deleted`);
    this.name = 'RoomDeleted';
  }
}

/** Writes are paused, and this would have started a room with something new in it. */
export class RoomWritesPaused extends Error {
  constructor(room: string) {
    super(`room ${room} cannot be filled while writes are paused`);
    this.name = 'RoomWritesPaused';
  }
}

export type WriteBarrier = { id: string; since: number };

export type RoomOutcome =
  /** Open right now, and already held everything it was handed. */
  | 'live'
  /** Stored, and already held everything it was handed. */
  | 'stored'
  /** Nothing was stored, and now the host's durable state is. */
  | 'restored'
  /** The room held something, and did not cover what it was handed. Merged, never replaced. */
  | 'merged'
  /** Nothing to go on but a file, which has become the room's first state. */
  | 'seeded'
  /** Nothing is stored, and nothing was handed over. */
  | 'missing';

export type RoomPreparation = RoomStateReport & { outcome: RoomOutcome };

export type PrepareRequest = {
  /** The host's durable state. */
  state?: Uint8Array;
  /** Convert a file to a first state. Only called if the room holds no content. */
  seed?: () => Promise<Uint8Array>;
  /** The fingerprint the host already holds, so the bytes need not come back. */
  known?: string;
};

export type RoomKeeperOptions = {
  /** How long a store that has stopped answering holds a request up. */
  storageTimeoutMs?: number;
  now?: () => number;
};

/** Writes stay refused while it is not yet known whether a barrier is in place. */
const UNCONFIRMED = 'unconfirmed';

/** Long enough for any token issued before the deletion to have run out. */
const REMEMBER_DELETED_MS = 2 * 60 * 60 * 1000;

/** How long a store that is away is left before asking it again for a barrier. */
const BARRIER_RETRY_MS = 2000;

function covers(doc: Y.Doc, update: Uint8Array): boolean {
  // Applying to a copy answers "would this add anything?" without firing anything
  // at the people connected to the real one. The whole encoded state is compared, and
  // not the state vector: deleting text adds no new structs, so it moves the vector not
  // at all, and a state differing only by a deletion would look already covered.
  const copy = new Y.Doc();

  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const before = Buffer.from(Y.encodeStateAsUpdate(copy));
    Y.applyUpdate(copy, update);

    return before.equals(Buffer.from(Y.encodeStateAsUpdate(copy)));
  } finally {
    copy.destroy();
  }
}

export class RoomKeeper {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly deleted = new Map<string, number>();
  private barrier: WriteBarrier | null = null;
  private barrierWrittenDown = false;
  private barrierRetry: ReturnType<typeof setTimeout> | undefined;
  private readonly storageTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: DocStorage,
    /** The open document for a room, once it has finished loading. */
    private readonly liveDocument: (room: string) => Promise<Y.Doc | undefined>,
    /** Close a room's sockets and unload it, without saving. */
    private readonly unload: (room: string) => Promise<void>,
    options: RoomKeeperOptions = {},
  ) {
    this.storageTimeoutMs = options.storageTimeoutMs ?? Number(process.env.ROOM_STORAGE_TIMEOUT_MS ?? 5000);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Is nobody allowed to change any document right now?
   *
   * For taking a final copy of everything, however many people are typing: see
   * pauseWrites(). Reads, and everything the host needs to save what exists, carry on.
   */
  get writesPaused(): boolean {
    return this.barrier !== null;
  }

  get writeBarrier(): WriteBarrier | null {
    return this.barrier;
  }

  /**
   * Start refusing every write, and remember that across a restart.
   *
   * Takes effect the moment this is called, before anything is awaited. If it cannot
   * be written down that is reported, and writes stay refused here all the same.
   * Repeating it keeps the same barrier, so a host can tell it has held throughout.
   *
   * @throws RoomStorageUnavailable
   */
  async pauseWrites(): Promise<WriteBarrier> {
    clearTimeout(this.barrierRetry);

    if (this.barrier === null || this.barrier.id === UNCONFIRMED) {
      this.barrier = { id: randomUUID(), since: this.now() };
      this.barrierWrittenDown = false;
    }

    // Once is enough. A host asking again may be asking because the store has gone away.
    if (!this.barrierWrittenDown) {
      await this.bounded(this.storage.saveBarrier(JSON.stringify(this.barrier)));
      this.barrierWrittenDown = true;
    }

    return this.barrier;
  }

  /**
   * Allow writes again. Writes stay refused until the store has agreed.
   *
   * @throws RoomStorageUnavailable
   */
  async resumeWrites(): Promise<void> {
    await this.bounded(this.storage.saveBarrier(null));
    clearTimeout(this.barrierRetry);
    this.barrier = null;
    this.barrierWrittenDown = false;
  }

  /**
   * After a restart: writes stay refused until the store has said whether they should be.
   *
   * Someone may be partway through taking a final copy, and a restart must not let
   * writes in behind it. The store being away is not an answer, so this keeps asking.
   */
  async restoreBarrier(): Promise<void> {
    this.barrier = { id: UNCONFIRMED, since: this.now() };

    try {
      const stored = await this.bounded(this.storage.loadBarrier());

      if (this.barrier?.id === UNCONFIRMED) {
        this.barrier = stored === null ? null : (JSON.parse(stored) as WriteBarrier);
        this.barrierWrittenDown = stored !== null;
      }
    } catch {
      this.barrierRetry = setTimeout(() => { void this.restoreBarrier(); }, BARRIER_RETRY_MS);
      this.barrierRetry.unref?.();
    }
  }

  stopRestoringBarrier(): void {
    clearTimeout(this.barrierRetry);
  }

  isDeleted(room: string): boolean {
    this.forgetOldDeletions();

    return this.deleted.has(room);
  }

  /** @throws RoomStorageUnavailable */
  async hasState(room: string): Promise<boolean> {
    if (await this.liveDocument(room)) {
      return true;
    }

    return this.bounded(this.storage.has(room));
  }

  /** @throws RoomStorageUnavailable */
  load(room: string): Promise<Uint8Array | null> {
    return this.bounded(this.storage.load(room));
  }

  /**
   * What the room holds now: the open document if there is one, else what is stored.
   *
   * @throws RoomStorageUnavailable
   */
  async read(room: string): Promise<Uint8Array | null> {
    const live = await this.liveDocument(room);

    return live ? Y.encodeStateAsUpdate(live) : this.load(room);
  }

  /**
   * Make sure a room holds what the host says it should, before anyone connects.
   *
   * Safe to call at any time and from any number of requests at once. Calls for one
   * room run one after another, so simultaneous opens initialize it exactly once.
   *
   * Nothing a room holds is ever replaced. If it does not cover the host's state the
   * two are merged, which for a room that came from that state simply brings it back
   * up to date. A file is only ever used to fill a room with no content in it.
   *
   * @throws RoomDeleted, RoomWritesPaused, RoomStorageUnavailable, or whatever `seed` throws
   */
  prepare(room: string, request: PrepareRequest): Promise<RoomPreparation> {
    return this.exclusively(room, async () => {
      if (this.isDeleted(room)) {
        throw new RoomDeleted(room);
      }

      // A durable state only restores what is already saved. A file would start a room
      // with something new, behind the back of whoever is taking a final copy.
      const allowed: PrepareRequest = this.writesPaused && request.seed
        ? { ...request, seed: async () => { throw new RoomWritesPaused(room); } }
        : request;

      const live = await this.liveDocument(room);

      return live
        ? this.prepareLive(live, allowed)
        : this.prepareStored(room, allowed);
    });
  }

  private async prepareLive(live: Y.Doc, request: PrepareRequest): Promise<RoomPreparation> {
    let outcome: RoomOutcome = 'live';

    if (request.state && !covers(live, request.state)) {
      // Into the real document, so whoever is connected receives it as an ordinary
      // update and the room saves itself in the usual way.
      Y.applyUpdate(live, request.state);
      outcome = 'merged';
    }

    const seed = await this.seedFor(Y.encodeStateAsUpdate(live), request);

    if (seed) {
      Y.applyUpdate(live, seed);
      outcome = 'seeded';
    }

    return { ...reportRoomState(Y.encodeStateAsUpdate(live), request.known), outcome };
  }

  private async prepareStored(room: string, request: PrepareRequest): Promise<RoomPreparation> {
    const stored = await this.load(room);

    if (stored === null) {
      const first = request.state ?? (request.seed ? await request.seed() : null);

      if (first === null) {
        return { exists: false, outcome: 'missing' };
      }

      await this.save(room, first);

      return { ...reportRoomState(first, request.known), outcome: request.state ? 'restored' : 'seeded' };
    }

    const doc = new Y.Doc();

    try {
      Y.applyUpdate(doc, stored);

      let outcome: RoomOutcome = 'stored';

      if (request.state && !covers(doc, request.state)) {
        Y.applyUpdate(doc, request.state);
        outcome = 'merged';
      }

      const seed = await this.seedFor(Y.encodeStateAsUpdate(doc), request);

      if (seed) {
        Y.applyUpdate(doc, seed);
        outcome = 'seeded';
      }

      const current = outcome === 'stored' ? stored : Y.encodeStateAsUpdate(doc);

      if (outcome !== 'stored') {
        await this.save(room, current);
      }

      return { ...reportRoomState(current, request.known), outcome };
    } finally {
      doc.destroy();
    }
  }

  /**
   * What a file would add to a room, if anything.
   *
   * Nothing to a room with content. Nothing from a file with none either: that room
   * and that file already say the same thing, and merging them only adds another empty
   * paragraph, once for every person who happened to open a blank document at that moment.
   */
  private async seedFor(current: Uint8Array, request: PrepareRequest): Promise<Uint8Array | null> {
    if (!request.seed || roomStateHoldsContent(current)) {
      return null;
    }

    const seed = await request.seed();

    return roomStateHoldsContent(seed) ? seed : null;
  }

  /**
   * The host has deleted this document. Close its sockets and remove what is stored.
   *
   * Remembered for a while because a socket closing right now would otherwise save
   * the room back. After that, nothing is stored, and so no token can open it anyway.
   *
   * @throws RoomStorageUnavailable, and the host tries again
   */
  remove(room: string): Promise<void> {
    this.deleted.set(room, this.now());

    return this.exclusively(room, async () => {
      await this.unload(room);
      await this.bounded(this.storage.delete(room));
    });
  }

  private async save(room: string, update: Uint8Array): Promise<void> {
    await this.bounded(this.storage.save(room, update));
  }

  /** Write a room's state to the store now, reporting whether that worked. */
  async storeNow(room: string, update: Uint8Array): Promise<void> {
    await this.save(room, update);
  }

  private exclusively<T>(room: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(room) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);

    this.locks.set(room, settled);
    void settled.then(() => {
      if (this.locks.get(room) === settled) {
        this.locks.delete(room);
      }
    });

    return run;
  }

  /** The Redis client queues commands for as long as it is away, which is forever. */
  private async bounded<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RoomStorageUnavailable()), this.storageTimeoutMs);
        }),
      ]);
    } catch (err) {
      throw err instanceof RoomStorageUnavailable ? err : new RoomStorageUnavailable(err);
    } finally {
      clearTimeout(timer);
    }
  }

  private forgetOldDeletions(): void {
    for (const [room, at] of this.deleted) {
      if (this.now() - at > REMEMBER_DELETED_MS) {
        this.deleted.delete(room);
      }
    }
  }
}
