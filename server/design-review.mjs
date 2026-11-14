export const REVIEW_CRITERIA = Object.freeze([
  'intent', 'hierarchy', 'typography', 'palette', 'composition', 'identity', 'mobile'
]);

const LABELS = Object.freeze({
  intent: '产品表达与主要动作',
  hierarchy: '信息层级',
  typography: '字体与可读性',
  palette: '配色',
  composition: '构图与留白',
  identity: '品牌辨识',
  mobile: '移动端体验'
});
const STATUSES = new Set(['pass', 'needs_work', 'not_checked']);
const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 6000;
const MAX_ITEMS = 20;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Records arrive as parsed JSON. Read only own data fields, without carrying
// unknown properties (including scores) or evaluating inherited/accessor fields.
function field(record, key) {
  const property = Object.getOwnPropertyDescriptor(record, key);
  return property && 'value' in property ? property.value : undefined;
}

/**
 * Validate a review's structure and bind it to the current review attempt.
 * `valid` does not establish aesthetic quality; findings and unchecked criteria
 * still require attention even when the record is correctly formatted.
 */
export function validateDesignReview(value, reviewId) {
  const errors = [];
  let malformed = false;
  const error = message => {
    malformed = true;
    if (errors.length < MAX_ISSUES) errors.push(message.slice(0, MAX_ISSUE_LENGTH));
  };
  const invalid = () => ({ valid: false, report: null, issues: errors, needsAttention: true });
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
    return raw.replace(/\r\n?/g, '\n').trim();
  };
  const list = (record, key, label, maxLength) => {
    const raw = field(record, key);
    if (!Array.isArray(raw)) {
      error(`${label}缺失或格式无效，必须是数组。`);
      return [];
    }
    if (raw.length > maxLength) error(`${label}数量过多，最多允许 ${maxLength} 项。`);
    return raw.slice(0, maxLength);
  };

  if (!isRecord(value)) {
    error('设计审查记录缺失或格式无效，必须是 JSON 对象。');
    return invalid();
  }
  if (field(value, 'schemaVersion') !== 1) error('设计审查记录的 schemaVersion 必须为 1。');
  const currentIdValid = typeof reviewId === 'string' && reviewId.trim().length > 0 && reviewId.length <= 200;
  const recordedId = field(value, 'reviewId');
  if (!currentIdValid) error('当前审查标识缺失或格式无效，无法确认本轮审查记录。');
  if (typeof recordedId !== 'string' || !recordedId.trim() || recordedId.length > 200) {
    error('设计审查记录的 reviewId 缺失或格式无效。');
  } else if (recordedId !== reviewId) {
    error('设计审查记录的 reviewId 与本轮不符；旧记录不能作为本轮审查结果。');
  }

  const direction = text(value, 'direction', '设计方向说明', 2000);
  const rawChecks = list(value, 'checks', '审查项列表', REVIEW_CRITERIA.length);
  if (rawChecks.length !== REVIEW_CRITERIA.length) error('审查项必须覆盖全部七个类别，且每个类别恰好出现一次。');
  const checks = new Map();
  for (const [index, check] of rawChecks.entries()) {
    if (!isRecord(check)) {
      error(`第 ${index + 1} 项审查记录格式无效，必须是对象。`);
      continue;
    }
    const id = field(check, 'id');
    const knownId = REVIEW_CRITERIA.includes(id);
    const label = knownId ? LABELS[id] : `第 ${index + 1} 项审查`;
    if (!knownId) error(`第 ${index + 1} 项审查的类别 id 无效，必须使用七个规定类别之一。`);
    else if (checks.has(id)) error(`${label}（${id}）重复；每个类别只能出现一次。`);
    const status = field(check, 'status');
    if (!STATUSES.has(status)) error(`${label}的状态无效，必须为 pass、needs_work 或 not_checked。`);
    const desktop = text(check, 'desktop', `${label}的电脑端观察`, 3000);
    const mobile = text(check, 'mobile', `${label}的手机端观察`, 3000);
    if (knownId && !checks.has(id)) checks.set(id, { id, status, desktop, mobile });
  }
  for (const id of REVIEW_CRITERIA) {
    if (!checks.has(id)) error(`缺少${LABELS[id]}（${id}）审查项。`);
  }

  const changes = list(value, 'changes', '修改记录', MAX_ITEMS).map((change, index) => {
    // Use the same bounded string validation as the observation fields.
    return text({ change }, 'change', `第 ${index + 1} 项修改记录`, 2000);
  });
  const remainingIssues = [];
  for (const [index, item] of list(value, 'remainingIssues', '剩余问题列表', MAX_ITEMS).entries()) {
    if (!isRecord(item)) {
      error(`第 ${index + 1} 项剩余问题格式无效，必须是对象。`);
      continue;
    }
    const criterion = field(item, 'criterion');
    if (!REVIEW_CRITERIA.includes(criterion)) error(`第 ${index + 1} 项剩余问题的 criterion 无效，必须关联一个规定的审查类别。`);
    remainingIssues.push({
      criterion,
      problem: text(item, 'problem', `第 ${index + 1} 项剩余问题的具体问题`, 2000),
      location: text(item, 'location', `第 ${index + 1} 项剩余问题的位置`, 2000),
      nextAction: text(item, 'nextAction', `第 ${index + 1} 项剩余问题的下一步动作`, 2000)
    });
  }
  if (malformed) return invalid();

  const report = {
    schemaVersion: 1,
    reviewId: recordedId,
    direction,
    checks: REVIEW_CRITERIA.map(id => checks.get(id)),
    changes,
    remainingIssues
  };
  const issues = [];
  const finding = message => {
    if (issues.length < MAX_ISSUES) issues.push(message.slice(0, MAX_ISSUE_LENGTH));
  };
  for (const check of report.checks) {
    if (check.status !== 'pass') {
      const state = check.status === 'not_checked' ? '尚未完成审查' : '仍需改进';
      finding(`${LABELS[check.id]}${state}；电脑端：${check.desktop}；手机端：${check.mobile}`);
    }
  }
  for (const item of remainingIssues) {
    finding(`${LABELS[item.criterion]}：${item.problem}；位置：${item.location}；下一步：${item.nextAction}`);
  }
  return {
    valid: true,
    report,
    issues,
    needsAttention: report.checks.some(check => check.status !== 'pass') || remainingIssues.length > 0
  };
}
