// Agent 执行器：以子进程拉起 codex / kimi / reasonix / dsh（DeepSeek Harness）完成指定任务。
// 运行状态在内存中（服务重启即丢失跟踪，子进程随服务退出）。
// 打回重做/续跑时会用任务保存的 thread_id 恢复原 CLI 会话。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTask, updateTask, claimTask, addComment, setTaskThread, setTaskLastRun, setTaskUsage, setTaskExecOpts, listTasks, defaultDbPath, resolveMainDir, getSettings, recentMemories, searchMemories, AGENT_NAMES, DbError } from './db.mjs';

export { AGENT_NAMES };

const TASKCTL = fileURLToPath(new URL('../cli/taskctl.mjs', import.meta.url));

// 运行输出在内存中保留的尾部大小：抽屉里的终端式实时视图直接读这段缓冲
const OUTPUT_CAP = 65536;

export const EFFORTS = ['low', 'medium', 'high']; // 思考强度（codex / reasonix 生效）
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
// reasonix 的权限模式（run --permission-mode）；看板的 codex 沙箱名会映射过去
export const REASONIX_MODES = ['manual', 'ask', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions'];
const REASONIX_MODE_MAP = { 'read-only': 'plan', 'workspace-write': 'auto', 'danger-full-access': 'bypassPermissions', yolo: 'bypassPermissions' };

// 各 agent 在执行弹框里可选的思考/权限档位（GET /api/agent-options 下发给前端）。
// yolo = 全自动跳过审批（codex：--dangerously-bypass-approvals-and-sandbox；reasonix：bypassPermissions；
// kimi 不支持：-p 与 -y/--auto 互斥，0.36.0 实测）。
// 模型清单是动态的，由 getAgentOptions() 读各家 CLI 本地配置补齐，这里只列档位。
export const AGENT_OPTIONS = {
  codex: { efforts: EFFORTS, permissions: [...CODEX_SANDBOXES, 'yolo'] },
  // kimi 的 -p 不能与 --auto/-y 组合，思考/权限不生效
  kimi: { efforts: [], permissions: [] },
  reasonix: { efforts: EFFORTS, permissions: [...REASONIX_MODES, 'yolo'] },
  // dsh（DeepSeek Harness）：headless 无 model/effort 参数（模型在 dsh 设置里配）；
  // 权限名与 codex 沙箱同名，经 DSH_PERMISSION_MODE 环境变量按次下发（yolo → danger-full-access）
  dsh: { efforts: [], permissions: [...CODEX_SANDBOXES, 'yolo'] },
};

// 从各家 CLI 的本地配置文件读可选模型清单（只读模型名/显示名，不碰凭证；文件不存在/解析失败则空数组）。
// codex：~/.codex/config.toml 的 model（CLI 无枚举能力，只能给到当前配置值）
// kimi：~/.kimi-code/config.toml 的 [models."<别名>"] 表（-m 接受模型别名）+ default_model
// reasonix：~/.reasonix/config.toml 的 [[providers]]（--model 接受 provider 名，label 带实际模型名）+ default_model
export function getAgentOptions() {
  const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  const opt = (agent, models, defaultModel) => ({ ...AGENT_OPTIONS[agent], models, defaultModel });

  let codexModels = [];
  let codexDefault = null;
  const codexToml = read(join(homedir(), '.codex', 'config.toml'));
  if (codexToml) {
    codexDefault = /^model\s*=\s*"([^"]+)"/m.exec(codexToml)?.[1] ?? null;
    if (codexDefault) codexModels = [{ id: codexDefault, label: `${codexDefault}（当前配置）` }];
  }

  const kimiModels = [];
  let kimiDefault = null;
  const kimiToml = read(join(homedir(), '.kimi-code', 'config.toml'));
  if (kimiToml) {
    kimiDefault = /^default_model\s*=\s*"([^"]+)"/m.exec(kimiToml)?.[1] ?? null;
    const re = /\[models\."([^"]+)"\]\n([\s\S]*?)(?=\n\[|$)/g;
    let m;
    while ((m = re.exec(kimiToml))) {
      const name = /display_name\s*=\s*"([^"]+)"/.exec(m[2])?.[1];
      kimiModels.push({ id: m[1], label: name ? `${name}（${m[1]}）` : m[1] });
    }
  }

  const reasonixModels = [];
  let reasonixDefault = null;
  const reasonixToml = read(join(homedir(), '.reasonix', 'config.toml'));
  if (reasonixToml) {
    reasonixDefault = /^default_model\s*=\s*"([^"]+)"/m.exec(reasonixToml)?.[1] ?? null;
    const re = /\[\[providers\]\]\n([\s\S]*?)(?=\n\[|$)/g;
    let m;
    while ((m = re.exec(reasonixToml))) {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(m[1])?.[1];
      const model = /^model\s*=\s*"([^"]+)"/m.exec(m[1])?.[1];
      if (name) reasonixModels.push({ id: name, label: model ? `${name}（${model}）` : name });
    }
  }

  return {
    codex: opt('codex', codexModels, codexDefault),
    kimi: opt('kimi', kimiModels, kimiDefault),
    reasonix: opt('reasonix', reasonixModels, reasonixDefault),
    // dsh 的模型在 Web 设置页 / Cordis patch 层配置，没有可读的本地模型清单文件
    dsh: opt('dsh', [], null),
  };
}

