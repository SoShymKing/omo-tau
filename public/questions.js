/**
 * Nonmodal question forms. State and transport are owned by the application.
 */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function buildQuestionResponse(request, draft) {
  const answers = {};
  for (const question of request.questions) {
    const answer = draft.answers?.[question.id];
    if (!answer) continue;
    const selected = (answer.selected || []).filter(label => label !== '');
    const text = answer.text;
    if (!selected.length && !text?.trim()) continue;
    answers[question.id] = {
      selected,
      ...(text?.trim() ? { text } : {}),
    };
  }
  return {
    answers,
    ...(draft.comment?.trim() ? { comment: draft.comment } : {}),
  };
}

export class QuestionPanel {
  constructor(container, { onDraft, onSubmit }) {
    this.container = container;
    this.onDraft = onDraft;
    this.onSubmit = onSubmit;
    this.forms = new Map();
    this.serial = 0;
    this.collapsed = false;
    container.classList.add('question-panel');
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Agent questions');
    this.header = element('div', 'question-panel-header');
    this.toggle = element('button', 'question-panel-toggle');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-controls', 'question-panel-body');
    this.summary = element('span');
    this.toggleLabel = element('span', 'question-toggle-label');
    this.toggle.append(this.summary, this.toggleLabel);
    this.header.append(this.toggle);
    this.body = element('div', 'question-panel-body');
    this.body.id = 'question-panel-body';
    this.notice = element('p', 'question-notice');
    this.notice.setAttribute('role', 'status');
    this.body.append(this.notice);
    container.append(this.header, this.body);
    this.toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.updateCollapse();
    });
    container.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.stopPropagation();
        if (event.key === 'Enter' && event.target.matches('input, textarea')) {
          // Textareas retain native newlines; no implicit form submission.
          if (event.target.tagName !== 'TEXTAREA') event.preventDefault();
        }
      }
    });
  }

  updateCollapse() {
    this.body.hidden = this.collapsed;
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    this.toggleLabel.textContent = this.collapsed ? 'Expand' : 'Collapse';
  }

  render({ sessionFile, requests, supported, connected, ready }) {
    if (this.sessionFile !== sessionFile) {
      const previous = [...this.forms.values()];
      this.forms.clear();
      this.sessionFile = sessionFile;
      // Detaching a focused field can synchronously save on change/blur.
      // Release its view ownership before that callback can render again.
      for (const form of previous) form.node.remove();
    }
    this.container.hidden = !sessionFile || (supported && requests.length === 0);
    this.summary.textContent = requests.length
      ? `${requests.length} pending question${requests.length === 1 ? '' : 's'}`
      : 'Questions unavailable';
    this.notice.textContent = !supported
      ? 'This session does not support question forms. Ordinary chat is still available.'
      : !connected ? 'Offline. Your answers are kept. Reconnect before submitting.'
        : !ready ? 'Waiting for the session to reconnect. Your answers are kept.'
          : 'Answer any questions, or leave a comment. Chat remains available.';
    const pending = new Set(requests.map(entry => entry.question.requestId));
    for (const [id, form] of this.forms) {
      if (!pending.has(id)) {
        form.node.remove();
        this.forms.delete(id);
      }
    }
    for (const entry of requests) {
      const id = entry.question.requestId;
      let form = this.forms.get(id);
      if (!form) {
        form = this.createForm(entry, sessionFile);
        this.forms.set(id, form);
        this.body.append(form.node);
      }
      form.entry = entry;
      const busy = entry.status === 'submitting';
      const disabled = busy || !supported || !connected || !ready;
      form.node.setAttribute('aria-busy', String(busy));
      form.fields.disabled = busy;
      form.submit.disabled = disabled;
      form.cancel.disabled = disabled;
      form.submit.textContent = busy ? 'Submitting...' : 'Submit';
      form.status.textContent = entry.error || form.localError ||
        (busy ? 'Submitting your response...' : '');
      form.status.setAttribute('role', entry.error || form.localError ? 'alert' : 'status');
    }
    this.updateCollapse();
  }

  createForm(entry, sessionFile) {
    const request = entry.question;
    const prefix = `question-${++this.serial}`;
    const form = {
      node: element('form', 'question-request'),
      fields: element('fieldset', 'question-fields'),
      status: element('p', 'question-request-status'),
      submit: element('button', 'question-submit', 'Submit'),
      cancel: element('button', 'question-cancel', 'Cancel'),
      entry,
      localError: '',
    };
    const title = element('legend', 'question-request-title',
      request.waitForAnswer ? 'Your input is needed' : 'A question for you');
    form.fields.append(title);
    const controls = [];
    request.questions.forEach((question, index) => {
      const group = element('fieldset', 'question-group');
      group.append(element('legend', 'question-label', question.header));
      const prompt = element('p', 'question-prompt', question.question);
      prompt.id = `${prefix}-${index}-prompt`;
      group.setAttribute('aria-describedby', prompt.id);
      group.append(prompt);
      const choices = [];
      question.options.forEach((option, optionIndex) => {
        const label = element('label', 'question-option');
        const input = element('input');
        input.type = question.multiSelect ? 'checkbox' : 'radio';
        input.name = `${prefix}-${index}`;
        input.value = option.label;
        input.checked = !!entry.draft.answers?.[question.id]?.selected?.includes(option.label);
        const copy = element('span', 'question-option-copy');
        const optionLabel = element('span', 'question-option-label', option.label);
        optionLabel.id = `${prefix}-${index}-${optionIndex}-label`;
        input.setAttribute('aria-labelledby', optionLabel.id);
        copy.append(optionLabel);
        if (option.description) {
          const description = element('span', 'question-description', option.description);
          description.id = `${prefix}-${index}-${optionIndex}-description`;
          input.setAttribute('aria-describedby', description.id);
          copy.append(description);
        }
        label.append(input, copy);
        group.append(label);
        choices.push(input);
      });
      const textLabel = element('label', 'question-text-label', 'Your own answer (optional)');
      const text = element('textarea', 'question-text');
      text.id = `${prefix}-${index}-text`;
      text.rows = 2;
      text.value = entry.draft.answers?.[question.id]?.text || '';
      textLabel.htmlFor = text.id;
      group.append(textLabel, text);
      form.fields.append(group);
      controls.push({ question, choices, text });
    });
    const commentLabel = element('label', 'question-text-label', 'Comment (optional)');
    const comment = element('textarea', 'question-text');
    comment.id = `${prefix}-comment`;
    comment.rows = 2;
    comment.value = entry.draft.comment || '';
    commentLabel.htmlFor = comment.id;
    form.fields.append(commentLabel, comment);
    const readDraft = () => {
      const answers = {};
      for (const { question, choices, text } of controls) {
        const selected = choices.filter(input => input.checked).map(input => input.value);
        if (selected.length || text.value) answers[question.id] = { selected, text: text.value };
      }
      return { answers, comment: comment.value };
    };
    const save = () => {
      form.localError = '';
      this.onDraft({ sessionFile, requestId: request.requestId, draft: readDraft() });
    };
    form.fields.addEventListener('input', save);
    form.fields.addEventListener('change', save);
    form.submit.type = 'submit';
    form.cancel.type = 'button';
    form.status.setAttribute('aria-live', 'polite');
    const actions = element('div', 'question-actions');
    actions.append(form.cancel, form.submit);
    form.node.append(form.fields, form.status, actions);
    form.node.addEventListener('submit', event => {
      event.preventDefault();
      const response = buildQuestionResponse(request, readDraft());
      if (!Object.keys(response.answers).length && !response.comment) {
        form.localError = 'Choose an option, type an answer, or leave a comment before submitting.';
        form.status.textContent = form.localError;
        form.status.setAttribute('role', 'alert');
        return;
      }
      this.onSubmit({ sessionFile, requestId: request.requestId, ...response, cancelled: false });
    });
    form.cancel.addEventListener('click', () => {
      this.onSubmit({ sessionFile, requestId: request.requestId, answers: {}, cancelled: true });
    });
    return form;
  }
}
