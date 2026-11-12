# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every version must also publish a Gitea Release note following [docs/release-notes.md](docs/release-notes.md).

## [Unreleased]

## [0.2.18] - 2026-11-12

### Fixed

- Concurrent sends on different aliases queue inside the process instead of racing the shared state lock; the lock wraps only the short `sessions.json` / `api-sessions.json` read-modify-write transactions, completion writes re-read and merge per alias, and only truly nested lock calls report `BUSY`. The same alias still keeps a single durable pending send.
- Native recovery rechecks the server branch identity at the click boundary; uncertain identity keeps the held draft instead of submitting to the wrong conversation.
- `publish-gitea-release.mjs --notes-file` refuses non-UTF-8 or oversized notes before any network call.

## [0.2.17] - 2026-11-12

### Fixed

- Web model selection now treats `aria-expanded` as the authoritative menu state, supports menus that retain selected options after closing, and uses `readyTimeoutMs` with a bounded CDP margin instead of racing two equal ten-second timeouts.
- Native webpage sends now wait for a temporarily disabled send control, recheck the server branch before each click, and preserve the held draft and pending marker if it never becomes usable; successful waiting recovery reports `autoRecovered: true`.
- Verified live: model selection and native submission completed on `claude-opus-5-5` with `complete:true` and `pending:null`.

## [0.2.16] - 2026-11-11

### Added

- Primary live evidence now interrupts the real `ask --native` send immediately before its click evaluate and recovers the product-generated held draft through the production CLI; the earlier CDP-typed staged probe remains supplementary.
- Bilingual repository READMEs, a progressive introduction, repository metadata guidance and release-note policy.
- Public sanitized protocol-boundary notes for the Claude web channel and generated-file evidence.
- Community and release documentation: license, contribution guide, security policy and code of conduct.
- Gitea issue forms and pull-request template.
- A green `--check --probe` reports `reconnectCleared` and `reconnectMarker`, making a skipped or failed runtime marker cleanup observable.
- A green-but-incomplete probe also emits a top-level `warning` when marker cleanup could not complete.

### Changed

- Repository documentation now distinguishes development source, immutable Release consumption, offline evidence and live evidence.
- Release documentation payload includes the community and protocol files linked from the README.
- Both `--status` commands read `reconnect-required` through the bounded, single-link regular-file guard shared with the installer.
- Gitea Release publication writes a bounded `--notes-file` to the Release body instead of accepting and ignoring it.
- Gitea Release publication accepts `--credential-helper` as an explicit opt-in `git credential fill` fallback with a working stdin query and custom-port support.

### Fixed

- Release and plugin builds now fail closed on sensitive content in publishable payloads, and released artifacts accept any `/home/<user>/` sandbox path instead of a fixed username.
- `--credential-helper` now writes its query to the child's stdin instead of passing an unsupported `input` option to async `execFile`.
- Reconnect-marker identity checks include `ctimeMs` in both strict read and pre-unlink verification.
- A native send interrupted between filling the composer and clicking send no longer wedges the session: the `send` pending marker is written before the prompt reaches the page, and `transcript --recover` verifies the held draft's text and attachment identities against the pending record and completes that one submission instead of deadlocking on `PENDING_TURN`.
- `native-resume` now also accepts a `pending.kind === 'send'` native session: after the same prompt digest and attachment identity checks it completes that one recorded submission exactly once, refilling consumed text drafts but never re-uploading missing attachment chips. `transcript --recover` remains the read-only reconciliation path; `native-resume` is the explicit operator escape hatch when the held draft can no longer be auto-verified.
- A turn whose assistant terminates with `user_canceled` now reconciles as settled (terminated but incomplete, `complete: false`) and allows a follow-up from that leaf, instead of wedging the alias on `PENDING_TURN` forever. `transcript --recover --discard-pending` now also works for native sessions: it explicitly abandons an unrecoverable pending and re-anchors the alias to the current server leaf without sending anything.
- `transcript --recover` now waits briefly for a restored held draft to mount in a freshly navigated Claude tab before proving it against the pending digest; an empty editor seen during asynchronous restore no longer causes a false `UI_DRAFT_CONFLICT`.
