import { spawn } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./renderer/capture.mjs', import.meta.url));

async function browserEnvironment() {
  const env = { ...process.env };
  if (!env.PLAYWRIGHT_CHANNEL && process.platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
      if (!base) continue;
      try { await access(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')); env.PLAYWRIGHT_CHANNEL = 'msedge'; break; }
      catch { /* Playwright Chromium remains the default. */ }
    }
  }
  return env;
}

export async function checkRender({ root, out, signal }) {
  await mkdir(dirname(out), { recursive: true });
  let stderr = '';
  const env = await browserEnvironment();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, '--root', root, '--out', out, '--label', 'final', '--timeout-ms', '45000'], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    // Let the helper's bounded timeout perform browser/server cleanup. An aborted
    // request waits for this bounded check before returning, rather than orphaning Chromium.
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  if (signal?.aborted) throw new Error('任务已停止。');
  let report;
  try { report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')); }
  catch { return { ok: false, available: false, issues: [stderr || '渲染工具没有生成检查报告。'], images: [] }; }
  if (report.status !== 'complete') {
    return { ok: false, available: false, issues: [report.error || stderr || '渲染检查未完成。'], reportPath: join(out, 'report.json'), images: [] };
  }
  const issues = [];
  for (const view of report.viewports) {
    const prefix = view.name === 'mobile' ? '手机端' : '电脑端';
    if (!view.navigation?.ok) issues.push(`${prefix}无法正常加载：${view.navigation?.status ?? view.navigation?.error}`);
    for (const item of view.pageErrors ?? []) issues.push(`${prefix}脚本错误：${item.message}`);
    for (const item of view.consoleErrors ?? []) issues.push(`${prefix}控制台错误：${item.message}`);
    for (const item of view.httpErrors ?? []) issues.push(`${prefix}资源加载失败：${item.status} ${item.url}`);
    for (const item of view.requestFailures ?? []) issues.push(`${prefix}资源请求失败：${item.url}`);
    for (const item of view.blockedRequests ?? []) issues.push(`${prefix}使用了不可用的外部资源：${item.url}`);
    if (view.diagnostics?.horizontalOverflow) issues.push(`${prefix}出现横向溢出。`);
    for (const item of view.diagnostics?.brokenImages ?? []) issues.push(`${prefix}图片未加载：${item.src}`);
    for (const item of view.diagnostics?.controls?.missingLocalAnchorTargets ?? []) issues.push(`${prefix}链接目标不存在：${item.href}`);
  }
  return {
    ok: issues.length === 0, available: true, issues: [...new Set(issues)].slice(0, 20),
    summary: report.summary, reportPath: join(out, 'report.json'),
    images: ['desktop.png', 'mobile.png'].map(name => join(out, name)),
    frames: { desktop: join(out, 'desktop.png'), detail: join(out, 'desktop-detail.png'), mobile: join(out, 'mobile.png') },
    note: '自动检查覆盖加载、脚本与部分布局问题；视觉审查由 Agent 查看实际截图完成。'
  };
}
