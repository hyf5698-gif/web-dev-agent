import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { ProjectStore } from '../server/project-store.mjs';

async function fixture(t) {
  const base = resolve(tmpdir());
  const folder = await mkdtemp(join(base, 'web-agent-store-test-'));
  t.after(async () => {
    const target = resolve(folder);
    const part = relative(base, target);
    assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return folder;
}

test('projects persist, protect identity, and serialize concurrent message and state writes', async t => {
  const folder = await fixture(t);
  const root = join(folder, 'data');
  const store = new ProjectStore({ root });
  await store.init();
  const project = await store.create('中文网页');
  assert.equal(project.name, '中文网页');
  assert.equal(project.previewUrl, `/preview/${project.id}/`);
  assert.equal(store.workspace(project.id), join(root, project.id, 'site'));
  assert.equal(store.evidenceDir(project.id), join(root, project.id, 'evidence'));
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.addMessage(project.id, { role: 'user', text: `消息 ${index}` })));
  await Promise.all([
    store.update(project.id, { name: '新名字', id: '../../outside', createdAt: 'FORGED' }),
    store.update(project.id, { phase: 'building', status: 'running', threadId: 'thread-example' }),
    store.addMessage(project.id, { role: 'assistant', text: '开始制作。' }),
    store.appendRun(project.id, { kind: 'build', status: 'running' })
  ]);
  const current = await store.get(project.id);
  assert.equal(current.id, project.id);
  assert.equal(current.createdAt, project.createdAt);
  assert.equal(current.name, '新名字');
  assert.equal(current.phase, 'building');
  assert.equal(current.status, 'running');
  const reopened = new ProjectStore({ root });
  const messages = await reopened.loadMessages(project.id);
  assert.equal(messages.length, 31);
  assert.equal(new Set(messages.map(message => message.id)).size, 31);
  assert.equal((await reopened.list()).length, 1);
  assert.equal((await reopened.loadRuns(project.id)).length, 1);
  assert(!(await readdir(join(root, project.id))).some(name => name.endsWith('.tmp')));
  await assert.rejects(store.update(project.id, { status: 'FAKE' }), /状态无效/);
  assert.equal((await store.get(project.id)).status, 'running');
});

test('source access is confined, text-only, bounded, and excludes hidden or secret files', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('文件检查');
  const site = store.workspace(project.id);
  await mkdir(join(site, 'src'));
  await mkdir(join(site, 'node_modules'));
  await writeFile(join(site, 'index.html'), '<h1>你好</h1>');
  await writeFile(join(site, 'src', 'app.js'), 'console.log("ok");');
  await writeFile(join(site, '.env'), 'PRIVATE');
  await writeFile(join(site, 'credentials.json'), '{"token":"PRIVATE"}');
  await writeFile(join(site, 'node_modules', 'library.js'), 'IGNORE');
  await writeFile(join(site, 'image.png'), Buffer.from([1, 0, 2]));
  await writeFile(join(site, 'binary.txt'), Buffer.from([1, 0, 2]));
  await writeFile(join(site, 'large.txt'), 'a'.repeat(1024 * 1024 + 1));
  assert.deepEqual((await store.listFiles(project.id)).map(file => file.path), ['index.html', 'src/app.js']);
  assert.equal((await store.readFile(project.id, 'index.html')).content, '<h1>你好</h1>');
  for (const path of ['../state.json', '/index.html', 'src/../../state.json', 'src\\app.js', '.env', 'credentials.json', 'node_modules/library.js']) {
    await assert.rejects(store.readFile(project.id, path));
  }
  await assert.rejects(store.readFile(project.id, 'image.png'));
  await assert.rejects(store.readFile(project.id, 'large.txt'));
  await assert.rejects(store.readFile(project.id, 'binary.txt'));
  const sentinel = join(folder, 'sentinel.json');
  await writeFile(sentinel, 'DO NOT OVERWRITE');
  await assert.rejects(store.update('../sentinel', { name: 'bad' }));
  await assert.rejects(store.addMessage('../sentinel', { role: 'user', text: 'bad' }));
  assert.equal(await readFile(sentinel, 'utf8'), 'DO NOT OVERWRITE');
});

