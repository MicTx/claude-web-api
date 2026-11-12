import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mutationTurn, publicationManifest } from '../scripts/design-probe-turns.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/design-turns.json', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function publication(version = fixture.version, sequence = 1, history = [fixture.version]) {
  return { slug: fixture.frameId, url: `https://claude.ai/artifact/${fixture.shortId}`, version,
    seq: sequence, history, own_file_count: 1, title: 'Synthetic Design', assetToken: 'TOKEN_SENTINEL',
    author: { email: 'PII_SENTINEL@example.invalid' } };
}

function blocks(value = publication(), source = fixture.source) {
  return [
    { type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: '/synthetic/index.html', content: source } },
    { type: 'tool_result', name: 'Write', tool_use_id: 'write_1', is_error: false, content: [{ type: 'text', text: 'written' }] },
    { type: 'tool_use', id: 'publish_1', name: 'mcp__claude-artifacts__publish_files',
      input: { files: [{ path: '/synthetic/index.html', as: 'index.html' }], title: 'Synthetic Design', icon: 'layout' } },
    { type: 'tool_result', name: 'mcp__claude-artifacts__publish_files', tool_use_id: 'publish_1', is_error: false,
      content: [{ type: 'text', text: JSON.stringify(value) }] },
    { type: 'text', text: 'Synthetic result with no authority outside the paired tool result.' },
  ];
}

function conversation() {
  return { uuid: fixture.conversationId, current_leaf_message_uuid: fixture.assistantMessageId,
    chat_messages: [
      { uuid: fixture.humanMessageId, parent_message_uuid: fixture.parentMessageId, sender: 'human',
        content: [{ type: 'text', text: fixture.prompt }], attachments: [], files: [] },
      { uuid: fixture.assistantMessageId, parent_message_uuid: fixture.humanMessageId, sender: 'assistant',
        content: blocks(), stop_reason: 'end_turn', truncated: false },
    ] };
}

function extract(value = conversation(), extra = {}) {
  return mutationTurn(value, { parentMessageId: fixture.parentMessageId, prompt: fixture.prompt, ...extra });
}

function manifest(value = publication(), extra = {}) {
  return Buffer.from(JSON.stringify({ ver: value.version, seq: value.seq, history: value.history, fileCount: 1,
    files: [{ path: 'index.html', contentType: 'text/html', size: Buffer.byteLength(fixture.source), sha256: hash(fixture.source) }],
    viewer: { can_edit: true, token: 'TOKEN_SENTINEL' }, author: { email: 'PII_SENTINEL@example.invalid' }, ...extra }));
}

test('design turns: synthetic tool pair yields only an unpublished type candidate and source hashes', () => {
  const result = extract();
  assert.equal(fixture.synthetic, true);
  assert.equal(result.status, 'publication-candidate');
  assert.equal(result.complete, true);
  assert.equal(result.publications.length, 1);
  const source = result.publications[0].sourceClaims[0];
  assert.equal(source.sha256, hash(fixture.source));
  assert.equal(source.size, Buffer.byteLength(fixture.source));
  assert.equal(source.hasCJK, true);
  assert.equal(source.hasEmoji, true);
  assert.equal(source.hasCombining, true);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SENTINEL|PII_SENTINEL|\/synthetic|<html|Design.*verified/);
});

test('design turns: manifest must independently match the published identity and UTF-8 claim', () => {
  const candidate = extract().publications[0];
  const result = publicationManifest(manifest(), candidate);
  assert.equal(result.status, 'manifest-candidate');
  assert.equal(result.sourceClaimsMatch, null);
  assert.equal(result.sourceClaimsMatchedCount, 1);
  assert.equal(result.canEdit, true);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SENTINEL|PII_SENTINEL|<html/);
  const changed = publicationManifest(manifest(publication(), { files: [{ path: 'index.html', contentType: 'text/html',
    size: Buffer.byteLength(fixture.source), sha256: '0'.repeat(64) }] }), candidate);
  assert.equal(changed.sourceClaimsMatch, null);
  assert.equal(changed.sourceClaimsMatchedCount, 0);
});

