#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Scan a staged public tree for credential-shaped or private content.

Every regular file is passed to ``public_secret_scan.scan_secrets`` with
generic private-text patterns plus host/org patterns derived from the source
repository's configured Git remotes. The scanner itself ships in the public
snapshot, so it must never embed private endpoint literals — anything
repo-specific is derived at runtime from ``--source``.

Output is a JSON summary on stdout: ``{"ok": bool, "files": n, "findings": [...]}``.
Exit status is 0 only when every file scanned clean; findings or an
incomplete inspection fail closed with exit 1.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from public_secret_scan import SecretScanError, scan_secrets  # noqa: E402

PRIVATE_TEXT_PATTERNS = (
    re.compile(r"https?://[^/\s]+\.internal(?:[:/]|$)", re.IGNORECASE),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"(?:AKIA|ghp_|github_pat_|xox[baprs]-)[0-9A-Za-z_\-]{20,}"),
    re.compile(r"sk-[0-9A-Za-z]{20,}"),
    # Home-path usernames that are deliberate fixture placeholders (sandbox or
    # obviously generic accounts), not a maintainer's real home directory.
    re.compile(
        r"/(?:Users|private|home)/"
        r"(?!(?:claude|x|otheruser|user|test|example|nobody)[/\\])"
        r"[A-Za-z0-9_.-]+/"
    ),
    re.compile("\u2063"),
)


def remote_patterns(source: Path | None) -> tuple[re.Pattern, ...]:
    """Derive private host/org patterns from the source repo's remotes."""
    if source is None or not (source / ".git").exists():
        return ()
    result = subprocess.run(
        ["git", "remote", "-v"],
        cwd=source,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode:
        raise RuntimeError("cannot inspect development remotes for the public privacy gate")
    names: set[str] = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        url = fields[1]
        host = urllib.parse.urlsplit(url).hostname
        if host is None and "@" in url and ":" in url:
            host = url.split("@", 1)[1].split(":", 1)[0]
        if host and host.lower() != "github.com":
            names.add(host)
        path = urllib.parse.urlsplit(url).path if "://" in url else url.split(":", 1)[-1]
        org = path.strip("/").split("/", 1)[0]
        if org and org != "~" and "/" not in org:
            names.add(org + "/")
    # A bare "org/" or short host must not substring-match inside longer words
    # like "ExampleOrg/repo"; anchor each pattern at a name boundary.
    return tuple(
        re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(name), re.IGNORECASE)
        for name in sorted(names)
    )


def iter_files(tree: Path):
    for path in sorted(tree.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"public tree contains symlink: {path}")
        if path.is_file():
            yield path


def scan_tree(tree: Path, patterns: tuple[re.Pattern, ...]) -> dict:
    findings: list[dict] = []
    count = 0
    for path in iter_files(tree):
        count += 1
        relative = path.relative_to(tree).as_posix()
        try:
            hits = scan_secrets(path.read_bytes(), relative, extra_patterns=patterns)
        except SecretScanError as exc:
            raise RuntimeError(f"credential inspection incomplete: {relative}") from exc
        findings.extend({"rule": f.rule, "fingerprint": f.fingerprint, "location": f.location} for f in hits)
    return {"ok": not findings, "files": count, "findings": findings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree", type=Path, help="staged public tree to scan")
    parser.add_argument("--source", type=Path, default=None,
                        help="source repository used to derive remote host/org patterns")
    args = parser.parse_args()
    tree = args.tree.resolve()
    if not tree.is_dir():
        print(json.dumps({"ok": False, "error": "tree is not a directory"}))
        return 1
    try:
        patterns = (*PRIVATE_TEXT_PATTERNS, *remote_patterns(args.source.resolve() if args.source else None))
        result = scan_tree(tree, patterns)
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
