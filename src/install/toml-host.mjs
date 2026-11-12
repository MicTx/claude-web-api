// TOML host adapter with managed-block ownership.
//
// A host is described by a spec object (config path, server name, extra entry
// keys, record location and style). Codex keeps its historical record schema so
// existing installs stay valid; other TOML hosts use the generic schema.
//
// Ownership proof is ONLY the install record: markers alone never authorize a
// write, adopt or removal. Rollback restores pre/post images per resource and
// reports anything it could not restore.
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { InstallError } from './errors.mjs';
import { isNodeCommand, nodeCommandExists } from './node-command.mjs';
import {
  defaultIo, sha256, lstatSafe, readIfFile, assertNotSymlink, ensureDirectory,
  writeFileAtomic, acquireLock, backupFile, writeFileGuarded, removeFileGuarded, rollbackFile,
} from './atomic.mjs';
import {
  desiredSkillFiles, skillHashesMatch, checkSkillFreshness, copySkillInto, dirMatchesPostimage, restoreQuarantinedSkill,
  verifySkillTree, assertOwnedSkillTree,
} from './skills.mjs';

export const BLOCK_START = '# >>> claude-web-api >>>';
export const BLOCK_END = '# <<< claude-web-api <<<';
export const isBlockStart = (line) => line === BLOCK_START;
export const isBlockEnd = (line) => line === BLOCK_END;
const HASH_RE = /^[a-f0-9]{64}$/;
const SEPS = ['', '\n', '\n\n'];

// --- block text -------------------------------------------------------------

export function buildBlock(spec, nodePath, mcpPath) {
  const lines = [
    BLOCK_START,
    `[mcp_servers.${spec.serverName}]`,
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(mcpPath)}]`,
  ];
  for (const [key, value] of spec.extraKeys ?? []) lines.push(`${key} = ${JSON.stringify(value)}`);
  lines.push(BLOCK_END, '');
  return lines.join('\n');
}

const ownedEntryKeys = (spec) => ['command', 'args', ...(spec.extraKeys ?? []).map(([k]) => k)];

function exactOwnedEntry(entry, spec) {
  const keys = Object.keys(entry).sort();
  const owned = ownedEntryKeys(spec).sort();
  return keys.length === owned.length && owned.every((k) => keys.includes(k))
    && Array.isArray(entry.args) && entry.args.length === 1;
}

function entryMatches(entry, record, spec) {
  if (entry.command !== record.nodePath || entry.args?.[0] !== record.mcpPath) return false;
  return (spec.extraKeys ?? []).every(([key, value]) => entry[key] === value);
}

function parseConfig(text) {
  if (text === null || text.trim() === '') return {};
  try {
    const p = parseToml(text);
    return p && typeof p === 'object' ? p : {};
  } catch {
    throw new InstallError('CONFIG_INVALID', 'config.toml is not valid TOML');
  }
}

const hasServer = (parsed, spec) => Boolean(parsed?.mcp_servers
  && typeof parsed.mcp_servers === 'object' && parsed.mcp_servers[spec.serverName] !== undefined);

// Exact full-line markers only; exactly one balanced pair, in one naming family.
function findBlock(text) {
  const lines = text.split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (isBlockStart(line)) starts.push(i);
    if (isBlockEnd(line)) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1 || ends.length > 1) throw new InstallError('CONFIG_INVALID', 'Duplicate managed block markers');
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new InstallError('CONFIG_INVALID', 'Unbalanced managed block markers');
  }
  const start = starts[0];
  const end = ends[0];
  let byteStart = 0;
  for (let i = 0; i < start; i++) byteStart += lines[i].length + 1;
  let byteEnd = 0;
  for (let i = 0; i <= end; i++) byteEnd += lines[i].length + 1;
  if (byteEnd > text.length) byteEnd = text.length;
  return { start: byteStart, end: byteEnd, content: text.slice(byteStart, byteEnd) };
}

// parse the candidate block to prove the decoded entry really is ours
function blockEntry(blockContent, spec) {
  const parsed = parseConfig(blockContent);
  const e = parsed?.mcp_servers?.[spec.serverName];
  if (!e || typeof e.command !== 'string' || !Array.isArray(e.args) || typeof e.args[0] !== 'string') {
    throw new InstallError('INSTALL_CONFLICT', 'Managed block does not decode to a registered MCP server');
  }
  return e;
}

// --- install record ---------------------------------------------------------

function validateRecord(data, spec) {
  const bad = (m) => { throw new InstallError('INSTALL_CONFLICT', `Install record invalid: ${m}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('not an object');
  if (spec.recordStyle === 'codex') {
    if (data.schema !== 1) bad('schema');
    if (data.createdConfig !== undefined && typeof data.createdConfig !== 'boolean') bad('createdConfig');
  } else {
    if (data.schema !== 2) bad('schema');
    if (data.host !== spec.hostId) bad('host');
    if (data.format !== 'toml') bad('format');
  }
  for (const k of ['mcpPath', 'cliPath']) {
    if (typeof data[k] !== 'string' || !isAbsolute(data[k])) bad(`${k} not absolute`);
  }
  if (!isNodeCommand(data.nodePath) && (typeof data.nodePath !== 'string' || !isAbsolute(data.nodePath))) bad('nodePath not absolute');
  if (typeof data.blockSha256 !== 'string' || !HASH_RE.test(data.blockSha256)) bad('blockSha256');
  if (!data.skillFiles || typeof data.skillFiles !== 'object' || Array.isArray(data.skillFiles)) bad('skillFiles');
  for (const [rel, hash] of Object.entries(data.skillFiles)) {
    if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) bad('skillFiles key');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) bad('skillFiles hash');
  }
  if (typeof data.appendedBase64 !== 'string') bad('appendedBase64');
  let decoded;
  try {
    decoded = Buffer.from(data.appendedBase64, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') !== data.appendedBase64) bad('appendedBase64 not canonical');
  } catch (e) { if (e instanceof InstallError) throw e; bad('appendedBase64 decode'); }
  const expectedBlocks = [buildBlock(spec, data.nodePath, data.mcpPath)];
  const matched = expectedBlocks.find((block) => SEPS.some((s) => decoded === s + block));
  if (matched === undefined) bad('appended bytes do not match owned block');
  if (sha256(matched) !== data.blockSha256) bad('block hash mismatch');
  return data;
}