test('junction escapes and linked project records cannot expose or overwrite other files', async t => {
  const folder = await fixture(t);
  const root = join(folder, 'data');
  const outside = join(folder, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'outside.txt'), 'PRIVATE');
  const store = new ProjectStore({ root });
  const project = await store.create('链接检查');
  try { await symlink(outside, join(store.workspace(project.id), 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Links unavailable.'); return; } throw error; }
  assert.deepEqual(await store.listFiles(project.id), []);
  await assert.rejects(store.readFile(project.id, 'escape/outside.txt'), /符号链接/);
  const fakeId = '11111111-1111-4111-8111-111111111111';
  await symlink(outside, join(root, fakeId), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.update(fakeId, { name: 'bad' }), /目录不安全/);
  assert.equal(await readFile(join(outside, 'outside.txt'), 'utf8'), 'PRIVATE');
  assert.deepEqual(await readdir(outside), ['outside.txt']);
});

test('workspace hashes bind binary image and font bytes, paths, and unchanged content deterministically', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('二进制素材摘要');
  const site = store.workspace(project.id);
  await mkdir(join(site, 'assets'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 255]);
  const font = Buffer.from([119, 79, 70, 70, 0, 1, 0, 0, 254]);
  await writeFile(join(site, 'index.html'), '<img src="assets/cover.png">');
  await writeFile(join(site, 'assets', 'cover.png'), png);
  await writeFile(join(site, 'assets', 'type.woff'), font);
  const hash = async () => ({ full: await store.workspaceHash(project.id), render: await store.workspaceHash(project.id, { renderOnly: true }) });
  const original = await hash();
  assert.match(original.full, /^[a-f0-9]{64}$/);
  assert.deepEqual(await hash(), original);
  for (const [name, bytes] of [['cover.png', png], ['type.woff', font]]) {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(site, 'assets', name), changed);
    const current = await hash();
    assert.notEqual(current.full, original.full, `${name} changes must invalidate approval`);
    assert.notEqual(current.render, original.render, `${name} changes must require new rendering`);
    await writeFile(join(site, 'assets', name), bytes);
    assert.deepEqual(await hash(), original, 'timestamps alone must not change the content identity');
  }
  await rename(join(site, 'assets', 'cover.png'), join(site, 'assets', 'renamed.png'));
  const renamed = await hash();
  assert.notEqual(renamed.full, original.full, 'asset paths also belong to the approved workspace');
  assert.notEqual(renamed.render, original.render);
});

test('workspace hashing cannot confuse embedded NUL bytes with file record delimiters', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const oneFile = await store.create('单文件');
  const twoFiles = await store.create('两个文件');
  // These workspaces produce identical streams with the unsafe historical
  // path + NUL + contents + NUL framing, despite different names and bytes.
  await writeFile(join(store.workspace(oneFile.id), 'a'), Buffer.from('x\0b\0y'));
  await writeFile(join(store.workspace(twoFiles.id), 'a'), 'x');
  await writeFile(join(store.workspace(twoFiles.id), 'b'), 'y');
  for (const options of [{}, { renderOnly: true }]) {
    assert.notEqual(await store.workspaceHash(oneFile.id, options), await store.workspaceHash(twoFiles.id, options));
  }
});

test('render hashes exclude design metadata while approval hashes still bind each record', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('设计元数据');
  const site = store.workspace(project.id);
  await writeFile(join(site, 'index.html'), '<h1>已预览方向</h1>');
  const render = await store.workspaceHash(project.id, { renderOnly: true });
  for (const file of ['DESIGN.md', 'DESIGN_REVIEW.json', 'DESIGN_PLAN.json']) {
    const before = await store.workspaceHash(project.id);
    await writeFile(join(site, file), `第一版 ${file}`);
    const first = await store.workspaceHash(project.id);
    assert.notEqual(first, before, `${file} creation must be included in the full hash`);
    assert.equal(await store.workspaceHash(project.id, { renderOnly: true }), render);
    await writeFile(join(site, file), `第二版 ${file}`);
    assert.notEqual(await store.workspaceHash(project.id), first, `${file} changes must invalidate approval`);
    assert.equal(await store.workspaceHash(project.id, { renderOnly: true }), render, `${file} alone does not change pixels`);
  }
  await writeFile(join(site, 'index.html'), '<h1>未经预览的新方向</h1>');
  assert.notEqual(await store.workspaceHash(project.id, { renderOnly: true }), render);
});

test('exports preserve local PNG and WOFF bytes but exclude secrets, hidden directories and dependencies', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('完整素材导出');
  const site = store.workspace(project.id);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const font = Buffer.from([119, 79, 70, 70, 0, 128, 255, 0]);
  const allowed = new Map([
    ['index.html', Buffer.from('<h1>中文页面</h1>')],
    ['assets/photo.png', png],
    ['assets/type.woff', font]
  ]);
  const refused = [
    '.env', '.hidden/photo.png', 'assets/.private/type.woff', 'node_modules/library.js',
    'assets/node_modules/photo.png', 'secrets.json', 'assets/credentials.json',
    'service_account.json', 'assets/id_ed25519', 'assets/private.key', 'archive.exe'
  ];
  for (const [name, bytes] of [...allowed, ...refused.map(name => [name, Buffer.from('PRIVATE')])]) {
    const parts = name.split('/');
    await mkdir(join(site, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(site, ...parts), bytes);
  }
  const exported = new Map((await store.exportEntries(project.id)).map(entry => [entry.name, entry.data]));
  assert.deepEqual([...exported.keys()].sort(), [...allowed.keys()].sort());
  for (const [name, bytes] of allowed) {
    assert(Buffer.isBuffer(exported.get(name)));
    assert.deepEqual(exported.get(name), bytes);
  }
  assert.deepEqual((await store.listFiles(project.id)).map(file => file.path), ['index.html']);
});

