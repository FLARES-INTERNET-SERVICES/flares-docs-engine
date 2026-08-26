# Patches carried by this fork

Every divergence from upstream `CasualOffice/docs`, why it exists, and what
would happen if it were dropped. Five of the seven are generic fixes intended
to go back upstream; the notes say which and why.

**Baseline:** `7b03e1113244130375b69ce4258744d097252917` (2026-07-08), the
revision inside app image `casualoffice/docs@sha256:0f9892411476f45a…`
(version 0.0.5). The collab server is that image's vendored
`@casualoffice/collab@0.1.0`.

**Totals:** 7 patches · 10 files · **541 lines added, 31 removed**
(client 262/18 across 6 files; server 279/13 across 4, including
`seed-token.ts` as a new 134-line file).

**Editor engine (`@eigenpal/docx-core`): 1 patch, 15 lines.** The CRDT,
the ProseMirror schema and the layout engine are untouched.

| | Patch | Area | Files | +/− | Upstreamable |
| --- | --- | --- | --- | --- | --- |
| **P001** | Collaboration bootstrap | client app | 2 | +150 / −1 | yes |
| **P002** | `claim-init` arbitration | collab server | 2 | +70 / −0 | yes |
| **P003** | Seed authentication | collab server | 2 | +200 / −1 | yes |
| **P004** | Analytics removal | client app | 1 | +5 / −9 | no (their site) |
| **P005** | Durable room metadata | collab server | 3 | +120 / −2 | yes |
| **P006** | Image duplication on export | **editor core** | 1 | +15 / −0 | yes, strongly |
| **P007** | Comment threads never shared | client + package | 2 | +30 / −0 | yes |
| **P008** | Documents named by their room id | collab server | 2 | +40 / −2 | yes, strongly |
| **P009** | Embedded editor draws a second title bar | editor package + app | 3 | +28 / −6 | yes |

---

## P001 — Collaboration bootstrap

**Files:** `examples/vite/src/App.tsx`, `packages/react/src/collab/useCollab.ts`

**Why.** Imported Word documents never reached the shared state, so every
participant — including the author — landed in a blank room. When the DOCX
parse completed, `HiddenProseMirror` built a fresh `EditorState` and called
`updateState()`; prosemirror-view re-initialised every plugin view, and
`ySyncPlugin`'s init ran `_forceRerender()`, replacing the just-parsed
document with the (empty) Y fragment. The blank paragraph left behind was then
published to everyone as canonical.

**What it does.** The host parses the room's seed `.docx` once, passes it to
the editor as its base `document` with `externalContent` so Yjs owns the body,
and — if it wins the `claim-init` arbitration — converts it with `toProseDoc`
and dispatches it into the live view as an ordinary transaction. ySyncPlugin
broadcasts it like any other edit. `useCollab` gains a `ydoc` field so the host
can tell an empty room from a populated one.

**If dropped:** imported documents do not collaborate at all. This is the
patch the whole thing rests on.

**Tests:** `imported-docx-collaboration.mjs` (21 checks × 4 fixtures),
`multiuser.mjs`, `robustness.mjs` join storm.

**Upstream note.** Fixes upstream's own stated intent — their comment claims
"the first joiner's PM → Y.Doc capture wins", which `_forceRerender()` prevents
from ever happening. Worth a maintainer conversation about whether the logic
belongs in `useCollab` rather than the example app. Upstream has since added a
`synced` flag to `useCollab` with a comment describing the same hazard, so they
are working in this area.

---

## P002 — `claim-init` arbitration

**Files:** `collab/src/rooms.ts`, `collab/src/index.ts`

**Why.** Every joiner downloads the same seed `.docx`, so without a referee
each would publish its own copy and the room would hold the document N times.

**What it does.** `RoomState` gains `initializedAt`. `claimInitialization()`
returns true for exactly one caller — check and set are adjacent with no
`await` between them, which is what makes the pair atomic under Node's
run-to-completion. Exposed as `POST /api/rooms/:id/claim-init`.

**If dropped:** duplicated documents under any concurrent join.

**Tests:** `seed-security.mjs` (20 concurrent claims → exactly 1 winner),
`robustness.mjs` (20 real browsers → one copy).

---

## P003 — Seed authentication

