import { BridgeError } from './errors.mjs';

export const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkWorkspace(data) {
  if (data.workspace_upgraded !== undefined && typeof data.workspace_upgraded !== 'boolean') {
    throw new BridgeError('API_CONTRACT', 'workspace_upgraded must be boolean');
  }
}

function checkMessageShape(m, index) {
  const field = `chat_messages[${index}]`;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new BridgeError('API_CONTRACT', `${field} is malformed`);
  }
  if (typeof m.uuid !== 'string' || !UUID_RE.test(m.uuid)) {
    throw new BridgeError('API_CONTRACT', `${field}.uuid is not a UUID`);
  }
  if (typeof m.parent_message_uuid !== 'string' || !UUID_RE.test(m.parent_message_uuid)) {
    throw new BridgeError('API_CONTRACT', `${field}.parent_message_uuid is not a UUID`);
  }
  if (m.sender !== 'human' && m.sender !== 'assistant') {
    throw new BridgeError('API_CONTRACT', `${field}.sender is not human or assistant`);
  }
  if (!Array.isArray(m.content)) {
    throw new BridgeError('API_CONTRACT', `${field}.content is not an array`);
  }
  for (const block of m.content) {
    if (block && block.type === 'text' && typeof block.text !== 'string') {
      throw new BridgeError('API_CONTRACT', `${field}.content text block is missing text`);
    }
  }
  if (m.stop_reason !== undefined && m.stop_reason !== null && typeof m.stop_reason !== 'string') {
    throw new BridgeError('API_CONTRACT', `${field}.stop_reason is malformed`);
  }
  if (m.truncated !== undefined && m.truncated !== null && typeof m.truncated !== 'boolean') {
    throw new BridgeError('API_CONTRACT', `${field}.truncated is malformed`);
  }
}

export class ClaudeApi {
  constructor(tab, config) {
    this.tab = tab;
    this.config = config;
  }

  async discoverOrganization({ signal } = {}) {
    const data = await this.tab.request({ path: '/api/organizations' }, {
      signal,
      timeoutMs: this.config.readyTimeoutMs,
    });
    if (!Array.isArray(data)) {
      throw new BridgeError('API_CONTRACT', '/api/organizations did not return an array');
    }
    const hasChat = (o) => o && typeof o === 'object'
      && typeof o.uuid === 'string' && UUID_RE.test(o.uuid)
      && Array.isArray(o.capabilities)
      && o.capabilities.includes('chat');
    const chatOrgs = data.filter(hasChat);
    if (this.config.orgId) {
      const match = data.find((o) => o && o.uuid === this.config.orgId);
      if (!match) {
        throw new BridgeError('ORG_NOT_FOUND', 'Configured CCW_ORG_ID is not present on this account');
      }
      if (!hasChat(match)) {
        throw new BridgeError('ORG_NOT_FOUND', 'Configured CCW_ORG_ID does not have the chat capability');
      }
      return match.uuid;
    }
    if (chatOrgs.length === 0) {
      if (data.length === 0) {
        throw new BridgeError('AUTH_REQUIRED', 'No organizations returned; the browser session is probably not logged in');
      }
      throw new BridgeError('ORG_NOT_FOUND', 'No organization with the chat capability found');
    }
    if (chatOrgs.length > 1) {
      throw new BridgeError('ORG_AMBIGUOUS', 'Multiple organizations have the chat capability; set CCW_ORG_ID', {
        count: chatOrgs.length,
      });
    }
    return chatOrgs[0].uuid;
  }

