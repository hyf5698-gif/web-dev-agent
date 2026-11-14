import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkRender } from './render-check.mjs';
import { DESIGN_BUILD_GUIDANCE, DESIGN_REVIEW_GUIDANCE, DESIGN_CRITERIA, DESIGN_DIRECTION_GUIDANCE, DESIGN_COMPLETION_GUIDANCE } from './design-guidance.mjs';
import { validateDesignReview } from './design-review.mjs';
import { validateDesignPlan } from './design-plan.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

const BUILD_RULES = `你是这个应用中的网页开发Agent。用户需要实际可运行的网页，不是说明、提示词或演示回答。
请在当前项目工作目录里创建或修改真实HTML/CSS/JavaScript文件，入口必须是index.html。首版是静态网页，可拆分文件，不使用需要构建的框架、外部CDN、远程字体、图片生成服务或后台。用原创CSS/SVG/Canvas或用户提供的本地素材表达视觉想法。
按用户所用语言交付界面和回复，默认中文。先明确产品、受众、主要动作及设计构想，并写入DESIGN.md（配色角色、字体、版式、交互、移动端行为）。已有项目沿用原文件与设计，针对修改需求更新，不另建无关项目。
重要事实缺失时先明确提出问题，不把想象的评价、客户、价格、使用数据当真实事实。可在明确标为演示的局部交互中展示能力。
实际完成文件编辑。不要修改工作目录以外的文件，不访问凭据，不发布或部署，不发送消息。若需要提高权限，走宿主审批。不要启动长期服务器；本应用负责提供预览和浏览器检查。完成后简短说明已实现什么，记录剩余问题。`;

