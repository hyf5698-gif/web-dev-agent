import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

const PREVIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'self'";

function within(root, path) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

function forbidden(part) {
  return part.startsWith('.') || part.toLowerCase() === 'node_modules'
    || /^(?:credentials|secrets?|service[-_]account)(?:[._-]|$)/i.test(part)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part);
}

export async function serveStatic(req, res, { root, pathname = '/', preview = false, frameAncestor }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (preview) {
    const ancestor = /^http:\/\/127\.0\.0\.1:\d+$/.test(frameAncestor || '') ? frameAncestor : "'self'";
    res.setHeader('Content-Security-Policy', PREVIEW_CSP.replace("frame-ancestors 'self'", `frame-ancestors ${ancestor}`));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  const end = (status, message) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : message);
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    end(405, 'Method not allowed');
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { end(400, 'Malformed path'); return; }
  if (typeof decoded !== 'string' || !decoded.startsWith('/') || /[\\\0:]/u.test(decoded)) {
    end(400, 'Invalid path'); return;
  }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.' || forbidden(part))) { end(403, 'Path refused'); return; }
  let handle;
  try {
    const originalRoot = resolve(root);
    const rootInfo = await lstat(originalRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) { end(403, 'Unsafe root'); return; }
    const actualRoot = await realpath(originalRoot);
    let target = actualRoot;
    for (const part of parts) {
      target = join(target, part);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !within(actualRoot, await realpath(target))) { end(403, 'Path refused'); return; }
    }
    if ((await lstat(target)).isDirectory()) target = join(target, 'index.html');
    const info = await lstat(target);
    if (!info.isFile()) { end(404, 'Not found'); return; }
    if (info.isSymbolicLink() || !within(actualRoot, await realpath(target))) { end(403, 'Path refused'); return; }
    const mime = MIME[extname(target).toLowerCase()];
    if (!mime) { end(403, 'File type refused'); return; }
    if (info.size > 32 * 1024 * 1024) { end(413, 'File too large'); return; }
    handle = await open(target, 'r');
    const opened = await handle.stat();
    if (!opened.isFile()) { end(404, 'Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': opened.size });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = handle.createReadStream({ autoClose: false });
    res.once('close', () => stream.destroy());
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
}
