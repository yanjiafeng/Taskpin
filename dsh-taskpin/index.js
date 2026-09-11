// dsh-taskpin：Taskpin 任务看板对接插件。
// 1) 给 dsh agent 注册四个模型可见的原生工具（taskboard_show / taskboard_comment /
//    taskboard_update / taskboard_transition），agent 执行看板任务时直接调工具回写看板，
//    不必再通过 bash 拼 taskctl 命令。看板 API 走本机回环（Host 为 127.0.0.1 免认证），
//    地址默认 http://127.0.0.1:47824，可用环境变量 TASKBOARD_API 覆盖。
// 2) 进度上报：dsh headless 只在跑完后把最终答复打一次 stdout，执行过程全程静默，
//    看板输出弹框因此一直「暂无可显示输出」。这里订阅 session/event 事件流，
//    把 agent 发言、工具调用（▸）与工具结果（✓）实时写到 stderr——
//    看板 runner 合并捕获 stdout/stderr，弹框即可看到过程。
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-taskpin';
export const inject = ['tools'];

const baseUrl = () => (process.env.TASKBOARD_API ?? 'http://127.0.0.1:47824').replace(/\/+$/, '');

async function api(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code;
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(code ? `${code}: ${msg}` : msg); // 抛异常 = isError，模型可见失败原因
  }
  return data;
}

const asText = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }];

const TASK_ID = { type: 'integer', required: true, description: '看板任务 id' };

// —— 进度上报（session/event → stderr）——

const textBlocks = (blocks) =>
  (blocks ?? []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();

// 从工具结果消息中提取可读文本（tool-result 块的 content 是工具返回的内容块数组）
const resultText = (message) =>
  (message?.content ?? [])
    .filter((b) => b?.type === 'tool-result')
    .map((b) => textBlocks(b.content))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// 工具调用参数取一个可读摘要：优先 command/file_path/path/url/pattern 等典型字段
const argsSummary = (args) => {
  let v = args;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* 原样使用 */ }
  }
  if (v && typeof v === 'object') {
    for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'task_id', 'query']) {
      if (v[key] != null) { v = v[key]; break; }
    }
    if (typeof v === 'object') v = JSON.stringify(v);
  }
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

function startProgressReporter(ctx) {
  const write = (line) => {
    try { process.stderr.write(`${line}\n`); } catch { /* stderr 不可写时静默 */ }
  };
  const callNames = new Map(); // callId → 工具名（tool/result 事件不带名称）
  // token 用量：assistant/message 事件自带 usage（dsh headless 本身不打用量），累计后在进程
  // 退出时打一行 `dsh-usage: {...}` 到 stderr，看板 runner 的 parseUsage 据此填 tasks.usage
  let usageTotal = null;
  process.on('exit', () => {
    if (!usageTotal) return;
    try {
      process.stderr.write(`dsh-usage: ${JSON.stringify(usageTotal)}\n`); // exit 钩子内同步写
    } catch { /* stderr 不可写时静默 */ }
  });
  ctx.on('session/event', (_session, event) => {
    try {
      if (event.type === 'assistant/message') {
        const u = event.data?.usage;
        if (u) {
          usageTotal ??= { input_tokens: 0, output_tokens: 0 };
          usageTotal.input_tokens += u.inputTokens ?? 0;
          usageTotal.output_tokens += u.outputTokens ?? 0;
        }
        const text = textBlocks(event.data?.message?.content);
        if (text) write(text);
      } else if (event.type === 'tool/call') {
        const { callId, name: toolName } = event.data ?? {};
        if (callId != null) callNames.set(callId, toolName);
        if (toolName) write(`▸ ${toolName} ${argsSummary(event.data.arguments)}`.trim());
      } else if (event.type === 'tool/result') {
        const msg = event.data?.message;
        const callId = msg?.source?.callId ?? msg?.content?.[0]?.toolCallId;
        const toolName = callNames.get(callId) ?? 'tool';
        let out = resultText(msg);
        if (out.length > 200) out = `${out.slice(0, 200)}…`;
        write(`✓ ${toolName}${event.data?.error || msg?.content?.[0]?.isError ? '（失败）' : ''}${out ? ` ${out}` : ''}`);
      }
      // 其余事件（assistant/chunk 增量、user/message、turn/step 边界、request/* 等）不展示
    } catch { /* 进度上报失败不影响执行 */ }
  });
}

