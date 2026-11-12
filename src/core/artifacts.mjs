import { BridgeError } from './errors.mjs';
import { digest, safeFileName } from '../attachments.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => { throw new BridgeError('API_CONTRACT', 'Malformed public artifact metadata'); };

export function messageText(message) {
  return (message.content ?? []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
}

const PUBLISH = 'mcp__claude-artifacts__publish_files';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const VERIFIED_FRAME_TEXT = /^[\t\n\x20-\x7e]+$/;
const REMOTE_HOME_PATH = /^\/home\/[^/]+\//;
const toolBlock = block => block?.type === 'tool_use' || block?.type === 'tool_result';

// A single-file first publication reads the page the immediately preceding Write left on disk.
// Any other tool activity in between could have changed that file, so provenance is refused.
// Byte identity with the published file is only observed for LF-only printable ASCII; encoding,
// BOM and line-ending handling beyond that are unverified, so such pages stay refused.
function frameOriginal(content, resultIndex) {
  const result = content[resultIndex];
  if (typeof result.tool_use_id !== 'string' || !result.tool_use_id) return null;
  const uses = content.flatMap((b, i) => (b?.type === 'tool_use' && b.id === result.tool_use_id ? [i] : []));
  if (uses.length !== 1) return null;
  const useIndex = uses[0];
  if (useIndex > resultIndex || content[useIndex].name !== PUBLISH) return null;
  if (content.slice(useIndex + 1, resultIndex).some(toolBlock)) return null;
  const input = content[useIndex].input;
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['files', 'title', 'icon'].includes(k))) return null;
  const files = input.files;
  if (!Array.isArray(files) || files.length !== 1 || !files[0] || typeof files[0] !== 'object'
    || Object.keys(files[0]).some(k => !['path', 'as'].includes(k)) || files[0].as !== 'index.html'
    || typeof files[0].path !== 'string' || !files[0].path) return null;
  let index = useIndex - 1;
  while (index >= 0 && !toolBlock(content[index])) index--;
  const writeResult = content[index];
  if (writeResult?.type !== 'tool_result' || writeResult.name !== 'Write' || writeResult.is_error !== false) return null;
  const writeIndex = index - 1;
  const write = content[writeIndex];
  if (write?.type !== 'tool_use' || write.name !== 'Write' || write.id !== writeResult.tool_use_id
    || write.input?.file_path !== files[0].path || typeof write.input.content !== 'string') return null;
  if (!VERIFIED_FRAME_TEXT.test(write.input.content)) return null;
  const bytes = Buffer.from(write.input.content, 'utf8');
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES || !/^\s*(<!doctype\s+html|<html\b)/i.test(write.input.content)) return null;
  return { name: files[0].as, bytes };
}

// `sources` is internal: download passes a Map to receive provable Frame originals by artifact ID.
export function publicArtifacts(conversationId, messages, sources = null) {
  const artifacts = new Map();
  const originals = new Map();
  const add = (message, identity, fields) => {
    const id = digest(JSON.stringify([conversationId, message.uuid, ...identity]));
    const artifact = { id, messageId: message.uuid, ...fields };
    if (artifacts.has(id) && JSON.stringify(artifacts.get(id)) !== JSON.stringify(artifact)) invalid();
    artifacts.set(id, artifact);
    if (artifacts.size > 256) throw new BridgeError('PAYLOAD_TOO_LARGE', 'Too many public artifacts');
    return id;
  };
  for (const message of messages) {
    if (message.sender !== 'assistant') continue;
    const content = message.content ?? [];
    for (const [blockIndex, block] of content.entries()) {
      if (block?.type !== 'tool_result' || block.is_error !== false) continue;
      if (block.name === 'SendUserFile') {
        if (!Array.isArray(block.file_deliveries) || block.file_deliveries.length > 64) invalid();
        for (const file of block.file_deliveries) {
          if (!UUID.test(file?.file_uuid ?? '') || typeof file.path !== 'string' || file.path.length > 4096
            || !REMOTE_HOME_PATH.test(file.path) || /[\\\x00-\x1f\x7f]/u.test(file.path)) invalid();
          const parts = file.path.slice(1).split('/');
          if (parts.some(p => !p || p === '.' || p === '..')) invalid();
          let name;
          try { name = safeFileName(parts.at(-1)); } catch { invalid(); }
          add(message, ['file', file.file_uuid.toLowerCase()], {
            kind: 'file', fileId: file.file_uuid, name, version: null, mimeType: null, size: null, downloadable: true,
          });
        }
      } else if (block.name === PUBLISH) {
        if (!Array.isArray(block.content)) invalid();
        const text = block.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
        if (Buffer.byteLength(text) > 256 * 1024) invalid();
        let data, url;
        try { data = JSON.parse(text); url = new URL(data.url); } catch { invalid(); }
        if (!UUID.test(data.slug ?? '') || typeof data.version !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(data.version)
          || !Number.isSafeInteger(data.seq) || data.seq < 1 || !Number.isSafeInteger(data.own_file_count) || data.own_file_count < 1
          || typeof data.title !== 'string' || data.title.length > 512
          || !Array.isArray(data.history) || data.history.length > 256 || data.history.some(v => typeof v !== 'string' || v.length > 128)
          || !['owner', 'public', 'private', 'unlisted'].includes(data.read)
          || url.origin !== 'https://claude.ai' || !/^\/artifact\/[A-Za-z0-9_-]{10,80}$/.test(url.pathname)
          || url.username || url.password || url.search || url.hash) invalid();
        const original = data.seq === 1 && data.own_file_count === 1 && data.history.length === 1 && data.history[0] === data.version
          ? frameOriginal(content, blockIndex) : null;
        const id = add(message, ['frame', data.slug.toLowerCase(), data.version], {
          kind: 'frame-artifact', artifactId: data.slug, version: data.version, name: data.title,
          fileCount: data.own_file_count, mimeType: null, size: null, downloadable: original !== null,
          ...(original === null ? { unsupportedReason: 'FRAME_EXPORT_UNVERIFIED' } : {}),
        });
        if (original) {
          if (originals.has(id) && !originals.get(id).bytes.equals(original.bytes)) invalid();
          originals.set(id, original);
        }
      }
    }
  }
  if (sources) for (const [id, original] of originals) sources.set(id, original);
  return [...artifacts.values()];
}

export function completedAssistant(conversationId, message) {
  return message?.sender === 'assistant' && message.stop_reason === 'end_turn' && message.truncated !== true
    && (messageText(message).trim() !== '' || publicArtifacts(conversationId, [message]).length > 0);
}

export function assistantCompletion(message) {
  if (message?.sender !== 'assistant' || typeof message.stop_reason !== 'string') return null;
  if (message.stop_reason === 'user_canceled') return false;
  if (!['end_turn', 'stop_sequence', 'refusal', 'max_tokens', 'model_context_window_exceeded'].includes(message.stop_reason)) return null;
  return message.truncated !== true && !['max_tokens', 'model_context_window_exceeded'].includes(message.stop_reason);
}

// A terminated partial answer is known, even though its content is incomplete.
export function settledAssistant(conversationId, message) {
  // A user-canceled assistant is terminal: the turn is on the server and no more
  // output will arrive, even when the answer has no text or artifacts.
  if (message?.sender === 'assistant' && message.stop_reason === 'user_canceled') return true;
  return assistantCompletion(message) !== null
    && (messageText(message).trim() !== '' || publicArtifacts(conversationId, [message]).length > 0);
}
