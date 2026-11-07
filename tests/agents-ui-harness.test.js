/** Direct browser fixture: real stylesheet/modules, no transport or DOM emulation. */
export const task = (id, status = 'running', ancestry) => ({
  task_id: id, status, model: 'effective/model', task_summary: `Task ${id}`,
  created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:02:05Z',
  ...(ancestry ? { tau_ancestry: ancestry } : {}),
});
export const node = (id, depends_on = [], state = 'pending', task_id) => ({
  id, label: id, prompt: `Prompt ${id}`, depends_on, state, ...(task_id ? { task_id } : {}),
});
export const run = (run_id = 'one', nodes = [node('plan', [], 'completed'), node('verify', ['plan'], 'running', 'linked')]) =>
  ({ run_id, name: `Workflow ${run_id}`, status: 'running', nodes });
export const snapshot = (tasks = [], runs = [run()], availability = 'ready') => ({
  agentsState: { availability, parent_session_id: 'owner', tasks },
  dagState: { availability, parent_session_id: 'owner', runs },
});
export async function harness(width = 1440) {
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response(`<!doctype html><html data-theme="night"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/style.css"><style>
        #agents-panel { width: min(360px,100vw); height:100vh; }
        </style></head><body><button id="toolbar"><span id="count"></span></button>
        <div id="agents-panel" class="agents-panel"></div>
        <script>window.errors=[];addEventListener('error',event=>errors.push(event.message));</script>
        </body></html>`, { headers: { 'Content-Type': 'text/html' } });
      const file = Bun.file(new URL(`../public${path}`, import.meta.url));
      return await file.exists() ? new Response(file) : new Response('', { status: 404 });
    },
  });
  const view = new Bun.WebView({ width, height: 844 });
  const evaluate = (fn, args = null) => view.evaluate(`(${fn.toString()})(${JSON.stringify(args)})`);
  try {
    await view.navigate('about:blank');
    await view.cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    await view.navigate(server.url.href);
    await evaluate(async () => {
      const { AgentsPanel } = await import('/agents-panel.js');
      window.panel = new AgentsPanel(document.getElementById('agents-panel'), document.getElementById('count'));
      panel.selectSession('fixture');
      panel.setVisible(true);
    });
  } catch (error) {
    await view.close(); server.stop(true); throw error;
  }
  return {
    view, evaluate,
    async replace(data) { await evaluate(data => panel.replace(data, 'fixture'), data); },
    async graph() {
      await evaluate(() => { panel.dagRoot.node.open = true; panel.render(); });
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    },
    async close() { await evaluate(() => panel.destroy()); await view.close(); server.stop(true); },
  };
}
