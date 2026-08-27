// API 测试：真实 HTTP 请求走完整流程。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

let server;
let base;

before(async () => {
  const app = createApp({ dbPath: ':memory:' });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('完整任务流：建任务 → 认领 → 交付 → 验收', async () => {
  const { data: projects } = await req('GET', '/api/projects');
  assert.equal(projects.length, 1);

  // 验收（done）会写项目记忆，主目录隔离到临时目录
  const tmpMain = mkdtempSync(join(tmpdir(), 'tb-flow-'));
  await req('PATCH', `/api/projects/${projects[0].id}`, { main_dir: tmpMain });

  const created = await req('POST', '/api/tasks', { project_id: projects[0].id, title: 'API 任务' });
  assert.equal(created.status, 201);
  const task = created.data;
  assert.equal(task.status, 'todo');
  assert.equal(task.version, 1);

  // 并发认领：只有一个能成功
  const [c1, c2] = await Promise.all([
    req('POST', `/api/tasks/${task.id}/claim`, { thread_id: 't-1' }),
    req('POST', `/api/tasks/${task.id}/claim`, { thread_id: 't-2' }),
  ]);
  const statuses = [c1.status, c2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = c1.status === 200 ? c1 : c2;
  assert.equal(winner.data.status, 'in_progress');
  assert.equal(winner.data.version, 2);

  // 过期 version 更新 → 409 并附 current
  const stale = await req('PATCH', `/api/tasks/${task.id}`, { version: 1, status: 'in_review' });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.data.error.current.version, 2);

  // Agent 不能置 done
  const agentDone = await req('PATCH', `/api/tasks/${task.id}`, { version: 2, status: 'in_review' });
  assert.equal(agentDone.status, 200);
  const forbidden = await req('PATCH', `/api/tasks/${task.id}`, { version: 3, status: 'done' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error.code, 'DONE_REQUIRES_USER');

  // 用户验收
  const accepted = await req('PATCH', `/api/tasks/${task.id}`, { version: 3, status: 'done', by: 'user' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.status, 'done');

  // 评论与详情
  await req('POST', `/api/tasks/${task.id}/comments`, { author: 'user', body: '验收通过' });
  const detail = await req('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.data.comments.length, 1);
  assert.equal(detail.data.comments[0].body, '验收通过');

  // 验收时主目录下生成了项目记忆
  const { readFileSync } = await import('node:fs');
  const mem = readFileSync(join(tmpMain, 'TASKBOARD_MEMORY.md'), 'utf8');
  assert.match(mem, new RegExp(`## #${task.id} API 任务`));
  rmSync(tmpMain, { recursive: true, force: true });
});

test('输入校验与 404', async () => {
  const bad = await req('POST', '/api/tasks', { project_id: 1, title: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'VALIDATION');

  const missing = await req('GET', '/api/tasks/424242');
  assert.equal(missing.status, 404);

  const noRoute = await req('GET', '/api/nope');
  assert.equal(noRoute.status, 404);
});

test('列表过滤', async () => {
  const { data: projects } = await req('GET', '/api/projects');
  const pid = projects[0].id;
  const all = await req('GET', `/api/tasks?project_id=${pid}`);
  assert.ok(all.data.length >= 1);
  const doneOnly = await req('GET', `/api/tasks?project_id=${pid}&status=done`);
  assert.ok(doneOnly.data.every((t) => t.status === 'done'));
});

test('TASKBOARD_TOKEN 认证（本机 Host 免认证）', async (t) => {
  process.env.TASKBOARD_TOKEN = 'test-secret';
  t.after(() => delete process.env.TASKBOARD_TOKEN);

  // 本机 Host（127.0.0.1）免 token
  const local = await req('GET', '/api/projects');
  assert.equal(local.status, 200);

  // 非本机 Host（模拟隧道域名）才校验 token
  const { get } = await import('node:http');
  const viaHost = (path, headers) => new Promise((resolve, reject) => {
    const r = get(base + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
  });
  const extHost = { host: 'xxx.trycloudflare.com' };
  assert.equal(await viaHost('/api/projects', extHost), 401);
  assert.equal(await viaHost('/api/projects', { ...extHost, authorization: 'Bearer test-secret' }), 200);
  assert.equal(await viaHost('/api/projects', { ...extHost, authorization: 'Bearer wrong' }), 401);
  assert.equal(await viaHost('/api/projects?token=test-secret', extHost), 200); // SSE 只能走 query
});

test('静态页面与 SSE 端点', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Taskpin/);

  const controller = new AbortController();
  const sse = await fetch(base + '/api/events', { signal: controller.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  controller.abort();
});

test('项目编辑与任务详情中的项目信息', async () => {
  const { data: projects } = await req('GET', '/api/projects');
  const pid = projects[0].id;

  const updated = await req('PATCH', `/api/projects/${pid}`, { name: '主项目', paths: ['/tmp/a', '/tmp/b'] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.paths, ['/tmp/a', '/tmp/b']);

  // 兼容旧的单 path 字段
  const compat = await req('PATCH', `/api/projects/${pid}`, { path: '/tmp/repo' });
  assert.deepEqual(compat.data.paths, ['/tmp/repo']);

  const cleared = await req('PATCH', `/api/projects/${pid}`, { path: null });
  assert.deepEqual(cleared.data.paths, []);

  const missing = await req('PATCH', '/api/projects/999', { name: 'x' });
  assert.equal(missing.status, 404);

  const created = await req('POST', '/api/tasks', { project_id: pid, title: '详情带项目' });
  const detail = await req('GET', `/api/tasks/${created.data.id}`);
  assert.equal(detail.data.project_name, '主项目');
  assert.deepEqual(detail.data.project_paths, []);
});

test('删除项目：仅限没有未取消任务，任务与评论级联删除', async () => {
  const p = (await req('POST', '/api/projects', { name: '待删项目' })).data;
  const t = (await req('POST', '/api/tasks', { project_id: p.id, title: '占用任务' })).data;
  await req('POST', `/api/tasks/${t.id}/comments`, { author: 'user', body: '评论' });

  // 有未取消任务 -> 422
  const busy = await req('DELETE', `/api/projects/${p.id}`);
  assert.equal(busy.status, 422);
  assert.equal(busy.data.error.code, 'INVALID_TRANSITION');

  // 任务取消后可删；任务与评论级联删除
  await req('PATCH', `/api/tasks/${t.id}`, { version: 1, status: 'canceled' });
  const ok = await req('DELETE', `/api/projects/${p.id}`);
  assert.equal(ok.status, 200);
  const projects = await req('GET', '/api/projects');
  assert.ok(!projects.data.some((x) => x.id === p.id));
  const taskGone = await req('GET', `/api/tasks/${t.id}`);
  assert.equal(taskGone.status, 404);

  // 不存在 -> 404
  const missing = await req('DELETE', `/api/projects/${p.id}`);
  assert.equal(missing.status, 404);
});

test('settings：读取默认、局部更新、至少启用一个 Agent', async () => {
  // 默认全部启用
  const def = await req('GET', '/api/settings');
  assert.deepEqual(def.data.agents, ['codex', 'kimi', 'reasonix', 'dsh']);

  // 局部更新并持久化
  const patched = await req('PATCH', '/api/settings', { agents: ['kimi'] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data.agents, ['kimi']);
  const reread = await req('GET', '/api/settings');
  assert.deepEqual(reread.data.agents, ['kimi']);

  // 全停用 -> 400；未知 agent -> 400；未知 key -> 400
  const empty = await req('PATCH', '/api/settings', { agents: [] });
  assert.equal(empty.status, 400);
  const badAgent = await req('PATCH', '/api/settings', { agents: ['gpt'] });
  assert.equal(badAgent.status, 400);
  const badKey = await req('PATCH', '/api/settings', { theme: 'dark' });
  assert.equal(badKey.status, 400);

  // 非法请求不破坏已存配置
  const after = await req('GET', '/api/settings');
  assert.deepEqual(after.data.agents, ['kimi']);
  await req('PATCH', '/api/settings', { agents: ['codex', 'kimi', 'reasonix', 'dsh'] }); // 恢复默认

  // 执行 prompt 模板：内置默认值端点 + 覆盖/校验/恢复
  const defs = await req('GET', '/api/prompt-defaults');
  assert.ok(defs.data.new.includes('{{task_id}}') && defs.data.resume.includes('{{tctl}}'));
  assert.ok(defs.data.auto_claim.includes('taskctl list --status todo')); // 自动认领提示词
  const badTpl = await req('PATCH', '/api/settings', { prompt_new: '没有占位符的模板' });
  assert.equal(badTpl.status, 400);
  const okTpl = await req('PATCH', '/api/settings', { prompt_new: '自定义 {{task_id}} 用 {{tctl}} 完成' });
  assert.equal(okTpl.status, 200);
  assert.equal(okTpl.data.prompt_new, '自定义 {{task_id}} 用 {{tctl}} 完成');
  const clearedTpl = await req('PATCH', '/api/settings', { prompt_new: null });
  assert.equal(clearedTpl.data.prompt_new, null); // 恢复内置默认
});

test('agent-options：各 agent 的模型/思考/权限由后端下发（模型读各家 CLI 本地配置）', async () => {
  const r = await req('GET', '/api/agent-options');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.codex.efforts, ['low', 'medium', 'high']);
  assert.deepEqual(r.data.codex.permissions, ['read-only', 'workspace-write', 'danger-full-access', 'yolo']);
  assert.deepEqual(r.data.kimi.efforts, []); // kimi 思考/权限不生效
  assert.deepEqual(r.data.kimi.permissions, []);
  assert.deepEqual(r.data.reasonix.efforts, ['low', 'medium', 'high']);
  assert.ok(r.data.reasonix.permissions.includes('bypassPermissions'));
  assert.ok(r.data.reasonix.permissions.includes('yolo')); // YOLO = bypassPermissions 的显式别名
  assert.deepEqual(r.data.dsh.efforts, []); // dsh headless 无 model/effort 参数（模型在 dsh 设置里配）
  assert.deepEqual(r.data.dsh.permissions, ['read-only', 'workspace-write', 'danger-full-access', 'yolo']); // 经 DSH_PERMISSION_MODE 下发
  // 模型清单读本机 CLI 配置（测试环境可能没有这些文件，只断言结构）：{id,label} 数组 + defaultModel
  for (const agent of ['codex', 'kimi', 'reasonix', 'dsh']) {
    assert.ok(Array.isArray(r.data[agent].models));
    for (const mo of r.data[agent].models) {
      assert.equal(typeof mo.id, 'string');
      assert.equal(typeof mo.label, 'string');
    }
    assert.ok(r.data[agent].defaultModel === null || typeof r.data[agent].defaultModel === 'string');
  }
});

test('删除任务：仅已取消，单个与批量（事务）', async () => {
  const mk = async (title) => (await req('POST', '/api/tasks', { project_id: 1, title })).data;
  const t1 = await mk('待删1');
  const t2 = await mk('待删2');
  const t3 = await mk('留着');

  // 非已取消不可删 -> 422
  const notCanceled = await req('DELETE', `/api/tasks/${t1.id}`);
  assert.equal(notCanceled.status, 422);
  assert.equal(notCanceled.data.error.code, 'INVALID_TRANSITION');

  // 取消后可删（评论级联删除）
  await req('POST', `/api/tasks/${t1.id}/comments`, { body: '一条评论' });
  await req('PATCH', `/api/tasks/${t1.id}`, { version: 1, status: 'canceled' });
  const del = await req('DELETE', `/api/tasks/${t1.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, 1);
  assert.equal((await req('GET', `/api/tasks/${t1.id}`)).status, 404);

  // 批量里混着非已取消 -> 整体 422，事务回滚
  await req('PATCH', `/api/tasks/${t2.id}`, { version: 1, status: 'canceled' });
  const mixed = await req('POST', '/api/tasks/batch-delete', { ids: [t2.id, t3.id] });
  assert.equal(mixed.status, 422);
  assert.equal((await req('GET', `/api/tasks/${t2.id}`)).status, 200); // t2 未被误删
  const bad = await req('POST', '/api/tasks/batch-delete', { ids: [] });
  assert.equal(bad.status, 400);

  // 全部已取消 -> 批量删除成功
  const t4 = await mk('待删4');
  await req('PATCH', `/api/tasks/${t4.id}`, { version: 1, status: 'canceled' });
  const batch = await req('POST', '/api/tasks/batch-delete', { ids: [t2.id, t4.id] });
  assert.equal(batch.data.deleted, 2);
  assert.equal((await req('GET', `/api/tasks/${t2.id}`)).status, 404);
  assert.equal((await req('GET', `/api/tasks/${t3.id}`)).status, 200); // t3 不受影响
});

test('execute：启动、查重、停止、退出写评论', async () => {
  const { EventEmitter } = await import('node:events');
  const procs = [];
  const fakeSpawn = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.pid = 40000 + procs.length;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.emit('exit', 143); };
    procs.push({ proc: p, cmd, args, opts });
    return p;
  };
  const app = createApp({ dbPath: ':memory:', spawnFn: fakeSpawn });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const rq = async (method, path, body) => {
    const res = await fetch(b + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    // 主目录隔离到临时目录，避免测试在用户目录下建文件夹
    const tmpMain = mkdtempSync(join(tmpdir(), 'tb-exec-'));
    await rq('PATCH', '/api/projects/1', { main_dir: tmpMain });

    const created = await rq('POST', '/api/tasks', { project_id: 1, title: '执行任务' });
    const tid = created.data.id;

    // 未知 agent -> 400
    const bad = await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'gpt' });
    assert.equal(bad.status, 400);

    // 启动 codex -> 202，默认工作区可写沙箱
    const started = await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'codex' });
    assert.equal(started.status, 202);
    assert.equal(started.data.agent, 'codex');
    assert.equal(procs[0].cmd, 'codex');
    assert.ok(procs[0].args.includes('exec'));
    assert.equal(procs[0].args[procs[0].args.indexOf('-s') + 1], 'workspace-write');
    assert.equal(procs[0].opts.cwd, tmpMain); // 工作目录 = 项目主目录

    // 执行即流转：任务自动进「进行中」（自动认领），卡片位置反映后台执行
    const afterExec = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(afterExec.data.status, 'in_progress');

    // runs 列表 + 重复启动 -> 409
    const runs = await rq('GET', '/api/runs');
    assert.equal(runs.data.length, 1);
    assert.equal(runs.data[0].task_id, tid);
    const dup = await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'RUN_IN_PROGRESS');

    // 进程退出 -> 自动写评论并清空 runs；任务仍停在「进行中」则放回「待规划」
    procs[0].proc.emit('exit', 0);
    const detail = await rq('GET', `/api/tasks/${tid}`);
    assert.ok(detail.data.comments.some((c) => c.body.includes('[runner] codex 正常结束')));
    assert.equal(detail.data.status, 'backlog'); // 进程退出但未流转 -> 回待规划
    assert.ok(detail.data.comments.some((c) => c.body.includes('执行进程已退出')));
    assert.equal((await rq('GET', '/api/runs')).data.length, 0);

    // 停止运行中的 agent：任务回到「待规划」
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    // Windows 下 runner 会用 ~/.kimi-code/bin/kimi.exe 兜底
    assert.ok(procs[1].cmd === 'kimi' || /[\\/]kimi\.exe$/.test(procs[1].cmd), `unexpected kimi cmd: ${procs[1].cmd}`);
    const stop = await rq('DELETE', `/api/tasks/${tid}/run`);
    assert.equal(stop.status, 200);
    assert.ok(procs[1].proc.killed);
    assert.equal((await rq('GET', '/api/runs')).data.length, 0);
    const afterStop = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(afterStop.data.status, 'backlog'); // 暂停执行 -> 回待规划
    assert.ok(afterStop.data.comments.some((c) => c.body.includes('已停止执行')));
    const stopAgain = await rq('DELETE', `/api/tasks/${tid}/run`);
    assert.equal(stopAgain.status, 404);

    // 指定模型/思考/权限参数（codex）
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'codex', model: 'gpt-x', effort: 'high', permission: 'read-only' });
    const cargs = procs[2].args;
    assert.ok(cargs.includes('-m') && cargs.includes('gpt-x'));
    assert.ok(cargs.includes('model_reasoning_effort=high'));
    assert.equal(cargs[cargs.indexOf('-s') + 1], 'read-only');
    procs[2].proc.emit('exit', 0);

    // 按任务记忆本次执行选项：exec_opts 落库（执行弹框回填 + 卡片展示）
    const afterOpts = await rq('GET', `/api/tasks/${tid}`);
    const execOpts = JSON.parse(afterOpts.data.exec_opts);
    assert.equal(execOpts.agent, 'codex');
    assert.equal(execOpts.model, 'gpt-x');
    assert.equal(execOpts.effort, 'high');
    assert.equal(execOpts.permission, 'read-only');

    // kimi：此版本 -p 不能与 --auto/-y 组合，固定为 kimi -p（permission 仅 codex 生效）
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi', permission: 'yolo' });
    assert.ok(procs[3].args.includes('-p'));
    assert.ok(!procs[3].args.includes('--auto') && !procs[3].args.includes('-y'));
    procs[3].proc.emit('exit', 0);

    // 会话续跑：捕获 codex session id 存库，非 todo 状态再执行时用 resume 恢复原会话
    const t3 = await rq('POST', '/api/tasks', { project_id: 1, title: '续跑任务' });
    const t3id = t3.data.id;
    const sid = '019fcf7b-f714-7aa1-b271-d4925b680615';
    await rq('POST', `/api/tasks/${t3id}/execute`, { agent: 'codex' });
    procs[4].proc.stdout.emit('data', Buffer.from(`OpenAI Codex\nsession id: ${sid}\n`));
    procs[4].proc.emit('exit', 0);
    const afterCap = await rq('GET', `/api/tasks/${t3id}`);
    assert.equal(afterCap.data.thread_id, `codex:${sid}`); // thread_id 带 agent 前缀

    // 同 agent 再次执行 → resume 原会话（执行已自动把任务认领进 in_progress）
    await rq('PATCH', `/api/tasks/${t3id}`, { version: afterCap.data.version, status: 'in_progress' });
    await rq('POST', `/api/tasks/${t3id}/execute`, { agent: 'codex' });
    const rargs = procs[5].args;
    assert.ok(rargs.includes('resume') && rargs.includes(sid));
    assert.ok(!rargs.includes('-s')); // resume 子命令无沙箱参数
    procs[5].proc.emit('exit', 0);

    // 跨 agent：上次是 codex，这次 kimi → 无法续跑，开新会话（靠评论继承记忆）
    const ksid = 'session_3e124846-d732-43c4-9ff5-f9c835778467';
    await rq('POST', `/api/tasks/${t3id}/execute`, { agent: 'kimi' });
    assert.ok(!procs[6].args.includes('-S')); // kimi 不续 codex 的会话
    procs[6].proc.stdout.emit('data', Buffer.from(`To resume this session: kimi -r ${ksid}\n`));
    procs[6].proc.emit('exit', 0);
    const afterK = await rq('GET', `/api/tasks/${t3id}`);
    assert.equal(afterK.data.thread_id, `kimi:${ksid}`);

    // 同 agent（kimi）→ 续跑 -S
    await rq('POST', `/api/tasks/${t3id}/execute`, { agent: 'kimi' });
    assert.ok(procs[7].args.includes('-S') && procs[7].args.includes(ksid));
    procs[7].proc.emit('exit', 0);

    // 跨 agent（codex 接 kimi）→ 新会话，不带 resume
    await rq('POST', `/api/tasks/${t3id}/execute`, { agent: 'codex' });
    assert.ok(!procs[8].args.includes('resume'));
    procs[8].proc.emit('exit', 0);

    // reasonix：run 子命令 + 沙箱名映射到 permission-mode + stream-json 事件流输出
    const rxHome = mkdtempSync(join(tmpdir(), 'tb-rxhome-'));
    process.env.REASONIX_HOME = rxHome; // 隔离会话文件查找，不碰真实 Reasonix home
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'reasonix', model: 'deepseek-pro', effort: 'high', permission: 'danger-full-access' });
    assert.equal(procs[9].cmd, 'reasonix');
    const xargs = procs[9].args;
    assert.ok(xargs.includes('run'));
    assert.equal(xargs[xargs.indexOf('--permission-mode') + 1], 'bypassPermissions'); // danger-full-access 映射
    assert.equal(xargs[xargs.indexOf('--model') + 1], 'deepseek-pro');
    assert.equal(xargs[xargs.indexOf('--effort') + 1], 'high');
    assert.ok(xargs.includes('--output-format') && xargs.includes('stream-json')); // 事件流：执行过程可见
    assert.ok(!xargs.includes('--resume')); // todo 状态开新会话
    // 模拟 stream-json 输出：过程事件行（message/tool_dispatch/tool_result）+ 末尾结果行。
    // 捕获 session_id，定位会话文件后写 thread_id，评论提取 result 文本。
    // 附带真实事故场景：结果行 subtype:success 但进程退出码为 1（reasonix 误报），
    // 应以结果行为准记「正常结束」，不打 last_run 异常标记
    const rsid = '20260805-120000.000000000-deepseek-v4-flash';
    const rsessDir = join(rxHome, 'projects', '-x', 'sessions');
    mkdirSync(rsessDir, { recursive: true });
    const rsessFile = join(rsessDir, `${rsid}.jsonl`);
    writeFileSync(rsessFile, '{}\n');
    procs[9].proc.stdout.emit('data', Buffer.from(
      '{"kind":"turn_started"}\n'
      + '{"kind":"tool_dispatch","tool":{"id":"c1","name":"bash","args":"{\\"command\\": \\"echo hi\\"}","readOnly":false}}\n'
      + '{"kind":"tool_result","tool":{"id":"c1","name":"bash","output":"hi\\n","durationMs":40}}\n'
      + '{"kind":"message","text":"执行完成"}\n'
      + `{"type":"result","subtype":"success","is_error":false,"result":"搞定了","session_id":"${rsid}"}\n`,
    ));
    procs[9].proc.emit('exit', 1);
    const afterRx = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(afterRx.data.thread_id, `reasonix:${rsessFile}`); // 存的是会话文件完整路径
    assert.ok(afterRx.data.comments.some((c) => c.body.includes('搞定了') && !c.body.includes('"session_id"')));
    assert.ok(afterRx.data.comments.some((c) => c.body.includes('正常结束') && c.body.includes('忽略进程退出码 1')));
    assert.equal(afterRx.data.last_run, null); // 成功不打异常退出标记

    // 同 agent 续跑：--resume 传会话文件完整路径；权限默认映射 auto
    await rq('PATCH', `/api/tasks/${tid}`, { version: afterRx.data.version, status: 'in_progress' });
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'reasonix' });
    const xargs2 = procs[10].args;
    assert.equal(xargs2[xargs2.indexOf('--resume') + 1], rsessFile);
    assert.equal(xargs2[xargs2.indexOf('--permission-mode') + 1], 'auto');
    procs[10].proc.emit('exit', 0);
    delete process.env.REASONIX_HOME;
    rmSync(rxHome, { recursive: true, force: true });

    // dsh（DeepSeek Harness）：headless 一次性执行；权限经 DSH_PERMISSION_MODE 环境变量下发
    // （yolo → danger-full-access）；prompt 末尾带 taskboard 工具提示；headless 不输出会话 id
    // → 不更新 thread_id（保持上一家 reasonix 的），再执行开新会话
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'dsh', permission: 'yolo' });
    assert.equal(procs[11].cmd, 'dsh');
    assert.deepEqual(procs[11].args.slice(0, 2), ['--profile', 'headless']);
    assert.equal(procs[11].opts.env.DSH_PERMISSION_MODE, 'danger-full-access');
    assert.ok(procs[11].args[2].includes('taskboard_show'));
    assert.ok(!procs[11].args.includes('--resume'));
    procs[11].proc.stdout.emit('data', Buffer.from('完成了\n'));
    procs[11].proc.emit('exit', 0);
    const afterDsh = await rq('GET', `/api/tasks/${tid}`);
    assert.ok(afterDsh.data.comments.some((c) => c.body.includes('[runner] dsh 正常结束')));
    assert.ok(afterDsh.data.thread_id.startsWith('reasonix:')); // dsh 无会话 id 可存，不覆盖

    // dsh 权限默认值与映射：workspace-write 默认；codex 沙箱名原样透传
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'dsh' });
    assert.equal(procs[12].opts.env.DSH_PERMISSION_MODE, 'workspace-write');
    procs[12].proc.emit('exit', 0);

    rmSync(tmpMain, { recursive: true, force: true });

    // 新建不能落在 done（必须走验收流程）
    const asDone = await rq('POST', '/api/tasks', { project_id: 1, title: 'x', status: 'done' });
    assert.equal(asDone.status, 400);

    // 终态任务不可执行 -> 422
    const t2 = await rq('POST', '/api/tasks', { project_id: 1, title: '取消任务' });
    await rq('PATCH', `/api/tasks/${t2.data.id}`, { version: 1, status: 'canceled' });
    const execCanceled = await rq('POST', `/api/tasks/${t2.data.id}/execute`, { agent: 'codex' });
    assert.equal(execCanceled.status, 422);

    // 设置页停用 kimi 后，执行被拒 -> 403 AGENT_DISABLED
    const disabled = await rq('PATCH', '/api/settings', { agents: ['codex', 'reasonix'] });
    assert.equal(disabled.status, 200);
    assert.deepEqual(disabled.data.agents, ['codex', 'reasonix']);
    const execDisabled = await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    assert.equal(execDisabled.status, 403);
    assert.equal(execDisabled.data.error.code, 'AGENT_DISABLED');
    await rq('PATCH', '/api/settings', { agents: ['codex', 'kimi', 'reasonix', 'dsh'] }); // 恢复

    // prompt 模板覆盖：spawn 的 prompt 使用自定义模板并渲染占位符
    await rq('PATCH', '/api/settings', { prompt_new: 'CUSTOM-TPL 任务#{{task_id}} CLI={{tctl}} 范围：{{scope}}' });
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    const kprompt = procs[13].args[procs[13].args.indexOf('-p') + 1];
    assert.ok(kprompt.startsWith('CUSTOM-TPL'));
    assert.ok(kprompt.includes(`任务#${tid}`) && !kprompt.includes('{{task_id}}'));
    procs[13].proc.emit('exit', 0);
    await rq('PATCH', '/api/settings', { prompt_new: null }); // 恢复默认

    // 问答模式：状态不动、用 qa 模板；仅 待规划/待办/阻塞 可发起
    const qa1 = await rq('POST', '/api/tasks', { project_id: 1, title: '问答任务', status: 'backlog' });
    const qid = qa1.data.id;
    const qaStart = await rq('POST', `/api/tasks/${qid}/execute`, { agent: 'kimi', mode: 'qa' });
    assert.equal(qaStart.status, 202);
    assert.ok(qaStart.data.mode.includes('问答'));
    const qprompt = procs[14].args[procs[14].args.indexOf('-p') + 1];
    assert.ok(qprompt.includes('只讨论不实现'));
    procs[14].proc.emit('exit', 0);
    const qaAfter = await rq('GET', `/api/tasks/${qid}`);
    assert.equal(qaAfter.data.status, 'backlog'); // 问答不自动流转状态

    // 问答模板覆盖 + 占位符校验
    const badTpl = await rq('PATCH', '/api/settings', { prompt_qa: '没有占位符的模板' });
    assert.equal(badTpl.status, 400);
    await rq('PATCH', '/api/settings', { prompt_qa: 'QA-TPL #{{task_id}} {{tctl}}' });
    await rq('POST', `/api/tasks/${qid}/execute`, { agent: 'kimi', mode: 'qa' });
    assert.ok(procs[15].args[procs[15].args.indexOf('-p') + 1].startsWith('QA-TPL'));
    procs[15].proc.emit('exit', 0);
    await rq('PATCH', '/api/settings', { prompt_qa: null });

    // 进行中不能发起问答 -> 422（手动 PATCH 到 in_progress，无活动 run）；未知 mode -> 400
    let tidNow = await rq('GET', `/api/tasks/${tid}`);
    await rq('PATCH', `/api/tasks/${tid}`, { version: tidNow.data.version, status: 'todo' });
    tidNow = await rq('GET', `/api/tasks/${tid}`);
    await rq('PATCH', `/api/tasks/${tid}`, { version: tidNow.data.version, status: 'in_progress' });
    const qaBadStatus = await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi', mode: 'qa' });
    assert.equal(qaBadStatus.status, 422);
    tidNow = await rq('GET', `/api/tasks/${tid}`);
    await rq('PATCH', `/api/tasks/${tid}`, { version: tidNow.data.version, status: 'backlog' }); // 还原
    const badMode = await rq('POST', `/api/tasks/${qid}/execute`, { agent: 'kimi', mode: 'chat' });
    assert.equal(badMode.status, 400);

    // prompt-defaults 暴露 qa 模板
    const defs = await rq('GET', '/api/prompt-defaults');
    assert.ok(defs.data.qa.includes('只讨论不实现'));

    // YOLO 模式：codex 跳过审批+无沙箱（与 -s/--add-dir 互斥）；reasonix 映射 bypassPermissions
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'codex', permission: 'yolo' });
    const yargs = procs[16].args;
    assert.ok(yargs.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!yargs.includes('-s') && !yargs.includes('--add-dir'));
    procs[16].proc.emit('exit', 0);
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'reasonix', permission: 'yolo' });
    const ryargs = procs[17].args;
    assert.equal(ryargs[ryargs.indexOf('--permission-mode') + 1], 'bypassPermissions');
    procs[17].proc.emit('exit', 0);
  } finally {
    srv.close();
  }
});

test('残留「进行中」回收：启动时无活跃 run 的 in_progress 自动回待规划，正在跑的不打扰', async () => {
  const { EventEmitter } = await import('node:events');
  const { openDb, createProject, createTask, updateTask } = await import('../server/db.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'tb-stale-'));
  const dbPath = join(tmpDir, 't.sqlite');

  // 预置：模拟上次会话服务重启后留下的残留 in_progress 任务（无任何 run 跟踪、无完成评论）
  let db = openDb(dbPath);
  createProject(db, { name: '残留项目' });
  const stale = createTask(db, { projectId: 1, title: '残留任务' });
  updateTask(db, stale.id, { version: stale.version, status: 'in_progress' });
  db.close();

  const procs = [];
  const fakeSpawn = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.pid = 60000 + procs.length;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.emit('exit', 143); };
    procs.push({ proc: p, cmd, args, opts });
    return p;
  };
  const app = createApp({ dbPath, spawnFn: fakeSpawn });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const rq = async (method, path, body) => {
    const res = await fetch(b + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    // 启动即回收：预置的残留任务回到「待规划」并写说明评论
    const recovered = await rq('GET', `/api/tasks/${stale.id}`);
    assert.equal(recovered.data.status, 'backlog');
    assert.ok(recovered.data.comments.some((c) => c.body.includes('执行进程已中断')));

    // 主目录隔离到临时目录（执行需要可写工作目录）
    const tmpMain = mkdtempSync(join(tmpdir(), 'tb-stale-main-'));
    await rq('PATCH', '/api/projects/1', { main_dir: tmpMain });

    // 正在跑的任务不受回收影响；新的残留（手动 PATCH，模拟外部认领后 agent 失联）显式回收
    const running = await rq('POST', '/api/tasks', { project_id: 1, title: '正在跑' });
    const rid = running.data.id;
    await rq('POST', `/api/tasks/${rid}/execute`, { agent: 'kimi' });
    const orphan = await rq('POST', '/api/tasks', { project_id: 1, title: '失联任务' });
    const oid = orphan.data.id;
    const oNow = await rq('GET', `/api/tasks/${oid}`);
    await rq('PATCH', `/api/tasks/${oid}`, { version: oNow.data.version, status: 'in_progress' });

    assert.equal(app.runner.recoverStale(), 1); // 只回收失联任务
    const runDetail = await rq('GET', `/api/tasks/${rid}`);
    assert.equal(runDetail.data.status, 'in_progress'); // 正在跑的保留
    const orphDetail = await rq('GET', `/api/tasks/${oid}`);
    assert.equal(orphDetail.data.status, 'backlog'); // 失联的回收
    assert.ok(orphDetail.data.comments.some((c) => c.body.includes('执行进程已中断')));

    procs[0].proc.emit('exit', 0); // 收尾：跑完假进程，finish 正常清理
    rmSync(tmpMain, { recursive: true, force: true });
  } finally {
    srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('tunnel：启动、域名持久化、重生成、停止', async () => {
  const { EventEmitter } = await import('node:events');
  const procs = [];
  const fakeSpawn = (cmd, args) => {
    const p = new EventEmitter();
    p.pid = 50000 + procs.length;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { setTimeout(() => p.emit('exit', 0), 0); return true; };
    procs.push({ proc: p, cmd, args });
    return p;
  };
  const app = createApp({ dbPath: ':memory:', spawnFn: fakeSpawn });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const rq = async (method, path) => {
    const res = await fetch(b + path, { method });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    // 初始：停止，无域名
    let s = (await rq('GET', '/api/tunnel')).data;
    assert.equal(s.state, 'stopped');
    assert.equal(s.url, null);

    // 启动 → starting；cloudflared 输出域名 → running 并持久化
    await rq('POST', '/api/tunnel/start');
    // Windows 下若 ~/.local/bin/cloudflared.exe 存在会解析成绝对路径
    assert.ok(procs[0].cmd === 'cloudflared' || /[\\/]cloudflared\.exe$/.test(procs[0].cmd), `unexpected cloudflared cmd: ${procs[0].cmd}`);
    assert.ok(procs[0].args.includes('tunnel'));
    assert.equal((await rq('GET', '/api/tunnel')).data.state, 'starting');
    procs[0].proc.stderr.emit('data', Buffer.from('INF | https://aaa-bbb-ccc.trycloudflare.com |\n'));
    s = (await rq('GET', '/api/tunnel')).data;
    assert.equal(s.state, 'running');
    assert.equal(s.url, 'https://aaa-bbb-ccc.trycloudflare.com');
    assert.equal(s.live, true);

    // 进程退出 → stopped，仍显示上次域名（live=false）
    procs[0].proc.emit('exit', 0);
    s = (await rq('GET', '/api/tunnel')).data;
    assert.equal(s.state, 'stopped');
    assert.equal(s.url, 'https://aaa-bbb-ccc.trycloudflare.com');
    assert.equal(s.live, false);

    // 重新生成（已停止时 = 直接启动新进程）
    await rq('POST', '/api/tunnel/restart');
    assert.equal(procs.length, 2);
    procs[1].proc.stderr.emit('data', Buffer.from('https://ddd-eee-fff.trycloudflare.com\n'));
    assert.equal((await rq('GET', '/api/tunnel')).data.url, 'https://ddd-eee-fff.trycloudflare.com');

    // 运行中 restart → 杀旧进程，其退出后自动起新进程
    await rq('POST', '/api/tunnel/restart');
    await tick(); // 等 kill 触发的 exit 回调
    assert.equal(procs.length, 3);
    procs[2].proc.stderr.emit('data', Buffer.from('https://ggg-hhh-iii.trycloudflare.com\n'));
    s = (await rq('GET', '/api/tunnel')).data;
    assert.equal(s.state, 'running');
    assert.equal(s.url, 'https://ggg-hhh-iii.trycloudflare.com');

    // 停止
    await rq('POST', '/api/tunnel/stop');
    await tick();
    s = (await rq('GET', '/api/tunnel')).data;
    assert.equal(s.state, 'stopped');
    assert.equal(s.url, 'https://ggg-hhh-iii.trycloudflare.com'); // 保留上次域名
  } finally {
    srv.close();
  }
});


test('评论图片附件：粘贴上传、读取、校验', async () => {
  const attDir = mkdtempSync(join(tmpdir(), 'tb-att-'));
  const app = createApp({ dbPath: ':memory:', attachmentsDir: attDir });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const rq = async (method, path, body) => {
    const res = await fetch(b + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  // 1x1 透明 PNG
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  try {
    const created = await rq('POST', '/api/tasks', { project_id: 1, title: '带图评论' });
    const tid = created.data.id;

    // 一次评论多张图片（粘贴场景）
    const c = await rq('POST', `/api/tasks/${tid}/comments`, { author: 'user', body: '看这两张图', images: [{ data: PNG }, { data: PNG }] });
    assert.equal(c.status, 201);
    assert.equal(c.data.images.length, 2);
    assert.ok(c.data.images[0].startsWith(`${tid}/`));

    // 空 body + 纯图片也可以
    const imgOnly = await rq('POST', `/api/tasks/${tid}/comments`, { author: 'user', images: [{ data: PNG }] });
    assert.equal(imgOnly.status, 201);

    // 详情里评论带 images，附件可按路径取回且 content-type 正确
    const detail = await rq('GET', `/api/tasks/${tid}`);
    const withImgs = detail.data.comments.filter((x) => x.images.length);
    assert.equal(withImgs.length, 2);
    const att = await fetch(`${b}/api/attachments/${withImgs[0].images[0]}`);
    assert.equal(att.status, 200);
    assert.equal(att.headers.get('content-type'), 'image/png');
    assert.ok((await att.arrayBuffer()).byteLength > 0);

    // 路径穿越被拒
    const traversal = await fetch(`${b}/api/attachments/${tid}/..%2F..%2Ftaskboard.sqlite`);
    assert.equal(traversal.status, 404);

    // 非图片 dataURL -> 400；空评论（无文无图）-> 400
    const bad = await rq('POST', `/api/tasks/${tid}/comments`, { author: 'user', body: 'x', images: [{ data: 'data:text/plain;base64,aGk=' }] });
    assert.equal(bad.status, 400);
    const empty = await rq('POST', `/api/tasks/${tid}/comments`, { author: 'user', body: '' });
    assert.equal(empty.status, 400);

    // 超过 6 张 -> 400
    const tooMany = await rq('POST', `/api/tasks/${tid}/comments`, { author: 'user', body: 'x', images: Array(7).fill({ data: PNG }) });
    assert.equal(tooMany.status, 400);
  } finally {
    srv.close();
    rmSync(attDir, { recursive: true, force: true });
  }
});


test('执行异常退出标记（last_run）与实时输出接口', async () => {
  const { EventEmitter } = await import('node:events');
  const procs = [];
  const fakeSpawn = (cmd) => {
    const p = new EventEmitter();
    p.pid = 60000 + procs.length;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.emit('exit', null); };
    procs.push({ proc: p, cmd });
    return p;
  };
  const app = createApp({ dbPath: ':memory:', spawnFn: fakeSpawn });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const rq = async (method, path, body) => {
    const res = await fetch(b + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    const tmpMain = mkdtempSync(join(tmpdir(), 'tb-lastrun-'));
    await rq('PATCH', '/api/projects/1', { main_dir: tmpMain });
    const created = await rq('POST', '/api/tasks', { project_id: 1, title: '失败任务' });
    const tid = created.data.id;
    assert.equal(created.data.last_run, null);

    // 未在运行：run/output 404
    const noRun = await rq('GET', `/api/tasks/${tid}/run/output`);
    assert.equal(noRun.status, 404);

    // 启动后：run/output 返回实时输出
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'codex' });
    procs[0].proc.stdout.emit('data', Buffer.from('thinking: 第一步先读文件\n做了些事\n'));
    const live = await rq('GET', `/api/tasks/${tid}/run/output`);
    assert.equal(live.status, 200);
    assert.equal(live.data.agent, 'codex');
    assert.ok(live.data.output.includes('thinking: 第一步先读文件'));

    // 非零退出 → last_run 打标
    procs[0].proc.emit('exit', 3);
    let detail = await rq('GET', `/api/tasks/${tid}`);
    const lr = JSON.parse(detail.data.last_run);
    assert.equal(lr.agent, 'codex');
    assert.equal(lr.code, 3);

    // 列表也带 last_run（卡片渲染用）
    const list = await rq('GET', '/api/tasks');
    assert.equal(JSON.parse(list.data.find((t) => t.id === tid).last_run).code, 3);

    // 进程已退出：run/output 回到 404
    assert.equal((await rq('GET', `/api/tasks/${tid}/run/output`)).status, 404);

    // 新执行开始即清除标记；正常结束保持清除
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    detail = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(detail.data.last_run, null);
    procs[1].proc.emit('exit', 0);
    detail = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(detail.data.last_run, null);

    // 用户主动停止（信号杀死，code 为 null）不打标
    await rq('POST', `/api/tasks/${tid}/execute`, { agent: 'kimi' });
    await rq('DELETE', `/api/tasks/${tid}/run`);
    detail = await rq('GET', `/api/tasks/${tid}`);
    assert.equal(detail.data.last_run, null);

    rmSync(tmpMain, { recursive: true, force: true });
  } finally {
    srv.close();
  }
});


test('quota 端点：返回三家额度结构', async () => {
  const stubQuota = {
    calls: [],
    async get(opts = {}) {
      this.calls.push(opts);
      return {
        fetched_at: '2026-08-10T09:00:00.000Z',
        deepseek: { ok: true, balance: '18.08', currency: 'CNY' },
        kimi: { ok: true, weekly: { limit: 100, used: 82, remaining: 18 } },
        codex: { ok: false, error: 'provider 未提供标准余额接口' },
      };
    },
  };
  const app = createApp({ dbPath: ':memory:', quota: stubQuota });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await fetch(`${b}/api/quota`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deepseek.balance, '18.08');
    assert.equal(data.kimi.weekly.remaining, 18);
    assert.equal(data.codex.ok, false);
    // ?refresh=1 透传强制刷新
    await fetch(`${b}/api/quota?refresh=1`);
    assert.deepEqual(stubQuota.calls[1], { refresh: true });
  } finally {
    srv.close();
  }
});

test('TTS 后备端点：能力探测、参数校验、Windows 上真实合成 wav', async () => {
  const cap = await req('GET', '/api/tts');
  assert.equal(cap.status, 200);
  assert.equal(typeof cap.data.available, 'boolean');

  const empty = await req('POST', '/api/tts', { text: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, 'VALIDATION');
  const tooLong = await req('POST', '/api/tts', { text: '长'.repeat(501) });
  assert.equal(tooLong.status, 400);

  if (process.platform !== 'win32') {
    assert.equal(cap.data.available, false); // 非 Windows 服务端不可用，前端走提示
    return;
  }
  assert.equal(cap.data.available, true);
  const res = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '测试' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF'); // 合法 wav 头
  // 命中缓存的第二次请求应明显更快且内容一致
  const t0 = Date.now();
  const res2 = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '测试' }),
  });
  const buf2 = Buffer.from(await res2.arrayBuffer());
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(buf2, buf);
});

test('评论顺序：问答多轮交错，详情接口严格按提交先后返回（agent 读评论的顺序保证）', async () => {
  const { data: projects } = await req('GET', '/api/projects');
  const created = await req('POST', '/api/tasks', { project_id: projects[0].id, title: '顺序任务' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  // 模拟问答环节：user 补充 → agent [提问] → user 答复 → agent 再问 → user 再答 → agent 收尾
  const rounds = [
    ['user', '需求补充 1'],
    ['agent', '[提问] 验收标准是什么？'],
    ['user', '答复：运行 X 输出 Y'],
    ['agent', '[提问] 还有一个问题'],
    ['user', '答复 2'],
    ['agent', '问答结论摘要'],
  ];
  for (const [author, body] of rounds) {
    const r = await req('POST', `/api/tasks/${id}/comments`, { author, body });
    assert.equal(r.status, 201);
  }

  const detail = await req('GET', `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.comments.map((c) => [c.author, c.body]), rounds);
  // id 单调递增：taskctl show / dsh 插件 / 详情接口都靠 ORDER BY id 给 agent 供稿
  const ids = detail.data.comments.map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});
