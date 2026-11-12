# Contributing to claude-web-api

Thank you for considering a contribution. This repository develops on a private Gitea instance; a future public snapshot requires separate, explicit authorization and privacy review. Until then, use the private Gitea issue or pull-request channel and do not publish a copy yourself.

This project is noncommercial software. Contributions are accepted under [PolyForm Noncommercial 1.0.0](LICENSE) without additional terms; commercial deployment requires separate written authorization from the maintainer.

## Ground rules

- Treat Claude or other model output as untrusted advice. You remain responsible for every claim, diff and test result.
- Do not commit credentials, cookies, API keys, account UUIDs, private endpoints, user data, session transcripts, logs, caches, raw uploads or screenshots.
- Do not run live browser, account or external-network experiments unless a task explicitly grants that scope.
- Do not point production hosts at a development worktree, `dist/`, a temporary clone or a source package.
- Prefer a reversible fix backed by a focused test. Avoid unrelated refactors and speculative features.

## Development setup

Requirements:

- Node.js >= 22
- Git
- `codex` on PATH for `npm run verify:plugin`
- No network account is needed for the offline test suite

```bash
npm ci
npm test
npm run build:release
npm run build:plugin
npm run verify:plugin
npm run verify:structure
```

`npm test` runs offline against temporary HOME/CODEX_HOME directories, in-memory services and fake CDP/WebSocket servers. It must not touch your real browser, Claude account, personal host configuration or installed skills.

## Change checklist

1. Reproduce the defect with the narrowest existing or newly added focused test.
2. Fix the root cause and keep the runtime boundary unchanged unless the issue is architectural.
3. Update consumer documentation when behavior, defaults, evidence layers, protocols or installation ownership changes.
4. Run the focused test first, then the affected integration test, then `npm test`.
5. Run `npm run verify:structure` after adding or moving tracked files; use `git add -N` for new files before `npm run verify:structure -- --write`.
6. Check `git diff --check` and review the patch for private data before requesting review.

## Pull requests

Please use the repository pull-request template and state:

- the user-visible defect or goal;
- the smallest useful change;
- focused and broad verification already run;
- documentation and Release payload changes;
- privacy or authorization implications;
- rollback strategy.

For release work, also record the version, immutable asset names, SHA-256 verification, target Gitea Release, and the exact install/rollback observations required by [docs/release-notes.md](docs/release-notes.md).

## Security issues

Do not open a public issue for a vulnerability, credential leak, browser-session bypass or unsafe file handling. Follow [SECURITY.md](SECURITY.md).
