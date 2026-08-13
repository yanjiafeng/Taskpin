// Agent 执行器：以子进程拉起 codex / kimi / reasonix 完成指定任务。
// 运行状态在内存中（服务重启即丢失跟踪，子进程随服务退出）。
// 打回重做/续跑时会用任务保存的 thread_id 恢复原 CLI 会话。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTask, updateTask, claimTask, addComment, setTaskThread, setTaskLastRun, setTaskUsage, defaultDbPath, resolveMainDir, getSettings, AGENT_NAMES, DbError } from './db.mjs';

export { AGENT_NAMES };

const TASKCTL = fileURLToPath(new URL('../cli/taskctl.mjs', import.meta.url));

// 运行输出在内存中保留的尾部大小：抽屉里的终端式实时视图直接读这段缓冲
const OUTPUT_CAP = 65536;

export const EFFORTS = ['low', 'medium', 'high']; // 思考强度（codex / reasonix 生效）
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
// reasonix 的权限模式（run --permission-mode）；看板的 codex 沙箱名会映射过去
export const REASONIX_MODES = ['manual', 'ask', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'];
const REASONIX_MODE_MAP = { 'read-only': 'plan', 'workspace-write': 'auto', 'danger-full-access': 'bypassPermissions' };

// 从 CLI 输出中识别会话 id（输出滚动截断，必须边收边解析）
const SESSION_PATTERNS = {
  codex: /session id: ([0-9a-f-]{36})/,
  kimi: /kimi -r (session_[0-9a-f-]+)/,
  reasonix: /"session_id":"([^"]+)"/, // run --output-format json 的结果行
};

// 从 CLI 输出解析上下文/token 用量（详情抽屉「上下文大小」的数据源）。
// codex 尾部打印 "tokens used\n12,345"（会话累计）；reasonix 结果行带 usage 字段；kimi 无输出 → null。
export function parseUsage(agent, output) {
  if (!output) return null;
  if (agent === 'codex') {
    const m = /tokens used\s*\n\s*([\d,]+)/.exec(output);
    return m ? { tokens: Number(m[1].replace(/,/g, '')) } : null;
  }
  if (agent === 'reasonix') {
    const line = output.trim().split('\n').reverse().find((l) => l.startsWith('{"type":"result"'));
    if (!line) return null;
    try {
      const u = JSON.parse(line).usage;
      if (!u) return null;
      const input = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      return { input_tokens: input, output_tokens: outputTokens, tokens: input + outputTokens };
    } catch { return null; }
  }
  return null; // kimi -p 不输出用量
}

