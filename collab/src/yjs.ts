import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import * as Y from 'yjs';
import type { RoomRegistry } from './rooms.js';
import type { DocStorage } from './storage.js';
import { RoomKeeper, RoomStorageUnavailable, type WriteBarrier } from './room-keeper.js';
import type { ShareLinkRole } from './auth/personal.js';
import { resolveJoinRole } from './auth/join-role.js';
import {
  EditorSessionRefused,
  SESSION_ENDED_CLOSE,
  SESSION_REFUSED_CLOSE,
  verifyEditorSession,
  type EditorSessionClaims,
  type SessionLedger,
} from './auth/editor-session.js';

/** Resolve a share token to its persisted role/room/password, respecting
 *  expiry, or null. In production this is `PersonalAuthStore.getLinkRole`,
 *  bound in index.ts; null in anonymous-only deploys (no personal store),
 *  in which case any `?share=` token is treated as invalid and rejected. */
export type ResolveLinkRole = (token: string) => ShareLinkRole | null;

export type AttachHocuspocusOptions = {
  /** Wired only in personal mode. When absent, share tokens can't be
   *  validated, so a `?share=` join is rejected rather than trusted. */
  resolveLinkRole?: ResolveLinkRole | null;
  /** Wired when a host signs editor sessions. Every connection must then present
   *  a valid one: the anonymous and share-link paths below are not reachable. */
  editorSessions?: { secret: string; ledger: SessionLedger } | null;
};

export type WriteBarrierReport = WriteBarrier & { flushed: number; flushFailed: number };

/**
 * Wire Hocuspocus to a Node http server. Hocuspocus owns the Yjs sync
 * protocol; we hook lifecycle callbacks into our RoomRegistry (accounting)
 * and DocStorage (persistence). The room id is the document name — clients
 * connect with `new HocuspocusProvider({ url, name: roomId })`.
 */
