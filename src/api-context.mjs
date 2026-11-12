import { BridgeError } from './core/errors.mjs';

export const DEFAULT_API_CONTEXT_TOKENS = 16_000;
export const MIN_API_CONTEXT_TOKENS = 1_024;
export const MAX_API_CONTEXT_TOKENS = 131_072;

const REQUEST_OVERHEAD_TOKENS = 256;
const MESSAGE_OVERHEAD_TOKENS = 32;

export function estimateApiMessageTokens(message) {
  return MESSAGE_OVERHEAD_TOKENS + Math.ceil(Buffer.byteLength(message?.content ?? '', 'utf8') / 2);
}

export function estimateApiInputTokens(messages) {
  return REQUEST_OVERHEAD_TOKENS + messages.reduce((total, message) => total + estimateApiMessageTokens(message), 0);
}

export function selectApiContext(messages, tokenBudget) {
  if (!Array.isArray(messages) || !messages.length || messages.length % 2 !== 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'API context requires alternating user/assistant history with a current user turn');
  }
  const currentEstimate = estimateApiInputTokens([messages.at(-1)]);
  if (currentEstimate > tokenBudget) {
    throw new BridgeError('API_INPUT_BUDGET', 'The current prompt exceeds the configured API input token budget; nothing was sent', {
      estimatedInputTokens: currentEstimate,
      tokenBudget,
    });
  }

  for (let start = 0; start < messages.length; start += 2) {
    const selected = messages.slice(start);
    const estimatedInputTokens = estimateApiInputTokens(selected);
    if (estimatedInputTokens <= tokenBudget) {
      return {
        messages: selected,
        context: {
          policy: 'rolling-window',
          tokenBudget,
          estimatedInputTokens,
          retainedTurns: (selected.length - 1) / 2,
          omittedTurns: start / 2,
          retainedMessages: selected.length,
        },
      };
    }
  }

  throw new BridgeError('API_INPUT_BUDGET', 'No complete API context fits the configured input token budget; nothing was sent', {
    tokenBudget,
  });
}
