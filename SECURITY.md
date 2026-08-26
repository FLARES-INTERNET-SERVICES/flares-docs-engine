# Security

## Reporting a vulnerability

Use **[private vulnerability reporting](https://github.com/FLARES-INTERNET-SERVICES/flares-docs-engine/security/advisories/new)**
on this repository. Please do not open a public issue for anything exploitable.

That route is preferred because it exists as long as the repository does and it
does not depend on a mailbox staying staffed. If you cannot use it, mail
`security@flaresinc.com`.

Include enough to reproduce it — a document, a sequence, a request. If you have
a proof of concept, say what it does before attaching it.

What to expect:

| | |
| --- | --- |
| Acknowledgement | within 3 working days |
| Initial assessment | within 10 working days |
| Fix or mitigation plan | agreed with you before disclosure |

We will credit you when the fix ships unless you would rather we did not.

This repository is a fork. A vulnerability that originates upstream will be
reported to [CasualOffice/docs](https://github.com/CasualOffice/docs) and, where
relevant, [eigenpal/docx-editor](https://github.com/eigenpal/docx-editor), and we
will tell you when we do that so you can decide how to coordinate.

## Scope

In scope: this repository — the editor, the collaboration server, the room and
session model, and document parsing.

Out of scope: anything about a particular deployment of it. If you have found
something in a Flares service rather than in this code, the same address
reaches us, but it is not a repository issue.

## What this project relies on you to do

The editor cannot enforce what it cannot see. A deployment is responsible for:

- **Authorization.** Room ids are unguessable, which is not the same as being
  secret and is not the same as being permission. Decide who may open a
  document before issuing a token; the editor trusts the token because only you
  could have minted it.
- **Setting `CASUAL_JWT_SECRET`.** Without it, room initialisation keeps the
  original open behaviour — appropriate for a local scratch instance and for
  nothing else. Anyone who learns a room id can then replace the document every
  participant is about to open.
- **Running one collaboration node**, or pinning rooms to nodes with sticky
  sessions. Two nodes serving one room do not just fail to sync; the later one
  to drain overwrites the earlier one's work, silently. See the README.
- **Treating uploaded documents as untrusted input.** They are parsed
  client-side and malformed ones fail safely, but a document is a file from a
  stranger and deserves the limits you would put on any other upload.

## What this project does

- Room initialisation requires a signed, room-bound, single-use capability
  token, and refuses a second attempt even with a valid one.
- Viewer permission is enforced at the socket. A read-only participant's
  updates are refused by the server, not hidden by the interface.
- Session tokens carry the minimum a generic collaboration service needs: a
  room, a permission, an opaque user id and a display name. No email address,
  no role, no host-internal identifier.
- Malformed and hostile documents — truncated archives, non-archives, highly
  compressible payloads, macro-bearing files — are rejected or absorbed without
  crashing the editor, and macros are never executed.
