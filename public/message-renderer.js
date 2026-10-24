/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';
import { appendActivity } from './activity-group.js';
import { appendAttachments } from './attachments.js';

export class MessageRenderer {
  constructor(container, requestScroll, getSessionId = () => null) {
    this.container = container;
    this.requestScroll = requestScroll;
    this.thinkingBlocks = new WeakMap();
    this.getSessionId = getSessionId;
  }

  clear() {
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        // KaTeX not loaded or rendering failed — math stays as raw TeX
      }
    }
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    div.innerHTML = `
      <div class="message-content">${renderUserMarkdown(message.content)}</div>
      <button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    const content = div.querySelector('.message-content');
    appendAttachments(content, [...(message.images || []), ...(message.attachments || [])], this.getSessionId());
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    this._renderMath(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    const thinkingParts = [];
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          thinkingParts.push(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      const content = div.querySelector('.message-content');
      appendAttachments(content, Array.isArray(message.content) ? message.content : [], this.getSessionId());
      this._setupCopyBtn(div);
    }
    const hasText = typeof message.content === 'string'
      ? message.content.trim().length > 0
      : message.content?.some(block => block.type === 'text' && block.text?.trim());
    div.hidden = !hasText && !div.querySelector('.chat-attachment');
    this.container.appendChild(div);
    if (thinkingParts.length) this._updateThinking(div, thinkingParts.join('\n\n'), isStreaming);
    if (!isStreaming && div.hidden) div.remove();
    if (!isStreaming) this._renderMath(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  _updateThinking(messageElement, thinking, isStreaming = false) {
    let thinkingDiv = this.thinkingBlocks.get(messageElement);
    if (!thinkingDiv) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = this.renderThinkingBlock(thinking);
      thinkingDiv = wrapper.firstElementChild;
      const container = messageElement.parentElement;
      container.insertBefore(thinkingDiv, messageElement);
      appendActivity(container, thinkingDiv);
      this.thinkingBlocks.set(messageElement, thinkingDiv);
    }
    thinkingDiv.classList.toggle('streaming-thinking', isStreaming);
    thinkingDiv.querySelector('.thinking-content').textContent = thinking;
  }

  updateStreamingThinking(messageElement, thinking) {
    this._updateThinking(messageElement, thinking, true);
    this.scrollToBottom();
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.innerHTML = this.escapeHtml(content);
      messageElement.hidden = !content.trim();
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '', blocks = []) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      const rawText = contentDiv.textContent;
      if (thinking) this._updateThinking(messageElement, thinking);
      const hasAttachments = blocks.some(block => ['image', 'file', 'resource_link'].includes(block.type));
      if (!rawText.trim() && !hasAttachments) {
        messageElement.remove();
        this.scrollToBottom();
        return;
      }
      messageElement.hidden = false;
      contentDiv.innerHTML = renderMarkdown(rawText);
      appendAttachments(contentDiv, blocks, this.getSessionId());
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage && usage.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
    this.scrollToBottom();
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    this.requestScroll();
  }
}
