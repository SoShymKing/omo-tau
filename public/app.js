/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { Launcher } from './launcher.js';


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'), requestRenderScroll);
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
let dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const typingIndicator = document.getElementById('typing-indicator');

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastUsage = null; // Full usage object for context visualiser
const selectedSessionKey = `tau-selected-session:${location.origin}`;
let isMirrorMode = false; // Set when mirror_sync received
let liveSessions = [];
let sessionStatusRevision = 0;
let currentWorkspace = '';
let pendingDialogRequests = [];

let renderFrameId = null;
let renderGeneration = 0;
let pendingMessagePaints = new Map();
let pendingToolPaints = new Map();
let pendingScroll = false;
let isFlushingRender = false;

function scheduleRender() {
  if (renderFrameId !== null) return;
  const generation = renderGeneration;
  const frameId = requestAnimationFrame(() => {
    if (generation !== renderGeneration || renderFrameId !== frameId) return;
    flushRender();
  });
  renderFrameId = frameId;
}

function requestRenderScroll() {
  pendingScroll = true;
  if (!isFlushingRender) scheduleRender();
}

function flushMessagePaint(element, batch = pendingMessagePaints) {
  const snapshot = batch.get(element);
  batch.delete(element);
  if (!snapshot || !messagesContainer.contains(element)) return;
  const generation = renderGeneration;
  if (snapshot.thinking) {
    // A prior text-only paint owns the content node until Thinking appears.
    if (!element.querySelector('.streaming-thinking')) {
      element.querySelector('.message-content').replaceChildren();
    }
    messageRenderer.updateStreamingThinking(element, snapshot.thinking);
  }
  if (generation !== renderGeneration || !messagesContainer.contains(element)) return;
  messageRenderer.updateStreamingMessage(element, snapshot.text);
}

function flushToolPaint(toolCallId, batch = pendingToolPaints) {
  const snapshot = batch.get(toolCallId);
  batch.delete(toolCallId);
  if (snapshot) toolCardRenderer.updateToolCard(snapshot);
}

function flushRender() {
  if (renderFrameId !== null) cancelAnimationFrame(renderFrameId);
  renderFrameId = null;
  const generation = renderGeneration;
  const messages = pendingMessagePaints;
  const tools = pendingToolPaints;
  pendingMessagePaints = new Map();
  pendingToolPaints = new Map();
  isFlushingRender = true;
  try {
    for (const element of messages.keys()) {
      if (generation !== renderGeneration) return;
      flushMessagePaint(element, messages);
    }
    for (const toolCallId of tools.keys()) {
      if (generation !== renderGeneration) return;
      flushToolPaint(toolCallId, tools);
    }
    if (generation !== renderGeneration) return;
    if (pendingScroll && messageRenderer.isNearBottom) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    pendingScroll = false;
  } finally {
    isFlushingRender = false;
  }
}

function invalidateRender() {
  renderGeneration++;
  if (renderFrameId !== null) cancelAnimationFrame(renderFrameId);
  renderFrameId = null;
  pendingMessagePaints.clear();
  pendingToolPaints.clear();
  pendingScroll = false;
}

function canSend() {
  const session = state.getSession();
  return wsClient.isConnected && wsClient.gatewayReady && wsClient.sessionReady &&
    !!session && session.status !== 'disconnected' && session.status !== 'closed';
}

function saveDraft() {
  const session = state.getSession();
  if (!session) return;
  session.draft = messageInput.value;
  session.images = pendingImages;
  session.filePaths = pendingFilePaths;
}

function sessionRPC(cmd, sessionId = wsClient.sessionId) {
  const gatewayCommand = cmd.type === 'get_auth' || cmd.type === 'set_auth';
  if (!gatewayCommand && (!canSend() || !sessionId)) {
    return Promise.reject(new Error('Select a connected session first'));
  }
  return fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cmd, ...(sessionId ? { sessionId } : {}) }),
  });
}

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
}, () => wsClient.sessionReady ? wsClient.sessionId : null);

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder').title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    flushRender();
    if (wsClient.ws?.readyState !== WebSocket.OPEN) {
      console.log('[App] Returning to app, reconnecting...');
      wsClient.forceReconnect();
    }
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  updateUI();
});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
  updateUI();
});

