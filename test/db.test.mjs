// 数据层测试：schema、状态机、乐观锁、原子认领。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, ensureDefaultProject, listProjects, createProject, updateProject, resolveMainDir,
  listTasks, getTask, getTaskWithComments, createTask, claimTask, updateTask, addComment, setTaskLastRun, setTaskUsage, setTaskExecOpts,
  normalizeTags, recentMemories, searchMemories, archiveProjectMemories, DbError,
} from '../server/db.mjs';
import { parseUsage } from '../server/runner.mjs';

function freshDb() {
  return openDb(':memory:');
}

test('ensureDefaultProject 幂等', () => {
  const db = freshDb();
  const p1 = ensureDefaultProject(db);
  const p2 = ensureDefaultProject(db);
  assert.equal(p1.id, p2.id);
  assert.equal(listProjects(db).length, 1);
});

test('createTask 校验标题、状态、优先级', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  assert.throws(() => createTask(db, { projectId: p.id, title: '' }), (e) => e instanceof DbError && e.code === 'VALIDATION');
  assert.throws(() => createTask(db, { projectId: p.id, title: 'x', status: 'nope' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => createTask(db, { projectId: p.id, title: 'x', priority: 'urgent' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => createTask(db, { projectId: 999, title: 'x' }), (e) => e.code === 'NOT_FOUND');
  const t = createTask(db, { projectId: p.id, title: 'ok' });
  assert.equal(t.status, 'todo');
  assert.equal(t.version, 1);
});

test('claim 原子认领，二次认领冲突', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  const claimed = claimTask(db, t.id, { threadId: 'thread-1' });
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.version, 2);
  assert.equal(claimed.thread_id, 'thread-1');
  assert.throws(() => claimTask(db, t.id), (e) => e.code === 'CLAIM_CONFLICT' && e.current.status === 'in_progress');
  assert.throws(() => claimTask(db, 999), (e) => e.code === 'NOT_FOUND');
});

test('updateTask 乐观锁：版本不符即冲突', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  assert.throws(() => updateTask(db, t.id, { version: 99, title: 'new' }),
    (e) => e.code === 'VERSION_CONFLICT' && e.current.version === 1);
  assert.throws(() => updateTask(db, t.id, { title: 'new' }), (e) => e.code === 'VALIDATION');
  const updated = updateTask(db, t.id, { version: 1, title: 'new' });
  assert.equal(updated.title, 'new');
  assert.equal(updated.version, 2);
});

test('状态机：非法跳转被拒绝', () => {
  const db = freshDb();
  // done 会写项目记忆，主目录隔离到临时目录
  const dir = mkdtempSync(join(tmpdir(), 'tb-mem-'));
  try {
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const t1 = createTask(db, { projectId: p.id, title: 'a', status: 'backlog' });
    assert.throws(() => updateTask(db, t1.id, { version: 1, status: 'done' }), (e) => e.code === 'INVALID_TRANSITION');
    assert.throws(() => updateTask(db, t1.id, { version: 1, status: 'in_progress' }), (e) => e.code === 'INVALID_TRANSITION');
    const t2 = updateTask(db, t1.id, { version: 1, status: 'todo' });
    assert.equal(t2.status, 'todo');
    // done 可回退到待办/待规划，其余跳转仍非法
    let cur = claimTask(db, t2.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    cur = updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });
    assert.throws(() => updateTask(db, cur.id, { version: cur.version, status: 'in_progress' }), (e) => e.code === 'INVALID_TRANSITION');
    cur = updateTask(db, cur.id, { version: cur.version, status: 'todo' });
    assert.equal(cur.status, 'todo');
    // 再次走到 done，验证 done → backlog
    cur = claimTask(db, cur.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    cur = updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });
    cur = updateTask(db, cur.id, { version: cur.version, status: 'backlog' });
    assert.equal(cur.status, 'backlog');
    // 第三次走到 done，验证 done → canceled（已完成也可取消）
    cur = updateTask(db, cur.id, { version: cur.version, status: 'todo' });
    cur = claimTask(db, cur.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    cur = updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });
    cur = updateTask(db, cur.id, { version: cur.version, status: 'canceled' });
    assert.equal(cur.status, 'canceled');
    // canceled 仍为终态
    assert.throws(() => updateTask(db, cur.id, { version: cur.version, status: 'todo' }), (e) => e.code === 'INVALID_TRANSITION');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态机：待验收可回退到待办/待规划', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'r', status: 'todo' });
  let cur = claimTask(db, t.id);
  cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
  cur = updateTask(db, cur.id, { version: cur.version, status: 'todo' });
  assert.equal(cur.status, 'todo');
  cur = claimTask(db, cur.id);
  cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
  cur = updateTask(db, cur.id, { version: cur.version, status: 'backlog' });
  assert.equal(cur.status, 'backlog');
});

