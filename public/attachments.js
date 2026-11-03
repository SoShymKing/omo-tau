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
      if (!url) {
        if (!sessionId) {
          const label = document.createElement('span');
          label.className = 'attachment-status';
          label.textContent = block.name || block.filename || (value ? filename(value) : 'File');
          label.title = 'Available when the session is ready';
          container.appendChild(label);
        }
        continue;
      }
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

function createViewer(name, downloadUrl) {
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
  dialog.append(header, status);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  return { dialog, status };
}

function previewImage(dialog, status, src, name) {
  status.textContent = 'Loading image...';
  const image = document.createElement('img');
  image.alt = name;
  image.addEventListener('load', () => { status.hidden = true; });
  image.addEventListener('error', () => { status.textContent = 'Image could not be loaded.'; });
  dialog.appendChild(image);
  image.src = src;
}

async function showFile(url, name, downloadUrl) {
  const { dialog, status } = createViewer(name, downloadUrl);
  const controller = new AbortController();
  dialog.addEventListener('close', () => controller.abort(), { once: true });
  status.textContent = 'Loading file details...';
  try {
    const metadata = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (!metadata.ok) throw new Error(`File could not be loaded (${metadata.status}).`);
    if (!dialog.open) return;
    const size = Number(metadata.headers.get('content-length'));
    const type = metadata.headers.get('content-type')?.split(';')[0] || '';
    const details = document.createElement('p');
    details.className = 'attachment-file-details';
    details.textContent = `${Number.isFinite(size) ? `${size.toLocaleString()} bytes` : 'Size unavailable'} · ${type || 'File'}`;
    status.before(details);
    if (/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(type)) {
      previewImage(dialog, status, url, name);
    } else if (type === 'application/pdf') {
      const preview = document.createElement('iframe');
      preview.className = 'attachment-document';
      preview.title = name;
      preview.src = url;
      dialog.appendChild(preview);
      status.textContent = 'PDF preview. If it cannot be displayed, use Download.';
    } else if (type === 'text/plain' && size <= 1024 * 1024) {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`File could not be loaded (${response.status}).`);
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 1024 * 1024) {
          await reader.cancel();
          throw new Error('This file is too large to preview. Use Download.');
        }
        chunks.push(value);
      }
      if (!dialog.open) return;
      const preview = document.createElement('pre');
      preview.className = 'attachment-text-preview';
      preview.textContent = await new Blob(chunks).text();
      dialog.appendChild(preview);
      status.hidden = true;
    } else {
      status.textContent = 'Preview is not available for this file. Use Download.';
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    status.textContent = error instanceof Error ? error.message : 'File could not be loaded.';
    status.setAttribute('role', 'alert');
  }
}

export function enhanceAttachments(container, sessionId) {
  let list = container.querySelector(':scope > .attachment-list');
  function addAttachment(element, attachment) {
    if (!list) {
      list = document.createElement('div');
      list.className = 'attachment-list';
      list.setAttribute('aria-label', 'Attachments');
      container.prepend(list);
    }
    const parent = element.parentElement;
    element.replaceWith(attachment);
    list.appendChild(attachment);
    if (parent?.tagName === 'P' && !parent.textContent.trim() && !parent.children.length) parent.remove();
  }
  const elements = container.querySelectorAll('img:not([data-attachment]), a:not(.attachment-action):not([data-attachment])');
  for (const element of elements) {
    if (element.tagName === 'A') {
      const original = element.getAttribute('href');
      const url = localFileUrl(original, sessionId);
      if (!sessionId && original && !/^(?:https?:|mailto:|tel:|#|\?)/i.test(original)) {
        const label = document.createElement('span');
        label.textContent = element.textContent;
        label.title = 'Available when the session is ready';
        element.replaceWith(label);
        continue;
      }
      if (!url) continue;
      const name = filename(original);
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-attachment attachment-file';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'attachment-action';
      open.textContent = element.textContent || name;
      open.setAttribute('aria-label', `Open ${open.textContent}`);
      open.addEventListener('click', () => {
        open.focus();
        void showFile(url, name, localFileUrl(original, sessionId, true));
      });
      wrapper.appendChild(open);
      addAttachment(element, wrapper);
      continue;
    }
    const image = element;
    const original = image.getAttribute('src');
    const src = localFileUrl(original, sessionId) || original;
    if (!src || !/^(?:\/api\/file\?|https?:|data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,)/i.test(src)) {
      if (!sessionId) {
        const label = document.createElement('span');
        label.className = 'attachment-status';
        label.textContent = image.alt || (original ? filename(original) : 'Image');
        label.title = 'Available when the session is ready';
        image.replaceWith(label);
      } else image.remove();
      continue;
    }
    const name = image.alt && image.alt !== 'Attached image' ? image.alt
      : original.startsWith('data:') ? 'image.png' : filename(original);
    const downloadUrl = localFileUrl(original, sessionId, true) || src;
    image.dataset.attachment = '';
    image.src = src;
    image.loading = 'lazy';
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-attachment attachment-image';
    const open = document.createElement('button');
    open.className = 'attachment-thumbnail';
    open.type = 'button';
    open.setAttribute('aria-label', `View ${name}`);
    open.addEventListener('click', () => {
      open.focus();
      const { dialog, status } = createViewer(name, downloadUrl);
      previewImage(dialog, status, src, name);
    });
    addAttachment(image, wrapper);
    open.appendChild(image);
    wrapper.appendChild(open);
  }
}
