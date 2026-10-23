/**
 * Shared attachment presentation for messages and tool results.
 */

export function localFileUrl(value, sessionId, download = false) {
  if (!value || !sessionId) return null;
  let filePath = value;
  if (/^file:/i.test(filePath)) {
    try {
      const url = new URL(filePath);
      if (url.hostname && url.hostname !== 'localhost') return null;
      filePath = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      return null;
    }
  } else if (/^sandbox:\//i.test(filePath)) {
    filePath = filePath.slice('sandbox:'.length);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(filePath) && !/^[a-z]:[/\\]/i.test(filePath)) {
    return null;
  }
  if (/^(?:[/\\]{2}|#|\?)/.test(filePath)) return null;
  const query = new URLSearchParams({ sessionId, path: filePath });
  if (download) query.set('download', '1');
  return `/api/file?${query}`;
}

function filename(value) {
  return value.split(/[/\\]/).pop()?.split(/[?#]/)[0] || 'image.png';
}

function imageSource(block) {
  const source = block.source || block;
  const mime = source.media_type || source.mimeType || block.mimeType || 'image/png';
  if (source.data && /^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(mime)) {
    return source.data.startsWith('data:') ? source.data : `data:${mime};base64,${source.data}`;
  }
  return source.url || block.url || '';
}

export function appendAttachments(container, blocks, sessionId) {
  for (const block of blocks || []) {
    if (block.type === 'image' || (!block.type && block.data)) {
      const src = imageSource(block);
      if (!src) continue;
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = src;
      image.alt = block.name || block.filename || 'Attached image';
      container.appendChild(image);
    } else if (block.type === 'file' || block.type === 'resource_link') {
      const value = block.path || block.url || block.uri;
      const url = localFileUrl(value, sessionId);
      if (!url) continue;
      const link = document.createElement('a');
      link.href = value;
      link.textContent = block.name || block.filename || filename(value);
      container.appendChild(link);
    }
  }
  enhanceAttachments(container, sessionId);
}

function downloadLink(url, name) {
  const link = document.createElement('a');
  link.className = 'attachment-action';
  link.href = url;
  link.download = name;
  link.textContent = 'Download';
  link.setAttribute('aria-label', `Download ${name}`);
  return link;
}

function showImage(src, name, downloadUrl) {
  const dialog = document.createElement('dialog');
  dialog.className = 'attachment-viewer';
  dialog.setAttribute('aria-label', name);
  const header = document.createElement('div');
  header.className = 'attachment-viewer-header';
  const title = document.createElement('span');
  title.textContent = name;
  const close = document.createElement('button');
  close.className = 'attachment-action';
  close.textContent = 'Close';
  close.autofocus = true;
  close.addEventListener('click', () => dialog.close());
  header.append(title, downloadLink(downloadUrl, name), close);
  const status = document.createElement('p');
  status.className = 'attachment-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading image...';
  const image = document.createElement('img');
  image.alt = name;
  image.addEventListener('load', () => { status.hidden = true; });
  image.addEventListener('error', () => { status.textContent = 'Image could not be loaded.'; });
  dialog.append(header, status, image);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  image.src = src;
}

export function enhanceAttachments(container, sessionId) {
  for (const image of container.querySelectorAll('img:not([data-attachment])')) {
    const original = image.getAttribute('src');
    const src = localFileUrl(original, sessionId) || original;
    if (!src || !/^(?:\/api\/file\?|https?:|data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,)/i.test(src)) {
      image.remove();
      continue;
    }
    const name = image.alt && image.alt !== 'Attached image' ? image.alt
      : original.startsWith('data:') ? 'image.png' : filename(original);
    const downloadUrl = localFileUrl(original, sessionId, true) || src;
    image.dataset.attachment = '';
    image.src = src;
    image.loading = 'lazy';
    const wrapper = document.createElement('span');
    wrapper.className = 'chat-attachment attachment-image';
    const open = document.createElement('button');
    open.className = 'attachment-thumbnail';
    open.type = 'button';
    open.setAttribute('aria-label', `View ${name}`);
    open.addEventListener('click', () => {
      open.focus();
      showImage(src, name, downloadUrl);
    });
    image.replaceWith(wrapper);
    open.appendChild(image);
    wrapper.append(open, downloadLink(downloadUrl, name));
  }
  for (const link of container.querySelectorAll('a:not(.attachment-action):not([data-attachment])')) {
    const original = link.getAttribute('href');
    const url = localFileUrl(original, sessionId);
    if (!url) continue;
    const name = filename(original);
    const wrapper = document.createElement('span');
    wrapper.className = 'chat-attachment attachment-file';
    link.dataset.attachment = '';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.classList.add('attachment-action');
    link.setAttribute('aria-label', `Open ${link.textContent || name}`);
    link.replaceWith(wrapper);
    wrapper.append(link, downloadLink(localFileUrl(original, sessionId, true), name));
  }
}
