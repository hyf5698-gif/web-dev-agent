import http from 'node:http';
import { realpath, stat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname, join } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4'
};

export function isWithin(root, path) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export async function startStaticServer({ root, port = 0 }) {
  const realRoot = await realpath(resolve(root));
  if (!(await stat(realRoot)).isDirectory()) throw new Error('Static root must be a directory.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const end = (status, message) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      end(405, 'Method not allowed'); return;
    }
    let decoded;
    try { decoded = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { end(400, 'Malformed path'); return; }
    if (!decoded.startsWith('/') || /[\\\0:]/u.test(decoded)) {
      end(400, 'Invalid path'); return;
    }
    if (decoded.split('/').includes('..')) { end(403, 'Path traversal refused'); return; }
    let handle;
    try {
      let requested = resolve(realRoot, `.${decoded}`);
      if (!isWithin(realRoot, requested)) { end(403, 'Path traversal refused'); return; }
      let resolved = await realpath(requested);
      if (!isWithin(realRoot, resolved)) { end(403, 'Symlink escape refused'); return; }
      if ((await stat(resolved)).isDirectory()) {
        requested = join(resolved, 'index.html');
        resolved = await realpath(requested);
        if (!isWithin(realRoot, resolved)) { end(403, 'Symlink escape refused'); return; }
      }
      handle = await open(resolved, 'r');
      const details = await handle.stat();
      if (!details.isFile()) { end(404, 'Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[extname(resolved).toLowerCase()] || 'application/octet-stream',
        'Content-Length': details.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = handle.createReadStream({ autoClose: false });
      // A disconnected client must not leave a file read running.
      res.on('close', () => stream.destroy());
      await new Promise((done, fail) => {
        stream.once('error', fail);
        res.once('error', fail);
        res.once('finish', done);
        res.once('close', done);
        stream.pipe(res);
      });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) end(404, 'Not found');
      else if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) end(403, 'Access refused');
      else end(500, 'Static file error');
    } finally { await handle?.close().catch(() => {}); }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return {
    root: realRoot,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: async () => {
      const stopped = new Promise(done => server.close(done));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await stopped;
    }
  };
}