wsClient.addEventListener('stateUpdate', (e) => {
  const data = e.detail;
  if (data.mode !== 'gateway') {
    updateUI();
    statusText.textContent = 'Session selection is not supported by this server';
    return;
  }
  const sessionFile = localStorage.getItem(selectedSessionKey) || data.defaultSessionFile;
  if (!sessionFile) {
    statusText.textContent = 'No session is available';
    return;
  }
  switchSession(sessionFile).catch(error => {
    if (error.name !== 'AbortError') messageRenderer.renderError(error.message);
    updateUI();
  });
});

wsClient.addEventListener('sessionStatus', (e) => {
  sessionStatusRevision++;
  updateSessionStatus(e.detail);
});

wsClient.addEventListener('response', (e) => {
  const response = e.detail;
  if (response.success !== false) return;
  const session = [...state.sessions.values()].find(item => item.sessionId === response.sessionId);
  if (response.command === 'prompt' && session) {
    session.awaitingPrompt = false;
    session.isStreaming = false;
    session.lastSentMessage = null;
  }
  if (response.sessionId === wsClient.sessionId) {
    messageRenderer.renderError(response.error || 'Command failed');
  }
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  if (!e.detail.sessionId || e.detail.sessionId === wsClient.sessionId) {
    messageRenderer.renderError(e.detail.message);
  }
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  messageRenderer.scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  const session = state.getSession();
  session.isStreaming = true;
  session.awaitingPrompt = false;
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  flushRender();
  const session = state.getSession();
  session.isStreaming = false;
  session.awaitingPrompt = false;
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  currentStreamingThinking = '';
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    const session = state.getSession();
    if (!session.lastSentMessage || getMessageText(message) !== session.lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    session.lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;
  if (!currentStreamingElement) {
    currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
  }

  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking += assistantMessageEvent.delta;
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText += assistantMessageEvent.delta;
  } else {
    return;
  }
  pendingMessagePaints.set(currentStreamingElement, {
    text: currentStreamingText,
    thinking: currentStreamingThinking,
  });
  scheduleRender();
}

function handleMessageEnd(message) {
  if (message?.role !== 'assistant') return;
  if (currentStreamingElement) {
    flushMessagePaint(currentStreamingElement);
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  if (event.method !== 'notify') {
    if (dialogHandler.currentDialog) {
      pendingDialogRequests.push(event);
      return;
    }
    const sessionId = event.sessionId || wsClient.sessionId;
    const handler = new DialogHandler(document.getElementById('dialog-container'), {
      send: response => {
        wsClient.send({ ...response, sessionId });
        if (dialogHandler === handler && pendingDialogRequests.length) {
          handleExtensionUIRequest(pendingDialogRequests.shift());
        }
      },
    });
    dialogHandler = handler;
  }
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  saveDraft();
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');

let pendingImages = [];     // { data: base64, mimeType }
let pendingFilePaths = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  const session = state.getSession();
  if (!session || !canSend()) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const image = await processImageFile(file);
      session.images.push(image);
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  if (session === state.getSession()) {
    pendingImages = session.images;
    renderAttachmentPreviews();
  }
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  saveDraft();
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      thumb.src = `/api/file/preview?path=${encodeURIComponent(fp.path)}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

function sendMessage() {
  if (!canSend()) return;
  const session = state.getSession();
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;
  if (message.startsWith('/')) {
    sendSlashCommand(message);
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd = {
    type: 'prompt', id: wsClient.nextRequestId(), sessionId: session.sessionId,
    message: message || '(see attached image)',
  };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (session.isStreaming || session.awaitingPrompt) {
    // Queue it — show as bubble above input
    session.queue.push(cmd);
    renderQueuedMessages();
    return;
  }

  if (wsClient.send(cmd)) {
    session.lastSentMessage = cmd.message;
    session.awaitingPrompt = true;
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
  }
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  const messageQueue = state.getSession()?.queue || [];
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue(session = state.getSession()) {
  if (!wsClient.isConnected || !wsClient.gatewayReady || !wsClient.sessionReady ||
      !session?.sessionId || session.isStreaming || session.awaitingPrompt) return;
  if (session.status === 'disconnected' || session.status === 'closed') return;
  const cmd = session.queue[0];
  if (cmd && wsClient.send(cmd)) {
    session.queue.shift();
    session.awaitingPrompt = true;
    if (session === state.getSession()) {
      session.lastSentMessage = cmd.message;
      messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
      renderQueuedMessages();
    }
  }
}

abortBtn.addEventListener('click', () => {
  if (!canSend() || !wsClient.send({ type: 'abort' })) return;
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');
const commandSearch = document.getElementById('command-search');
const commandStatus = document.getElementById('command-status');
let agentCommands = [];
let commandReturnFocus = null;

const slashCommands = [
  { name: 'help', description: 'Browse available commands', action: () => openCommandPalette() },
  { name: 'name', description: 'Rename this session', args: '<name>', action: async (args) => {
    if (!args) throw new Error('Usage: /name <name>');
    const sessionId = wsClient.sessionId;
    const result = await rpcCommand({ type: 'set_session_name', name: args });
    if (sessionId !== wsClient.sessionId) return;
    if (!result?.success) throw new Error(result?.error || 'Rename failed');
    document.querySelectorAll('.session-item.active .session-title').forEach(title => {
      title.textContent = title.title = args;
    });
    messageRenderer.renderSystemMessage(`Session renamed: ${args}`);
  } },
  { name: 'stats', description: 'Show session statistics', action: () => showSessionStats() },
  { name: 'compact', description: 'Compact context', args: '[instructions]', action: async (args) => {
    if (state.isStreaming) throw new Error('Wait for the current response before compacting.');
    const result = await rpcCommand({ type: 'compact', customInstructions: args || undefined }, 'Compacting...');
    if (!result?.success) throw new Error(result?.error || 'Compaction failed');
  } },
  { name: 'model', description: 'Choose a model', action: () => openModelDropdown() },
  { name: 'settings', description: 'Open settings', action: () => openSettings() },
  { name: 'abort', description: 'Stop the current response', action: async () => {
    const result = await rpcCommand({ type: 'abort' });
    if (!result?.success) throw new Error(result?.error || 'Abort failed');
  } },
  { name: 'export', description: 'Export this session as HTML', action: () => rpcExportHtml() },
];

async function sendSlashCommand(message) {
  if (!canSend()) return;
  const session = state.getSession();
  if (session.slashPending) return;
  const sessionId = wsClient.sessionId;
  const draft = messageInput.value;
  try {
    if (pendingImages.length || pendingFilePaths.length) throw new Error('Send attachments separately from commands.');
    if (message === '/') { openCommandPalette(); return; }
    const [, name, args = ''] = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message) || [];
    const local = slashCommands.find(cmd => cmd.name === name);
    session.slashPending = true;
    if (local) {
      if (!local.args && args) throw new Error(`/${name} does not accept arguments.`);
      await local.action(args);
    } else {
      const result = await rpcCommand({ type: 'run_slash_command', message }, 'Submitting command...');
      if (!result?.success) throw new Error(result?.error || 'Command submission failed');
      if (sessionId === wsClient.sessionId) messageRenderer.renderSystemMessage(`Submitted /${name}`);
    }
    // Do not erase text the user entered while the request was in flight.
    if (sessionId === wsClient.sessionId && messageInput.value === draft) {
      messageInput.value = '';
      messageInput.style.height = 'auto';
      saveDraft();
    } else if (session.draft === draft) {
      session.draft = '';
    }
  } catch (error) {
    if (sessionId === wsClient.sessionId) messageRenderer.renderError(error.message);
  } finally {
    session.slashPending = false;
  }
}

const commands = [
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },

];

function renderCommandList() {
  commandList.innerHTML = '';
  const query = commandSearch.value.trim().replace(/^\//, '').toLowerCase();
  const choices = commands.concat([
    ...slashCommands.map(cmd => ({ ...cmd, source: 'Tau' })),
    ...agentCommands.filter(cmd => !slashCommands.some(local => local.name === cmd.name)),
  ].map(cmd => ({
    icon: '/',
    label: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`,
    desc: `${cmd.description || 'Agent command'} · ${cmd.source || 'agent'}`,
    action: () => {
      messageInput.value = `/${cmd.name} `;
      messageInput.focus();
      messageInput.style.height = 'auto';
    },
  })));
  choices.filter(cmd => `${cmd.label} ${cmd.desc}`.toLowerCase().includes(query)).forEach(cmd => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'command-item';
    el.innerHTML = `
      <div class="command-icon" aria-hidden="true">${escapeHtml(cmd.icon)}</div>
      <div>
        <div class="command-label">${escapeHtml(cmd.label)}</div>
        <div class="command-desc">${escapeHtml(cmd.desc)}</div>
      </div>
    `;
    el.addEventListener('click', async () => {
      const sessionId = wsClient.sessionId;
      closeCommandPalette();
      try {
        await cmd.action();
      } catch (error) {
        if (sessionId === wsClient.sessionId) messageRenderer.renderError(error.message);
      }
    });
    commandList.appendChild(el);
  });
  if (!commandList.children.length) {
    const empty = document.createElement('div');
    empty.className = 'command-hint';
    empty.textContent = 'No matching commands.';
    commandList.appendChild(empty);
  }
}

