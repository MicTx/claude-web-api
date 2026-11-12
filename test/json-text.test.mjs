import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertMember, removeMember, buildDocument, buildMemberText, getMember, hasMember,
  canonical, isEmptyObject, parseDocument,
} from '../src/install/json-text.mjs';

const ENTRY = '{"command":"/opt/node","args":["/repo/src/mcp-server.mjs"]}';

test('json-text: insert into a pretty multi-line document keeps every other byte', () => {
  const before = '{\n  "numStartups": 5,\n  "mcpServers": {\n    "other": {\n      "command": "/bin/other"\n    }\n  },\n  "projects": {"/x": {}}\n}\n';
  const after = insertMember(before, ['mcpServers'], 'claude_web', ENTRY);
  assert.equal(getMember(after, ['mcpServers', 'claude_web'])?.command, '/opt/node');
  // removing our member restores the original byte for byte
  assert.equal(removeMember(after, ['mcpServers'], 'claude_web'), before);
  // nothing else moved
  assert.ok(after.includes('"numStartups": 5'));
  assert.ok(after.includes('"projects": {"/x": {}}'));
});

test('json-text: insert into a compact single-line document stays valid and reversible', () => {
  const before = '{"mcpServers":{"other":{"command":"/bin/other"}},"imports":["cursor"]}\n';
  const after = insertMember(before, ['mcpServers'], 'claude_web', ENTRY);
  assert.deepEqual(Object.keys(JSON.parse(after).mcpServers), ['claude_web', 'other']);
  assert.deepEqual(JSON.parse(after).imports, ['cursor']);
  assert.equal(removeMember(after, ['mcpServers'], 'claude_web'), before);
});

test('json-text: insert into an empty container of either shape', () => {
  const compact = '{"mcpServers":{}}';
  const inserted = insertMember(compact, ['mcpServers'], 'claude_web', ENTRY);
  assert.equal(JSON.parse(inserted).mcpServers.claude_web.args[0], '/repo/src/mcp-server.mjs');
  assert.equal(removeMember(inserted, ['mcpServers'], 'claude_web'), '{"mcpServers":{}}');

  const pretty = '{\n  "mcpServers": {}\n}\n';
  const prettyInserted = insertMember(pretty, ['mcpServers'], 'claude_web', ENTRY);
  assert.equal(JSON.parse(prettyInserted).mcpServers.claude_web.command, '/opt/node');
  assert.equal(removeMember(prettyInserted, ['mcpServers'], 'claude_web'), '{\n  "mcpServers": {}\n}\n');
});

test('json-text: insert at the document root (creating a missing container)', () => {
  const before = '{"security":{"auth":{"selectedType":"gemini-api-key"}}}';
  // what a missing container looks like: the container value, built from its members
  const value = buildMemberText([], 'claude_web', ENTRY);
  const after = insertMember(before, [], 'mcpServers', value);
  const parsed = JSON.parse(after);
  assert.equal(parsed.mcpServers.claude_web.command, '/opt/node');
  assert.equal(parsed.security.auth.selectedType, 'gemini-api-key');
  assert.equal(removeMember(after, [], 'mcpServers'), before);
});

test('json-text: buildDocument produces a minimal valid document', () => {
  const doc = buildDocument(['servers'], 'claude_web', ENTRY);
  const parsed = JSON.parse(doc);
  assert.equal(parsed.servers.claude_web.args.length, 1);
  assert.ok(doc.endsWith('\n'));
});

test('json-text: removal of the only member empties the container', () => {
  const before = '{\n  "mcpServers": {\n    "claude_web": {}\n  }\n}\n';
  const after = removeMember(before, ['mcpServers'], 'claude_web');
  assert.deepEqual(JSON.parse(after), { mcpServers: {} });
  assert.equal(after, '{\n  "mcpServers": {}\n}\n');
});

test('json-text: removal of the last member without a trailing comma drops the preceding comma', () => {
  const before = '{\n  "mcpServers": {\n    "other": {"command": "/bin/other"},\n    "claude_web": {}\n  }\n}\n';
  const after = removeMember(before, ['mcpServers'], 'claude_web');
  assert.deepEqual(Object.keys(JSON.parse(after).mcpServers), ['other']);
  assert.equal(after, '{\n  "mcpServers": {\n    "other": {"command": "/bin/other"}\n  }\n}\n');
});

test('json-text: a same-named member in a deeper object is never touched', () => {
  const before = '{"mcpServers":{"other":{"claude_web":"nested"}},"claude_web":"top"}';
  const after = insertMember(before, ['mcpServers'], 'claude_web', ENTRY);
  const parsed = JSON.parse(after);
  assert.equal(parsed.mcpServers.other.claude_web, 'nested');
  assert.equal(parsed.claude_web, 'top');
  assert.equal(parsed.mcpServers.claude_web.command, '/opt/node');
  assert.equal(removeMember(after, ['mcpServers'], 'claude_web'), before);
});

test('json-text: braces, escapes and nested arrays inside strings are not structural', () => {
  const before = '{"note":"a {\\"b\\": [1,2]} c","mcpServers":{"x":["}]","\\"q\\""]}}';
  const after = insertMember(before, ['mcpServers'], 'claude_web', ENTRY);
  const parsed = JSON.parse(after);
  assert.equal(parsed.note, 'a {"b": [1,2]} c');
  assert.deepEqual(parsed.mcpServers.x, ['}]', '"q"']);
  assert.equal(removeMember(after, ['mcpServers'], 'claude_web'), before);
});

test('json-text: invalid or non-object documents are refused', () => {
  assert.throws(() => parseDocument('{"a":}'), /Malformed JSON/);
  assert.throws(() => parseDocument('[]'), /must be an object/);
  assert.throws(() => parseDocument(''), /Empty JSON document/);
  assert.throws(() => parseDocument('{"a":1} trailing'), /Trailing content/);
  assert.throws(() => insertMember('{"mcpServers":{}}', ['mcpServers', 'x'], 'claude_web', ENTRY), /container is missing/);
  assert.throws(() => insertMember('{"mcpServers":[]}', ['mcpServers'], 'claude_web', ENTRY), /not an object/);
  assert.throws(() => removeMember('{"mcpServers":{}}', ['mcpServers'], 'claude_web'), /member is missing/);
});

test('json-text: canonical form ignores key order and isEmptyObject is strict', () => {
  assert.equal(canonical({ a: 1, b: [2, { c: 3, d: 4 }] }), canonical({ b: [2, { d: 4, c: 3 }], a: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
  assert.equal(isEmptyObject({}), true);
  assert.equal(isEmptyObject({ a: 1 }), false);
  assert.equal(isEmptyObject([]), false);
  assert.equal(isEmptyObject(null), false);
  assert.equal(hasMember('{"mcpServers":{}}', ['mcpServers']), true);
  assert.equal(hasMember('{"mcpServers":{}}', ['servers']), false);
});
