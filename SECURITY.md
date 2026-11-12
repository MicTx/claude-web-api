# Security Policy

## Supported versions

Only the latest published release is supported. Install it through the versioned Release mechanism and use `install.sh --status` to identify the current runtime. Development worktrees and local build outputs are not supported consumption surfaces.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting for `MicTx/claude-web-api`: <https://github.com/MicTx/claude-web-api/security/advisories/new>. Include reproduction steps without live credentials.

Do not open a public issue, pull request, discussion comment or release note for:

- credentials, cookies, session tokens or account identifiers;
- authentication, authorization or browser-session bypasses;
- command injection, path traversal, unsafe archive extraction or unsafe MIME handling;
- Cross-Site WebSocket or loopback origin issues;
- vulnerabilities in third-party services that you can report directly to those providers.

## Include in a report

- Affected version from `install.sh --status`, operating system, Node.js version and host.
- The entry point: CLI, MCP server, installer, plugin, fallback API channel, attachment handling or browser bridge.
- Exact steps or a minimal offline reproduction.
- Observed result and expected result.
- Logs or output with secrets, private paths and account data removed.

## Handling expectations

This is a small noncommercial project; do not assume a paid incident-response SLA. Reports are acknowledged when a maintainer can reproduce or triage them. Coordinated disclosure, embargo timing and credit are agreed individually with the reporter.

AI-generated reports are accepted only when a human validates the reproduction locally and removes irrelevant bulk output. Automated scans without a concrete impact path may be closed as noise.
