import type Redis from 'ioredis';

/**
 * Y.Doc persistence. Two implementations:
 *
 *   - `InMemoryStorage` (default) — rooms vanish on restart. Matches the
 *     v1 design doc's "in-memory only" stance.
 *   - `RedisStorage` — when REDIS_URL is set, snapshot every change into
 *     Redis as a single binary update blob keyed by room id. Survives
 *     restarts and gives us pub/sub headroom for horizontal scaling later.
 *
 * The interface deliberately stays small so swapping in another backend (S3,
 * Postgres bytea) is a single-file change.
 *
 * What is stored here is a cache of a document whose durable copy, if there is a
 * host, is the host's. So how long it may be kept depends on whether the host has
 * that copy yet: see `RedisStorage`.
 */

export interface DocStorage {
  /** Return the persisted Y.Doc update bytes for `roomId`, or null. */
  load(roomId: string): Promise<Uint8Array | null>;
  /** Is anything stored for `roomId`? Without moving the bytes. */
  has(roomId: string): Promise<boolean>;
  /** Persist the full Y.Doc update for `roomId`. Called debounced on change. */
  save(roomId: string, update: Uint8Array): Promise<void>;
  /** Remove the persisted snapshot. Only for a document that has been deleted. */
  delete(roomId: string): Promise<void>;
  /** The host holds a durable copy of what is stored, so this copy may now expire. */
  confirmDurable(roomId: string): Promise<void>;
  /** The write barrier, as it was last written down. See RoomKeeper.pauseWrites(). */
  loadBarrier(): Promise<string | null>;
  saveBarrier(value: string | null): Promise<void>;
  /** Close any underlying connections. */
  close(): Promise<void>;
}

export class InMemoryStorage implements DocStorage {
  private store = new Map<string, Uint8Array>();
  private barrier: string | null = null;
  async load(roomId: string) {
    return this.store.get(roomId) ?? null;
  }
  async has(roomId: string) {
    return this.store.has(roomId);
  }
  async save(roomId: string, update: Uint8Array) {
    this.store.set(roomId, update);
  }
  async delete(roomId: string) {
    this.store.delete(roomId);
  }
  async confirmDurable(_roomId: string) {
    // Nothing here expires.
  }
  async loadBarrier() {
    return this.barrier;
  }
  async saveBarrier(value: string | null) {
    this.barrier = value;
  }
  async close() {
    this.store.clear();
  }
}

// Redis key namespace for persisted room Y.Doc bytes. Override per
// deployment (CASUAL_REDIS_PREFIX) so multiple products sharing one
// Redis don't collide — e.g. "casual-docs:room:" / "casual-sheets:room:".
const KEY_PREFIX = process.env.CASUAL_REDIS_PREFIX ?? 'casual:room:';
// Beside the rooms, not among them: anything counting or copying rooms should not find it.
const BARRIER_KEY = `${KEY_PREFIX.replace(/room:$/, '')}write-barrier`;

/**
 * With `keepUntilConfirmed`, work a host has not yet read does not expire.
 *
 * A fixed expiry on every save means work is lost if the host stops reading for
 * longer than the expiry, however long that is, and nothing would look wrong until
 * somebody came back to the document. So a save stores with no expiry, and the clock
 * only starts when the host shows it holds the same bytes. The next save stops it
 * again. Redis keeps only what a read has not yet made safe, plus a week of hot copies.
 */
export class RedisStorage implements DocStorage {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec = 60 * 60 * 24 * 7, // 7-day idle TTL
    private readonly keepUntilConfirmed = false,
  ) {}

  async load(roomId: string): Promise<Uint8Array | null> {
    // Use Buffer-typed getter so we get the raw bytes, not a UTF-8 string.
    const buf = await this.redis.getBuffer(KEY_PREFIX + roomId);
    return buf ? new Uint8Array(buf) : null;
  }

  async has(roomId: string): Promise<boolean> {
    return (await this.redis.exists(KEY_PREFIX + roomId)) === 1;
  }

  async save(roomId: string, update: Uint8Array): Promise<void> {
    if (this.keepUntilConfirmed) {
      // A plain SET also clears any expiry left from the last confirmation.
      await this.redis.set(KEY_PREFIX + roomId, Buffer.from(update));

      return;
    }

    await this.redis.set(
      KEY_PREFIX + roomId,
      Buffer.from(update),
      'EX',
      this.ttlSec,
    );
  }

  async confirmDurable(roomId: string): Promise<void> {
    await this.redis.expire(KEY_PREFIX + roomId, this.ttlSec);
  }

  async delete(roomId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + roomId);
  }

  async loadBarrier(): Promise<string | null> {
    return this.redis.get(BARRIER_KEY);
  }

  async saveBarrier(value: string | null): Promise<void> {
    if (value === null) {
      await this.redis.del(BARRIER_KEY);

      return;
    }

    await this.redis.set(BARRIER_KEY, value);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/**
 * Pick the storage backend based on environment. Falls back to in-memory
 * if no REDIS_URL is set so `pnpm dev:server` works without Redis.
 */
export async function createStorage(options: { keepUntilConfirmed?: boolean } = {}): Promise<DocStorage> {
  const url = process.env.REDIS_URL;
  if (!url) {
    // In production, ephemeral Y.Doc storage means every restart drops all
    // live rooms — almost never intended. Refuse to boot loudly unless the
    // operator explicitly opts in, so a misconfigured deploy fails fast
    // instead of silently losing data.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_EPHEMERAL !== 'true') {
      throw new Error(
        'Refusing to start: NODE_ENV=production with in-memory Y.Doc storage — ' +
          'rooms would be lost on every restart. Set REDIS_URL for persistence, ' +
          'or ALLOW_EPHEMERAL=true to override intentionally.',
      );
    }
    return new InMemoryStorage();
  }
  // Lazy import so the redis client only loads when actually used.
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(url, {
    // Don't crash the whole server if Redis is briefly unreachable —
    // log and retry. The bridge still works in-memory in the meantime.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  redis.on('error', (err) => console.warn('[redis]', err.message));
  return new RedisStorage(redis, undefined, options.keepUntilConfirmed ?? false);
}
