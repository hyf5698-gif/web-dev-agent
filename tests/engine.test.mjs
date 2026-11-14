import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexEngine } from '../server/codex-engine.mjs';

function mockChild(handler = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sent = [];
  child.exitCode = null;
  child.signalCode = null;
  child.send = (message, fragmented = false) => {
    if (child.exitCode !== null || child.stdout.writableEnded) return;
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    if (fragmented) {
      for (let index = 0; index < bytes.length; index += 7) child.stdout.write(bytes.subarray(index, index + 7));
    } else child.stdout.write(bytes);
  };
  child.notify = (method, params, fragmented) => child.send({ method, params }, fragmented);
  child.reply = (request, result, fragmented) => child.send({ id: request.id, result }, fragmented);
  const finish = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end(); child.stderr.end();
    queueMicrotask(() => child.emit('close', 0, null));
  };
  child.kill = () => { child.killed = true; finish(); return true; };
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        child.sent.push(request);
        queueMicrotask(() => {
          if (request.method === 'initialize') child.reply(request, { userAgent: 'codex_cli_rs/0.167.0-alpha.4.1',
            codexHome: '/not-returned-to-ui', platformFamily: 'windows', platformOs: 'windows' }, true);
          else handler(request, child);
        });
      }
      done();
    },
    final(done) { finish(); done(); }
  });
  child.factory = (command, args, options) => {
    child.spawnArguments = { command, args, options };
    return child;
  };
  return child;
}

async function until(predicate) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise(done => setImmediate(done));
  }
  throw new Error('Expected mock protocol event was not received.');
}

function engineFor(t, child, options = {}) {
  const engine = new CodexEngine({ childFactory: child.factory, requestTimeoutMs: 1000, ...options });
  t.after(() => engine.close());
  return engine;
}

test('initialize handles fragmented JSONL; health exposes status without account details', async t => {
  const child = mockChild((request, process) => {
    if (request.method === 'account/read') process.reply(request, {
      account: { type: 'chatgpt', email: 'private@example.com', accessToken: 'fixture-secret' }, requiresOpenaiAuth: true
    }, true);
    if (request.method === 'model/list') process.reply(request, { data: [{
      id: 'configured-default', model: 'configured-default', displayName: '配置中的模型', isDefault: true,
      inputModalities: ['text', 'image'], ignoredPrivateValue: 'not-exported'
    }] });
  });
  const engine = engineFor(t, child);
  await Promise.all([engine.start(), engine.start()]);
  const health = await engine.health();
  assert.equal(health.available, true);
  assert.equal(health.authenticated, true);
  assert.equal(health.version, '0.167.0-alpha.4.1');
  assert(!JSON.stringify(health).includes('private@example.com'));
  assert(!JSON.stringify(health).includes('fixture-secret'));
  assert.equal(child.sent.filter(item => item.method === 'initialize').length, 1);
  assert.equal(child.sent[1].method, 'initialized');
  assert.equal(child.spawnArguments.options.windowsHide, true);
  assert.equal(child.spawnArguments.options.env.CODEX_HOME, process.env.CODEX_HOME || join(homedir(), '.codex'));
  const models = await engine.listModels();
  assert.equal(models[0].displayName, '配置中的模型');
  assert(!JSON.stringify(models).includes('not-exported'));
  assert(!child.sent.some(item => item.method === 'turn/start'));
});

