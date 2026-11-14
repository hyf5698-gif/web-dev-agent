import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { serveStatic } from '../server/static-files.mjs';

async function fixture(t) {
  const base = resolve(tmpdir());
  const folder = await mkdtemp(join(base, 'web-agent-static-test-'));
  t.after(async () => {
    const target = resolve(folder);
    const part = relative(base, target);
    assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return folder;
}

async function serverFor(t, root) {
  const server = http.createServer((req, res) => { serveStatic(req, res, { root, pathname: req.url.split('?')[0], preview: true }).catch(error => res.destroy(error)); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    const closed = new Promise(done => server.close(done));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

function request(port, path, method = 'GET') {
  return new Promise((done, fail) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => done({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once('error', fail);
    req.end();
  });
}

test('preview serves indexes, HEAD and modules with isolation headers', async t => {
  const folder = await fixture(t);
  await writeFile(join(folder, 'index.html'), '<h1>本地预览</h1>');
  await writeFile(join(folder, 'app.js'), 'export const x = 1;');
  await mkdir(join(folder, 'nested'));
  await writeFile(join(folder, 'nested', 'index.html'), 'Nested index');
  await mkdir(join(folder, 'empty'));
  const port = await serverFor(t, folder);
  const index = await request(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /本地预览/);
  assert.match(index.headers['content-security-policy'], /connect-src 'none'/);
  assert.match(index.headers['content-security-policy'], /form-action 'none'/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(index.headers['access-control-allow-origin'], '*');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-store');
  const head = await request(port, '/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength('<h1>本地预览</h1>')));
  assert.match((await request(port, '/app.js')).headers['content-type'], /text\/javascript/);
  assert.equal((await request(port, '/nested/')).body, 'Nested index');
  assert.equal((await request(port, '/empty/')).status, 404);
  assert.equal((await request(port, '/', 'POST')).status, 405);
});

test('raw encoded traversal, secret paths and unsupported types are refused', async t => {
  const folder = await fixture(t);
  const root = join(folder, 'site');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), 'OK');
  await writeFile(join(folder, 'outside.txt'), 'PRIVATE');
  await writeFile(join(root, '.env'), 'PRIVATE');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'PRIVATE');
  await writeFile(join(root, 'credentials.json'), 'PRIVATE');
  await writeFile(join(root, 'key.pem'), 'PRIVATE');
  const port = await serverFor(t, root);
  for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/.env', '/.git/config', '/credentials.json', '/key.pem']) {
    const response = await request(port, path);
    assert.equal(response.status, 403, path);
    assert(!response.body.includes('PRIVATE'));
  }
  assert.equal((await request(port, '/%5c..%5coutside.txt')).status, 400);
  assert.equal((await request(port, '/index.html:stream')).status, 400);
  assert.equal((await request(port, '/%zz')).status, 400);
});

test('preview refuses junction escapes', async t => {
  const folder = await fixture(t);
  const root = join(folder, 'site');
  const outside = join(folder, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'outside.txt'), 'PRIVATE');
  try { await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Links unavailable.'); return; } throw error; }
  const port = await serverFor(t, root);
  const response = await request(port, '/escape/outside.txt');
  assert.equal(response.status, 403);
  assert(!response.body.includes('PRIVATE'));
});
