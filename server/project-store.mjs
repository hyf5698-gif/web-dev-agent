import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep, extname } from 'node:path';
import { mkdir, lstat, realpath, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['running', 'verifying', 'reviewing', 'awaiting_design', 'completed', 'needs_attention', 'failed', 'interrupted']);
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.svg', '.vue', '.svelte', '.xml', '.yaml', '.yml', '.webmanifest']);
const EXPORT_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav']);
const MAX_FILE = 1024 * 1024;
const MAX_RECORD = 8 * 1024 * 1024;
const MAX_FILES = 250;

export function storeError(message, status = 400, code = 'INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function within(root, target) {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

function secretPart(name) {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules'
    || /^(?:credentials|secrets?|service[-_]account)(?:[._-]|$)/i.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function fileParts(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\0:]/u.test(value) || value.startsWith('/')) {
    throw storeError('文件路径无效。');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || secretPart(part))) {
    throw storeError('不允许访问这个文件路径。', 403, 'PATH_REFUSED');
  }
  return parts;
}

function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw storeError(`${label}无效。`);
  return value.trim();
}

export class ProjectStore {
  constructor({ root }) {
    if (!root) throw new TypeError('ProjectStore requires a data root.');
    this.root = resolve(root);
    this.queues = new Map();
    this.ready = null;
  }

