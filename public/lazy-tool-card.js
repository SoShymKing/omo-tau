import { ToolCardRenderer } from './tool-card.js';
import { appendLazyActivity, removeLazyActivity, refreshActivityGroup } from './activity-group.js';
import { appendAttachments } from './attachments.js';

const detailKey = data => JSON.stringify([data.callRef, data.resultRef, data.liveRef, data.revision]);
const statusRank = { unknown: 0, pending: 1, streaming: 2, complete: 3, error: 3 };

export class LazyToolCardRenderer extends ToolCardRenderer {
  constructor(container, requestScroll, getSessionId, detailClient) {
    super(container, requestScroll, getSessionId);
    this.detailClient = detailClient;
  }

  createHistoryCard(summary) { return this.updateToolCard(summary); }
  createToolCard(summary) { return this.updateToolCard(summary); }

  updateToolCard(summary) {
    let model = this.toolCards.get(summary.toolCallId);
    if (!model) {
      model = { kind: 'tool', dataset: { toolCallId: summary.toolCallId }, status: 'unknown',
        data: { toolCallId: summary.toolCallId, toolName: 'Tool', revision: 0 },
        expanded: false, node: null, body: null, request: null, group: null,
        mount: parent => this.mount(model, parent),
        unmount: () => {
          this.setExpanded(model, false);
          model.actions?.abort();
          model.node?.remove();
          model.node = null;
          model.expandOnMount = false;
        } };
      this.toolCards.set(summary.toolCallId, model);
    }
    for (const [key, value] of Object.entries(summary)) {
      if (value != null && key !== 'status' && key !== 'revision') model.data[key] = value;
    }
    model.data.revision = Math.max(model.data.revision, summary.revision ?? 0);
    if (statusRank[summary.status] >= statusRank[model.status]) model.status = summary.status;
    model.data.status = model.status;
    if (!model.group) appendLazyActivity(this.container, model);
    this.updateHeader(model);
    refreshActivityGroup(model.group);
    if (model.expanded) this.load(model);
    return model;
  }

  addHistoryResult(id, result, isError) {
    return this.updateToolCard({ ...result.tool, toolCallId: id,
      status: isError ? 'error' : result.tool.status ?? 'complete' });
  }

  finalizeToolCard(id, result, isError) { return this.addHistoryResult(id, result, isError); }