// reasonix 的权威成功信号是 JSON 结果行（subtype:"success" 且 is_error:false）。
// 实测存在任务成功完成但进程退出码为 1 的误报（其 changelog 也记载过 "-p 文本输出可能以码 1 退出且 stderr 为空"
// 的同类问题），所以 finish 先信结果行；无结果行或字段缺失时回退到退出码语义。
export function parseReasonixResult(output) {
  if (!output) return null;
  const line = output.trim().split('\n').reverse().find((l) => l.startsWith('{"type":"result"'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// reasonix 的 --resume 需要会话文件完整路径；按 session_id 在 Reasonix home 下定位
function findReasonixSessionFile(sessionId) {
  const projectsDir = join(process.env.REASONIX_HOME || join(homedir(), '.reasonix'), 'projects');
  try {
    for (const proj of readdirSync(projectsDir)) {
      const f = join(projectsDir, proj, 'sessions', `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch { /* Reasonix home 不存在 */ }
  return null;
}

function buildCommand(agent, prompt, cwd, dbDir, { model, effort, permission, resumeId } = {}) {
  if (agent === 'codex') {
    const args = ['exec'];
    if (resumeId) {
      // resume 子命令没有 -s/--add-dir：沙箱用 -c 覆盖，工作区可写根沿用原会话
      args.push('resume', '--skip-git-repo-check');
      if (CODEX_SANDBOXES.includes(permission)) args.push('-c', `sandbox_mode=${permission}`);
    } else {
      // workspace-write 沙箱 + 额外放行看板数据库目录（taskctl 要直写 SQLite）
      const sandbox = CODEX_SANDBOXES.includes(permission) ? permission : 'workspace-write';
      args.push('-s', sandbox, '--skip-git-repo-check', '-C', cwd, '--add-dir', dbDir);
    }
    if (model) args.push('-m', model);
    if (EFFORTS.includes(effort)) args.push('-c', `model_reasoning_effort=${effort}`);
    if (resumeId) args.push(resumeId);
    args.push(prompt);
    return { cmd: 'codex', args, cwd };
  }
  if (agent === 'kimi') {
    // 注意：此版本 kimi 的 -p 不能与 --auto/-y 组合（permission 仅 codex 生效）
    const args = [];
    if (resumeId) args.push('-S', resumeId);
    if (model) args.push('-m', model);
    args.push('-p', prompt);
    return { cmd: 'kimi', args, cwd };
  }
  if (agent === 'reasonix') {
    // reasonix run 是非交互模式；--resume 要会话文件完整路径（finish 时按 session_id 定位存库）
    const perm = REASONIX_MODES.includes(permission) ? permission : REASONIX_MODE_MAP[permission] || 'auto';
    const args = ['run', '--dir', cwd, '--permission-mode', perm, '--add-dir', dbDir, '--output-format', 'json'];
    if (resumeId) args.push('--resume', resumeId);
    if (model) args.push('--model', model);
    if (EFFORTS.includes(effort)) args.push('--effort', effort);
    args.push(prompt);
    return { cmd: 'reasonix', args, cwd };
  }
  throw new DbError('VALIDATION', `unknown agent: ${agent} (codex|kimi|reasonix)`);
}

// 执行 prompt 模板（内置默认）。占位符：{{task_id}} {{tctl}} {{project_name}} {{scope}} {{claim_step}}
// （续跑/问答模板只用 {{task_id}} {{tctl}}）。用户可在设置页覆盖，存 settings 表 prompt_new/prompt_resume/prompt_qa。
export const PROMPT_DEFAULTS = {
  new: [
    '你是看板任务执行 Agent，负责完成任务 #{{task_id}}。看板 CLI：{{tctl}}',
    '',
    '项目「{{project_name}}」配置的查找范围（优先在这些路径下定位仓库，但不限于这些路径）：',
    '{{scope}}',
    '',
    '严格按以下流程执行：',
    '1. 若当前工作目录（项目主目录）存在 TASKBOARD_RULES.md，先通读它——那是本项目的规则；若存在 TASKBOARD_MEMORY.md，同样通读——那是本项目已验收任务的记忆',
    '2. {{tctl}} show {{task_id}} —— 完整阅读任务描述与全部评论（评论的 images 字段是图片绝对路径，需要时用读图工具查看）',
    '{{claim_step}}',
    '4. 验收标准检查（铁律）：若任务涉及代码改动/功能实现/文件产出（开发类），描述中必须有「验收标准」。没有 → 不要开始实现：comment（body 以 [提问] 开头，主动给出 2-4 条可验证的验收标准草案，如"运行 X 命令输出 Y"、"页面 Z 出现 W"）后 update --status blocked，等用户确认。拿不准算不算开发类时宁问勿猜；纯调研/问答类不强制',
    '5. 在上述路径下定位对应仓库，完成实现，并运行相关测试自验证；开发类任务须对照描述中的「验收标准」逐条验证',
    "6. {{tctl}} comment {{task_id}} --author agent --body '<结果摘要：变更内容、验证命令与结果、验收标准逐项核对、遗留疑点>'",
    '7. {{tctl}} update {{task_id}} --status in_review --if-version <当前 version>',
    '',
    '需要用户决策或信息不全时，不要猜测：comment（body 以 [提问] 开头，列出问题和可选方案）后 update --status blocked，等用户答复并重新执行你（会续跑本会话）。无法解决的硬阻塞同样 comment 说明后置 blocked。',
    '禁止将任务置为 done（done 只能由用户验收）。',
  ].join('\n'),
  resume: [
    '继续看板任务 #{{task_id}}（你之前执行过，本会话是续跑）。看板 CLI：{{tctl}}',
    '严格按以下流程执行：',
    '1. {{tctl}} show {{task_id}} —— 重点阅读你上次交付/提问后用户新写的评论（答复或验收意见；images 字段是图片绝对路径，用读图工具查看）',
    '2. 若主目录存在 TASKBOARD_RULES.md / TASKBOARD_MEMORY.md，按需参考',
    '3. 按答复/意见继续修改，并运行相关测试自验证；开发类任务对照描述中的「验收标准」逐条验证；标准仍缺失时不要猜：comment（body 以 [提问] 开头，给出验收标准草案）后 update --status blocked 等用户确认',
    "4. {{tctl}} comment {{task_id}} --author agent --body '<本轮变更摘要、验证结果、验收标准逐项核对、遗留疑点>'",
    '5. {{tctl}} update {{task_id}} --status in_review --if-version <当前 version>',
    '',
    '仍有需要用户决策的问题：comment（body 以 [提问] 开头，列出问题和可选方案）后 update --status blocked 等待答复，不要猜测。',
    '禁止将任务置为 done（done 只能由用户验收）。',
  ].join('\n'),
  qa: [
    '你是看板任务 #{{task_id}} 的问答 Agent：只讨论不实现（不改代码、不跑测试、不动项目文件，唯一允许的写操作见第 4 步）。看板 CLI：{{tctl}}',
    '',
    '严格按以下流程执行：',
    '1. 若当前工作目录（项目主目录）存在 TASKBOARD_RULES.md / TASKBOARD_MEMORY.md，先通读',
    '2. {{tctl}} show {{task_id}} —— 完整阅读任务描述与全部评论；若最近有你的 [提问]，重点读用户之后的答复',
    '3. 与用户讨论：澄清需求、目标、规则与约束、验收标准，或继续讨论你之前提出的问题。还需要用户补充时：comment（body 以 [提问] 开头，一次别问太多，给建议选项或草案），然后结束本轮等用户答复（会续跑本会话），不要修改任务状态',
    "4. 讨论充分后收尾：把结论结构化写回任务描述——{{tctl}} update {{task_id}} --if-version <当前 version> --desc '<重写后的描述，含 ## 需求 / ## 目标 / ## 规则与约束 / ## 验收标准（开发类任务必须有；给不出就先回第 3 步给草案问用户）>'；用户定下的跨任务规则可追加到主目录 TASKBOARD_RULES.md",
    "5. {{tctl}} comment {{task_id}} --author agent --body '<问答结论摘要>'",
    '6. 流转任务：未成熟回 backlog，已就绪进 todo，阻塞已解进 todo（{{tctl}} update --status backlog|todo --if-version <当前 version>）。禁止置 in_progress / in_review / done',
  ].join('\n'),
};

// 自动认领提示词：复制贴给常驻 Agent 会话（终端里的 codex/kimi/reasonix），
// 让它循环认领 todo 任务执行。经 GET /api/prompt-defaults 暴露给设置页。
export const AUTO_CLAIM_PROMPT = [
  `你是看板任务认领循环 Agent。看板 CLI：node ${TASKCTL}（下文简称 taskctl，所有命令默认输出 JSON）。`,
  '',
  '循环执行：',
  '1. taskctl list --status todo —— 查看待办任务',
  '2. 有待办：选优先级最高（high > normal > low）、同优先级取 id 最小的任务，走下面的认领流程，做完继续下一轮',
  '3. 没有待办：sleep 300 后再查，不要空转',
  '',
  '认领流程（每个任务）：',
  '1. taskctl show <id> —— 完整阅读任务描述与全部评论（评论里可能有验收标准和前轮进展；images 字段是图片绝对路径，用读图工具查看）',
  '2. taskctl claim <id> —— 原子认领；返回 CLAIM_CONFLICT 说明已被抢走，放弃它换下一个',
  '3. 在任务描述指定的仓库完成实现（show 返回的 project_paths 是查找范围提示，不限于此），运行相关测试自验证',
  "4. taskctl comment <id> --author agent --body '<结果摘要：变更内容、验证命令与结果、遗留疑点>'",
  '5. taskctl update <id> --status in_review --if-version <当前 version> —— 交付待验收',
  '6. 需要用户决策或信息不全：comment（body 以 [提问] 开头，列出问题和可选方案）后 update --status blocked；硬阻塞同样 comment 说明后置 blocked',
  '',
  '铁律：',
  '- 一次只认领一个任务；永远不要置 done（done 只能由用户验收，系统也会拒绝）',
  '- 更新必须带 --if-version；VERSION_CONFLICT 时重新 show 取最新 version 再重试，连续冲突则放弃并 comment 说明',
].join('\n');

// 模板里必须保留的占位符（否则 agent 拿不到任务 id 和 CLI 路径）
export const PROMPT_REQUIRED_PLACEHOLDERS = ['{{task_id}}', '{{tctl}}'];

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function buildPrompt(task, projectPaths, { resume, mode, templates } = {}) {
  const tctl = `node ${TASKCTL}`;
  const kind = mode === 'qa' ? 'qa' : resume ? 'resume' : 'new';
  const tpl = templates?.[kind]?.trim() ? templates[kind] : PROMPT_DEFAULTS[kind];
  // 执行开始时看板已把任务流转到「进行中」（自动认领），无需 agent 再 claim
  const claimStep = `3. 任务已由看板自动认领进「进行中」，无需执行 claim，直接开始实现；若是打回重做，重点按最新评论中的验收意见修改`;
  const scope = projectPaths.length
    ? projectPaths.map((p) => `  - ${p}`).join('\n')
    : '  （未配置，先自行定位代码仓库）';
  return renderTemplate(tpl, {
    task_id: String(task.id),
    tctl,
    project_name: task.project_name ?? '',
    scope,
    claim_step: claimStep,
  });
}

export function createRunner({ db, broadcast, dbPath, spawnFn = spawn }) {
  const runs = new Map(); // taskId -> {task_id, agent, pid, started_at, proc, output}

  function publicRun({ proc, output, ...pub }) {
    return { ...pub, output_tail: output.trim().split('\n').slice(-5).join('\n') };
  }

  function list() {
    return [...runs.values()].map(publicRun);
  }

  // 运行中任务的实时输出（终端式视图用）；未在运行返回 null
  function output(taskId) {
    const run = runs.get(taskId);
    if (!run) return null;
    const { proc, ...pub } = run;
    return { ...pub };
  }

  function start(taskId, agent, options = {}) {
    if (!AGENT_NAMES.includes(agent)) {
      throw new DbError('VALIDATION', `unknown agent: ${agent} (codex|kimi|reasonix)`);
    }
    // execMode：execute=实现任务（执行即进进行中）；qa=问答（只讨论不实现，不自动流转状态）
    const execMode = options.mode ?? 'execute';
    if (!['execute', 'qa'].includes(execMode)) {
      throw new DbError('VALIDATION', `unknown mode: ${execMode} (execute|qa)`);
    }
    const settings = getSettings(db);
    if (!settings.agents.includes(agent)) {
      throw new DbError('AGENT_DISABLED', `agent ${agent} 已在设置页停用`);
    }
    let task = getTask(db, taskId); // 不存在则抛 NOT_FOUND
    if (runs.has(taskId)) {
      throw new DbError('RUN_IN_PROGRESS', `task ${taskId} already has a running ${runs.get(taskId).agent}`);
    }
    if (task.status === 'done' || task.status === 'canceled') {
      throw new DbError('INVALID_TRANSITION', `task ${taskId} is ${task.status}`);
    }
    if (execMode === 'qa') {
      // 问答只允许在 待规划/待办/阻塞 发起；状态保持不动（不占「进行中」）
      if (!['backlog', 'todo', 'blocked'].includes(task.status)) {
        throw new DbError('INVALID_TRANSITION', `task ${taskId} is ${task.status}；问答仅支持待规划/待办/阻塞`, { current: task });
      }
    } else {
      // 执行即进「进行中」：卡片位置同步反映后台执行。backlog 先排进 todo，todo 原子认领，
      // blocked（已答复直接执行）/ in_review（打回重做）直接流转
      if (task.status === 'backlog') {
        updateTask(db, taskId, { version: task.version, status: 'todo' });
        task = getTask(db, taskId);
      }
      if (task.status === 'todo') {
        claimTask(db, taskId);
        task = getTask(db, taskId);
      } else if (task.status === 'blocked' || task.status === 'in_review') {
        updateTask(db, taskId, { version: task.version, status: 'in_progress' });
        task = getTask(db, taskId);
      }
    }
    // thread_id 存 "<agent>:<sessionId>"；同 agent 再执行续跑原会话，跨 agent 开新会话、靠评论继承任务记忆
    const [threadAgent, ...threadRest] = (task.thread_id || '').split(':');
    const resumeId = threadAgent === agent && threadRest.length
      ? threadRest.join(':')
      : null;
    const project = db.prepare('SELECT name, paths, main_dir FROM projects WHERE id = ?').get(task.project_id);
    const projectPaths = JSON.parse(project?.paths || '[]');
    const cwd = resolveMainDir(project); // 主目录作为工作目录；paths 仅作查找范围提示
    const dbDir = dirname(dbPath ?? defaultDbPath());
    const prompt = buildPrompt({ ...task, project_name: project?.name }, projectPaths, {
      resume: Boolean(resumeId),
      mode: execMode,
      templates: { new: settings.prompt_new, resume: settings.prompt_resume, qa: settings.prompt_qa }, // 设置页的覆盖模板
    });
    const { cmd, args } = buildCommand(agent, prompt, cwd, dbDir, { ...options, resumeId });

    const proc = spawnFn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const mode = [execMode === 'qa' ? '问答' : null, options.model, options.effort, options.permission, resumeId ? '续跑' : null].filter(Boolean).join(' · ');
    const run = { task_id: taskId, agent, mode, pid: proc.pid, started_at: new Date().toISOString(), proc, output: '', sessionId: null, stopping: false };
    runs.set(taskId, run);
    // 新执行开始：清除上一次的异常退出标记
    try { setTaskLastRun(db, taskId, null); } catch { /* 任务可能已被删除 */ }
    const onData = (d) => {
      run.output = (run.output + d).slice(-OUTPUT_CAP);
      if (!run.sessionId) {
        const m = SESSION_PATTERNS[agent]?.exec(run.output);
        if (m) run.sessionId = m[1];
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => finish(taskId, null, err));
    proc.on('exit', (code) => finish(taskId, code, null));
    broadcast();
    return publicRun(run);
  }

  function finish(taskId, code, err) {
    const run = runs.get(taskId);
    if (!run) return;
    runs.delete(taskId);
    // 记录 CLI 会话 id（带 agent 前缀），同 agent 打回重做时续跑
    if (run.sessionId) {
      // reasonix 的 --resume 要会话文件完整路径，按 session_id 定位；找不到就不存（靠评论继承）
      const thread = run.agent === 'reasonix' ? findReasonixSessionFile(run.sessionId) : run.sessionId;
      if (thread) {
        try { setTaskThread(db, taskId, `${run.agent}:${thread}`); } catch { /* 任务可能已被删除 */ }
      }
    }
    const secs = Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000);
    // reasonix 兼容：结果行（subtype:success + is_error:false）说成功就按成功算，忽略误报的非零退出码
    const rxResult = run.agent === 'reasonix' ? parseReasonixResult(run.output) : null;
    const okByResult = Boolean(rxResult) && rxResult.subtype === 'success' && rxResult.is_error === false;
    const ok = !err && (okByResult || code === 0);
    const status = err
      ? `启动失败：${err.message}`
      : ok
        ? `正常结束${okByResult && code !== 0 ? `（结果行 success，忽略进程退出码 ${code}）` : ''}`
        : `异常退出（码 ${code}）`;
    // 解析本次输出的上下文用量，存 tasks.usage（kimi 无用量输出则保持不变）
    const usage = parseUsage(run.agent, run.output);
    if (usage) {
      try {
        setTaskUsage(db, taskId, JSON.stringify({ agent: run.agent, ...usage, at: new Date().toISOString() }));
      } catch { /* 任务可能已被删除 */ }
    }
    let tail = run.output.trim().split('\n').slice(-8).join('\n');
    if (rxResult && typeof rxResult.result === 'string' && rxResult.result) {
      // reasonix 输出是 JSON 结果行，提取 result 文本避免评论里糊一整行 JSON
      tail = rxResult.result;
    }
    try {
      addComment(db, taskId, {
        author: 'agent',
        body: `[runner] ${run.agent} ${status}，用时 ${secs}s${tail ? `\n输出尾部：\n${tail}` : ''}`,
      });
      // 异常退出（非零码/启动失败）打标：卡片渲染红色告警，直到下次执行或正常结束清除。
      // 用户主动停止（stop 先置 stopping）不算异常；信号杀死 code 为 null 也不打标；
      // reasonix 结果行判定成功（okByResult）同样不打标
      const failed = !run.stopping && (Boolean(err) || (!okByResult && code !== null && code !== 0));
      setTaskLastRun(db, taskId, failed
        ? JSON.stringify({ agent: run.agent, code, error: err?.message ?? null, at: new Date().toISOString() })
        : null);
      // 进程退出时任务仍停在「进行中」（agent 什么都没流转就死了）：放回待规划，
      // 否则卡片会永久滞留进行中列。agent 已交付/提问/用户已手动流转的都不打扰
      const task = getTask(db, taskId);
      if (task.status === 'in_progress') {
        updateTask(db, taskId, { version: task.version, status: 'backlog' });
        addComment(db, taskId, { author: 'user', body: '执行进程已退出，任务回到「待规划」（可重新执行）' });
      }
    } catch { /* 任务可能已被删除 */ }
    broadcast();
  }

  function stop(taskId) {
    const run = runs.get(taskId);
    if (!run) return false;
    run.stopping = true; // 用户停止不是异常退出，finish 不打失败标记
    // 用户停止 = 暂停执行：先流转回待规划再 kill，finish 清理时看到已不是 in_progress 就不会重复放回
    // （agent 若已自行流转到别的状态则不打扰）
    try {
      const task = getTask(db, taskId);
      if (task.status === 'in_progress') {
        updateTask(db, taskId, { version: task.version, status: 'backlog' });
        addComment(db, taskId, { author: 'user', body: '已停止执行，任务回到「待规划」' });
      }
    } catch { /* 任务可能已被删除 */ }
    run.proc.kill('SIGTERM'); // exit 事件触发 finish 清理
    broadcast();
    return true;
  }

  return { list, start, stop, output };
}
