// cloudflared 快速隧道：把看板暴露到公网。
// 运行状态在内存（state/liveUrl），最近一次成功的域名持久化到 settings.tunnel_url，
// 供对话框展示「上一次的域名」。进程退出即域名失效。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { getSettings, updateSettings } from './db.mjs';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// 取一个可用的局域网 IPv4 地址（非 127.0.0.1），用于无 cloudflared 时的局域网分享提示
function getLanUrl(port) {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return null;
}

// 定位 cloudflared 可执行文件：显式环境变量 > Windows 常见安装位置 > PATH 中的 cloudflared
function resolveCloudflared() {
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  if (process.platform === 'win32') {
    const home = homedir();
    const candidates = [
      join(home, '.local', 'bin', 'cloudflared.exe'),
      join(home, '.cloudflared', 'cloudflared.exe'),
      join(home, 'AppData', 'Local', 'cloudflared', 'cloudflared.exe'),
      join(home, 'AppData', 'Roaming', 'cloudflared', 'cloudflared.exe'),
      'C:\\cloudflared\\cloudflared.exe',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return 'cloudflared';
}

export function createTunnel({ db, broadcast, port = 47824, spawnFn = spawn, target }) {
  let proc = null;
  let state = 'stopped'; // stopped | starting | running | error
  let liveUrl = null;
  let error = null;
  let wantRestart = false;
  const targetUrl = target || `http://127.0.0.1:${port}`;

  function current() {
    return {
      state,
      // 隧道活着时是当前域名，否则是 settings 里上次的域名
      url: liveUrl || getSettings(db).tunnel_url || null,
      lanUrl: getLanUrl(port),
      live: Boolean(liveUrl && state === 'running'),
      token: process.env.TASKBOARD_TOKEN || getSettings(db).access_token || null,
      error,
    };
  }

  function onData(d) {
    if (liveUrl) return;
    const m = URL_RE.exec(String(d));
    if (m) {
      liveUrl = m[0];
      state = 'running';
      error = null;
      try { updateSettings(db, { tunnel_url: liveUrl }); } catch { /* 持久化失败不影响使用 */ }
      broadcast();
    }
  }

  // 访问 Token 随隧道生命周期管理：启动隧道时若未设置则自动生成；
  // 「重新生成」强制换新（旧分享链接随之失效，等于吊销）。
  // TASKBOARD_TOKEN 环境变量优先于它——设了环境变量就不动 settings。
  function rotateToken(force) {
    if (process.env.TASKBOARD_TOKEN) return;
    if (!force && getSettings(db).access_token) return;
    try {
      updateSettings(db, { access_token: randomBytes(24).toString('base64url') });
    } catch (err) {
      // 写库失败 = 隧道可能以无 Token 状态暴露，必须留下痕迹
      console.error('[tunnel] access_token 写入失败，注意公网访问可能无 Token 保护:', err);
    }
  }

  function start() {
    if (proc) return current(); // 已在运行/启动中
    rotateToken(false);
    state = 'starting';
    liveUrl = null;
    error = null;
    const cmd = resolveCloudflared();
    try {
      proc = spawnFn(cmd, ['tunnel', '--url', targetUrl, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      state = 'error';
      const isEnoent = err.code === 'ENOENT' || /ENOENT|not found/i.test(err.message);
      const hint = isEnoent
        ? `未找到 cloudflared。请下载 cloudflared-windows-amd64.exe 重命名为 cloudflared.exe 放到 C:\\Users\\yan\\.local\\bin，或设置 CLOUDFLARED_PATH 环境变量。`
        : `可设置 CLOUDFLARED_PATH 环境变量指定路径。`;
      error = `${err.message}（解析路径：${cmd}；${hint}）`;
      proc = null;
      return current();
    }
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      state = 'error';
      error = err.message;
      proc = null;
      liveUrl = null;
      broadcast();
    });
    proc.on('exit', () => {
      proc = null;
      liveUrl = null;
      if (wantRestart) {
        // 重启链路：直接起新进程，不落 stopped 中间态（避免弹框刷新到 stopped 停止轮询）
        wantRestart = false;
        start();
        return;
      }
      if (state !== 'error') state = 'stopped';
      broadcast();
    });
    broadcast();
    return current();
  }

  function stop() {
    if (proc) proc.kill('SIGTERM'); // exit 事件做状态清理
    return current();
  }

  // 重新生成：停掉旧隧道再起新的（快速隧道域名随机，必换新域名）；同时换新访问 Token
  function restart() {
    rotateToken(true);
    // 立即进入「换新中」：否则旧进程退出晚于前端刷新时，弹框会停在 running+旧域名 不再更新
    liveUrl = null;
    state = 'starting';
    if (!proc) return start();
    wantRestart = true;
    stop();
    return current();
  }

  return { start, stop, restart, status: current };
}
