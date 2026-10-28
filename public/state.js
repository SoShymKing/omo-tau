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
    this.todoState = null;
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
        streamStats: { count: 0, lastReceivedAt: null },
        questions: new Map(), questionControl: { supported: false },
        questionRoute: null, questionsReady: false,
        todoExpanded: false,
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

  replaceQuestions(snapshot) {
    const session = this.getSession(snapshot.sessionFile);
    const questions = new Map();
    for (const question of snapshot.pendingQuestions || []) {
      const previous = session.questions.get(question.requestId);
      questions.set(question.requestId, {
        question: structuredClone(question),
        draft: previous?.draft || { answers: {}, comment: '' },
        status: 'pending', error: null, submission: null,
      });
    }
    session.questions = questions;
    session.questionControl = { supported: snapshot.questionControl?.supported === true };
    session.questionRoute = { sessionId: snapshot.sessionId, epoch: snapshot.epoch };
    session.questionsReady = true;
    this.notifyListeners();
  }

  applyQuestionEvent(route, event) {
    const session = this.sessions.get(route.sessionFile);
    if (!session?.questionsReady || session.sessionId !== route.sessionId ||
        session.questionRoute?.sessionId !== route.sessionId ||
        session.questionRoute.epoch !== route.epoch) return false;
    if (event.type === 'question_opened') {
      const previous = session.questions.get(event.question.requestId);
      session.questions.set(event.question.requestId, {
        question: structuredClone(event.question),
        draft: previous?.draft || { answers: {}, comment: '' },
        status: previous?.status || 'pending',
        error: previous?.error || null,
        submission: previous?.submission || null,
      });
    } else if (event.type === 'question_resolved') {
      if (!session.questions.delete(event.requestId)) return false;
    } else {
      return false;
    }
    this.notifyListeners();
    return true;
  }

  setQuestionDraft(sessionFile, requestId, updates) {
    const entry = this.sessions.get(sessionFile)?.questions.get(requestId);
    if (!entry) return false;
    entry.draft = { ...entry.draft, ...structuredClone(updates) };
    this.notifyListeners();
    return true;
  }

  beginQuestionSubmission(sessionFile, requestId, route, cancelled = false) {
    const session = this.sessions.get(sessionFile);
    const entry = session?.questions.get(requestId);
    if (!entry || entry.status === 'submitting' || !session.questionsReady ||
        !session.questionControl.supported || !route.id ||
        session.sessionId !== route.sessionId ||
        session.questionRoute?.sessionId !== route.sessionId ||
        session.questionRoute.epoch !== route.epoch) return null;
    const command = {
      type: 'answer_question', id: route.id, sessionId: route.sessionId,
      epoch: route.epoch, requestId,
      answers: structuredClone(entry.draft.answers),
      comment: entry.draft.comment, cancelled,
    };
    entry.submission = { ...structuredClone(command), sessionFile };
    entry.status = 'submitting';
    entry.error = null;
    this.notifyListeners();
    return command;
  }

  failQuestionSubmission(command, error = 'send_failed') {
    return this.handleQuestionResponse({
      ...command, command: 'answer_question', success: false, error,
    });
  }

  handleQuestionResponse(response) {
    if (response.command !== 'answer_question') return false;
    for (const session of this.sessions.values()) {
      for (const [requestId, entry] of session.questions) {
        const submission = entry.submission;
        if (!submission || submission.id !== response.id ||
            submission.sessionId !== response.sessionId ||
            session.sessionId !== submission.sessionId ||
            session.questionRoute?.sessionId !== submission.sessionId ||
            session.questionRoute.epoch !== submission.epoch ||
            (response.epoch !== undefined && response.epoch !== submission.epoch)) continue;
        if (response.success === true) {
          session.questions.delete(requestId);
        } else if (response.success === false) {
          entry.status = 'failed';
          entry.error = response.error || 'answer_refused';
          entry.submission = null;
        } else {
          return false;
        }
        this.notifyListeners();
        return true;
      }
    }
    return false;
  }

  disconnectQuestions() {
    for (const session of this.sessions.values()) {
      session.questionsReady = false;
      for (const entry of session.questions.values()) {
        if (entry.status !== 'submitting') continue;
        entry.status = 'failed';
        entry.error = 'disconnected';
        entry.submission = null;
      }
    }
    this.notifyListeners();
  }

  reset() {
    this.todoState = null;
    this.messages = [];
    this.toolExecutions.clear();
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }
}
