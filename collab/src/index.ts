import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { RoomRegistry, RoomCapacityError } from './rooms.js';
import { attachHocuspocus } from './yjs.js';
import { createStorage } from './storage.js';
import { createHost } from './host/index.js';
import { fileFormat } from './host/format.js';
import { registerWopiRoutes } from './wopi.js';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reportRoomState } from './room-state.js';
import { RoomDeleted, RoomStorageUnavailable, RoomWritesPaused } from './room-keeper.js';
import { SessionLedger, editorSessionSecretFromEnv, parseRevocations } from './auth/editor-session.js';
import { AdminConfigStore } from './admin/config.js';
import { registerAdminRoutes } from './admin/routes.js';
import { WebhookDispatcher } from './admin/webhooks.js';
import { PersonalAuthStore, readModeFromEnv } from './auth/personal.js';
import { registerPersonalAuthRoutes } from './auth/personal-routes.js';
import { registerPersonalProfileRoutes } from './auth/personal-profile-routes.js';
import { registerPersonalFilesRoutes } from './files/personal-files-routes.js';
import { registerPersonalSharesRoutes } from './files/personal-shares-routes.js';
import { attachAiWs } from './ai.js';
import { isZipContainer, isGzip } from './upload-validation.js';
import { registerMcpProxyRoute } from './mcpProxy.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
// Cap on multipart + raw-binary uploads — bounds the seed/snapshot
// path. If you raise this, also bump the web client's VITE_MAX_OPEN_MB
// so the share dialog doesn't get rejected here after the user picked
// a workbook the browser said it could open.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Rate-limit envelope for the write-side endpoints. The defaults are
// generous enough that a real user editing actively never hits them
// (creating ~one room per few seconds is plenty for testing), but
// tight enough that a script trying to enumerate room ids or fill
// disk via /seed gets a 429 quickly. Tuned per-route below — uploads
// (seed / snapshot) are slower / larger and get a smaller bucket
// than the cheap room-create POST.
//
// `false` for RATE_LIMIT_ENABLED skips the plugin entirely (useful for
// load tests + dev where the bucket would mask real failures). On by
// default for production safety.
const RATE_LIMIT_ENABLED = (process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
const UPLOAD_RATE_LIMIT_PER_MIN = Number(process.env.UPLOAD_RATE_LIMIT_PER_MIN ?? 12);

// Enable trustProxy behind a reverse proxy (Caddy / nginx / Cloudflare) so
// `req.ip` — and therefore the per-IP rate-limit key below — is the real
// client address, not the proxy's. Without it, every request behind the proxy
// shares one bucket and a single abuser throttles everyone. Off by default so
// a direct-exposed server can't be spoofed via X-Forwarded-For.
const app = Fastify({
  logger: true,
  bodyLimit: MAX_UPLOAD_BYTES,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

// CORS. `CORS_ORIGINS` (comma-separated) restricts to an allowlist — set it in
// production so a hostile page can't ride the user's cookies against /auth,
// /files, etc. Unset keeps the reflect-any default for local dev; we warn if
// that's left open under NODE_ENV=production.
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  await app.register(cors, { origin: corsOrigins, credentials: true });
  app.log.info(`CORS: restricted to ${corsOrigins.join(', ')}`);
} else {
  if (process.env.NODE_ENV === 'production') {
    app.log.warn(
      'CORS: reflecting any Origin (no CORS_ORIGINS set) — set an allowlist in production',
    );
  }
  await app.register(cors, { origin: true });
}
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
await app.register(cookie);

// Rate limit — applied per-route via `config.rateLimit` below so the
// hot-path GETs (snapshot, seed, info, /health) stay unbounded for
// returning peers while the WRITE-side endpoints (room create,
// snapshot upload, seed upload) get throttled per source IP.
//
// We DON'T set a global default — turning every route into a 429
// candidate would make a single noisy client throttle their own
// /health probes and look like a backend outage. Explicit opt-in
// per-route is the rule.
if (RATE_LIMIT_ENABLED) {
  await app.register(rateLimit, {
    global: false,
    // Identify clients by their forwarded IP when behind a proxy
    // (Caddy / nginx / Cloudflare). Fastify's `req.ip` honours
    // trustProxy when enabled; we don't enable trustProxy yet
    // (host-controlled), so this falls back to the socket address.
    // When self-hosted behind a reverse proxy, set NODE_OPTIONS
    // or enable trustProxy in the Fastify constructor.
    keyGenerator: (req) => req.ip,
    // Plain 429 + Retry-After header — the standard envelope.
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
  app.log.info(
    `rate limit: ${RATE_LIMIT_PER_MIN}/min general, ${UPLOAD_RATE_LIMIT_PER_MIN}/min uploads`,
  );
} else {
  app.log.warn(
    'rate limit: DISABLED via RATE_LIMIT_ENABLED=false — do not run this way in production',
  );
}

// Accept raw binary uploads (used by /api/rooms/:id/snapshot for the
// gzipped IWorkbookData cache). Cap matches the multipart limit so a
// single content-type isn't an end-run around the size guard.
app.addContentTypeParser(
  'application/gzip',
  { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
  (_req, body, done) => done(null, body),
);
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
  (_req, body, done) => done(null, body),
);

// Serve the built web bundle if present (production / docker). In dev the
// web app lives on a separate Vite server on :5273 and this path is empty.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');
const servesWeb = existsSync(join(webDist, 'index.html'));
if (servesWeb) {
  await app.register(staticPlugin, {
    root: webDist,
    prefix: '/',
    // `decorateReply: true` (the default) gives us `reply.sendFile()` —
    // required by the SPA fallback below so `/r/<roomId>` reloads serve
    // index.html instead of 500'ing.
    wildcard: false,
  });
  app.log.info(`serving built web app from ${webDist}`);
} else {
  app.log.info(`web/dist not built — running API/WS only (mount a built SPA at web/dist to serve one)`);
}

// Room permissions. Read before anything else starts: in production, a missing
// key must stop the server rather than leave every room open to every writer.
const editorSessionSecret = editorSessionSecretFromEnv(process.env);
const sessionLedger = new SessionLedger();
if (!editorSessionSecret) {
  app.log.warn('editor sessions are not enforced (OFFICE_SIGNING_SECRET is unset): any client may write to any room');
}

// With a host in charge, work it has not read yet must outlast any fixed expiry.
const storage = await createStorage({ keepUntilConfirmed: editorSessionSecret !== null });
app.log.info(
  `doc storage: ${process.env.REDIS_URL ? `redis (${process.env.REDIS_URL})` : 'in-memory'}`,
);

// Workbook FILE storage — separate concern from Y.Doc update storage
// above (rooms vs files). Drives the WOPI /wopi/files/:id routes and
// the admin-panel storage page in v0.1.0.
const host = await createHost();
app.log.info(`file host: ${host.label}`);
registerWopiRoutes(app, host);
// Same-origin proxy so the web editor can reach external MCP servers (CORS).
registerMcpProxyRoute(app);

// Admin panel config + REST routes. The on-disk config (default
// `/data/casual-admin.json`) drives runtime customisation: branding,
// storage backend selection, networking, room limits, auth provider
// hooks, base path, webhook subscriptions. Admin auth = env-only
// (CASUAL_ADMIN_USERNAME + CASUAL_ADMIN_PASSWORD); login mints a
// short-lived admin-role JWT for the session.
const adminConfigPath = process.env.CASUAL_ADMIN_CONFIG_PATH ?? '/data/casual-admin.json';
const adminStore = new AdminConfigStore(adminConfigPath);
const webhooks = new WebhookDispatcher(adminStore, {
  info: (...a) => app.log.info(a.join(' ')),
  warn: (...a) => app.log.warn(a.join(' ')),
});
registerAdminRoutes(app, adminStore);
app.log.info(`admin config: ${adminConfigPath}`);
// Webhook dispatcher is held in `webhooks` so call sites can fire
// events on demand. The dispatcher reloads the config on every emit
// so admin-panel edits to subscriptions take effect immediately.
void webhooks;

// Room registry created BEFORE the personal-mode routes so the share-link
// route can validate that a minted token's `roomId` refers to a live room
// (sharing-model §6.1 — tokens are bound to a specific room at mint time).
//
// Being forgotten here touches nothing that is stored. This registry starts empty on
// every restart, so it cannot tell a throwaway room from someone's document, and
// deleting what it has lost track of is how an idle document used to disappear 60
// minutes after a restart. Stored state goes when its document is deleted, or when
// Redis expires it: see RedisStorage.
const rooms = new RoomRegistry();
rooms.start();
app.addHook('onClose', async () => rooms.stop());

// Personal-mode auth store + routes. Off by default (`mode='none'`),
// in which case the store is not even instantiated (no DB file
// touched, no `/data` mount required) and `/auth/*` returns 503 via
// the route guards. Operators flip it on with
// `CASUAL_PERSONAL_MODE=single` (one account) or `=multi` (open
// signup); DB path is configurable for tests / dev, production uses
// the volume.
const personalMode = readModeFromEnv();
let personalAuth: PersonalAuthStore | null = null;
if (personalMode !== 'none') {
  const personalDbPath = process.env.CASUAL_USERS_DB_PATH ?? '/data/users.db';
  personalAuth = new PersonalAuthStore({
    dbPath: personalDbPath,
    mode: personalMode,
    bootstrap: process.env.CASUAL_BOOTSTRAP_USER ?? null,
  });
  registerPersonalAuthRoutes(app, personalAuth);
  registerPersonalProfileRoutes(app, personalAuth);
  registerPersonalFilesRoutes(app, personalAuth, host, {
    maxUploadBytes: MAX_UPLOAD_BYTES,
  });
  // Share-link CRUD (sharing-model §6.1). Tokens are bound to a specific
  // room at mint time; enforcement lives in the collab gate (yjs.ts
  // onAuthenticate → resolveJoinRole). The route validates that the
  // posted roomId refers to a live room before minting.
  registerPersonalSharesRoutes(app, personalAuth, {
    roomExists: (roomId) => rooms.get(roomId) !== undefined,
  });
  app.log.info(
    `personal auth: mode=${personalMode} db=${personalDbPath} users=${personalAuth.stats().userCount}`,
  );
  // Periodic prune so the sessions table doesn't grow unboundedly on
  // a long-running container. Cheap full-table scan via the
  // expires_at index; running once per hour is plenty for
  // human-scale traffic.
  const liveStore = personalAuth;
  const prunePersonal = setInterval(
    () => {
      try {
        const n = liveStore.pruneExpiredSessions();
        if (n > 0) app.log.info(`personal auth: pruned ${n} expired session(s)`);
      } catch (err) {
        app.log.warn({ err }, 'personal auth: prune failed');
      }
    },
    60 * 60 * 1000,
  );
  app.addHook('onClose', async () => {
    clearInterval(prunePersonal);
    liveStore.close();
  });
} else {
  app.log.info('personal auth: disabled (CASUAL_PERSONAL_MODE=none)');
}

app.log.info(
  `room registry: max ${process.env.MAX_ROOMS ?? 256} concurrent, TTL ${process.env.ROOM_TTL_MIN ?? 60} min, upload ≤ ${MAX_UPLOAD_MB} MB`,
);


app.get('/health', async () => ({
  ok: true,
  ts: Date.now(),
  rooms: rooms.snapshot().length,
}));

/**
 * The check every `/internal/` route makes. Returns the reply if the request was
 * refused, or null if the caller holds the shared service credential.
 */
function refuseWithoutServiceCredential(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  const expected = process.env.CASUAL_JWT_SECRET ?? '';

  if (expected === '') {
    // Refuse rather than accept everything: an unset secret must not read as
    // "no authentication required".
    req.log.error(`${req.url} called but CASUAL_JWT_SECRET is unset`);

    return reply.code(503).send({ error: 'not_configured' });
  }

  const offered = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

  // Constant-time: a length-independent comparison here leaks the secret one
  // character at a time to anything that can measure the response.
  const ok =
    offered.length === expected.length &&
    timingSafeEqual(Buffer.from(offered), Buffer.from(expected));

  return ok ? null : reply.code(401).send({ error: 'unauthorized' });
}

/**
 * With a host in charge, `/api/rooms*` is for the host.
 *
 * These routes were written for anonymous rooms, where only a room's creator knows
 * its id. Here a room id is in a URL in someone's browser history, and anyone who could
 * reach these could create rooms, pin uploads in memory, and read an uploaded seed. A
 * browser has no reason to call them: Flares serves the starting file itself and fills
 * rooms through /internal. A proxy not routing them is one defence, and this is another.
 */
if (editorSessionSecret) {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';

    if (path === '/api/rooms' || path.startsWith('/api/rooms/')) {
      const refused = refuseWithoutServiceCredential(req, reply);

      if (refused) {
        return refused;
      }
    }
  });
}

/**
 * The conversions between .docx and Yjs.
 *
 * Imported by absolute path, and lazily, so Node resolves the editor's ProseMirror
 * stack from the editor's own tree. Two copies of prosemirror-model in one process
 * cannot exchange documents, and a linked package brings its own. Lazy also keeps
 * the editor out of the startup path: a deployment that never converts never loads it.
 */
function loadEditorScript() {
  const modulePath =
    process.env.CASUAL_SERIALIZER_PATH ??
    resolve(here, '../../docx-editor/scripts/serialize-ydoc.mts');

  return import(pathToFileURL(modulePath).href) as Promise<typeof import('../../docx-editor/scripts/serialize-ydoc.mjs')>;
}

/**
 * Convert a Yjs document to .docx, for a trusted server-side caller.
 *
 * A host application owns the canonical file and needs bytes to store a
 * version of it. The conversion lives in the editor's TypeScript, so a host
 * written in another language cannot do it — and having the browser upload the
 * bytes instead would make whatever a client sends the canonical document.
 *
 * `/internal/` because this is not a browser surface: it is bearer-authenticated
 * with the shared service credential and expected to be reachable only over
 * loopback or a private network. A reverse proxy must not expose it.
 */
app.post<{ Body: { state?: string; name?: string; base?: string } }>(
  '/internal/serialize',
  async (req, reply) => {
    const refused = refuseWithoutServiceCredential(req, reply);

    if (refused) {
      return refused;
    }

    const state = typeof req.body?.state === 'string' ? req.body.state : '';

    if (state === '') {
      return reply.code(400).send({ error: 'state_required' });
    }

    try {
      const { serializeYDocToDocx } = await loadEditorScript();

      const docx = await serializeYDocToDocx({
        state: new Uint8Array(Buffer.from(state, 'base64')),
        name: typeof req.body?.name === 'string' ? req.body.name : 'document.docx',
        base: typeof req.body?.base === 'string' && req.body.base !== ''
          ? new Uint8Array(Buffer.from(req.body.base, 'base64'))
          : undefined,
      });

      return reply.send({ docx: Buffer.from(docx).toString('base64') });
    } catch (err) {
      // The caller gets a category, not a stack: it is a different process and
      // usually a different language, and the detail belongs in our log.
      req.log.error({ err }, 'internal/serialize failed');

      return reply.code(500).send({ error: 'serialize_failed' });
    }
  },
);

/**
 * The current state of a room, for a trusted server-side caller.
 *
 * A host application that owns the canonical file has to be able to read what
 * people typed. Without this, `/internal/serialize` has nothing to convert: the
 * state lives only here, and a host's stored file stays whatever it was when the
 * room was created, while the editor goes on showing the typed text.
 *
 * Read from the live document when the room is open, so an edit made a moment
 * ago is included rather than waiting on the debounced save, and from storage
 * when it is not. `?known=` is the fingerprint the caller already holds, and
 * makes asking repeatedly cheap.
 */
app.get<{ Params: { id: string }; Querystring: { known?: string } }>(
  '/internal/rooms/:id/state',
  async (req, reply) => {
    const refused = refuseWithoutServiceCredential(req, reply);

    if (refused) {
      return refused;
    }

    try {
      const report = reportRoomState(await hocus.keeper.read(req.params.id), req.query.known);

      // Only a caller that holds these same bytes can name their fingerprint, so
      // this is the host saying it has a durable copy. Not worth failing a read over.
      if (report.exists && report.unchanged) {
        storage.confirmDurable(req.params.id).catch((err) => {
          req.log.warn({ err }, 'could not start the expiry of a stored room');
        });
      }

      return report;
    } catch (err) {
      req.log.error({ err }, 'internal/rooms/state failed');

      return err instanceof RoomStorageUnavailable
        ? reply.code(503).send({ error: 'storage_unavailable' })
        : reply.code(500).send({ error: 'state_unavailable' });
    }
  },
);

/**
 * Make sure a room holds a document before anyone connects to it, for a trusted
 * server-side caller. See RoomKeeper.prepare() for what this will and will not do.
 *
 * `state` is the host's durable copy. `docx` is a file to start from, used only if
 * the room holds no content, and converted here because the conversion lives in the
 * editor's TypeScript. Doing this before anyone connects is what lets every socket
 * be refused from an empty room, and lets a viewer who arrives first see the document
 * rather than a blank page they cannot fill.
 */
app.post<{ Params: { id: string }; Body: { state?: unknown; docx?: unknown; known?: unknown } }>(
  '/internal/rooms/:id/prepare',
  async (req, reply) => {
    const refused = refuseWithoutServiceCredential(req, reply);

    if (refused) {
      return refused;
    }

    const { state, docx, known } = req.body ?? {};

    if (
      (state !== undefined && (typeof state !== 'string' || state === '')) ||
      (docx !== undefined && (typeof docx !== 'string' || docx === '')) ||
      (known !== undefined && typeof known !== 'string')
    ) {
      return reply.code(400).send({ error: 'invalid_prepare' });
    }

    try {
      return await hocus.keeper.prepare(req.params.id, {
        state: typeof state === 'string' ? new Uint8Array(Buffer.from(state, 'base64')) : undefined,
        known: typeof known === 'string' ? known : undefined,
        seed: typeof docx === 'string'
          ? async () => {
              const { docxToYDocState } = await loadEditorScript();

              return docxToYDocState(new Uint8Array(Buffer.from(docx, 'base64')));
            }
          : undefined,
      });
    } catch (err) {
      if (err instanceof RoomDeleted) {
        return reply.code(410).send({ error: 'room_deleted' });
      }

      if (err instanceof RoomWritesPaused) {
        return reply.code(503).send({ error: 'writes_paused' });
      }

      if (err instanceof RoomStorageUnavailable) {
        req.log.error({ err }, 'internal/rooms/prepare: storage unavailable');

        return reply.code(503).send({ error: 'storage_unavailable' });
      }

      // A state that does not decode, or a file that does not convert. Either way
      // the room was left as it was, and the caller must not treat it as prepared.
      req.log.error({ err }, 'internal/rooms/prepare failed');

      return reply.code(422).send({ error: 'unusable_document' });
    }
  },
);

/**
 * Remove a deleted document's room, for a trusted server-side caller.
 *
 * The only way stored state is deleted. Sockets close, and because nothing is then
 * stored, no token issued for this room can open it again. Safe to repeat.
 */
app.delete<{ Params: { id: string } }>('/internal/rooms/:id', async (req, reply) => {
  const refused = refuseWithoutServiceCredential(req, reply);

  if (refused) {
    return refused;
  }

  try {
    await hocus.keeper.remove(req.params.id);

    return { deleted: true };
  } catch (err) {
    req.log.error({ err }, 'internal/rooms delete failed');

    return reply.code(503).send({ error: 'storage_unavailable' });
  }
});

/**
 * Stop every document changing, for a trusted server-side caller about to take a final
 * copy of everything. Only with a host in charge: without one there is nobody to take it.
 *
 * `{ "active": true }` starts it and stores what has been accepted so far; repeating that
 * keeps the same barrier. `{ "active": false }` ends it. The routes a host saves with stay
 * available throughout, and the barrier outlasts a restart of this service.
 */
app.get('/internal/write-barrier', async (req, reply) => {
  const refused = refuseWithoutServiceCredential(req, reply);

  if (refused) {
    return refused;
  }

  const barrier = hocus.keeper.writeBarrier;

  return barrier ? { active: true, ...barrier } : { active: false };
});

app.post<{ Body: { active?: unknown } }>('/internal/write-barrier', async (req, reply) => {
  const refused = refuseWithoutServiceCredential(req, reply);

  if (refused) {
    return refused;
  }

  if (!editorSessionSecret) {
    return reply.code(409).send({ error: 'no_host' });
  }

  if (typeof req.body?.active !== 'boolean') {
    return reply.code(400).send({ error: 'invalid_barrier' });
  }

  try {
    if (req.body.active) {
      return { active: true, ...(await hocus.pauseWrites()) };
    }

    await hocus.resumeWrites();

    return { active: false };
  } catch (err) {
    req.log.error({ err }, 'internal/write-barrier failed');

    return reply.code(503).send({ error: 'storage_unavailable' });
  }
});

/**
 * Take editor sessions back, for a trusted server-side caller.
 *
 * Only the host can tell that someone has lost access, so it says so here. Closing
 * the socket is what makes that immediate; a client that still has access renews
 * and reconnects with whatever permission it now holds. Repeating a request is
 * harmless, and the host does, so a restart here does not forget for long.
 */
app.post('/internal/sessions/revoke', async (req, reply) => {
  const refused = refuseWithoutServiceCredential(req, reply);

  if (refused) {
    return refused;
  }

  const sessions = parseRevocations(req.body);

  if (sessions === null) {
    return reply.code(400).send({ error: 'invalid_sessions' });
  }

  return { closed: sessionLedger.revoke(sessions) };
});

/**
 * Create a fresh room. Body is optional JSON `{ password?: string }`.
 * Empty Y.Doc to start — the room creator's client seeds it (via xlsx
 * open or fresh edits) which then propagates through the op-log bridge
 * to anyone who joins. Keeps the server out of the workbook parsing
 * business; everything goes through the same code path on the client.
 */
app.post(
  '/api/rooms',
  {
    // Room creation is cheap on the server but a script enumerating
    // ids or filling the registry with garbage is the easiest abuse
    // vector. RATE_LIMIT_PER_MIN default = 60/min/IP — 1/sec average,
    // plenty for a human + their dev tools, throttles a bot.
    config: RATE_LIMIT_ENABLED
      ? { rateLimit: { max: RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } }
      : {},
  },
  async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown };
    const password =
      typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
    try {
      const id = rooms.create({ password });
      return { roomId: id, needsPassword: Boolean(password) };
    } catch (err) {
      if (err instanceof RoomCapacityError) {
        // 503 — registry is at the MAX_ROOMS cap and every existing
        // room is non-evictable (all protected / seeded). Client
        // should back off and retry; long-term fix is raising the cap
        // OR clearing stuck rooms via the admin panel.
        req.log.warn({ cap: err.cap }, 'room create rejected: capacity full');
        return reply
          .code(503)
          .header('retry-after', '60')
          .send({ error: 'capacity_full', cap: err.cap });
      }
      throw err;
    }
  },
);

