// Byte-preserving JSON member splicing.
//
// Host configs are user-owned files: the installer must add exactly one member
// and later remove exactly that member, leaving every other byte untouched.
// Re-serializing the whole document would reformat unrelated settings, so we
// locate the target member in the original text and splice characters.
//
// Every mutation re-parses the result and deep-compares it with the intended
// object; a mismatch aborts with no write. Correctness over cleverness: the
// scanner only needs object member spans, and arrays/strings/literals are
// skipped by span.
import { InstallError } from './errors.mjs';

const WS = new Set([' ', '\t', '\n', '\r']);
const isWs = (ch) => WS.has(ch);

function fail(message) {
  throw new InstallError('CONFIG_INVALID', message);
}

function skipWs(text, i) {
  let j = i;
  while (j < text.length && isWs(text[j])) j++;
  return j;
}

function expect(text, i, ch) {
  if (text[i] !== ch) fail('Malformed JSON');
  return i + 1;
}

function parseString(text, i) {
  if (text[i] !== '"') fail('Malformed JSON string');
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '"') return j + 1;
    j++;
  }
  fail('Unterminated JSON string');
}

function parseScalar(text, i) {
  let j = i;
  while (j < text.length && !isWs(text[j]) && !',}]'.includes(text[j])) j++;
  if (j === i) fail('Malformed JSON value');
  return j;
}

// Returns { node, next }; node spans [start, end) and carries object members.
function parseValue(text, i) {
  const start = skipWs(text, i);
  const ch = text[start];
  if (ch === '{') {
    const members = [];
    let j = expect(text, start, '{');
    j = skipWs(text, j);
    if (text[j] === '}') return { node: { type: 'object', start, end: j + 1, members }, next: j + 1 };
    for (;;) {
      j = skipWs(text, j);
      const nameStart = j;
      const nameEnd = parseString(text, j);
      const name = JSON.parse(text.slice(nameStart, nameEnd));
      j = skipWs(text, nameEnd);
      j = expect(text, j, ':');
      j = skipWs(text, j);
      const valueStart = j;
      const { node: value, next } = parseValue(text, j);
      j = skipWs(text, next);
      const hasComma = text[j] === ',';
      members.push({ name, nameStart, nameEnd, valueStart, valueEnd: value.end, hasComma, commaIndex: hasComma ? j : -1, value });
      if (hasComma) {
        j = skipWs(text, j + 1);
        if (text[j] === '}') {
          // trailing comma is invalid JSON; parseValue is only reached after JSON.parse validated
          fail('Malformed JSON object');
        }
        continue;
      }
      if (text[j] !== '}') fail('Malformed JSON object');
      return { node: { type: 'object', start, end: j + 1, members }, next: j + 1 };
    }
  }
  if (ch === '[') {
    let j = start + 1;
    for (;;) {
      j = skipWs(text, j);
      if (text[j] === ']') return { node: { type: 'array', start, end: j + 1 }, next: j + 1 };
      const { next } = parseValue(text, j);
      j = skipWs(text, next);
      if (text[j] === ',') {
        j++;
        continue;
      }
      if (text[j] === ']') return { node: { type: 'array', start, end: j + 1 }, next: j + 1 };
      fail('Malformed JSON array');
    }
  }
  if (ch === '"') {
    const end = parseString(text, start);
    return { node: { type: 'string', start, end }, next: end };
  }
  const end = parseScalar(text, start);
  return { node: { type: 'scalar', start, end }, next: end };
}

export function parseDocument(text) {
  let i = skipWs(text, 0);
  if (i >= text.length) fail('Empty JSON document');
  const { node, next } = parseValue(text, i);
  i = skipWs(text, next);
  if (i < text.length) fail('Trailing content after JSON document');
  if (node.type !== 'object') fail('JSON document must be an object');
  return node;
}

// Walk a member path from the document root. Returns the located node chain or
// null when any segment is missing.
function walk(text, path) {
  let node = parseDocument(text);
  const chain = [{ node, member: null }];
  for (const segment of path) {
    if (node.type !== 'object') return null;
    const member = node.members.find((m) => m.name === segment);
    if (!member) return null;
    node = member.value;
    chain.push({ node, member });
  }
  return { node, chain };
}

export function hasMember(text, path) {
  if (path.length === 0) return true;
  return walk(text, path) !== null;
}

export function getMember(text, path) {
  const found = path.length === 0 ? { node: parseDocument(text) } : walk(text, path);
  if (!found) return undefined;
  return JSON.parse(text.slice(found.node.start, found.node.end));
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sameJson = (a, b) => canonical(a) === canonical(b);

// The intended document after the mutation, built independently of the splicer.
function expectedAfterInsert(text, path, name, value) {
  const doc = JSON.parse(text);
  let cursor = doc;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) fail('Missing JSON container');
    cursor = cursor[segment];
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) fail('Missing JSON container');
  cursor[name] = value;
  return doc;
}

