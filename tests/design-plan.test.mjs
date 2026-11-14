import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDesignPlan } from '../server/design-plan.mjs';

const DESIGN_ID = 'b910cdf2-c9cb-4b8c-9317-4ff7e8301b89';

function directionPlan() {
  return {
    schemaVersion: 1,
    designId: DESIGN_ID,
    concept: '以山路地图与真实照片说明徒步路线。',
    audience: '准备第一次周末徒步的城市居民。',
    primaryAction: '查看路线难度与出行准备。',
    typography: '系统黑体用于说明，数字使用等宽字体。',
    palette: '米白背景、墨绿文字、橙色标记主操作。',
    composition: '路线图与标题各占半幅，后续以图注和清单改变节奏。',
    keyVisual: '原创 SVG 路线图表现路径与海拔。',
    mobile: '先读难度和出行按钮，再显示可缩放的路线图。',
    motion: '选择路线时高亮路径，减少运动偏好下取消过渡。',
    sections: [{ name: '路线概览', purpose: '解释目的地和难度。', composition: '路线图旁放置标题与出行信息。' }],
    assets: [{ name: '路线图', kind: 'code', purpose: '呈现真实路线和起终点。' }],
    references: [{ name: '参考案例', url: 'https://example.com/trails', lesson: '借鉴路线与注释的阅读顺序。' }]
  };
}

function assertInvalid(input, expectedIssue) {
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.equal(result.valid, false);
  assert.equal(result.plan, null);
  assert(result.issues.length > 0);
  if (expectedIssue) assert.match(result.issues.join(' '), expectedIssue);
  return result;
}

test('current complete plans produce independent canonical ordinary objects', () => {
  const input = directionPlan();
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.deepEqual(result, { valid: true, plan: input, issues: [], needsAssets: false });
  assert.notEqual(result.plan, input);
  for (const key of ['sections', 'assets', 'references']) {
    assert.notEqual(result.plan[key], input[key]);
    assert.notEqual(result.plan[key][0], input[key][0]);
    assert.equal(Object.getPrototypeOf(result.plan[key][0]), Object.prototype);
  }
  assert.equal(Object.getPrototypeOf(result.plan), Object.prototype);
  result.plan.sections[0].name = 'changed';
  assert.equal(input.sections[0].name, '路线概览');
});

test('IDs must be UUIDs bound exactly to the current attempt', () => {
  for (const id of ['6e0e774f-746b-4f53-bbbf-2346edac7384', DESIGN_ID.toUpperCase(), ` ${DESIGN_ID} `, 'current-design', '', null]) {
    const input = directionPlan();
    input.designId = id;
    assertInvalid(input, /designId/);
  }
  for (const current of ['', null, 'current-design', ` ${DESIGN_ID} `]) {
    const result = validateDesignPlan(directionPlan(), current);
    assert.equal(result.valid, false);
    assert.match(result.issues.join(' '), /当前设计标识/);
  }
});

test('root shape and schema version fail closed', () => {
  for (const value of [undefined, null, [], 'plan', 1, true]) assertInvalid(value, /JSON 对象/);
  for (const version of [undefined, null, '1', 0, 2]) {
    const input = directionPlan();
    input.schemaVersion = version;
    assertInvalid(input, /schemaVersion/);
  }
});

test('every direction field is required, bounded text', () => {
  const keys = ['concept', 'audience', 'primaryAction', 'typography', 'palette', 'composition', 'keyVisual', 'mobile', 'motion'];
  for (const key of keys) {
    for (const invalid of [undefined, ' \n\t ', [], {}, 1, 'a'.repeat(3001), 'bad\u0000text']) {
      const input = directionPlan();
      input[key] = invalid;
      assertInvalid(input);
    }
  }
  const input = directionPlan();
  input.concept = '  第一行\r\n第二行\r第三行  ';
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.equal(result.valid, true);
  assert.equal(result.plan.concept, '第一行\n第二行\n第三行');
  assert.equal(input.concept, '  第一行\r\n第二行\r第三行  ');
});

test('required lists enforce count and nested record shape', () => {
  const limits = [['sections', 1, 8], ['assets', 0, 12], ['references', 0, 4]];
  for (const [key, minimum, maximum] of limits) {
    for (const invalid of [undefined, null, {}, '[]', [null], ['item'], [false], new Array(1)]) {
      const input = directionPlan();
      input[key] = invalid;
      assertInvalid(input);
    }
    const boundary = directionPlan();
    const example = boundary[key][0];
    boundary[key] = Array.from({ length: maximum }, () => ({ ...example }));
    assert.equal(validateDesignPlan(boundary, DESIGN_ID).valid, true);
    boundary[key].push({ ...example });
    assertInvalid(boundary, /数量无效/);
    const empty = directionPlan();
    empty[key] = [];
    assert.equal(validateDesignPlan(empty, DESIGN_ID).valid, minimum === 0);
  }
});

test('section, asset, and reference details cannot be omitted or unbounded', () => {
  const cases = [
    ['sections', 'name', 120], ['sections', 'purpose', 2000], ['sections', 'composition', 3000],
    ['assets', 'name', 120], ['assets', 'purpose', 1000],
    ['references', 'name', 120], ['references', 'lesson', 1500]
  ];
  for (const [list, key, maximum] of cases) {
    for (const value of [undefined, ' ', 5, 'a'.repeat(maximum + 1)]) {
      const input = directionPlan();
      input[list][0][key] = value;
      assertInvalid(input);
    }
    const input = directionPlan();
    input[list][0][key] = 'a'.repeat(maximum);
    assert.equal(validateDesignPlan(input, DESIGN_ID).valid, true);
  }
});

