import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectMutationTurn, mutationTurn, publicationManifest, PUBLICATION_REASON_CODES,
  validPublicationDiagnostic } from '../scripts/design-probe-turns.mjs';
import { MUTATION_PROMPT } from '../scripts/design-probe-mutations.mjs';
import { projectReconciliation, publicationDiagnosticForEvidence } from '../scripts/design-probe-reconciliation.mjs';
import { cleanupTmpDirs, makeTmpDir } from './helpers.mjs';

after(cleanupTmpDirs);
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/design-turns.json', import.meta.url)));
const digest = value => createHash('sha256').update(value).digest('hex');
const publishTool = 'mcp__claude-artifacts__publish_files';
const expected = { parentMessageId: fixture.parentMessageId, prompt: MUTATION_PROMPT };
const binding = { organizationId: fixture.organizationId, conversationId: fixture.conversationId,
  parentMessageId: fixture.parentMessageId, promptSha256: digest(MUTATION_PROMPT), stateSha256: 'a'.repeat(64) };
const baselineRoot = await fs.realpath(await makeTmpDir('ccw-publication-baseline-'));
for (const path of ['src/core/claude-api.mjs', 'src/core/errors.mjs', 'scripts/design-probe-json.mjs']) {
  await fs.mkdir(dirname(join(baselineRoot, path)), { recursive: true, mode: 0o700 });
  await fs.copyFile(new URL(`../${path}`, import.meta.url), join(baselineRoot, path));
}
const frozen = await fs.readFile(new URL('./fixtures/design-turns-before-reasons.txt', import.meta.url));
assert.equal(digest(frozen), '51df2f392058039effa3bcef1dff4cfc48fd13d0c9e6da8e674e26f34206c352');
const baselinePath = join(baselineRoot, 'scripts/design-probe-turns.mjs');
await fs.writeFile(baselinePath, frozen, { mode: 0o600 });
const baseline = await import(pathToFileURL(baselinePath).href);

function publication(version = fixture.version, sequence = 1, history = [fixture.version]) {
  return { slug: fixture.frameId, url: `https://claude.ai/artifact/${fixture.shortId}`, version,
    seq: sequence, history, own_file_count: 1, assetToken: 'TOKEN_SENTINEL' };
}

function pair(id = 'publish_1', value = publication()) {
  return [
    { type: 'tool_use', id, name: publishTool, input: { files: [{ path: '/synthetic/index.html', as: 'index.html' }], text: 'INPUT_SENTINEL' } },
    { type: 'tool_result', name: publishTool, tool_use_id: id, is_error: false,
      content: [{ type: 'text', text: JSON.stringify(value) }] },
  ];
}

function conversation() {
  return { uuid: fixture.conversationId, current_leaf_message_uuid: fixture.assistantMessageId, chat_messages: [
    { uuid: fixture.humanMessageId, parent_message_uuid: fixture.parentMessageId, sender: 'human',
      content: [{ type: 'text', text: MUTATION_PROMPT }], attachments: [], files: [] },
    { uuid: fixture.assistantMessageId, parent_message_uuid: fixture.humanMessageId, sender: 'assistant',
      stop_reason: 'end_turn', truncated: false, content: [
        { type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: '/synthetic/index.html', content: fixture.source } },
        { type: 'tool_result', name: 'Write', tool_use_id: 'write_1', is_error: false, content: [{ type: 'text', text: 'ok' }] },
        ...pair(), { type: 'text', text: 'REPLY_SENTINEL' },
      ] },
  ] };
}