// Reconciliation validates an already captured immutable record image rather
// than re-reading a possibly swapped path between provenance checks.
export { validateRecord as validateTomlRecord };

export async function readRecord(io, spec) {
  const text = await readIfFile(io, spec.recordPath, 'install record');
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstallError('INSTALL_CONFLICT', 'Install record is not valid JSON');
  }
  return validateRecord(data, spec);
}

const readRecordText = (io, spec) => readIfFile(io, spec.recordPath, 'install record');

// --- preflight --------------------------------------------------------------

async function preflight(io, spec, { forUninstall = false } = {}) {
  const homeStat = await lstatSafe(io, spec.homeDir);
  if (homeStat && homeStat.isSymbolicLink()) throw new InstallError('UNSAFE_PATH', `${spec.homeLabel} is a symlink`);
  await assertNotSymlink(io, spec.configPath, 'config.toml');
  await assertNotSymlink(io, spec.recordPath, 'install record');
  if (spec.skillsDir) {
    await assertNotSymlink(io, spec.skillsDir, 'skills directory');
    await assertNotSymlink(io, spec.skillDest, 'skill destination');
    if (spec.legacySkillDest) await assertNotSymlink(io, spec.legacySkillDest, 'legacy skill destination');
  }

  const configText = await readIfFile(io, spec.configPath, 'config.toml');
  const parsed = parseConfig(configText);
  const block = configText === null ? null : findBlock(configText);
  const recordText = await readRecordText(io, spec);
  const record = await readRecord(io, spec);

  if (block !== null && record === null) {
    // ownership is only ever the record
    throw new InstallError('INSTALL_CONFLICT', 'config.toml contains managed-looking markers without an install record');
  }
  if (hasServer(parsed, spec) && block === null && !(forUninstall && record !== null)) {
    throw new InstallError('INSTALL_CONFLICT', `config.toml already defines mcp_servers.${spec.serverName} without our managed block`);
  }
  if (block !== null && record !== null) {
    if (sha256(block.content) !== record.blockSha256) {
      throw new InstallError('OWNED_MODIFIED', 'Managed config block was modified after installation');
    }
    if (!hasServer(parsed, spec)) {
      throw new InstallError('INSTALL_CONFLICT', 'Managed block is present but the MCP server is not bound in parsed config');
    }
    const owned = blockEntry(block.content, spec);
    const actual = parsed.mcp_servers[spec.serverName];
    if (!entryMatches(owned, record, spec)) {
      throw new InstallError('INSTALL_CONFLICT', 'Parsed entry does not match the recorded owned block');
    }
    if (!exactOwnedEntry(actual, spec)
      || actual.command !== owned.command || actual.args[0] !== owned.args[0]
      || (spec.extraKeys ?? []).some(([k, v]) => actual[k] !== v)) {
      // e.g. a user-attached env subtable under our entry outside the markers
      throw new InstallError('OWNED_MODIFIED', 'The MCP entry has keys beyond the owned registration');
    }
  }

  // Pre-rename installs left the skill tree at legacySkillDest; the record
  // proves ownership of the tree, not of a particular directory name.
  const destNew = spec.skillDest ? await lstatSafe(io, spec.skillDest) : null;
  const destLegacy = spec.legacySkillDest ? await lstatSafe(io, spec.legacySkillDest) : null;
  const destStat = destNew ?? destLegacy;
  const skillDestActual = destNew !== null ? spec.skillDest
    : (destLegacy !== null ? spec.legacySkillDest : null);
  if (destStat !== null) {
    if (record === null) {
      throw new InstallError('INSTALL_CONFLICT', `Skill destination ${skillDestActual} exists and is not owned`);
    }
    await assertOwnedSkillTree(io, { skillDest: skillDestActual, postHashes: record.skillFiles });
  }
  return { configText, parsed, block, record, recordText, destExists: destStat !== null, skillDestActual };
}