/**
 * Pre-flight check for a join URL. Lets the client decide whether to
 * prompt for a password before opening the WebSocket. Returns 404 when
 * the room doesn't exist so a bad link surfaces immediately.
 */
app.get<{ Params: { id: string } }>('/api/rooms/:id/info', async (req, reply) => {
  const room = rooms.get(req.params.id);
  if (!room) return reply.code(404).send({ error: 'room_not_found' });
  return {
    id: room.id,
    needsPassword: room.passwordHash !== null,
    hasSeed: Boolean(room.xlsxSeed),
    /** True when the server has a pre-parsed snapshot. Joiners that see
     *  this can skip the xlsx parser entirely and apply the snapshot
     *  directly — multi-second win on big workbooks. */
    hasSnapshot: Boolean(room.snapshotGz),
    clients: room.clients,
  };
});

/**
 * Upload an xlsx file as the room's starting workbook. Joiners GET the
 * same bytes via /seed and import them locally before the op-log bridge
 * takes over — that's how content the owner had before creating the room
 * reaches peers (the op log only carries *future* mutations).
 *
 * No auth: the owner is the only client who knows the freshly-minted
 * roomId at this instant. A misuse window of "another tab races to
 * overwrite the seed before the owner uploads" is theoretical and not
 * worth more machinery in a self-hosted v1.
 */