function expectedAfterRemove(text, path, name) {
  const doc = JSON.parse(text);
  let cursor = doc;
  for (const segment of path) cursor = cursor[segment];
  delete cursor[name];
  return doc;
}

function verifyMutation(original, result, expected, what) {
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new InstallError('CONFIG_INVALID', `Splice produced invalid JSON while ${what}`);
  }
  if (!sameJson(parsed, expected)) {
    throw new InstallError('CONFIG_INVALID', `Splice verification failed while ${what}`);
  }
  return result;
}

// Indentation of the line containing `index` (whitespace prefix only).
const leadingWs = (text, index) => {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, index))[0];
};

const indentLines = (text, indent) => text.split('\n').join(`\n${indent}`);

// Insert `name: value` as the first member of the object at `path`.
// `path` may be empty (document root). The container must already exist.
export function insertMember(text, path, name, valueText) {
  const value = JSON.parse(valueText);
  const located = path.length === 0 ? { node: parseDocument(text) } : walk(text, path);
  if (!located) throw new InstallError('CONFIG_INVALID', 'JSON container is missing');
  const object = located.node;
  if (object.type !== 'object') throw new InstallError('CONFIG_INVALID', 'JSON container is not an object');
  const quoted = JSON.stringify(name);

  if (object.members.length === 0) {
    const inner = text.slice(object.start + 1, object.end - 1);
    const baseIndent = leadingWs(text, object.start);
    const indent = `${baseIndent}  `;
    const body = inner.trim() === ''
      ? `\n${indent}${quoted}: ${indentLines(valueText, indent)}\n${baseIndent}`
      : `${quoted}: ${valueText}`;
    const result = text.slice(0, object.start + 1) + body + text.slice(object.end - 1);
    return verifyMutation(text, result, expectedAfterInsert(text, path, name, value), 'inserting a member');
  }

  const first = object.members[0];
  const multiLine = text.slice(object.start, first.nameStart).includes('\n');
  const indent = multiLine ? leadingWs(text, first.nameStart) : '';
  const valueIndented = multiLine ? indentLines(valueText, indent) : valueText;
  const insertText = multiLine
    ? `${quoted}: ${valueIndented},\n${indent}`
    : `${quoted}: ${valueText}, `;
  const result = text.slice(0, first.nameStart) + insertText + text.slice(first.nameStart);
  return verifyMutation(text, result, expectedAfterInsert(text, path, name, value), 'inserting a member');
}

// Remove exactly the `name` member from the object at `path`, keeping every
// other byte (whitespace included) as it was.
export function removeMember(text, path, name) {
  const located = path.length === 0 ? { node: parseDocument(text) } : walk(text, path);
  if (!located) throw new InstallError('CONFIG_INVALID', 'JSON container is missing');
  const object = located.node;
  if (object.type !== 'object') throw new InstallError('CONFIG_INVALID', 'JSON container is not an object');
  const thing = object.members.find((m) => m.name === name);
  if (!thing) throw new InstallError('CONFIG_INVALID', 'JSON member is missing');

  let start;
  let end;
  if (object.members.length === 1) {
    // last member: empty the object but keep any inner whitespace shape
    const result = `${text.slice(0, object.start + 1)}${text.slice(object.end - 1)}`;
    return verifyMutation(text, result, expectedAfterRemove(text, path, name), 'removing a member');
  }
  if (thing.hasComma) {
    let s = thing.nameStart;
    while (s > object.start + 1 && isWs(text[s - 1])) s--;
    start = s;
    let e = thing.commaIndex + 1;
    while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    end = e;
  } else {
    // last member without a trailing comma: consume the previous comma instead
    const index = object.members.indexOf(thing);
    start = object.members[index - 1].commaIndex;
    let e = thing.valueEnd;
    while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    end = e;
  }
  if (start < 0) fail('Malformed JSON object');
  const result = text.slice(0, start) + text.slice(end);
  return verifyMutation(text, result, expectedAfterRemove(text, path, name), 'removing a member');
}

// Pretty JSON text for the innermost container object that holds `name`.
export function buildMemberText(path, name, valueText) {
  const value = JSON.parse(valueText);
  let fragment = { [name]: value };
  for (let i = path.length - 1; i >= 0; i--) fragment = { [path[i]]: fragment };
  return JSON.stringify(fragment, null, 2);
}

// Build a minimal document that nests `name: value` under `path`.
export function buildDocument(path, name, valueText) {
  const value = JSON.parse(valueText);
  let fragment = { [name]: value };
  for (let i = path.length - 1; i >= 0; i--) fragment = { [path[i]]: fragment };
  return `${JSON.stringify(fragment, null, 2)}\n`;
}

export const isEmptyObject = (value) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === 0;

export const spliceInternals = { parseValue, walk, sameJson };
