/**
 * State Manager - Manages chat state
 */

export class StateManager {
  constructor() {
    this.messages = [];
    this.toolExecutions = new Map(); // toolCallId -> tool execution data
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.listeners = new Set();
    this.sessions = new Map(); // Durable file paths own drafts and unsent prompts.
    this.sessionFile = null;
  }

  addListener(callback) {
    this.listeners.add(callback);
  }

  removeListener(callback) {
    this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback());
  }

  addMessage(message) {
    this.messages.push(message);
    this.notifyListeners();
  }

  updateLastMessage(updates) {
    if (this.messages.length > 0) {
      const lastMessage = this.messages[this.messages.length - 1];
      Object.assign(lastMessage, updates);
      this.notifyListeners();
    }
  }

  setStreamingMessage(message) {
    this.currentStreamingMessage = message;
    this.notifyListeners();
  }

  clearStreamingMessage() {
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }

  setStreaming(isStreaming) {
    this.isStreaming = isStreaming;
    this.notifyListeners();
  }

  addToolExecution(toolCallId, data) {
    this.toolExecutions.set(toolCallId, {
      toolCallId,
      toolName: data.toolName,
      args: data.args,
      status: 'pending',
      output: '',
      isError: false,
      ...data
    });
    this.notifyListeners();
  }

  updateToolExecution(toolCallId, updates) {
    const tool = this.toolExecutions.get(toolCallId);
    if (tool) {
      Object.assign(tool, updates);
      this.notifyListeners();
    }
  }

  getToolExecution(toolCallId) {
    return this.toolExecutions.get(toolCallId);
  }

  getAllToolExecutions() {
    return Array.from(this.toolExecutions.values());
  }

  getSession(sessionFile = this.sessionFile) {
    if (!sessionFile) return null;
    if (!this.sessions.has(sessionFile)) {
      this.sessions.set(sessionFile, {
        sessionFile, sessionId: null, draft: '', images: [], filePaths: [],
        queue: [], status: 'ready', isStreaming: false, awaitingPrompt: false, lastSentMessage: null,
      });
    }
    return this.sessions.get(sessionFile);
  }

  selectSession(sessionFile, sessionId) {
    this.sessionFile = sessionFile;
    const session = this.getSession();
    session.sessionId = sessionId;
    // Unsent prompts survive a gateway restart; sent mutations never replay.
    for (const command of session.queue) command.sessionId = sessionId;
    return session;
  }

  reset() {
    this.messages = [];
    this.toolExecutions.clear();
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }
}