// --- desired text -----------------------------------------------------------

function computeNewConfig(pre, desiredBlock) {
  if (pre.configText === null) {
    return { newText: desiredBlock, appended: desiredBlock, createdConfig: true };
  }
  if (pre.block === null) {
    const sep = pre.configText === '' ? '' : (pre.configText.endsWith('\n') ? '\n' : '\n\n');
    const appended = sep + desiredBlock;
    return { newText: pre.configText + appended, appended, createdConfig: false };
  }
  const newText = pre.configText.slice(0, pre.block.start) + desiredBlock + pre.configText.slice(pre.block.end);
  const oldAppended = Buffer.from(pre.record.appendedBase64, 'base64').toString('utf8');
  const sep = oldAppended.slice(0, oldAppended.length - pre.block.content.length);
  return { newText, appended: sep + desiredBlock, createdConfig: pre.record.createdConfig === true };
}

const desiredSkillsFor = (io, spec) => desiredSkillFiles(io, {
  skillSrc: spec.skillSrc, cliPath: spec.cliPath, hostId: spec.hostId,
});

// --- install ----------------------------------------------------------------

export async function installTomlHost(spec, { io = defaultIo(), dryRun = false } = {}) {
  // A dry run is read-only: no lock file, no state directory, no writes.
  const release = dryRun ? async () => {} : await acquireLock(io, {
    lockPath: spec.lockPath, directory: spec.homeDir, directoryLabel: spec.homeLabel,
  });
  const w = { staging: null, quarantine: null, configWrote: false, destSwapped: false };
  // Hosts without a skill directory (desktop apps, unverified hosts) only get
  // the MCP registration; the skill tree is never staged for them.
  const skillsEnabled = Boolean(spec.skillsDir && spec.skillSrc);
  try {
    const pre = await preflight(io, spec);
    if (spec.expectedSourceConfigSha256 !== undefined
      && (pre.configText === null ? null : sha256(pre.configText)) !== spec.expectedSourceConfigSha256) {
      throw new InstallError('CONFIG_CHANGED', 'Host configuration changed after source inspection; no registration was written');
    }
    const desiredBlock = buildBlock(spec, spec.nodePath, spec.mcpPath);
    const desiredSkills = skillsEnabled ? await desiredSkillsFor(io, spec) : {};
    const { newText, appended, createdConfig } = computeNewConfig(pre, desiredBlock);
    parseConfig(newText); // candidate must parse before any write/stage/backup

    // The unchanged check only holds when the skill tree already sits at the
    // new destination and matches; a legacy directory still counts as owned
    // but needs the rename, not an idempotent no-op.
    const skillsUnchanged = !skillsEnabled || (pre.destExists
      && pre.skillDestActual === spec.skillDest && skillHashesMatch(desiredSkills, pre.record?.skillFiles));
    const unchanged = pre.record !== null && pre.block !== null
      && sha256(pre.block.content) === sha256(desiredBlock) && skillsUnchanged;
    if (unchanged) {
      return { ok: true, alreadyInstalled: true, host: spec.hostId, configPath: spec.configPath, skillDir: spec.skillDest ?? null };
    }
    if (dryRun) {
      return {
        ok: true, wouldInstall: true, host: spec.hostId, configPath: spec.configPath,
        changes: { config: pre.configText !== newText, skills: skillsEnabled && !skillsUnchanged },
      };
    }

    const skillNeedsUpdate = skillsEnabled && !skillsUnchanged;
    const configChanging = pre.configText !== newText;

    try {
      if (skillNeedsUpdate) {
        await ensureDirectory(io, spec.skillsDir, { label: 'skills directory' });
        w.staging = join(spec.skillsDir, `.staging-${randomUUID()}`);
        await copySkillInto(io, {
          skillSrc: spec.skillSrc, dest: w.staging, cliPath: spec.cliPath, hostId: spec.hostId,
          keepSet: new Set(Object.keys(desiredSkills)),
        });
      }
      if (configChanging) {
        if (pre.configText !== null) await backupFile(io, { path: spec.configPath });
        await writeFileGuarded(io, {
          path: spec.configPath, expected: pre.configText, newText, label: 'config.toml', phase: 'installation',
        });
        w.configWrote = true;
        w.newText = newText;
      }
      if (w.staging) {
        if (pre.destExists) {
          const ownedDest = pre.skillDestActual ?? spec.skillDest;
          if (!(await dirMatchesPostimage(io, ownedDest, pre.record.skillFiles))) {
            throw new InstallError('OWNED_MODIFIED', 'Managed skill directory changed during installation; aborted');
          }
          w.quarantine = join(spec.skillsDir, `.prev-${randomUUID()}`);
          await io.rename(ownedDest, w.quarantine);
          w.ownedDest = ownedDest;
        }
        await io.rename(w.staging, spec.skillDest);
        w.staging = null;
        w.destSwapped = pre.destExists;
        w.destCreated = !pre.destExists;
      }
      const record = {
        ...(spec.recordStyle === 'codex'
          ? { schema: 1, createdConfig }
          : { schema: 2, host: spec.hostId, format: 'toml', createdConfig }),
        blockSha256: sha256(desiredBlock),
        appendedBase64: Buffer.from(appended ?? desiredBlock, 'utf8').toString('base64'),
        nodePath: spec.nodePath,
        mcpPath: spec.mcpPath,
        cliPath: spec.cliPath,
        skillFiles: desiredSkills,
      };
      const nextRecordBytes = `${JSON.stringify(record, null, 2)}\n`;
      // optimistic byte checks immediately before the commit point
      const currentRecordText = await readRecordText(io, spec);
      if (currentRecordText !== pre.recordText) {
        throw new InstallError('CONFIG_CHANGED', 'Install record changed during installation; aborted');
      }
      await ensureDirectory(io, dirname(spec.recordPath), { label: 'record directory' });
      await writeFileAtomic(io, spec.recordPath, nextRecordBytes);
      w.committed = true;
    } catch (error) {
      const leftover = [];
      if (w.staging) {
        await io.rm(w.staging, { recursive: true, force: true }).catch(() => {
          leftover.push(`staging directory (kept: ${w.staging})`);
        });
      }
      if (w.configWrote) {
        await rollbackFile(io, {
          path: spec.configPath, expectedPost: w.newText, original: pre.configText, leftover, label: 'config.toml',
        });
      }
      if (w.destCreated || w.destSwapped) {
        const intact = await dirMatchesPostimage(io, spec.skillDest, desiredSkills).catch(() => false);
        if (intact) {
          await io.rm(spec.skillDest, { recursive: true, force: true }).catch(() => {
            leftover.push('skill directory');
          });
        } else {
          leftover.push('skill directory');
        }
      }
      if (w.quarantine) await restoreQuarantinedSkill(io, { skillDest: w.ownedDest ?? spec.skillDest, quarantine: w.quarantine, leftover });
      if (leftover.length) {
        error.details = { ...(error.details ?? {}), incompleteRollback: leftover };
      }
      throw error;
    }
    if (w.staging) await io.rm(w.staging, { recursive: true, force: true }).catch(() => {});
    const cleanupPending = [];
    if (w.quarantine) {
      try {
        await io.rm(w.quarantine, { recursive: true, force: true });
      } catch {
        cleanupPending.push(w.quarantine);
      }
    }
    return {
      ok: true, installed: true, host: spec.hostId, configPath: spec.configPath, skillDir: spec.skillDest ?? null,
      ...(cleanupPending.length ? { cleanupPending } : {}),
    };
  } finally {
    await release();
  }
}