async function openCommandPalette() {
  if (!canSend()) return;
  const sessionId = wsClient.sessionId;
  if (!commandPalette.classList.contains('hidden')) return;
  commandReturnFocus = document.activeElement;
  commandSearch.value = '';
  renderCommandList();
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
  commandSearch.focus();
  commandStatus.textContent = 'Loading agent commands...';
  try {
    const response = await sessionRPC({ type: 'get_commands' }, sessionId);
    const result = await response.json();
    if (sessionId !== wsClient.sessionId) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'Cannot load agent commands');
    agentCommands = result.data.commands;
    commandStatus.textContent = '';
    renderCommandList();
  } catch (error) {
    if (sessionId !== wsClient.sessionId) return;
    agentCommands = [];
    commandStatus.textContent = error.message;
    renderCommandList();
  }
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
  commandReturnFocus?.focus();
}

commandBtn.addEventListener('click', openCommandPalette);
commandPaletteOverlay.addEventListener('click', closeCommandPalette);
document.getElementById('command-close').addEventListener('click', closeCommandPalette);
commandSearch.addEventListener('input', renderCommandList);
commandPalette.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const items = [...commandList.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? index + 1 : index < 0 ? items.length - 1 : index - 1;
    (items[next] || commandSearch).focus();
  } else if (e.key === 'Enter' && document.activeElement === commandSearch) {
    e.preventDefault();
    items[0]?.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeCommandPalette();
  } else if (e.key === 'Tab') {
    const focusable = [...commandPalette.querySelectorAll('button, input')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

async function rpcCommand(cmd, statusMsg) {
  const sessionId = cmd.sessionId || wsClient.sessionId;
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await sessionRPC(cmd, sessionId);
    const data = await resp.json();
    if (sessionId === wsClient.sessionId) {
      statusText.textContent = data.success ? 'Done' : data.error || 'Failed';
      setTimeout(() => {
        if (sessionId === wsClient.sessionId) updateUI();
      }, data.success ? 2000 : 3000);
    }
    return data;
  } catch (e) {
    if (sessionId === wsClient.sessionId) {
      statusText.textContent = e.message;
    }
    return { success: false, error: e.message, sessionId };
  }
}

async function rpcExportHtml() {
  const sessionId = wsClient.sessionId;
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (sessionId !== wsClient.sessionId) return;
  if (!data?.success) throw new Error(data?.error || 'Export failed');
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => { if (sessionId === wsClient.sessionId) updateUI(); }, 4000);
  }
}

