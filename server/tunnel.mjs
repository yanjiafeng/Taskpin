// cloudflared 快速隧道：把看板暴露到公网。
// 运行状态在内存（state/liveUrl），最近一次成功的域名持久化到 settings.tunnel_url，
// 供对话框展示「上一次的域名」。进程退出即域名失效。
import { spawn } from 'node:child_process';
import { getSettings, updateSettings } from './db.mjs';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

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
      live: Boolean(liveUrl && state === 'running'),
      token: process.env.TASKBOARD_TOKEN || null,
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

  function start() {
    if (proc) return current(); // 已在运行/启动中
    state = 'starting';
    liveUrl = null;
    error = null;
    try {
      proc = spawnFn('cloudflared', ['tunnel', '--url', targetUrl, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      state = 'error';
      error = err.message;
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
      if (state !== 'error') state = 'stopped';
      broadcast();
      if (wantRestart) {
        wantRestart = false;
        start();
      }
    });
    broadcast();
    return current();
  }

  function stop() {
    if (proc) proc.kill('SIGTERM'); // exit 事件做状态清理
    return current();
  }

  // 重新生成：停掉旧隧道再起新的（快速隧道域名随机，必换新域名）
  function restart() {
    if (!proc) return start();
    wantRestart = true;
    stop();
    return current();
  }

  return { start, stop, restart, status: current };
}
