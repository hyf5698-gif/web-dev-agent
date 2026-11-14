'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const state = { engine: null, projects: [], project: null, design: null, designImages: null, composerMode: null, approvingDesign: false, autoViewPending: false, files: [], selectedFile: null, fileContent: '', eventSource: null, stream: null, pendingUser: null, messageKeys: new Set(), approvals: new Map(), submitting: false, stopping: false, loading: false, connected: false, selection: 0, currentView: 'design', eventCount: 0 };
  const activeStatuses = new Set(['running', 'verifying', 'reviewing']);
  const statuses = { idle: '等待需求', awaiting_design: '待确认设计', running: '正在制作', verifying: '正在验证', reviewing: '正在审查', completed: '已完成', needs_attention: '需要处理', failed: '执行失败', interrupted: '已停止' };
  const phases = { ready: '等待需求', designing: '构思设计方向', design_brief: '整理设计方向', design_images: '制作设计效果图', direction_preview: '拍摄设计预览', design_needs_attention: '调整设计方向', awaiting_design: '待确认设计', developing: '完善网页与交互', rendering: '检查实际渲染', visual_review: '美感复核与修订', rechecking: '复查最新版本', awaiting_details: '等待补充需求', finished: '本轮结束' };
  const designViews = [['desktop', '电脑首屏', '第一眼的布局、文字与视觉重点'], ['detail', '页面中段', '内容层次、信息节奏与细节'], ['mobile', '手机效果', '小屏幕上的布局与阅读体验']];
  const eventNames = { status: '状态更新', activity: '执行活动', message: '对话消息', files: '文件更新', approval: '等待确认', error: '发生错误', done: '本轮结束' };
  let toastTimer;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = String(message); $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
  function time(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  function date(value) { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); }
  function isRunning() { return Boolean(state.project && activeStatuses.has(state.project.status)); }
  function ready() { return state.engine?.available === true && state.engine?.authenticated === true; }

  async function api(url, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-Requested-With'] = 'web-dev-agent'; }
    let response;
    try { response = await fetch(url, { method, headers, credentials: 'same-origin', ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }); }
    catch { throw new Error('无法连接本地服务，请确认开发服务仍在运行。'); }
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`本地服务返回了无法读取的响应（${response.status}）。`); }
    if (!response.ok) { const detail = payload?.message || payload?.error?.message || payload?.error; throw new Error(typeof detail === 'string' ? detail : `请求失败（${response.status}）。`); }
    return payload;
  }

  function syncComposer() {
    const active = isRunning();
    const text = $('#message-input').value.trim();
    $('#send-message').disabled = !ready() || active || state.submitting || state.approvingDesign || state.loading || !text;
    $('#send-label').textContent = state.submitting ? '正在发送' : state.composerMode === 'design' ? '发送设计调整' : (state.project && $('#messages').children.length ? '发送修改' : '发送需求');
    $('#stop-run').hidden = !active;
    $('#stop-run').disabled = state.stopping;
    $('#composer-note').textContent = !state.engine ? '正在检查引擎' : !state.engine.available ? '引擎离线，可先整理需求' : !state.engine.authenticated ? '登录 Codex 后即可发送' : active ? '执行中，可随时停止' : state.composerMode === 'design' ? '说明想调整的风格、配色或布局' : state.design && !state.design.approved ? '可补充要求，或查看设计后确认' : state.project ? '继续对话，修改当前项目' : '发送后先制作设计方向';
    $('#composer-mode').hidden = state.composerMode !== 'design';
    $('#cancel-design-mode').disabled = state.submitting;
    $('#message-input').placeholder = state.composerMode === 'design' ? '想把设计改成什么样？描述风格、配色、布局或参考…' : '描述你的网页需求，或继续提出修改…';
    $('#input-count').textContent = `${$('#message-input').value.length} / 12000`;
    syncDesignActions();
  }

  function renderEngine() {
    const engine = state.engine;
    const badge = $('#engine-status');
    let label = '正在检查引擎', kind = 'checking', message = '';
    if (engine) {
      if (!engine.available) { label = 'Codex 引擎离线'; kind = 'offline'; message = engine.message || '尚未检测到可用的 Codex 引擎。请完成本机引擎配置后刷新状态。'; }
      else if (!engine.authenticated) { label = 'Codex 尚未登录'; kind = 'unauthenticated'; message = engine.message || '已检测到 Codex。请在本机完成账号登录，再刷新引擎状态。'; }
      else { label = 'Codex 已连接'; kind = 'ready'; }
    }
    badge.className = `engine-status ${kind}`;
    $('#engine-label').textContent = label;
    $('#engine-notice').hidden = !message;
    $('#engine-message').textContent = message;
    $('#chat-model').textContent = engine?.model ? `Codex · ${engine.model}` : '使用现有 Codex 账号';
    $('#chat-status').textContent = ready() ? (isRunning() ? '执行中' : '已就绪') : engine?.available ? '未登录' : '离线';
    syncComposer();
  }

  async function refreshEngine() {
    $('#refresh-engine').disabled = true;
    try { const result = await api('/api/status'); state.engine = result.engine || { available: false, authenticated: false, message: '服务未返回引擎状态。' }; }
    catch (error) { state.engine = { available: false, authenticated: false, message: error.message }; }
    finally { $('#refresh-engine').disabled = false; renderEngine(); }
  }

  function upsertProject(project) {
    if (!project?.id) return;
    const index = state.projects.findIndex(item => item.id === project.id);
    if (index < 0) state.projects.unshift(project); else state.projects[index] = { ...state.projects[index], ...project };
    renderProjects();
  }

  function renderProjects() {
    const list = $('#project-list'); list.replaceChildren();
    if (!state.projects.length) { list.append(node('p', 'sidebar-empty', '还没有项目。\n新建一个，开始制作你的网页。')); return; }
    for (const project of state.projects) {
      const button = node('button', `project-item${state.project?.id === project.id ? ' active' : ''}`); button.type = 'button'; button.dataset.status = project.status || 'idle'; button.setAttribute('aria-current', state.project?.id === project.id ? 'true' : 'false');
      button.append(node('span', 'project-item-icon', '▧'));
      const content = node('span', 'project-item-content'); content.append(node('span', 'project-item-name', project.name || '未命名项目'));
      const meta = node('span', 'project-item-meta'); meta.append(node('i'), node('span', '', statuses[project.status] || '等待需求'));
      if (project.updatedAt) meta.append(node('span', '', `· ${date(project.updatedAt)}`));
      content.append(meta); button.append(content); button.addEventListener('click', () => selectProject(project.id)); list.append(button);
    }
  }

  async function loadProjects(selectFirst = false) {
    $('#reload-projects').disabled = true;
    try { const result = await api('/api/projects'); state.projects = Array.isArray(result.projects) ? result.projects : []; renderProjects(); if (selectFirst && !state.project && state.projects.length) await selectProject(state.projects[0].id, false); }
    catch (error) { $('#project-list').replaceChildren(node('p', 'sidebar-empty', error.message)); }
    finally { $('#reload-projects').disabled = false; }
  }

  function setView(view) {
    state.currentView = view;
    document.querySelectorAll('[data-view]').forEach(button => { const selected = button.dataset.view === view; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    for (const name of ['design', 'preview', 'source', 'events']) $(`#view-${name}`).hidden = name !== view;
    if (view === 'events') $('#events-dot').hidden = true;
  }

  function mobileView(view) { document.body.dataset.mobileView = view; document.querySelectorAll('[data-mobile-target]').forEach(button => { const selected = button.dataset.mobileTarget === view; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false'); }); }

  function safePreview(url) {
    if (typeof url !== 'string') return null;
    try { const target = new URL(url, location.origin); if (target.origin !== location.origin || !target.pathname.startsWith('/preview/')) return null; return target.href; } catch { return null; }
  }

  function designImageKey() {
    if (!state.project || !state.design?.designId) return '';
    return `${state.project.id}|${state.design.designId}|${designViews.map(([view]) => state.design.images?.[view] === true ? '1' : '0').join('')}`;
  }

  function designIssues() {
    const design = state.design;
    if (!design) return [];
    const issues = !design.approved && Array.isArray(design.issues) ? design.issues.filter(issue => typeof issue === 'string' && issue.trim()) : [];
    for (const [view, label] of designViews) {
      if (design.images?.[view] !== true && !design.approved) issues.push(`${label}图尚未生成。`);
      else if (state.designImages?.failed.has(view)) issues.push(`${label}图暂时无法加载，请重新加载后查看。`);
    }
    if (!design.approved && !design.ready && !issues.length && !isRunning()) issues.push('设计图或所需素材还未准备齐全，请补充要求让 Agent 完善。');
    return [...new Set(issues)];
  }

  function syncDesignActions() {
    const design = state.design, active = isRunning();
    const imageState = state.designImages;
    const imagesLoaded = imageState?.key === designImageKey() && designViews.every(([view]) => imageState.loaded.has(view));
    const issues = designIssues();
    const canApprove = Boolean(design?.designId && design.ready === true && !design.approved && !issues.length && imagesLoaded);
    $('#approve-design').disabled = !canApprove || !ready() || active || state.loading || state.submitting || state.approvingDesign;
    $('#approve-design').hidden = Boolean(design?.approved);
    $('#approve-design').textContent = state.approvingDesign ? '正在开始制作…' : '按此方向完善网页';
    $('#adjust-design').disabled = active || state.loading || state.submitting || state.approvingDesign;
    $('#adjust-design').textContent = design?.approved ? '重新定设计方向' : '调整设计方向';
    $('#redesign-project').hidden = !state.project || (!state.files.length && !design);
    $('#redesign-project').disabled = active || state.loading || state.submitting || state.approvingDesign;
    $('#start-design').disabled = state.loading || state.submitting || state.approvingDesign;
    $('#design-decision-title').textContent = design?.approved ? '这个方向已确认' : '这个方向合适吗？';
    $('#design-decision-note').textContent = design?.approved ? '可以随时回来查看设计说明，继续在对话中修改网页。' : active ? '正在整理设计，完成后可查看并确认。' : issues.length ? '设计图和素材补齐后，即可确认方向。' : !imagesLoaded ? '正在加载设计图，请先查看完整效果。' : !ready() ? '设计已准备好，连接引擎后即可开始完善网页。' : '确认后，Agent 会按这些设计图完善网页。';
    $('#design-issues').hidden = !issues.length;
    $('#design-issue-list').replaceChildren(...issues.map(issue => node('li', '', issue)));
    $('#retry-design-images').hidden = !imageState?.failed.size;
    $('#design-chat-notice').hidden = !design || design.approved || active;
  }

  function renderDesignImages(force = false) {
    const key = designImageKey();
    if (!force && state.designImages?.key === key) return;
    const grid = $('#design-images'); grid.replaceChildren();
    state.designImages = { key, loaded: new Set(), failed: new Set() };
    const imageState = state.designImages;
    if (!key) return;
    for (const [view, label, description] of designViews) {
      const card = node('figure', `design-image-card design-image-${view}`); card.dataset.designView = view;
      const imageArea = node('div', 'design-image-area');
      const placeholder = node('p', 'design-image-placeholder', state.design.images?.[view] === true ? '正在加载设计图…' : '此视图尚未生成');
      imageArea.append(placeholder);
      if (state.design.images?.[view] === true) {
        const url = `/api/projects/${encodeURIComponent(state.project.id)}/design-image?view=${view}&v=${encodeURIComponent(state.design.designId)}${force ? `&reload=${Date.now()}` : ''}`;
        const link = node('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('aria-label', `查看${label}设计原图`); link.hidden = true;
        const img = node('img'); img.alt = `${label}设计效果图`; img.decoding = 'async';
        img.addEventListener('load', () => {
          if (state.designImages !== imageState) return;
          state.designImages.loaded.add(view); state.designImages.failed.delete(view); placeholder.hidden = true; link.hidden = false; card.dataset.imageState = 'loaded'; syncDesignActions();
        });
        img.addEventListener('error', () => {
          if (state.designImages !== imageState) return;
          state.designImages.failed.add(view); state.designImages.loaded.delete(view); placeholder.textContent = '设计图暂时无法加载'; placeholder.hidden = false; link.hidden = true; card.dataset.imageState = 'failed'; syncDesignActions();
        });
        link.append(img); imageArea.append(link); img.src = url;
      }
      const caption = node('figcaption'); caption.append(node('strong', '', label), node('span', '', description)); card.append(imageArea, caption); grid.append(card);
    }
  }

  function renderDesignPlan() {
    const container = $('#design-plan'); container.replaceChildren();
    const plan = state.design?.plan;
    if (!plan || typeof plan !== 'object') { container.append(node('p', 'design-plan-empty', '设计说明还在整理中。')); return; }
    const concept = node('section', 'design-concept'); concept.append(node('h4', '', '整体想法'), node('p', '', typeof plan.concept === 'string' && plan.concept.trim() ? plan.concept : '设计说明还在整理中。')); container.append(concept);
    const details = node('dl', 'design-details');
    for (const [field, label] of [['audience', '面向谁'], ['primaryAction', '希望访客做什么'], ['typography', '字体与文字'], ['palette', '配色'], ['composition', '版式与节奏'], ['keyVisual', '主视觉'], ['mobile', '手机布局'], ['motion', '动效与交互']]) {
      if (typeof plan[field] !== 'string' || !plan[field].trim()) continue;
      const item = node('div', 'design-detail'); item.append(node('dt', '', label), node('dd', '', plan[field])); details.append(item);
    }
    if (details.children.length) container.append(details);
    const sections = Array.isArray(plan.sections) ? plan.sections.filter(item => item && typeof item.name === 'string') : [];
    if (sections.length) {
      const section = node('section', 'design-plan-section'); section.append(node('h4', '', '页面怎样展开'));
      const list = node('ol', 'design-section-list');
      for (const item of sections) { const row = node('li'); row.append(node('strong', '', item.name)); if (typeof item.purpose === 'string') row.append(node('p', '', item.purpose)); if (typeof item.composition === 'string') row.append(node('p', 'design-section-composition', item.composition)); list.append(row); }
      section.append(list); container.append(section);
    }
    const assets = Array.isArray(plan.assets) ? plan.assets.filter(item => item && typeof item.name === 'string') : [];
    if (assets.length) {
      const section = node('section', 'design-plan-section'); section.append(node('h4', '', '视觉素材'));
      const list = node('ul', 'design-asset-list');
      for (const item of assets) { const row = node('li'); row.append(node('strong', '', item.name)); if (typeof item.purpose === 'string') row.append(node('p', '', item.purpose)); list.append(row); }
      section.append(list); container.append(section);
    }
    const references = Array.isArray(plan.references) ? plan.references.filter(item => item && typeof item.name === 'string') : [];
    if (references.length) {
      const section = node('section', 'design-plan-section'); section.append(node('h4', '', '参考与借鉴'));
      const list = node('ul', 'design-reference-list');
      for (const item of references) {
        const row = node('li'); let url;
        try { const target = new URL(item.url); if (['http:', 'https:'].includes(target.protocol)) url = target.href; } catch { /* A reference without a safe URL is shown as text. */ }
        const title = node(url ? 'a' : 'strong', '', item.name); if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; } row.append(title);
        if (typeof item.lesson === 'string') row.append(node('p', '', item.lesson)); list.append(row);
      }
      section.append(list); container.append(section);
    }
  }

  function renderDesign() {
    const design = state.design;
    const building = Boolean(design?.approved || (!design && state.files.length));
    $('#workflow-design').classList.toggle('active', !building);
    $('#workflow-design').classList.toggle('complete', building);
    $('#workflow-build').classList.toggle('active', building);
    $('#design-content').hidden = !design;
    $('#design-empty').hidden = Boolean(design);
    $('#design-state').textContent = design?.approved ? '已确认方向' : isRunning() ? '正在制作' : design ? '待确认设计' : '等待需求';
    $('#design-state').dataset.state = design?.approved ? 'approved' : design ? 'pending' : 'empty';
    $('#design-description').textContent = design?.approved ? '这是已确认的设计方向。实际网页的内容和交互可继续在对话中调整。' : '先看电脑首屏、页面中段和手机效果。确认喜欢这个方向后，再开始完善网页。';
    $('#design-empty-title').textContent = isRunning() ? '正在制作设计方向' : state.files.length ? '这个项目还没有设计方向' : '先聊聊你想做的网页';
    $('#design-empty-description').textContent = isRunning() ? '设计图和说明准备好后会显示在这里，完成前可以查看执行记录。' : state.files.length ? '已有网页可以继续修改。也可以重新定设计方向，先看效果图再制作。' : '告诉 Agent 用途、内容和喜欢的风格，它会先制作设计图供你确认。';
    $('#start-design').textContent = isRunning() ? '查看执行记录' : state.files.length ? '重新定设计方向' : '去描述需求';
    renderDesignImages(); renderDesignPlan(); syncDesignActions();
  }

  function enterDesignMode() {
    if (isRunning() || state.submitting || state.approvingDesign || state.loading) return;
    state.composerMode = 'design'; syncComposer(); mobileView('chat'); $('#message-input').focus();
  }

  async function approveDesign() {
    syncDesignActions();
    if ($('#approve-design').disabled || !state.project || !state.design) return;
    const id = state.project.id, designId = state.design.designId, selection = state.selection;
    state.approvingDesign = true; syncComposer();
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/approve-design`, { method: 'POST', body: { designId } });
      if (selection !== state.selection || state.design?.designId !== designId) return;
      state.design = { ...state.design, approved: true }; state.composerMode = null;
      if (result.project) { state.project = result.project; upsertProject(result.project); }
      else if (result.runId) { state.project.status = 'running'; upsertProject(state.project); }
      renderProject(); setView('preview'); mobileView('workspace'); toast('方向已确认，正在按此方向完善网页。');
      await loadSnapshot(id, selection);
    } catch (error) { if (selection === state.selection) toast(error.message); }
    finally { state.approvingDesign = false; syncComposer(); }
  }

  function renderProject(refreshPreview = false) {
    const project = state.project;
    $('#project-name').textContent = project?.name || '未选择项目';
    $('#project-meta').textContent = project ? `${state.files.length} 个文件 · 保存在本机` : '设计方向、网页预览和执行记录';
    $('#project-status').textContent = project ? statuses[project.status] || project.status || '等待需求' : '等待开始';
    $('#project-status').dataset.status = project?.status || 'idle';
    const showRun = Boolean(project && (activeStatuses.has(project.status) || ['failed', 'interrupted'].includes(project.status) || (project.status === 'needs_attention' && project.phase !== 'ready')));
    $('#run-banner').hidden = !showRun; $('#run-banner').dataset.status = project?.status || 'idle';
    $('#run-phase').textContent = project ? statuses[project.status] || '执行状态' : '执行状态';
    if (!showRun) $('#run-message').textContent = '';
    const url = safePreview(project?.previewUrl);
    const canPreview = Boolean(url && (state.files.length || Number(project?.fileCount) > 0));
    $('#export-project').disabled = !canPreview || isRunning();
    $('#preview-empty').hidden = canPreview; $('#preview-frame').hidden = !canPreview; $('#refresh-preview').disabled = !canPreview;
    $('#empty-create').hidden = Boolean(project);
    $('#preview-empty-title').textContent = state.design?.approved ? '正在把设计做成网页。' : project ? '确认设计后，网页会出现在这里。' : '你的下一个网页，从这里开始。';
    $('#preview-empty-description').textContent = state.design?.approved ? '实际页面生成后会显示在这里。你可以继续查看设计方向和执行记录。' : '先在对话中描述需求，查看设计图并确认方向，再完善网页与交互。';
    if (canPreview) { const frame = $('#preview-frame'); if (frame.dataset.baseUrl !== url || refreshPreview) { frame.dataset.baseUrl = url; const target = new URL(url); if (refreshPreview) target.searchParams.set('_preview', String(Date.now())); frame.src = target.href; } $('#preview-address').textContent = new URL(url).pathname; }
    else { $('#preview-frame').removeAttribute('src'); delete $('#preview-frame').dataset.baseUrl; $('#preview-address').textContent = '本地项目预览'; }
    $('#chat-status').textContent = ready() ? (isRunning() ? '执行中' : '已就绪') : state.engine?.available ? '未登录' : '离线';
    renderDesign(); syncComposer();
  }

  function clearChat() { $('#messages').replaceChildren(); $('#approvals').replaceChildren(); state.messageKeys.clear(); state.approvals.clear(); state.stream = null; state.pendingUser = null; $('#chat-welcome').hidden = false; }
  function scrollChat(force = false) { const scroll = $('#chat-scroll'); if (force || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 170) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; }); }

  function addMessage(message, options = {}) {
    if (typeof message?.text !== 'string' || !message.text) return null;
    const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'system';
    const key = `${role}|${message.text}|${message.createdAt || ''}`;
    if (state.messageKeys.has(key)) return null;
    if (role === 'user' && state.pendingUser?.text === message.text && !options.pending) { state.pendingUser.element.querySelector('time').textContent = time(message.createdAt); state.pendingUser = null; state.messageKeys.add(key); return null; }
    if (role === 'assistant' && state.stream) { state.stream.body.textContent = message.text; state.stream.element.classList.remove('streaming'); state.stream.element.querySelector('time').textContent = time(message.createdAt); const result = state.stream.element; state.stream = null; state.messageKeys.add(key); scrollChat(); return result; }
    state.messageKeys.add(key); $('#chat-welcome').hidden = true;
    const article = node('article', 'message'); article.dataset.role = role;
    const heading = node('div', 'message-heading'); heading.append(node('strong', '', role === 'user' ? '你' : role === 'assistant' ? 'Codex' : '执行记录'), node('time', '', options.pending ? '已发送' : time(message.createdAt)));
    article.append(heading, node('div', 'message-body', message.text)); $('#messages').append(article);
    if (options.pending) state.pendingUser = { text: message.text, element: article };
    scrollChat(role === 'user'); syncComposer(); return article;
  }

  function addDelta(delta) {
    if (typeof delta !== 'string' || !delta) return;
    $('#chat-welcome').hidden = true;
    if (!state.stream) { const element = node('article', 'message streaming'); element.dataset.role = 'assistant'; const heading = node('div', 'message-heading'); heading.append(node('strong', '', 'Codex'), node('time', '', '正在输出')); const body = node('div', 'message-body'); element.append(heading, body); $('#messages').append(element); state.stream = { element, body, text: '' }; }
    state.stream.text += delta; state.stream.body.textContent = state.stream.text; scrollChat();
  }

  function appendEvent(type, message, createdAt) {
    if (state.eventCount === 0) $('#event-list').replaceChildren();
    const item = node('li', 'event-item'); item.dataset.type = type; item.append(node('i'));
    const content = node('div', 'event-item-content'), meta = node('div', 'event-meta'); meta.append(node('strong', '', eventNames[type] || '执行活动'), node('time', '', time(createdAt || Date.now()))); content.append(meta, node('p', '', message || eventNames[type] || '引擎返回一条事件')); item.append(content); $('#event-list').append(item);
    state.eventCount++; while ($('#event-list').children.length > 250) $('#event-list').firstElementChild.remove();
    if (state.currentView !== 'events') $('#events-dot').hidden = false;
  }

  function renderFiles(files) {
    state.files = Array.isArray(files) ? files.filter(file => typeof file?.path === 'string') : [];
    $('#file-count').textContent = String(state.files.length); const list = $('#file-list'); list.replaceChildren();
    if (!state.files.length) { list.append(node('p', 'file-empty', '尚无文件。生成后可在这里查看源码。')); state.selectedFile = null; state.fileContent = ''; $('#selected-file').textContent = '选择一个文件查看源码'; $('#source-code').textContent = '生成的真实文件会出现在左侧。'; $('#copy-source').disabled = true; }
    for (const file of state.files) { const button = node('button', `file-item${file.path === state.selectedFile ? ' active' : ''}`); button.type = 'button'; button.title = file.path; button.append(node('span', '', '◇'), node('span', '', file.path)); button.addEventListener('click', () => loadFile(file.path)); list.append(button); }
    if (state.selectedFile && !state.files.some(file => file.path === state.selectedFile)) { state.selectedFile = null; state.fileContent = ''; $('#selected-file').textContent = '文件已更新，请重新选择'; $('#source-code').textContent = '请选择一个项目文件。'; $('#copy-source').disabled = true; }
  }

  async function loadFile(path) {
    if (!state.project) return;
    const projectId = state.project.id; state.selectedFile = path; renderFiles(state.files); $('#selected-file').textContent = path; $('#source-code').textContent = '正在读取文件…'; $('#copy-source').disabled = true;
    try { const result = await api(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`); if (state.project?.id !== projectId || state.selectedFile !== path) return; state.fileContent = typeof result.content === 'string' ? result.content : ''; $('#source-code').textContent = state.fileContent; $('#copy-source').disabled = false; }
    catch (error) { if (state.project?.id === projectId && state.selectedFile === path) { $('#source-code').textContent = error.message; state.fileContent = ''; } }
  }

  async function loadSnapshot(id, selection, replaceMessages = false) {
    const result = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (selection !== state.selection || state.project?.id !== id) return;
    const previousDesignId = state.design?.designId;
    if (result.project) { state.project = result.project; upsertProject(result.project); }
    state.design = result.design || null;
    renderFiles(result.files || []);
    if (replaceMessages) { clearChat(); (result.messages || []).forEach(message => addMessage(message)); scrollChat(true); }
    renderProject();
    if (state.autoViewPending) { setView(state.design && !state.design.approved || !state.files.length ? 'design' : 'preview'); state.autoViewPending = false; }
    else if (state.design && !state.design.approved && state.design.designId !== previousDesignId) { setView('design'); mobileView('workspace'); }
    return result;
  }

  async function selectProject(id, switchMobile = true) {
    if (state.project?.id === id && !state.loading) { if (switchMobile) mobileView('workspace'); return; }
    state.eventSource?.close(); state.eventSource = null; state.connected = false; state.loading = true; state.selection++; const selection = state.selection;
    state.project = state.projects.find(project => project.id === id) || { id, name: '正在读取项目', status: 'idle' };
    state.design = null; state.designImages = null; state.composerMode = null; state.autoViewPending = true;
    clearChat(); renderFiles([]); state.selectedFile = null; state.fileContent = ''; $('#source-code').textContent = '选择一个文件查看源码。'; $('#selected-file').textContent = '选择一个文件查看源码'; $('#copy-source').disabled = true;
    state.eventCount = 0; $('#event-list').replaceChildren(node('li', 'events-empty', '尚无执行记录。发送需求后，进度会实时显示在这里。')); $('#events-dot').hidden = true; $('#run-message').textContent = ''; renderProjects(); renderProject(); $('#connection-note').textContent = '正在读取项目';
    if (switchMobile) mobileView('workspace');
    try { const result = await loadSnapshot(id, selection, true); if (!result || selection !== state.selection) return; const run = Array.isArray(result.runs) ? result.runs[result.runs.length - 1] : null; if (run) appendEvent('status', run.message || `上次运行：${statuses[run.status] || run.status || '已记录'}`, run.updatedAt || run.createdAt); connectEvents(id, selection); }
    catch (error) { if (selection === state.selection) { $('#connection-note').textContent = '项目读取失败'; appendEvent('error', error.message); toast(error.message); } }
    finally { if (selection === state.selection) { state.loading = false; syncComposer(); } }
  }

  function renderApproval(data) {
    if (!data.id || state.approvals.has(String(data.id))) return;
    const id = String(data.id), card = node('section', 'approval-card'); card.append(node('h3', '', '这一步需要你的决定'), node('p', '', data.description || '引擎正在请求执行一项操作。'), node('div', 'approval-method', data.method || ''));
    const actions = node('div', 'approval-actions');
    for (const [decision, label] of [['accept', '允许这一步'], ['decline', '拒绝']]) { const button = node('button', '', label); button.type = 'button'; button.addEventListener('click', async () => { const buttons = [...actions.querySelectorAll('button')]; buttons.forEach(item => { item.disabled = true; }); try { await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } }); card.replaceChildren(node('p', '', decision === 'accept' ? '已允许这一步，等待引擎继续。' : '已拒绝这一步。')); state.approvals.delete(id); } catch (error) { buttons.forEach(item => { item.disabled = false; }); toast(error.message); } }); actions.append(button); }
    card.append(actions); $('#approvals').append(card); state.approvals.set(id, card); $('#chat-welcome').hidden = true; scrollChat(true);
  }

  function connectEvents(id, selection) {
    state.eventSource?.close(); const source = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`); state.eventSource = source;
    source.onopen = () => { if (selection !== state.selection) return; state.connected = true; $('#connection-note').textContent = '实时事件已连接'; };
    source.onerror = () => { if (selection !== state.selection) return; state.connected = false; $('#connection-note').textContent = '事件连接中断，正在自动重连'; };
    source.onmessage = event => {
      if (selection !== state.selection || state.project?.id !== id) return;
      let data; try { data = JSON.parse(event.data); } catch { appendEvent('error', '收到无法读取的引擎事件。'); return; }
      if (data.type === 'message.delta') { addDelta(data.delta); return; }
      if (data.type === 'status') { if (data.status) state.project.status = data.status; if (data.phase) state.project.phase = data.phase; upsertProject(state.project); renderProject(); if (data.phase) $('#run-phase').textContent = phases[data.phase] || statuses[data.status] || '正在执行'; $('#run-message').textContent = data.message || ''; appendEvent('status', data.message || statuses[data.status] || data.status, data.createdAt); }
      else if (data.type === 'message') addMessage(data);
      else if (data.type === 'activity') appendEvent('activity', data.message, data.createdAt);
      else if (data.type === 'files') { renderFiles(data.files); state.project.fileCount = state.files.length; renderProject(true); appendEvent('files', `已更新 ${state.files.length} 个项目文件。`, data.createdAt); }
      else if (data.type === 'approval') { renderApproval(data); appendEvent('approval', data.description || '引擎请求操作确认。', data.createdAt); }
      else if (data.type === 'design') { loadSnapshot(id, selection).catch(error => toast(error.message)); }
      else if (data.type === 'error') { appendEvent('error', data.message || '引擎执行时发生错误。', data.createdAt); $('#run-message').textContent = data.message || '执行出现错误，请查看记录。'; toast(data.message || '引擎执行出现错误。'); refreshEngine(); }
      else if (data.type === 'done') { if (state.stream) { state.stream.element.classList.remove('streaming'); state.stream = null; } if (data.project) { state.project = { ...state.project, ...data.project }; upsertProject(state.project); } state.stopping = false; renderProject(true); appendEvent('done', statuses[state.project?.status] || '本轮执行已结束。', data.createdAt); loadSnapshot(id, selection, true).then(() => { if (selection === state.selection) renderProject(true); }).catch(error => toast(error.message)); }
    };
  }

  function showProjectDialog() { $('#project-error').hidden = true; $('#new-project-name').value = ''; $('#project-dialog').showModal(); $('#new-project-name').focus(); }
  async function createProject(name) { const result = await api('/api/projects', { method: 'POST', body: { name } }); if (!result.project?.id) throw new Error('服务没有返回新项目。'); upsertProject(result.project); await selectProject(result.project.id, false); return result.project; }

  async function sendMessage(event) {
    event.preventDefault(); const message = $('#message-input').value.trim(); if (!message || state.submitting || state.approvingDesign || state.loading || isRunning()) return;
    if (!ready()) { toast(state.engine?.message || '请先连接并登录 Codex 引擎。'); return; }
    const mode = state.composerMode;
    state.submitting = true; syncComposer();
    try {
      if (!state.project) await createProject(message.split('\n')[0].slice(0, 36) || '新网页项目');
      const id = state.project.id, selection = state.selection;
      const result = await api(`/api/projects/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { message, ...(mode === 'design' ? { mode: 'design' } : {}) } });
      if (!result.runId) throw new Error('服务未返回执行编号，请刷新项目确认发送结果。');
      if (selection === state.selection) {
        const last = $('#messages').lastElementChild; const alreadyShown = last?.dataset.role === 'user' && last.querySelector('.message-body')?.textContent === message;
        if (!alreadyShown) addMessage({ role: 'user', text: message }, { pending: true });
        state.composerMode = null;
        if (mode === 'design' || !state.design?.approved && !state.files.length) setView('design');
        $('#message-input').value = ''; $('#message-input').style.height = ''; appendEvent('activity', `需求已接收，执行编号：${result.runId}`); $('#chat-welcome').hidden = true;
      }
    } catch (error) { toast(error.message); appendEvent('error', error.message); refreshEngine(); }
    finally { state.submitting = false; syncComposer(); }
  }

  document.querySelectorAll('[data-mobile-target]').forEach(button => button.addEventListener('click', () => mobileView(button.dataset.mobileTarget)));
  document.querySelectorAll('[data-view]').forEach(button => { button.addEventListener('click', () => setView(button.dataset.view)); button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const list = [...document.querySelectorAll('[data-view]')], index = list.indexOf(button); const target = event.key === 'Home' ? list[0] : event.key === 'End' ? list[list.length - 1] : list[(index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]; setView(target.dataset.view); target.focus(); }); });
  document.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', () => { $('#message-input').value = button.dataset.suggestion; $('#message-input').dispatchEvent(new Event('input')); $('#message-input').focus(); mobileView('chat'); }));
  $('#message-input').addEventListener('input', () => { const textarea = $('#message-input'); textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; syncComposer(); });
  $('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('#send-message').disabled) $('#message-form').requestSubmit(); } });
  $('#message-form').addEventListener('submit', sendMessage);
  $('#approve-design').addEventListener('click', approveDesign);
  $('#adjust-design').addEventListener('click', enterDesignMode); $('#redesign-project').addEventListener('click', enterDesignMode);
  $('#cancel-design-mode').addEventListener('click', () => { state.composerMode = null; syncComposer(); $('#message-input').focus(); });
  $('#review-design').addEventListener('click', () => { setView('design'); mobileView('workspace'); });
  $('#start-design').addEventListener('click', () => { if (isRunning()) setView('events'); else if (state.files.length) enterDesignMode(); else { mobileView('chat'); $('#message-input').focus(); } });
  $('#retry-design-images').addEventListener('click', () => { renderDesignImages(true); syncDesignActions(); });
  $('#refresh-engine').addEventListener('click', refreshEngine); $('#reload-projects').addEventListener('click', () => loadProjects());
  $('#new-project').addEventListener('click', showProjectDialog); $('#empty-create').addEventListener('click', showProjectDialog);
  $('#close-dialog').addEventListener('click', () => $('#project-dialog').close()); $('#cancel-dialog').addEventListener('click', () => $('#project-dialog').close());
  $('#project-form').addEventListener('submit', async event => { event.preventDefault(); const name = $('#new-project-name').value.trim(); if (!name) return; $('#confirm-project').disabled = true; $('#project-error').hidden = true; try { await createProject(name); $('#project-dialog').close(); mobileView('chat'); toast('项目已创建，可以发送需求了。'); $('#message-input').focus(); } catch (error) { $('#project-error').textContent = error.message; $('#project-error').hidden = false; } finally { $('#confirm-project').disabled = false; } });
  $('#refresh-preview').addEventListener('click', () => renderProject(true)); $('#show-events').addEventListener('click', () => setView('events'));
  $('#copy-source').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.fileContent); toast('源码已复制。'); } catch { toast('浏览器未允许复制，请在源码区域选择并复制。'); } });
  $('#export-project').addEventListener('click', () => { if (state.project) location.href = `/api/projects/${encodeURIComponent(state.project.id)}/export`; });
  $('#stop-run').addEventListener('click', async () => { if (!state.project || state.stopping) return; const id = state.project.id, selection = state.selection; state.stopping = true; syncComposer(); try { const result = await api(`/api/projects/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }); if (!result.ok) throw new Error('停止请求未被接受。'); toast('已发送停止请求，等待引擎结束。'); await loadSnapshot(id, selection, false); } catch (error) { toast(error.message); } finally { if (selection === state.selection) { state.stopping = false; syncComposer(); } } });
  window.addEventListener('beforeunload', () => state.eventSource?.close());
  setView('design'); mobileView('chat'); renderProject();
  Promise.allSettled([refreshEngine(), loadProjects(true)]).then(() => { if (!state.project) $('#connection-note').textContent = ready() ? '本地引擎已就绪' : '等待引擎连接'; });
  setInterval(refreshEngine, 20000);
})();
