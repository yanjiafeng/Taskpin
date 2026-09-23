#!/usr/bin/env node
// taskctl：用户与 Agent 操作任务板的 CLI。直接读写 SQLite，不依赖 server 运行。
// 默认输出 JSON（Agent 友好），--pretty 人性化输出。错误以 JSON 打到 stderr，退出码非零。
import {
  openDb, defaultDbPath, ensureDefaultProject,
  listProjects, createProject, updateProject, deleteProject, listTasks, getTaskWithComments,
  createTask, claimTask, updateTask, addComment, saveAttachments, attachmentsDir, searchMemories,
  mergeTasks, confirmMerge, cancelMerge, compactComments, DbError, ATTACHMENT_MIME_EXT,
} from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const USAGE = `taskctl - task board CLI

usage: taskctl <command> [options]

commands:
  serve                                  启动看板服务 (env PORT/HOST/TASKBOARD_TOKEN)
  projects                               列出项目
  project-create --name N [--path P1,P2] [--main-dir D]  创建项目（路径可多个，逗号分隔；主目录默认 ~/项目名）
  project-update ID [--name N] [--path P1,P2] [--main-dir D]  修改项目（--path "" 清空路径，--main-dir "" 恢复默认）
  project-delete ID                      删除项目（仅限没有未取消任务的项目，任务与评论一并删除）
  list [--project ID] [--status S] [--all] [--pretty]
  show ID [--compact]                      任务详情 + 全部评论（--compact 续跑省 token：剔除 [runner] 评论、折叠早期评论）
  create --title T [--project ID] [--desc D] [--status S] [--priority low|normal|high]
  claim ID [--thread-id X]               原子认领：todo -> in_progress
  update ID --if-version N [--status S] [--title T] [--desc D] [--priority P] [--thread-id X] [--tags a,b,c]
  done ID --if-version N                 用户验收：in_review -> done（仅用户）
  merge --ids 1,2,3                      合并融合第一步：校验（2~5 个、同项目、非已取消/进行中）并建 backlog 融合草案（融合执行需在看板 UI 发起，CLI 只建草案）
  merge-confirm ID                       第二步：确认生效——源任务 version 未变则全部置已取消并互链评论
  merge-cancel ID                        第二步：放弃——草案置已取消，源任务不受影响
  comment ID --body B [--author user|agent] [--image P]... [--file P]...   评论；--image/--file 可多次添加附件（图片 png/jpg/gif/webp，文件 pdf/doc/docx/xls/xlsx/ppt/pptx/md/txt/csv/zip）
  memory search <关键词> [--project ID] [--limit N]   检索项目记忆（BM25 + 时间衰减；--project 不传则搜全部项目）

env:
  TASKBOARD_DB   数据库文件路径（默认 ~/.codex-task-dashiboard/taskboard.sqlite）
`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      // 重复出现的 flag 收成数组（如 --image a.png --image b.png）
      if (key in flags) flags[key] = [flags[key]].flat().concat(val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { flags, pos };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(err) {
  const code = err instanceof DbError ? err.code : 'INTERNAL';
  const body = { error: { code, message: err.message } };
  if (err.current) body.error.current = err.current;
  process.stderr.write(JSON.stringify(body) + '\n');
  process.exit(1);
}

function need(value, message) {
  if (value == null || value === '') throw new DbError('VALIDATION', message);
  return value;
}

const parsePaths = (s) => String(s).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

// ext→mime 与 db.mjs 附件白名单同源（另加 .jpeg/.markdown 别名）
const MIME_BY_EXT = {
  ...Object.fromEntries(Object.entries(ATTACHMENT_MIME_EXT).map(([mime, ext]) => [`.${ext}`, mime])),
  '.jpeg': 'image/jpeg',
  '.markdown': 'text/markdown',
};
function fileToDataUrl(p) {
  const mime = MIME_BY_EXT[extname(p).toLowerCase()];
  if (!mime) throw new DbError('VALIDATION', `不支持的附件类型：${p}（图片 png/jpg/gif/webp；文件 pdf/doc/docx/xls/xlsx/ppt/pptx/md/txt/csv/zip）`);
  return { name: p, data: `data:${mime};base64,${readFileSync(p).toString('base64')}` };
}

function prettyTask(t) {
  const thread = t.thread_id ? ` thread:${t.thread_id}` : '';
  return `#${t.id} [${t.status}] (${t.priority}) v${t.version} ${t.title}${thread}`;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'serve') {
    startServer();
    return;
  }

  const { flags, pos } = parseArgs(rest);
  const pretty = flags.pretty === true;
  const dbPath = process.env.TASKBOARD_DB || defaultDbPath();
  const db = openDb(dbPath);

  switch (cmd) {
    case 'projects': {
      const rows = listProjects(db);
      if (pretty) rows.forEach((p) => console.log(`#${p.id} ${p.name}${p.main_dir ? ` [主目录 ${p.main_dir}]` : ''}${p.paths.length ? ` (${p.paths.join(', ')})` : ''}`));
      else out(rows);
      return;
    }
    case 'project-create': {
      out(createProject(db, {
        name: need(flags.name, '--name is required'),
        paths: flags.path != null ? parsePaths(flags.path) : [],
        mainDir: flags['main-dir'],
      }));
      return;
    }
    case 'project-update': {
      const id = Number(need(pos[0], 'project id is required'));
      const patch = {};
      if (flags.name != null) patch.name = flags.name;
      if (flags.path != null) patch.paths = parsePaths(flags.path);
      if (flags['main-dir'] != null) patch.mainDir = flags['main-dir']; // 传 "" 清空恢复默认
      out(updateProject(db, id, patch));
      return;
    }
    case 'project-delete': {
      const id = Number(need(pos[0], 'project id is required'));
      out(deleteProject(db, id));
      return;
    }
    case 'list': {
      const rows = listTasks(db, {
        projectId: flags.project != null ? Number(flags.project) : undefined,
        status: flags.status,
        includeCanceled: flags.all === true,
      });
      if (pretty) rows.forEach((t) => console.log(prettyTask(t)));
      else out(rows);
      return;
    }
    case 'show': {
      const id = Number(need(pos[0], 'task id is required'));
      const t = getTaskWithComments(db, id);
      // --compact：续跑省 token（剔除 [runner] 评论、折叠「最新一轮」之前的早期评论）
      if (flags.compact === true) t.comments = compactComments(t.comments);
      // 附件转成绝对路径，agent 可直接读取（图片用读图工具，md/txt/csv 直接读）
      t.comments.forEach((c) => {
        c.images = (c.images || []).map((img) => {
          const rel = typeof img === 'string' ? img : img.path;
          const abs = join(attachmentsDir(dbPath), rel);
          return typeof img === 'string' ? abs : { ...img, path: abs };
        });
      });
      if (pretty) {
        console.log(prettyTask(t));
        console.log(`project:#${t.project_id} ${t.project_name ?? ''}${t.project_path ? ` (${t.project_path})` : ''} created:${t.created_at} updated:${t.updated_at}`);
        const tags = JSON.parse(t.tags || '[]');
        if (tags.length) console.log(`tags: ${tags.join(', ')}`);
        console.log(t.description || '(no description)');
        t.comments.forEach((c) => {
          console.log(`\n[${c.author} ${c.created_at}]\n${c.body}`);
          (c.images || []).forEach((img) => console.log(
            typeof img === 'string' ? `[附件] ${img}` : `[附件] ${img.name} -> ${img.path}`,
          ));
        });
      } else out(t);
      return;
    }
    case 'create': {
      const projectId = flags.project != null ? Number(flags.project) : ensureDefaultProject(db).id;
      out(createTask(db, {
        projectId,
        title: need(flags.title, '--title is required'),
        description: flags.desc ?? '',
        status: flags.status ?? 'todo',
        priority: flags.priority ?? 'normal',
      }));
      return;
    }
    case 'claim': {
      const id = Number(need(pos[0], 'task id is required'));
      out(claimTask(db, id, { threadId: flags['thread-id'] ?? null }));
      return;
    }
    case 'update': {
      const id = Number(need(pos[0], 'task id is required'));
      const version = Number(need(flags['if-version'], '--if-version is required'));
      const patch = { version };
      if (flags.status != null) patch.status = flags.status;
      if (flags.title != null) patch.title = flags.title;
      if (flags.desc != null) patch.description = flags.desc;
      if (flags.priority != null) patch.priority = flags.priority;
      if (flags['thread-id'] != null) patch.thread_id = flags['thread-id'];
      if (flags.tags != null) patch.tags = parsePaths(flags.tags); // 逗号分隔；--tags "" 清空
      out(updateTask(db, id, patch, { by: flags['as-user'] === true ? 'user' : 'agent' }));
      return;
    }
    case 'done': {
      const id = Number(need(pos[0], 'task id is required'));
      const version = Number(need(flags['if-version'], '--if-version is required'));
      out(updateTask(db, id, { version, status: 'done' }, { by: 'user' }));
      return;
    }
    case 'merge': {
      const ids = parsePaths(need(flags.ids, '--ids is required（逗号分隔，如 1,2,3）')).map(Number);
      out(mergeTasks(db, ids));
      return;
    }
    case 'merge-confirm': {
      const id = Number(need(pos[0], 'task id is required'));
      out(confirmMerge(db, id));
      return;
    }
    case 'merge-cancel': {
      const id = Number(need(pos[0], 'task id is required'));
      out(cancelMerge(db, id));
      return;
    }
    case 'memory': {
      const sub = pos[0];
      if (sub !== 'search') throw new DbError('VALIDATION', 'usage: taskctl memory search <关键词> [--project ID] [--limit N]');
      const query = need(pos.slice(1).join(' '), 'memory search 需要关键词');
      const limit = flags.limit != null ? Number(flags.limit) : undefined;
      // --project 不传则搜全部项目（本地单机 CLI 属主本人）；传入时强制单项目隔离
      const projectIds = flags.project != null ? [Number(flags.project)] : listProjects(db).map((p) => p.id);
      const hits = projectIds.flatMap((pid) => searchMemories(db, pid, query, { limit: limit ?? 1000 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit ?? 5);
      out(hits);
      return;
    }
    case 'comment': {
      const id = Number(need(pos[0], 'task id is required'));
      // --image/--file 可多次：读文件转 dataURL，存到 <db 目录>/attachments/<taskId>/
      const filePaths = [
        ...(flags.image != null ? [flags.image].flat() : []),
        ...(flags.file != null ? [flags.file].flat() : []),
      ];
      const images = saveAttachments(attachmentsDir(dbPath), id, filePaths.map((p) => fileToDataUrl(p)));
      // --author 只放行 user/agent；system 是服务端内部通知专用，CLI 不可伪造
      const author = ['user', 'agent'].includes(flags.author) ? flags.author : 'agent';
      out(addComment(db, id, {
        author,
        body: images.length ? (flags.body ?? '') : need(flags.body, '--body is required'),
        images,
      }));
      return;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  fail(err);
}