  async init() {
    if (!this.ready) this.ready = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storeError('数据目录不能是符号链接。', 403);
      this.realRoot = await realpath(this.root);
      return this;
    })().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  _id(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw storeError('项目编号无效。');
    return id.toLowerCase();
  }

  workspace(id) { return join(this.root, this._id(id), 'site'); }
  evidenceDir(id) { return join(this.root, this._id(id), 'evidence'); }

  _serial(id, operation) {
    const key = this._id(id);
    const next = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }

  async _directory(id, child) {
    await this.init();
    const canonicalRoot = await realpath(this.root);
    if (canonicalRoot !== this.realRoot) throw storeError('数据目录已发生变化。', 403);
    const project = join(this.root, this._id(id));
    const paths = child ? [project, join(project, child)] : [project];
    for (const path of paths) {
      const info = await lstat(path).catch(error => {
        if (error.code === 'ENOENT') throw storeError('项目不存在。', 404, 'NOT_FOUND');
        throw error;
      });
      if (!info.isDirectory() || info.isSymbolicLink() || !within(this.realRoot, await realpath(path))) {
        throw storeError('项目目录不安全。', 403, 'PATH_REFUSED');
      }
    }
    return realpath(paths.at(-1));
  }

  async _read(id, name) {
    const folder = await this._directory(id);
    const path = join(folder, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD) throw storeError('项目记录无效。', 500);
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async _write(id, name, value) {
    const folder = await this._directory(id);
    const destination = join(folder, name);
    const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw storeError('拒绝覆盖不安全的记录。', 403);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_RECORD) throw storeError('项目记录过大。', 413);
    const temporary = join(folder, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  _project(state) {
    const id = this._id(state.id);
    return { ...state, id, previewUrl: `/preview/${id}/` };
  }

  async create(name = '新网页项目') {
    await this.init();
    name = cleanText(name, 100, '项目名称');
    const id = randomUUID();
    const folder = join(this.root, id);
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, 'site'), { mode: 0o700 });
    await mkdir(join(folder, 'evidence'), { mode: 0o700 });
    const now = new Date().toISOString();
    const state = { id, name, workflow: 'design_first', status: 'needs_attention', phase: 'ready', createdAt: now, updatedAt: now };
    await this._write(id, 'state.json', state);
    await this._write(id, 'messages.json', []);
    await this._write(id, 'runs.json', []);
    return this._project(state);
  }

  async list() {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const result = [];
    for (const entry of entries.slice(0, 2000)) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try { result.push(await this.get(entry.name)); } catch { /* Ignore incomplete or invalid project records. */ }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) { return this._serial(id, async () => this._project(await this._read(id, 'state.json'))); }

  async update(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw storeError('项目更新无效。');
    return this._serial(id, async () => {
      const state = await this._read(id, 'state.json');
      if (Object.hasOwn(patch, 'name')) state.name = cleanText(patch.name, 100, '项目名称');
      if (Object.hasOwn(patch, 'status')) {
        if (!STATUSES.has(patch.status)) throw storeError('项目状态无效。');
        state.status = patch.status;
      }
      if (Object.hasOwn(patch, 'phase')) state.phase = cleanText(patch.phase, 100, '项目阶段');
      if (Object.hasOwn(patch, 'workflow')) {
        if (!['design_first', 'legacy'].includes(patch.workflow)) throw storeError('开发流程无效。');
        state.workflow = patch.workflow;
      }
      for (const field of ['designDraftId', 'designApprovedId']) {
        if (Object.hasOwn(patch, field)) {
          if (patch[field] === null) delete state[field];
          else state[field] = this._id(patch[field]);
        }
      }
      for (const field of ['designPlanHash', 'designRenderHash']) {
        if (Object.hasOwn(patch, field)) {
          if (patch[field] === null) delete state[field];
          else if (/^[a-f0-9]{64}$/.test(patch[field])) state[field] = patch[field];
          else throw storeError('设计摘要无效。');
        }
      }
      if (Object.hasOwn(patch, 'fileCount')) {
        if (!Number.isInteger(patch.fileCount) || patch.fileCount < 0 || patch.fileCount > MAX_FILES) throw storeError('文件数量无效。');
        state.fileCount = patch.fileCount;
      }
      if (Object.hasOwn(patch, 'lastValidation')) {
        const value = patch.lastValidation;
        if (!value || typeof value.ok !== 'boolean' || typeof value.reviewed !== 'boolean' || !Array.isArray(value.issues) || value.issues.length > 20 || value.issues.some(issue => typeof issue !== 'string' || issue.length > 6000) || !/^[a-f0-9]{64}$/.test(value.sourceHash)) throw storeError('检查结果无效。');
        state.lastValidation = { ok: value.ok, reviewed: value.reviewed, issues: value.issues, sourceHash: value.sourceHash };
      }
      for (const field of ['threadId', 'activeRunId', 'lastError']) {
        if (Object.hasOwn(patch, field)) {
          if (patch[field] === null) delete state[field];
          else state[field] = cleanText(patch[field], field === 'lastError' ? 4000 : 200, field);
        }
      }
      state.updatedAt = new Date().toISOString();
      await this._write(id, 'state.json', state);
      return this._project(state);
    });
  }

  async addMessage(id, input) {
    if (!input || !['user', 'assistant', 'system', 'tool'].includes(input.role)) throw storeError('消息角色无效。');
    const text = cleanText(input.text, 50000, '消息');
    return this._serial(id, async () => {
      const messages = await this._read(id, 'messages.json');
      const message = { ...input, id: randomUUID(), role: input.role, text, createdAt: new Date().toISOString() };
      messages.push(message);
      await this._write(id, 'messages.json', messages);
      const state = await this._read(id, 'state.json');
      state.updatedAt = message.createdAt;
      await this._write(id, 'state.json', state);
      return message;
    });
  }

  async loadMessages(id) { return this._serial(id, () => this._read(id, 'messages.json')); }

  async appendRun(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw storeError('运行记录无效。');
    return this._serial(id, async () => {
      const runs = await this._read(id, 'runs.json');
      const record = { ...input, id: input.id || randomUUID(), createdAt: input.createdAt || new Date().toISOString() };
      runs.push(record);
      await this._write(id, 'runs.json', runs);
      return record;
    });
  }

  async loadRuns(id) { return this._serial(id, () => this._read(id, 'runs.json')); }

  async _safeFile(root, parts, maxBytes) {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !within(root, await realpath(path))) throw storeError('文件路径不安全。', 403);
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes) throw storeError('文件类型或大小不受支持。', 413);
    return readFile(path);
  }

  async readEvidence(id, runId, file) {
    const names = new Set(['design-plan.json', 'direction/desktop.png', 'direction/desktop-detail.png', 'direction/mobile.png']);
    if (!names.has(file)) throw storeError('设计预览不存在。', 404);
    const root = await this._directory(id, 'evidence');
    return this._safeFile(root, [this._id(runId), ...file.split('/')], 16 * MAX_FILE);
  }

  async assetExists(id, path) {
    try { await this._safeFile(await this._directory(id, 'site'), fileParts(path), 20 * MAX_FILE); return true; }
    catch { return false; }
  }

  async exportEntries(id) {
    const root = await this._directory(id, 'site');
    const entries = [];
    let examined = 0, bytes = 0;
    const walk = async (folder, parts, depth) => {
      if (depth > 12) throw storeError('项目目录层级过深。', 413);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (secretPart(entry.name)) continue;
        if (++examined > 3000) throw storeError('项目文件过多。', 413);
        if (entry.isSymbolicLink()) throw storeError('项目包含不安全的链接。', 403);
        const pathParts = [...parts, entry.name];
        if (entry.isDirectory()) await walk(join(folder, entry.name), pathParts, depth + 1);
        else if (entry.isFile() && EXPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          const data = await this._safeFile(root, pathParts, 20 * MAX_FILE);
          if ((bytes += data.length) > 20 * MAX_FILE) throw storeError('源码包过大，请从本地项目目录获取。', 413);
          entries.push({ name: pathParts.join('/'), data });
        }
      }
    };
    await walk(root, [], 0);
    return entries;
  }

  // Approval binds all preview resources, including binary images and fonts.
  async workspaceHash(id, { renderOnly = false } = {}) {
    const root = await this._directory(id, 'site');
    const hash = createHash('sha256');
    let count = 0, bytes = 0;
    const walk = async (folder, parts, depth) => {
      if (depth > 12) throw storeError('项目目录层级过深。', 413);
      const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (secretPart(entry.name)) continue;
        if (++count > 3000) throw storeError('项目文件过多。', 413);
        const pathParts = [...parts, entry.name], path = join(folder, entry.name);
        if (entry.isSymbolicLink()) throw storeError('项目包含不安全的链接。', 403);
        if (entry.isDirectory()) await walk(path, pathParts, depth + 1);
        else if (entry.isFile()) {
          if (renderOnly && ['DESIGN.md', 'DESIGN_REVIEW.json', 'DESIGN_PLAN.json'].includes(pathParts.join('/'))) continue;
          const data = await this._safeFile(root, pathParts, 20 * MAX_FILE);
          if ((bytes += data.length) > 40 * MAX_FILE) throw storeError('项目素材超过检查上限。', 413);
          hash.update(JSON.stringify([pathParts.join('/'), createHash('sha256').update(data).digest('hex')])).update('\n');
        }
      }
    };
    await walk(root, [], 0);
    return hash.digest('hex');
  }

  async listFiles(id) {
    const root = await this._directory(id, 'site');
    const result = [];
    let examined = 0;
    let bytesRead = 0;
    const walk = async (folder, parts, depth) => {
      if (depth > 8 || result.length >= MAX_FILES || examined >= 3000) return;
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (++examined > 3000 || result.length >= MAX_FILES) break;
        if (secretPart(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(folder, entry.name);
        const actual = await realpath(path).catch(() => null);
        if (!actual || !within(root, actual)) continue;
        if (entry.isDirectory()) await walk(path, [...parts, entry.name], depth + 1);
        else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          const info = await lstat(path);
          if (info.isSymbolicLink() || info.size > MAX_FILE || bytesRead + info.size > 8 * MAX_FILE) continue;
          const sample = await readFile(path);
          bytesRead += sample.length;
          if (sample.includes(0)) continue;
          result.push({ path: [...parts, entry.name].join('/'), bytes: info.size, updatedAt: info.mtime.toISOString() });
        }
      }
    };
    await walk(root, [], 0);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(id, value) {
    const parts = fileParts(value);
    if (!TEXT_EXTENSIONS.has(extname(parts.at(-1)).toLowerCase())) throw storeError('不支持查看这个文件类型。', 415);
    const root = await this._directory(id, 'site');
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      const info = await lstat(path).catch(error => {
        if (error.code === 'ENOENT') throw storeError('文件不存在。', 404, 'NOT_FOUND');
        throw error;
      });
      if (info.isSymbolicLink() || !within(root, await realpath(path))) throw storeError('不允许访问符号链接。', 403);
    }
    const info = await lstat(path);
    if (!info.isFile()) throw storeError('不是可读取的文件。', 404);
    if (info.size > MAX_FILE) throw storeError('文件超过1MB查看上限。', 413);
    const buffer = await readFile(path);
    if (buffer.length > MAX_FILE || buffer.includes(0)) throw storeError('不支持查看二进制或过大的文件。', 415);
    return { path: parts.join('/'), content: buffer.toString('utf8'), bytes: buffer.length };
  }
}
