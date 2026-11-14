import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createApplication } from '../server/main.mjs';
import { makeZip } from '../server/zip.mjs';
import { request } from 'node:http';

async function fixture(t, run, validate, options = {}) {
  const { designFirst = false, ...applicationOptions } = options;
  const base = resolve(tmpdir());
  const folder = await mkdtemp(join(base, 'web-agent-api-test-'));
  const calls = [];
  const engine = { health: async () => ({ available: true, authenticated: true }), close: async () => {},
    async run(input) { calls.push(input); return run(input, calls.length); }, respondApproval() {} };
  const app = await createApplication({ dataRoot: join(folder, 'data'), engine, validate: validate || (async () => ({ available: true, ok: true, issues: [], images: [] })), ...applicationOptions });
  const origin = await app.listen(0);
  t.after(async () => {
    await app.close();
    const part = relative(base, resolve(folder));
    assert(part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  async function post(path, body, headers = {}) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'web-dev-agent', ...headers }, body: JSON.stringify(body) });
    // Older pipeline cases exercise migrated projects; new design-first cases opt in below.
    if (!designFirst && path === '/api/projects' && response.status === 201) await app.store.update((await response.clone().json()).project.id, { workflow: 'legacy' });
    return response;
  }
  return { app, origin, calls, post };
}
const completed = { threadId: 'thread-test', turnId: 'turn-test', status: 'completed', finalResponse: '已编辑真实文件。' };
async function settle(app) { await Promise.all([...app.runner.active.values()].map(item => item.task)); }
async function writeDesignReview(input, patch = {}) {
  const reviewId = input.prompt.match(/"reviewId":\s*"([^"]+)"/)?.[1];
  assert(reviewId, 'The current run identity must reach the visual review call.');
  const report = {
    schemaVersion: 1, reviewId, direction: '以阅读内容为中心的中文编辑式版面',
    checks: ['intent', 'hierarchy', 'typography', 'palette', 'composition', 'identity', 'mobile'].map(id => ({ id, status: 'pass', desktop: '测试图片中的标题与正文层级清楚。', mobile: '测试图片中的文字与控件在窄屏保持清晰。' })),
    changes: [], remainingIssues: [], ...patch
  };
  await writeFile(join(input.cwd, 'DESIGN_REVIEW.json'), JSON.stringify(report));
  return report;
}

test('HTTP pipeline writes sources, feeds actual diagnostic data back, rechecks edits and resumes the same thread', async t => {
  let checks = 0;
  const { app, origin, post, calls } = await fixture(t, async (input, index) => {
    if (index === 1) await writeFile(join(input.cwd, 'index.html'), '<html lang="zh-CN"><h1>初版</h1></html>');
    else if (index === 2) {
      assert.match(input.prompt, /脚本错误/);
      await writeFile(join(input.cwd, 'index.html'), '<html lang="zh-CN"><h1>修复版</h1></html>');
    }
    if (index % 2 === 0) await writeDesignReview(input);
    return completed;
  }, async () => ({ available: true, ok: ++checks > 1, issues: checks === 1 ? ['脚本错误：missing is not defined'] : [], images: [] }));
  const project = (await (await post('/api/projects', { name: '中文项目' })).json()).project;
  assert.equal((await post(`/api/projects/${project.id}/messages`, { message: '生成网页' })).status, 202);
  await settle(app);
  assert.equal(checks, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].threadId, 'thread-test');
  const detail = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
  assert.equal(detail.project.status, 'completed');
  assert.equal(detail.messages.length, 2);
  assert(detail.files.some(item => item.path === 'index.html'));
  assert.match((await (await fetch(`${origin}/api/projects/${project.id}/file?path=index.html`)).json()).content, /修复版/);
  const report = JSON.parse(await readFile(join(app.store.evidenceDir(project.id), detail.runs[0].id, 'result.json'), 'utf8'));
  assert.equal(report.automatedPassed, true);
  assert.equal(report.designReviewRecorded, true);
  assert.equal(report.designNeedsAttention, false);
  assert.equal(report.sourceHash, detail.runs[0].sourceHash);
  const preview = await fetch(`${origin}${project.previewUrl}`);
  assert.notEqual(new URL(preview.url).origin, origin);
  assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/);
  assert(preview.headers.get('content-security-policy').includes(`frame-ancestors ${origin}`));
  assert.match(await preview.text(), /修复版/);
  const zip = Buffer.from(await (await fetch(`${origin}/api/projects/${project.id}/export`)).arrayBuffer());
  assert.equal(zip.readUInt32LE(), 0x04034b50);
  assert(zip.includes(Buffer.from('index.html')));
  assert.equal((await post(`/api/projects/${project.id}/messages`, { message: '继续修改' })).status, 202);
  await settle(app);
  assert.equal(calls[2].threadId, 'thread-test');
  assert.equal((await app.store.loadMessages(project.id)).length, 4);
  assert.equal(checks, 3, 'Only new review metadata must not trigger an extra render.');
  const lastEvidence = (await app.store.loadRuns(project.id)).at(-1).validation;
  assert.equal(lastEvidence.reRendered, false);
  assert.equal(lastEvidence.reviewInputRenderSourceHash, lastEvidence.renderSourceHash);
});

