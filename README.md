# Flares Docs Engine

A collaborative `.docx` editor: real Word files, edited by several people at
once, saved back as real Word files.

**Flares Inc. did not write this engine.** It is a fork of
[CasualOffice/docs](https://github.com/CasualOffice/docs), which is itself a
fork of [eigenpal/docx-editor](https://github.com/eigenpal/docx-editor). What
Flares added is a small set of collaboration, security and correctness fixes,
listed in [PATCHES.md](PATCHES.md) and mostly intended to go back upstream. See
[NOTICE](NOTICE) for the full lineage and [LICENSE](LICENSE) for terms.

Flares maintains this fork because Flares Docs is built on it. It is published
because the fixes are generic, and because a dependency you cannot read is a
dependency you cannot trust.

---

## What it is

- **Real OOXML.** Documents are parsed into a Word-shaped model — tables,
  merged cells, images, headers, footers, sections — and written back to it.
  Files exported from here open in Microsoft Word without a repair prompt.
- **Real collaboration.** Yjs CRDT over Hocuspocus. Several people edit at
  once, offline edits merge on reconnect, and the document converges.
- **No backend requirement for the editor.** The editing surface is
  client-side. The collaboration server is a separate, small Node service.

## What it is not

- Not a Flares product. It knows about documents, rooms, users and
  permissions. It does not know what a school, a student or an assignment is,
  and nothing in it should.
- Not a Google Docs replacement. Comments and suggesting mode exist; tracked
  changes under concurrent editing is not proven.

---

## Running it

Requires [Bun](https://bun.sh) and Docker.

```bash
git clone https://github.com/flaresinc/flares-docs-engine.git
cd flares-docs-engine
./setup.sh --in-place        # submodules, dependencies, .env.local
```

Two processes — the collaboration server and the editor:

```bash
docker compose up -d redis app          # collaboration + Redis
cd docx-editor && bun run dev           # editor on :5173
```

For anything performance-related, measure the production build rather than the
dev server. Vite serves roughly a thousand unbundled modules in development;
cold load there is several times slower than the real thing and is not a
product number.

```bash
cd docx-editor && bun run build:demo
```

### Why `setup.sh` exists

The repository does not build from a plain `git clone`, and rather than leave
that to be rediscovered the script handles it:

1. `docx-editor/vendor/design-system` is declared as a submodule with an **SSH**
   URL, so anyone without a key on that account gets an empty directory and a
   build that fails on an unresolved import. The repository is public over
   HTTPS; the script rewrites the URL for that one command.
2. **`katex`** is imported by the editor but not installed by the workspace
   resolve, so Vite's dependency scan fails without it.

---

## Architecture

```
      Browser
         │
   ProseMirror  ◄──►  canonical OOXML document model
         │
   y-prosemirror
         │
       Y.Doc  ◄──►  HocuspocusProvider  ──── websocket ────┐
                                                            │
                                              Collaboration server
                                                (Node, Fastify)
                                                            │
                                              ┌─────────────┴──────────┐
                                              │                        │
                                            Redis                  Host storage
                                         (hot state)            (durable, yours)
```

The document model is the source of truth and ProseMirror is a projection of
it — which is why round-trips preserve things the editing schema does not
model, like section properties and header parts.

### Collaboration bootstrap

The part most likely to surprise you, and the reason for the largest patch in
this fork. An imported `.docx` has to *become* the room's shared state, once:

1. A room is created and the starting `.docx` is uploaded to it.
2. Every joiner downloads that same file.
3. **One** of them — chosen by `POST /api/rooms/:id/claim-init`, which returns
   `won: true` to exactly one caller — converts it and dispatches it into the
   live editor as an ordinary transaction. Yjs broadcasts it like any edit.
4. Everyone else takes the shared state and leaves their local copy alone.

Without the arbitration in step 3, every joiner publishes its own copy and the
room ends up holding the document N times over.

---

## Integrating it

The editor is deliberately ignorant of who you are. It needs four things from a
host, and nothing else:

| It needs | It does not need |
| --- | --- |
| a document (`.docx` bytes) | where you keep it |
| a room id | what the document is *for* |
| a user's display name and colour | their email, role or account |
| a permission: `edit` or `view` | why the answer was yes |

Authorization is the host's job and happens before the editor is involved.
The host issues a short-lived token naming the room, the permission and an
opaque user id; the collaboration server verifies it and enforces the
permission at the socket. A viewer's updates are refused there — not by hiding
toolbar buttons.

```
your identity system  →  your authorization  →  short-lived token
                                                       │
                                                       ▼
                                              editor + collab server
```

A host with a completely different identity system, storage and permission
model can use this without changing the editor. That is the test any change to
this repository should be held to: *would this still make sense to someone who
has never heard of the maintainer?*

### Serialization

The collaboration server can turn a room's state back into a `.docx` on
request, which is how a host stores a snapshot without running a browser.

---

## Security model

- **Room ids are not authorization.** They are unguessable, which is not the
  same thing. Access is decided by a token the host issues.
- **Room initialisation is a capability.** Setting a room's starting document
  requires a signed, room-bound, single-use token. Without it, anyone who
  learned a room id could replace the document every participant was about to
  open.
- **Viewer enforcement is server-side.** Set `readOnly` on the connection and
  the socket refuses updates.
- **Set `CASUAL_JWT_SECRET`.** Without it the initialisation endpoint keeps its
  original open behaviour, which is only appropriate for a local scratch
  deployment.

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

---

## Deployment

**Run one collaboration node.** Hocuspocus keeps an in-memory document per room
*per process*, and nothing bridges two processes unless you add a synchronising
extension. Two nodes serving the same room do not merely fail to sync — the
later one to drain silently overwrites the earlier one's work.

Either run a single writer, or pin every room to one node with sticky sessions,
until [`@hocuspocus/extension-redis`](https://www.npmjs.com/package/@hocuspocus/extension-redis)
(or equivalent) is wired in. `tests/multinode` demonstrates the failure and is
expected to fail until then.

**Redis is hot state, not storage.** It holds live rooms and expires them.
Anything you would be upset to lose belongs in a durable store behind the
persistence hook.

---

## Known limitations

- **Single collaboration node** (above).
- **Touch is unverified.** Every viewport from 1920 down to 390 px renders and
  accepts typing, but no test has been run on real touch hardware: caret
  placement, selection handles, the on-screen keyboard and pinch-zoom are
  unproven.
- **Google Fonts.** The default build fetches fonts from Google. Self-host them
  for any deployment where that matters.
- **Tracked changes** exists as a mode; its behaviour under concurrent editing
  is not proven.
- **The bundle is large** — roughly 4 MB gzipped, of which the on-device AI
  writing feature is the majority. It loads lazily, but it is installed for
  every consumer.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Fixes that make sense for any host are
welcome; anything that teaches this repository about a particular product's
domain is not.

Upstream issues generally belong upstream:
[CasualOffice/docs](https://github.com/CasualOffice/docs/issues) or
[eigenpal/docx-editor](https://github.com/eigenpal/docx-editor/issues).

## Licence

Apache-2.0 for the repository; MIT for `docx-editor/`, from its upstream. Both
licences and the full attribution chain are in [LICENSE](LICENSE),
[docx-editor/LICENSE](docx-editor/LICENSE) and [NOTICE](NOTICE).

---

*Upstream's own README is preserved at [README.upstream.md](README.upstream.md).*
