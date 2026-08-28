// 数据层：schema、状态机、乐观并发控制。server 与 CLI 共用。
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, archived);
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
  // 迁移：任务标签（JSON 数组字符串，明细抽屉维护，卡片标题下方胶带风胶囊展示）
  if (!taskCols.includes('tags')) {
    db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
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

// ---------- 项目记忆（.taskpin/ 目录 + memories 索引表 + 检索 + 遗忘） ----------

// 项目主目录下的 .taskpin/ 子目录：收纳 TASKBOARD_RULES.md / TASKBOARD_MEMORY.md / 记忆归档文件
export function taskpinDir(mainDir) {
  const dir = join(mainDir, '.taskpin');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MEMORY_FILE = 'TASKBOARD_MEMORY.md';
const RULES_FILE = 'TASKBOARD_RULES.md';
const ARCHIVE_FILE = 'TASKBOARD_MEMORY.archive.md';
// 主文件只保留最近 N 条全文，超出的折叠为一行摘要进归档文件（遗忘，防无限膨胀）
export const MEMORY_KEEP_FULL = 50;
// 执行 prompt 注入：最近 N 条全文 + 检索命中条数
export const MEMORY_RECENT_FULL = 10;
export const MEMORY_SEARCH_TOP = 5;
// 检索时间衰减：score = bm25 × 0.5^(ageDays/半衰期)
export const MEMORY_DECAY_HALFLIFE_DAYS = 30;

// 一次性迁移：主目录根的旧 TASKBOARD_MEMORY.md / TASKBOARD_RULES.md 移入 .taskpin/。
// 两边都存在时不动旧文件（避免覆盖新内容），打印提示由人工合并。失败只打印错误，不阻断验收。
function migrateTaskpinFiles(mainDir) {
  for (const name of [MEMORY_FILE, RULES_FILE]) {
    const oldFile = join(mainDir, name);
    const newFile = join(mainDir, '.taskpin', name);
    try {
      if (!existsSync(oldFile)) continue;
      if (existsSync(newFile)) {
        console.error(`[taskboard] 提示：${oldFile} 与 ${newFile} 同时存在，未自动合并，请人工处理后删除旧文件`);
        continue;
      }
      mkdirSync(join(mainDir, '.taskpin'), { recursive: true });
      renameSync(oldFile, newFile);
      console.error(`[taskboard] 已迁移 ${oldFile} -> ${newFile}`);
    } catch (e) {
      console.error(`[taskboard] 迁移 ${oldFile} 失败: ${e.message}`);
    }
  }
}

const oneLine = (s) => s.trim().replace(/\s*\n\s*/g, ' ⏎ ');

const memoryHeader = (name) =>
  `# 项目记忆 · ${name}\n\n> 由 Taskpin 自动维护：任务验收（done）时追加；仅保留最近 ${MEMORY_KEEP_FULL} 条全文，更早的折叠进 ${ARCHIVE_FILE}。\n`;

// 遗忘：非归档记忆超过 keep 条时，最旧的折叠为一行摘要追加到 .taskpin/TASKBOARD_MEMORY.archive.md，
// 索引表标 archived=1，主文件按索引表重写为最近 keep 条全文。返回本次归档条数。
export function archiveProjectMemories(db, projectId, keep = MEMORY_KEEP_FULL) {
  const rows = db.prepare('SELECT * FROM memories WHERE project_id = ? AND archived = 0 ORDER BY id').all(projectId);
  if (rows.length <= keep) return 0;
  const excess = rows.slice(0, rows.length - keep);
  const kept = rows.slice(rows.length - keep);
  const project = db.prepare('SELECT name, main_dir FROM projects WHERE id = ?').get(projectId);
  const tp = taskpinDir(resolveMainDir(project));
  const archFile = join(tp, ARCHIVE_FILE);
  if (!existsSync(archFile)) {
    writeFileSync(archFile, `# 项目记忆归档 · ${project?.name ?? 'unknown'}\n\n> 超出最近 ${keep} 条的旧记忆折叠为一行摘要归档于此；taskctl memory search 的全文检索仍覆盖这些条目。\n`);
  }
  const mark = db.prepare('UPDATE memories SET archived = 1 WHERE id = ?');
  for (const r of excess) {
    appendFileSync(archFile, `- ${oneLine(r.summary)}\n`);
    mark.run(r.id);
  }
  writeFileSync(join(tp, MEMORY_FILE), memoryHeader(project?.name ?? 'unknown'));
  for (const r of kept) appendFileSync(join(tp, MEMORY_FILE), `\n${r.summary.trim()}\n`);
  return excess.length;
}

// 任务验收（done）时，把任务摘要按固定结构追加到主目录 .taskpin/TASKBOARD_MEMORY.md，
// 并与 memories 索引表落库 + 归档检查放在同一事务。写入失败不阻断状态流转，只打印错误。
function appendProjectMemory(db, task) {
  const project = db.prepare('SELECT name, main_dir FROM projects WHERE id = ?').get(task.project_id);
  const dir = resolveMainDir(project);
  migrateTaskpinFiles(dir); // 按需迁移旧布局（仅验收时触发，不扫描不相关目录）
  const tp = taskpinDir(dir);
  const file = join(tp, MEMORY_FILE);
  const comments = db.prepare('SELECT author, body FROM comments WHERE task_id = ? ORDER BY id').all(task.id);
  const agentResult = [...comments].reverse().find((c) => c.author === 'agent' && !c.body.startsWith('[runner]'));
  const userNote = [...comments].reverse().find((c) => c.author === 'user');
  const lines = [
    `## #${task.id} ${task.title}`,
    `- 验收时间：${now().slice(0, 16).replace('T', ' ')}`,
  ];
  if (task.description?.trim()) lines.push(`- 需求：${oneLine(task.description)}`);
  if (agentResult) lines.push(`- 结果：${oneLine(agentResult.body)}`);
  if (userNote) lines.push(`- 验收意见：${oneLine(userNote.body)}`);
  const entry = lines.join('\n');
  if (!existsSync(file)) {
    writeFileSync(file, memoryHeader(project?.name ?? 'unknown'));
  }
  appendFileSync(file, `\n${entry}\n`);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO memories (project_id, task_id, summary, created_at, archived) VALUES (?, ?, ?, ?, 0)')
      .run(task.project_id, task.id, entry, now());
    archiveProjectMemories(db, task.project_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 执行 prompt 注入用：最近 N 条未归档记忆全文（按时间正序返回）
export function recentMemories(db, projectId, limit = MEMORY_RECENT_FULL) {
  return db.prepare('SELECT * FROM memories WHERE project_id = ? AND archived = 0 ORDER BY id DESC LIMIT ?')
    .all(projectId, limit)
    .reverse();
}

// BM25 检索（JS 全量打分，语料 KB~MB 级足够；内置 SQLite 无 FTS5）。
// 分词：拉丁/数字词 + CJK 单字。评分乘时间衰减：score = bm25 × 0.5^(ageDays/半衰期)。
// 项目隔离：强制 WHERE project_id = ?，scope 由服务端从任务记录解析。
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  return (s.match(/[a-z0-9_]+/g) || []).concat(s.match(/[㐀-鿿豈-﫿]/g) || []);
}

export function searchMemories(db, projectId, query, { limit = MEMORY_SEARCH_TOP, now: nowMs = Date.now() } = {}) {
  const rows = db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY id').all(projectId);
  const qTokens = [...new Set(tokenize(query))];
  if (!rows.length || !qTokens.length) return [];
  const docs = rows.map((r) => tokenize(r.summary));
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.5;
  const b = 0.75;
  const out = [];
  rows.forEach((r, i) => {
    const d = docs[i];
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let bm25 = 0;
    for (const q of qTokens) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (rows.length - df.get(q) + 0.5) / (df.get(q) + 0.5));
      bm25 += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl));
    }
    if (bm25 <= 0) return;
    const ageDays = Math.max(0, (nowMs - new Date(r.created_at).getTime()) / 86400000);
    const score = bm25 * Math.pow(0.5, ageDays / MEMORY_DECAY_HALFLIFE_DAYS);
    out.push({ ...r, score });
  });
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
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

// 任务标签校验：必须是数组；元素 trim、去空、去重（大小写敏感）；单个 ≤20 字符，总数 ≤8 个。
// 返回 JSON 字符串（updateTask 的 fields 直写落库）。
export function normalizeTags(v) {
  if (!Array.isArray(v)) throw new DbError('VALIDATION', 'tags 必须是数组');
  const tags = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  if (tags.length > 8) throw new DbError('VALIDATION', '标签最多 8 个');
  for (const t of tags) {
    if (t.length > 20) throw new DbError('VALIDATION', `标签「${t}」超长（单个最多 20 字符）`);
  }
  return JSON.stringify(tags);
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
  if (patch.tags != null) fields.tags = normalizeTags(patch.tags);
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