// --- uninstall --------------------------------------------------------------

export async function uninstallTomlHost(spec, { io = defaultIo(), dryRun = false } = {}) {
  const release = dryRun ? async () => {} : await acquireLock(io, {
    lockPath: spec.lockPath, directory: spec.homeDir, directoryLabel: spec.homeLabel,
  });
  const w = { quarantine: null, configWrote: false };
  try {
    const pre = await preflight(io, spec, { forUninstall: true });
    if (pre.block === null && pre.record === null && !pre.destExists) {
      return { ok: true, removed: false, host: spec.hostId };
    }
    const block = pre.block;
    let newText = pre.configText;
    if (block !== null) {
      if (sha256(block.content) !== pre.record.blockSha256) {
        throw new InstallError('OWNED_MODIFIED', 'Managed config block was modified; refusing removal');
      }
      const appended = Buffer.from(pre.record.appendedBase64, 'base64').toString('utf8');
      if (pre.configText.endsWith(appended)) {
        newText = pre.configText.slice(0, pre.configText.length - appended.length);
      } else {
        let start = block.start;
        const sep = appended.slice(0, appended.length - block.content.length);
        if (sep !== '' && pre.configText.slice(start - sep.length, start) === sep) start -= sep.length;
        newText = pre.configText.slice(0, start) + pre.configText.slice(block.end);
      }
    }
    if (newText !== pre.configText) parseConfig(newText);

    if (dryRun) {
      return {
        ok: true, wouldRemove: true, host: spec.hostId, configPath: spec.configPath,
        changes: {
          config: newText !== pre.configText,
          removesFile: pre.record?.createdConfig === true && (newText ?? '').trim() === '',
          skills: pre.destExists,
        },
      };
    }

    const expectedPost = (pre.record?.createdConfig === true && typeof newText === 'string' && newText.trim() === '') ? null : newText;
    try {
      if (pre.destExists) {
        const ownedDest = pre.skillDestActual ?? spec.skillDest;
        if (!(await dirMatchesPostimage(io, ownedDest, pre.record.skillFiles))) {
          throw new InstallError('OWNED_MODIFIED', 'Managed skill directory changed; refusing partial removal');
        }
        w.quarantine = join(spec.skillsDir, `.quarantine-${randomUUID()}`);
        await io.rename(ownedDest, w.quarantine);
        w.ownedDest = ownedDest;
      }
      if (newText !== pre.configText) {
        if (pre.configText !== null) await backupFile(io, { path: spec.configPath });
        if (expectedPost === null) {
          const current = await readIfFile(io, spec.configPath, 'config.toml');
          if (current !== pre.configText) {
            throw new InstallError('CONFIG_CHANGED', 'config.toml changed during uninstall; aborted');
          }
          await removeFileGuarded(io, {
            path: spec.configPath, expected: pre.configText, label: 'config.toml', phase: 'removal',
          });
        } else {
          await writeFileGuarded(io, {
            path: spec.configPath, expected: pre.configText, newText, label: 'config.toml', phase: 'uninstall',
          });
        }
        w.configWrote = true;
        w.expectedPost = expectedPost;
      }
      const currentRecordText = await readRecordText(io, spec);
      if (currentRecordText !== pre.recordText) {
        throw new InstallError('CONFIG_CHANGED', 'Install record changed during uninstall; aborted');
      }
      await io.unlink(spec.recordPath); // commit point
      w.committed = true;
    } catch (error) {
      const leftover = [];
      if (w.configWrote) {
        await rollbackFile(io, {
          path: spec.configPath, expectedPost: w.expectedPost, original: pre.configText, leftover, label: 'config.toml',
        });
      }
      if (w.quarantine) await restoreQuarantinedSkill(io, { skillDest: w.ownedDest ?? spec.skillDest, quarantine: w.quarantine, leftover });
      if (leftover.length) error.details = { ...(error.details ?? {}), incompleteRollback: leftover };
      throw error;
    }
    const cleanupPending = [];
    if (w.quarantine) {
      try {
        await io.rm(w.quarantine, { recursive: true, force: true });
      } catch {
        cleanupPending.push(w.quarantine);
      }
    }
    return {
      ok: true, removed: true, host: spec.hostId,
      ...(cleanupPending.length ? { cleanupPending } : {}),
    };
  } finally {
    await release();
  }
}