  mount(model, parent) {
    if (model.node) { parent.append(model.node); return; }
    const node = document.createElement('div');
    node.className = 'tool-card';
    Object.assign(node.dataset, model.dataset);
    const header = document.createElement('div');
    header.className = 'tool-card-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-header-left tool-card-toggle';
    toggle.style.cssText = 'min-height:44px;min-width:44px;flex:1;background:none;border:0;color:inherit;text-align:left;font:inherit;cursor:pointer';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => this.setExpanded(model, !model.expanded));
    const name = document.createElement('span');
    name.className = 'tool-name';
    const preview = document.createElement('span');
    preview.className = 'tool-args-preview';
    toggle.append(name, preview);
    const right = document.createElement('div');
    right.className = 'tool-header-right';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'tool-action-btn copy-output-btn';
    copy.textContent = 'Copy output';
    copy.style.minHeight = '44px';
    copy.addEventListener('click', () => this.action(model, copy, 'copy'));
    const status = document.createElement('span');
    status.className = 'tool-status';
    right.append(copy, status);
    header.append(toggle, right);
    node.append(header);
    model.node = node;
    model.actions = new AbortController();
    this.updateHeader(model);
    parent.append(node);
    if (model.expandOnMount) this.setExpanded(model, true);
  }

  updateHeader(model) {
    if (!model.node) return;
    model.node.querySelector('.tool-name').textContent = model.data.toolName;
    model.node.querySelector('.tool-args-preview').textContent = model.data.preview ?? '';
    const status = model.node.querySelector('.tool-status');
    status.className = `tool-status ${model.status}`;
    status.textContent = model.status;
  }

  setExpanded(model, expanded) {
    model.expanded = expanded;
    model.node?.querySelector('.tool-card-toggle').setAttribute('aria-expanded', String(expanded));
    if (!expanded) {
      model.request?.controller.abort();
      model.request = null;
      model.body?.remove();
      model.body = null;
      model.loadedKey = null;
      return;
    }
    if (!model.node || model.body) return;
    model.body = document.createElement('div');
    model.body.className = 'tool-card-body expanded';
    model.node.append(model.body);
    this.load(model);
  }

  async load(model) {
    if (model.request || !model.body) return;
    const key = detailKey(model.data);
    if (model.loadedKey === key) return;
    const request = { key, controller: new AbortController() };
    model.request = request;
    const body = model.body;
    body.textContent = 'Loading tool details...';
    try {
      const detail = await this.detailClient.view(model.data, request.controller.signal);
      if (model.request !== request || request.controller.signal.aborted || key !== detailKey(model.data)) return;
      this.renderDetails(model, detail);
      model.loadedKey = key;
    } catch (error) {
      if (model.request !== request || request.controller.signal.aborted || error.name === 'AbortError') return;
      body.textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this.load(model));
      body.append(retry);
    } finally {
      if (model.request === request) {
        model.request = null;
        if (model.expanded && key !== detailKey(model.data)) this.load(model);
      }
    }
  }

  renderDetails(model, detail) {
    const body = model.body;
    body.replaceChildren();
    const oldText = detail.args?.oldText ?? detail.args?.old_text;
    const newText = detail.args?.newText ?? detail.args?.new_text;
    if (/^edit$/i.test(model.data.toolName) && !detail.argsTruncated &&
        typeof oldText === 'string' && typeof newText === 'string') {
      body.append(this.renderDiff(oldText, newText));
    } else if (detail.argsText) {
      const args = document.createElement('div');
      args.className = 'tool-args';
      args.textContent = detail.argsText;
      body.append(args);
    }
    const output = document.createElement('div');
    output.className = `tool-output${detail.isError ? ' error' : ''}`;
    output.textContent = detail.output;
    body.append(output);
    if (detail.argsTruncated || detail.outputTruncated) {
      const notice = document.createElement('p');
      notice.className = 'tool-detail-truncation';
      notice.textContent = 'Preview truncated. Copy output or download arguments for the full content.';
      body.append(notice);
    }
    if (detail.argsTruncated) {
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'attachment-action';
      download.textContent = 'Download arguments';
      download.addEventListener('click', () => this.action(model, download, 'args'));
      body.append(download);
    }
    for (const [index, attachment] of detail.attachments.entries()) {
      if (attachment.path || attachment.url || attachment.uri) {
        appendAttachments(body, [attachment], this.getSessionId());
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'attachment-action';
      button.textContent = `Download ${attachment.name ?? `attachment ${index + 1}`}`;
      button.addEventListener('click', () => this.action(model, button, {
        index: attachment.index ?? index, name: attachment.name ?? `attachment-${index + 1}`,
      }));
      body.append(button);
    }
  }

  async action(model, button, mode) {
    const signal = model.actions.signal;
    button.disabled = true;
    const label = button.textContent;
    try {
      if (mode === 'copy') {
        const text = await this.detailClient.copy(model.data, signal);
        signal.throwIfAborted();
        if (navigator.clipboard) await navigator.clipboard.writeText(text);
        else {
          const field = document.createElement('textarea');
          field.value = text;
          field.style.cssText = 'position:fixed;left:-9999px';
          document.body.append(field);
          field.select();
          try {
            if (!document.execCommand('copy')) throw new Error('Copy is unavailable in this browser');
          } finally {
            field.remove();
          }
        }
      } else {
        const blob = mode === 'args'
          ? new Blob([await this.detailClient.args(model.data, signal)], { type: 'application/json' })
          : await this.detailClient.attachment(model.data, mode.index, signal);
        signal.throwIfAborted();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = mode === 'args' ? 'arguments.json' : mode.name;
        link.click();
        URL.revokeObjectURL(url);
      }
      if (!signal.aborted) button.textContent = mode === 'copy' ? 'Copied' : label;
    } catch (error) {
      if (!signal.aborted && error.name !== 'AbortError') button.textContent = `${label}: ${error.message}. Retry`;
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  }

  expandAll() {
    for (const model of this.toolCards.values()) {
      model.expandOnMount = true;
      model.group.open = true;
      if (model.node) this.setExpanded(model, true);
    }
  }

  collapseAll() {
    for (const model of this.toolCards.values()) {
      model.expandOnMount = false;
      this.setExpanded(model, false);
      model.group.open = false;
    }
  }

  captureDisclosure() {
    return new Map([...this.toolCards].map(([id, model]) => [id,
      { activityOpen: model.group.open, expanded: model.expanded }]));
  }

  restoreDisclosure(disclosure) {
    const groups = new Map();
    for (const [id, model] of this.toolCards) {
      const saved = disclosure.get(id);
      model.expandOnMount = Boolean(saved?.activityOpen && saved.expanded);
      groups.set(model.group, groups.get(model.group) || Boolean(saved?.activityOpen));
      if (model.node) this.setExpanded(model, model.expandOnMount);
    }
    for (const [group, open] of groups) group.open = open;
  }

  clear() {
    this.detailClient.cancelAll();
    for (const model of this.toolCards.values()) {
      model.unmount();
      removeLazyActivity(model);
    }
    this.toolCards.clear();
    this.historyResults.clear();
  }
}