test('missing assets remain valid declarations and explain the required action', () => {
  const input = directionPlan();
  input.assets.push({ name: '山顶实拍', kind: 'missing', purpose: '首屏展示目的地的真实环境。' });
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAssets, true);
  assert.match(result.issues.join(' '), /山顶实拍.*尚未就绪.*真实环境.*补齐素材/);
  assert.equal(result.plan.assets[1].kind, 'missing');
  input.assets[1].kind = 'ready';
  assertInvalid(input, /kind/);
});

test('local assets require normalized safe paths without filesystem assumptions', () => {
  const input = directionPlan();
  input.assets = [{ name: '本地山景', kind: 'local', purpose: '展示山景。', path: 'assets/山景 01.webp' }];
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.equal(result.valid, true, 'the host, not this synchronous schema validator, checks existence');
  assert.equal(result.needsAssets, false);
  assert.equal(result.plan.assets[0].path, 'assets/山景 01.webp');
  delete input.assets[0].path;
  assertInvalid(input, /路径/);
});

test('asset paths reject traversal, Windows aliases, hidden/dependency and secret files', () => {
  const unsafe = [
    '../photo.png', 'assets/../photo.png', './assets/photo.png', '/assets/photo.png',
    'C:/photo.png', 'C:photo.png', '\\\\host\\share\\photo.png', 'assets\\photo.png',
    'assets//photo.png', 'assets/', 'assets/./photo.png', '.git/config', 'assets/.env',
    'node_modules/a.png', 'assets/NoDe_MoDuLeS/a.png', 'assets/secrets.json',
    'credentials.json', 'assets/service_account.json', 'assets/id_ed25519', 'private.key',
    'assets/server.PEM', 'assets/token.p12', 'assets/api-key.json', 'assets/passwords.txt',
    'assets/photo.png:secret', 'assets/photo.png?raw=1', 'assets/photo.png#x',
    'assets/%2e%2e/photo.png', 'assets/a%252fb.png', 'assets/a\u0000.png',
    'assets/a\n.png', 'assets/dir./photo.png', 'assets/dir /photo.png', 'assets/CON.png',
    'assets/Lpt1', 'assets/pa*th.png', 'assets/im|age.png'
  ];
  for (const path of unsafe) {
    const input = directionPlan();
    input.assets[0] = { name: '素材', kind: 'local', purpose: '主视觉。', path };
    assertInvalid(input, /路径|控制字符/);
  }
  for (const kind of ['code', 'missing']) {
    const input = directionPlan();
    input.assets[0].kind = kind;
    input.assets[0].path = '../outside.svg';
    assertInvalid(input, /路径/);
  }
  const input = directionPlan();
  input.assets[0].path = 'a'.repeat(501);
  assertInvalid(input, /500/);
});

test('references require explicit HTTPS URLs and cannot embed credentials', () => {
  for (const url of [
    undefined, '', 'http://example.com', '//example.com', 'example.com', 'https:example.com',
    'javascript:alert(1)', 'file:///etc/passwd', 'https://', 'https:///example.com',
    'https://user:pass@example.com/', 'https://user@example.com/',
    'https://example.com/a b', 'https://exam\nple.com', 'https://example.com\\path',
    `https://example.com/${'a'.repeat(2000)}`
  ]) {
    const input = directionPlan();
    input.references[0].url = url;
    assertInvalid(input, /网址/);
  }
  const input = directionPlan();
  input.references[0].url = '  HTTPS://EXAMPLE.COM:443/paths/../trails#map  ';
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.equal(result.valid, true);
  assert.equal(result.plan.references[0].url, 'https://example.com/trails#map');
});

test('unknown fields and prototype pollution are not preserved in approval records', () => {
  const input = directionPlan();
  input.approved = true;
  input.score = 100;
  for (const record of [input, input.sections[0], input.assets[0], input.references[0]]) {
    Object.defineProperty(record, '__proto__', { value: { approved: true }, enumerable: true });
    Object.defineProperty(record, 'unknownGetter', { get() { throw new Error('must not run'); } });
    record.extra = { unsafe: true };
  }
  const result = validateDesignPlan(input, DESIGN_ID);
  assert.deepEqual(result.plan, directionPlan());
  assert.equal(Object.hasOwn(result.plan, '__proto__'), false);
  assert.equal(Object.hasOwn(result.plan, 'approved'), false);
  assert.equal({}.approved, undefined);
});

test('required fields and list entries cannot be supplied by prototypes or getters', () => {
  const inherited = Object.create(directionPlan());
  assertInvalid(inherited);
  const nullPrototype = Object.assign(Object.create(null), directionPlan());
  assert.equal(validateDesignPlan(nullPrototype, DESIGN_ID).valid, true);
  for (const prepare of [
    input => Object.defineProperty(input, 'concept', { get() { throw new Error('must not run'); } }),
    input => Object.defineProperty(input.sections[0], 'name', { get() { throw new Error('must not run'); } }),
    input => Object.defineProperty(input.sections, '0', { get() { throw new Error('must not run'); } }),
    input => Object.defineProperty(input.assets[0], 'path', { get() { throw new Error('must not run'); } })
  ]) {
    const input = directionPlan();
    prepare(input);
    assertInvalid(input);
  }
  const input = directionPlan();
  input.sections = new Array(1);
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, '0', { get() { throw new Error('must not run'); } });
  Object.setPrototypeOf(input.sections, prototype);
  assertInvalid(input);
});

test('issue output is bounded even when many nested fields are malformed', () => {
  const input = directionPlan();
  input.sections = Array.from({ length: 10000 }, () => ({}));
  input.assets = Array.from({ length: 10000 }, () => ({}));
  input.references = Array.from({ length: 10000 }, () => ({}));
  const result = assertInvalid(input);
  assert(result.issues.length <= 20);
  assert(result.issues.every(issue => issue.length <= 1000));
});