const cases = [
  { code: 'no_publish_tool', change: value => { value.chat_messages[1].content = [{ type: 'text', text: 'REPLY_SENTINEL' }]; } },
  { code: 'use_without_result', change: value => { value.chat_messages[1].content.splice(3, 1); } },
  { code: 'result_error', change: value => { value.chat_messages[1].content[3].is_error = true; } },
  { code: 'result_unparsable', change: value => { value.chat_messages[1].content[3].content[0].text = 'INVALID_JSON_SENTINEL'; } },
  { code: 'identity_fields_missing', change: value => { value.chat_messages[1].content[3].content[0].text = JSON.stringify({ version: 'VERSION_SENTINEL' }); } },
  { code: 'identity_invalid', change: value => { value.chat_messages[1].content[3].content[0].text = JSON.stringify({ ...publication(),
    version: 'VERSION_SENTINEL', history: ['VERSION_SENTINEL'], url: 'https://example.invalid/URL_SENTINEL' }); } },
  { code: 'unknown_result_shape', change: value => { value.chat_messages[1].content[3].content = [{ type: 'image', data: 'BODY_SENTINEL' }]; } },
  { code: 'duplicate_tool_identity', change: value => { value.chat_messages[1].content.unshift(structuredClone(value.chat_messages[1].content[0])); } },
  { code: 'use_result_identity_mismatch', change: value => { value.chat_messages[1].content[3].name = 'Read'; } },
  { code: 'publication_conflict', change: value => { value.chat_messages[1].content.push(...pair('publish_2')); } },
  { code: 'lineage_unverified', change: value => { value.chat_messages[1].content[3].content[0].text = JSON.stringify(
    publication(fixture.nextVersion, 2, [fixture.version, fixture.nextVersion])); } },
  { code: 'turn_unverified', change: value => { value.chat_messages[0].content[0].text = 'PROMPT_SENTINEL'; } },
  { code: 'oversized', change: value => { value.chat_messages[1].content[3].content[0].text = 'BODY_SENTINEL'.repeat(25000); } },
  { code: 'multiple_candidates', accepted: true, change: value => { value.chat_messages[1].content.push(
    ...pair('publish_2', publication(fixture.nextVersion, 2, [fixture.version, fixture.nextVersion]))); } },
];

test('publication diagnostics: every fixed code is observed through the production reconciliation projection', () => {
  assert.equal(fixture.synthetic, true);
  assert.deepEqual([...cases.map(item => item.code)].sort(), [...PUBLICATION_REASON_CODES].sort());
  for (const scenario of cases) {
    const value = conversation();
    scenario.change(value);
    const inspected = inspectMutationTurn(value, expected);
    assert.deepEqual(inspected.result, baseline.mutationTurn(value, expected));
    assert.equal(inspected.result.status, scenario.accepted ? 'publication-candidate' : 'unverified');
    assert.deepEqual(inspected.diagnostic.reasonCodes, [scenario.code]);
    assert.equal(validPublicationDiagnostic(inspected.diagnostic), true);
    const projected = projectReconciliation(value, binding);
    assert.deepEqual(projected.publicationDiagnostic, inspected.diagnostic);
    assert.doesNotMatch(JSON.stringify(projected.publicationDiagnostic), /SENTINEL|https:|bbbbbbbb|synthetic-version|设计/);
    assert.doesNotMatch(JSON.stringify(projected), /SENTINEL|https:|bbbbbbbb|synthetic-version|设计/);
  }
});

test('publication diagnostics: frozen parser and all existing fixture behaviors keep identical identities and decisions', () => {
  const inputs = [conversation()];
  for (const scenario of cases) {
    const value = conversation();
    scenario.change(value);
    inputs.push(value);
  }
  for (const change of [
    value => { value.chat_messages[1].stop_reason = 'max_tokens'; value.chat_messages[1].truncated = true; },
    value => { value.chat_messages[1].stop_reason = 'refusal'; },
    value => { value.chat_messages[1].stop_reason = 'tool_use'; },
    value => { value.chat_messages[1].content.splice(2, 0, { type: 'tool_use', id: 'edit_1', name: 'Edit', input: {} }); },
    value => { value.chat_messages[1].content.splice(2, 0,
      { type: 'tool_use', id: 'write_2', name: 'Write', input: { file_path: '/synthetic/index.html', content: 'different' } },
      { type: 'tool_result', name: 'Write', tool_use_id: 'write_2', is_error: false, content: [{ type: 'text', text: 'ok' }] }); },
    value => { value.chat_messages[1].content[1].tool_use_id = 'other_write'; },
    value => { value.chat_messages[1].content.splice(1, 0, { type: 'tool_use', id: 'intervening', name: 'Write', input: {} }); },
    value => { value.chat_messages[0].files = [{}]; },
    value => { value.chat_messages[1].parent_message_uuid = fixture.parentMessageId; },
    value => { value.chat_messages[1].content[3].content[0].text = '{"slug":"TOKEN_SENTINEL","slug":"OTHER_SENTINEL"}'; },
    value => { value.chat_messages[1].content[3].content[0].text = 'null'; },
    value => { value.chat_messages[1].content.splice(2, 0, { type: 'text', text: 'non-adjacent publication remains a candidate' }); },
  ]) {
    const value = conversation();
    change(value);
    inputs.push(value);
  }
  for (const value of inputs) assert.deepEqual(mutationTurn(value, expected), baseline.mutationTurn(value, expected));
  const first = mutationTurn(conversation(), expected).publications[0];
  const revised = conversation();
  revised.chat_messages.push({ uuid: fixture.nextHumanMessageId, parent_message_uuid: fixture.assistantMessageId,
    sender: 'human', content: [{ type: 'text', text: fixture.revision }], attachments: [], files: [] });
  revised.chat_messages.push({ uuid: fixture.nextAssistantMessageId, parent_message_uuid: fixture.nextHumanMessageId,
    sender: 'assistant', content: pair('revision_1', publication(fixture.nextVersion, 2, [fixture.version, fixture.nextVersion])),
    stop_reason: 'end_turn', truncated: false });
  revised.current_leaf_message_uuid = fixture.nextAssistantMessageId;
  const revisionOptions = { parentMessageId: fixture.assistantMessageId, prompt: fixture.revision, previous: first };
  assert.deepEqual(mutationTurn(revised, revisionOptions), baseline.mutationTurn(revised, revisionOptions));
  for (const path of ['index.html', '../index.html', 'a//b', '/index.html', 'NUL.html', '__proto__', 'a\\b', 'a\u0000b', 'a\u202eb']) {
    const bytes = Buffer.from(JSON.stringify({ ver: fixture.version, seq: 1, history: [fixture.version], fileCount: 1,
      files: [{ path, contentType: 'text/html', size: Buffer.byteLength(fixture.source), sha256: digest(fixture.source) }], viewer: { can_edit: true } }));
    assert.deepEqual(publicationManifest(bytes, first), baseline.publicationManifest(bytes, first));
  }
});

