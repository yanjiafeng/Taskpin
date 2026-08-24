// REST API 路由。统一 JSON 错误格式 {error: {code, message}}。
import {
  listProjects, createProject, updateProject, deleteProject, listTasks, getTaskWithComments,
  createTask, updateTask, claimTask, addComment, deleteTasks, getSettings, updateSettings,
  saveAttachments, DbError,
} from './db.mjs';
import { PROMPT_DEFAULTS, AUTO_CLAIM_PROMPT, getAgentOptions } from './runner.mjs';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

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
      // 上限 60MB：评论图片走 base64 dataURL，6 张 8MB 图编码后约 43MB
      if (data.length > 60_000_000) reject(new DbError('VALIDATION', 'request body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new DbError('VALIDATION', 'request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createApiHandler({ db, broadcast, runner, tunnel, attachmentsDir, quota }) {
  return async function handleApi(req, res, url) {
    const m = url.pathname.match(/^\/api\/tasks\/(\d+)(\/claim|\/comments|\/execute|\/run|\/run\/output)?$/);
    const pm = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    const am = url.pathname.match(/^\/api\/attachments\/(\d+)\/([\w.-]+)$/);
    try {
      // 评论图片附件（文件在 attachments/<taskId>/ 下，只允许该目录内的平文件名）
      if (req.method === 'GET' && am) {
        const ext = am[2].split('.').pop().toLowerCase();
        const type = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
        const filePath = normalize(join(attachmentsDir, am[1], am[2]));
        if (!type || !filePath.startsWith(normalize(join(attachmentsDir, am[1])))) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'attachment not found' } });
        }
        try {
          const data = await readFile(filePath);
          res.writeHead(200, { 'content-type': type, 'cache-control': 'immutable, max-age=31536000' });
          return res.end(data);
        } catch {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'attachment not found' } });
        }
      }
      // runs
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return sendJson(res, 200, runner.list());
      }
      // 三家 Agent 的额度/余额（quota.mjs 本机读凭证查询，元数据接口不耗 token，60s 缓存）
      if (req.method === 'GET' && url.pathname === '/api/quota') {
        if (!quota) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'quota not configured' } });
        return sendJson(res, 200, await quota.get({ refresh: url.searchParams.get('refresh') === '1' }));
      }
      // settings（目前只有 agents：启用的执行 Agent）
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
        return sendJson(res, 200, listTasks(db, {
          projectId: projectId == null ? undefined : Number(projectId),
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

      // task item
      if (m) {
        const id = Number(m[1]);
        const sub = m[2];
        if (req.method === 'GET' && !sub) {
          return sendJson(res, 200, getTaskWithComments(db, id));
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
        if (req.method === 'POST' && sub === '/comments') {
          const body = await readBody(req);
          const images = saveAttachments(attachmentsDir, id, body.images);
          const comment = addComment(db, id, { author: body.author ?? 'user', body: body.body, images });
          broadcast('tasks');
          return sendJson(res, 201, comment);
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