test('design turns: model links, orphan results, duplicate uses and wrong parents are not identities', () => {
  for (const mutate of [
    value => { value.chat_messages[1].content = [{ type: 'text', text: `https://claude.ai/artifact/${fixture.shortId}` }]; },
    value => { value.chat_messages[1].content.splice(2, 1); },
    value => { value.chat_messages[1].content.unshift(structuredClone(value.chat_messages[1].content[0])); },
    value => { value.chat_messages[0].content[0].text = 'Different prompt'; },
    value => { value.chat_messages[0].files = [{}]; },
    value => { value.chat_messages[1].parent_message_uuid = fixture.parentMessageId; },
    value => { value.chat_messages[1].content[3].is_error = true; },
  ]) {
    const value = conversation();
    mutate(value);
    assert.deepEqual(extract(value), { status: 'unverified' });
  }
});

test('design turns: only a fully paired contiguous same-target revision is a candidate', () => {
  const first = extract().publications[0];
  const value = conversation();
  value.chat_messages.push({ uuid: fixture.nextHumanMessageId, parent_message_uuid: fixture.assistantMessageId, sender: 'human',
    content: [{ type: 'text', text: fixture.revision }], attachments: [], files: [] });
  value.chat_messages.push({ uuid: fixture.nextAssistantMessageId, parent_message_uuid: fixture.nextHumanMessageId, sender: 'assistant',
    content: blocks(publication(fixture.nextVersion, 2, [fixture.version, fixture.nextVersion])), stop_reason: 'end_turn', truncated: false });
  value.current_leaf_message_uuid = fixture.nextAssistantMessageId;
  const expected = { parentMessageId: fixture.assistantMessageId, prompt: fixture.revision, previous: first };
  assert.equal(extract(value, expected).status, 'publication-candidate');
  for (const mutate of [
    data => { data.slug = '99999999-9999-4999-8999-999999999999'; },
    data => { data.history = [fixture.nextVersion]; },
    data => { data.seq = 4; },
    data => { data.url = 'https://example.invalid/artifact/SyntheticOther01'; },
  ]) {
    const changed = structuredClone(value);
    const data = publication(fixture.nextVersion, 2, [fixture.version, fixture.nextVersion]);
    mutate(data);
    changed.chat_messages.at(-1).content = blocks(data);
    assert.deepEqual(extract(changed, expected), { status: 'unverified' });
  }
});

test('design turns: truncated publication and source provenance remain separate', () => {
  const value = conversation();
  value.chat_messages[1].stop_reason = 'max_tokens';
  value.chat_messages[1].truncated = true;
  const partial = extract(value);
  assert.equal(partial.status, 'publication-candidate');
  assert.equal(partial.complete, false);
  value.chat_messages[1].content.splice(2, 0, { type: 'tool_use', id: 'edit_1', name: 'Edit', input: {} });
  assert.deepEqual(extract(value).publications[0].sourceClaims, []);
});

test('design turns: a later paired write supplies the source candidate for that path', () => {
  const value = conversation();
  value.chat_messages[1].content.splice(2, 0,
    { type: 'tool_use', id: 'write_2', name: 'Write', input: { file_path: '/synthetic/index.html', content: 'different' } },
    { type: 'tool_result', name: 'Write', tool_use_id: 'write_2', is_error: false, content: [{ type: 'text', text: 'ok' }] });
  const result = extract(value);
  assert.equal(result.publications[0].sourceClaims.length, 1);
  assert.equal(result.publications[0].sourceClaims[0].sha256, hash('different'));
});

test('design turns: an unpaired or non-adjacent write cannot provide source provenance', () => {
  for (const change of [
    value => { value.chat_messages[1].content[1].tool_use_id = 'some_other_write'; },
    value => { value.chat_messages[1].content.splice(1, 0, { type: 'tool_use', id: 'intervening', name: 'Write', input: { file_path: '/other', content: 'x' } }); },
  ]) {
    const value = conversation();
    change(value);
    assert.deepEqual(extract(value).publications[0].sourceClaims, []);
  }
});

test('design turns: unsafe paths and duplicate JSON keys fail closed without echoing data', () => {
  const candidate = extract().publications[0];
  for (const path of ['../index.html', 'a//b', '/index.html', 'NUL.html', '__proto__', 'a\\b', 'a\u0000b', 'a\u202eb']) {
    const bytes = manifest(publication(), { files: [{ path, contentType: 'text/html', size: 1, sha256: 'c'.repeat(64) }] });
    assert.deepEqual(publicationManifest(bytes, candidate), { status: 'unverified' });
  }
  const duplicate = manifest().toString().replace('"ver":', '"ver":"TOKEN_SENTINEL","ver":');
  assert.deepEqual(publicationManifest(Buffer.from(duplicate), candidate), { status: 'unverified' });
});
