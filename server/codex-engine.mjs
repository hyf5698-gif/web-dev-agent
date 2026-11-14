import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const TERMINAL = new Set(['completed', 'interrupted', 'failed']);
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput'
]);
const safeText = value => String(value ?? '').replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
  .replace(/\bsk-[\w-]+/gu, '[redacted key]')
  .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[redacted email]').slice(0, 1600);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Notifications can settle a turn before the turn/start response arrives.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/** Local Codex app-server adapter. No model is selected or inference run by start/health. */
export class CodexEngine {
  constructor({ onApproval, childFactory = spawn, command = process.env.CODEX_BINARY || 'codex',
    requestTimeoutMs = 30000, interruptTimeoutMs = 8000 } = {}) {
    this.onApproval = onApproval;
    this.childFactory = childFactory;
    this.command = command;
    this.requestTimeoutMs = requestTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.pending = new Map();
    this.approvals = new Map();
    this.threadDirectories = new Map();
    this.nextId = 1;
    this.started = false;
    this.closed = false;
    this.busy = false;
  }

  async start() {
    if (this.closed) throw new Error('Codex engine is closed.');
    if (this.failure) throw this.failure;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.child = this.childFactory(this.command, ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || join(homedir(), '.codex') }
      });
      this.exited = deferred();
      this.child.once('error', error => this._fail(new Error(`Cannot start Codex: ${safeText(error.message)}`)));
      this.child.once('close', (code, signal) => {
        this.exited.resolve();
        if (!this.closed) this._fail(new Error(`Codex app-server exited (${signal || code}).`));
      });
      // Keep diagnostics bounded; never emit complete environment or auth responses.
      this.child.stderr?.setEncoding('utf8');
      this.child.stderr?.on('data', chunk => { this.stderrTail = `${this.stderrTail || ''}${chunk}`.slice(-4000); });
      this.child.stdin.on('error', error => this._fail(new Error(`Codex input closed: ${safeText(error.message)}`)));
      this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      this.lines.on('error', error => this._fail(new Error(`Codex output closed: ${safeText(error.message)}`)));
      this.lines.on('line', line => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); }
        catch { this._fail(new Error('Codex app-server returned invalid JSONL.')); void this.close(); return; }
        try { this._receive(message); }
        catch (error) { this._fail(error); void this.close(); }
      });
      const response = await this._rpc('initialize', {
        clientInfo: { name: 'web_dev_agent', title: '网页开发 Agent', version: '0.3.0' }
      });
      this.version = response.userAgent?.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/u)?.[0];
      this._write({ method: 'initialized', params: {} });
      this.started = true;
      return this;
    })().catch(async error => { await this.close(); throw error; });
    return this.startPromise;
  }

  async health() {
    try {
      await this.start();
      const response = await this._rpc('account/read', { refreshToken: false });
      const authenticated = Boolean(response.account);
      return {
        available: true, authenticated,
        message: authenticated ? 'Codex 已登录；实际模型运行尚需验证。'
          : response.requiresOpenaiAuth ? 'Codex 可用，请先在本机登录。'
            : 'Codex 可用；当前提供商未要求 OpenAI 登录，模型访问尚未验证。',
        ...(this.model ? { model: this.model } : {}),
        ...(this.version ? { version: this.version } : {})
      };
    } catch (error) {
      return { available: false, authenticated: false, message: safeText(error.message),
        ...(this.version ? { version: this.version } : {}) };
    }
  }

  async listModels() {
    await this.start();
    const response = await this._rpc('model/list', {});
    return (response.data || []).map(model => ({
      id: model.id, model: model.model, displayName: model.displayName,
      isDefault: Boolean(model.isDefault), inputModalities: model.inputModalities || ['text']
    }));
  }

  async run({ threadId, cwd, prompt, images = [], onEvent = () => {}, signal } = {}) {
    if (this.busy) throw new Error('Codex engine already has an active run.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A nonempty prompt is required.');
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('cwd must be an absolute project directory.');
    if (!Array.isArray(images) || images.some(path => typeof path !== 'string' || !isAbsolute(path))) {
      throw new Error('images must contain absolute local image paths.');
    }
    signal?.throwIfAborted();
    this.busy = true;
    let active;
    const abort = () => {
      if (active) { active.abortRequested = true; this._interrupt(active); }
    };
    try {
      const project = await realpath(resolve(cwd));
      if (!(await stat(project)).isDirectory()) throw new Error('cwd must be an existing directory.');
      if (threadId && this.threadDirectories.has(threadId) && this.threadDirectories.get(threadId) !== project) {
        throw new Error('This thread belongs to a different project directory.');
      }
      await this.start();
      signal?.throwIfAborted();
      const threadOptions = {
        cwd: project, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        developerInstructions: '你是本地网页开发应用的执行组件。使用本地文件与命令工具直接完成项目；不启动子Agent，不操作宿主桌面或云端网站服务。先交付当前项目中的真实文件，避免把时间耗在编排工具和泛泛规划上。浏览器渲染与截图由宿主提供。'
      };
      const response = await this._rpc(threadId ? 'thread/resume' : 'thread/start', {
        ...threadOptions, ...(threadId ? { threadId } : {})
      });
      threadId = response.thread?.id || threadId;
      if (!threadId) throw new Error('Codex did not return a thread ID.');
      this.threadDirectories.set(threadId, project);
      if (response.model) this.model = response.model;
      active = {
        threadId, turnId: null, messages: new Map(), done: deferred(), onEvent,
        abortRequested: false, settled: false
      };
      this.active = active;
      this._emit(active, { type: 'activity', kind: 'thread', message: '已连接项目执行会话', threadId });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) active.abortRequested = true;
      if (active.abortRequested) signal.throwIfAborted();
      active.turnRequested = true;
      const turnResponse = await this._rpc('turn/start', {
        threadId, cwd: project, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        effort: 'medium',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project], networkAccess: false },
        input: [{ type: 'text', text: prompt }, ...images.map(path => ({ type: 'localImage', path }))]
      });
      active.turnId ||= turnResponse.turn?.id;
      if (!active.turnId) throw new Error('Codex did not return a turn ID.');
      if (TERMINAL.has(turnResponse.turn?.status)) this._finish(active, turnResponse.turn);
      if (active.abortRequested && !active.settled) this._interrupt(active);
      return await active.done.promise;
    } catch (error) {
      // A failed RPC can leave an unknown live turn; terminate our owned runtime rather than abandon it.
      if (active?.turnRequested && !active.settled) await this.close();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (active) {
        clearTimeout(active.interruptTimer);
        this._clearApprovals(active);
        if (this.active === active) this.active = null;
      }
      this.busy = false;
    }
  }

  /** Respond only to an explicit user decision; no constructor callback return auto-approves. */
  respondApproval(id, decision) {
    if (!['accept', 'decline'].includes(decision)) throw new Error('Approval decision must be accept or decline.');
    const pending = this.approvals.get(String(id));
    if (!pending) throw new Error('This approval is no longer pending.');
    let result;
    if (pending.method === 'item/permissions/requestApproval') {
      // Grant exactly the requested subset for this turn, without persisting a rule.
      result = { permissions: decision === 'accept' ? pending.params.permissions : {}, scope: 'turn' };
    } else if (pending.method === 'mcpServer/elicitation/request') {
      if (decision === 'accept') throw new Error('MCP elicitation needs a structured response; decline is supported.');
      result = { action: 'decline', content: null };
    } else if (pending.method === 'item/tool/requestUserInput') {
      if (decision === 'accept') throw new Error('This request needs text answers; decline is supported.');
      result = { answers: {} };
    } else result = { decision };
    this._write({ id: pending.id, result });
    this.approvals.delete(String(id));
    this._emit(this.active, { type: 'activity', kind: 'approval', status: 'resolved', approvalId: pending.id });
    return { accepted: true };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      this.started = false;
      this._fail(new Error('Codex engine closed.'));
      this.approvals.clear();
      const child = this.child;
      if (!child) return;
      child.stdin?.end();
      let timer;
      await Promise.race([
        this.exited?.promise,
        new Promise(done => { timer = setTimeout(done, 1500); })
      ]);
      clearTimeout(timer);
      if (child.exitCode == null && child.signalCode == null) child.kill();
      this.lines?.close();
    })();
    return this.closePromise;
  }

  _write(message) {
    if (!this.child?.stdin?.writable || this.child.stdin.destroyed) throw new Error('Codex transport is not writable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _rpc(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex engine is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  _receive(message) {
    if (message.method && Object.hasOwn(message, 'id')) { this._serverRequest(message); return; }
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(safeText(message.error.message || 'Codex RPC failed.'));
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.method === 'serverRequest/resolved') {
      this.approvals.delete(String(params.requestId));
      this._emit(this.active, { type: 'activity', kind: 'approval', status: 'resolved', approvalId: params.requestId });
      return;
    }
    const active = this.active;
    if (!active || (params.threadId && params.threadId !== active.threadId)
      || (params.turnId && active.turnId && params.turnId !== active.turnId)) return;
    const common = { threadId: active.threadId, turnId: params.turnId || active.turnId, itemId: params.itemId };
    if (message.method === 'turn/started') {
      active.turnId ||= params.turn?.id;
      this._emit(active, { type: 'activity', kind: 'turn', status: 'started', ...common, turnId: active.turnId });
      if (active.abortRequested) this._interrupt(active);
    } else if (message.method === 'turn/completed') {
      if (active.turnId && params.turn?.id !== active.turnId) return;
      active.turnId ||= params.turn?.id;
      this._finish(active, params.turn);
    } else if (message.method === 'item/agentMessage/delta') {
      const item = active.messages.get(params.itemId) || { text: '' };
      item.text += params.delta || '';
      active.messages.set(params.itemId, item);
      this._emit(active, { type: 'message.delta', ...common, delta: params.delta || '', text: params.delta || '' });
    } else if (['item/started', 'item/completed'].includes(message.method)) {
      const item = params.item || {};
      if (item.type === 'agentMessage') this._recordMessage(active, item, message.method === 'item/completed');
      else this._emit(active, {
        type: 'activity', ...common, itemId: item.id, method: message.method,
        kind: item.type || 'tool', status: item.status || (message.method === 'item/started' ? 'running' : 'completed'),
        text: item.command || (item.changes ? item.changes.map(change => change.path).join('\n') : item.tool || ''),
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {})
      });
    } else if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress'].includes(message.method)) {
      this._emit(active, { type: 'activity', ...common, method: message.method, kind: 'tool-output',
        text: params.delta || params.message || '', status: 'running' });
    } else if (message.method === 'turn/plan/updated') {
      this._emit(active, { type: 'activity', ...common, method: message.method, kind: 'plan', plan: params.plan || [] });
    } else if (message.method === 'error') {
      this._emit(active, { type: 'activity', ...common, kind: 'error', text: safeText(params.error?.message || params.message) });
    }
  }

  _serverRequest(message) {
    if (!APPROVAL_METHODS.has(message.method)) {
      this._write({ id: message.id, error: { code: -32601, message: 'This client does not implement that server request.' } });
      this._emit(this.active, { type: 'activity', kind: 'unsupported-request', method: message.method });
      return;
    }
    const approval = { type: 'approval', id: message.id, method: message.method, params: message.params || {},
      threadId: message.params?.threadId, turnId: message.params?.turnId };
    this.approvals.set(String(message.id), { ...message, params: message.params || {} });
    this._emit(this.active, approval);
    try { Promise.resolve(this.onApproval?.(approval)).catch(() => {}); } catch { /* Remains pending. */ }
  }

  _recordMessage(active, item, completed) {
    const previous = active.messages.get(item.id);
    if (completed && item.text && !previous?.text) {
      this._emit(active, { type: 'message.delta', threadId: active.threadId, turnId: active.turnId,
        itemId: item.id, delta: item.text, text: item.text });
    }
    active.messages.set(item.id, {
      text: completed ? (item.text || previous?.text || '') : (previous?.text || ''),
      phase: item.phase || previous?.phase
    });
  }

  _finish(active, turn) {
    if (!turn || !TERMINAL.has(turn.status) || active.settled) return;
    for (const item of turn.items || []) if (item.type === 'agentMessage') this._recordMessage(active, item, true);
    active.settled = true;
    clearTimeout(active.interruptTimer);
    this._clearApprovals(active);
    const messages = [...active.messages.values()];
    const finalMessages = messages.filter(item => item.phase === 'final_answer');
    const finalResponse = (finalMessages.length ? finalMessages : messages.slice(-1)).map(item => item.text).join('\n\n');
    this._emit(active, { type: 'activity', kind: 'turn', status: turn.status, threadId: active.threadId,
      turnId: turn.id, ...(turn.error ? { text: safeText(turn.error.message) } : {}) });
    active.done.resolve({ threadId: active.threadId, turnId: turn.id, status: turn.status, finalResponse,
      ...(turn.error ? { error: safeText(turn.error.message) } : {}) });
  }

  _interrupt(active) {
    if (!active.turnId || active.settled || active.interrupting) return;
    active.interrupting = true;
    active.interruptTimer = setTimeout(() => {
      active.done.reject(new Error('Codex did not confirm interruption; the engine was closed.'));
      void this.close();
    }, this.interruptTimeoutMs);
    void this._rpc('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(error => {
      if (!active.settled) { active.done.reject(error); void this.close(); }
    });
  }

  _clearApprovals(active) {
    for (const [id, request] of this.approvals) {
      if (request.params.threadId === active.threadId && (!request.params.turnId || request.params.turnId === active.turnId)) {
        this.approvals.delete(id);
      }
    }
  }

  _emit(active, event) {
    try { Promise.resolve(active?.onEvent(event)).catch(() => {}); } catch { /* UI callbacks cannot corrupt RPC state. */ }
  }

  _fail(error) {
    this.failure = error;
    this.started = false;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    if (this.active && !this.active.settled) this.active.done.reject(error);
  }
}