  async createConversation(orgId, conversationId, title, { signal } = {}) {
    const data = await this.tab.request({
      path: `/api/organizations/${orgId}/chat_conversations`,
      method: 'POST',
      body: { uuid: conversationId, name: title },
    }, { signal, timeoutMs: this.config.readyTimeoutMs });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.uuid !== conversationId) {
      throw new BridgeError('API_CONTRACT', 'Conversation creation returned an unexpected response');
    }
    checkWorkspace(data);
    return data;
  }

  async conversation(orgId, conversationId, { signal } = {}) {
    const data = await this.tab.request({
      path: `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    }, { signal, timeoutMs: this.config.readyTimeoutMs });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BridgeError('API_CONTRACT', 'Conversation read did not return an object');
    }
    if (data.uuid !== conversationId) {
      throw new BridgeError('API_CONTRACT', 'Conversation response uuid does not match the requested conversation');
    }
    checkWorkspace(data);
    if (!Object.hasOwn(data, 'chat_messages') || !Array.isArray(data.chat_messages)) {
      throw new BridgeError('API_CONTRACT', 'Conversation response is missing chat_messages');
    }
    // The page omits the leaf pointer on empty conversations instead of sending
    // null; a non-empty response without it is still a contract violation.
    if (!Object.hasOwn(data, 'current_leaf_message_uuid') && data.chat_messages.length !== 0) {
      throw new BridgeError('API_CONTRACT', 'Conversation response is missing current_leaf_message_uuid');
    }
    const leaf = data.current_leaf_message_uuid ?? null;
    if (leaf !== null && (typeof leaf !== 'string' || !UUID_RE.test(leaf))) {
      throw new BridgeError('API_CONTRACT', 'current_leaf_message_uuid is not a UUID or null');
    }
    data.chat_messages.forEach((m, i) => checkMessageShape(m, i));
    return data;
  }

  async complete(orgId, conversationId, parentMessageId, prompt, { signal } = {}) {
    return await this.tab.request({
      path: `/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
      method: 'POST',
      stream: true,
      body: {
        prompt,
        parent_message_uuid: parentMessageId,
        timezone: 'Asia/Tokyo',
        locale: 'zh-Hant',
        personalized_styles: [],
        tools: [],
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: 'messages',
      },
    }, {
      signal,
      timeoutMs: this.config.timeoutMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
  }

  async contents(orgId, fileId, { signal } = {}) {
    return this.tab.request({ path: `/api/organizations/${orgId}/files/${fileId}/contents`, binary: true }, {
      signal, timeoutMs: this.config.timeoutMs, idleTimeoutMs: this.config.idleTimeoutMs,
    });
  }
}

export function activeBranch(conversation) {
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
    throw new BridgeError('API_CONTRACT', 'Conversation is not an object');
  }
  if (!Object.hasOwn(conversation, 'chat_messages') || !Array.isArray(conversation.chat_messages)) {
    throw new BridgeError('API_CONTRACT', 'Conversation is missing chat_messages');
  }
  const messages = conversation.chat_messages;
  const leaf = conversation.current_leaf_message_uuid ?? null;
  const byId = new Map();
  messages.forEach((m, i) => {
    checkMessageShape(m, i);
    if (byId.has(m.uuid)) {
      throw new BridgeError('API_CONTRACT', 'Conversation contains duplicate message ids');
    }
    byId.set(m.uuid, m);
  });
  if (leaf === null || leaf === ROOT_PARENT) {
    if (messages.length !== 0) {
      throw new BridgeError('API_CONTRACT', 'Conversation has messages but no current leaf');
    }
    return [];
  }
  if (!UUID_RE.test(leaf)) {
    throw new BridgeError('API_CONTRACT', 'current_leaf_message_uuid is not a valid UUID');
  }
  const chain = [];
  const seen = new Set();
  let cur = leaf;
  while (cur !== ROOT_PARENT) {
    if (seen.has(cur)) {
      throw new BridgeError('API_CONTRACT', 'Conversation parent chain contains a cycle');
    }
    seen.add(cur);
    const msg = byId.get(cur);
    if (!msg) {
      throw new BridgeError('API_CONTRACT', 'Conversation parent chain references a missing message');
    }
    chain.push(msg);
    cur = msg.parent_message_uuid;
  }
  return chain.reverse();
}
