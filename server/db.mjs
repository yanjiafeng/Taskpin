// 数据层：schema、状态机、乐观并发控制。server 与 CLI 共用。
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled'];
export const PRIORITIES = ['low', 'normal', 'high'];

// 允许的状态跳转。canceled 为终态；done 可回退到 todo / backlog（重新规划），也可取消。
const TRANSITIONS = {
  backlog: ['todo', 'canceled'],
  todo: ['in_progress', 'backlog', 'canceled'],
  in_progress: ['in_review', 'blocked', 'todo', 'backlog', 'canceled'],
  blocked: ['in_progress', 'todo', 'canceled'],
  in_review: ['done', 'in_progress', 'todo', 'backlog', 'canceled'],
  done: ['todo', 'backlog', 'canceled'],
  canceled: [],
};

export class DbError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const now = () => new Date().toISOString();

export function defaultDbPath() {
  return process.env.TASKBOARD_DB || join(homedir(), '.codex-task-dashiboard', 'taskboard.sqlite');
}

export function openDb(dbPath = defaultDbPath()) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      paths TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal',
      version INTEGER NOT NULL DEFAULT 1,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT 'user',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 迁移：旧库的单 path 字段 -> paths JSON 数组
  const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!cols.includes('paths')) {
    db.exec("ALTER TABLE projects ADD COLUMN paths TEXT NOT NULL DEFAULT '[]'");
    if (cols.includes('path')) {
      db.exec("UPDATE projects SET paths = json_array(path) WHERE path IS NOT NULL AND path != ''");
      try { db.exec('ALTER TABLE projects DROP COLUMN path'); } catch { /* 旧 SQLite 不支持 DROP COLUMN 则保留 */ }
    }
  }
  // 迁移：项目主目录（Agent 执行的工作目录）
  if (!cols.includes('main_dir')) {
    db.exec('ALTER TABLE projects ADD COLUMN main_dir TEXT');
  }
  // 迁移：评论图片附件（JSON 数组，存附件相对路径 <taskId>/<文件>）
  const commentCols = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (!commentCols.includes('images')) {
    db.exec("ALTER TABLE comments ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
  }
  // 迁移：最近一次执行结果标记（异常退出时写 JSON {agent, code, error, at}；NULL = 正常/无）
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('last_run')) {
    db.exec('ALTER TABLE tasks ADD COLUMN last_run TEXT');
  }
  // 迁移：最近一次执行从 agent 输出解析到的上下文用量（JSON {agent, tokens?|input_tokens?, output_tokens?, at}；NULL = 未解析到）
  if (!taskCols.includes('usage')) {
    db.exec('ALTER TABLE tasks ADD COLUMN usage TEXT');
  }
  // 迁移：最近一次执行选用的模型/思考/权限（JSON {agent, model?, effort?, permission?, at}；NULL = 未执行过）
  if (!taskCols.includes('exec_opts')) {
    db.exec('ALTER TABLE tasks ADD COLUMN exec_opts TEXT');
  }
  return db;
}

// 数据库里 paths 存 JSON 字符串，对外一律是数组
function parseProject(row) {
  if (!row) return row;
  return { ...row, paths: JSON.parse(row.paths || '[]') };
}

// ---------- projects ----------

export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY id').all().map(parseProject);
}

function cleanPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new DbError('VALIDATION', 'paths must be an array of strings');
  }
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
}

export function createProject(db, { name, paths = [], mainDir = null }) {
  if (!name || !name.trim()) throw new DbError('VALIDATION', 'project name is required');
  const ts = now();
  const r = db.prepare('INSERT INTO projects (name, paths, main_dir, created_at) VALUES (?, ?, ?, ?)')
    .run(name.trim(), JSON.stringify(cleanPaths(paths)), mainDir?.trim() || null, ts);
  return parseProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid));
}

// 修改项目名/路径列表/主目录。paths、mainDir 传 undefined 保持不变，paths 传 [] 清空，mainDir 传空串清空（恢复默认）。
export function updateProject(db, id, { name, paths, mainDir } = {}) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) throw new DbError('NOT_FOUND', `project ${id} not found`);
  if (name != null && !name.trim()) throw new DbError('VALIDATION', 'project name cannot be empty');
  db.prepare('UPDATE projects SET name = ?, paths = ?, main_dir = ? WHERE id = ?').run(
    name != null ? name.trim() : project.name,
    paths === undefined ? project.paths : JSON.stringify(cleanPaths(paths)),
    mainDir === undefined ? project.main_dir : (mainDir?.trim() || null),
    id
  );
  return parseProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