test('publication diagnostics: multiple reasons are sorted and unknown tools never establish publication identity', () => {
  const value = conversation();
  value.chat_messages[1].content = [pair('missing_1')[0], ...pair('error_1')];
  value.chat_messages[1].content.at(-1).is_error = true;
  const reason = inspectMutationTurn(value, expected).diagnostic;
  assert.deepEqual(reason.reasonCodes, ['result_error', 'use_without_result']);
  for (let iteration = 0; iteration < 5; iteration++) assert.deepEqual(inspectMutationTurn(value, expected).diagnostic, reason);
  value.chat_messages[1].content = [...value.chat_messages[1].content.slice(1), value.chat_messages[1].content[0]];
  assert.deepEqual(inspectMutationTurn(value, expected).diagnostic, reason);
  value.chat_messages[1].content = [{ type: 'tool_use', id: 'IDENTIFIER_SENTINEL', name: 'PRIVATE_TOOL_SENTINEL',
    input: { url: 'https://example.invalid/URL_SENTINEL', text: 'INPUT_SENTINEL' } }];
  const projected = projectReconciliation(value, binding);
  assert.deepEqual(projected.publicationDiagnostic, { reasonCodes: ['no_publish_tool'], unknownToolPresent: true });
  assert.equal(projected.publicationCandidates, null);
  assert.doesNotMatch(JSON.stringify(projected), /SENTINEL|https:/);
});

test('publication diagnostics: old evidence is read as unrecorded without rewriting its synthetic snapshot', async () => {
  const directory = await fs.realpath(await makeTmpDir('ccw-old-publication-evidence-'));
  const path = join(directory, 'reconciliation-final-result.json');
  const old = projectReconciliation(conversation(), binding);
  delete old.publicationDiagnostic;
  old.publicationCandidates = null;
  const bytes = Buffer.from(JSON.stringify(old) + '\n');
  await fs.writeFile(path, bytes, { mode: 0o600 });
  assert.deepEqual(publicationDiagnosticForEvidence(JSON.parse(await fs.readFile(path))), {
    reasonCodes: ['reason_unrecorded'], unknownToolPresent: null,
  });
  assert.deepEqual(await fs.readFile(path), bytes);
  for (const invalid of [
    { reasonCodes: ['TOKEN_SENTINEL'], unknownToolPresent: false },
    { reasonCodes: ['result_error', 'result_error'], unknownToolPresent: false },
    { reasonCodes: [], unknownToolPresent: false, url: 'URL_SENTINEL' },
  ]) {
    assert.equal(validPublicationDiagnostic(invalid), false);
    assert.throws(() => publicationDiagnosticForEvidence({ ...old, publicationDiagnostic: invalid }), error => {
      assert.equal(error.code, 'PROBE_FAILED');
      assert.doesNotMatch(error.message + JSON.stringify(error.details), /SENTINEL/);
      return true;
    });
  }
});