test('workspace hashes and exports reject a junction instead of silently following or omitting it', async t => {
  const folder = await fixture(t);
  const outside = join(folder, 'outside-assets');
  await mkdir(outside);
  await writeFile(join(outside, 'private.png'), Buffer.from([0, 255, 1]));
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('拒绝链接素材');
  await writeFile(join(store.workspace(project.id), 'index.html'), '<h1>页面</h1>');
  try { await symlink(outside, join(store.workspace(project.id), 'linked-assets'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Links unavailable.'); return; } throw error; }
  await assert.rejects(store.exportEntries(project.id), error => error.status === 403 && /链接/.test(error.message));
  await assert.rejects(store.workspaceHash(project.id), error => error.status === 403 && /链接/.test(error.message));
  await assert.rejects(store.workspaceHash(project.id, { renderOnly: true }), error => error.status === 403 && /链接/.test(error.message));
  assert.deepEqual(await readFile(join(outside, 'private.png')), Buffer.from([0, 255, 1]));
});

test('evidence reads use an exact filename allowlist and a validated UUID folder', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('方向截图读取');
  const currentId = 'a3333333-b333-4333-8333-c33333333333';
  const otherId = '44444444-4444-4444-8444-444444444444';
  const run = join(store.evidenceDir(project.id), currentId);
  const otherRun = join(store.evidenceDir(project.id), otherId);
  await mkdir(join(run, 'direction'), { recursive: true });
  await mkdir(join(otherRun, 'direction'), { recursive: true });
  const allowed = new Map([
    ['design-plan.json', Buffer.from('{"concept":"当前方向"}')],
    ['direction/desktop.png', Buffer.from([137, 80, 78, 71, 0, 1])],
    ['direction/desktop-detail.png', Buffer.from([137, 80, 78, 71, 0, 2])],
    ['direction/mobile.png', Buffer.from([137, 80, 78, 71, 0, 3])]
  ]);
  for (const [name, bytes] of allowed) await writeFile(join(run, ...name.split('/')), bytes);
  await writeFile(join(otherRun, 'direction', 'desktop.png'), 'OTHER RUN');
  await writeFile(join(run, 'state.json'), 'PRIVATE');
  for (const [name, bytes] of allowed) assert.deepEqual(await store.readEvidence(project.id, currentId, name), bytes);
  assert.deepEqual(await store.readEvidence(project.id, currentId.toUpperCase(), 'direction/desktop.png'), allowed.get('direction/desktop.png'));
  for (const file of [
    'state.json', '../state.json', `${otherId}/direction/desktop.png`, './design-plan.json',
    'DESIGN_PLAN.json', 'direction\\desktop.png', '/direction/desktop.png',
    'direction/../design-plan.json', 'direction/report.json', 'direction/desktop.png?raw=1',
    'direction/%2e%2e/state.json', 'direction/desktop.png\0'
  ]) {
    await assert.rejects(store.readEvidence(project.id, currentId, file), error => error.status === 404);
  }
  for (const id of ['', null, '../', `${currentId}/../${otherId}`, ` ${currentId} `, 'not-a-uuid', '33333333-3333-3333-8333-333333333333']) {
    await assert.rejects(store.readEvidence(project.id, id, 'direction/desktop.png'), error => error.status === 400);
  }
});

test('evidence refuses oversized allowed files and junctions in run or screenshot directories', async t => {
  const folder = await fixture(t);
  const store = new ProjectStore({ root: join(folder, 'data') });
  const project = await store.create('证据边界');
  const oversizedId = '55555555-5555-4555-8555-555555555555';
  const oversizedRun = join(store.evidenceDir(project.id), oversizedId);
  await mkdir(oversizedRun);
  await writeFile(join(oversizedRun, 'design-plan.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 1));
  await assert.rejects(store.readEvidence(project.id, oversizedId, 'design-plan.json'), error => error.status === 413);

  const outside = join(folder, 'outside-evidence');
  await mkdir(join(outside, 'direction'), { recursive: true });
  await writeFile(join(outside, 'design-plan.json'), 'PRIVATE PLAN');
  await writeFile(join(outside, 'direction', 'desktop.png'), 'PRIVATE IMAGE');
  const linkedRunId = '66666666-6666-4666-8666-666666666666';
  const linkedDirectionId = '77777777-7777-4777-8777-777777777777';
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  try { await symlink(outside, join(store.evidenceDir(project.id), linkedRunId), kind); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Links unavailable.'); return; } throw error; }
  await assert.rejects(store.readEvidence(project.id, linkedRunId, 'design-plan.json'), error => error.status === 403);
  await mkdir(join(store.evidenceDir(project.id), linkedDirectionId));
  await symlink(join(outside, 'direction'), join(store.evidenceDir(project.id), linkedDirectionId, 'direction'), kind);
  await assert.rejects(store.readEvidence(project.id, linkedDirectionId, 'direction/desktop.png'), error => error.status === 403);
  assert.equal(await readFile(join(outside, 'design-plan.json'), 'utf8'), 'PRIVATE PLAN');
});
