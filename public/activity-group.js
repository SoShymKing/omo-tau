/**
 * Compact consecutive tool calls and thinking blocks, including live reasoning.
 * Keep the original nodes so streaming updates and card controls still work.
 */
export function refreshActivityGroup(element) {
  const group = element.closest('.activity-group');
  if (!group) return;
  const thinking = group.querySelectorAll('.thinking-block').length;
  const tools = group.querySelectorAll('.tool-card').length;
  const running = group.querySelectorAll('.tool-status.pending, .tool-status.streaming').length;
  const errors = group.querySelectorAll('.tool-status.error').length;
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
  // Keep the newer group's nodes, focus and disclosure state when paging history.
  second.querySelector('.activity-items').prepend(...first.querySelector('.activity-items').children);
  first.remove();
  refreshActivityGroup(second);
}

export function appendActivity(container, element) {
  let before = element.parentElement === container ? element : null;
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
  group.querySelector('.activity-items').appendChild(element);
  refreshActivityGroup(group);
  if (group.nextElementSibling?.matches('.activity-group')) {
    mergeActivityGroups(group, group.nextElementSibling);
  }
}
