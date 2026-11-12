// JSON host adapter: installs one MCP server entry into a host config file.
//
// Ownership model, mirroring the TOML adapter: only the install record proves a
// member is ours. An entry we did not write is never adopted, modified or
// removed; a member that changed after install is OWNED_MODIFIED. Every write is
// a splice on the original text, so unrelated settings keep their exact bytes.
import { basename, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
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
import {
  insertMember, removeMember, getMember, buildDocument, buildMemberText,
  canonical, isEmptyObject,
} from './json-text.mjs';

const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

const entryHash = (spec, nodePath, mcpPath) => sha256(canonical(spec.entry({ nodePath, mcpPath })));
const label = (target) => basename(target.configPath);

function parseConfigJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InstallError('CONFIG_INVALID', 'config file is not a JSON object');
    }
    return parsed;
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('CONFIG_INVALID', 'config file is not valid JSON');
  }
}

// --- install record ---------------------------------------------------------

export function validateHostRecord(data, spec, target) {
  const bad = (m) => { throw new InstallError('INSTALL_CONFLICT', `Install record invalid: ${m}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('not an object');
  if (data.schema !== 2) bad('schema');
  if (data.host !== spec.id) bad('host');
  if (data.format !== 'json') bad('format');
  for (const key of ['mcpPath', 'cliPath', 'configPath']) {
    if (typeof data[key] !== 'string' || !isAbsolute(data[key])) bad(`${key} not absolute`);
  }
  if (!isNodeCommand(data.nodePath) && (typeof data.nodePath !== 'string' || !isAbsolute(data.nodePath))) bad('nodePath not absolute');
  if (data.configPath !== target.configPath) bad('configPath');
  if (!Array.isArray(data.container) || data.container.length === 0
    || data.container.some((s) => typeof s !== 'string' || !SAFE_KEY_RE.test(s))) bad('container');
  if (data.container.join('.') !== spec.container.join('.')) bad('container');
  if (data.serverName !== spec.serverName) bad('serverName');
  if (typeof data.entrySha256 !== 'string' || !HASH_RE.test(data.entrySha256)) bad('entrySha256');
  if (typeof data.createdFile !== 'boolean') bad('createdFile');
  if (typeof data.createdContainer !== 'boolean') bad('createdContainer');
  if (data.skillDir !== null && (typeof data.skillDir !== 'string' || !isAbsolute(data.skillDir))) bad('skillDir');
  const allowedDests = new Set([target.skillDest, target.legacySkillDest].filter(Boolean));
  if (data.skillDir !== null && !allowedDests.has(data.skillDir)) bad('skillDir mismatch');
  if (!data.skillFiles || typeof data.skillFiles !== 'object' || Array.isArray(data.skillFiles)) bad('skillFiles');
  for (const [rel, hash] of Object.entries(data.skillFiles)) {
    if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) bad('skillFiles key');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) bad('skillFiles hash');
  }
  if (entryHash(spec, data.nodePath, data.mcpPath) !== data.entrySha256) bad('entrySha256 mismatch');
  return data;
}

export async function readRecord(io, spec, target) {
  const text = await readIfFile(io, target.recordPath, 'install record');
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstallError('INSTALL_CONFLICT', 'Install record is not valid JSON');
  }
  return validateHostRecord(data, spec, target);
}

// --- preflight --------------------------------------------------------------

function containerIsObject(doc, container) {
  let cursor = doc;
  for (const segment of container) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
    if (!Object.hasOwn(cursor, segment)) return null;
    cursor = cursor[segment];
  }
  return Boolean(cursor) && typeof cursor === 'object' && !Array.isArray(cursor);
}

async function preflight(io, spec, target, { forUninstall = false } = {}) {
  await assertNotSymlink(io, target.configPath, label(target));
  await assertNotSymlink(io, target.recordPath, 'install record');
  if (target.skillsDir) {
    await assertNotSymlink(io, target.skillsDir, 'skills directory');
    await assertNotSymlink(io, target.skillDest, 'skill destination');
    if (target.legacySkillDest) await assertNotSymlink(io, target.legacySkillDest, 'legacy skill destination');
  }

  const configText = await readIfFile(io, target.configPath, label(target));
  const parsed = configText === null ? null : parseConfigJson(configText);
  const record = await readRecord(io, spec, target);
  const current = configText === null ? undefined : getMember(configText, [...spec.container, spec.serverName]);

  if (current !== undefined && record === null) {
    throw new InstallError('INSTALL_CONFLICT',
      `${label(target)} already registers mcpServers.${spec.serverName} (${spec.container.join('.')}) without an install record`);
  }
  if (forUninstall && record === null && current === undefined) {
    // nothing of ours here
  }
  if (current !== undefined && record !== null) {
    if (sha256(canonical(current)) !== record.entrySha256) {
      throw new InstallError('OWNED_MODIFIED', 'Installed MCP entry was modified after installation');
    }
  }
  if (parsed !== null) {
    const state = containerIsObject(parsed, spec.container);
    if (state === false) {
      throw new InstallError('CONFIG_INVALID',
        `${label(target)} has ${spec.container.join('.')} but it is not a JSON object`);
    }
  }

  // The record's skillDir decides which physical directory is ours: installs
  // written before the entry rename keep pointing at legacySkillDest.
  const skillDestActual = (record?.skillDir && record.skillDir === target.legacySkillDest)
    ? target.legacySkillDest : target.skillDest;
  const destStat = skillDestActual ? await lstatSafe(io, skillDestActual) : null;
  if (destStat !== null) {
    if (record === null) {
      throw new InstallError('INSTALL_CONFLICT', `Skill destination ${skillDestActual} exists and is not owned`);
    }
    await assertOwnedSkillTree(io, { skillDest: skillDestActual, postHashes: record.skillFiles });
  }
  return { configText, parsed, record, current, destExists: destStat !== null, skillDestActual };
}

// Produce the new config text that holds exactly our entry.
function desiredConfigText(pre, spec, entry, entryText) {
  const { configText, current } = pre;
  const containerExists = configText !== null && getMember(configText, spec.container) !== undefined;
  if (configText === null) {
    return { newText: buildDocument(spec.container, spec.serverName, entryText), createdFile: true, createdContainer: true };
  }
  if (!containerExists) {
    const valueText = buildMemberText(spec.container.slice(1), spec.serverName, entryText);
    return {
      newText: insertMember(configText, [], spec.container[0], valueText),
      createdFile: false, createdContainer: true,
    };
  }
  if (current === undefined) {
    return { newText: insertMember(configText, spec.container, spec.serverName, entryText), createdFile: false, createdContainer: false };
  }
  if (canonical(current) === canonical(entry)) {
    // already exactly what we would write: keep the file bytes as they are
    return { newText: configText, createdFile: false, createdContainer: false };
  }
  // ours but stale (e.g. the node binary moved): replace in place
  const withoutMember = removeMember(configText, spec.container, spec.serverName);
  return { newText: insertMember(withoutMember, spec.container, spec.serverName, entryText), createdFile: false, createdContainer: false };
}

// --- install ----------------------------------------------------------------

export async function installJsonHost(spec, target, {
  io = defaultIo(), nodePath, mcpPath, cliPath, skillSrc, dryRun = false,
} = {}) {
  // A dry run is read-only: no lock file, no state directory, no writes.
  const release = dryRun ? async () => {} : await acquireLock(io, {
    lockPath: target.lockPath, directory: dirname(target.lockPath), directoryLabel: 'state directory',
  });
  const w = { staging: null, quarantine: null, wrote: false };
  try {
    const pre = await preflight(io, spec, target);
    if (spec.expectedSourceConfigSha256 !== undefined
      && (pre.configText === null ? null : sha256(pre.configText)) !== spec.expectedSourceConfigSha256) {
      throw new InstallError('CONFIG_CHANGED', 'Host configuration changed after source inspection; no registration was written');
    }
    const entry = spec.entry({ nodePath, mcpPath });
    const entryText = JSON.stringify(entry);
    const { newText, createdFile, createdContainer } = desiredConfigText(pre, spec, entry, entryText);
    const desiredSkills = target.skillsDir
      ? await desiredSkillFiles(io, { skillSrc, cliPath, hostId: spec.id })
      : {};

    const configUnchanged = newText === pre.configText;
    // The unchanged check only holds when the tree already sits at the new
    // destination; a legacy directory is owned but still needs the rename.
    const skillsUnchanged = !target.skillsDir || (pre.destExists
      && pre.skillDestActual === target.skillDest && skillHashesMatch(desiredSkills, pre.record?.skillFiles));
    if (pre.record !== null && configUnchanged && skillsUnchanged) {
      return { ok: true, alreadyInstalled: true, host: spec.id, configPath: target.configPath, skillDir: target.skillDest ?? null };
    }
    if (dryRun) {
      return {
        ok: true, wouldInstall: true, host: spec.id, configPath: target.configPath,
        changes: { config: !configUnchanged, skills: Boolean(target.skillsDir) && !skillsUnchanged },
      };
    }

    const skillNeedsUpdate = Boolean(target.skillsDir) && !skillsUnchanged;
    try {
      if (skillNeedsUpdate) {
        await ensureDirectory(io, target.skillsDir, { label: 'skills directory' });
        w.staging = `${target.skillsDir}/.staging-${randomUUID()}`;
        await copySkillInto(io, {
          skillSrc, dest: w.staging, cliPath, hostId: spec.id, keepSet: new Set(Object.keys(desiredSkills)),
        });
      }
      if (!configUnchanged) {
        await ensureDirectory(io, dirname(target.configPath), { label: 'config directory' });
        if (pre.configText !== null) await backupFile(io, { path: target.configPath, label: label(target) });
        await writeFileGuarded(io, {
          path: target.configPath, expected: pre.configText, newText, label: label(target), phase: 'installation',
        });
        w.wrote = true;
        w.newText = newText;
      }
      if (w.staging) {
        if (pre.destExists) {
          const ownedDest = pre.skillDestActual ?? target.skillDest;
          if (!(await dirMatchesPostimage(io, ownedDest, pre.record.skillFiles))) {
            throw new InstallError('OWNED_MODIFIED', 'Managed skill directory changed during installation; aborted');
          }
          w.quarantine = `${target.skillsDir}/.prev-${randomUUID()}`;
          await io.rename(ownedDest, w.quarantine);
          w.ownedDest = ownedDest;
        }
        await io.rename(w.staging, target.skillDest);
        w.staging = null;
        w.destSwapped = pre.destExists;
        w.destCreated = !pre.destExists;
      }
      const record = {
        schema: 2,
        host: spec.id,
        format: 'json',
        configPath: target.configPath,
        container: [...spec.container],
        serverName: spec.serverName,
        entrySha256: sha256(canonical(entry)),
        createdFile: pre.record?.createdFile === true || createdFile,
        createdContainer: pre.record?.createdContainer === true || createdContainer,
        nodePath,
        mcpPath,
        cliPath,
        skillDir: target.skillDest ?? null,
        skillFiles: desiredSkills,
      };
      await ensureDirectory(io, dirname(target.recordPath), { label: 'record directory' });
      await writeFileAtomic(io, target.recordPath, `${JSON.stringify(record, null, 2)}\n`);
      w.committed = true;
    } catch (error) {
      const leftover = [];
      if (w.staging) {
        await io.rm(w.staging, { recursive: true, force: true }).catch(() => {
          leftover.push(`staging directory (kept: ${w.staging})`);
        });
      }
      if (w.wrote) {
        await rollbackFile(io, {
          path: target.configPath, expectedPost: w.newText, original: pre.configText, leftover, label: label(target),
        });
      }
      if (w.destCreated || w.destSwapped) {
        const intact = await dirMatchesPostimage(io, target.skillDest, desiredSkills).catch(() => false);
        if (intact) {
          await io.rm(target.skillDest, { recursive: true, force: true }).catch(() => {
            leftover.push('skill directory');
          });
        } else {
          leftover.push('skill directory');
        }
      }
      if (w.quarantine) {
        await restoreQuarantinedSkill(io, { skillDest: w.ownedDest ?? target.skillDest, quarantine: w.quarantine, leftover });
      }
      if (leftover.length) error.details = { ...(error.details ?? {}), incompleteRollback: leftover };
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
      ok: true, installed: true, host: spec.id, configPath: target.configPath, skillDir: target.skillDest ?? null,
      recordPath: target.recordPath,
      ...(cleanupPending.length ? { cleanupPending } : {}),
    };
  } finally {
    await release();
  }
}

// --- uninstall --------------------------------------------------------------

export async function uninstallJsonHost(spec, target, { io = defaultIo(), dryRun = false } = {}) {
  const release = dryRun ? async () => {} : await acquireLock(io, {
    lockPath: target.lockPath, directory: dirname(target.lockPath), directoryLabel: 'state directory',
  });
  const w = { quarantine: null, wrote: false };
  try {
    const pre = await preflight(io, spec, target, { forUninstall: true });
    if (pre.record === null && pre.current === undefined && !pre.destExists) {
      return { ok: true, removed: false, host: spec.id };
    }
    // Our entry may already be gone: the user hand-edited the config, another
    // installer rewrote it, or the file itself was deleted. That is a normal
    // end state, not an error — only the install record and the owned skill
    // tree are cleaned up, and the user's remaining bytes stay untouched.
    // A *modified* entry still fails earlier, in preflight, as OWNED_MODIFIED.
    const ownsEntry = pre.configText !== null && pre.current !== undefined;
    let newText = pre.configText;
    let removeFile = false;
    if (ownsEntry) {
      newText = removeMember(pre.configText, spec.container, spec.serverName);
      const containerAfter = getMember(newText, spec.container);
      if (pre.record?.createdContainer && isEmptyObject(containerAfter)) {
        newText = removeMember(newText, spec.container.slice(0, -1), spec.container[spec.container.length - 1]);
      }
      if (pre.record?.createdFile) {
        const after = JSON.parse(newText);
        if (isEmptyObject(after)) {
          removeFile = true;
          newText = null;
        }
      }
    }

    if (dryRun) {
      return {
        ok: true, wouldRemove: true, host: spec.id, configPath: target.configPath,
        changes: { config: ownsEntry, removesFile: removeFile, skills: pre.destExists },
      };
    }

    try {
      if (pre.destExists) {
        const ownedDest = pre.skillDestActual ?? target.skillDest;
        if (!(await dirMatchesPostimage(io, ownedDest, pre.record.skillFiles))) {
          throw new InstallError('OWNED_MODIFIED', 'Managed skill directory changed; refusing partial removal');
        }
        w.quarantine = `${target.skillsDir}/.quarantine-${randomUUID()}`;
        await io.rename(ownedDest, w.quarantine);
        w.ownedDest = ownedDest;
      }
      if (removeFile) {
        await backupFile(io, { path: target.configPath, label: label(target) });
        await removeFileGuarded(io, {
          path: target.configPath, expected: pre.configText, label: label(target), phase: 'removal',
        });
        w.wrote = true;
      } else if (ownsEntry && newText !== pre.configText) {
        await backupFile(io, { path: target.configPath, label: label(target) });
        await writeFileGuarded(io, {
          path: target.configPath, expected: pre.configText, newText, label: label(target), phase: 'removal',
        });
        w.wrote = true;
      }
      w.expectedPost = newText;
      await io.unlink(target.recordPath); // commit point
      w.committed = true;
    } catch (error) {
      const leftover = [];
      if (w.wrote) {
        await rollbackFile(io, {
          path: target.configPath, expectedPost: w.expectedPost, original: pre.configText, leftover, label: label(target),
        });
      }
      if (w.quarantine) {
        await restoreQuarantinedSkill(io, { skillDest: w.ownedDest ?? target.skillDest, quarantine: w.quarantine, leftover });
      }
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
      ok: true, removed: true, host: spec.id, configPath: target.configPath,
      ...(cleanupPending.length ? { cleanupPending } : {}),
    };
  } finally {
    await release();
  }
}

// --- check ------------------------------------------------------------------

export async function checkJsonHost(spec, target, { io = defaultIo() } = {}) {
  const issues = [];
  let record = null;
  try {
    record = await readRecord(io, spec, target);
  } catch (e) {
    if (e instanceof InstallError) issues.push(`record: ${e.message}`);
    else throw e;
  }
  if (record === null && !issues.length) issues.push('install record missing');

  let parsed = null;
  let configText = null;
  try {
    await assertNotSymlink(io, target.configPath, label(target));
    configText = await readIfFile(io, target.configPath, label(target));
    parsed = configText === null ? null : parseConfigJson(configText);
  } catch (e) {
    if (e instanceof InstallError) issues.push(`config: ${e.message}`);
    else throw e;
  }

  let current;
  if (configText !== null) {
    try {
      current = getMember(configText, [...spec.container, spec.serverName]);
    } catch {
      current = undefined;
    }
  }
  if (current === undefined) issues.push(`${spec.container.join('.')}.${spec.serverName} is not registered`);
  else if (record !== null && sha256(canonical(current)) !== record.entrySha256) {
    issues.push('installed MCP entry changed after installation');
  }

  if (record !== null) {
    if (isNodeCommand(record.nodePath)) {
      if (!await nodeCommandExists(record.nodePath)) issues.push('node command missing');
    } else if ((await lstatSafe(io, record.nodePath)) === null) issues.push('node path missing');
    for (const [name, p] of [['mcp server', record.mcpPath], ['cli', record.cliPath]]) {
      if ((await lstatSafe(io, p)) === null) issues.push(`${name} path missing`);
    }
    const skillDestActual = (record.skillDir && record.skillDir === target.legacySkillDest)
      ? target.legacySkillDest : target.skillDest;
    if (skillDestActual) {
      const parentStat = await lstatSafe(io, target.skillsDir);
      const destStat = await lstatSafe(io, skillDestActual);
      if (parentStat?.isSymbolicLink() || destStat?.isSymbolicLink()) {
        issues.push('skill directory is a symlink');
      } else if (destStat === null) {
        issues.push('skill directory missing');
      } else if (!destStat.isDirectory()) {
        issues.push('skill destination is not a directory');
      } else {
        if (skillDestActual !== target.skillDest) issues.push(`skill directory at legacy path ${skillDestActual}; reinstall to move it`);
        await verifySkillTree(io, { skillDest: skillDestActual, postHashes: record.skillFiles, issues });
        await checkSkillFreshness(io, { skillSrc: spec.skillSrc, cliPath: spec.cliPath, hostId: spec.id, recorded: record.skillFiles, issues });
        try {
          const rt = JSON.parse(await io.readFile(`${skillDestActual}/runtime.json`, 'utf8'));
          if (!rt || typeof rt.cli !== 'string' || (await lstatSafe(io, rt.cli)) === null) {
            issues.push('runtime.json cli path is invalid');
          }
        } catch { issues.push('runtime.json is missing or unreadable'); }
      }
    }
  }
  const installed = record !== null;
  return {
    ok: true, host: spec.id, installed, healthy: installed && issues.length === 0, issues,
    configPath: target.configPath,
  };
}