test('concurrent submissions cannot overlap, and stop retains files without falsely reporting completion', async t => {
  const { app, post, calls } = await fixture(t, async input => {
    await writeFile(join(input.cwd, 'index.html'), '<h1>保留文件</h1>');
    await new Promise((resolve, reject) => {
      if (input.signal.aborted) reject(new Error('stopped'));
      else input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
    return completed;
  });
  const project = (await (await post('/api/projects', { name: '并发检查' })).json()).project;
  const responses = await Promise.all([post(`/api/projects/${project.id}/messages`, { message: '第一次' }), post(`/api/projects/${project.id}/messages`, { message: '第二次' })]);
  assert.deepEqual(responses.map(item => item.status).sort(), [202, 409]);
  await post(`/api/projects/${project.id}/stop`, {});
  await settle(app);
  assert.equal(calls.length, 1);
  assert.equal((await app.store.get(project.id)).status, 'interrupted');
  assert.match((await app.store.readFile(project.id, 'index.html')).content, /保留文件/);
});

test('model failure and unavailable rendering remain visibly incomplete', async t => {
  const { app, post } = await fixture(t, async () => ({ ...completed, status: 'failed', error: '账户额度不足' }));
  const project = (await (await post('/api/projects', { name: '失败检查' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '生成' }); await settle(app);
  assert.equal((await app.store.get(project.id)).status, 'failed');
  assert.match((await app.store.loadMessages(project.id)).at(-1).text, /账户额度不足/);
  const second = await fixture(t, async input => { await writeFile(join(input.cwd, 'index.html'), '<h1>页面</h1>'); return completed; }, async () => ({ available: false, ok: false, issues: ['未找到浏览器'], images: [] }));
  const other = (await (await second.post('/api/projects', { name: '浏览器缺失' })).json()).project;
  await second.post(`/api/projects/${other.id}/messages`, { message: '生成' }); await settle(second.app);
  assert.equal((await second.app.store.get(other.id)).status, 'needs_attention');
  assert.equal(second.calls.length, 1);
});

test('runtime success cannot hide a missing or stale aesthetic review record', async t => {
  const { app, post } = await fixture(t, async (input, index) => {
    if (index === 1) {
      await writeFile(join(input.cwd, 'index.html'), '<h1>自动渲染通过的页面</h1>');
      await writeFile(join(input.cwd, 'DESIGN_REVIEW.json'), JSON.stringify({ schemaVersion: 1, reviewId: 'old-run', direction: '上次的设计' }));
    }
    return completed;
  });
  const project = (await (await post('/api/projects', { name: '审查记录不能复用' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '生成网页并检查美感' }); await settle(app);
  const state = await app.store.get(project.id);
  assert.equal(state.status, 'needs_attention');
  assert.equal(state.lastValidation.ok, true);
  assert.equal(state.lastValidation.reviewed, false);
  assert(state.lastValidation.issues.length > 0);
  assert.equal((await app.store.loadRuns(project.id)).at(-1).validation.designReviewRecorded, false);
});

test('visual review has its own bounded time window after development completes', async t => {
  const { app, post } = await fixture(t, async (input, index) => {
    await new Promise(resolve => setTimeout(resolve, 650));
    input.signal.throwIfAborted();
    if (index === 1) await writeFile(join(input.cwd, 'index.html'), '<h1>开发与复核有独立时限</h1>');
    else await writeDesignReview(input);
    return completed;
  }, undefined, { timeoutMs: 1000, reviewTimeoutMs: 1500 });
  const project = (await (await post('/api/projects', { name: '复核时间窗口' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '制作并审查页面' }); await settle(app);
  assert.equal((await app.store.get(project.id)).status, 'completed');
});

test('unresolved design findings stay visible even when the model and renderer report success', async t => {
  const { app, post } = await fixture(t, async (input, index) => {
    if (index === 1) await writeFile(join(input.cwd, 'index.html'), '<h1>字体拥挤的页面</h1>');
    else {
      const report = await writeDesignReview(input);
      report.checks.find(item => item.id === 'typography').status = 'needs_work';
      report.remainingIssues.push({ criterion: 'typography', problem: '手机正文过密', location: '介绍段落', nextAction: '调整行距后重新查看手机截图' });
      await writeFile(join(input.cwd, 'DESIGN_REVIEW.json'), JSON.stringify(report));
    }
    return completed;
  });
  const project = (await (await post('/api/projects', { name: '未解决的设计问题' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '生成网页' }); await settle(app);
  const state = await app.store.get(project.id);
  assert.equal(state.status, 'needs_attention');
  assert.equal(state.lastValidation.reviewed, true);
  assert.match((await app.store.loadMessages(project.id)).at(-1).text, /手机正文过密/);
  const run = (await app.store.loadRuns(project.id)).at(-1);
  assert.equal(run.validation.designNeedsAttention, true);
  assert.equal(JSON.parse(await readFile(join(app.store.evidenceDir(project.id), run.id, 'design-review.json'), 'utf8')).remainingIssues.length, 1);
});

test('host and origin checks protect local mutation and preview API is separate', async t => {
  const { origin, post } = await fixture(t, async () => completed);
  assert.equal((await post('/api/projects', { name: '跨来源' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/projects', { name: '缺少标头' }, { 'X-Requested-With': '' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${origin}/api/status`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('startup recovers stale runs and preserves saved project content', async t => {
  const { app, post } = await fixture(t, async () => completed);
  const project = (await (await post('/api/projects', { name: '重启恢复' })).json()).project;
  await app.store.update(project.id, { status: 'running', phase: 'developing', activeRunId: 'old-run' });
  await writeFile(join(app.store.workspace(project.id), 'index.html'), '<h1>未丢失的文件</h1>');
  const another = await createApplication({ dataRoot: app.store.root, engine: { close() {} } });
  await another.listen(0);
  t.after(() => another.close());
  const recovered = await another.store.get(project.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.activeRunId, undefined);
  assert.match(recovered.lastError, /上次服务退出/);
  assert.match((await another.store.readFile(project.id, 'index.html')).content, /未丢失/);
});

test('ZIP stores UTF-8 paths, correct CRC and rejects traversal', () => {
  const zip = makeZip([{ name: '中文.html', data: '123456789' }]);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.readUInt16LE(6), 0x800);
  assert(zip.includes(Buffer.from('中文.html')));
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.throws(() => makeZip([{ name: '../secret.txt', data: '' }]), /Invalid/);
});

async function writeDirection(input, patch = {}) {
  const designId = input.prompt.match(/"designId":\s*"([^"]+)"/)?.[1];
  assert(designId, 'A direction draft must be bound to the current run.');
  const plan = {
    schemaVersion: 1, designId, concept: '纸张与文字的安静秩序', audience: '希望整理阅读的人', primaryAction: '保存一本书',
    typography: '中文标题与正文字重分工', palette: '纸白背景与墨黑文字', composition: '大留白和不对称书目', keyVisual: '原创代码线条', mobile: '手机优先显示录入区', motion: '状态切换并支持减少动态',
    sections: [{ name: '书目', purpose: '记录阅读', composition: '标题与列表相邻' }], assets: [], references: [], ...patch
  };
  await writeFile(join(input.cwd, 'index.html'), '<html lang="zh-CN"><h1>方向稿</h1></html>');
  await writeFile(join(input.cwd, 'DESIGN_PLAN.json'), JSON.stringify(plan));
  return plan;
}
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
async function directionRender({ out }) {
  await mkdir(out, { recursive: true });
  await Promise.all(['desktop.png', 'desktop-detail.png', 'mobile.png'].map(file => writeFile(join(out, file), pixel)));
  return { available: true, ok: true, issues: [], images: [] };
}

test('new projects pause on real direction evidence, then approval expands the same thread and preserves normal edits', async t => {
  const { app, origin, post, calls } = await fixture(t, async input => {
    if (input.prompt.includes('本轮是等待用户确认的设计方向稿')) await writeDirection(input);
    else if (input.prompt.includes('"reviewId"')) await writeDesignReview(input);
    else {
      assert.match(input.prompt, /纸张与文字的安静秩序/);
      await writeFile(join(input.cwd, 'index.html'), '<h1>完整阅读页面</h1>');
    }
    return completed;
  }, directionRender, { designFirst: true });
  const project = (await (await post('/api/projects', { name: '先设计再实现' })).json()).project;
  assert.equal(project.workflow, 'design_first');
  assert.equal((await post(`/api/projects/${project.id}/messages`, { message: '做一个阅读记录页', mode: 'build' })).status, 409);
  assert.equal(calls.length, 0);
  await post(`/api/projects/${project.id}/messages`, { message: '做一个阅读记录页' }); await settle(app);
  let detail = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
  assert.equal(calls.length, 1, 'No full build or self-review before a human approves direction.');
  assert.equal(detail.project.status, 'awaiting_design');
  assert.equal(detail.design.ready, true);
  assert.deepEqual(detail.design.images, { desktop: true, detail: true, mobile: true });
  const designId = detail.design.designId;
  const image = await fetch(`${origin}/api/projects/${project.id}/design-image?view=detail&v=${designId}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), pixel);
  assert.equal((await fetch(`${origin}/api/projects/${project.id}/design-image?view=../../state.json`)).status, 400);
  assert.equal((await fetch(`${origin}/api/projects/${project.id}/design-image?view=desktop&v=old`)).status, 404);
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId })).status, 202);
  await settle(app);
  detail = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
  assert.equal(detail.project.status, 'completed');
  assert.equal(detail.project.designApprovedId, designId);
  assert.equal(detail.design.approved, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].threadId, 'thread-test');
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId })).status, 409);
  await post(`/api/projects/${project.id}/messages`, { message: '把按钮文字改短' }); await settle(app);
  assert.equal(calls.length, 5, 'An approved project takes the ordinary edit and review path.');
});

test('a changed direction cannot be approved, including binary assets and plan-only changes', async t => {
  const { app, origin, post, calls } = await fixture(t, async input => { await writeDirection(input); await writeFile(join(input.cwd, 'texture.png'), pixel); return completed; }, directionRender, { designFirst: true });
  const project = (await (await post('/api/projects', { name: '防止批准过期预览' })).json()).project;
  const draft = async () => { await post(`/api/projects/${project.id}/messages`, { message: '重新调整字距', mode: 'design' }); await settle(app); return (await (await fetch(`${origin}/api/projects/${project.id}`)).json()).design.designId; };
  let designId = await draft();
  await writeFile(join(app.store.workspace(project.id), 'texture.png'), Buffer.from([1, 2, 3]));
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId })).status, 409);
  const oldId = designId;
  designId = await draft();
  assert.notEqual(designId, oldId);
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId: oldId })).status, 409);
  const planPath = join(app.store.workspace(project.id), 'DESIGN_PLAN.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8')); plan.concept = '未经预览的新方向';
  await writeFile(planPath, JSON.stringify(plan));
  assert.equal((await (await fetch(`${origin}/api/projects/${project.id}`)).json()).design.ready, false);
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId })).status, 409);
  assert.equal(calls.length, 2);
});

test('missing key assets, absent screenshots and failed rendering cannot unlock full generation', async t => {
  for (const failure of ['asset', 'image', 'render']) {
    const { app, origin, post, calls } = await fixture(t, async input => {
      await writeDirection(input, failure === 'asset' ? { assets: [{ name: '展览照片', kind: 'local', purpose: '主视觉', path: 'missing.png' }] } : {});
      return completed;
    }, async args => {
      if (failure !== 'image') await directionRender(args);
      return { available: true, ok: failure !== 'render', issues: failure === 'render' ? ['手机横向溢出'] : [], images: [] };
    }, { designFirst: true });
    const project = (await (await post('/api/projects', { name: failure })).json()).project;
    await post(`/api/projects/${project.id}/messages`, { message: '做设计方向' }); await settle(app);
    const detail = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
    assert.equal(detail.project.status, 'needs_attention');
    assert.equal(detail.design.ready, false);
    if (failure === 'render') assert(detail.design.issues.includes('手机横向溢出'));
    assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId: detail.design.designId })).status, 409);
    assert.equal(calls.length, 1);
  }
});

test('two simultaneous direction approvals start at most one build', async t => {
  const { app, origin, post, calls } = await fixture(t, async input => {
    if (input.prompt.includes('本轮是等待用户确认的设计方向稿')) { await writeDirection(input); return completed; }
    await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    return completed;
  }, directionRender, { designFirst: true });
  const project = (await (await post('/api/projects', { name: '确认并发' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '设计网页' }); await settle(app);
  const { design } = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
  const responses = await Promise.all([post(`/api/projects/${project.id}/approve-design`, { designId: design.designId }), post(`/api/projects/${project.id}/approve-design`, { designId: design.designId })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409]);
  for (let attempts = 0; calls.length < 2 && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 2);
  await post(`/api/projects/${project.id}/stop`, {}); await settle(app);
  assert.equal(calls.length, 2);
});

test('downloaded website includes local image and font bytes while the source viewer stays text-only', async t => {
  const { app, origin, post } = await fixture(t, async () => completed);
  const project = (await (await post('/api/projects', { name: '完整素材导出' })).json()).project;
  const root = app.store.workspace(project.id);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<img src="assets/cover.png">');
  await writeFile(join(root, 'assets', 'cover.png'), pixel);
  const font = Buffer.from([0, 119, 79, 70, 50, 0, 100, 23]);
  await writeFile(join(root, 'assets', 'type.woff2'), font);
  await writeFile(join(root, '.env'), 'PRIVATE_SHOULD_NOT_EXPORT');
  const zip = Buffer.from(await (await fetch(`${origin}/api/projects/${project.id}/export`)).arrayBuffer());
  assert(zip.includes(Buffer.from('assets/cover.png')));
  assert(zip.includes(pixel));
  assert(zip.includes(font));
  assert(!zip.includes(Buffer.from('PRIVATE_SHOULD_NOT_EXPORT')));
  assert.equal((await fetch(`${origin}/api/projects/${project.id}/file?path=assets/cover.png`)).status, 415);
});

test('approval checks the current draft after the engine health check, before accepting it', async t => {
  const { app, origin, post, calls } = await fixture(t, async input => { await writeDirection(input); return completed; }, directionRender, { designFirst: true });
  const project = (await (await post('/api/projects', { name: '健康检查后重新核对' })).json()).project;
  await post(`/api/projects/${project.id}/messages`, { message: '制作设计方向' }); await settle(app);
  const { design } = await (await fetch(`${origin}/api/projects/${project.id}`)).json();
  app.engine.health = async () => {
    await writeFile(join(app.store.workspace(project.id), 'index.html'), '<h1>外部修改过的页面</h1>');
    return { available: true, authenticated: true };
  };
  assert.equal((await post(`/api/projects/${project.id}/approve-design`, { designId: design.designId })).status, 409);
  assert.equal(calls.length, 1);
  assert.equal((await app.store.get(project.id)).designApprovedId, undefined);
});
