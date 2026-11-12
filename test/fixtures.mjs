// Hand-written SSE fixtures mirroring the documented protocol; these are
// deliberately authored strings, not output of the production parser.
export const REPLY_UUID = '11111111-2222-4333-8444-555566667777';
export const REPLY_UUID_2 = 'aaaaaaaa-1111-4222-8333-444455556666';

export function sse(events) {
  return events.map((e) => `event: ${e[0]}\ndata: ${e[1]}\n`).join('\n') + '\n';
}

export const msgStart = (uuid = REPLY_UUID, model = 'claude-opus-5-5') => [
  'message_start',
  JSON.stringify({ type: 'message_start', message: { uuid, model } }),
];
export const blockStart = (index = 0, type = 'text', text = '') => [
  'content_block_start',
  JSON.stringify({ type: 'content_block_start', index, content_block: { type, text } }),
];
export const blockDelta = (index, deltaType, fields) => [
  'content_block_delta',
  JSON.stringify({ type: 'content_block_delta', index, delta: { type: deltaType, ...fields } }),
];
export const textDelta = (index, text) => blockDelta(index, 'text_delta', { text });
export const blockStop = (index = 0) => [
  'content_block_stop',
  JSON.stringify({ type: 'content_block_stop', index }),
];
export const msgDelta = (stopReason = 'end_turn') => [
  'message_delta',
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } }),
];
export const msgLimit = () => [
  'message_limit',
  JSON.stringify({
    type: 'message_limit',
    message_limit: {
      type: 'within_limit',
      windows: { '5h': { status: 'within_limit', resets_at: 1793788200, utilization: 0.18 } },
      resolved: { status: 'ok', limit: { kind: 'session', percent: 18 } },
    },
  }),
];
export const msgStop = () => ['message_stop', JSON.stringify({ type: 'message_stop' })];
export const ping = () => ['ping', JSON.stringify({ type: 'ping' })];

export const SSE_BASIC = sse([
  msgStart(),
  blockStart(0),
  textDelta(0, 'Hello'),
  textDelta(0, ' world'),
  blockStop(0),
  msgDelta('end_turn'),
  msgLimit(),
  msgStop(),
]);

export const SSE_THINKING = sse([
  msgStart(REPLY_UUID_2, 'claude-opus-5-5'),
  blockStart(0, 'thinking'),
  blockDelta(0, 'thinking_delta', { thinking: 'hidden reasoning' }),
  blockDelta(0, 'signature_delta', { signature: 'sig' }),
  blockStop(0),
  blockStart(1, 'text'),
  textDelta(1, '可见回复'),
  blockStop(1),
  msgDelta('end_turn'),
  msgStop(),
]);

export const SSE_PING_COMMENTS = ': comment line\n' + sse([
  ping(),
  msgStart(),
  blockStart(0),
  textDelta(0, 'ok'),
  blockStop(0),
  msgDelta(),
  msgStop(),
]);

export const SSE_NO_STOP = sse([
  msgStart(),
  blockStart(0),
  textDelta(0, 'partial reply here'),
  blockStop(0),
]);

export const SSE_BAD_JSON = sse([
  msgStart(),
  ['content_block_start', '{not valid json'],
]);

export const SSE_NO_UUID = sse([
  ['message_start', JSON.stringify({ type: 'message_start', message: { model: 'x' } })],
  blockStart(0),
  textDelta(0, 'hi'),
  blockStop(0),
  msgStop(),
]);

export const SSE_ERROR_EVENT = sse([
  msgStart(),
  ['error', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })],
]);

export const SSE_EMPTY_REPLY = sse([
  msgStart(),
  blockStart(0),
  blockStop(0),
  msgDelta(),
  msgStop(),
]);