// 删除项目：只允许没有未取消任务的项目；其任务与评论由外键 ON DELETE CASCADE 一并删除
export function deleteProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) throw new DbError('NOT_FOUND', `project ${id} not found`);
  const active = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'canceled'").get(id).n;
  if (active > 0) {
    throw new DbError('INVALID_TRANSITION', `项目「${project.name}」下还有 ${active} 个未取消任务，请先取消或删除它们`);
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return { deleted: 1 };
}

// 项目主目录：未配置时回退到 ~/<项目名>；不存在则创建。作为 Agent 执行的工作目录。
export function resolveMainDir(project) {
  const fallback = (project?.name || 'taskboard').replace(/[\/\\:*?"<>|]/g, '_').trim() || 'taskboard';
  const dir = project?.main_dir?.trim() || join(homedir(), fallback);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 任务验收（done）时，把任务摘要按固定结构追加到主目录的 TASKBOARD_MEMORY.md。
// 写入失败不阻断状态流转，只打印错误。
function appendProjectMemory(db, task) {
  const project = db.prepare('SELECT name, main_dir FROM projects WHERE id = ?').get(task.project_id);
  const dir = resolveMainDir(project);
  const file = join(dir, 'TASKBOARD_MEMORY.md');
  const comments = db.prepare('SELECT author, body FROM comments WHERE task_id = ? ORDER BY id').all(task.id);
  const oneLine = (s) => s.trim().replace(/\s*\n\s*/g, ' ⏎ ');
  const agentResult = [...comments].reverse().find((c) => c.author === 'agent' && !c.body.startsWith('[runner]'));
  const userNote = [...comments].reverse().find((c) => c.author === 'user');
  if (!existsSync(file)) {
    writeFileSync(file, `# 项目记忆 · ${project?.name ?? 'unknown'}\n\n> 由 Taskpin 自动维护：任务验收（done）时追加。\n`);
  }
  const lines = [
    `\n## #${task.id} ${task.title}`,
    `- 验收时间：${now().slice(0, 16).replace('T', ' ')}`,
  ];
  if (task.description?.trim()) lines.push(`- 需求：${oneLine(task.description)}`);
  if (agentResult) lines.push(`- 结果：${oneLine(agentResult.body)}`);
  if (userNote) lines.push(`- 验收意见：${oneLine(userNote.body)}`);
  appendFileSync(file, lines.join('\n') + '\n');
}

export function ensureDefaultProject(db) {
  const first = db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').get();
  if (first) return parseProject(first);
  return createProject(db, { name: 'default' });
}

// ---------- settings ----------

export const AGENT_NAMES = ['codex', 'kimi', 'reasonix', 'dsh'];
// prompt_new/prompt_resume/prompt_qa：执行/问答 prompt 模板覆盖（null = 用 runner.mjs 的 PROMPT_DEFAULTS）
// tunnel_url：最近一次 cloudflared 隧道域名（隧道断开后展示用，由 tunnel.mjs 写入）
const SETTING_DEFAULTS = () => ({ agents: [...AGENT_NAMES], prompt_new: null, prompt_resume: null, prompt_qa: null, tunnel_url: null });
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS());
const PROMPT_KEYS = ['prompt_new', 'prompt_resume', 'prompt_qa'];

// 全局设置（key-value，value 存 JSON）：agents = 启用的执行 Agent；prompt_* = 执行 prompt 模板覆盖
export function getSettings(db) {
  const out = SETTING_DEFAULTS();
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(row.key in out)) continue;
    try { out[row.key] = JSON.parse(row.value); } catch { /* 坏值回退默认 */ }
  }
  return out;
}

export function updateSettings(db, patch = {}) {
  const cur = getSettings(db);
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.includes(key)) throw new DbError('VALIDATION', `unknown setting: ${key}`);
    // null / 空串 = 清除覆盖，恢复默认
    if (value === null || value === '') {
      del.run(key);
      cur[key] = SETTING_DEFAULTS()[key];
      continue;
    }
    if (key === 'agents') {
      if (!Array.isArray(value) || value.some((a) => !AGENT_NAMES.includes(a))) {
        throw new DbError('VALIDATION', `agents 必须是以下值的数组：${AGENT_NAMES.join('|')}`);
      }
      if (value.length === 0) throw new DbError('VALIDATION', '至少需要启用一个 Agent');
    }
    if (PROMPT_KEYS.includes(key)) {
      if (typeof value !== 'string') throw new DbError('VALIDATION', `${key} 必须是字符串或 null`);
      for (const ph of ['{{task_id}}', '{{tctl}}']) {
        if (!value.includes(ph)) throw new DbError('VALIDATION', `${key} 缺少必需占位符 ${ph}`);
      }
    }
    upsert.run(key, JSON.stringify(value));
    cur[key] = value;
  }
  return cur;
}