// 从 CLI 输出中识别会话 id（输出滚动截断，必须边收边解析）
const SESSION_PATTERNS = {
  codex: /session id: ([0-9a-f-]{36})/,
  kimi: /kimi -r (session_[0-9a-f-]+)/,
  reasonix: /"session_id":"([^"]+)"/, // stream-json 事件流末尾的 {"type":"result"} 结果行
  // dsh headless 只在结束时打印最终 assistant 文本，无会话 id 可解析 → 不支持续跑
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

// Windows 下服务进程若未继承用户 PATH，spawn('kimi') 会 ENOENT。
// 对常用安装位置做兜底：PATH 能找到就用 PATH，找不到时尝试各 agent 的默认绝对路径。
function resolveAgentBinary(agent) {
  if (process.platform !== 'win32') return agent;
  const home = homedir();
  const candidates = {
    codex: [join(home, '.codex', 'bin', 'codex.exe'), join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd')],
    kimi: [join(home, '.kimi-code', 'bin', 'kimi.exe')],
    reasonix: [join(home, '.reasonix', 'bin', 'reasonix.exe')],
    dsh: [join(home, '.local', 'bin', 'dsh.exe'), join(home, 'AppData', 'Local', 'dsh', 'dsh.exe')],
  }[agent];
  if (!candidates) return agent;
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return agent;
}

function buildCommand(agent, prompt, cwd, dbDir, { model, effort, permission, resumeId } = {}) {
  const cmd = resolveAgentBinary(agent);
  if (agent === 'codex') {
    const args = ['exec'];
    const yolo = permission === 'yolo'; // YOLO：跳过所有审批且无沙箱（--dangerously-bypass-approvals-and-sandbox）
    if (resumeId) {
      // resume 子命令没有 -s/--add-dir：沙箱用 -c 覆盖，工作区可写根沿用原会话
      args.push('resume', '--skip-git-repo-check');
      if (yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
      else if (CODEX_SANDBOXES.includes(permission)) args.push('-c', `sandbox_mode=${permission}`);
    } else if (yolo) {
      // YOLO 与 -s/--add-dir 互斥（无沙箱即全机可写，无需放行看板库目录）
      args.push('--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', cwd);
    } else {
      // workspace-write 沙箱 + 额外放行看板数据库目录（taskctl 要直写 SQLite）
      const sandbox = CODEX_SANDBOXES.includes(permission) ? permission : 'workspace-write';
      args.push('-s', sandbox, '--skip-git-repo-check', '-C', cwd, '--add-dir', dbDir);
    }
    if (model) args.push('-m', model);
    if (EFFORTS.includes(effort)) args.push('-c', `model_reasoning_effort=${effort}`);
    if (resumeId) args.push(resumeId);
    args.push(prompt);
    return { cmd, args, cwd };
  }
  if (agent === 'kimi') {
    // 注意：kimi 的 -p 不能与 --auto/-y 组合（0.36.0 实测报错 Cannot combine --prompt with --yolo）；
    // kimi 的自动审批由 ~/.kimi-code/config.toml 的 default_permission_mode 控制，看板侧无法按次指定
    const args = [];
    if (resumeId) args.push('-S', resumeId);
    if (model) args.push('-m', model);
    args.push('-p', prompt);
    return { cmd, args, cwd };
  }
  if (agent === 'reasonix') {
    // reasonix run 是非交互模式；--resume 要会话文件完整路径（finish 时按 session_id 定位存库）。
    // stream-json：过程中持续输出 message/tool_dispatch/tool_result 等事件行（执行过程可见，
    // json 模式只在结束时输出一行结果）；末尾同样带 {"type":"result"} 结果行，usage/成功判定逻辑不变
    const perm = REASONIX_MODES.includes(permission) ? permission : REASONIX_MODE_MAP[permission] || 'auto';
    const args = ['run', '--dir', cwd, '--permission-mode', perm, '--add-dir', dbDir, '--output-format', 'stream-json'];
    if (resumeId) args.push('--resume', resumeId);
    if (model) args.push('--model', model);
    if (EFFORTS.includes(effort)) args.push('--effort', effort);
    args.push(prompt);
    return { cmd, args, cwd };
  }
  if (agent === 'dsh') {
    // DeepSeek Harness（dsh）：headless 一次性执行——新建会话、跑完、最终文本打 stdout，
    // completed 退出码 0 否则 1（契约与看板 finish 的退出码语义一致）。无 model/effort/resume
    // 参数（模型在 dsh 设置里配；会话 id 不输出 → 无法续跑，再执行自动新会话、靠评论继承记忆）。
    // 权限经 DSH_PERMISSION_MODE 下发（取值与 codex 沙箱同名；yolo → danger-full-access），
    // 默认 workspace-write：bash/写文件限工作区+临时目录，看板回写走 dsh-taskpin 插件工具（HTTP）。
    // headless 自身过程零输出：过程进度（发言/工具调用/结果）由 dsh-taskpin 插件订阅
    // session/event 实时写 stderr，与本捕获合并后在输出弹框可见。
    const perm = permission === 'yolo' ? 'danger-full-access'
      : CODEX_SANDBOXES.includes(permission) ? permission : 'workspace-write';
    return { cmd, args: ['--profile', 'headless', prompt], cwd, env: { DSH_PERMISSION_MODE: perm } };
  }
  throw new DbError('VALIDATION', `unknown agent: ${agent} (${AGENT_NAMES.join('|')})`);
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
    '1. 若当前工作目录（项目主目录）存在 .taskpin/TASKBOARD_RULES.md，先通读它——那是本项目的规则；本项目已验收任务的记忆见下方「项目记忆」节，需要更多历史细节时用 {{tctl}} memory search 检索',
    '2. {{tctl}} show {{task_id}} —— 完整阅读任务描述与全部评论（评论的 images 字段是图片绝对路径，需要时用读图工具查看）',
    '{{claim_step}}',
    '4. 验收标准检查（铁律）：若任务涉及代码改动/功能实现/文件产出（开发类），描述中必须有「验收标准」。没有 → 不要开始实现：comment（body 以 [提问] 开头，主动给出 2-4 条可验证的验收标准草案，如"运行 X 命令输出 Y"、"页面 Z 出现 W"）后 update --status blocked，等用户确认。拿不准算不算开发类时宁问勿猜；纯调研/问答类不强制',
    '5. 开工确认（铁律）：开发类任务，只有任务描述或用户评论中明确出现「开工」二字时才允许开始实现。还没有 → 不要动手：comment（body 以 [提问] 开头，概述你的实现计划/方案要点，请用户确认后回复「开工」）后 update --status blocked，等用户确认（答复会触发续跑，届时再动工）。与第 4 步的验收标准同时缺失时，合并成一条 [提问] 一次问清；纯调研/问答类不受限',
    '6. 在上述路径下定位对应仓库，完成实现，并运行相关测试自验证；开发类任务须对照描述中的「验收标准」逐条验证',
    "7. {{tctl}} comment {{task_id}} --author agent --body '<结果摘要：变更内容、验证命令与结果、验收标准逐项核对、遗留疑点>'",
    '8. {{tctl}} update {{task_id}} --status in_review --if-version <当前 version>',
    '',
    '需要用户决策或信息不全时，不要猜测：comment（body 以 [提问] 开头，列出问题和可选方案）后 update --status blocked，等用户答复并重新执行你（会续跑本会话）。无法解决的硬阻塞同样 comment 说明后置 blocked。',
    '禁止将任务置为 done（done 只能由用户验收）。',
  ].join('\n'),
  resume: [
    '继续看板任务 #{{task_id}}（你之前执行过，本会话是续跑）。看板 CLI：{{tctl}}',
    '严格按以下流程执行：',
    '1. {{tctl}} show {{task_id}} —— 重点阅读你上次交付/提问后用户新写的评论（答复或验收意见；images 字段是图片绝对路径，用读图工具查看）',
    '2. 若主目录存在 .taskpin/TASKBOARD_RULES.md，按需参考；项目记忆见下方「项目记忆」节，需要更多历史细节时用 {{tctl}} memory search 检索',
    '3. 按答复/意见继续修改，并运行相关测试自验证；开发类任务对照描述中的「验收标准」逐条验证；标准仍缺失时不要猜：comment（body 以 [提问] 开头，给出验收标准草案）后 update --status blocked 等用户确认；开工确认同样适用：用户尚未明确说过「开工」（描述或任一用户评论含「开工」二字）时不要实现，comment（body 以 [提问] 开头，概述实现计划请用户回复「开工」）后 update --status blocked 等确认',
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
    '1. 若当前工作目录（项目主目录）存在 .taskpin/TASKBOARD_RULES.md，先通读；项目记忆见下方「项目记忆」节，需要更多历史细节时用 {{tctl}} memory search 检索',
    '2. {{tctl}} show {{task_id}} —— 完整阅读任务描述与全部评论；若最近有你的 [提问]，重点读用户之后的答复',
    '3. 与用户讨论：澄清需求、目标、规则与约束、验收标准，或继续讨论你之前提出的问题。还需要用户补充时：comment（body 以 [提问] 开头，一次别问太多，给建议选项或草案），然后结束本轮等用户答复（会续跑本会话），不要修改任务状态',
    "4. 讨论充分后收尾：把结论结构化写回任务描述——{{tctl}} update {{task_id}} --if-version <当前 version> --desc '<重写后的描述，含 ## 需求 / ## 目标 / ## 规则与约束 / ## 验收标准（开发类任务必须有；给不出就先回第 3 步给草案问用户）>'；用户定下的跨任务规则可追加到主目录 .taskpin/TASKBOARD_RULES.md；收尾时提示用户：回复「开工」即启动实现（开发类任务未明确说「开工」不会动工）",
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

// 项目记忆注入（替代全量读 TASKBOARD_MEMORY.md）：最近 N 条全文 + 按任务标题/描述 BM25 检索
// （含时间衰减）的命中条。完整历史由 agent 按需用 taskctl memory search 自查。
export function buildMemorySection(db, projectId, task) {
  const tctl = `node ${TASKCTL}`;
  const recent = recentMemories(db, projectId);
  const query = `${task.title || ''}\n${task.description || ''}`.slice(0, 500);
  const recentIds = new Set(recent.map((r) => r.id));
  const hits = searchMemories(db, projectId, query).filter((h) => !recentIds.has(h.id));
  const blocks = [];
  if (recent.length) blocks.push(`【最近验收记忆 · ${recent.length} 条】\n${recent.map((r) => r.summary.trim()).join('\n\n')}`);
  if (hits.length) blocks.push(`【相关历史命中 · ${hits.length} 条】\n${hits.map((r) => r.summary.trim()).join('\n\n')}`);
  return [
    `项目记忆（本项目已验收任务的记忆；完整检索：${tctl} memory search --project ${projectId} <关键词>）：`,
    blocks.length ? blocks.join('\n\n') : '（暂无项目记忆）',
  ].join('\n');
}

function buildPrompt(task, projectPaths, { resume, mode, templates, agent, memorySection } = {}) {
  const tctl = `node ${TASKCTL}`;
  const kind = mode === 'qa' ? 'qa' : resume ? 'resume' : 'new';
  const tpl = templates?.[kind]?.trim() ? templates[kind] : PROMPT_DEFAULTS[kind];
  // 执行开始时看板已把任务流转到「进行中」（自动认领），无需 agent 再 claim
  const claimStep = `3. 任务已由看板自动认领进「进行中」，无需执行 claim，直接开始实现；若是打回重做，重点按最新评论中的验收意见修改`;
  const scope = projectPaths.length
    ? projectPaths.map((p) => `  - ${p}`).join('\n')
    : '  （未配置，先自行定位代码仓库）';
  const prompt = renderTemplate(tpl, {
    task_id: String(task.id),
    tctl,
    project_name: task.project_name ?? '',
    scope,
    claim_step: claimStep,
  });
  const withMemory = memorySection ? `${prompt}\n\n${memorySection}` : prompt;
  // dsh 沙箱内 taskctl 直写看板数据库会被权限拦截；dsh-taskpin 插件工具走 HTTP 不受限
  if (agent === 'dsh') {
    return `${withMemory}\n\n环境提示：你运行在 DeepSeek Harness 中，已内置 taskboard_show / taskboard_comment / taskboard_transition 三个原生工具——回写看板（读任务/发评论/流转状态）优先用工具而不是 taskctl CLI。`;
  }
  return withMemory;
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
      throw new DbError('VALIDATION', `unknown agent: ${agent} (${AGENT_NAMES.join('|')})`);
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
    // 上面的认领/流转已把任务置「进行中」：此处再构造命令/建主目录/spawn，若同步失败
    // （如主目录创建被拒、命令构造异常），回滚认领——否则会留下「进行中」但无活跃 run 的
    // 残留任务（卡片无执行中样式却停在进行中列）
    let proc;
    try {
      const project = db.prepare('SELECT name, paths, main_dir FROM projects WHERE id = ?').get(task.project_id);
      const projectPaths = JSON.parse(project?.paths || '[]');
      const cwd = resolveMainDir(project); // 主目录作为工作目录；paths 仅作查找范围提示
      const dbDir = dirname(dbPath ?? defaultDbPath());
      const prompt = buildPrompt({ ...task, project_name: project?.name }, projectPaths, {
        resume: Boolean(resumeId),
        mode: execMode,
        agent,
        templates: { new: settings.prompt_new, resume: settings.prompt_resume, qa: settings.prompt_qa }, // 设置页的覆盖模板
        memorySection: buildMemorySection(db, task.project_id, task),
      });
      const { cmd, args, env } = buildCommand(agent, prompt, cwd, dbDir, { ...options, resumeId });

      proc = spawnFn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      try {
        const cur = getTask(db, taskId);
        if (cur.status === 'in_progress') {
          updateTask(db, taskId, { version: cur.version, status: 'backlog' });
          addComment(db, taskId, { author: 'user', body: `执行启动失败，任务回到「待规划」（可重新执行）：${err.message}` });
        }
      } catch { /* 任务可能已被删除 */ }
      throw err;
    }
    const mode = [execMode === 'qa' ? '问答' : null, options.model, options.effort, options.permission, resumeId ? '续跑' : null].filter(Boolean).join(' · ');
    const run = { task_id: taskId, agent, mode, pid: proc.pid, started_at: new Date().toISOString(), proc, output: '', sessionId: null, stopping: false };
    runs.set(taskId, run);
    // 新执行开始：清除上一次的异常退出标记
    try { setTaskLastRun(db, taskId, null); } catch { /* 任务可能已被删除 */ }
    // 记录本次选用的模型/思考/权限（按任务记忆：执行弹框回填 + 卡片展示「上一次」）
    try {
      setTaskExecOpts(db, taskId, JSON.stringify({
        agent,
        ...(options.model ? { model: options.model } : {}),
        ...(EFFORTS.includes(options.effort) ? { effort: options.effort } : {}),
        ...(options.permission ? { permission: options.permission } : {}),
        at: new Date().toISOString(),
      }));
    } catch { /* 任务可能已被删除 */ }
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

  // 回收「残留进行中」：运行跟踪在内存，服务重启即全部丢失——上次会话已流转到「进行中」
  // 的任务若没有活跃 run（进程随重启中断/失联、外部认领后 agent 失联、手动拖入等），会永久
  // 滞留「进行中」列且没有任何执行中样式（无吊牌/缝线/停止入口）。与 finish 的兜底一致：
  // 放回待规划并写一条说明评论；当前正在跑的任务不打扰。返回本次回收的任务数。
  function recoverStale() {
    const runningIds = new Set(runs.keys());
    const stale = listTasks(db).filter((t) => t.status === 'in_progress' && !runningIds.has(t.id));
    for (const t of stale) {
      try {
        updateTask(db, t.id, { version: t.version, status: 'backlog' });
        addComment(db, t.id, { author: 'user', body: '执行进程已中断（服务重启或进程失联），任务从「进行中」回到「待规划」，可重新执行' });
      } catch (err) {
        console.error(`[runner] 回收残留任务 #${t.id} 失败: ${err.message}`);
      }
    }
    if (stale.length) broadcast();
    return stale.length;
  }

  return { list, start, stop, output, recoverStale };
}