app.post<{ Params: { id: string } }>(
  '/api/rooms/:id/seed',
  {
    // Upload route — bytes go to memory before we hand them to the
    // room registry. Even with MAX_UPLOAD_BYTES capping each request,
    // a script PUT-ing 100 MB blobs in a tight loop can churn GC.
    // UPLOAD_RATE_LIMIT_PER_MIN default = 12/min/IP (one upload every
    // 5 s sustained) — fine for the upload-once-per-session real flow.
    config: RATE_LIMIT_ENABLED
      ? { rateLimit: { max: UPLOAD_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } }
      : {},
  },
  async (req, reply) => {
    const room = rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no_file' });
    const buf = await file.toBuffer();
    // Seeds are .xlsx workbooks — zip (OOXML) containers. Reject anything that
    // isn't a zip so a client can't pin 100 MB of arbitrary bytes in room
    // memory (MAX_ROOMS × MAX_UPLOAD_BYTES of unvalidated RSS otherwise).
    if (!isZipContainer(buf)) {
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }
    rooms.setXlsxSeed(req.params.id, new Uint8Array(buf));
    return { ok: true, bytes: buf.byteLength };
  },
);

/**
 * Serve the room's xlsx starting workbook. Joiners apply this locally
 * before the bridge runs so they begin from the same state as the owner.
 *
 * Gated by the room password (header `x-room-password`) when the room
 * is password-protected. Without this gate, anyone with the room URL
 * could fetch the contents — making the password a UI illusion rather
 * than an actual access control.
 */
