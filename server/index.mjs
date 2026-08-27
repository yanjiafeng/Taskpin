// HTTP 入口：API + 静态文件 + SSE + 可选 Token 认证。
// 直接运行：node server/index.mjs（默认 http://127.0.0.1:47824）
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureDefaultProject, defaultDbPath, attachmentsDir as attachmentsDirOf } from './db.mjs';
import { createApiHandler } from './api.mjs';
import { createRunner } from './runner.mjs';
import { createTunnel } from './tunnel.mjs';
import { createQuota } from './quota.mjs';
import { createTts } from './tts.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// 暴露到公网（内网穿透）前务必设置 TASKBOARD_TOKEN。
// 客户端可用 Authorization: Bearer <token> 或 ?token=<token>（SSE 只能后者）。
// Host 为 localhost/127.0.0.1/::1 的本机访问免认证（隧道流量的 Host 是公网域名，不受影响）。
// 注意：若 HOST=0.0.0.0 监听局域网，同网段可伪造 Host: localhost 绕过——公网/局域网暴露务必确认
// 只能通过域名访问或自行加前置鉴权。
function isLocalRequest(req) {
  try {
    const { hostname } = new URL(`http://${req.headers.host || ''}`);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function checkAuth(req, url) {
  const expected = process.env.TASKBOARD_TOKEN;
  if (!expected) return true;
  if (isLocalRequest(req)) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || url.searchParams.get('token') || '';
  if (token.length !== expected.length) return false;
  // timing-safe 比较
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b);
}

export function createApp({ dbPath, spawnFn, port, attachmentsDir, quota } = {}) {
  const db = openDb(dbPath);
  ensureDefaultProject(db);

  const sseClients = new Set();
  function sseSend(res, msg) {
    try { res.write(msg); } catch { sseClients.delete(res); } // 死连接写失败直接摘除
  }
  function broadcast() {
    for (const res of sseClients) sseSend(res, 'data: {"type":"change"}\n\n');
  }
  // 心跳：不能用 SSE 注释行（EventSource 会丢弃，客户端探测不到），发真正的 ping 事件。
  // 手机端 SSE 常静默僵死——连接不报错但事件再也收不到；前端看门狗靠 ping 判断活性
  const heartbeat = setInterval(() => {
    for (const res of sseClients) sseSend(res, 'data: {"type":"ping"}\n\n');
  }, 15_000);
  heartbeat.unref();

  const resolvedDbPath = dbPath ?? defaultDbPath();
  const runner = createRunner({ db, broadcast, dbPath: resolvedDbPath, spawnFn });
  // 回收「残留进行中」：运行跟踪在内存，服务重启即丢失——停在「进行中」但没有活跃 run 的
  // 任务（上次会话进程随重启中断、外部认领后 agent 失联等）自动放回「待规划」，否则会以无
  // 执行样式的普通卡片永久滞留「进行中」列。启动时先收一次，之后每 30s 周期兜底
  // （无残留时零写入；正在跑的任务由 recoverStale 内部排除，不打扰）。
  const recoverStale = () => { try { runner.recoverStale(); } catch { /* 单次回收失败不影响服务 */ } };
  recoverStale();
  const staleTimer = setInterval(recoverStale, 30_000);
  staleTimer.unref();
  const tunnel = createTunnel({ db, broadcast, port, spawnFn });
  const handleApi = createApiHandler({
    db, broadcast, runner, tunnel,
    attachmentsDir: attachmentsDir ?? attachmentsDirOf(resolvedDbPath),
    quota: quota ?? createQuota(),
    // TTS 合成缓存放数据库目录旁（:memory: 测试库落到系统临时目录）
    tts: createTts({ cacheDir: resolvedDbPath === ':memory:' ? undefined : join(dirname(resolvedDbPath), 'tts-cache') }),
  });

  // 外部写入监听：taskctl CLI 直写 SQLite 不经过本进程，无法触发上面的 broadcast；
  // 靠数据库文件变化补广播（WAL 模式下变更先落在 -wal 文件）。本进程自己的写入也会
  // 触发一次多余广播，前端加载是幂等的，可接受。
  if (resolvedDbPath !== ':memory:') {
    const base = basename(resolvedDbPath);
    let debounce = null;
    try {
      const watcher = watch(dirname(resolvedDbPath), (event, filename) => {
        if (!filename || !String(filename).startsWith(base)) return;
        clearTimeout(debounce);
        debounce = setTimeout(broadcast, 300);
      });
      watcher.on('error', () => { /* 监听失败不影响主流程 */ });
      watcher.unref();
    } catch { /* 目录不可监听时静默降级（仅靠 API 内广播） */ }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/events') {
      if (!checkAuth(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'invalid token' } }));
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'invalid token' } }));
      }
      return handleApi(req, res, url);
    }

    // 静态文件
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  // 服务关闭时停掉回收/心跳定时器（测试里每个 app 都会 close，避免遗留定时器空转）
  server.on('close', () => { clearInterval(staleTimer); clearInterval(heartbeat); });

  return { server, db, broadcast, runner, tunnel, dbPath: resolvedDbPath };
}

export function startServer({
  port = Number(process.env.PORT || 47824),
  host = process.env.HOST || '127.0.0.1',
  dbPath,
} = {}) {
  const { server, dbPath: usedDbPath, tunnel } = createApp({ dbPath, port });
  server.listen(port, host, () => {
    console.log(`taskboard: http://${host}:${port}`);
    console.log(`database:  ${usedDbPath}`);
    if (!process.env.TASKBOARD_TOKEN) {
      console.log('warning: TASKBOARD_TOKEN is not set; do not expose this service publicly without it');
    }
  });
  // 服务退出时带走隧道进程，不留孤儿隧道（域名失效但进程空转）
  const shutdown = () => { tunnel.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer();
}
