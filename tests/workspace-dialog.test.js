import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createStreamingGateway } from './fixtures/streaming-gateway.js';

describe('workspace dialog in the real application', () => {
  let gateway;
  let view;
  const evaluate = script => view.evaluate(`(${script.toString()})()`);

  function directories(request) {
    const path = new URL(request.url).searchParams.get('path') || '/workspace';
    return Response.json({
      path,
      parentPath: path === '/workspace/child' ? '/workspace' : '/',
      items: path === '/workspace/child' ? [] : [{ name: 'child', path: '/workspace/child' }],
    });
  }

  async function open(width, touch) {
    view = new Bun.WebView({ width, height: 844 });
    await view.navigate('about:blank');
    await view.cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: touch,
    });
    await view.cdp('Emulation.setTouchEmulationEnabled', {
      enabled: touch, maxTouchPoints: touch ? 5 : 1,
    });
    await view.navigate(gateway.server.url.href);
    await evaluate(() => new Promise((resolve, reject) => {
      const input = document.getElementById('message-input');
      if (!input.disabled) { resolve(); return; }
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Session selection missing'));
      }, 3000);
      const observer = new MutationObserver(() => {
        if (input.disabled) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(input, { attributes: true, attributeFilter: ['disabled'] });
    }));
    expect(await evaluate(() =>
      matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(touch);
    await evaluate(() => {
      document.getElementById('sidebar').classList.remove('collapsed');
      window.qaEditableFocus = [];
      document.addEventListener('focusin', event => {
        if (event.target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]')) {
          qaEditableFocus.push(event.target.id);
        }
      });
    });
    await view.click('#new-session-btn');
    await listed();
  }

  async function listed(path = null) {
    await view.evaluate(`window.qaExpectedPath = ${JSON.stringify(path)}`);
    await evaluate(() => new Promise((resolve, reject) => {
      const list = document.getElementById('workspace-directory-list');
      const ready = () => list.firstElementChild
        && (!qaExpectedPath || document.getElementById('workspace-preview-path').textContent === qaExpectedPath)
        && document.getElementById('workspace-preview-status').textContent !== 'Loading folders...';
      if (ready()) { resolve(); return; }
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Directory preview missing'));
      }, 3000);
      const observer = new MutationObserver(() => {
        if (!ready()) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(document.getElementById('workspace-dialog'), {
        childList: true, subtree: true,
      });
    }));
  }

  const focusedPath = () => evaluate(() =>
    document.activeElement === document.getElementById('workspace-directory'));

  beforeAll(async () => {
    gateway = await createStreamingGateway({
      filesHandler: directories,
      newSessionHandler: () => Response.json({ error: 'fixture-create-failure' }, { status: 503 }),
    });
  });
  afterEach(async () => { if (view) await view.close(); });
  afterAll(() => gateway?.close());

  test.each([390, 844])('touch opening does not activate editing at width %i', async width => {
    await open(width, true);
    expect(await focusedPath()).toBe(false);
    expect(await evaluate(() => qaEditableFocus)).toEqual([]);
  });

  test('touch folder and parent navigation never activate editing', async () => {
    await open(390, true);
    await evaluate(() => {
      document.getElementById('workspace-create-directory').focus();
      qaEditableFocus.length = 0;
    });
    await view.click('.workspace-directory-option[data-path="/workspace/child"]');
    await listed('/workspace/child');
    expect(await evaluate(() => document.getElementById('workspace-directory').value))
      .toBe('/workspace/child');
    expect(await focusedPath()).toBe(false);
    await view.click('.workspace-directory-option[data-path="/workspace"]');
    await listed('/workspace');
    expect(await evaluate(() => document.getElementById('workspace-directory').value))
      .toBe('/workspace');
    expect(await evaluate(() => qaEditableFocus)).toEqual([]);
  });

  test.each([390, 844])('touch path remains editable without small text at width %i', async width => {
    await open(width, true);
    await view.click('#workspace-directory');
    await view.cdp('Input.insertText', { text: '/manual' });
    expect(await focusedPath()).toBe(true);
    expect(await evaluate(() => document.getElementById('workspace-directory').value))
      .toContain('/manual');
    expect(await evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('workspace-directory')).fontSize)))
      .toBeGreaterThanOrEqual(16);
  });

  test('failed touch creation restores controls without activating editing', async () => {
    await open(390, true);
    await evaluate(() => {
      document.getElementById('workspace-directory').value = '/workspace';
      document.getElementById('workspace-create-directory').focus();
      qaEditableFocus.length = 0;
    });
    await view.click('#workspace-submit');
    await evaluate(() => new Promise((resolve, reject) => {
      const dialog = document.getElementById('workspace-dialog');
      const ready = () => document.getElementById('workspace-error').textContent
        && !document.getElementById('workspace-submit').disabled;
      if (ready()) { resolve(); return; }
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Creation failure missing'));
      }, 3000);
      const observer = new MutationObserver(() => {
        if (!ready()) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(dialog, { attributes: true, childList: true, subtree: true });
    }));
    expect(await evaluate(() => document.getElementById('workspace-dialog').open)).toBe(true);
    expect(await evaluate(() => document.getElementById('workspace-directory').disabled)).toBe(false);
    expect(await evaluate(() => qaEditableFocus)).toEqual([]);
  });

  test('desktop keeps input focus, keyboard navigation and focus restoration', async () => {
    await open(1440, false);
    expect(await focusedPath()).toBe(true);
    async function press(key) {
      const keyCode = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 }[key];
      await view.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
      });
      await view.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
    await press('ArrowDown');
    expect(await evaluate(() => document.activeElement.textContent)).toBe('..');
    await press('ArrowUp');
    expect(await focusedPath()).toBe(true);
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    await listed('/workspace/child');
    expect(await evaluate(() => document.getElementById('workspace-directory').value))
      .toBe('/workspace/child');
    expect(await focusedPath()).toBe(true);
    await press('Escape');
    expect(await evaluate(() => document.getElementById('workspace-dialog').open)).toBe(false);
    expect(await evaluate(() => document.activeElement.id)).toBe('new-session-btn');
  });
});