app.get<{ Params: { id: string } }>('/api/rooms/:id/seed', async (req, reply) => {
  const room = rooms.get(req.params.id);
  if (!room?.xlsxSeed) return reply.code(404).send({ error: 'no_seed' });
  if (!checkRoomPassword(req, room.id)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  reply.header('content-type', fileFormat().contentType);
  reply.header('cache-control', 'no-store');
  return reply.send(Buffer.from(room.xlsxSeed));
});

/**
 * Constant-time password check for a room request. The password rides
 * the `x-room-password` header — preferable to a query string because
 * it stays out of access logs and browser history. Falls back to the
 * `?p=` query param so clients with restricted header control (e.g.
 * EventSource) can still authenticate.
 *
 * Returns true for open (no-password) rooms.
 */
function checkRoomPassword(
  req: { headers: Record<string, unknown>; query?: unknown },
  roomId: string,
): boolean {
  const headerVal = req.headers['x-room-password'];
  const headerPw = typeof headerVal === 'string' ? headerVal : undefined;
  const queryPw =
    typeof req.query === 'object' && req.query !== null
      ? (req.query as { p?: unknown }).p
      : undefined;
  const password =
    typeof headerPw === 'string' ? headerPw : typeof queryPw === 'string' ? queryPw : undefined;
  return rooms.passwordOk(roomId, password ?? null);
}

/**
 * Upload a pre-parsed gzipped `IWorkbookData` snapshot for the room.
 * Owner-side: serialize the in-memory workbook (no ExcelJS), gzip,
 * upload — joiners then skip parsing entirely. Body is the raw gzipped
 * bytes (no multipart envelope), keeping the upload tiny.
 */
app.post<{ Params: { id: string } }>(
  '/api/rooms/:id/snapshot',
  {
    // Snapshot upload — same shape and risk profile as /seed (large
    // binary into memory). Shares the upload bucket.
    config: RATE_LIMIT_ENABLED
      ? { rateLimit: { max: UPLOAD_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } }
      : {},
  },
  async (req, reply) => {
    const room = rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    // Fastify gives us the raw body when content-type isn't JSON/form;
    // ensure we got bytes.
    const body = req.body as unknown;
    let bytes: Uint8Array | null = null;
    if (body instanceof Buffer) bytes = new Uint8Array(body);
    else if (body instanceof Uint8Array) bytes = body;
    if (!bytes || bytes.byteLength === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }
    // The snapshot is a gzipped IWorkbookData cache — reject non-gzip bytes so
    // arbitrary uploads can't be pinned in room memory.
    if (!isGzip(bytes)) {
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }
    rooms.setSnapshotGz(req.params.id, bytes);
    return { ok: true, bytes: bytes.byteLength };
  },
);

/**
 * Serve the room's pre-parsed gzipped snapshot. Cache-able forever —
 * the snapshot bytes for a given room id never change outside of an
 * owner re-upload, which is rare. Browser disk cache hits make the
 * second-and-Nth joiner load nearly free.
 */
app.get<{ Params: { id: string } }>('/api/rooms/:id/snapshot', async (req, reply) => {
  const room = rooms.get(req.params.id);
  if (!room?.snapshotGz) return reply.code(404).send({ error: 'no_snapshot' });
  if (!checkRoomPassword(req, room.id)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  reply.header('content-type', 'application/json');
  reply.header('content-encoding', 'gzip');
  // Private — the password gates access, so each protected response
  // must NOT be served from a shared / proxy cache. Browser disk cache
  // still kicks in (immutable) so warm re-joins stay fast.
  reply.header(
    'cache-control',
    room.passwordHash ? 'private, max-age=3600, immutable' : 'public, max-age=3600, immutable',
  );
  return reply.send(Buffer.from(room.snapshotGz));
});

// Diagnostic: list current rooms (clients, idle time). No auth — fine
// for v1 since the surface is anonymous and self-hosted anyway.
// Public diagnostic: per-room counts WITHOUT the room ids. An open (no
// password) room is readable by anyone who has its id, so listing every live
// id unauthenticated handed out the full set of shared documents. The metadata
// (client counts, age, protected flag) stays for a health overview.
app.get('/api/rooms', async () => ({
  rooms: rooms.snapshot().map(({ id: _id, ...rest }) => rest),
}));

// SPA fallback — any unknown HTML route serves index.html so client-side
// routing (e.g. /r/:roomId) works on reload. Only registered when the
// web bundle is present (production / docker).
if (servesWeb) {
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.code(404).send();
    const accept = req.headers.accept ?? '';
    if (!accept.includes('text/html')) return reply.code(404).send();
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: HOST });

// Hocuspocus needs the underlying Node http server for the upgrade
// handler. Fastify exposes it after listen. Storage was created
// earlier (right after the app instance) so the room registry could
// register its eviction callback.
// In personal mode, hand the share-token resolver to the collab gate so
// `?share=<token>` joins are validated against the persisted, room-bound
// link tokens (sharing-model §6.1 enforcement). In anonymous-only
// deploys `personalAuth` is null, so the gate rejects any share token and
// only the legacy `?role=` / room-password path applies.
const personalAuthForCollab = personalAuth;
const hocus = attachHocuspocus(app.server, rooms, storage, '/yjs', {
  editorSessions: editorSessionSecret ? { secret: editorSessionSecret, ledger: sessionLedger } : null,
  resolveLinkRole: personalAuthForCollab
    ? (token) => personalAuthForCollab.getLinkRole(token)
    : null,
});

const closeAiWs = attachAiWs(app.server, '/api/ai', hocus.hocuspocus.documents as Parameters<typeof attachAiWs>[2]);
app.log.info(`AI WebSocket on ws://${HOST}:${PORT}/api/ai`);

const shutdown = async () => {
  app.log.info('shutting down');
  closeAiWs();
  await hocus.close();
  await storage.close();
  if (host.close) await host.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.log.info(`collab server listening on http://${HOST}:${PORT}`);
app.log.info(`websocket sync on ws://${HOST}:${PORT}/yjs`);
