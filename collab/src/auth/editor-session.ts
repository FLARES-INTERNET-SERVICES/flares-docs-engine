import jwt from 'jsonwebtoken';

/**
 * Editor sessions: who may do what to a room, decided by the host application.
 *
 * The host signs a short-lived token saying "this session, this room, this
 * permission, until this time". This server never learns why the answer was yes.
 * It only checks that the token is genuine, is for the room being opened and has
 * not run out, and takes the permission from it. Nothing the client sends, such as
 * a `?role=` parameter, has a say.
 *
 * The signing key is deliberately not the service credential that guards
 * `/internal/*`. The browser holds a token signed with this key, and a host can
 * rotate one without the other.
 */

export type EditorPermission = 'edit' | 'view';

export type EditorSessionClaims = {
  sid: string;
  room: string;
  perm: EditorPermission;
  exp: number;
  sub?: string;
};

/** Logged here, and never sent to the client: every refusal looks the same to it. */
export type EditorSessionRefusal =
  | 'not_a_token'
  | 'expired'
  | 'malformed'
  | 'wrong_room'
  | 'revoked'
  | 'not_synced'
  | 'room_deleted'
  | 'no_state'
  | 'storage_unavailable';

export class EditorSessionRefused extends Error {
  constructor(public readonly why: EditorSessionRefusal) {
    super(`editor session refused: ${why}`);
    this.name = 'EditorSessionRefused';
  }
}

/** Below this a key can be guessed offline from any token a browser holds. */
const MIN_SECRET_LENGTH = 32;

/**
 * The key to verify sessions with, or null when this deployment does not use them.
 *
 * An unset key in production stops the server starting. The alternative is every
 * room accepting every writer, and nothing would look wrong until somebody checked.
 */
export function editorSessionSecretFromEnv(env: NodeJS.ProcessEnv): string | null {
  const secret = env.OFFICE_SIGNING_SECRET ?? '';

  if (secret.length >= MIN_SECRET_LENGTH) {
    return secret;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to start: OFFICE_SIGNING_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters, ` +
        'so room permissions could not be enforced. Set it to the same value the host signs editor sessions with.',
    );
  }

  return null;
}

/** Verify a token against the room it is being used on. Throws on any failure. */
export function verifyEditorSession(
  token: string | null | undefined,
  room: string,
  secret: string,
): EditorSessionClaims {
  if (!token) {
    throw new EditorSessionRefused('not_a_token');
  }

  let payload: unknown;

  try {
    // The algorithm is pinned: without it a token can name its own, `none` included.
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new EditorSessionRefused(err instanceof jwt.TokenExpiredError ? 'expired' : 'not_a_token');
  }

  const claims = payload as Partial<EditorSessionClaims> | string;

  if (
    typeof claims !== 'object' ||
    claims === null ||
    typeof claims.sid !== 'string' ||
    claims.sid === '' ||
    typeof claims.room !== 'string' ||
    typeof claims.exp !== 'number' ||
    (claims.perm !== 'edit' && claims.perm !== 'view')
  ) {
    throw new EditorSessionRefused('malformed');
  }

  // Without this, a token for any document a person can open works on all of them.
  if (claims.room !== room) {
    throw new EditorSessionRefused('wrong_room');
  }

  return claims as EditorSessionClaims;
}

/** A token's permission holds for as long as the token, so expiry has to end the socket. */
export const SESSION_ENDED_CLOSE = { code: 4000, reason: 'session-ended' } as const;

/**
 * Hocuspocus's own Forbidden, which its client does not reconnect after. That
 * matters: closing a refused socket with any other code makes the client's socket
 * layer reconnect and try the same token again, about twice a second, for as long
 * as the tab stays open. A tab still running an older editor would do exactly that
 * after a deployment.
 */
export const SESSION_REFUSED_CLOSE = { code: 4403, reason: 'Forbidden' } as const;

type LiveConnection = {
  sid: string;
  timer: ReturnType<typeof setTimeout> | null;
  close: () => void;
};

/** setTimeout overflows above this and fires immediately. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/**
 * Which sessions have live sockets, and which have been taken back.
 *
 * Held in memory, so a restart forgets revocations. So until the host has told this
 * process what it has taken back, every session is refused, however good its token
 * looks. Someone with access is barely held up: a refused editor asks the host for
 * a new session, and issuing one sends the list. Someone without access never gets
 * the moment after a restart when their old token would have worked again.
 */
export class SessionLedger {
  private revoked = new Map<string, number>();
  private live = new Map<string, LiveConnection>();
  private synced = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Has the host told this process what it has taken back, since it started? */
  isSynced(): boolean {
    return this.synced;
  }

  isRevoked(sid: string): boolean {
    this.forgetExpired();

    return this.revoked.has(sid);
  }

  /**
   * Track a connection until it closes, closing it when its token runs out.
   *
   * Checks for revocation again because one can arrive between the token being
   * verified and the connection being established.
   */
  admit(key: string, claims: EditorSessionClaims, close: () => void): void {
    this.release(key);

    const remainingMs = claims.exp * 1000 - this.now();

    if (remainingMs <= 0 || this.isRevoked(claims.sid)) {
      close();

      return;
    }

    const entry: LiveConnection = { sid: claims.sid, timer: null, close };

    entry.timer = setTimeout(() => {
      this.live.delete(key);
      close();
    }, Math.min(remainingMs, LONGEST_TIMER_MS));
    entry.timer.unref?.();

    this.live.set(key, entry);
  }

  release(key: string): void {
    const entry = this.live.get(key);

    if (entry?.timer) {
      clearTimeout(entry.timer);
    }

    this.live.delete(key);
  }

  /**
   * Take sessions back, closing any of their live sockets.
   *
   * Idempotent, because the host repeats itself, and it always sends all of them,
   * possibly none. `exp` is how long the refusal has to last: after that, the token
   * fails on its own.
   *
   * @returns how many connections were closed
   */
  revoke(sessions: ReadonlyArray<{ sid: string; exp: number }>): number {
    let closed = 0;

    this.synced = true;

    for (const { sid, exp } of sessions) {
      this.revoked.set(sid, exp);

      for (const [key, entry] of this.live) {
        if (entry.sid === sid) {
          this.release(key);
          entry.close();
          closed++;
        }
      }
    }

    this.forgetExpired();

    return closed;
  }

  liveCount(): number {
    return this.live.size;
  }

  private forgetExpired(): void {
    const nowSeconds = this.now() / 1000;

    for (const [sid, exp] of this.revoked) {
      if (exp <= nowSeconds) {
        this.revoked.delete(sid);
      }
    }
  }
}

/** Validate a revocation request body. Null if it is not one. */
export function parseRevocations(body: unknown): Array<{ sid: string; exp: number }> | null {
  const sessions = (body as { sessions?: unknown } | null)?.sessions;

  if (!Array.isArray(sessions) || sessions.length > 10_000) {
    return null;
  }

  const parsed: Array<{ sid: string; exp: number }> = [];

  for (const session of sessions) {
    const { sid, exp } = (session ?? {}) as { sid?: unknown; exp?: unknown };

    if (typeof sid !== 'string' || sid === '' || typeof exp !== 'number' || !Number.isFinite(exp)) {
      return null;
    }

    parsed.push({ sid, exp });
  }

  return parsed;
}