test('进入 done 必须由用户验收，验收后写结构化项目记忆', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mem-'));
  try {
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const t = createTask(db, { projectId: p.id, title: 'task', description: '需求A' });
    addComment(db, t.id, { author: 'agent', body: '结果摘要B' });
    const claimed = claimTask(db, t.id);
    const review = updateTask(db, claimed.id, { version: claimed.version, status: 'in_review' });
    assert.throws(() => updateTask(db, review.id, { version: review.version, status: 'done' }),
      (e) => e.code === 'DONE_REQUIRES_USER');
    const done = updateTask(db, review.id, { version: review.version, status: 'done' }, { by: 'user' });
    assert.equal(done.status, 'done');

    // 主目录 .taskpin/ 下生成结构化记忆
    const mem = readFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.md'), 'utf8');
    assert.match(mem, /# 项目记忆 · default/);
    assert.match(mem, new RegExp(`## #${t.id} task`));
    assert.match(mem, /- 验收时间：/);
    assert.match(mem, /- 需求：需求A/);
    assert.match(mem, /- 结果：结果摘要B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.taskpin 迁移：主目录根的旧记忆/规则文件在验收时移入 .taskpin/，新摘要追加其后', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mig-'));
  try {
    // 旧布局：根目录放 TASKBOARD_MEMORY.md / TASKBOARD_RULES.md
    writeFileSync(join(dir, 'TASKBOARD_MEMORY.md'), '# 项目记忆 · default\n\n## #1 旧任务\n- 验收时间：2026-01-01 10:00\n');
    writeFileSync(join(dir, 'TASKBOARD_RULES.md'), '# 规则\n- 老规矩\n');
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const t = createTask(db, { projectId: p.id, title: '新任务' });
    let cur = claimTask(db, t.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });

    // 两个旧文件都移入 .taskpin/，根目录不再保留
    assert.ok(!existsSync(join(dir, 'TASKBOARD_MEMORY.md')));
    assert.ok(!existsSync(join(dir, 'TASKBOARD_RULES.md')));
    const mem = readFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.md'), 'utf8');
    assert.match(mem, /## #1 旧任务/); // 旧记忆保留
    assert.ok(mem.indexOf('## #1 旧任务') < mem.indexOf(`## #${t.id} 新任务`)); // 新摘要追加在其后
    assert.equal(readFileSync(join(dir, '.taskpin', 'TASKBOARD_RULES.md'), 'utf8'), '# 规则\n- 老规矩\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.taskpin 迁移：新旧文件同时存在时不动旧文件（避免覆盖新内容）', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mig-'));
  try {
    mkdirSync(join(dir, '.taskpin'));
    writeFileSync(join(dir, 'TASKBOARD_MEMORY.md'), '旧根文件\n');
    writeFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.md'), '# 项目记忆 · default\n\n新文件内容\n');
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const t = createTask(db, { projectId: p.id, title: '任务' });
    let cur = claimTask(db, t.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });

    // 旧文件原地保留，新摘要写进 .taskpin/ 里已有的文件
    assert.equal(readFileSync(join(dir, 'TASKBOARD_MEMORY.md'), 'utf8'), '旧根文件\n');
    const mem = readFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.md'), 'utf8');
    assert.match(mem, /新文件内容/);
    assert.match(mem, new RegExp(`## #${t.id} 任务`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('验收落库 memories 索引表（与 md 文件同事务）', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mem-'));
  try {
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const t = createTask(db, { projectId: p.id, title: '索引任务', description: '需求X' });
    let cur = claimTask(db, t.id);
    cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
    updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });

    const rows = db.prepare('SELECT * FROM memories WHERE project_id = ?').all(p.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, t.id);
    assert.equal(rows[0].archived, 0);
    assert.match(rows[0].summary, new RegExp(`## #${t.id} 索引任务`));
    assert.match(rows[0].summary, /- 需求：需求X/);
    // recentMemories 供 prompt 注入
    assert.equal(recentMemories(db, p.id).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记忆遗忘：超出 keep 的旧记忆折叠归档，主文件重写为最近 keep 条全文', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mem-'));
  try {
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const accept = (title) => {
      const t = createTask(db, { projectId: p.id, title });
      let cur = claimTask(db, t.id);
      cur = updateTask(db, cur.id, { version: cur.version, status: 'in_review' });
      updateTask(db, cur.id, { version: cur.version, status: 'done' }, { by: 'user' });
    };
    accept('任务一');
    accept('任务二');
    accept('任务三');
    // 默认 keep=50 不触发；显式 keep=2 归档最旧一条
    assert.equal(archiveProjectMemories(db, p.id, 2), 1);

    const archived = db.prepare('SELECT * FROM memories WHERE project_id = ? AND archived = 1').all(p.id);
    assert.equal(archived.length, 1);
    assert.match(archived[0].summary, /任务一/);
    // 主文件只剩最近 2 条全文
    const mem = readFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.md'), 'utf8');
    assert.ok(!mem.includes('任务一'));
    assert.match(mem, /任务二/);
    assert.match(mem, /任务三/);
    // 归档文件有一行摘要
    const arch = readFileSync(join(dir, '.taskpin', 'TASKBOARD_MEMORY.archive.md'), 'utf8');
    assert.match(arch, /任务一/);
    // 检索仍覆盖归档条目
    assert.ok(searchMemories(db, p.id, '任务一').length >= 1);
    // 不超额时幂等返回 0（归档后非归档正好 2 条 = keep）
    assert.equal(archiveProjectMemories(db, p.id, 2), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchMemories：BM25 排序 + 时间衰减 + 项目隔离', () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'tb-mem-'));
  try {
    const p = ensureDefaultProject(db);
    updateProject(db, p.id, { mainDir: dir });
    const ins = db.prepare('INSERT INTO memories (project_id, task_id, summary, created_at, archived) VALUES (?, ?, ?, ?, 0)');
    const day = 86400000;
    const nowMs = Date.now();
    ins.run(p.id, 1, '## #1 修复登录超时\n- 结果：调整了 timeout 配置', new Date(nowMs - 60 * day).toISOString()); // 旧
    ins.run(p.id, 2, '## #2 修复登录超时\n- 结果：调整了 timeout 配置', new Date(nowMs - 1 * day).toISOString()); // 新（同文）
    ins.run(p.id, 3, '## #3 看板样式调整\n- 结果：改了卡片颜色', new Date(nowMs).toISOString());
    const p2 = createProject(db, { name: 'other' });
    ins.run(p2.id, 9, '## #9 登录 timeout', new Date(nowMs).toISOString());

    const hits = searchMemories(db, p.id, '登录 timeout', { now: nowMs });
    assert.ok(hits.length >= 2);
    // 同文下新的排前面（时间衰减）
    assert.equal(hits[0].task_id, 2);
    assert.ok(hits.every((h) => h.score > 0));
    // 不命中返回空；项目隔离：p2 的记忆不会出现在 p 的结果里
    assert.ok(hits.every((h) => h.project_id === p.id));
    assert.equal(searchMemories(db, p.id, '完全无关词zzz').length, 0);
    assert.equal(searchMemories(db, p2.id, '登录').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('评论落库并计入 comment_count', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  addComment(db, t.id, { author: 'agent', body: '进展 1' });
  addComment(db, t.id, { author: 'user', body: '收到' });
  const detail = getTaskWithComments(db, t.id);
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comments[0].author, 'agent');
  const listed = listTasks(db, { projectId: p.id });
  assert.equal(listed[0].comment_count, 2);
  assert.throws(() => addComment(db, t.id, { body: '' }), (e) => e.code === 'VALIDATION');
});

test('listTasks 过滤与取消任务可见性', () => {
  const db = freshDb();
  const p1 = ensureDefaultProject(db);
  const p2 = createProject(db, { name: 'second' });
  const a = createTask(db, { projectId: p1.id, title: 'a' });
  createTask(db, { projectId: p2.id, title: 'b' });
  updateTask(db, a.id, { version: 1, status: 'canceled' });
  assert.equal(listTasks(db, { projectId: p1.id }).length, 1);
  assert.equal(listTasks(db, { projectId: p1.id, includeCanceled: false }).length, 0);
  assert.equal(listTasks(db, {}).length, 2);
  assert.equal(listTasks(db, { status: 'canceled' }).length, 1);
});

test('updateProject 改名、改路径列表、清空', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const renamed = updateProject(db, p.id, { name: '主项目', paths: ['/tmp/repo', '/tmp/lib'] });
  assert.equal(renamed.name, '主项目');
  assert.deepEqual(renamed.paths, ['/tmp/repo', '/tmp/lib']);
  const cleared = updateProject(db, p.id, { paths: [] });
  assert.deepEqual(cleared.paths, []);
  assert.equal(cleared.name, '主项目');
  const kept = updateProject(db, p.id, { name: '再改' });
  assert.deepEqual(kept.paths, []);
  assert.throws(() => updateProject(db, 999, { name: 'x' }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => updateProject(db, p.id, { name: '  ' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => createProject(db, { name: 'x', paths: ['/ok', 1] }), (e) => e.code === 'VALIDATION');
});

test('任务详情包含项目名与路径列表', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  updateProject(db, p.id, { name: '主项目', paths: ['/tmp/repo'] });
  const t = createTask(db, { projectId: p.id, title: 'task' });
  const detail = getTaskWithComments(db, t.id);
  assert.equal(detail.project_name, '主项目');
  assert.deepEqual(detail.project_paths, ['/tmp/repo']);
  assert.equal(detail.project_path, '/tmp/repo');
});

test('旧库单 path 字段自动迁移为 paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskboard-mig-'));
  try {
    const file = join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT, created_at TEXT NOT NULL)');
    old.exec("INSERT INTO projects (name, path, created_at) VALUES ('legacy', '/tmp/legacy', '2026-01-01')");
    old.exec("INSERT INTO projects (name, path, created_at) VALUES ('nopath', NULL, '2026-01-01')");
    old.close();
    const db = openDb(file);
    const rows = listProjects(db);
    assert.deepEqual(rows.find((r) => r.name === 'legacy').paths, ['/tmp/legacy']);
    assert.deepEqual(rows.find((r) => r.name === 'nopath').paths, []);
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    assert.ok(cols.includes('paths'));
    assert.ok(cols.includes('main_dir'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('项目主目录：设置、保持不变、清空恢复默认、自动创建', () => {
  const db = freshDb();
  const p = createProject(db, { name: 'dirproj', mainDir: '/tmp/main-a' });
  assert.equal(p.main_dir, '/tmp/main-a');

  // 不传 mainDir 保持不变
  const kept = updateProject(db, p.id, { name: 'dirproj2' });
  assert.equal(kept.main_dir, '/tmp/main-a');
  // 空串清空 -> null（恢复默认 ~/项目名）
  const cleared = updateProject(db, p.id, { mainDir: '' });
  assert.equal(cleared.main_dir, null);

  // resolveMainDir：用配置的目录并按需创建
  const tmp = mkdtempSync(join(tmpdir(), 'tb-main-'));
  try {
    const dir = resolveMainDir({ name: 'x', main_dir: join(tmp, 'sub/dir') });
    assert.equal(dir, join(tmp, 'sub/dir'));
    assert.ok(statSync(dir).isDirectory());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test('last_run 异常退出标记：写入/清除，不 bump version', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  assert.equal(t.last_run, null);

  const mark = JSON.stringify({ agent: 'kimi', code: 1, error: null, at: new Date().toISOString() });
  setTaskLastRun(db, t.id, mark);
  const after = getTask(db, t.id);
  assert.equal(after.last_run, mark);
  assert.equal(after.version, t.version); // 元数据不 bump version

  setTaskLastRun(db, t.id, null);
  assert.equal(getTask(db, t.id).last_run, null);
});

test('usage 上下文用量：写入/清除，不 bump version', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  assert.equal(t.usage, null);

  const usage = JSON.stringify({ agent: 'codex', tokens: 10850, at: new Date().toISOString() });
  setTaskUsage(db, t.id, usage);
  const after = getTask(db, t.id);
  assert.equal(after.usage, usage);
  assert.equal(after.version, t.version); // 元数据不 bump version

  setTaskUsage(db, t.id, null);
  assert.equal(getTask(db, t.id).usage, null);
});

test('exec_opts 执行选项记忆：写入/清除，不 bump version', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  assert.equal(t.exec_opts, null);

  const opts = JSON.stringify({ agent: 'codex', model: 'gpt-x', effort: 'high', permission: 'read-only', at: new Date().toISOString() });
  setTaskExecOpts(db, t.id, opts);
  const after = getTask(db, t.id);
  assert.equal(after.exec_opts, opts);
  assert.equal(after.version, t.version); // 元数据不 bump version

  setTaskExecOpts(db, t.id, null);
  assert.equal(getTask(db, t.id).exec_opts, null);
});

test('任务标签：tags 列默认 []，updateTask 写入/校验/清空', () => {
  const db = freshDb();
  const p = ensureDefaultProject(db);
  const t = createTask(db, { projectId: p.id, title: 'task' });
  assert.equal(t.tags, '[]'); // 迁移列默认值

  // roundtrip：自动去重去空
  const updated = updateTask(db, t.id, { version: 1, tags: ['前端', ' 紧急 ', '前端', ''] });
  assert.equal(JSON.parse(updated.tags).join(','), '前端,紧急');

  // 清空
  const cleared = updateTask(db, t.id, { version: updated.version, tags: [] });
  assert.equal(cleared.tags, '[]');

  // 校验：非数组 / 超 8 个 / 单条超长
  assert.throws(() => updateTask(db, t.id, { version: cleared.version, tags: 'a,b' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => updateTask(db, t.id, { version: cleared.version, tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }), (e) => e.code === 'VALIDATION');
  assert.throws(() => updateTask(db, t.id, { version: cleared.version, tags: ['x'.repeat(21)] }), (e) => e.code === 'VALIDATION');
  assert.throws(() => normalizeTags(null), (e) => e.code === 'VALIDATION');
});

test('parseUsage：codex / reasonix 输出解析，kimi 与无用量输出返回 null', () => {
  // codex：尾部 "tokens used\n10,850"
  assert.deepEqual(parseUsage('codex', '好了\ntokens used\n10,850\n好了'), { tokens: 10850 });
  assert.equal(parseUsage('codex', '没有用量行'), null);
  // reasonix：结果 JSON 行的 usage 字段（input + output）
  const line = '{"type":"result","result":"好了","usage":{"input_tokens":5722,"output_tokens":18}}';
  assert.deepEqual(parseUsage('reasonix', `warning: xxx\n${line}`), { input_tokens: 5722, output_tokens: 18, tokens: 5740 });
  assert.equal(parseUsage('reasonix', '{"type":"result","result":"好了"}'), null);
  // kimi -p 不输出用量
  assert.equal(parseUsage('kimi', '好了\n\nTo resume this session: kimi -r session_x'), null);
  assert.equal(parseUsage('kimi', ''), null);
});