export function sseMultilineData(uuid = REPLY_UUID) {
  const start = JSON.stringify({ type: 'message_start', message: { uuid } });
  const mid = start.indexOf('"message":') + '"message":'.length;
  return [
    'event: message_start',
    `data: ${start.slice(0, mid)}`,
    `data: ${start.slice(mid)}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'joined' } })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 2 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
    '',
  ].join('\r\n');
}

export const ORGS = [
  { uuid: '99999999-8888-4777-8666-555544443333', name: 'chat org', capabilities: ['claude_pro', 'chat'] },
];
export const ORG_ID = ORGS[0].uuid;
export const ORGS_DUAL = [
  ...ORGS,
  { uuid: '77777777-6666-4555-8444-333322221111', name: 'api org', capabilities: ['api'] },
];
export const ORGS_AMBIGUOUS = [
  ...ORGS,
  { uuid: '66666666-5555-4444-8333-222211110000', name: 'second chat', capabilities: ['chat'] },
];

export const CONV_ID = '22222222-3333-4444-8555-666677778888';

export const SSE_TWO_TEXT_BLOCKS = sse([
  msgStart(),
  blockStart(0),
  blockStart(1),
  textDelta(1, 'second-block '),
  textDelta(0, 'first-block '),
  textDelta(1, 'tail'),
  blockStop(1),
  blockStop(0),
  msgDelta('end_turn'),
  msgStop(),
]);

// lifecycle-violating fixtures (each must fail, not yield partial success)
export const SSE_DUP_START = sse([msgStart(), msgStart(REPLY_UUID_2)]);
export const SSE_DUP_BLOCK = sse([msgStart(), blockStart(0), blockStart(0)]);
export const SSE_DELTA_UNKNOWN = sse([msgStart(), textDelta(3, 'x'), msgDelta(), msgStop()]);
export const SSE_DELTA_AFTER_STOP = sse([msgStart(), blockStart(0), blockStop(0), textDelta(0, 'late'), msgDelta(), msgStop()]);
export const SSE_STOP_UNKNOWN = sse([msgStart(), blockStop(9), msgDelta(), msgStop()]);
export const SSE_STOP_NO_REASON = sse([msgStart(), blockStart(0), textDelta(0, 'x'), blockStop(0), msgStop()]);
export const SSE_BAD_INDEX = sse([msgStart(), ['content_block_start', JSON.stringify({ type: 'content_block_start', index: 0.5, content_block: { type: 'text' } })]]);

export const SAMPLE_PNG = Buffer.from([
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAABkCAIAAAA3wCqQAAAB6klEQVR4nO3SwYlCURREQSNxPRvTMAhD',
  'nJjMRY1AEPrTn6YOHcC7j7q8pKEu7QdIyYDWVEBrKqA1FdCaCmhNBbSmAlpTAa2pgNZUQGsqoDUV0JoK',
  'aE0FtKYCWlMBramA1lRAayqgNRXQmgpoTQW0pgJaU/0G+vp4nnAHfc2n5+3vhDvu3uv//YT76QSgv1W3',
  'CzTQyep2gQY6Wd0u0EAnq9sFGuhkdbtAA52sbhdooJPV7QINdLK6XaCBTla3CzTQyep2gQY6Wd0u0EAn',
  'q9sFGuhkdbtAA52sbhdooJPV7QINdLK6XaCBTla3CzTQyep2gQY6Wd0u0EAnq9sFGuhkdbtAA52sbhdo',
  'oJPV7QINdLK6XaCBTla3CzTQyep2gQY6Wd0u0EAnq9sFGuhkdbtAA52sbhdooJPV7QINdLK6XaCBTla3',
  'CzTQyep2gQY6Wd0u0EAnq9sFGuhkdbtAA52sbhdooJPV7QINdLK6XaCBTla3CzTQyep2gQY6Wd0u0EAn',
  'q9sFGuhkdbtAA52sbhdooJPV7QINdLK6XaCBTla3C/SxoKWTB7SmAlpTAa2pgNZUQGsqoDUV0JoKaE0F',
  'tKYCWlMBramA1lRAayqgNRXQmgpoTQW0pgJaUwGtqYDWVEBrKqA1FdCaCmhN9QbmFI9+86JF2QAAAABJ',
  'RU5ErkJggg==',
].join(''), 'base64');
export const SAMPLE_CODE = Buffer.from('export function compute(x) {\n  return x * 8 + 16;\n}\n');
export const SAMPLE_PDF = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 76 >>
stream
BT /F1 14 Tf 40 720 Td (CCW-DOC-00000000-0000-4000-8000-000000000001) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f${' '}
0000000009 00000 n${' '}
0000000058 00000 n${' '}
0000000115 00000 n${' '}
0000000241 00000 n${' '}
0000000311 00000 n${' '}
trailer
<< /Size 6 /Root 1 0 R >>
startxref
436
%%EOF
`);

export const FILE_PNG_ID = '33333333-4444-4555-8666-777788889999';
export const FILE_PDF_ID = '44444444-5555-4666-8777-88889999aaaa';
export const OUTPUT_IDS = [
  '55555555-6666-4777-8888-9999aaaabbbb',
  '66666666-7777-4888-8999-aaaabbbbcccc',
  '77777777-8888-4999-8aaa-bbbbccccdddd',
];
export const OBSERVED_UPLOADS = [
  { success: true, file_kind: 'image', file_uuid: FILE_PNG_ID, file_name: 'sample.png', size_bytes: 547, preview_asset: { file_variant: 'preview' }, thumbnail_asset: { file_variant: 'thumbnail' } },
  { success: true, file_kind: 'document', file_uuid: FILE_PDF_ID, file_name: 'sample.pdf', size_bytes: 619, media_type: 'application/pdf', document_asset: { file_variant: 'document_pdf', page_count: 1 } },
];
export const OBSERVED_FILE_DELIVERIES = {
  type: 'tool_result',
  name: 'SendUserFile',
  tool_use_id: 'sanitized-share-id',
  is_error: false,
  file_deliveries: ['result.md', 'drawing.svg', 'result.js'].map((name, i) => ({
    file_uuid: OUTPUT_IDS[i], path: `/home/claude/${name}`,
  })),
};
export const OBSERVED_HUMAN_ATTACHMENTS = {
  attachments: [{
    id: '88888888-9999-4aaa-8bbb-ccccddddeeee',
    file_name: 'sample.js', file_size: 52, file_type: 'text/javascript',
    extracted_content: SAMPLE_CODE.toString('utf8'),
    created_at: '2026-11-04T00:00:00.000000Z',
  }],
  files: OBSERVED_UPLOADS.map(f => ({
    file_uuid: f.file_uuid, file_kind: f.file_kind, file_name: f.file_name, size_bytes: f.size_bytes,
  })),
};

export const OBSERVED_FRAME_PUBLICATION = {
  type: 'tool_result', name: 'mcp__claude-artifacts__publish_files', is_error: false,
  content: [{ type: 'text', text: JSON.stringify({
    slug: '99999999-aaaa-4bbb-8ccc-ddddeeeeffff', version: '0000000000-test', seq: 1, own_file_count: 1,
    title: 'Synthetic Artifact', read: 'owner', history: ['0000000000-test'],
    contract: '0.0.0', minContract: '0.0.0', preferredContract: '0.2.96',
    url: 'https://claude.ai/artifact/SyntheticArtifact0001',
  }) }],
};

export const SYNTHETIC_FRAME_PAGE = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Synthetic Artifact</title>\n</head>\n<body><svg width="10" height="10"><rect width="10" height="10" fill="#1E5EFF"/></svg></body>\n</html>\n';

// Block order observed on 2026-11-05 for a first single-file publication: Write -> result -> publish_files -> result.
export function observedFrameChain({ tag = 'a', page = SYNTHETIC_FRAME_PAGE, slug = '99999999-aaaa-4bbb-8ccc-ddddeeeeffff', version = '0000000000-test' } = {}) {
  const path = `/home/claude/frame-${tag}.html`;
  const publication = structuredClone(OBSERVED_FRAME_PUBLICATION);
  const data = JSON.parse(publication.content[0].text);
  Object.assign(data, { slug, version, history: [version] });
  publication.content[0].text = JSON.stringify(data);
  return [
    { type: 'tool_use', id: `toolu_write_${tag}`, name: 'Write', integration_name: 'Claude Code', input: { file_path: path, content: page } },
    { type: 'tool_result', tool_use_id: `toolu_write_${tag}`, name: 'Write', is_error: false, content: [{ type: 'text', text: `File created successfully at: ${path}` }] },
    { type: 'thinking', thinking: 'publish' },
    { type: 'tool_use', id: `toolu_publish_${tag}`, name: 'mcp__claude-artifacts__publish_files', integration_name: 'Claude Code',
      input: { files: [{ path, as: 'index.html' }], icon: 'square', title: 'Synthetic Artifact' } },
    { ...publication, tool_use_id: `toolu_publish_${tag}` },
  ];
}