**Files:** `collab/src/seed-token.ts` (new), `collab/src/index.ts`,
`examples/vite/src/collab/Share.tsx`

**Why.** `POST /api/rooms/:id/seed` took **no credential**. Anyone who learned
a room id — from a share link, chat, browser history, an access log, or
`GET /api/rooms` — could replace the document every participant was about to
open. Upstream's comment argued the window was theoretical because only the
owner knows a fresh id; true for an instant, false forever after.

**What it does.** Room creation mints an HS256 capability token bound to that
room, that operation (`initialize_room` + `can_seed`), and a 5-minute window.
`/seed` requires it and accepts it once — upstream documents the route as
"idempotent — re-uploading replaces", which for a shared document is the
vulnerability rather than the feature. Every failure collapses to one
undifferentiated 401; the reason goes only to the server log.

Falls back to the original open behaviour when no `CASUAL_JWT_SECRET` is
configured, so anonymous self-hosted deployments are not broken.

**If dropped:** documents can be silently replaced by anyone with the room id.

**Tests:** `seed-security.mjs` — 13 checks (no token, wrong room, tampered
payload, wrong key, `alg:none`, expired, wrong capability, valid, replay).

---

## P004 — Analytics removal

**File:** `examples/vite/index.html`

**Why.** The app shell loads Google Analytics (`G-1CDWFLK79M`) and calls
`googletagmanager.com` / `google-analytics.com` on every page load. For an
editor whose users may be children, that is not acceptable regardless of what
the data is used for.

**If dropped:** every page view is reported to Google.

**Tests:** `privacy-and-regressions.mjs` — the patched build makes zero
tracker requests; the shipped build makes two.

**Not upstreamable.** It is their own demo site's analytics, on their own
domain. The real fix for a packaged product is not to ship the demo shell.

---

## P005 — Durable room metadata

**Files:** `collab/src/storage.ts`, `collab/src/rooms.ts`, `collab/src/yjs.ts`

**Why.** Y.Doc state persisted to Redis and survived restarts — but the room
registry did not. Clients bootstrap by fetching `/seed` before connecting, so
after a restart the document sat in storage perfectly intact and completely
unreachable: `/seed` answered 404 and the editor never mounted.

A second, subtler bug sat behind it. `onConnect` fabricates a bare room for any
websocket carrying an unknown id — which, after a restart, is every
reconnecting client. That placeholder has no seed, and because clients open
their websocket *before* fetching `/seed`, it was already in the map by the
time the fetch arrived, shadowing the durable copy permanently.

**What it does.** `DocStorage` gains `saveRoom`/`loadRoom` (separate keys: the
seed can be tens of megabytes, the metadata a few hundred bytes). The registry
gains `rehydrate(id)`, which HTTP handlers and `onLoadDocument` call on a miss,
and which treats a live-but-seedless entry as a placeholder to fill rather than
an answer. The synchronous `get()` hot path is untouched.

**If dropped:** every server restart orphans every live document.

**Tests:** `durability.mjs` — 10 checks including SIGKILL and recovery.

---

## P006 — Image duplication on export

**File:** `packages/core/src/docx/rezip.ts` — **the only editor-core change**

**Why.** Exported documents grew by one copy of every image on every
save-and-reopen cycle: 137 KB → 237 → 337 → … → 1130 KB over ten rounds, a
flat +99 KB each time. For the 14 MB fixture that was +14.4 MB per round.
Linear, not geometric — but unbounded either way, and enough on its own to
fail this gate.

`collectNewImages` decides an image is "newly inserted" purely from its `src`
starting with `data:` — which is true of *every* image the parser has decoded
for rendering, not just inserted ones. Any client whose content came from Yjs
rather than its own parse therefore re-registered every picture on export,
writing a byte-identical second copy and orphaning the first.

**What it does.** Four lines: if the image's `rId` already resolves in the
part's relationships, the bytes are present and the reference is correct —
skip it.

**If dropped:** documents grow without limit. `137 KB → 1130 KB` in ten saves.

**Tests:** `roundtrip-growth.mjs` (flat across 10 rounds),
`export-anatomy.py` (media count and hashes vs the original).

**Upstream note.** The strongest upstream candidate of the six: a small,
general serializer-correctness fix with no Flares specificity, and single-user
saves are unaffected either way.

---