export class Orchestrator {
  constructor({ store, engine, emit, validate = checkRender, timeoutMs = 420000, reviewTimeoutMs = 180000 }) {
    Object.assign(this, { store, engine, emit, validate, timeoutMs, reviewTimeoutMs });
    this.active = new Map();
  }
  async submit(id, text, { mode, designId } = {}) {
    if (this.submitting || this.active.size) throw Object.assign(new Error('已有任务正在运行，请先等待完成或停止当前任务。'), { statusCode: 409 });
    this.submitting = true;
    try {
    const project = await this.store.get(id);
    const health = await this.engine.health();
    if (!health.available || !health.authenticated) throw Object.assign(new Error(health.message || '请先连接并登录本机Codex。'), { statusCode: 503 });
    if (mode !== undefined && !['design', 'build'].includes(mode)) throw Object.assign(new Error('开发模式无效。'), { statusCode: 400 });
    let approvedPlan;
    if (designId !== undefined) {
      if (project.status !== 'awaiting_design' || designId !== project.designDraftId || project.designApprovedId === designId) throw conflict('这个设计方向已失效，请查看最新设计预览。');
      const design = await this.getDesign(id);
      if (!design?.ready) throw conflict(`设计方向尚不能确认：${design?.issues.join('；') || '缺少实际预览'}`);
      const current = validateDesignPlan(JSON.parse((await this.store.readFile(id, 'DESIGN_PLAN.json')).content), designId);
      if (!current.valid || digest(current.plan) !== project.designPlanHash || await this.sourceHash(id, { renderOnly: true }) !== project.designRenderHash) throw conflict('设计稿已发生变化，请重新生成方向预览后确认。');
      approvedPlan = design.plan;
      mode = 'build';
    } else {
      const needsDirection = project.workflow === 'design_first' && !project.designApprovedId;
      if (mode === 'build' && needsDirection) throw conflict('请先在“设计方向”中确认预览，再完善网页。');
      mode ||= needsDirection ? 'design' : 'build';
      if (mode === 'build' && project.designApprovedId) {
        const snapshot = JSON.parse((await this.store.readEvidence(id, project.designApprovedId, 'design-plan.json')).toString('utf8'));
        const checked = validateDesignPlan(snapshot, project.designApprovedId);
        if (!checked.valid) throw conflict('已确认的设计记录无法读取，请重新确定方向。');
        approvedPlan = checked.plan;
      }
    }
    const controller = new AbortController();
    const runId = randomUUID();
    this.active.set(id, { runId, controller });
    await this.store.update(id, { activeRunId: runId, lastError: null });
    if (mode === 'design') await this.store.update(id, { workflow: 'design_first', designDraftId: runId, designApprovedId: null, designPlanHash: null, designRenderHash: null });
    await this.store.addMessage(id, { role: 'user', text });
    this.emit(id, { type: 'message', role: 'user', text, createdAt: new Date().toISOString() });
    await this.phase(id, 'running', mode === 'design' ? 'designing' : 'developing', mode === 'design' ? '正在制作设计方向稿，完成后由你确认…' : '正在按设计方向完善网页…');
    const task = this.execute(id, project, text, runId, controller, { mode, approvedPlan, confirmedDesignId: designId }).catch(async error => {
      await this.finishError(id, error, controller.signal.aborted, runId, controller.signal.reason);
    }).finally(() => this.active.delete(id));
    this.active.get(id).task = task;
    return { runId };
    } catch (error) {
      if (!this.active.get(id)?.task) this.active.delete(id);
      throw error;
    } finally { this.submitting = false; }
  }
  async phase(id, status, phase, message) {
    await this.store.update(id, { status, phase });
    this.emit(id, { type: 'status', status, phase, message });
  }
  async sourceHash(id, { renderOnly = false } = {}) {
    return this.store.workspaceHash(id, { renderOnly });
  }
  async getDesign(id) {
    const project = await this.store.get(id);
    if (!project.designDraftId) return null;
    const designId = project.designDraftId;
    let checked = { valid: false, plan: null, issues: ['设计方向稿尚未生成。'], needsAssets: true };
    try { checked = validateDesignPlan(JSON.parse((await this.store.readEvidence(id, designId, 'design-plan.json')).toString('utf8')), designId); } catch { /* In-progress drafts have no snapshot yet. */ }
    const images = {};
    for (const [view, file] of Object.entries({ desktop: 'desktop.png', detail: 'desktop-detail.png', mobile: 'mobile.png' })) {
      try { await this.store.readEvidence(id, designId, `direction/${file}`); images[view] = true; } catch { images[view] = false; }
    }
    const issues = [...checked.issues];
    if (checked.valid) for (const asset of checked.plan.assets) if (asset.kind === 'local' && !await this.store.assetExists(id, asset.path)) issues.push(`本地素材尚不可用：${asset.name}`);
    const approved = project.designApprovedId === designId;
    if (!approved && project.phase === 'design_needs_attention') issues.push(...(project.lastValidation?.issues || []));
    if (project.status === 'awaiting_design') {
      try {
        if (project.designRenderHash !== await this.sourceHash(id, { renderOnly: true })) issues.push('网页已变化，需要重新生成设计预览。');
      } catch { issues.push('网页文件或素材无法安全读取，需要处理后重新生成预览。'); }
      try {
        const current = validateDesignPlan(JSON.parse((await this.store.readFile(id, 'DESIGN_PLAN.json')).content), designId);
        if (!current.valid || digest(current.plan) !== project.designPlanHash) issues.push('设计计划已变化，需要重新生成方向预览。');
      } catch { issues.push('当前设计计划无法读取，需要重新生成方向预览。'); }
    }
    if (!Object.values(images).every(Boolean)) issues.push('三个设计预览尚未全部生成。');
    const uniqueIssues = [...new Set(issues)].slice(0, 20);
    return { designId, plan: checked.plan, images, issues: uniqueIssues, approved, ready: checked.valid && !checked.needsAssets && !uniqueIssues.length && project.status === 'awaiting_design' && !approved };
  }
  async designReview(id, runId) {
    try {
      const file = await this.store.readFile(id, 'DESIGN_REVIEW.json');
      return validateDesignReview(JSON.parse(file.content), runId);
    } catch {
      return { valid: false, report: null, needsAttention: true, issues: ['本轮美感审查记录尚未生成或无法读取。'] };
    }
  }
  async finishDirection({ id, runId, startedAt, threadId, first, controller, files }) {
    let design = { valid: false, plan: null, needsAssets: true, issues: ['未生成可读取的设计方向记录。'] };
    try { design = validateDesignPlan(JSON.parse((await this.store.readFile(id, 'DESIGN_PLAN.json')).content), runId); } catch { /* Keep incomplete plans visible, never approve them. */ }
    if (design.valid) await writeFile(join(this.store.evidenceDir(id), runId, 'design-plan.json'), JSON.stringify(design.plan, null, 2));
    let checked = { available: false, ok: false, issues: ['尚未生成网页入口。'] };
    const beforeHash = await this.sourceHash(id, { renderOnly: true });
    if (files.some(file => file.path === 'index.html')) {
      await this.phase(id, 'verifying', 'direction_preview', '正在拍摄电脑首屏、中段和手机设计预览…');
      checked = await this.validate({ root: this.store.workspace(id), out: join(this.store.evidenceDir(id), runId, 'direction'), signal: controller.signal });
    }
    if (controller.signal.aborted) throw new Error('任务已停止。');
    const issues = [...design.issues, ...checked.issues];
    if (design.valid) for (const asset of design.plan.assets) if (asset.kind === 'local' && !await this.store.assetExists(id, asset.path)) issues.push(`本地素材尚不可用：${asset.name}`);
    for (const file of ['desktop.png', 'desktop-detail.png', 'mobile.png']) {
      try { await this.store.readEvidence(id, runId, `direction/${file}`); } catch { issues.push(`缺少实际设计预览：${file}`); }
    }
    const renderHash = await this.sourceHash(id, { renderOnly: true });
    if (beforeHash !== renderHash) issues.push('截图期间网页发生变化，需要重新生成预览。');
    const ready = design.valid && !design.needsAssets && checked.ok && checked.available && !issues.length;
    const status = ready ? 'awaiting_design' : 'needs_attention';
    const sourceHash = await this.sourceHash(id);
    const uniqueIssues = [...new Set(issues)].slice(0, 20);
    const evidence = { kind: 'design_direction', designId: runId, sourceHash, renderSourceHash: renderHash, automatedPassed: checked.ok, issues: uniqueIssues, readyForConfirmation: ready, reportPath: checked.reportPath };
    await writeFile(join(this.store.evidenceDir(id), runId, 'result.json'), JSON.stringify(evidence, null, 2));
    await this.store.update(id, { status, phase: ready ? 'awaiting_design' : 'design_needs_attention', activeRunId: null, fileCount: files.length, designPlanHash: design.valid ? digest(design.plan) : null, designRenderHash: renderHash, lastValidation: { ok: checked.ok, reviewed: false, issues: uniqueIssues, sourceHash } });
    const reply = `${first.finalResponse || '设计方向稿已保存。'}\n\n${ready ? '请打开“设计方向”，查看电脑首屏、中段和手机截图。满意后点“按此方向完善网页”；也可以先调整方向。本轮尚未展开完整网站。' : `方向稿还需要处理：${uniqueIssues.join('；')}。请补充要求或素材后继续调整方向。`}`;
    await this.store.addMessage(id, { role: 'assistant', text: reply });
    await this.store.appendRun(id, { id: runId, kind: 'design_direction', startedAt, finishedAt: new Date().toISOString(), status, threadId, sourceHash, validation: evidence });
    this.emit(id, { type: 'message', role: 'assistant', text: reply });
    this.emit(id, { type: 'status', status, phase: ready ? 'awaiting_design' : 'design_needs_attention', message: ready ? '方向稿已就绪，等待你确认美感方向。' : '方向稿仍有待处理项。' });
    this.emit(id, { type: 'done', project: await this.store.get(id) });
  }
  async execute(id, project, userText, runId, controller, { mode, approvedPlan, confirmedDesignId }) {
    const startedAt = new Date().toISOString();
    let deadline = setTimeout(() => controller.abort('网页开发达到本次运行时间上限。'), this.timeoutMs);
    let threadId = project.threadId;
    const cwd = this.store.workspace(id);
    const outputNotices = new Set();
    const onEvent = event => {
      if (event.threadId && event.threadId !== threadId) {
        threadId = event.threadId;
        this.store.update(id, { threadId }).catch(() => {});
      }
      if (event.type === 'activity' && event.kind === 'tool-output') {
        const key = `${event.turnId}:${event.itemId}`;
        if (!outputNotices.has(key)) {
          outputNotices.add(key);
          this.emit(id, { type: 'activity', kind: 'tool-output', itemId: event.itemId, message: '正在读取文件或检查命令结果…' });
        }
        return;
      }
      const labels = { reasoning: '正在分析需求与实现…', commandExecution: event.status === 'completed' ? `本地命令已结束${event.exitCode != null ? `（退出码 ${event.exitCode}）` : ''}` : '正在运行本地命令…', fileChange: event.status === 'completed' ? '项目文件已保存。' : '正在编辑项目文件…', plan: '已更新开发步骤。' };
      this.emit(id, event.type === 'activity' ? { ...event, message: labels[event.kind] || event.message || event.text || '正在执行工具…' } : event);
    };
    const saveThread = async result => {
      if (result.threadId) { threadId = result.threadId; await this.store.update(id, { threadId }); }
      if (result.status !== 'completed') throw new Error(result.error || result.finalResponse || `执行结束：${result.status}`);
      return result;
    };
    try {
      await mkdir(join(this.store.evidenceDir(id), runId), { recursive: true });
      const planTemplate = { schemaVersion: 1, designId: runId, concept: '与内容有关的一句设计构想', audience: '具体受众', primaryAction: '用户主要动作', typography: '中文字体角色、字重、字距、行长与断行', palette: '配色角色及其用途', composition: '首屏构图、留白与视觉重心', keyVisual: '主视觉材质、空间与实际实现方式', mobile: '手机独立构图与阅读顺序', motion: '运动目的与减少动态的替代方式', sections: [{ name: '首屏', purpose: '叙事或任务目的', composition: '该段的版式' }, { name: '代表性内容段', purpose: '展示中段节奏', composition: '与首屏不同的构图' }], assets: [], references: [] };
      const directionPrompt = `${DESIGN_DIRECTION_GUIDANCE}\n宿主要求：在真实index.html方向稿之外，写入DESIGN_PLAN.json。必须用本轮designId。结构如下（替换所有占位内容）：\n${JSON.stringify(planTemplate, null, 2)}\nsections为1至8段；工具页可只有真实任务区域。assets为0至12项，每项{name,kind:"code"或"local"或"missing",purpose,path?}；code表示原创代码内视觉，local需要相对路径且文件实际存在，缺少的关键素材必须missing，不能用假图片掩盖；missing会阻止确认。references为0至4项{name,url,lesson}，只填本轮真实提供且核实的HTTPS参考，没有就空数组。不要虚构已浏览参考或复制品牌字体素材。本轮只交付方向稿，等待用户确认，不生成美感通过报告。`;
      const completionPrompt = approvedPlan ? `${DESIGN_COMPLETION_GUIDANCE}\n用户已确认的方向快照（按此完善，保留构图和字体逻辑）：\n${JSON.stringify(approvedPlan)}` : '';
      if (confirmedDesignId) {
        const current = validateDesignPlan(JSON.parse((await this.store.readFile(id, 'DESIGN_PLAN.json')).content), confirmedDesignId);
        if (!current.valid || digest(current.plan) !== project.designPlanHash || await this.sourceHash(id, { renderOnly: true }) !== project.designRenderHash) throw new Error('启动前设计稿发生变化，请重新生成并确认方向。');
        await this.store.update(id, { designApprovedId: confirmedDesignId });
      }
      controller.signal.throwIfAborted();
      const first = await this.engine.run({ threadId, cwd, prompt: `${BUILD_RULES}\n\n${DESIGN_BUILD_GUIDANCE}\n\n${mode === 'design' ? directionPrompt : completionPrompt}\n\n用户本次需求：\n${userText}`, onEvent, signal: controller.signal });
      await saveThread(first);
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort('截图与美感复核达到本次运行时间上限。'), this.reviewTimeoutMs);
      let files = await this.store.listFiles(id);
      this.emit(id, { type: 'files', files });
      if (mode === 'design') {
        await this.finishDirection({ id, runId, startedAt, threadId, first, controller, files });
        return;
      }
      if (!files.some(file => file.path === 'index.html')) {
        const reply = first.finalResponse || '本轮未生成入口文件。请补充需求后继续。';
        await this.store.addMessage(id, { role: 'assistant', text: reply });
        this.emit(id, { type: 'message', role: 'assistant', text: reply });
        await this.store.update(id, { activeRunId: null });
        await this.phase(id, 'needs_attention', 'awaiting_details', '尚未生成网页，查看Agent回复后继续补充。');
        await this.store.appendRun(id, { id: runId, startedAt, finishedAt: new Date().toISOString(), status: 'needs_attention', threadId });
        this.emit(id, { type: 'done', project: await this.store.get(id) });
        return;
      }
      await this.phase(id, 'verifying', 'rendering', '已生成源码，正在检查电脑和手机实际渲染…');
      const initialRenderHash = await this.sourceHash(id, { renderOnly: true });
      let checked = await this.validate({ root: cwd, out: join(this.store.evidenceDir(id), runId, 'initial'), signal: controller.signal });
      let finalResponse = first.finalResponse;
      let reviewed = false;
      let reviewRequested = false;
      let reRendered = false;
      let design = { valid: false, report: null, needsAttention: true, issues: ['实际截图尚不可用，未进行本轮美感复核。'] };
      if (checked.available) {
        await this.phase(id, 'reviewing', 'visual_review', checked.ok ? '正在逐项检查层级、字体、配色、构图与手机美感…' : '正在结合真实错误与截图修正功能和视觉问题…');
        const reviewTemplate = {
          schemaVersion: 1, reviewId: runId, direction: '说明本项目采用的视觉方向及其与内容、受众的关系',
          checks: DESIGN_CRITERIA.map(item => ({ id: item.id, status: 'not_checked', desktop: '替换为实际电脑截图观察', mobile: '替换为实际手机截图观察' })),
          changes: [], remainingIssues: []
        };
        reviewRequested = true;
        const review = await this.engine.run({
          threadId, cwd, images: checked.images,
          prompt: `对本轮需求进行渲染后的美感与可用性审查。用户本次需求：${userText}\n图片依次为1440×1000电脑首屏和390×844手机首屏；全页图片与报告位于${join(this.store.evidenceDir(id), runId, 'initial')}。\n实际检查结果：${JSON.stringify({ issues: checked.issues, summary: checked.summary })}\n\n${DESIGN_REVIEW_GUIDANCE}\n\n七项检查依据：\n${DESIGN_CRITERIA.map(item => `${item.id}（${item.label}）：${item.question}`).join('\n')}\n\n完成必要修订后，必须在当前项目写入DESIGN_REVIEW.json，格式如下：\n${JSON.stringify(reviewTemplate, null, 2)}\nreviewId必须使用上述本轮编号；将所有占位文字替换为具体观察。每项status只能为pass（模型判断已处理/未发现问题）、needs_work（仍有问题）或not_checked（无法检查）。desktop和mobile分别记录实际依据，包含已处理问题时说明如何修订；这份记录是模型的审查判断，不是独立认证。changes必须为字符串数组，每项用一句话说明文件和实际修改，例如["index.html：调整手机标题行距"]；没有修改时用空数组，不使用对象数组。remainingIssues每项格式为{criterion:上述七个id之一,problem:具体问题,location:页面位置,nextAction:下一步动作}，没有则为空数组。不要编造图片、交互测试或通过结果；无法检查的内容如实注明。同步更新DESIGN.md，简短中文说明方向、修改与未解决项。宿主会对最新源码重新截图并自动检查；不要声称已查看尚未提供的修订后截图。`,
          onEvent, signal: controller.signal
        });
        await saveThread(review);
        finalResponse = review.finalResponse;
        design = await this.designReview(id, runId);
        reviewed = design.valid;
        if (design.valid) await writeFile(join(this.store.evidenceDir(id), runId, 'design-review.json'), JSON.stringify(design.report, null, 2));
        if (await this.sourceHash(id, { renderOnly: true }) !== initialRenderHash) {
          await this.phase(id, 'verifying', 'rechecking', '修订已写入，正在重新检查最新版本…');
          checked = await this.validate({ root: cwd, out: join(this.store.evidenceDir(id), runId, 'final'), signal: controller.signal });
          reRendered = true;
        }
      }
      if (controller.signal.aborted) throw new Error('任务已停止。');
      const sourceHash = await this.sourceHash(id);
      const issues = [...new Set([...checked.issues, ...design.issues])].slice(0, 20);
      const status = checked.ok && reviewed && !design.needsAttention ? 'completed' : 'needs_attention';
      const evidence = { sourceHash, renderSourceHash: await this.sourceHash(id, { renderOnly: true }), reviewInputRenderSourceHash: initialRenderHash, reviewInputScreenshotSet: reviewRequested ? 'initial' : null, reRendered, finalImagesProvidedForReview: reviewRequested && !reRendered, checkedAt: new Date().toISOString(), automatedPassed: checked.ok, visualReviewRequested: reviewRequested, designReviewRecorded: design.valid, designNeedsAttention: design.needsAttention, designDirection: design.report?.direction, issues, reportPath: checked.reportPath };
      await writeFile(join(this.store.evidenceDir(id), runId, 'result.json'), JSON.stringify(evidence, null, 2));
      const designNote = design.valid ? `\n\n视觉方向：${design.report.direction}\n已保存本轮七项美感审查记录${design.needsAttention ? '，其中仍有待处理项' : '与实际修订说明'}。` : '';
      const suffix = status === 'completed' ? `${designNote}\n\n源码与预览已更新。电脑和手机的自动渲染检查通过。美感记录来自Agent对截图与本轮修订的判断，最终风格由你确认。` : `${designNote}\n\n网页源码已保存，可以查看预览。仍需处理：${issues.join('；') || '视觉检查尚未完成'}`;
      const reply = `${finalResponse || '本轮文件修改已完成。'}${suffix}`;
      await this.store.addMessage(id, { role: 'assistant', text: reply });
      this.emit(id, { type: 'message', role: 'assistant', text: reply });
      files = await this.store.listFiles(id);
      await this.store.update(id, { status, phase: 'finished', activeRunId: null, fileCount: files.length, lastValidation: { ok: checked.ok, reviewed, issues, sourceHash } });
      await this.store.appendRun(id, { id: runId, startedAt, finishedAt: new Date().toISOString(), status, threadId, sourceHash, validation: evidence });
      this.emit(id, { type: 'files', files });
      this.emit(id, { type: 'status', status, phase: 'finished', message: status === 'completed' ? '本轮完成，可以查看网页并继续提出修改。' : '网页可预览，仍有待处理项。' });
      this.emit(id, { type: 'done', project: await this.store.get(id) });
    } finally { clearTimeout(deadline); }
  }
  async finishError(id, error, interrupted, runId, reason) {
    const message = interrupted ? `${typeof reason === 'string' ? reason : '本轮任务已停止。'} 已生成的文件仍保留。` : `本轮未完成：${String(error.message).slice(0, 1800)}`;
    await this.store.update(id, { status: interrupted ? 'interrupted' : 'failed', phase: 'finished', activeRunId: null, lastError: message });
    await this.store.addMessage(id, { role: 'assistant', text: message });
    await this.store.appendRun(id, { id: runId, finishedAt: new Date().toISOString(), status: interrupted ? 'interrupted' : 'failed', error: message });
    this.emit(id, { type: 'error', message });
    this.emit(id, { type: 'status', status: interrupted ? 'interrupted' : 'failed', phase: 'finished', message });
    this.emit(id, { type: 'done', project: await this.store.get(id) });
  }
  async stop(id) { this.active.get(id)?.controller.abort(); return { ok: true }; }
  async close() {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map(active => active.task));
  }
}
