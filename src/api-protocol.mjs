import { apiProtocol, apiReasoningEffort, apiWireMaxTokens } from './api-config.mjs';
import { selectApiContext } from './api-context.mjs';

const PATHS = Object.freeze({ messages: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' });

// Shared by the sender and doctor: diagnostics describe the actual wire fields.
export function apiWireSettings(config) {
  const protocol = apiProtocol(config);
  const effort = apiReasoningEffort(config);
  const limit = apiWireMaxTokens(config);
  const fields = protocol === 'messages'
    ? { max_tokens: limit, ...(effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {}) }
    : protocol === 'chat'
      ? { max_completion_tokens: limit, ...(effort ? { reasoning_effort: effort } : {}) }
      : { max_output_tokens: limit, ...(effort ? { reasoning: { effort } } : {}) };
  return { path: PATHS[protocol], fields: { stream: protocol === 'messages', ...fields } };
}

export function apiPayload(config, messages, sessionId) {
  return apiPayloadFor(config, selectApiContext(messages, config.apiContextTokens).messages, sessionId);
}

export function apiPayloadFor(config, messages, sessionId) {
  const protocol = apiProtocol(config);
  const common = {
    model: config.apiModel, metadata: { user_id: sessionId },
    ...apiWireSettings(config).fields,
  };
  if (protocol === 'messages') {
    const content = messages.map((m, i) => ({
      role: m.role,
      content: [{ type: 'text', text: m.content,
        ...(config.apiCache === 'ephemeral' && (i === 0 || i === messages.length - 2) ? { cache_control: { type: 'ephemeral' } } : {}),
      }],
    }));
    return { ...common, messages: content };
  }
  // A bounded rolling suffix is replayed locally; no remote stored response chain.
  const history = messages.map(m => ({ role: m.role, content: m.content }));
  return { ...common, store: false, ...(protocol === 'chat' ? { messages: history } : { input: history }) };
}
