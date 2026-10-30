// REST API 路由。统一 JSON 错误格式 {error: {code, message}}。
import {
  listProjects, createProject, updateProject, deleteProject, listTasks, getTaskWithComments,
  createTask, updateTask, claimTask, addComment, deleteTasks, getSettings, updateSettings,
  saveAttachments, mergeTasks, confirmMerge, cancelMerge, compactComments, DbError,
  listReviewSeen, markReviewSeen,
  ATTACHMENT_MIME_EXT,
} from './db.mjs';
import { PROMPT_DEFAULTS, AUTO_CLAIM_PROMPT, getAgentOptions } from './runner.mjs';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

// 附件路由的 ext→mime（由 db.mjs 的白名单反推，白名单改动只动 db.mjs 一处）
const ATTACHMENT_EXT_MIME = Object.fromEntries(
  Object.entries(ATTACHMENT_MIME_EXT).map(([mime, ext]) => [ext, mime]),
);

// 从评论记录里找回附件原始文件名（下载回显用）；历史字符串条目没有名字，返回 null
function findAttachmentName(db, taskId, rel) {
  const rows = db.prepare('SELECT images FROM comments WHERE task_id = ?').all(taskId);
  for (const r of rows) {
    for (const it of JSON.parse(r.images || '[]')) {
      if (typeof it === 'object' && it?.path === rel && it.name) return it.name;
    }
  }
  return null;
}

