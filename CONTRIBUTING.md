# Contributing

This is a fork, and it stays small on purpose. The most useful thing you can
know before opening a pull request is which of three places your change
belongs.

## Where does this change go?

**Upstream, probably.** Most editor and collaboration fixes belong to
[CasualOffice/docs](https://github.com/CasualOffice/docs) or
[eigenpal/docx-editor](https://github.com/eigenpal/docx-editor). Landing them
there means everyone gets them and this fork gets smaller. If you are not sure,
open an issue here and we will help work out where it goes.

**Here**, if it is a generic fix this fork is carrying — collaboration
bootstrap, room security, export correctness — or if upstream has declined it
and it matters.

**Not here**, if it teaches this repository about a particular product's
domain. The test is one question:

> Would this still make sense to someone using the editor with a completely
> different identity system, storage and permission model?

If yes, it may belong here. If it only makes sense because of how one company's
platform works, it belongs in that company's own code — including ours.
Concretely: `authorizeRoom(token)` and `deduplicateExportedImages()` are fine;
anything named after a school, an assignment, a bucket or a billing plan is not.

## Before you open a pull request

```bash
bun install
bun run typecheck
bun test                          # unit
npx playwright test --grep <area> # the area you touched
```

Run the full Playwright suite only when you are finishing — it is 500+ tests
and running it casually wastes your afternoon.

### Regression tests we will not merge without

Four bugs in this project were serious, silent, and easy to reintroduce. Each
has a test, and a change that breaks one needs a better argument than "the test
is old":

| Test | What it stops coming back |
| --- | --- |
| `imported-docx-collaboration` | A shared document arriving blank for everyone but the person who shared it. |
| `roundtrip-growth` | Exported files growing by one copy of every image on every save. |
| `durability` | A restart orphaning every live document. |
| `seed-security` | Anyone with a room id replacing its starting document. |

## What a good pull request looks like

- **One change.** A fix and a refactor in the same diff means neither can be
  reviewed properly.
- **A test that fails before it.** If the bug is hard to reproduce, say so and
  describe what you did instead — an honest gap is more useful than a test that
  passes for the wrong reason.
- **A plain description of the cause.** Not just the symptom. Half the bugs
  here were misdiagnosed at least once, and a PR that explains the mechanism is
  worth several that say "fixes rendering".
- **Comments where the reasoning is not obvious.** Especially in the
  collaboration bootstrap, where the correct code looks wrong and the obvious
  code is subtly broken.

## Testing notes, learned the hard way

The editor renders **twice**: a hidden ProseMirror that owns editing state, and
a painted layer the user sees. Driving the hidden one directly does not
establish a real selection — a test that focuses a hidden `<td>` and presses
Tab is testing nothing, because no row is added. Click the painted cell.

Other traps that produced confident, wrong results:

- `fragment.length === 0` is not "empty room". An unseeded room reports 1: the
  sync plugin publishes the editor's empty starting paragraph as soon as it
  binds.
- `innerText` on the editing surface includes presence decorations. Remote
  carets carry peer names, so two clients that have converged compare unequal.
- Playwright's `keyboard.type` reaches only the focused page. Firing concurrent
  edits with `Promise.all` silently drops every edit but one.
- Judge export growth by absolute size, not ratio. A file gaining a fixed
  amount each round shows a *decaying* ratio and looks like it is settling.

## Licence

Apache-2.0 for the repository, MIT for `docx-editor/`. By contributing you
agree your work is licensed under the terms covering the files you touched.
Do not add code you cannot license that way, and do not remove or alter
copyright notices — the attribution chain in [NOTICE](NOTICE) is what makes
this fork legitimate.
