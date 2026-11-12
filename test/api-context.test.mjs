import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateApiInputTokens,
  estimateApiMessageTokens,
  selectApiContext,
} from '../src/api-context.mjs';

const turn = (index, width = 8) => [
  { role: 'user', content: `question-${index}-${'x'.repeat(width)}` },
  { role: 'assistant', content: `answer-${index}-${'y'.repeat(width)}` },
];

test('api context: estimates UTF-8 conservatively and includes message overhead', () => {
  assert.equal(estimateApiMessageTokens({ content: 'abc' }), 34);
  assert.equal(estimateApiMessageTokens({ content: '中文' }), 35);
  assert.equal(estimateApiInputTokens([{ content: 'abc' }]), 290);
});

test('api context: selects the largest complete-turn suffix within budget', () => {
  const messages = [...turn(0), ...turn(1), { role: 'user', content: 'current question' }];
  const full = estimateApiInputTokens(messages);
  const result = selectApiContext(messages, full);
  assert.equal(result.context.omittedTurns, 0);
  assert.deepEqual(result.messages, messages);

  const withoutFirst = estimateApiInputTokens(messages.slice(2));
  const rolled = selectApiContext(messages, withoutFirst);
  assert.deepEqual(rolled.messages, messages.slice(2));
  assert.equal(rolled.context.omittedTurns, 1);
  assert.equal(rolled.context.retainedTurns, 1);
  assert.equal(rolled.context.retainedMessages, 3);
});

test('api context: always keeps the current turn and rejects only an oversized prompt', () => {
  const current = { role: 'user', content: 'current question' };
  const result = selectApiContext([...turn(0), current], estimateApiInputTokens([current]));
  assert.deepEqual(result.messages, [current]);
  assert.equal(result.context.retainedTurns, 0);
  assert.equal(result.context.omittedTurns, 1);

  assert.throws(
    () => selectApiContext([{ role: 'user', content: 'x'.repeat(2000) }], 1024),
    error => error.code === 'API_INPUT_BUDGET' && error.details.estimatedInputTokens > 1024,
  );
});