const ERROR_STATUS = {
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  CLAIM_CONFLICT: 409,
  RUN_IN_PROGRESS: 409,
  INVALID_TRANSITION: 422,
  DONE_REQUIRES_USER: 403,
  AGENT_DISABLED: 403,
  VALIDATION: 400,
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  const code = err instanceof DbError ? err.code : 'INTERNAL';
  const status = ERROR_STATUS[code] || 500;
  const body = { error: { code, message: err.message } };
  if (err.current) body.error.current = err.current;
  sendJson(res, status, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // 上限 130MB：评论附件走 base64 dataURL，6 个 15MB 文件编码后约 120MB
      if (data.length > 130_000_000) reject(new DbError('VALIDATION', 'request body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new DbError('VALIDATION', 'request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createApiHandler({ db, broadcast, runner, tunnel, attachmentsDir, quota, tts }) {
  return async function handleApi(req, res, url) {
    const m = url.pathname.match(/^\/api\/tasks\/(\d+)(\/claim|\/comments|\/execute|\/run|\/run\/output|\/merge-confirm|\/merge-cancel|\/review-seen)?$/);
    const pm = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    const am = url.pathname.match(/^\/api\/attachments\/(\d+)\/([\w.-]+)$/);
    try {
      // 评论附件（文件在 attachments/<taskId>/ 下，只允许该目录内的平文件名）：
      // 图片 inline 显示；非图片强制下载（Content-Disposition 带回原始文件名，也防内联执行）
      if (req.method === 'GET' && am) {
        const ext = am[2].split('.').pop().toLowerCase();
        const type = ATTACHMENT_EXT_MIME[ext];
        const filePath = normalize(join(attachmentsDir, am[1], am[2]));
        if (!type || !filePath.startsWith(normalize(join(attachmentsDir, am[1])))) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'attachment not found' } });
        }
        try {
          const data = await readFile(filePath);
          const headers = { 'content-type': type, 'cache-control': 'immutable, max-age=31536000' };
          if (!type.startsWith('image/')) {
            const name = findAttachmentName(db, am[1], `${am[1]}/${am[2]}`) || am[2];
            headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
          }
          res.writeHead(200, headers);
          return res.end(data);
        } catch {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'attachment not found' } });
        }
      }
      // runs
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return sendJson(res, 200, runner.list());
      }
      // 「待验收」未查看标记：已查看状态 {taskId: seen_at}，服务端共享给所有设备
      if (req.method === 'GET' && url.pathname === '/api/review-seen') {
        return sendJson(res, 200, listReviewSeen(db));
      }
      // 三家 Agent 的额度/余额（quota.mjs 本机读凭证查询，元数据接口不耗 token，60s 缓存）
      if (req.method === 'GET' && url.pathname === '/api/quota') {
        if (!quota) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'quota not configured' } });
        return sendJson(res, 200, await quota.get({ refresh: url.searchParams.get('refresh') === '1' }));
      }
      // settings（agents：启用的执行 Agent；prompt_*：模板覆盖；access_token：访问 Token，由隧道自动管理）
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(res, 200, getSettings(db));
      }
      if (req.method === 'PATCH' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        const settings = updateSettings(db, body);
        broadcast();
        return sendJson(res, 200, settings);
      }
      // 执行 prompt 模板的内置默认值（设置页展示/恢复默认用）+ 自动认领提示词
      if (req.method === 'GET' && url.pathname === '/api/prompt-defaults') {
        return sendJson(res, 200, { ...PROMPT_DEFAULTS, auto_claim: AUTO_CLAIM_PROMPT });
      }
      // 各 agent 可选的模型/思考/权限（执行弹框联动选项；模型清单读各家 CLI 本地配置，后端统一下发）
      if (req.method === 'GET' && url.pathname === '/api/agent-options') {
        return sendJson(res, 200, getAgentOptions());
      }
      // 服务端 TTS 后备（浏览器无 speechSynthesis 时，Windows SAPI 离线合成 wav；tts.mjs）
      if (req.method === 'GET' && url.pathname === '/api/tts') {
        return sendJson(res, 200, { available: tts.available() });
      }
      if (req.method === 'POST' && url.pathname === '/api/tts') {
        const body = await readBody(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > tts.MAX_TEXT) {
          return sendJson(res, 400, { error: { code: 'VALIDATION', message: `text 必填且不超过 ${tts.MAX_TEXT} 字` } });
        }
        const rate = Number(body.rate);
        const wav = await tts.synthesize(text, Number.isFinite(rate) ? rate : 1);
        if (!wav) {
          return sendJson(res, 501, { error: { code: 'TTS_UNAVAILABLE', message: '服务端语音合成不可用（仅 Windows 服务端支持）' } });
        }
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'immutable, max-age=31536000' });
        return res.end(wav);
      }
      // projects
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return sendJson(res, 200, listProjects(db));
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const body = await readBody(req);
        const project = createProject(db, {
          name: body.name,
          paths: body.paths ?? (body.path ? [body.path] : []),
          mainDir: body.main_dir,
        });
        broadcast('projects');
        return sendJson(res, 201, project);
      }
      if (pm && req.method === 'PATCH') {
        const body = await readBody(req);
        const patch = { name: body.name };
        if (body.paths !== undefined) patch.paths = body.paths;
        else if (body.path !== undefined) patch.paths = body.path ? [body.path] : [];
        if (body.main_dir !== undefined) patch.mainDir = body.main_dir;
        const project = updateProject(db, Number(pm[1]), patch);
        broadcast('projects');
        return sendJson(res, 200, project);
      }
      // 删除项目：仅限没有未取消任务的项目（任务/评论级联删除）
      if (pm && req.method === 'DELETE') {
        const result = deleteProject(db, Number(pm[1]));
        broadcast('projects');
        return sendJson(res, 200, result);
      }

      // tunnel（cloudflared 快速隧道：状态/启动/停止/重新生成）
      if (req.method === 'GET' && url.pathname === '/api/tunnel') {
        return sendJson(res, 200, tunnel.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/tunnel/start') {
        return sendJson(res, 202, tunnel.start());
      }
      if (req.method === 'POST' && url.pathname === '/api/tunnel/stop') {
        return sendJson(res, 200, tunnel.stop());
      }
      if (req.method === 'POST' && url.pathname === '/api/tunnel/restart') {
        return sendJson(res, 202, tunnel.restart());
      }

      // tasks collection
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const projectId = url.searchParams.get('project_id');
        const status = url.searchParams.get('status');
        const includeCanceled = url.searchParams.get('include_canceled') === '1';
        // project_id 支持逗号分隔多选（"1,2,3"）；单个值保持原语义，非法段忽略
        const projectIds = projectId == null ? undefined
          : projectId.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
        return sendJson(res, 200, listTasks(db, {
          projectIds,
          status: status || undefined,
          includeCanceled,
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readBody(req);
        const task = createTask(db, {
          projectId: body.project_id,
          title: body.title,
          description: body.description ?? '',
          status: body.status ?? 'todo',
          priority: body.priority ?? 'normal',
        });
        broadcast('tasks');
        return sendJson(res, 201, task);
      }

      // 批量删除（仅已取消；事务，任一不满足整体失败）
      if (req.method === 'POST' && url.pathname === '/api/tasks/batch-delete') {
        const body = await readBody(req);
        const result = deleteTasks(db, body.ids);
        broadcast();
        return sendJson(res, 200, result);
      }

      // 合并融合第一步（出草案）：校验（2~5 个、非已取消/进行中；允许跨项目，草案落第一个源任务的项目）→ 建 backlog 草案（merged_from
      // 记录源任务 id+version）→ 自动以 merge 模式发起融合执行（会把草案认领进「进行中」）。执行启动失败
      // 不阻断（草案已建好，可稍后从详情抽屉手动执行）；run 为 null 时前端据此提示手动发起。
      if (req.method === 'POST' && url.pathname === '/api/tasks/merge') {
        const body = await readBody(req);
        const draft = mergeTasks(db, body.ids);
        broadcast('tasks');
        let run = null;
        let runError = null;
        try {
          run = runner.start(draft.id, body.agent || getSettings(db).agents[0], { mode: 'merge' });
        } catch (err) {
          runError = err.message;
        }
        return sendJson(res, 201, { task: getTaskWithComments(db, draft.id), run, run_error: runError });
      }

      // task item
      if (m) {
        const id = Number(m[1]);
        const sub = m[2];
        if (req.method === 'GET' && !sub) {
          const task = getTaskWithComments(db, id);
          // ?compact=1：dsh 插件等读任务继承记忆时省 token（与 taskctl show --compact 同逻辑）
          if (url.searchParams.get('compact') === '1') task.comments = compactComments(task.comments);
          return sendJson(res, 200, task);
        }
        if (req.method === 'DELETE' && !sub) {
          const result = deleteTasks(db, [id]);
          broadcast();
          return sendJson(res, 200, result);
        }
        if (req.method === 'PATCH' && !sub) {
          const body = await readBody(req);
          const task = updateTask(db, id, body, { by: body.by === 'user' ? 'user' : 'agent' });
          broadcast('tasks');
          return sendJson(res, 200, task);
        }
        if (req.method === 'POST' && sub === '/claim') {
          const body = await readBody(req);
          const task = claimTask(db, id, { threadId: body.thread_id ?? null });
          broadcast('tasks');
          return sendJson(res, 200, task);
        }
        if (req.method === 'POST' && sub === '/execute') {
          const body = await readBody(req);
          const run = runner.start(id, body.agent, {
            mode: body.mode,
            model: typeof body.model === 'string' ? body.model.trim() || undefined : undefined,
            effort: body.effort,
            permission: body.permission,
          });
          return sendJson(res, 202, run);
        }
        if (req.method === 'DELETE' && sub === '/run') {
          if (!runner.stop(id)) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `task ${id} has no running agent` } });
          }
          return sendJson(res, 200, { stopped: true });
        }
        // 运行中任务的实时输出（终端式视图轮询）
        if (req.method === 'GET' && sub === '/run/output') {
          const out = runner.output(id);
          if (!out) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `task ${id} has no running agent` } });
          }
          return sendJson(res, 200, out);
        }
        if (req.method === 'POST' && sub === '/review-seen') {
          const seen = markReviewSeen(db, id);
          broadcast(); // 其它设备（手机/PC）经 SSE 同步摘掉未查看标记
          return sendJson(res, 200, seen);
        }
        if (req.method === 'POST' && sub === '/comments') {
          const body = await readBody(req);
          const images = saveAttachments(attachmentsDir, id, body.images);
          // author 外部入口只放行 user/agent；system 是服务端内部通知专用，外部伪造一律降级为 user
          const author = ['user', 'agent'].includes(body.author) ? body.author : 'user';
          const comment = addComment(db, id, { author, body: body.body, images });
          broadcast('tasks');
          return sendJson(res, 201, comment);
        }
        // 合并融合第二步（显式快捷操作）：确认生效（源任务 version 校验 → 同事务置已取消 + 互链评论）。
        // 隐式确认：对草案发起 execute 执行时由 runner 自动调用 confirmMerge
        if (req.method === 'POST' && sub === '/merge-confirm') {
          const task = confirmMerge(db, id);
          broadcast();
          return sendJson(res, 200, task);
        }
        // 合并融合第二步（显式快捷操作）：放弃（草案置已取消，源任务不受影响）。
        // 隐式放弃：任意入口把草案置 canceled 都会触发 updateTask 的放弃钩子，语义相同
        if (req.method === 'POST' && sub === '/merge-cancel') {
          const task = cancelMerge(db, id);
          broadcast();
          return sendJson(res, 200, task);
        }
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname} not found` } });
    } catch (err) {
      if (err instanceof DbError) return sendError(res, err);
      console.error(err);
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
    }
  };
}