export function attachHocuspocus(
  httpServer: Server,
  rooms: RoomRegistry,
  storage: DocStorage,
  pathPrefix = '/yjs',
  options: AttachHocuspocusOptions = {},
): {
  hocuspocus: Hocuspocus;
  keeper: RoomKeeper;
  pauseWrites: () => Promise<WriteBarrierReport>;
  resumeWrites: () => Promise<void>;
  close: () => Promise<void>;
} {
  const resolveLinkRole = options.resolveLinkRole ?? null;
  const editorSessions = options.editorSessions ?? null;
  // Assigned just below: it needs the Hocuspocus instance, whose hooks need it.
  let keeper: RoomKeeper;
  // Which socket a request belongs to: a refused client gets its socket closed,
  // and Hocuspocus's auth hook is handed the request rather than the socket.
  const socketsByRequest = new WeakMap<IncomingMessage, WebSocket>();
  // Debounce per-room saves so a rapid burst of edits doesn't hammer Redis.
  // 500 ms feels right for "still feels live, doesn't write on every keystroke".
  const SAVE_DEBOUNCE_MS = 500;
  // Each entry keeps its timer AND a `flush` closure that performs the save
  // immediately — so shutdown (SIGTERM) can drain the queue instead of only
  // cancelling it, which previously discarded the last <500 ms of edits per
  // room on every deploy/restart.
  const pendingSaves = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; flush: () => Promise<void> }
  >();
  const queueSave = (name: string, doc: Y.Doc) => {
    const existing = pendingSaves.get(name);
    if (existing) clearTimeout(existing.timer);
    const flush = async () => {
      pendingSaves.delete(name);
      if (keeper.isDeleted(name)) return;
      try {
        const update = Y.encodeStateAsUpdate(doc);
        await storage.save(name, update);
      } catch (err) {
        console.warn('[hocuspocus] save failed for', name, err);
      }
    };
    const timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    pendingSaves.set(name, { timer, flush });
  };

  const hocuspocus = new Hocuspocus({
    name: 'casual-collab',
    async onLoadDocument({ documentName, document, context }) {
      // 1) If the room was pre-seeded via /api/rooms (xlsx upload path),
      //    apply that first.
      const room = rooms.get(documentName);
      if (room?.seed) Y.applyUpdate(document, room.seed);
      // 2) Restore the latest persisted state from the storage backend.
      const persisted = editorSessions ? await keeper.load(documentName) : await storage.load(documentName);
      if (persisted) Y.applyUpdate(document, persisted);
      // Checked at the door, in onAuthenticate, and checked again here because the
      // stored state can run out between the two. Carrying on would hand this socket
      // an empty document it would take for the real one.
      if (editorSessions && !persisted) {
        (context as { refuse?: () => void } | undefined)?.refuse?.();
        throw new Error('no_state');
      }
      return document;
    },
    /**
     * Server-side view-only enforcement. Until this hook landed, only
     * the client's `applyViewOnlyMode` + Univer's permission gate
     * stopped a view-role joiner from mutating the room — easily
     * bypassed by a crafted client.
     *
     * Hocuspocus's `ConnectionConfiguration.readOnly` flag, when set
     * in `onAuthenticate`, makes the underlying message receiver
     * reject any incoming sync update for that socket. Setting it
     * here is the only authoritative gate we control.
     *
     * Auth otherwise stays open — the room-password gate runs in the
     * upgrade handler (HTTP-level), and Hocuspocus's own auth flow is
     * effectively a no-op for anonymous rooms.
     *
     * Share-token enforcement (sharing-model §6.1): when the join URL
     * carries `?share=<token>`, the server becomes AUTHORITATIVE. We
     * IGNORE the client `?role=` entirely and derive the privilege from
     * the persisted, room-bound token via the pure `resolveJoinRole`.
     * Any token failure (invalid / expired / wrong room / bad share
     * password) THROWS — Hocuspocus turns a throw in onAuthenticate into
     * a closed connection (its `Unauthorized` close), matching the
     * unauthorized pattern the upgrade handler uses for the room
     * password. Without a token we fall through to the EXACT legacy
     * anonymous behaviour below.
     */
    async onAuthenticate({ token: sessionToken, request, requestParameters, connection, documentName }) {
      if (editorSessions) {
        try {
          const claims = verifyEditorSession(sessionToken, documentName, editorSessions.secret);

          // Since this process started, nobody has said what has been taken back.
          if (!editorSessions.ledger.isSynced()) {
            throw new EditorSessionRefused('not_synced');
          }

          if (editorSessions.ledger.isRevoked(claims.sid)) {
            throw new EditorSessionRefused('revoked');
          }

          if (keeper.isDeleted(documentName)) {
            throw new EditorSessionRefused('room_deleted');
          }

          // The host fills a room before issuing a session for it. If nothing is
          // here, it is not this socket's job to start an empty one.
          if (!(await keeper.hasState(documentName))) {
            throw new EditorSessionRefused('no_state');
          }

          connection.readOnly = keeper.writesPaused || claims.perm !== 'edit';

          return {
            role: claims.perm === 'edit' ? 'write' : 'view',
            via: 'editor-session' as const,
            session: claims,
            refuse: () => closeRefused(request),
          };
        } catch (err) {
          const why = err instanceof EditorSessionRefused
            ? err.why
            : err instanceof RoomStorageUnavailable ? 'storage_unavailable' : 'unknown';
          console.warn(`[hocuspocus] refused a connection to ${documentName}: ${why}`);
          closeRefused(request);
          // A plain error: the client learns only that it was refused.
          throw new Error('refused');
        }
      }

      const token = requestParameters.get('share');

      const decision = resolveJoinRole({
        token: token ?? null,
        documentName,
        sharePassword: requestParameters.get('sp') ?? null,
        // No personal store wired (anonymous-only deploy) → no token can
        // be validated, so treat every token as unknown (rejects below).
        lookup: (t) => (resolveLinkRole ? resolveLinkRole(t) : null),
      });

      if ('reject' in decision) {
        // Refuse the connection. Throwing is the documented way to fail
        // Hocuspocus auth; it closes the socket. We deliberately do NOT
        // leak WHICH check failed to the client (all reasons collapse to
        // one error) — only the server log distinguishes them.
        throw new Error(`share-token rejected: ${decision.reject}`);
      }

      if (decision.via === 'share-token') {
        connection.readOnly = decision.readOnly;
        return { role: decision.role, via: 'share-token' as const };
      }

      // ── No token → legacy anonymous path, unchanged. ────────────────
      const role = requestParameters.get('role');
      if (role === 'view') {
        connection.readOnly = true;
      }
      // Returned object becomes `context` on later hooks. Surface the
      // role so logs / metrics can attribute writes correctly.
      return { role: role === 'view' ? 'view' : 'write' };
    },
    /**
     * The one place every message from every socket passes, already connected or not.
     * Worked out afresh each time, so a barrier reaches sockets that were writing when it
     * began, and a session goes back to what its token says when it ends.
     */
    async beforeHandleMessage({ connection, context }) {
      if (editorSessions) {
        connection.readOnly = keeper.writesPaused || (context as { session?: EditorSessionClaims }).session?.perm !== 'edit';
      }
    },
    async onChange({ documentName, document }) {
      queueSave(documentName, document as Y.Doc);
    },
    async onConnect({ documentName }) {
      // Runs before authentication. With sessions in force that is not yet someone
      // who may be counted as in the room, nor allowed to create a registry entry.
      if (!editorSessions) {
        rooms.onConnect(documentName);
      }
    },
    async connected({ documentName, socketId, context, connectionInstance }) {
      if (!editorSessions) {
        return;
      }

      rooms.onConnect(documentName);
      editorSessions.ledger.admit(
        `${socketId}:${documentName}`,
        (context as { session: EditorSessionClaims }).session,
        () => connectionInstance.close(SESSION_ENDED_CLOSE),
      );
    },
    async onDisconnect({ documentName, document, clientsCount, socketId }) {
      editorSessions?.ledger.release(`${socketId}:${documentName}`);
      rooms.onDisconnect(documentName);
      // Snapshot-on-drain: when the last client leaves, run the room's pending
      // debounced save now rather than risking the doc being unloaded before
      // the 500 ms timer fires — otherwise the final edits are lost.
      if (clientsCount === 0) {
        const pending = pendingSaves.get(documentName);
        if (pending) {
          clearTimeout(pending.timer);
          await pending.flush();
        } else if (document && !keeper.isDeleted(documentName)) {
          try {
            await storage.save(documentName, Y.encodeStateAsUpdate(document as Y.Doc));
          } catch (err) {
            console.warn('[hocuspocus] drain save failed for', documentName, err);
          }
        }
      }
    },
  });

  // Messages from a refused socket queue up in memory, and it cannot try again on
  // this socket anyway, so there is no reason to keep it. After a moment, so the
  // permission-denied frame arrives first.
  const closeRefused = (request: IncomingMessage) => {
    const socket = socketsByRequest.get(request);
    const closing = setTimeout(() => socket?.close(SESSION_REFUSED_CLOSE.code, SESSION_REFUSED_CLOSE.reason), 100);
    closing.unref?.();
  };

  keeper = new RoomKeeper(
    storage,
    async (room) => {
      // A document still loading is an empty one that is about to hold something.
      await hocuspocus.loadingDocuments.get(room)?.catch(() => undefined);

      return hocuspocus.documents.get(room);
    },
    async (room) => {
      hocuspocus.closeConnections(room);
      const document = hocuspocus.documents.get(room);
      if (document) {
        await hocuspocus.unloadDocument(document);
      }
    },
  );

  if (editorSessions) {
    void keeper.restoreBarrier();
  }

  /**
   * Refuse every write from now on, then put everything already accepted in the store.
   *
   * An edit is acknowledged only once it is in the open document, and the host reads
   * open documents directly. So every acknowledged edit is in what the host reads after
   * this returns, and everything later is refused, and the sender is told it was.
   */
  const pauseWrites = async (): Promise<WriteBarrierReport> => {
    const barrier = await keeper.pauseWrites();

    // A message that passed the check just before it changed lands on this turn.
    await new Promise((resolve) => setImmediate(resolve));

    for (const [name, pending] of pendingSaves) {
      clearTimeout(pending.timer);
      pendingSaves.delete(name);
    }

    let flushed = 0;
    let flushFailed = 0;

    for (const [name, document] of hocuspocus.documents) {
      if (keeper.isDeleted(name)) {
        continue;
      }

      try {
        await keeper.storeNow(name, Y.encodeStateAsUpdate(document));
        flushed++;
      } catch (err) {
        flushFailed++;
        console.warn('[hocuspocus] could not store a room behind a write barrier', name, err);
      }
    }

    return { ...barrier, flushed, flushFailed };
  };

  /**
   * Allow writes again, and make everyone reconnect.
   *
   * A client whose update was refused has a gap in its history here. Its next update
   * would be acknowledged and then left waiting for the part that was refused. Connecting
   * again is what makes it send everything this side is missing.
   */
  const resumeWrites = async (): Promise<void> => {
    await keeper.resumeWrites();
    hocuspocus.closeConnections();
  };

  // Fastify's WebSocket plugin would also work but we keep dependencies
  // minimal — raw ws + manual upgrade routing.
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const rawUrl = req.url ?? '/';
    if (!rawUrl.startsWith(pathPrefix)) return;
    // Parse query string so the client can authenticate the WS upgrade
    // with `?room=<id>&p=<password>`. Without the room id we can't
    // validate, so we reject — Hocuspocus would otherwise let the
    // connection through and discover the room name from the protocol
    // handshake AFTER we've already accepted.
    const parsed = new URL(rawUrl, 'http://internal');
    const roomId = parsed.searchParams.get('room');
    const password = parsed.searchParams.get('p');
    const passwordBad =
      roomId !== null && rooms.get(roomId) !== undefined && !rooms.passwordOk(roomId, password);
    // Always complete the WS upgrade — even for bad-password rejections.
    // Pre-upgrade HTTP 401 responses surface in the browser only as
    // close-code 1006 ("abnormal"), indistinguishable from network
    // drops, so the client can't tell auth from outage and silently
    // reconnects forever. Completing the upgrade then closing with the
    // app-defined 4401 code gives the client a frame it can route to
    // the password prompt.
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (passwordBad) {
        try {
          // 4401 = app-defined "unauthorized" (RFC 6455 reserves 4000–4999
          // for private use). The client's onClose handler matches on this.
          ws.close(4401, 'unauthorized');
        } catch {
          // Best-effort — if close throws we just drop the socket.
          try {
            ws.terminate();
          } catch {
            /* swallow */
          }
        }
        return;
      }
      handleConnection(ws, req);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  const handleConnection = (ws: WebSocket, req: IncomingMessage) => {
    socketsByRequest.set(req, ws);
    // Hocuspocus expects (websocket, request, context). Context is optional
    // and we don't need auth tokens for anonymous rooms.
    hocuspocus.handleConnection(
      ws as unknown as Parameters<typeof hocuspocus.handleConnection>[0],
      req,
    );
  };

  return {
    hocuspocus,
    keeper,
    pauseWrites,
    resumeWrites,
    close: async () => {
      keeper.stopRestoringBarrier();
      // Drain any pending debounced saves before we tear down — run each save
      // now instead of cancelling it, so the last <500 ms of edits per room
      // survive a SIGTERM / deploy restart.
      const flushes = [...pendingSaves.values()].map(({ timer, flush }) => {
        clearTimeout(timer);
        return flush();
      });
      await Promise.allSettled(flushes);
      httpServer.off('upgrade', onUpgrade);
      wss.close();
      await hocuspocus.destroy();
    },
  };
}
