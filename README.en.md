# claude-web-api

Let agent hosts consult Claude through a local browser session with continuous follow-up conversations.

**English** · [简体中文](README.md)

`claude-web-api` turns one external consultation into an auditable loop: a host assembles authorized context, sends it through MCP, CLI or the skill, a local bridge reads the reply from an owned background tab, and an alias keeps follow-ups together. Execution and verification stay with the current host. This is neither an official SDK nor a stable public API; it supplies no event hooks and does not create user authorization for external consultation.

**This project provides no event hooks.** Within existing user authorization, the host proactively assesses planning, hard problem-solving and complex reasoning; semantic matching is not a deterministic trigger. The prompt must give sufficient but lean context (about 8 KiB by default) and explicitly require ultrathink reasoning, file-level guidance, an aggressive root-cause solution and a justified revision of any unreasonable verification gate with criteria and rollback; then include a preferred solution, prerequisites, ordered concrete steps, exact commands, success observations, failure handling and end-to-end verification. `--guidance` / `guidance: true` appends a fixed block only when no guidance marker exists; the default leaves the prompt unchanged and reports `guidanceAppended`. An older or incomplete marker is not repaired automatically. Every executable step labels facts `已核验` or `需本地核查`; decisions name a falsifiable point, rejected alternatives and switch conditions. See the [fixed guidance block and CLI example](docs/usage.md#可执行端到端指导).

Contents: [Documentation](#documentation) · [Requirements](#requirements) · [Setup](#setup) · [Limitations](#limitations)

## Documentation

| Goal | Start here |
|---|---|
| Understand the problem and when not to use this bridge | [Progressive introduction](docs/introduction.md) |
| Install, upgrade or roll back from a trusted Release | [English installation guide](docs/install.en.md) / [中文](docs/install.md) |
| Let an LLM follow the installation boundary | [llms.txt](llms.txt) |
| Look up commands, attachments, recovery, locks and evidence | [Usage guide](docs/usage.md) |
| Check fallback HTTP fields and limits | [API protocol reference](docs/api-protocols.md) |
| Understand the web channel and artifact boundary | [Web protocol summary](docs/claude-web-protocol.md) / [artifact mechanism summary](docs/claude-design-protocol.md) |
| Contribute or report a vulnerability | [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) |

## Requirements

- Node.js >= 22 with a `node` command available on the PATH of both the consuming process and the host launch process; installed shims never persist a versioned physical Node path.
- A local Chrome or Chromium logged in to claude.ai with an explicitly open loopback CDP endpoint; with no configured endpoint, the bridge discovers the sole logged-in candidate and requires explicit selection when ambiguous.
- Existing user authorization for external consultation; the operator supplies the web session. The optional fallback API channel requires independent gateway verification.

## Setup

**The development repository is never a consumption directory.** Select an existing fixed version on the trusted private Gitea Release page, then download and verify `install.sh`, `SHA256SUMS` and its archive. No clone, Git or npm is needed. A local candidate build does not prove a remote Release exists; do not invent download URLs. Follow the [English installation guide](docs/install.en.md) / [中文](docs/install.md) and the [LLM installation protocol](llms.txt).

Run from the downloaded and verified Release directory. `CCW_VERSION` is the operator-selected version; `ASSET` and `DIGEST` come from the installation guide:

```bash
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST" --dry-run
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST"
bash ./install.sh --status
"$HOME/.local/bin/ccw" --help
"$HOME/.local/bin/ccw" --status
```

Runtime versions live outside the repository under `~/.local/share/claude-web-api/runtime/releases/vVERSION`, with a stable `current` selector. Each command resolves `node` from PATH at launch time, and `ccw --status` is the equivalent read-only runtime check. Reconnecting a host after a Node upgrade requires an explicit refresh through the new-version direct installer or the original manager. Bash never edits host settings, restarts a service or sends a message.

### Integration routes

For existing Magpie/external management, retain that ownership: update the existing `claude_web` through its supported interface to the absolute installed `ccw-mcp` path and import the installed skill. Do not add direct registration. Only for explicitly confirmed direct hosts without external management, use the installed `ccw-hosts` entry (verify `dsh` ownership before using this example):

```bash
"$HOME/.local/bin/ccw-hosts" --list
"$HOME/.local/bin/ccw-hosts" --host dsh --dry-run
"$HOME/.local/bin/ccw-hosts" --host dsh
"$HOME/.local/bin/ccw-hosts" --check --host dsh
```

Native plugins and direct MCP registration are alternative assemblies. The standalone Release currently provides CLI/MCP/skill; if no plugin asset is published, do not invent its download URL. Codex-only direct installs use `ccw-hosts --host codex` after ruling out Magpie or native-plugin duplication. Registration and `runtime.json` must refer to the independent runtime root; `codex` plugin and structure checks are under [Development and tests](#development-and-tests-not-consumer-installation).

| Host | MCP registration | Skill | Status |
|---|---|---|---|
| Codex CLI | `[mcp_servers.claude_web]` in `~/.codex/config.toml` | `~/.codex/skills` | verified |
| Claude Code | `mcpServers.claude_web` in `~/.claude.json` | `~/.claude/skills` | verified |
| Claude Desktop | `mcpServers.claude_web` in `~/Library/Application Support/Claude/claude_desktop_config.json` | none (no skill directory) | path verified |
| Pi agent | `mcpServers.claude_web` in `~/.pi/agent/mcp.json` | `~/.pi/agent/skills` | verified |
| DeepSeek Harness | `servers.claude_web` in `~/.deepseek/mcp.json` | `~/.deepseek/skills` | verified |
| Gemini CLI | `mcpServers.claude_web` in `~/.gemini/settings.json` | `~/.gemini/skills` | verified |
| OpenCode | `mcp.claude_web` in `~/.config/opencode/opencode.json` | `~/.config/opencode/skills` | verified |
| Grok Build | `[mcp_servers.claude_web]` in `~/.grok/config.toml` | unverified, not installed | structure verified, runtime untested |

Verified means configuration-level adapter tests, not actual loading in every client. The remaining cc-switch hosts (openclaw, hermes, mcode, kimi, agy, omp) have unverified config locations and schemas; the installer reports them in `--list` and never guesses a write. Hosts get `claude_ask` / `claude_follow_up` / `claude_sessions` / `claude_transcript` / `claude_doctor` / `claude_download` plus the `claude` skill; reconnect MCP or reload the skill afterwards.

Write ownership (ownership) is proven only by the install record, kept under `$CCW_STATE_DIR` (default `~/.local/share/claude-web-api/installs/`); Codex keeps its historical record path. A verified Magpie hub/external direct route reports `configured:true` and `installed:false`; installation returns `skippedExternal:true` without duplicate registration or adoption. Unknown same-name entries remain `INSTALL_CONFLICT`. If another tool removed our entry, uninstall still finishes; a *modified* entry is `OWNED_MODIFIED` and nothing of the user's is deleted. A detected concurrent in-place edit is retained in a reported recovery file; stop other configuration editors during installation. Recovery never adopts links or unknown records.

### Evidence layers and recovery

```bash
"$HOME/.local/bin/ccw-hosts" --check --host pi
"$HOME/.local/bin/ccw-hosts" --check --probe --host pi
# Explicitly authorized read-only metadata discovery for a hub:
"$HOME/.local/bin/ccw-hosts" --check --discover --host pi
"$HOME/.local/bin/ccw-hosts" --reconcile --dry-run --host codex
```

Plain `--check` makes no network requests or writes. `source.verification:"configuration-only"` does not prove endpoint reachability; it also reports read-only freshness of an external manager skill copy. `externalSkill.status:"stale"` is separate evidence and does not invalidate a healthy route's configuration-level result. With Magpie `sharedSkills:true`, every library skill is linked into `~/.agents/skills`; every agent reading that directory sees all of them regardless of per-agent assignment. The check follows that shared link and adds `externalSkill.shared:true`, but this is not proof that an agent actually loaded it. Explicit `--probe` performs bounded initialize/tools/list only on verified local routes, checking six tools and both complete send-schema guidance blocks. `verification:"protocol-only"` and `hostLoaded:false` still require actual safe host reconnection. A discovery-only hub returns `PROBE_DISCOVERY_ONLY`: backend schemas (`discovery-schemas`) are unverified, not stale. With explicit authorization, `--check --discover` can issue two exact read-only `find_tools` metadata queries for `claude_web__claude_download` and `claude_web__claude_doctor`; it never calls `call_tool`, sends a Claude question, or refreshes caches. `DISCOVERY_*` stale cache metadata is diagnosed, never automatically refreshed or restarted.

`--reconcile` is recovery, not installation. Remove `--dry-run` only after reviewing ownership/preimages and obtaining write authorization. It retires valid stale records for this runtime only when registrations and skill destinations are absent, or removes one exact empty orphan start marker. Private preimages are saved first; links, unknown ownership, locks and concurrent edits fail closed and retain `recoveryPath`. `--check --all` still reports uninstalled hosts; bulk installation is not a way to make every row green. See [evidence layers and recovery](docs/usage.md#多源证据与显式恢复).

### Direct CLI use

Prefer stdin or files for prompt text:

```bash
"$HOME/.local/bin/ccw" ask --session architecture --stdin <<'QUESTION'
Give a read-only minimal offline acceptance plan for this project. Known facts: Node.js >=22; npm test runs offline tests.
Use ultrathink reasoning. Start with a conclusion, an aggressive root-cause preferred solution and prerequisites. Then give ordered file-level changes (paths, symbols, line numbers) or actions, exact commands and working directories, success observations, failure handling and final end-to-end verification. If the verification gate is unreasonable, give replacement criteria, evidence and rollback. If evidence is missing, give executable evidence-gathering steps first; do not invent paths or results.
QUESTION
"$HOME/.local/bin/ccw" follow-up --session architecture --stdin <<'QUESTION'
Fill only the missing execution details from the prior answer: exact locations, full verification commands, pass criteria, a counterexample and the next diagnostic action on failure. Label unseen implementations as requiring local inspection.
QUESTION
"$HOME/.local/bin/ccw" transcript --session architecture
"$HOME/.local/bin/ccw" transcript --session architecture --recover
```

Results are one JSON line per invocation; failures exit non-zero. `--recover` clears a pending turn only when server history proves it completed. Full command, attachment, timeout, lock, concurrency and pending rules are in the [usage guide](docs/usage.md).

## Configuration and optional channel

CLI, MCP and plugin share the read-only `$HOME/.config/claude-web-api/config.json`. It is not created automatically; uploads are disabled by default. Some hosts filter inherited environment variables, so operators should configure MCP/plugin browser access and approved file roots in this file. Uploads accept explicitly selected PNG and UTF-8 `.js` files; PDF attachments and PDF files disguised as code are refused. Returned PDF chat files can still be downloaded. Never upload a repository, expand directories or follow imports. File identity, restored drafts and `PROMPT_MISMATCH` boundaries are in the [usage guide](docs/usage.md#显式附件与回拉).

`CCW_CDP_URL` (empty by default, enabling discovery), `CCW_STATE_DIR`, `CCW_TIMEOUT_MS`, `CCW_ATTACHMENT_ROOT` and other environment variables override the configuration file. Only routing-sensitive options are listed here; all defaults are in the [usage guide](docs/usage.md#启动配置):

| Variable | Default | Meaning |
|---|---|---|
| `CCW_BACKEND` | `web` | `web` / `api` / `auto`: whether the fallback channel is allowed |
| `CCW_API_BASE_URL` | empty | Fallback endpoint; HTTPS required (loopback HTTP only in tests) |
| `CCW_API_MODEL` | empty | New API aliases otherwise select the latest host-catalog Opus; `ccw ask --model` selects explicitly |
| `CCW_API_KEY_FILE` | empty | Absolute path to the fallback key (unlinked, `0600`, at most 8 KiB) |
| `CCW_API_MAX_TOKENS` | `2048` | Strict output cap; reasoning consumption counts against it |
| `CCW_API_CONTEXT_TOKENS` | `16000` | Conservative input-history estimate allowed per send |
| `CCW_API_PROTOCOL` | `messages` | `messages` / `chat` / `responses`, pinned when an alias is created |
| `CCW_API_CACHE` | `ephemeral` | Messages prefix breakpoints; `off` omits them |
| `CCW_API_REASONING` | `off` | Reasoning effort; `off` omits effort fields, not disabled thinking |

An optional, separate HTTP fallback can be enabled. `backend=auto` runs one read-only browser preflight for a **new alias** and uses the fallback only if that fails. For an explicit per-call choice use `ccw web <command>` or `ccw api <command>`: it overrides configuration, never preflights, and never falls back; a session owned by the other backend reports `MODE_MISMATCH`. The fallback channel is **text-only and sticky per alias**: it takes no attachments, requests no web artifacts and provides no artifact downloads. Complete text history is retained locally, while each send uses the newest complete turns that fit both the `apiContextTokens` estimate and the actual 256 KiB JSON request limit. One alias permits one request in flight, while different aliases may send concurrently with independently persisted state. Effort uses `thinking: {"type":"adaptive"}` + `output_config.effort` for Messages, `reasoning_effort` for Chat, and `reasoning.effort` for Responses. `ccw doctor` shows the actual wire fields; a 200 response does not prove that the gateway applies effort, and missing reasoning usage remains `usage.reasoningTokens: null`. Protocol fields, cumulative SSE semantics, `API_STREAM_INCOMPLETE`, pending, 429, `store: false` and acceptance boundaries are in the [API protocol reference](docs/api-protocols.md).

Uncertain sends retain pending and are never retried automatically; inspect `transcript` first. Timeouts, partial streams, cancellation, redirects, authentication errors and contract errors never trigger a POST retry. `complete: false` means the response terminated with truncated content; abandoning an unconfirmed fallback API attempt requires explicit `--discard-pending`. A changed key blocks replay until `ccw api-bind-credential` explicitly validates it. Cache hits or savings are never claimed without observed server usage.

New web aliases also accept `--model`; otherwise the bridge selects the latest Claude Opus shared by the host catalog and visible webpage menu, then verifies the control and conversation/completion readbacks. Follow-ups cannot change models and existing aliases are not migrated. `ccw doctor` reports host, webpage and default-selection evidence read-only; this is not live model-switching acceptance.

## Development and tests (not consumer installation)

Run these only in the development repository. Never register source entry points with production hosts:

```bash
npm ci
npm test
npm run build:release
npm run build:plugin
npm run verify:plugin
npm run verify:structure
```

`scripts/install-agents.mjs` is a development fixture/temporary-HOME entry. Consumers use the Release's `ccw-hosts`. Build output is a candidate requiring release gates, not a production consumption directory. `verify:plugin` runs after `build:plugin` and checks the isolated temporary-CODEX_HOME plugin installation and MCP handshake; it needs the `codex` CLI on PATH. Everything runs offline: an in-memory Claude service, a fake CDP/WebSocket server and temporary HOME / CODEX_HOME / state directories. No real account, browser or personal host config is touched. `verify:structure` regenerates `.spec/architecture/*` from Git-tracked files and resolved direct imports, then proves the module DAG is acyclic. Run `npm run verify:structure -- --write` after changing governance files.

## Limitations

- Web sends create real conversations and consume the account allowance. `quota` is only a legacy SSE snapshot; native sends return `null`. It is not a hard budget. Claude endpoints, selectors and file protocols are not a public stable contract and may change.
- Upload evidence covers PNG and JS in a live restored-draft submission. The standalone automatic upload flow has not been revalidated live since PDF input was removed. Downloaded artifacts must be checked locally; they are never executed, overwritten or extracted.
- Multi-host acceptance covers config write/verify/uninstall plus an MCP handshake against the registered entry. Claude Desktop, Grok Build and Gemini CLI were not installed or logged in on this machine, so real host tool loading is untested.
- Fallback-channel gateway compatibility, model identity and server-side session affinity are for the operator to verify; local tests cover only request shape, state machine and safety boundaries.
- Uncertain sends are never retried automatically; inspect `transcript` first and use `unlock` only for dead locks.

## Community and license

- Bugs and contributions: [CONTRIBUTING.md](CONTRIBUTING.md); behavior standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security disclosure: [SECURITY.md](SECURITY.md); version differences: [CHANGELOG.md](CHANGELOG.md).
- Software is licensed under [PolyForm Noncommercial 1.0.0](LICENSE); see [NOTICE](NOTICE) for the copyright notice. Commercial use requires separate written authorization.

See `docs/usage.md` for details.