test('sequential runs resume the exact thread, preserve configured model and require turn completion', async t => {
  let turn = 0;
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start' || request.method === 'thread/resume') {
      process.reply(request, { thread: { id: 'thread-1' }, model: 'user-configured-model' });
    }
    if (request.method === 'turn/start') {
      turn += 1;
      process.reply(request, { turn: { id: `turn-${turn}`, status: 'inProgress', items: [] } });
    }
  });
  const engine = engineFor(t, child);
  const events = [];
  let finished = false;
  const first = engine.run({ cwd: tmpdir(), prompt: '创建中文网页', images: [join(tmpdir(), 'initial.png')],
    onEvent: event => events.push(event) }).then(result => { finished = true; return result; });
  await until(() => turn === 1);
  const firstTurn = child.sent.find(item => item.method === 'turn/start');
  assert.equal(firstTurn.params.input[1].type, 'localImage');
  assert.equal(firstTurn.params.approvalPolicy, 'on-request');
  assert.equal(firstTurn.params.approvalsReviewer, 'user');
  assert.equal(firstTurn.params.sandboxPolicy.type, 'workspaceWrite');
  assert(!Object.hasOwn(firstTurn.params, 'model'));
  child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'tool-1', type: 'commandExecution', command: 'node --check app.js', status: 'completed', exitCode: 0 } });
  await new Promise(done => setImmediate(done));
  assert.equal(finished, false, 'A successful tool is not a successful turn.');
  child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '页面已完成' }, true);
  child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'message-1', type: 'agentMessage', phase: 'final_answer', text: '页面已完成' } });
  child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
  assert.deepEqual(await first, { threadId: 'thread-1', turnId: 'turn-1', status: 'completed', finalResponse: '页面已完成' });
  assert(events.some(event => event.threadId === 'thread-1' && event.message === '已连接项目执行会话'));
  assert(events.some(event => event.type === 'message.delta' && event.delta === '页面已完成'));
  const second = engine.run({ threadId: 'thread-1', cwd: tmpdir(), prompt: '修改配色' });
  await until(() => turn === 2);
  const resumed = child.sent.find(item => item.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thread-1');
  assert.equal(resumed.params.sandbox, 'workspace-write');
  assert(!Object.hasOwn(resumed.params, 'model'));
  child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [
    { id: 'message-2', type: 'agentMessage', phase: 'final_answer', text: '配色已修改' }
  ] } });
  assert.equal((await second).finalResponse, '配色已修改');
  assert.equal(child.sent.filter(item => item.method === 'initialize').length, 1);
});

test('a completed notification arriving before the turn/start response is retained', async t => {
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'early-thread' } });
    if (request.method === 'turn/start') {
      process.notify('turn/completed', { threadId: 'early-thread', turn: { id: 'early-turn', status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', text: '先到的结果', phase: 'final_answer' }] } });
      process.reply(request, { turn: { id: 'early-turn', status: 'inProgress', items: [] } });
    }
  });
  const engine = engineFor(t, child);
  const result = await engine.run({ cwd: tmpdir(), prompt: '测试通知顺序' });
  assert.equal(result.finalResponse, '先到的结果');
  assert.equal(result.status, 'completed');
});

test('failed turns remain failed even after successful command events', async t => {
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'failed-thread' } });
    if (request.method === 'turn/start') {
      process.reply(request, { turn: { id: 'failed-turn', status: 'inProgress', items: [] } });
      process.notify('item/completed', { threadId: 'failed-thread', turnId: 'failed-turn',
        item: { type: 'commandExecution', id: 'tool', command: 'build', status: 'completed', exitCode: 0 } });
      process.notify('turn/completed', { threadId: 'failed-thread', turn: {
        id: 'failed-turn', status: 'failed', items: [], error: { message: 'provider unavailable' }
      } });
    }
  });
  const engine = engineFor(t, child);
  const result = await engine.run({ cwd: tmpdir(), prompt: '测试失败' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'provider unavailable');
});

test('approval stays pending until an explicit decision and grants no persistent permissions', async t => {
  let started = false;
  const seen = [];
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'approval-thread' } });
    if (request.method === 'turn/start') { started = true; process.reply(request, { turn: { id: 'approval-turn', status: 'inProgress' } }); }
  });
  const engine = engineFor(t, child, { onApproval: event => { seen.push(event); return 'accept'; } });
  const running = engine.run({ cwd: tmpdir(), prompt: '测试审批', onEvent: event => seen.push(event) });
  await until(() => started);
  child.send({ id: 900, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'approval-thread', turnId: 'approval-turn', command: 'npm install', reason: 'network access' } });
  await new Promise(done => setImmediate(done));
  assert(!child.sent.some(item => item.id === 900), 'A callback return must not silently approve.');
  assert(seen.some(event => event.type === 'approval' && event.id === 900));
  assert.throws(() => engine.respondApproval(900, 'acceptForSession'), /accept or decline/u);
  engine.respondApproval('900', 'decline');
  assert.deepEqual(child.sent.find(item => item.id === 900).result, { decision: 'decline' });
  const requested = { network: { enabled: true }, fileSystem: { write: [join(tmpdir(), 'explicit-only')] } };
  child.send({ id: 'permission-request', method: 'item/permissions/requestApproval',
    params: { threadId: 'approval-thread', turnId: 'approval-turn', permissions: requested } });
  engine.respondApproval('permission-request', 'accept');
  assert.deepEqual(child.sent.find(item => item.id === 'permission-request').result, { permissions: requested, scope: 'turn' });
  assert.throws(() => engine.respondApproval(900, 'accept'), /no longer pending/u);
  child.notify('turn/completed', { threadId: 'approval-thread', turn: { id: 'approval-turn', status: 'completed', items: [] } });
  await running;
});

