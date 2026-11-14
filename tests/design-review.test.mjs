import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_CRITERIA, validateDesignReview } from '../server/design-review.mjs';

const REVIEW_ID = 'current-review-attempt';

function cleanReport() {
  return {
    schemaVersion: 1,
    reviewId: REVIEW_ID,
    direction: '面向独立设计师的作品展示，以案例阅读为主要动作。',
    checks: REVIEW_CRITERIA.map(id => ({
      id,
      status: 'pass',
      desktop: `${id}：已查看电脑截图，标题与主要操作清晰。`,
      mobile: `${id}：已查看手机截图，窄屏内容顺序与阅读正常。`
    })),
    changes: ['调整手机端标题断行。'],
    remainingIssues: []
  };
}

test('a clean current report is canonical, valid, and needs no attention', () => {
  const input = cleanReport();
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAttention, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.report, input);
  assert.notEqual(result.report, input);
  assert.notEqual(result.report.checks[0], input.checks[0]);
});

test('stale review records cannot satisfy a current review', () => {
  const input = cleanReport();
  input.reviewId = 'previous-review-attempt';
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, false);
  assert.equal(result.needsAttention, true);
  assert.equal(result.report, null);
  assert.match(result.issues.join(' '), /reviewId.*本轮不符/);
  input.reviewId = ` ${REVIEW_ID} `;
  assert.equal(validateDesignReview(input, REVIEW_ID).valid, false, 'IDs must match exactly');
  assert.equal(validateDesignReview(cleanReport(), '').valid, false, 'missing current identity fails closed');
});

test('duplicate and missing categories are both identified', () => {
  const input = cleanReport();
  input.checks[6] = { ...input.checks[0] };
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, false);
  assert.equal(result.report, null);
  assert.match(result.issues.join(' '), /intent.*重复/);
  assert.match(result.issues.join(' '), /缺少.*mobile/);
  input.checks.pop();
  assert.equal(validateDesignReview(input, REVIEW_ID).valid, false);
});

test('unknown criteria and statuses fail rather than silently passing', () => {
  for (const change of [
    report => { report.checks[0].id = 'overall'; },
    report => { report.checks[0].status = 'excellent'; },
    report => { report.checks[0].status = 100; },
    report => { report.checks.push({ ...report.checks[0] }); }
  ]) {
    const input = cleanReport();
    change(input);
    const result = validateDesignReview(input, REVIEW_ID);
    assert.equal(result.valid, false);
    assert.equal(result.needsAttention, true);
    assert(result.issues.length > 0);
  }
});

test('explicit unchecked criteria remain incomplete even with well-formed observations', () => {
  const input = cleanReport();
  input.checks[6].status = 'not_checked';
  input.checks[6].desktop = '尚未检查桌面到窄屏的过渡宽度。';
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAttention, true);
  assert.equal(result.report.checks[6].status, 'not_checked');
  assert.match(result.issues.join(' '), /移动端体验尚未完成审查/);
  assert.match(result.issues.join(' '), /过渡宽度/);
});

test('needs_work findings include their category and observations', () => {
  const input = cleanReport();
  input.checks[2].status = 'needs_work';
  input.checks[2].mobile = '手机正文过小，说明文字难读。';
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAttention, true);
  assert.match(result.issues.join(' '), /字体与可读性仍需改进/);
  assert.match(result.issues.join(' '), /手机正文过小/);
});

test('unresolved findings require attention even when all seven check statuses pass', () => {
  const input = cleanReport();
  input.remainingIssues = [{
    criterion: 'hierarchy',
    problem: '次要入口与主要按钮争夺注意力。',
    location: '首页首屏右侧',
    nextAction: '降低次要入口的视觉权重。'
  }];
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAttention, true);
  assert.match(result.issues.join(' '), /信息层级.*争夺注意力.*首页首屏右侧.*降低/);
});

