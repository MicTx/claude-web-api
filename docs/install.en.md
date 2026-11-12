# Release installation

[中文](install.md) · [Usage](usage.md) · [LLM installation protocol](../llms.txt)

## Prerequisites and boundaries

- macOS/Linux, Bash and Node.js >=22 with `node` available on PATH. No Git, npm, clone or administrator privileges are needed. Windows Bash installation is unverified. Generated commands and direct-host registrations store only the stable `node` command name, never a versioned Homebrew/nvm physical path.
- The development repository is for development, testing and building, never production consumption. Its root install.sh intentionally refuses installation; execute the standalone install.sh asset from a verified Release.
- Select an existing fixed version on the project's **private Gitea Release** page. Download install.sh, SHA256SUMS and claude-web-api-vVERSION.tar.gz. A local build is not evidence that a remote release exists. GitHub is not the default source; do not invent download links.
- Verify both assets against the trusted publisher's checksum file before execution. SHA-256 proves transfer integrity, not publisher identity, a signature or a security review. Never use curl piped into Bash.
- Obtain authorization for the install location and integration method. The Bash installer deploys runtime files only: no agent settings, Magpie Library, shell profiles, browser configuration, sessions or credentials are edited. No Claude message is sent.

## Downloaded assets: verify and preview

Working directory: the directory containing the three downloaded assets, not a source checkout. Set CCW_VERSION to the existing fixed release selected by the operator, without the v prefix. This checks both assets, then makes a read-only plan without creating directories, locking or downloading:

<!-- verify:release-local-preview -->
```bash
: "${CCW_VERSION:?Select an existing fixed Release first}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi
ASSET="claude-web-api-v${CCW_VERSION}.tar.gz"
DIGEST="$(awk -v name="$ASSET" '$2 == name { print $1 }' SHA256SUMS)"
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST" --dry-run
```

Success: both checksums pass and JSON reports ok:true, dryRun:true, artifactVerified:true. Missing/duplicate digests or any failure mean stop, not skip verification or install from source.

## Install and verify files

With write authorization, retain the same working directory and variables:

```bash
bash ./install.sh --version "$CCW_VERSION" --archive "$ASSET" --sha256 "$DIGEST"
bash ./install.sh --status
"$HOME/.local/bin/ccw" --help
"$HOME/.local/bin/ccw" --status
```

Success reports the chosen version and registeredHosts:false. Identical reinstalls report changed:false. Both `install.sh --status` and `ccw --status` read-only verify file hashes, permissions and command ownership with verification:"installed-files-and-commands"; they do not prove browser access or actual host loading. When installed, `binDir` always reports the verified owner directory; the override or default path is only displayed while no ownership record exists.

An install or rollback that changes bytes writes a `reconnect-required` marker at the runtime root; `--status` then reports `reconnectRequired:true` and `reconnectVersion`. Both `--status` commands accept only a bounded, single-link regular marker file; a symlink, directory, oversized file or a marker changed while reading fails with `UNSAFE_PATH` / `CONCURRENT_CHANGE`. After a direct host passes `ccw-hosts --check --probe` (verified provenance plus a bounded initialize/tools/list reaching the current release), the marker is cleared and `--status` returns `reconnectRequired:false`. A `changed:false` reinstall neither creates nor clears the marker. A green probe also reports `reconnectCleared` and `reconnectMarker` (`cleared` / `absent` / `failed` / `no-release-root` / `not-current-release` / `not-attempted`); an in-process development call without a versioned runtime root reports `no-release-root` instead of silently skipping. When `reconnectMarker` is `failed`/`no-release-root`/`not-current-release`, the top-level output also carries a `warning` field reporting that marker cleanup did not complete; `cleared`/`absent`/`not-attempted` emit no `warning`.

Default layout:

```text
~/.local/share/claude-web-api/runtime/
  install.json
  releases/vVERSION/
  current -> releases/vVERSION
  previous -> releases/vPREVIOUS
  reconnect-required        # present while a host has not reconnected against the new release
  backups/
~/.local/bin/ccw
~/.local/bin/ccw-mcp
~/.local/bin/ccw-hosts
```

Version directories are immutable. Sessions remain in their existing state directory. Use --prefix /absolute/runtime and --bin-dir /absolute/commands for custom locations outside any worktree; keep supplying the same --prefix for future operations. The command directory must not be inside the runtime root; an existing command directory cannot be silently migrated. Absolute command paths work without editing PATH, but `node` itself must remain on the PATH of both the consuming process and the host launch process.

## Verified script: self-service download from a Release URL

The operator must provide CCW_RELEASE_URL, a trusted version-specific HTTPS URL ending in /owner/repo/releases/download/vVERSION, without userinfo, query or fragment. Keep using the already verified script:

```bash
: "${CCW_VERSION:?Select a fixed version}"
: "${CCW_RELEASE_URL:?Supply its trusted HTTPS Release URL}"
bash ./install.sh --version "$CCW_VERSION" --release-url "$CCW_RELEASE_URL" --dry-run
bash ./install.sh --version "$CCW_VERSION" --release-url "$CCW_RELEASE_URL"
```

Remote preview is offline and returns artifactVerified:false; it does not certify availability. Actual installation downloads SHA256SUMS and the archive, then verifies it. Private Gitea downloads require CCW_RELEASE_TOKEN to be explicitly injected through the launch environment; the installer never calls a Git credential helper or silently falls back to one. The separate publish script's `--credential-helper` flag is an explicit opt-in fallback for `git credential fill` (5s timeout, token never printed) used only when no `CCW_RELEASE_TOKEN`/`--token-file` is set. Never put a real token value in commands, URLs, documents, logs or shell history; do not enable shell tracing or dump the environment. Authentication failures stop; do not request passwords.

