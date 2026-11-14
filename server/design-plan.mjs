const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_KINDS = new Set(['code', 'local', 'missing']);
const MAX_ISSUES = 20;
const TEXT_FIELDS = [
  ['concept', '设计主意', 3000],
  ['audience', '目标受众', 2000],
  ['primaryAction', '主要动作', 2000],
  ['typography', '字体安排', 3000],
  ['palette', '配色方案', 3000],
  ['composition', '整体构图', 3000],
  ['keyVisual', '关键视觉', 3000],
  ['mobile', '手机端安排', 3000],
  ['motion', '运动与反馈', 3000]
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Read only own data fields. Inherited fields and accessors cannot supply an
// approval record, and unknown properties are never copied into the result.
function field(record, key) {
  const property = Object.getOwnPropertyDescriptor(record, key);
  return property && 'value' in property ? property.value : undefined;
}

function safeAssetPath(path) {
  if (/[\\%:#?<>"|*\u0000-\u001f\u007f]/u.test(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part.length > 0
    && !part.startsWith('.')
    && !/[. ]$/u.test(part)
    && part.toLowerCase() !== 'node_modules'
    && !/^(?:credentials|secrets?|service[-_]account|passwords?|api[-_]keys?|access[-_]tokens?)(?:[._-]|$)/i.test(part)
    && !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/i.test(part)
    && !/\.(?:pem|key|p12|pfx)$/i.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/**
 * Validate and canonicalize a direction plan for exactly one design attempt.
 * A valid plan may still lack declared assets; the host must resolve those and
 * verify local file existence/containment before allowing approval.
 */
export function validateDesignPlan(value, designId) {
  const issues = [];
  let malformed = false;
  let needsAssets = false;
  const finding = message => {
    if (issues.length < MAX_ISSUES) issues.push(message.slice(0, 1000));
  };
  const error = message => {
    malformed = true;
    finding(message);
  };
  const invalid = () => ({ valid: false, plan: null, issues, needsAssets });
  const text = (record, key, label, maxLength) => {
    const raw = field(record, key);
    if (typeof raw !== 'string' || !raw.trim()) {
      error(`${label}缺失或格式无效，必须填写非空文字。`);
      return '';
    }
    if (raw.length > maxLength) {
      error(`${label}过长，最多允许 ${maxLength} 个字符。`);
      return '';
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
      error(`${label}包含无效控制字符。`);
      return '';
    }
    return raw.replace(/\r\n?/g, '\n').trim();
  };
  const list = (record, key, label, minimum, maximum) => {
    const raw = field(record, key);
    if (!Array.isArray(raw)) {
      error(`${label}缺失或格式无效，必须是数组。`);
      return [];
    }
    if (raw.length < minimum || raw.length > maximum) {
      error(`${label}数量无效，必须为 ${minimum} 至 ${maximum} 项。`);
    }
    // Do not use slice/map on untrusted arrays: they can evaluate getters or
    // inherited entries. Holes and accessor entries fail as missing records.
    const result = [];
    for (let index = 0; index < Math.min(raw.length, maximum); index += 1) {
      result.push(field(raw, String(index)));
    }
    return result;
  };

  if (!isRecord(value)) {
    error('设计计划缺失或格式无效，必须是 JSON 对象。');
    return invalid();
  }
  if (field(value, 'schemaVersion') !== 1) error('设计计划的 schemaVersion 必须为 1。');
  const recordedId = field(value, 'designId');
  if (typeof designId !== 'string' || !UUID.test(designId)) {
    error('当前设计标识缺失或格式无效，必须提供本轮 UUID。');
  }
  if (typeof recordedId !== 'string' || !UUID.test(recordedId)) {
    error('设计计划的 designId 缺失或格式无效，必须为本轮 UUID。');
  } else if (recordedId !== designId) {
    error('设计计划的 designId 与本轮不符；旧计划不能作为本轮确认依据。');
  }

  const plan = { schemaVersion: 1, designId: recordedId };
  for (const [key, label, maximum] of TEXT_FIELDS) plan[key] = text(value, key, label, maximum);

  plan.sections = [];
  for (const [index, section] of list(value, 'sections', '页面章节', 1, 8).entries()) {
    const label = `第 ${index + 1} 个章节`;
    if (!isRecord(section)) {
      error(`${label}格式无效，必须是对象。`);
      continue;
    }
    plan.sections.push({
      name: text(section, 'name', `${label}的名称`, 120),
      purpose: text(section, 'purpose', `${label}的用途`, 2000),
      composition: text(section, 'composition', `${label}的构图`, 3000)
    });
  }

  plan.assets = [];
  for (const [index, asset] of list(value, 'assets', '视觉素材', 0, 12).entries()) {
    const label = `第 ${index + 1} 项素材`;
    if (!isRecord(asset)) {
      error(`${label}格式无效，必须是对象。`);
      continue;
    }
    const name = text(asset, 'name', `${label}的名称`, 120);
    const kind = field(asset, 'kind');
    if (!ASSET_KINDS.has(kind)) error(`${label}的 kind 无效，必须为 code、local 或 missing。`);
    const canonical = { name, kind, purpose: text(asset, 'purpose', `${label}的用途`, 1000) };
    if (kind === 'local' || Object.getOwnPropertyDescriptor(asset, 'path')) {
      const path = text(asset, 'path', `${label}的路径`, 500);
      if (path && !safeAssetPath(path)) {
        error(`${label}的路径不安全；须使用正斜杠分隔的相对文件路径，不能包含越界、隐藏目录、依赖目录或敏感文件。`);
      }
      canonical.path = path;
    }
    if (kind === 'missing') {
      needsAssets = true;
      finding(`素材“${name || label}”尚未就绪：${canonical.purpose}；需补齐素材或调整方案后再确认。`);
    }
    plan.assets.push(canonical);
  }

  plan.references = [];
  for (const [index, reference] of list(value, 'references', '参考案例', 0, 4).entries()) {
    const label = `第 ${index + 1} 项参考`;
    if (!isRecord(reference)) {
      error(`${label}格式无效，必须是对象。`);
      continue;
    }
    const name = text(reference, 'name', `${label}的名称`, 120);
    const rawUrl = text(reference, 'url', `${label}的网址`, 2000);
    let url = '';
    try {
      if (!/^https:\/\/[^/]/i.test(rawUrl) || /[\\\s\u0000-\u001f\u007f]/u.test(rawUrl)) throw new Error('unsafe URL');
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw new Error('unsafe URL');
      url = parsed.href;
    } catch {
      error(`${label}的网址无效，必须使用不含账号密码的完整 HTTPS 地址。`);
    }
    plan.references.push({ name, url, lesson: text(reference, 'lesson', `${label}的借鉴方法`, 1500) });
  }

  return malformed ? invalid() : { valid: true, plan, issues, needsAssets };
}
