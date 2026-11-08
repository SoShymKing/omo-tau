import { MessageRenderer } from './message-renderer.js';
import { mergeActivityGroups } from './activity-group.js';

export function selectConversation(conversation, indices) {
  if (!conversation) return undefined;
  const keys = indices.map(index => conversation.entrySetKeys[index]);
  const visible = new Set(keys);
  return {
    entryKeys: indices.map(index => conversation.entryKeys[index]),
    entrySetKeys: keys,
    sets: conversation.sets.filter(set => visible.has(set.key)),
  };
}

export function joinConversation(previous, page, entries, offsets) {
  if (!page.conversation) return undefined;
  const positioned = new Map();
  const transient = new Map();
  const sets = new Map();
  for (const source of [previous, page]) {
    if (!source?.conversation) continue;
    for (const definition of source.conversation.sets) {
      const known = sets.get(definition.key);
      sets.set(definition.key, {
        ...definition,
        instruction: definition.instruction || known?.instruction || null,
        partialBefore: known ? known.partialBefore && definition.partialBefore : definition.partialBefore,
      });
    }
    source.entries.forEach((entry, index) => {
      const value = [source.conversation.entryKeys[index], source.conversation.entrySetKeys[index]];
      const offset = source.offsets?.[index] ?? source.history?.offsets?.[index];
      if (typeof offset === 'number') positioned.set(offset, value);
      else transient.set(entry, value);
    });
  }
  const values = entries.map((entry, index) => typeof offsets[index] === 'number'
    ? positioned.get(offsets[index]) : transient.get(entry));
  const visible = new Set(values.map(value => value[1]));
  return {
    entryKeys: values.map(value => value[0]),
    entrySetKeys: values.map(value => value[1]),
    sets: [...visible].map(key => sets.get(key)),
  };
}

/** Instructions are sidecars; response chunks retain their physical history positions. */
export class ConversationSets {
  constructor(root, getSessionId) {
    this.root = root;
    this.getSessionId = getSessionId;
    this.sets = new Map();
    this.ordinal = 0;
    this.enabled = false;
  }

  ensure(definition) {
    let set = this.sets.get(definition.key);
    if (!set) {
      const element = document.createElement('section');
      element.className = 'conversation-set';
      element.dataset.conversationKey = definition.key;
      element.setAttribute('aria-label', 'Conversation');
      const instruction = document.createElement('div');
      instruction.className = 'conversation-instruction';
      const partial = document.createElement('p');
      partial.className = 'conversation-partial';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.textContent = 'Earlier activity is not loaded.';
      const load = document.createElement('button');
      load.className = 'conversation-history-load';
      load.type = 'button';
      load.textContent = 'Load earlier messages';
      partial.append(status, load);
      const body = document.createElement('div');
      body.className = 'conversation-response';
      body.dataset.lazyActivity = 'true';
      element.append(instruction, partial, body);
      set = { element, instruction, partial, body, instructionKey: null };
      this.sets.set(definition.key, set);
    }
    set.partial.hidden = !definition.partialBefore;
    if (definition.instruction && set.instructionKey !== definition.instruction.entryKey) {
      const { entry, entryKey } = definition.instruction;
      const message = entry.message;
      const renderer = new MessageRenderer(set.instruction, () => {}, this.getSessionId);
      set.instruction.replaceChildren();
      renderer.renderUserMessage({
        content: typeof message.content === 'string' ? message.content
          : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
        attachments: Array.isArray(message.content)
          ? message.content.filter(block => ['image', 'file', 'resource_link'].includes(block.type)) : [],
        images: message.images,
        entryId: entry.id,
        clientMessageId: message.clientMessageId,
      }, true);
      set.instruction.lastElementChild.dataset.historyKey = entryKey;
      set.instructionKey = entryKey;
    }
    return set;
  }

  begin(conversation) {
    const chunks = new Map();
    for (const definition of conversation.sets) {
      this.ensure(definition);
      const chunk = document.createElement('div');
      chunk.dataset.lazyActivity = 'true';
      chunks.set(definition.key, chunk);
    }
    return chunks;
  }

  commit(chunks, prepend) {
    const inserted = document.createDocumentFragment();
    for (const [key, chunk] of chunks) {
      const set = this.sets.get(key);
      if (!set.instruction.hasChildNodes() && !chunk.hasChildNodes() && !set.body.hasChildNodes()) continue;
      if (!set.instruction.hasChildNodes()) {
        const label = document.createElement('p');
        label.className = 'conversation-label';
        label.textContent = 'Activity without an instruction';
        set.instruction.append(label);
      }
      if (!set.element.parentElement) inserted.append(set.element);
      if (prepend) {
        const older = chunk.lastElementChild;
        const newer = set.body.firstElementChild;
        set.body.prepend(...chunk.childNodes);
        mergeActivityGroups(older, newer);
      } else set.body.append(...chunk.childNodes);
    }
    if (prepend) this.root.insertBefore(inserted, this.root.querySelector('.conversation-set'));
    else this.root.append(inserted);
    const last = this.root.querySelector('.conversation-set:last-of-type');
    this.current = last ? this.sets.get(last.dataset.conversationKey) : null;
  }

  user(message) {
    if (message.clientMessageId) {
      for (const set of this.sets.values()) {
        if (set.instruction.querySelector(`[data-client-message-id="${CSS.escape(message.clientMessageId)}"]`)) {
          this.current = set;
          return set.instruction.querySelector('.message.user');
        }
      }
    }
    const key = message.clientMessageId ? `pending:${message.clientMessageId}` : `live-user:${++this.ordinal}`;
    const set = this.ensure({
      key, partialBefore: false,
      instruction: { entry: { type: 'message', message }, entryKey: key, offset: null },
    });
    this.root.querySelector('.welcome')?.remove();
    this.root.append(set.element);
    this.current = set;
    return set.instruction.querySelector('.message.user');
  }

  clear() {
    this.sets.clear();
    this.current = null;
  }
}
