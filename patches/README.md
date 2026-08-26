# Patches to the collaboration server

The collaboration server is not part of this repository. It is the `collab`
git submodule, pointing at [`CasualOffice/collab`](https://github.com/CasualOffice/collab) —
a repository this fork does not own. Five of the fork's patches change it, so
they are carried here as a diff and applied to the submodule by `setup.sh`.

This is not a tidiness detail. Without them a clone of this repository gets
the client-side fixes and an **unpatched server**, which means:

- `POST /api/rooms/:id/seed` accepts anyone (P003). A room id is a URL, and
  URLs get shared, logged and guessed; unauthenticated seeding lets anyone who
  learns one replace the contents of a document being written.
- a room whose server restarted comes back empty (P005);
- a document downloads under its room id instead of its name (P008);
- the editor origin sends no Content-Security-Policy (P012).

`PATCHES.md` in the repository root explains each in full.

## Applying them

`./setup.sh` does this for you. By hand:

```bash
git submodule update --init --recursive
git -C collab apply --check ../patches/collab-server.patch   # dry run first
git -C collab apply ../patches/collab-server.patch
```

`--check` first, always: if upstream has moved under the patch, you want to
know that before your working tree is half-modified.

## When it stops applying

That is the fork burden becoming visible, and it is the signal to look
upstream rather than to force the patch. Every one of these except the CSP
policy is written to be contributed back; if upstream has fixed the same
problem their own way, the right move is to drop ours, not to reconcile two
fixes for one bug.

Regenerate after changing the submodule's working tree:

```bash
git -C collab diff > patches/collab-server.patch
```
