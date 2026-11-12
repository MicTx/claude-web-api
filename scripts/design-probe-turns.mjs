import { createHash } from 'node:crypto';
import { activeBranch } from '../src/core/claude-api.mjs';
import { parseStrictJson } from './design-probe-json.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VERSION = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const PUBLICATION = 'mcp__claude-artifacts__publish_files';
const ROOT = '00000000-0000-4000-8000-000000000000';
const MAX_FILE = 2 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
const KNOWN_TOOLS = new Set(['Write', 'Read', PUBLICATION]);
export const PUBLICATION_REASON_CODES = Object.freeze(['duplicate_tool_identity', 'identity_fields_missing', 'identity_invalid',
  'lineage_unverified', 'multiple_candidates', 'no_publish_tool', 'oversized', 'publication_conflict',
  'result_error', 'result_unparsable', 'turn_unverified', 'unknown_result_shape', 'use_result_identity_mismatch', 'use_without_result']);
const failure = () => ({ status: 'unverified' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizePrompt = value => value.replace(/\r\n?/g, '\n').trim();

export function confirmMutationTurn(conversation, { parentMessageId, prompt }) {
  try {
    if (!UUID.test(conversation?.uuid ?? '') || !UUID.test(parentMessageId ?? '') || typeof prompt !== 'string') return failure();
    const branch = activeBranch(conversation);
    const parentIndex = parentMessageId === ROOT ? -1 : branch.findIndex(message => message.uuid === parentMessageId);
    if (parentMessageId !== ROOT && parentIndex < 0) return failure();
    const suffix = branch.slice(parentIndex + 1);
    if (suffix.length !== 2 || suffix[0].sender !== 'human' || suffix[1].sender !== 'assistant') return failure();
    const human = suffix[0];
    const assistant = suffix[1];
    const parentChildren = conversation.chat_messages.filter(message => message.parent_message_uuid === parentMessageId);
    const humanChildren = conversation.chat_messages.filter(message => message.parent_message_uuid === human.uuid);
    if (parentChildren.length !== 1 || parentChildren[0].uuid !== human.uuid
      || humanChildren.length !== 1 || humanChildren[0].uuid !== assistant.uuid
      || !human.content.every(block => block?.type === 'text' && typeof block.text === 'string')
      || normalizePrompt(human.content.map(block => block.text).join('')) !== normalizePrompt(prompt)
      || !Array.isArray(human.attachments) || human.attachments.length !== 0
      || !Array.isArray(human.files) || human.files.length !== 0
      || !['end_turn', 'stop_sequence', 'refusal', 'max_tokens', 'model_context_window_exceeded'].includes(assistant.stop_reason)
      || assistant.content.length === 0) return failure();
    return { status: 'confirmed', humanMessageId: human.uuid, assistantMessageId: assistant.uuid,
      complete: assistant.truncated !== true && !['max_tokens', 'model_context_window_exceeded'].includes(assistant.stop_reason) };
  } catch {
    return failure();
  }
}

function pathSafe(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || value.startsWith('/')
    || /[\\:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.length <= 8 && parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !['__proto__', 'prototype', 'constructor'].includes(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
}

function publicationResult(block, reject) {
  if (!Array.isArray(block.content) || block.content.length !== 1 || block.content[0]?.type !== 'text'
    || typeof block.content[0].text !== 'string') return reject('unknown_result_shape');
  if (Buffer.byteLength(block.content[0].text) > 256 * 1024) return reject('oversized');
  let value;
  try { value = parseStrictJson(Buffer.from(block.content[0].text), { rejectPrototypeKeys: true }); }
  catch { return reject('result_unparsable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('unknown_result_shape');
  if (!value || !UUID.test(value.slug ?? '') || typeof value.version !== 'string' || !VERSION.test(value.version)
    || !Number.isSafeInteger(value.seq) || value.seq < 1 || !Number.isSafeInteger(value.own_file_count)
    || value.own_file_count < 1 || value.own_file_count > 32 || !Array.isArray(value.history)
    || value.history.length < 1 || value.history.length > 256
    || value.history.some(item => typeof item !== 'string' || !VERSION.test(item))
    || new Set(value.history).size !== value.history.length || !value.history.includes(value.version)
    || typeof value.url !== 'string' || value.url.length > 200) {
    return reject(value && typeof value === 'object' && !Array.isArray(value)
      && ['slug', 'version', 'seq', 'own_file_count', 'history', 'url'].some(key => !Object.hasOwn(value, key))
      ? 'identity_fields_missing' : 'identity_invalid');
  }
  let url;
  try { url = new URL(value.url); } catch { return reject('identity_invalid'); }
  if (url.origin !== 'https://claude.ai' || url.username || url.password || url.search || url.hash
    || !/^\/artifact\/[A-Za-z0-9_-]{10,80}$/.test(url.pathname)) return reject('identity_invalid');
  return { frameId: value.slug.toLowerCase(), shortId: url.pathname.slice('/artifact/'.length), version: value.version,
    sequence: value.seq, history: [...value.history], fileCount: value.own_file_count };
}

function writeClaims(blocks, useIndex, publicationUse) {
  const files = publicationUse.input?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) return [];
  const claimed = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 4096 || !pathSafe(file.as)) return [];
    let writeIndex = -1;
    for (let index = useIndex - 1; index >= 0; index--) {
      const block = blocks[index];
      if (block?.type === 'tool_use' && block.name === 'Write' && block.input?.file_path === file.path) {
        writeIndex = index;
        break;
      }
    }
    if (writeIndex < 0) return [];
    const write = blocks[writeIndex];
    const results = blocks.slice(writeIndex + 1, useIndex).filter(block => block?.type === 'tool_result'
      && block.tool_use_id === write.id && block.name === 'Write');
    const nextToolBlock = blocks.slice(writeIndex + 1, useIndex).find(block => ['tool_use', 'tool_result'].includes(block?.type));
    if (results.length !== 1 || results[0] !== nextToolBlock || results[0].is_error !== false || typeof write.input?.content !== 'string'
      || !write.input.content.isWellFormed() || blocks.slice(writeIndex + 1, useIndex).some(block => block?.type === 'tool_use'
        && !['Write', 'Read'].includes(block.name))) return [];
    const bytes = Buffer.from(write.input.content, 'utf8');
    if (bytes.length < 1 || bytes.length > MAX_FILE) return [];
    claimed.push({ path: file.as, size: bytes.length, sha256: hash(bytes), hasCR: bytes.includes(13),
      hasBOM: write.input.content.startsWith('\uFEFF'), hasCombining: /[\u0300-\u036f]/u.test(write.input.content),
      hasCJK: /[\u3400-\u9fff]/u.test(write.input.content), hasEmoji: /\p{Extended_Pictographic}/u.test(write.input.content) });
  }
  return new Set(claimed.map(file => file.path.normalize('NFC').toLowerCase())).size === claimed.length ? claimed : [];
}

function mutationTurnResult(conversation, { parentMessageId, prompt, previous = null }, diagnostic) {
  const reject = reason => { diagnostic.reasonCodes.add(reason); return failure(); };
  try {
    const confirmed = confirmMutationTurn(conversation, { parentMessageId, prompt });
    if (confirmed.status !== 'confirmed') return reject('turn_unverified');
    const assistant = conversation.chat_messages.find(message => message.uuid === confirmed.assistantMessageId);
    if (!['end_turn', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded'].includes(assistant.stop_reason)) return reject('turn_unverified');
    if (assistant.content.length > 512) return reject('oversized');
    diagnostic.unknownToolPresent = assistant.content.some(block => block?.type === 'tool_use'
      && typeof block.name === 'string' && !KNOWN_TOOLS.has(block.name));
    const uses = new Map();
    const results = new Map();
    for (const [index, block] of assistant.content.entries()) {
      if (block?.type === 'tool_use') {
        if (typeof block.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(block.id)
          || typeof block.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(block.name)) diagnostic.reasonCodes.add('unknown_result_shape');
        else if (uses.has(block.id)) diagnostic.reasonCodes.add('duplicate_tool_identity');
        else uses.set(block.id, { block, index });
      } else if (block?.type === 'tool_result') {
        if (typeof block.tool_use_id !== 'string') diagnostic.reasonCodes.add('unknown_result_shape');
        else if (results.has(block.tool_use_id)) diagnostic.reasonCodes.add('duplicate_tool_identity');
        else results.set(block.tool_use_id, { block, index });
      }
    }
    if (diagnostic.reasonCodes.size) return failure();
    const publications = [];
    for (const [id, result] of results) {
      if (result.block.name === PUBLICATION && uses.get(id)?.block.name !== PUBLICATION) diagnostic.reasonCodes.add('use_result_identity_mismatch');
    }
    for (const [id, use] of uses) {
      if (use.block.name !== PUBLICATION) continue;
      const result = results.get(id);
      if (!result) { diagnostic.reasonCodes.add('use_without_result'); continue; }
      if (result.index <= use.index || result.block.name !== PUBLICATION) { diagnostic.reasonCodes.add('use_result_identity_mismatch'); continue; }
      if (result.block.is_error !== false) { diagnostic.reasonCodes.add(result.block.is_error === true ? 'result_error' : 'unknown_result_shape'); continue; }
      const publication = publicationResult(result.block, reason => { diagnostic.reasonCodes.add(reason); return null; });
      if (!publication) continue;
      if (publications.some(item => item.version === publication.version)) diagnostic.reasonCodes.add('publication_conflict');
      publications.push({ ...publication, toolUseId: id, toolName: use.block.name,
        sourceClaims: writeClaims(assistant.content, use.index, use.block) });
    }
    if (diagnostic.reasonCodes.size) return failure();
    if (!publications.length) return reject('no_publish_tool');
    const frameId = previous?.frameId ?? publications[0].frameId;
    if (publications.some(publication => publication.frameId !== frameId)) return reject('publication_conflict');
    let predecessor = previous;
    for (const publication of publications) {
      if (predecessor && (publication.shortId !== predecessor.shortId || publication.sequence !== predecessor.sequence + 1
        || publication.history.length !== predecessor.history.length + 1
        || predecessor.history.some((version, index) => publication.history[index] !== version)
        || publication.history.at(-1) !== publication.version)) return reject('lineage_unverified');
      if (!predecessor && (publication.sequence !== 1 || publication.history.length !== 1)) return reject('lineage_unverified');
      predecessor = publication;
    }
    if (publications.length > 1) diagnostic.reasonCodes.add('multiple_candidates');
    return { status: 'publication-candidate', conversationId: conversation.uuid, parentMessageId,
      humanMessageId: confirmed.humanMessageId, assistantMessageId: confirmed.assistantMessageId,
      complete: assistant.truncated !== true && !['max_tokens', 'model_context_window_exceeded'].includes(assistant.stop_reason),
      toolNames: [...new Set([...uses.values()].map(use => use.block.name))], publications };
  } catch {
    return reject('unknown_result_shape');
  }
}

export function inspectMutationTurn(conversation, options) {
  const diagnostic = { reasonCodes: new Set(), unknownToolPresent: false };
  const result = mutationTurnResult(conversation, options, diagnostic);
  return { result, diagnostic: { reasonCodes: [...diagnostic.reasonCodes].sort(), unknownToolPresent: diagnostic.unknownToolPresent } };
}

export function mutationTurn(conversation, options) {
  return inspectMutationTurn(conversation, options).result;
}

export function validPublicationDiagnostic(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'reasonCodes') && Object.hasOwn(value, 'unknownToolPresent')
    && typeof value.unknownToolPresent === 'boolean' && Array.isArray(value.reasonCodes)
    && value.reasonCodes.length <= PUBLICATION_REASON_CODES.length
    && value.reasonCodes.every(code => PUBLICATION_REASON_CODES.includes(code))
    && JSON.stringify(value.reasonCodes) === JSON.stringify([...new Set(value.reasonCodes)].sort());
}

export function publicationManifest(bytes, publication) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_METADATA) return failure();
    const value = parseStrictJson(bytes, { rejectPrototypeKeys: true });
    if (!value || value.ver !== publication.version || value.seq !== publication.sequence || !Array.isArray(value.history)
      || JSON.stringify(value.history) !== JSON.stringify(publication.history) || value.fileCount !== publication.fileCount
      || !Array.isArray(value.files) || value.files.length !== value.fileCount || value.files.length < 1 || value.files.length > 32
      || typeof value.viewer?.can_edit !== 'boolean') return failure();
    let size = 0;
    const files = [];
    for (const file of value.files) {
      if (!file || !pathSafe(file.path) || typeof file.contentType !== 'string'
        || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[^\x00-\x1f]{1,100})?$/.test(file.contentType)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE || !HASH.test(file.sha256 ?? '')) return failure();
      size += file.size;
      files.push({ path: file.path, contentType: file.contentType, size: file.size, sha256: file.sha256 });
    }
    if (size > MAX_FILE || new Set(files.map(file => file.path.normalize('NFC').toLowerCase())).size !== files.length) return failure();
    const sourceClaimsMatchedCount = files.filter(file => publication.sourceClaims.some(claim =>
      claim.path === file.path && claim.size === file.size && claim.sha256 === file.sha256)).length;
    return { status: 'manifest-candidate', frameId: publication.frameId, shortId: publication.shortId,
      version: value.ver, sequence: value.seq, history: [...value.history], files, canEdit: value.viewer.can_edit,
      sourceClaimsMatch: null, sourceClaimsMatchedCount,
      manifestSha256: hash(JSON.stringify(files.slice().sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) };
  } catch {
    return failure();
  }
}