async function showSessionStats() {
  const sessionId = wsClient.sessionId;
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (sessionId !== wsClient.sessionId) return;
  if (!data?.success) throw new Error(data?.error || 'Cannot load session stats');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const thinkingBtn = document.getElementById('thinking-btn');
function updateThinkingBtn() {
  thinkingBtn.textContent = currentThinkingLevel;
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off');
}
let currentModelId = '';
let availableModels = [];
let currentThinkingLevel = 'off';

async function fetchModelInfo() {
  if (!canSend()) return;
  const sessionId = wsClient.sessionId;
  try {
    const [modelsResp, stateResp] = await Promise.all([
      sessionRPC({ type: 'get_available_models' }, sessionId),
      sessionRPC({ type: 'get_state' }, sessionId),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();
    if (sessionId !== wsClient.sessionId) return;

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      updateModelLabel();

      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      updateThinkingBtn();
    }
  } catch (e) {
    // ignore
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = shortName || 'model';
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  if (!canSend()) return;
  const sessionId = wsClient.sessionId;
  modelDropdownMenu.innerHTML = '';

  // Search input
  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = 'Search models…';
  search.type = 'text';
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = '';
    const query = (filter || '').toLowerCase();
    availableModels.forEach(m => {
      const shortName = m.id.replace(/-\d{8}$/, '');
      const providerStr = m.provider || '';
      if (query && !shortName.toLowerCase().includes(query) && !providerStr.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `model-dropdown-item${m.id === currentModelId ? ' active' : ''}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '';
      const providerLabel = m.provider && m.provider !== 'anthropic' ? `<span class="model-dropdown-item-provider">${m.provider}</span>` : '';
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener('click', async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        const result = await rpcCommand({ type: 'set_model', sessionId, provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
        if (sessionId !== wsClient.sessionId || !result?.success) return;
        currentModelId = m.id;
        updateModelLabel();
        if (m.contextWindow) {
          contextWindowSize = m.contextWindow;
          updateTokenUsage();
        }
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener('click', async () => {
  const sessionId = wsClient.sessionId;
  const data = await rpcCommand({ type: 'cycle_thinking_level' }, 'Cycling thinking...');
  if (sessionId !== wsClient.sessionId) return;
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (workspaceDialog.open) return;
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }

    if (canSend() && state.isStreaming && wsClient.send({ type: 'abort' })) {
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Open commands (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    openCommandPalette();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
const workspaceDialog = document.getElementById('workspace-dialog');
const workspaceDirectory = document.getElementById('workspace-directory');
const workspaceCreateDirectory = document.getElementById('workspace-create-directory');
const workspaceError = document.getElementById('workspace-error');
const workspaceSubmit = document.getElementById('workspace-submit');
const workspaceDirectoryList = document.getElementById('workspace-directory-list');
const workspacePreviewPath = document.getElementById('workspace-preview-path');
const workspacePreviewStatus = document.getElementById('workspace-preview-status');
let workspaceLookup = null;
let workspaceLookupTimer = null;
let creatingWorkspace = false;

function cancelWorkspaceLookup() {
  clearTimeout(workspaceLookupTimer);
  workspaceLookupTimer = null;
  workspaceLookup?.abort();
  workspaceLookup = null;
  workspaceDirectoryList.replaceChildren();
  workspacePreviewPath.textContent = '';
  workspacePreviewStatus.textContent = '';
}

async function loadWorkspaceDirectories() {
  workspaceLookup?.abort();
  const controller = new AbortController();
  workspaceLookup = controller;
  workspacePreviewStatus.textContent = 'Loading folders...';
  try {
    const url = `/api/files?directories=1&path=${encodeURIComponent(workspaceDirectory.value)}&sessionId=${encodeURIComponent(wsClient.sessionId || '')}`;
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    if (workspaceLookup !== controller || !workspaceDialog.open) return;
    if (!res.ok) throw new Error(data.error || 'Could not read this path');
    workspacePreviewPath.textContent = data.path;
    workspaceDirectoryList.replaceChildren();
    for (const item of [{ name: '..', path: data.parentPath }, ...data.items]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-directory-option';
      button.textContent = item.name === '..' ? '..' : `${item.name}/`;
      button.title = item.path;
      button.dataset.path = item.path;
      button.addEventListener('click', () => {
        if (creatingWorkspace) return;
        workspaceDirectory.value = item.path;
        workspaceError.textContent = '';
        workspaceDirectory.focus();
        cancelWorkspaceLookup();
        loadWorkspaceDirectories();
      });
      workspaceDirectoryList.appendChild(button);
    }
    workspacePreviewStatus.textContent = data.items.length ? '' : 'No subfolders found.';
  } catch (error) {
    if (controller.signal.aborted || workspaceLookup !== controller || !workspaceDialog.open) return;
    workspaceDirectoryList.replaceChildren();
    workspacePreviewStatus.textContent = 'Cannot preview this path. You can still create a new folder below.';
  }
}

workspaceDirectory.addEventListener('input', () => {
  cancelWorkspaceLookup();
  workspacePreviewStatus.textContent = 'Loading folders...';
  workspaceLookupTimer = setTimeout(loadWorkspaceDirectories, 150);
});

workspaceDirectory.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && workspaceDirectoryList.firstElementChild) {
    event.preventDefault();
    workspaceDirectoryList.firstElementChild.focus();
  }
});

workspaceDirectoryList.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...workspaceDirectoryList.children];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? buttons[index + 1] : buttons[index - 1];
  (next || (event.key === 'ArrowUp' ? workspaceDirectory : buttons[index])).focus();
});

function openWorkspaceDialog(directory = currentWorkspace) {
  cancelWorkspaceLookup();
  workspaceDirectory.value = directory;
  workspaceCreateDirectory.checked = false;
  workspaceError.textContent = '';
  const suggestions = document.getElementById('workspace-suggestions');
  suggestions.replaceChildren();
  const paths = new Set([currentWorkspace, ...sidebar.projects.map(project => project.path)]);
  for (const value of paths) {
    if (!value) continue;
    const option = document.createElement('option');
    option.value = value;
    suggestions.appendChild(option);
  }
  workspaceDialog.showModal();
  workspaceDirectory.focus();
  loadWorkspaceDirectories();
}

newSessionBtn.addEventListener('click', () => openWorkspaceDialog());
document.getElementById('workspace-cancel').addEventListener('click', () => workspaceDialog.close());
workspaceDialog.addEventListener('cancel', (event) => {
  if (creatingWorkspace) event.preventDefault();
});
workspaceDialog.addEventListener('close', () => {
  cancelWorkspaceLookup();
  newSessionBtn.focus();
});

document.getElementById('workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creatingWorkspace) return;
  creatingWorkspace = true;
  cancelWorkspaceLookup();
  workspaceError.textContent = '';
  workspaceSubmit.disabled = true;
  workspaceSubmit.textContent = 'Creating chat...';
  document.getElementById('workspace-cancel').disabled = true;
  workspaceDirectory.disabled = true;
  workspaceCreateDirectory.disabled = true;
  try {
    await newSession(workspaceDirectory.value, workspaceCreateDirectory.checked);
  } catch (error) {
    workspaceError.textContent = error.message;
  } finally {
    creatingWorkspace = false;
    workspaceSubmit.disabled = false;
    workspaceSubmit.textContent = 'Create chat';
    document.getElementById('workspace-cancel').disabled = false;
    workspaceDirectory.disabled = false;
    workspaceCreateDirectory.disabled = false;
    if (workspaceDialog.open) {
      workspaceDirectory.focus();
      if (workspaceError.textContent) loadWorkspaceDirectories();
    }
  }
});

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession(directory, createDirectory = false) {
  const res = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, createDirectory }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not create chat');
  await switchSession(data.sessionFile);
  workspaceDialog.close();
  hideLauncher();
  await sidebar.loadSessions();
  updateMirrorLiveIndicator();
}

async function handleSessionSelect(session, project) {
  if (!session?.filePath) return;
  try {
    await switchSession(session.filePath);
    hideLauncher();
    // Close sidebar only after the requested session has committed.
    if (isMobile()) {
      sidebarEl.classList.add('collapsed');
      sidebarOverlay.classList.remove('visible');
    }
  } catch (error) {
    if (error.name !== 'AbortError') messageRenderer.renderError(error.message);
  }
}

function switchSession(sessionFile) {
  return wsClient.selectSession(sessionFile);
}

// Sidebar actions use the same acknowledged selection as the chat controls.
// Keep the existing menu and inline editor while supplying its routing identity.
sidebar.startRename = async (itemEl) => {
  try {
    const selected = await switchSession(itemEl.dataset.filePath);
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    const currentName = titleEl.textContent;
    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let committing = false;
    const commit = async () => {
      if (committing) return;
      committing = true;
      const name = input.value.trim();
      let title = currentName;
      if (name && name !== currentName) {
        const result = await rpcCommand({
          type: 'set_session_name', name, sessionId: selected.sessionId,
        });
        if (result?.success) title = name;
      }
      const replacement = document.createElement('div');
      replacement.className = 'session-title';
      replacement.title = replacement.textContent = title;
      input.replaceWith(replacement);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  } catch (error) {
    if (error.name !== 'AbortError') messageRenderer.renderError(error.message);
  }
};

sidebar.exportSession = async (session) => {
  try {
    const selected = await switchSession(session.filePath);
    const result = await rpcCommand({ type: 'export_html', sessionId: selected.sessionId });
    if (!result?.success) throw new Error(result?.error || 'Export failed');
    if (result.data?.path) window.open(`/api/sessions/${encodeURIComponent(result.data.path)}`);
  } catch (error) {
    if (error.name !== 'AbortError') messageRenderer.renderError(error.message);
  }
};

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  invalidateRender();
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  isMirrorMode = true;
  sessionStatusRevision++;
  if (isRecording) {
    isRecording = false;
    recognition?.abort();
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
  }
  saveDraft();
  dialogHandler.clearCurrentDialog();
  pendingDialogRequests = [];
  closeModelDropdown();
  closeCommandPalette();
  closeSettings();
  contextViz.classList.add('hidden');
  agentCommands = [];
  state.reset();
  const session = state.selectSession(data.sessionFile, data.sessionId);
  session.isStreaming = !!data.isStreaming;
  session.awaitingPrompt = false;
  session.lastSentMessage = null;
  localStorage.setItem(selectedSessionKey, data.sessionFile);
  messageInput.value = session.draft;
  pendingImages = session.images;
  pendingFilePaths = session.filePaths;
  messageInput.dispatchEvent(new Event('input'));
  renderAttachmentPreviews();
  renderQueuedMessages();
  currentWorkspace = data.cwd || '';
  sidebar.setActive(data.sessionFile);
  currentStreamingElement = null;
  currentStreamingThinking = '';
  currentStreamingText = '';
  currentModelId = '';
  currentThinkingLevel = data.thinkingLevel || 'off';
  contextWindowSize = data.contextUsage?.contextWindow || 0;
  availableModels = [];

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  updateModelLabel();
  updateThinkingBtn();

  // Clear and render message history
  messageRenderer.clear();
  toolCardRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  hideCompactButton();

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else if (!data.streamingMessage && !data.toolExecutions?.length) {
    messageRenderer.renderWelcome();
  }

  if (data.streamingMessage) {
    const message = data.streamingMessage;
    currentStreamingText = getMessageText(message);
    currentStreamingThinking = Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('')
      : '';
    currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
    pendingMessagePaints.set(currentStreamingElement, {
      text: currentStreamingText,
      thinking: currentStreamingThinking,
    });
    scheduleRender();
    state.setStreamingMessage(message);
  }
  for (const tool of data.toolExecutions || []) {
    const execution = {
      ...tool,
      output: typeof tool.output === 'string' ? tool.output : formatToolOutput(tool.output),
    };
    state.addToolExecution(tool.toolCallId, execution);
    // Committed assistant entries may already contain this tool call.
    toolCardRenderer.updateToolCard(state.getToolExecution(tool.toolCallId));
    if (tool.status === 'complete' || tool.status === 'error') {
      toolCardRenderer.finalizeToolCard(tool.toolCallId, {
        content: [{ type: 'text', text: execution.output }],
      }, tool.isError);
    }
  }
  for (const request of data.pendingDialogs || []) {
    handleExtensionUIRequest({ ...request, sessionId: data.sessionId });
  }
  if (data.contextUsage?.tokens != null) lastInputTokens = data.contextUsage.tokens;
  state.setStreaming(session.isStreaming);
  showTypingIndicator(session.isStreaming);
  updateSessionStatus({ ...data, status: session.isStreaming ? 'working' : 'idle' }, false);
  if (data.sessionName) {
    document.querySelectorAll('.session-item.active .session-title').forEach(el => {
      el.textContent = data.sessionName;
    });
  }
  fileBrowser.currentPath = null;
  if (!fileSidebar.classList.contains('collapsed')) fileBrowser.load();
  fetchContextWindow();
  updateCostDisplay();
  updateTokenUsage();
  updateUI();
}

// Mark all live sessions in the sidebar with a green dot
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveSessions
    .filter(item => item.status !== 'closed' && item.status !== 'disconnected')
    .map(i => i.sessionFile));

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', liveFiles.has(el.dataset.filePath));
  });
}

function updateSessionStatus(data, flush = true) {
  if (!data.sessionId || !data.sessionFile) return;
  if (data.sessionId === wsClient.sessionId && data.epoch &&
      data.epoch !== wsClient.epoch && !wsClient.pendingSelection) {
    switchSession(data.sessionFile).catch(error => {
      if (error.name !== 'AbortError') messageRenderer.renderError(error.message);
    });
  }
  const index = liveSessions.findIndex(item => item.sessionFile === data.sessionFile);
  if (index < 0) liveSessions.push(data);
  else liveSessions[index] = { ...liveSessions[index], ...data };
  const session = state.getSession(data.sessionFile);
  if (session.sessionId !== data.sessionId) {
    session.sessionId = data.sessionId;
    session.awaitingPrompt = false;
    for (const cmd of session.queue) cmd.sessionId = data.sessionId;
  }
  session.status = data.status;
  session.isStreaming = !!data.isStreaming;
  if (data.isStreaming) session.awaitingPrompt = false;
  if ((data.status === 'closed' || data.status === 'disconnected') &&
      data.sessionId === wsClient.sessionId) {
    state.setStreaming(false);
    showTypingIndicator(false);
    updateUI();
  }
  updateMirrorLiveIndicator();
  if (flush &&
      (session !== state.getSession() || !state.isStreaming)) flushQueue(session);
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  const socket = wsClient.ws;
  const revision = sessionStatusRevision;
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      if (socket !== wsClient.ws || revision !== sessionStatusRevision) return;
      sessionStatusRevision++;
      liveSessions = data.sessions || [];
      for (const session of liveSessions) updateSessionStatus(session);
      updateMirrorLiveIndicator();
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text');
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === 'thinking');
      const toolCalls = (msg.content || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();

  // Jump to bottom instantly (no smooth scroll animation)
  const messagesEl = document.getElementById('messages');
  messagesEl.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle('hidden', !show);
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
  } else {
    tokenUsageEl.textContent = '';
    tokenUsageEl.classList.remove('visible', 'warning', 'critical');
    hideCompactButton();
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;
  const ready = canSend();

  if (!ready) {
    statusIndicator.classList.remove('streaming', 'connected');
    statusText.textContent = wsClient.isConnected ? 'Select a session' : 'Disconnected';
  } else if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = 'Working...';
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Connected';
  }

  messageInput.disabled = !ready;
  sendBtn.disabled = !ready;
  abortBtn.disabled = !ready;
  attachBtn.disabled = !ready;
  commandBtn.disabled = !ready;
  modelDropdownBtn.disabled = !ready;
  thinkingBtn.disabled = !ready;
  micBtn.disabled = !ready;
  messageInput.placeholder = ready ? 'Message...' : 'Select a connected session';
  document.querySelector('.input-area')?.classList.toggle('mirror-readonly', !ready);

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');


const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  const sessionId = wsClient.sessionId;
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await sessionRPC({ type: 'get_state' }, sessionId);
    const data = await resp.json();
    if (sessionId !== wsClient.sessionId) return;
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      currentThinkingLevel = s.thinkingLevel || 'off';
      updateThinkingBtn();
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const sessionId = wsClient.sessionId;
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (sessionId !== wsClient.sessionId) return;
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', !isOn);
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    if (!isRecording || !canSend()) return;
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    if (!canSend()) return;
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, move cost + token usage above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar');
  const sessionCost = document.getElementById('session-cost');
  const tokenUsage = document.getElementById('token-usage');
  if (mobileBar && sessionCost && tokenUsage) {
    mobileBar.appendChild(sessionCost);
    mobileBar.appendChild(tokenUsage);
  }

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle');
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

// Launcher
const launcherEl = document.getElementById('launcher');
const launcher = new Launcher(launcherEl, (projectPath) => {
  openWorkspaceDialog(projectPath);
});

// Check if launcher should show (projects configured)
async function initLauncher() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.projects && data.projects.length > 0) {
      launcher.projects = data.projects;
      launcher.render();
      // Show launcher by default, add a nav link in the sidebar
      addLauncherNav();
    }
  } catch {}
}

function addLauncherNav() {
  const modeToggle = document.getElementById('mode-toggle');
  if (!modeToggle || modeToggle.querySelector('.mode-link-launcher')) return;

  const launcherLink = document.createElement('span');
  launcherLink.className = 'mode-link mode-link-launcher';
  launcherLink.title = 'Projects';
  launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  launcherLink.addEventListener('click', () => {
    showLauncher();
  });
  modeToggle.appendChild(launcherLink);
}

function showLauncher() {
  launcherEl.classList.remove('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link-launcher')?.classList.add('active');

  launcher.load();
}

function hideLauncher() {
  launcherEl.classList.add('hidden');
  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

// Make the tau icon in sidebar switch back to chat
document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
  hideLauncher();
});

updateUI();
wsClient.connect();
messageRenderer.renderWelcome();
sidebar.loadSessions().then(() => {
  if (isMirrorMode) updateMirrorLiveIndicator();
});
initLauncher();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