test('unknown payload fields and scores are not carried into canonical reports', () => {
  const input = cleanReport();
  input.score = 100;
  input.approved = true;
  input.extra = { nested: 'untrusted' };
  input.direction = `  ${input.direction}\r\n  `;
  input.checks.reverse();
  input.checks[0].score = 100;
  input.checks[0].extra = 'ignore';
  input.remainingIssues = [{
    criterion: 'identity', problem: '  仍需核对标志授权。  ', location: '  页脚  ',
    nextAction: '  请用户确认本地标志来源。  ', score: 100, approved: true
  }];
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.deepEqual(Object.keys(result.report), ['schemaVersion', 'reviewId', 'direction', 'checks', 'changes', 'remainingIssues']);
  assert.deepEqual(result.report.checks.map(check => check.id), REVIEW_CRITERIA);
  assert.deepEqual(Object.keys(result.report.checks[0]), ['id', 'status', 'desktop', 'mobile']);
  assert.deepEqual(Object.keys(result.report.remainingIssues[0]), ['criterion', 'problem', 'location', 'nextAction']);
  assert.equal(result.report.remainingIssues[0].problem, '仍需核对标志授权。');
  assert(!JSON.stringify(result.report).includes('score'));
  assert(!result.report.direction.startsWith(' '));
  assert(!result.report.direction.endsWith('\n'));
});

test('required information must be nonempty and correctly typed', () => {
  for (const change of [
    report => { report.schemaVersion = '1'; },
    report => { report.direction = ' \n\t '; },
    report => { report.checks[0].desktop = ''; },
    report => { report.checks[0].mobile = null; },
    report => { delete report.changes; },
    report => { report.changes = ['']; },
    report => { report.remainingIssues = {}; },
    report => { report.remainingIssues = [{ criterion: 'palette', problem: '颜色对比不足', location: '首屏' }]; },
    report => { report.remainingIssues = [{ criterion: 'overall', problem: '问题', location: '首屏', nextAction: '修正' }]; }
  ]) {
    const input = cleanReport();
    change(input);
    const result = validateDesignReview(input, REVIEW_ID);
    assert.equal(result.valid, false);
    assert.equal(result.needsAttention, true);
    assert.equal(result.report, null);
    assert(result.issues.some(issue => /缺失|格式|必须|无效/.test(issue)));
  }
  for (const input of [undefined, null, [], 'report', 1, true]) {
    assert.equal(validateDesignReview(input, REVIEW_ID).valid, false);
  }
});

test('inherited and accessor fields cannot act as review evidence', () => {
  const inherited = Object.create(cleanReport());
  assert.equal(validateDesignReview(inherited, REVIEW_ID).valid, false);
  const input = cleanReport();
  Object.defineProperty(input.checks[0], 'desktop', { get() { throw new Error('must not run'); } });
  assert.equal(validateDesignReview(input, REVIEW_ID).valid, false);
});

test('oversized text and arrays are rejected, and stored findings stay bounded', () => {
  const oversized = cleanReport();
  oversized.direction = '大'.repeat(2001);
  assert.equal(validateDesignReview(oversized, REVIEW_ID).valid, false);
  oversized.direction = '合理方向';
  oversized.changes = Array.from({ length: 21 }, () => '修改');
  assert.equal(validateDesignReview(oversized, REVIEW_ID).valid, false);
  const input = cleanReport();
  for (const check of input.checks) {
    check.status = 'needs_work';
    check.desktop = '桌'.repeat(3000);
    check.mobile = '手'.repeat(3000);
  }
  input.remainingIssues = Array.from({ length: 20 }, () => ({
    criterion: 'palette', problem: '问'.repeat(2000), location: '位'.repeat(2000), nextAction: '改'.repeat(2000)
  }));
  const result = validateDesignReview(input, REVIEW_ID);
  assert.equal(result.valid, true);
  assert.equal(result.needsAttention, true);
  assert.equal(result.issues.length, 20);
  assert(result.issues.every(issue => issue.length <= 6000));
  const malformed = validateDesignReview({ checks: Array(7).fill({}) }, REVIEW_ID);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.issues.length, 20);
  assert(malformed.issues.every(issue => issue.length <= 6000));
});
