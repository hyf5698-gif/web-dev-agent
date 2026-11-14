import http from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './project-store.mjs';
import { serveStatic } from './static-files.mjs';
import { CodexEngine } from './codex-engine.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { makeZip } from './zip.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fileList = files => files.map(file => ({ ...file, size: file.size ?? file.bytes }));
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
async function bodyJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('请求需要JSON格式。'), { statusCode: 415 });
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 65536) throw Object.assign(new Error('请求过长。'), { statusCode: 413 });
  }
  try { return data ? JSON.parse(data) : {}; }
  catch { throw Object.assign(new Error('请求内容格式错误。'), { statusCode: 400 }); }
}

export async function createApplication({ dataRoot = join(appRoot, 'data'), engine = new CodexEngine(), validate, timeoutMs, reviewTimeoutMs, publicRoot = join(appRoot, 'public') } = {}) {
  const store = new ProjectStore({ root: dataRoot });
  await store.init();
  for (const project of await store.list()) {
    if (['running', 'verifying', 'reviewing'].includes(project.status)) {
      await store.update(project.id, { status: 'interrupted', phase: 'finished', activeRunId: null, lastError: '上次服务退出，本轮已停止；文件仍保留，可以继续修改。' });
    }
  }
  const streams = new Map(), approvals = new Map();
  let origin, previewOrigin;
  const emit = (id, value) => {
    if (value.type === 'done') for (const [key, pending] of approvals) { if (pending.projectId === id) approvals.delete(key); }
    if (value.type === 'activity' && value.kind === 'approval' && value.status === 'resolved') approvals.delete(String(value.approvalId));
    if (value.type === 'approval') {
      const key = String(value.id);
      value = { ...value, id: key, description: value.description || `${value.method}\n${JSON.stringify(value.params || {}).slice(0, 2400)}` };
      approvals.set(key, { projectId: id, id: value.id, value });
    }
    if (value.type === 'files') value = { ...value, files: fileList(value.files) };
    for (const res of streams.get(id) || []) res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const runner = new Orchestrator({ store, engine, emit, ...(validate ? { validate } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(reviewTimeoutMs ? { reviewTimeoutMs } : {}) });
  const details = async id => {
    const files = fileList(await store.listFiles(id));
    return { project: { ...await store.get(id), fileCount: files.length }, files, messages: await store.loadMessages(id), runs: await store.loadRuns(id), design: await runner.getDesign(id) };
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) { json(res, 403, { error: '只接受本机工作台地址。' }); return; }
      if (req.headers.origin && req.headers.origin !== origin) { json(res, 403, { error: '跨来源请求被拒绝。' }); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let health;
        try { health = await engine.health(); } catch (error) { health = { available: false, authenticated: false, message: error.message }; }
        json(res, 200, { engine: health, app: '网页开发助手', version: '0.3.0', localOnly: true }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const projects = await store.list();
        json(res, 200, { projects }); return;
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([a-f\d-]+)(?:\/(messages|stop|events|file|export|approve-design|design-image))?$/i);
      if (req.method === 'GET' && projectMatch) {
        const [, id, action] = projectMatch;
        await store.get(id);
        if (!action) { json(res, 200, await details(id)); return; }
        if (action === 'file') { json(res, 200, await store.readFile(id, url.searchParams.get('path') || '')); return; }
        if (action === 'design-image') {
          const files = { desktop: 'desktop.png', detail: 'desktop-detail.png', mobile: 'mobile.png' };
          const view = url.searchParams.get('view');
          if (!Object.hasOwn(files, view)) { json(res, 400, { error: '设计图片类型无效。' }); return; }
          const project = await store.get(id);
          if (!project.designDraftId || (url.searchParams.has('v') && url.searchParams.get('v') !== project.designDraftId)) { json(res, 404, { error: '设计图片已失效。' }); return; }
          let image;
          try { image = await store.readEvidence(id, project.designDraftId, `direction/${files[view]}`); }
          catch { json(res, 404, { error: '设计图片尚未生成。' }); return; }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': image.length }); res.end(image); return;
        }
        if (action === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
          const members = streams.get(id) || new Set(); streams.set(id, members); members.add(res);
          res.write(`data: ${JSON.stringify({ type: 'status', ...await store.get(id), message: '项目已连接。' })}\n\n`);
          for (const pending of approvals.values()) if (pending.projectId === id) res.write(`data: ${JSON.stringify(pending.value)}\n\n`);
          const pulse = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          req.on('close', () => { clearInterval(pulse); members.delete(res); if (!members.size) streams.delete(id); });
          return;
        }
        if (action === 'export') {
          const entries = await store.exportEntries(id);
          const zip = makeZip(entries);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="website-source.zip"', 'Content-Length': zip.length, 'Cache-Control': 'no-store' }); res.end(zip); return;
        }
      }
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        if (req.headers['x-requested-with'] !== 'web-dev-agent') { json(res, 403, { error: '请从本地工作台操作。' }); return; }
        const data = await bodyJson(req);
        if (url.pathname === '/api/projects' && req.method === 'POST') {
          const project = await store.create(data.name || '新网页项目'); json(res, 201, { project }); return;
        }
        if (projectMatch && req.method === 'POST') {
          const [, id, action] = projectMatch;
          if (action === 'messages') {
            if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 12000) { json(res, 400, { error: '请输入1至12000字的网页需求。' }); return; }
            json(res, 202, await runner.submit(id, data.message.trim(), { mode: data.mode })); return;
          }
          if (action === 'approve-design') {
            if (typeof data.designId !== 'string') { json(res, 400, { error: '请确认具体的设计方向。' }); return; }
            json(res, 202, await runner.submit(id, '我已确认此设计方向，请按已确认的方向完善网页内容与功能。', { designId: data.designId })); return;
          }
          if (action === 'stop') { await store.get(id); json(res, 200, await runner.stop(id)); return; }
        }
        const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approval && req.method === 'POST') {
          const key = decodeURIComponent(approval[1]), pending = approvals.get(key);
          if (!pending || !['accept', 'decline'].includes(data.decision)) { json(res, 400, { error: '审批已失效或选择无效。' }); return; }
          await engine.respondApproval(pending.id, data.decision); approvals.delete(key);
          emit(pending.projectId, { type: 'activity', message: data.decision === 'accept' ? '已按你的选择批准本次操作。' : '已拒绝本次操作。' });
          json(res, 200, { ok: true }); return;
        }
      }
      const previewMatch = url.pathname.match(/^\/preview\/([a-f\d-]+)(\/.*)?$/i);
      if (previewMatch) {
        await store.get(previewMatch[1]);
        if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: '只支持读取预览。' }); return; }
        res.writeHead(302, { Location: `${previewOrigin}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { error: '接口不存在。' }); return; }
      await serveStatic(req, res, { root: publicRoot, pathname: url.pathname, preview: false });
    } catch (error) {
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message || '请求失败。' });
      else res.end();
    }
  });
  // A different port is a different browser origin. Generated scripts can use
  // browser storage without being allowed to read the host UI or call its API.
  const previewServer = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(previewOrigin).host) { json(res, 403, { error: '预览地址无效。' }); return; }
      const url = new URL(req.url, previewOrigin);
      const match = url.pathname.match(/^\/preview\/([a-f\d-]+)(\/.*)?$/i);
      if (!match) { json(res, 404, { error: '预览不存在。' }); return; }
      await store.get(match[1]);
      await serveStatic(req, res, { root: store.workspace(match[1]), pathname: match[2] || '/', preview: true, frameAncestor: origin });
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message }); else res.end(); }
  });
  return {
    server, store, engine, runner,
    async listen(port = 4317) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      try {
        await new Promise((resolve, reject) => { previewServer.once('error', reject); previewServer.listen(0, '127.0.0.1', resolve); });
        previewOrigin = `http://127.0.0.1:${previewServer.address().port}`;
      } catch (error) { server.close(); throw error; }
      return origin;
    },
    async close() {
      await runner.close();
      await engine.close();
      for (const members of streams.values()) for (const res of members) res.end();
      await new Promise(resolve => { previewServer.close(resolve); previewServer.closeAllConnections?.(); });
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApplication({ dataRoot: process.env.WEB_AGENT_DATA ? resolve(process.env.WEB_AGENT_DATA) : undefined });
  const url = await app.listen(Number(process.env.PORT || 4317));
  console.log(`网页开发助手已启动：${url}`);
  console.log('输入真实需求后会使用当前Codex账号执行；生成项目保存在本应用data目录。');
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