test('AbortSignal sends turn/interrupt and preserves interrupted status', async t => {
  let started = false;
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'cancel-thread' } });
    if (request.method === 'turn/start') { process.reply(request, { turn: { id: 'cancel-turn', status: 'inProgress' } }); started = true; }
    if (request.method === 'turn/interrupt') {
      process.reply(request, {});
      process.notify('turn/completed', { threadId: 'cancel-thread', turn: { id: 'cancel-turn', status: 'interrupted', items: [] } });
    }
  });
  const engine = engineFor(t, child);
  const controller = new AbortController();
  const running = engine.run({ cwd: tmpdir(), prompt: '等待取消', signal: controller.signal });
  await until(() => started && engine.active?.turnId);
  await assert.rejects(engine.run({ cwd: tmpdir(), prompt: '不应并发' }), /active run/u);
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(child.sent.find(item => item.method === 'turn/interrupt').params,
    { threadId: 'cancel-thread', turnId: 'cancel-turn' });
});

test('unknown server requests are explicitly rejected; close rejects an owned active run', async t => {
  let started = false;
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'close-thread' } });
    if (request.method === 'turn/start') { started = true; process.reply(request, { turn: { id: 'close-turn', status: 'inProgress' } }); }
  });
  const engine = engineFor(t, child);
  const running = engine.run({ cwd: tmpdir(), prompt: '测试关闭' });
  const rejected = assert.rejects(running, /closed/u);
  await until(() => started);
  child.send({ id: 'unsupported', method: 'account/chatgptAuthTokens/refresh', params: {} });
  assert.equal(child.sent.find(item => item.id === 'unsupported').error.code, -32601);
  await engine.close();
  await rejected;
  assert.equal(child.exitCode, 0);
  assert.equal(engine.pending.size, 0);
});

test('pre-aborted input cannot start a model turn; initialization failure closes its owned process', async t => {
  const child = mockChild();
  const engine = engineFor(t, child);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.run({ cwd: tmpdir(), prompt: '不得运行', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(child.sent.length, 0);
  const broken = mockChild();
  broken.factory = () => {
    queueMicrotask(() => broken.stdout.write('invalid-json\n'));
    return broken;
  };
  const failedEngine = engineFor(t, broken);
  const health = await failedEngine.health();
  assert.equal(health.available, false);
  assert.match(health.message, /invalid JSONL/u);
  assert.equal(broken.exitCode, 0);
});

test('cancellation before turn/start responds still interrupts the started turn', async t => {
  const controller = new AbortController();
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'race-thread' } });
    if (request.method === 'turn/start') {
      process.notify('turn/started', { threadId: 'race-thread', turn: { id: 'race-turn', status: 'inProgress' } });
      process.reply(request, { turn: { id: 'race-turn', status: 'inProgress' } });
    }
    if (request.method === 'turn/interrupt') {
      process.reply(request, {});
      process.notify('turn/completed', { threadId: 'race-thread', turn: { id: 'race-turn', status: 'interrupted', items: [] } });
    }
  });
  const engine = engineFor(t, child);
  const result = await engine.run({ cwd: tmpdir(), prompt: '测试开始时停止', signal: controller.signal,
    onEvent: event => { if (event.kind === 'turn' && event.status === 'started') controller.abort(); } });
  assert.equal(result.status, 'interrupted');
  assert.equal(child.sent.filter(item => item.method === 'turn/interrupt').length, 1);
});

test('an acknowledged interrupt without terminal notification cannot leave an owned process running', async t => {
  let started = false;
  const child = mockChild((request, process) => {
    if (request.method === 'thread/start') process.reply(request, { thread: { id: 'stalled-thread' } });
    if (request.method === 'turn/start') { started = true; process.reply(request, { turn: { id: 'stalled-turn', status: 'inProgress' } }); }
    if (request.method === 'turn/interrupt') process.reply(request, {});
  });
  const engine = engineFor(t, child, { interruptTimeoutMs: 30 });
  const controller = new AbortController();
  const running = engine.run({ cwd: tmpdir(), prompt: '测试中断超时', signal: controller.signal });
  const rejected = assert.rejects(running, /did not confirm interruption/u);
  await until(() => started && engine.active?.turnId);
  controller.abort();
  await rejected;
  assert.equal(child.exitCode, 0);
  assert.equal(engine.pending.size, 0);
});