At most five same-origin redirects are followed. Cross-origin storage redirects are refused without forwarding credentials; use an authorized browser download and the offline path instead. Each asset has a 30-second default deadline; --timeout-ms accepts 500–120000 ms. There is no automatic retry or source fallback.

## Choose exactly one integration method

### Existing Magpie or another manager

Retain the current manager's ownership. Back up and inspect the existing claude_web definition; set its command to the absolute path printed below and args to an empty array. Point the skill to the independently installed current directory, never the development tree. Copying or importing the skill alone does not generate `runtime.json`, so that copy cannot reliably use its `scripts/ccw.mjs` CLI fallback; use the separate stable `ccw` command below instead and do not claim the copy is bound. Do not use a literal tilde as an executable path:

```bash
printf '%s\n' "$HOME/.local/bin/ccw-mcp"
printf '%s\n' "$HOME/.local/bin/ccw"
printf '%s\n' "$HOME/.local/share/claude-web-api/runtime/current/skills/claude"
```

Use the manager's supported interface only after config-write authorization and a quiescent-state check. Do not add a second direct registration, edit hub caches or blindly restart Magpie. Preserve unknown drafts, active calls and ownership for operator resolution.

### Confirmed direct host without external management

Only after confirming dsh is a direct host owned by this installer's records, for example:

```bash
"$HOME/.local/bin/ccw-hosts" --list
"$HOME/.local/bin/ccw-hosts" --host dsh --dry-run
"$HOME/.local/bin/ccw-hosts" --host dsh
"$HOME/.local/bin/ccw-hosts" --check --host dsh
```

ccw-hosts wraps scripts/install-agents.mjs inside the release. Registration and runtime.json must reference the independent runtime/current root, never a worktree or dist. Invoking the internal entrypoint or bundle directly from a releases/vVERSION directory is refused; an explicitly extracted non-installed directory still registers as before. Plain --check distinguishes magpie-hub, magpie-direct, external-direct and installer sources. Verified external routes report configured:true and installed:false; installation skips them without duplicate registration and reports external skill freshness read-only. This is configuration-only; --check --probe performs bounded local initialize/tools/list, and explicitly authorized --check --discover verifies discovery-hub backend schemas, but neither proves actual host loading. --check --all also reports uninstalled hosts. Explicit recovery starts with --reconcile --dry-run --host <id>; stop if historical backup, ownership or write authorization is missing. Links and unknown records are never adopted. See [evidence layers and recovery](usage.md#多源证据与显式恢复).

## Upgrade, rollback and end-to-end acceptance

Repeat verification, preview and installation with the new Release's script, fixed version and assets. Different bytes under the same version are VERSION_CONFLICT; publish a new version. Switching the runtime does not refresh copied host skills. The direct installer's `--check` reports managed skills that differ from the current runtime and `--dry-run` previews a refresh; external-manager skill copies are reported read-only as `externalSkill.status:"stale"` without invalidating a healthy route. Magpie `sharedSkills:true` links library skills into `~/.agents/skills`; every agent reading that directory sees all of them regardless of per-agent assignment. The check follows this shared link read-only and records `externalSkill.shared:true`, `via` and `linkExists`, without filtering by the `agents` list, adopting, copying, changing assignments or claiming host loading; refresh remains with the original manager. `--probe` conservatively skips an unhealthy managed skill and does not establish that the endpoint is offline. After verifying ownership and obtaining write authorization, refresh through the original manager or direct installer, then verify the runtime binding and actual host loading; direct checks never rewrite a copy owned by another manager. Preserve unknown ownership. Selecting an older fixed version is an explicit switch; prefer the verified previous release when available:

```bash
bash ./install.sh --rollback --dry-run
bash ./install.sh --rollback
bash ./install.sh --status
```

Rollback swaps current/previous and deletes neither versions nor sessions/configs. It fails without a previous release. Keep --prefix on every command for custom roots. Reconnect actual hosts only after checking for in-flight sends; never replay pending requests. An old install record bound to a removed physical Node path is reported as `node path missing` by `--check`; after installing a new version, refresh it explicitly through `ccw-hosts` or the original manager rather than silently rewriting host configuration. Removing an MCP registration with ccw-hosts --uninstall --host CONFIRMED_ID is separate from program rollback.

Verify in layers: installed-file status; ccw --help; separately authorized ccw doctor for browser/organization access; actual reconnected host tools/list with six tools and the complete guidance in both prompt schemas; then a separately authorized real Claude sample. Earlier layers do not prove later ones, semantic trigger rates or long-term model compliance.

## Failure and recovery

- SHA_MISMATCH, malformed/traversing/link archives: stop and obtain trusted assets again. Extraction accepts only bounded regular-file USTAR payloads.
- OWNERSHIP_CONFLICT, links, source trees or foreign commands: preserve them; investigate ownership and backups. Never force installation with sudo.
- LOCKED: check for another installer or an interrupted operation. Do not guess a PID or delete a lock automatically.
- Modified installed files: stop instead of overwriting modifications to manufacture success.
- Partial I/O failure: compensate only targets still matching this transaction's postimages. Never overwrite another writer. RECOVERY_REQUIRED preserves versions and the reported journal for explicit pre/post-image reconciliation. Stop other editors during installation; uncooperative filesystem replacement is not fully preventable.
- Power loss or termination may leave a lock, unfinished journal or unowned initial directory. Inspect read-only and reconcile first; never fall back to consumption from the development repository.