## P007 — Comment threads never shared

**Files:** `examples/vite/src/App.tsx`, `packages/react/src/index.ts`

**Why.** A teacher could write a comment and nobody else would ever see it. It
did not reach the other collaborator, did not survive a reload, and did not
appear in the exported `.docx` — so feedback written in Flares would have been
invisible to everyone else and absent from the exported file.

Nothing was missing from the engine. Upstream ships `collab/commentSync.ts` —
`commentsFromMap` / `writeCommentsToMap` / `observeComments`, with its own test
file — and `useCollab` already exposes the `commentsMap` it operates on.
`CasualEditor`, the SDK's own wrapper, wires them correctly. The example app,
which is what actually ships as the web application, simply never called any of
it, and the helpers were not exported from the package for a host to call
either.

**What it does.** Exports the three helpers from the package barrel (beside
`useCollab`, which was promoted the same way), and drives the editor's
controlled `comments` from the shared map in `CollabApp`, reconciling changes
back through `onCommentsChange`.

**If dropped:** comments are single-user scratch notes that vanish on reload.

**Result.** Threads reach the shared room state, survive reload, and export as
real OOXML — `word/comments.xml` plus `commentsExtended`, `commentsIds` and
`commentsExtensible`. Microsoft Word reads the comment back.

**Tests:** `comments.mjs` — 9 checks.

---

## P008 — Documents named by their room id

**Files:** `collab/src/rooms.ts`, `collab/src/index.ts`

**Why.** A user's document appeared in the editor titled `qd1ermqed8h7`. The
client asks for the document's name via `Content-Disposition` on the seed
response and falls back to `${room}.docx` when it is absent — and the server
never sent one, so every document was named after an internal identifier.

Two things were wrong, and fixing only the first looks like it works:

1. The server did not record the filename the seed was uploaded under, and did
   not send `Content-Disposition` when serving it back.
2. `Content-Disposition` is **not a CORS-safelisted response header**. Sending
   it is not enough — a cross-origin client cannot read it without
   `Access-Control-Expose-Headers`. An editor embedded on its own origin (the
   normal deployment) therefore still saw nothing.

**What it does.** Records `seedFileName` on the room, carries it through the
durable metadata so it survives a restart, returns it as `Content-Disposition`
(RFC 5987 form, so non-ASCII names survive), and exposes the header to
cross-origin readers.

**If dropped:** every document is named after a room id.

**Upstream note.** A strong candidate: the client-side parsing already exists
and has simply never had anything to parse.

---

## P009 — Embedded editor draws a second title bar

**Files:** `packages/react/src/components/features.ts`,
`packages/react/src/components/DocxEditor.tsx`,
`examples/vite/src/App.tsx`

**Why.** A host that embeds the editor generally has its own title bar and its
own save indicator — one that knows whether the document actually reached
storage, which the editor's local dirty flag does not. Both were drawn, one
above the other, saying opposite things: the host reporting the document saved
while the editor reported unsaved changes, on the same screen, about the same
document.

There was no way to turn the editor's off. `chrome: 'none'` exists but takes
the toolbar with it, and the toolbar is the reason to embed an editor.

**What it does.** Adds a `titleBar` feature id alongside the existing chrome
regions, defaulting to on. When a host disables it, the document name, the
save indicator and the presence slot are hidden — and the **menu bar stays**,
because a host supplying its own title bar still needs File and Insert. The
example app reads `?chrome=minimal` to request it.

**If dropped:** two contradictory save indicators on one screen.

---

## Fork burden: **LOW**

Rebased onto `origin/main` at `d1160518` — **72 upstream commits touching
`docx-editor/`, four weeks later — with zero conflicts.** Of the six patched
files, only two had any upstream activity (`App.tsx`, `useCollab.ts`).

The rebased result is kept on branch `flares-repair-on-latest` for inspection;
the gate itself was measured against the pinned baseline.

Two things to watch:

- **`useCollab.ts` is moving.** Upstream added `y-indexeddb` persistence and a
  `synced` flag since the baseline. That is the file P001 touches, and the
  overlap is conceptual as well as textual — if upstream fixes the bootstrap
  themselves, P001 should be retired rather than merged.
- **The editor core is churning fast** (72 commits/month), but P006 is four
  lines in a stable serializer path.
