# Release notes policy

Every fixed version gets a lower-case `v` + semantic-version tag, a Gitea Release, immutable assets and a `SHA256SUMS` file. Release notes describe consumer impact; they are not a commit log.

## Required structure

```markdown
# vVERSION

## Highlights
- One to three user-visible outcomes.

## Upgrade
- Required actions, breaking defaults and migration constraints.

## Added / Changed / Fixed
- Grouped entries with the affected entry point and exact commands or files.

## Verification
- Focused tests, full offline suite, release build, plugin gate and structure gate.
- Live evidence, when claimed, must name its exact scope; offline tests are not live evidence.

## Rollback
- `install.sh --rollback`, the previous verified version and any state migration required.
```

Keep the Chinese and English README structures synchronized when a release changes installation or usage.

## Evidence wording

- Say “configuration-level verified” for adapter/config tests; do not imply actual host loading.
- Say “protocol-only” for bounded initialize/tools/list; actual host reconnection is separate evidence.
- Say “offline regression” for fake servers and temporary homes; do not call it live browser/account validation.
- A 200 response does not prove reasoning effort, model identity or gateway session affinity.
- `complete: false` means terminated but truncated; it is not proof that a send failed.
- Pending reconciliation is not automatic retry.

## Publication gates

1. `npm test`
2. `npm run build:release`
3. `npm run build:plugin && npm run verify:plugin` when plugin/runtime payload changes
4. `npm run verify:structure`
5. `git diff --check`
6. Asset allowlist, manifest and SHA-256 verification
7. Post-install `--status`, `--help` and one representative host check in an isolated temporary home

The development repository and private Git source remain development-only. Consumers must install immutable Release assets outside the repository. Publication to GitHub additionally requires explicit project-level authorization, a clean allowlisted public tree and a privacy gate.