export function apply(ctx) {
  startProgressReporter(ctx);
  ctx.tools.register(defineTool({
    name: 'taskboard_show',
    description: '读取 Taskpin 看板任务的完整信息（标题、描述、状态、version、评论）。执行看板任务、回写评论或流转状态前必须先调用它取得最新 version；评论的 images 字段是图片绝对路径。compact（默认 true）折叠评论省 token：剔除 [runner] 进程记录、最新一轮之前的早期评论只留前 200 字符；确需全文时显式传 compact=false。',
    parameters: {
      task_id: TASK_ID,
      compact: { type: 'boolean', description: '折叠评论省 token（默认 true）；需要早期评论全文时传 false' },
    },
    output: { schema: { type: 'string' }, render: (_args, v) => asText(v) },
    async execute(args) {
      const qs = args.compact === false ? '' : '?compact=1';
      return JSON.stringify(await api('GET', `/api/tasks/${args.task_id}${qs}`));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'taskboard_update',
    description: '更新 Taskpin 看板任务的标题/描述/标签（问答模式把结论写回任务描述、融合执行重写草案描述都走它）。必须带 taskboard_show 读到的最新 version（乐观锁，VERSION_CONFLICT 时重新 show 再试）。只传要改的字段；状态流转用 taskboard_transition。',
    parameters: {
      task_id: TASK_ID,
      version: { type: 'integer', required: true, description: 'taskboard_show 返回的最新 version' },
      title: { type: 'string', description: '新标题（不改不传）' },
      description: { type: 'string', description: '新描述（不改不传）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组，整体替换（≤8 个、单个 ≤20 字符）；传 [] 清空' },
    },
    output: { schema: { type: 'string' }, render: (_args, v) => asText(v) },
    async execute(args) {
      const patch = { version: args.version };
      for (const k of ['title', 'description', 'tags']) {
        if (args[k] != null) patch[k] = args[k];
      }
      return JSON.stringify(await api('PATCH', `/api/tasks/${args.task_id}`, patch));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'taskboard_comment',
    description: '在 Taskpin 看板任务下发表评论。交付结果摘要用 author=agent；向用户提问时 body 以 [提问] 开头。',
    parameters: {
      task_id: TASK_ID,
      body: { type: 'string', required: true, description: '评论内容' },
      author: { type: 'string', description: 'agent（默认）或 user' },
    },
    output: { schema: { type: 'string' }, render: (_args, v) => asText(v) },
    async execute(args) {
      return JSON.stringify(await api('POST', `/api/tasks/${args.task_id}/comments`, {
        author: args.author ?? 'agent',
        body: args.body,
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'taskboard_transition',
    description: '流转 Taskpin 看板任务状态。必须带 taskboard_show 读到的最新 version（乐观锁，VERSION_CONFLICT 时重新 show 再试）。allowed：backlog|todo|in_progress|in_review|blocked|canceled；done 只能由用户验收，禁止调用。需要用户决策时先发 [提问] 评论再转 blocked；交付时转 in_review。',
    parameters: {
      task_id: TASK_ID,
      status: { type: 'string', required: true, description: '目标状态：backlog|todo|in_progress|in_review|blocked|canceled' },
      version: { type: 'integer', required: true, description: 'taskboard_show 返回的最新 version' },
    },
    output: { schema: { type: 'string' }, render: (_args, v) => asText(v) },
    async execute(args) {
      return JSON.stringify(await api('PATCH', `/api/tasks/${args.task_id}`, {
        status: args.status,
        version: args.version,
      }));
    },
  }));
}