// ---------- tasks ----------

export function listTasks(db, { projectId, status, includeCanceled = true } = {}) {
  const where = [];
  const args = [];
  if (projectId != null) { where.push('project_id = ?'); args.push(projectId); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (!includeCanceled) { where.push("status != 'canceled'"); }
  const sql = `SELECT tasks.*, (SELECT COUNT(*) FROM comments WHERE comments.task_id = tasks.id) AS comment_count FROM tasks${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY tasks.id`;
  return db.prepare(sql).all(...args);
}

export function getTask(db, id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new DbError('NOT_FOUND', `task ${id} not found`);
  return task;
}

export function getTaskWithComments(db, id) {
  const task = db.prepare(
    'SELECT tasks.*, projects.name AS project_name, projects.paths AS project_paths FROM tasks JOIN projects ON projects.id = tasks.project_id WHERE tasks.id = ?'
  ).get(id);
  if (!task) throw new DbError('NOT_FOUND', `task ${id} not found`);
  const paths = JSON.parse(task.project_paths || '[]');
  const comments = db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(id)
    .map((c) => ({ ...c, images: JSON.parse(c.images || '[]') }));
  return { ...task, project_paths: paths, project_path: paths[0] ?? null, comments };
}

export function createTask(db, { projectId, title, description = '', status = 'todo', priority = 'normal' }) {
  if (!title || !title.trim()) throw new DbError('VALIDATION', 'task title is required');
  // 新建只能落在 backlog/todo，其余状态必须走状态机流转（尤其 done 必须验收）
  if (!['backlog', 'todo'].includes(status)) {
    throw new DbError('VALIDATION', `invalid initial status: ${status} (backlog|todo)`);
  }
  if (!PRIORITIES.includes(priority)) throw new DbError('VALIDATION', `invalid priority: ${priority}`);
  db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    || (() => { throw new DbError('NOT_FOUND', `project ${projectId} not found`); })();
  const ts = now();
  const r = db.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(projectId, title.trim(), description, status, priority, ts, ts);
  return getTask(db, r.lastInsertRowid);
}

// 通用更新：必须携带当前 version，冲突抛 VERSION_CONFLICT。
// 状态跳转校验状态机；进入 done 必须 by === 'user'（人工验收）。
export function updateTask(db, id, patch, { by = 'agent' } = {}) {
  const task = getTask(db, id);
  if (patch.version == null) throw new DbError('VALIDATION', 'version is required (optimistic concurrency)');
  if (patch.version !== task.version) {
    throw new DbError('VERSION_CONFLICT', `task ${id} version conflict: expected ${task.version}, got ${patch.version}`, { current: task });
  }
  if (patch.status != null && patch.status !== task.status) {
    if (!STATUSES.includes(patch.status)) throw new DbError('VALIDATION', `invalid status: ${patch.status}`);
    const allowed = TRANSITIONS[task.status] || [];
    if (!allowed.includes(patch.status)) {
      throw new DbError('INVALID_TRANSITION', `cannot move task ${id} from ${task.status} to ${patch.status}`, { current: task });
    }
    if (patch.status === 'done' && by !== 'user') {
      throw new DbError('DONE_REQUIRES_USER', 'only the user can accept a task into done', { current: task });
    }
  }
  const fields = {};
  for (const k of ['title', 'description', 'status', 'priority', 'thread_id']) {
    if (patch[k] != null) fields[k] = patch[k];
  }
  if (fields.priority && !PRIORITIES.includes(fields.priority)) {
    throw new DbError('VALIDATION', `invalid priority: ${fields.priority}`);
  }
  const sets = ['version = version + 1', 'updated_at = ?'];
  const args = [now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  args.push(id, task.version);
  const r = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...args);
  if (r.changes === 0) throw new DbError('VERSION_CONFLICT', `task ${id} version conflict`, { current: getTask(db, id) });
  const updated = getTask(db, id);
  // 验收进入 done：整理一条结构化项目记忆（失败不阻断流转）
  if (fields.status === 'done' && task.status !== 'done') {
    try { appendProjectMemory(db, updated); } catch (e) { console.error(`[taskboard] 项目记忆写入失败: ${e.message}`); }
  }
  return updated;
}

// 原子认领：单条条件 UPDATE，todo -> in_progress。不需要预先读 version。
export function claimTask(db, id, { threadId = null } = {}) {
  const ts = now();
  const r = db.prepare(
    "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ?, thread_id = COALESCE(?, thread_id) WHERE id = ? AND status = 'todo'"
  ).run(ts, threadId, id);
  if (r.changes > 0) return getTask(db, id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new DbError('NOT_FOUND', `task ${id} not found`);
  throw new DbError('CLAIM_CONFLICT', `task ${id} is not in todo (current: ${task.status})`, { current: task });
}

// 记录任务的 Agent CLI 会话 id（runner 执行结束后写，用于打回重做时续跑原会话）
export function setTaskThread(db, id, threadId) {
  db.prepare('UPDATE tasks SET thread_id = ? WHERE id = ?').run(threadId, id);
}

// 记录最近一次执行结果：异常退出写 JSON {agent, code, error, at}，正常结束/新执行开始传 null 清除。
// 元数据，不 bump version（同 thread_id）。卡片据此渲染红色告警。
export function setTaskLastRun(db, id, lastRun) {
  db.prepare('UPDATE tasks SET last_run = ? WHERE id = ?').run(lastRun, id);
}

// 记录最近一次执行解析到的上下文用量（JSON；kimi 等 CLI 不输出用量时保持 NULL）。
// 元数据，不 bump version（同 last_run）。详情抽屉据此展示「上下文大小（来源：agent 会话输出）」。
export function setTaskUsage(db, id, usage) {
  db.prepare('UPDATE tasks SET usage = ? WHERE id = ?').run(usage, id);
}

// 记录最近一次执行选用的 agent + 模型/思考/权限（JSON {agent, model?, effort?, permission?, at}）。
// 元数据，不 bump version（同 usage）。执行弹框据此回填上一次的选择，卡片据此展示摘要。
export function setTaskExecOpts(db, id, execOpts) {
  db.prepare('UPDATE tasks SET exec_opts = ? WHERE id = ?').run(execOpts, id);
}

// 删除任务（评论随外键级联删除）。只允许已取消状态；批量在同一个事务里，任一不满足整体回滚。
export function deleteTasks(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger)) {
    throw new DbError('VALIDATION', 'ids 必须是非空整数数组');
  }
  const get = db.prepare('SELECT id, status FROM tasks WHERE id = ?');
  const del = db.prepare('DELETE FROM tasks WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const t = get.get(id);
      if (!t) throw new DbError('NOT_FOUND', `task ${id} not found`);
      if (t.status !== 'canceled') {
        throw new DbError('INVALID_TRANSITION', `task ${id} is ${t.status}，只能删除已取消的任务`);
      }
      del.run(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted: ids.length };
}

// ---------- comments ----------

// 评论附件：存 <db 同目录>/attachments/<taskId>/<文件>，comments.images 存相对路径 JSON。
// agent 与看板同机运行，taskctl show 打印绝对路径，agent 可直接读图。
export function attachmentsDir(dbPath) {
  return join(dirname(dbPath), 'attachments');
}

const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// files: [{ name?, data }] —— data 为 dataURL（data:image/png;base64,...）。返回附件相对路径数组。
export function saveAttachments(dir, taskId, files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_IMAGES) throw new DbError('VALIDATION', `最多 ${MAX_IMAGES} 张图片`);
  mkdirSync(join(dir, String(taskId)), { recursive: true });
  return files.map((f, i) => {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(f?.data || '');
    if (!m || !IMAGE_MIME_EXT[m[1]]) {
      throw new DbError('VALIDATION', `第 ${i + 1} 张图片格式不支持（仅 png/jpg/gif/webp 的 dataURL）`);
    }
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      throw new DbError('VALIDATION', `第 ${i + 1} 张图片大小超限（最大 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）`);
    }
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${IMAGE_MIME_EXT[m[1]]}`;
    writeFileSync(join(dir, String(taskId), name), buf);
    return `${taskId}/${name}`;
  });
}

// images 为 saveAttachments 返回的相对路径数组；有图时 body 可为空
export function addComment(db, taskId, { author = 'user', body, images = [] }) {
  if ((!body || !body.trim()) && images.length === 0) throw new DbError('VALIDATION', 'comment body is required');
  if (!['user', 'agent'].includes(author)) throw new DbError('VALIDATION', `invalid author: ${author}`);
  getTask(db, taskId);
  const ts = now();
  const r = db.prepare('INSERT INTO comments (task_id, author, body, images, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, (body || '').trim(), JSON.stringify(images), ts);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
  return { ...row, images: JSON.parse(row.images || '[]') };
}

export { TRANSITIONS };