// --- check ------------------------------------------------------------------

export async function checkTomlHost(spec, { io = defaultIo() } = {}) {
  const issues = [];
  let record = null;
  try {
    record = await readRecord(io, spec);
  } catch (e) {
    if (e instanceof InstallError) issues.push(`record: ${e.message}`);
    else throw e;
  }
  if (record === null && !issues.length) issues.push('install record missing');

  let block = null;
  let parsed = {};
  try {
    await assertNotSymlink(io, spec.configPath, 'config.toml');
    if (spec.skillsDir) {
      await assertNotSymlink(io, spec.skillsDir, 'skills directory');
      await assertNotSymlink(io, spec.skillDest, 'skill destination');
    }
    const configText = await readIfFile(io, spec.configPath, 'config.toml');
    parsed = parseConfig(configText);
    block = configText === null ? null : findBlock(configText);
    if (!hasServer(parsed, spec)) issues.push(`mcp_servers.${spec.serverName} not registered in config.toml`);
    if (block === null) issues.push('managed block missing from config.toml');
    else if (record !== null && sha256(block.content) !== record.blockSha256) {
      issues.push('managed block content changed after installation');
    }
  } catch (e) {
    if (e instanceof InstallError) issues.push(`config: ${e.message}`);
    else throw e;
  }

  if (record !== null) {
    if (isNodeCommand(record.nodePath)) {
      if (!await nodeCommandExists(record.nodePath)) issues.push('node command missing');
    } else if (typeof record.nodePath !== 'string' || !isAbsolute(record.nodePath) || (await lstatSafe(io, record.nodePath)) === null) {
      issues.push('node path missing');
    }
    for (const [label, p] of [['mcp server', record.mcpPath], ['cli', record.cliPath]]) {
      if (typeof p !== 'string' || !isAbsolute(p) || (await lstatSafe(io, p)) === null) issues.push(`${label} path missing`);
    }
    const actual = parsed?.mcp_servers?.[spec.serverName];
    if (actual && (!exactOwnedEntry(actual, spec) || !entryMatches(actual, record, spec))) {
      issues.push('parsed entry does not match the recorded registration');
    }
    // The skill tree may still live under the pre-rename directory; both are
    // reported as present, the new one being the expected post-upgrade state.
    const skillDests = [spec.skillDest, spec.legacySkillDest].filter(Boolean);
    let foundSkillDest = null;
    for (const dest of skillDests) {
      if ((await lstatSafe(io, dest)) !== null) { foundSkillDest = dest; break; }
    }
    if (skillDests.length) {
      const skillsStat = await lstatSafe(io, spec.skillsDir);
      const destStat = foundSkillDest === null ? null : await lstatSafe(io, foundSkillDest);
      if (skillsStat?.isSymbolicLink() || destStat?.isSymbolicLink()) {
        issues.push('skill directory is a symlink');
      } else if (foundSkillDest === null) {
        issues.push('skill directory missing');
      } else if (!destStat?.isDirectory()) {
        issues.push('skill destination is not a directory');
      } else {
        if (foundSkillDest !== spec.skillDest) {
          issues.push(`skill directory at legacy path ${foundSkillDest}; reinstall to move it`);
        }
        await verifySkillTree(io, {
          skillDest: foundSkillDest, postHashes: record.skillFiles, issues,
        });
        await checkSkillFreshness(io, { skillSrc: spec.skillSrc, cliPath: spec.cliPath, hostId: spec.hostId, recorded: record.skillFiles, issues });
        try {
          const rt = JSON.parse(await io.readFile(join(foundSkillDest, 'runtime.json'), 'utf8'));
          if (!rt || typeof rt.cli !== 'string' || (await lstatSafe(io, rt.cli)) === null) {
            issues.push('runtime.json cli path is invalid');
          }
        } catch { issues.push('runtime.json is missing or unreadable'); }
      }
    }
  }
  const installed = record !== null && block !== null;
  const healthy = installed && issues.length === 0;
  return { ok: true, host: spec.hostId, installed, healthy, issues, configPath: spec.configPath };
}
