/**
 * Compact consecutive tool calls and thinking blocks, including live reasoning.
 * Keep the original nodes so streaming updates and card controls still work.
 */
const lazyGroups = new WeakMap();
const activityOwners = new WeakMap();

export function refreshActivityGroup(element) {
  const group = activityOwners.get(element) || element.closest('.activity-group');
  if (!group) return;
  const items = lazyGroups.get(group);
  const thinking = items ? items.filter(item => item.kind === 'thinking').length
    : group.querySelectorAll('.thinking-block').length;
  const tools = items ? items.filter(item => item.kind === 'tool').length
    : group.querySelectorAll('.tool-card').length;
  const running = items ? items.filter(item => ['pending', 'streaming'].includes(item.status)).length
    : group.querySelectorAll('.tool-status.pending, .tool-status.streaming').length;
  const errors = items ? items.filter(item => item.status === 'error').length
    : group.querySelectorAll('.tool-status.error').length;
  group.querySelector('.activity-thinking').textContent = thinking ? `Thinking ${thinking}` : '';
  group.querySelector('.activity-tools').textContent = tools ? `Tools ${tools}` : '';
  group.querySelector('.activity-status').textContent = [
    running ? `${running} running` : '',
    errors ? `${errors} error` : '',
  ].filter(Boolean).join(' · ');
  group.classList.toggle('has-tools', tools > 0);
  group.classList.toggle('has-errors', errors > 0);
}

export function mergeActivityGroups(first, second) {
  if (!first?.matches('.activity-group') || !second?.matches('.activity-group')) return;
  const earlier = lazyGroups.get(first);
  const later = lazyGroups.get(second);
  if (earlier && later) {
    later.unshift(...earlier);
    for (const item of earlier) {
      item.group = second;
      if (item.element) activityOwners.set(item.element, second);
      if (!second.open) item.unmount();
    }
    if (second.open) {
      const body = second.querySelector('.activity-items');
      for (const item of later) item.mount(body);
    }
    lazyGroups.delete(first);
    first.remove();
    refreshActivityGroup(second);
    return;
  }
  // Keep the newer group's nodes, focus and disclosure state when paging history.
  second.querySelector('.activity-items').prepend(...first.querySelector('.activity-items').children);
  first.remove();
  refreshActivityGroup(second);
}

function activityGroup(container, element) {
  let before = element?.parentElement === container ? element : null;
  let previous = before ? before.previousElementSibling : container.lastElementChild;
  while (previous?.matches('.message.assistant[hidden]')) {
    before = previous;
    previous = previous.previousElementSibling;
  }
  let group = previous?.matches('.activity-group') ? previous : null;
  if (!group) {
    group = document.createElement('details');
    group.className = 'activity-group';
    group.innerHTML = `
      <summary class="activity-summary">
        <svg class="activity-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        <span class="activity-title">Activity</span>
        <span class="activity-thinking"></span>
        <span class="activity-tools"></span>
        <span class="activity-status"></span>
      </summary>
      <div class="activity-items"></div>`;
    container.insertBefore(group, before);
  }
  return group;
}

export function appendLazyActivity(container, item) {
  const group = activityGroup(container, item.element);
  let items = lazyGroups.get(group);
  if (!items) {
    items = [];
    lazyGroups.set(group, items);
    group.dataset.lazyActivity = 'true';
    group.addEventListener('toggle', () => {
      const current = lazyGroups.get(group);
      if (!current) return;
      const body = group.querySelector('.activity-items');
      for (const entry of current) {
        if (group.open) entry.mount(body);
        else entry.unmount();
      }
    });
  }
  item.group = group;
  items.push(item);
  if (item.element) activityOwners.set(item.element, group);
  if (group.open) item.mount(group.querySelector('.activity-items'));
  refreshActivityGroup(group);
  if (group.nextElementSibling?.matches('.activity-group')) {
    mergeActivityGroups(group, group.nextElementSibling);
  }
  return item.group;
}

export function removeLazyActivity(item) {
  const group = item.group;
  const items = lazyGroups.get(group);
  if (!items) return;
  item.unmount();
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
  if (item.element) activityOwners.delete(item.element);
  if (!items.length) {
    lazyGroups.delete(group);
    group.remove();
  } else refreshActivityGroup(group);
}

export function appendActivity(container, element) {
  if (container.dataset.lazyActivity === 'true') {
    const item = {
      kind: element.matches('.thinking-block') ? 'thinking' : 'tool',
      status: '',
      element,
      mount(parent) { parent.appendChild(element); },
      unmount() { element.remove(); },
    };
    appendLazyActivity(container, item);
    if (!item.group.open) element.remove();
    return;
  }
  const group = activityGroup(container, element);
  group.querySelector('.activity-items').appendChild(element);
  refreshActivityGroup(group);
  if (group.nextElementSibling?.matches('.activity-group')) {
    mergeActivityGroups(group, group.nextElementSibling);
  }
}
