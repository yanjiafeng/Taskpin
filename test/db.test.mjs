// 数据层测试：schema、状态机、乐观锁、原子认领。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, ensureDefaultProject, listProjects, createProject, updateProject, resolveMainDir,
  listTasks, getTask, getTaskWithComments, createTask, claimTask, updateTask, addComment, setTaskLastRun, setTaskUsage, DbError,
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

    // 主目录下生成结构化记忆
    const mem = readFileSync(join(dir, 'TASKBOARD_MEMORY.md'), 'utf8');
    assert.match(mem, /# 项目记忆 · default/);
    assert.match(mem, new RegExp(`## #${t.id} task`));
    assert.match(mem, /- 验收时间：/);
    assert.match(mem, /- 需求：需求A/);
    assert.match(mem, /- 结果：结果摘要B/);
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
