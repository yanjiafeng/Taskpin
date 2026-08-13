// 额度查询：DeepSeek（Reasonix）钱包余额 / Kimi 订阅用量 / Codex（OpenAI 兼容）计费。
// 全部是元数据/钱包接口，不消耗模型 token。凭证只在本机读取，结果不含任何密钥。
// 结果缓存（默认 60s），前端展开额度区时调用。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 从 .env 风格文件里取某个 KEY（容忍引号/注释）
function readEnvValue(file, key) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* 文件不存在 */ }
  return null;
}

// config.toml 里 model_provider = "X" 指向的 [model_providers.X] 段的 base_url（朴素解析，够用即可）
function readCodexProvider(configToml) {
  let text;
  try { text = readFileSync(configToml, 'utf8'); } catch { return null; }
  const strip = (l) => l.replace(/#.*$/, '');
  const pm = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(text.split('\n').map(strip).join('\n'));
  if (!pm) return null;
  const section = new RegExp(`^\\s*\\[model_providers\\.${pm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'm');
  const sm = section.exec(text);
  if (!sm) return null;
  const rest = text.slice(sm.index + sm[0].length);
  const end = rest.search(/^\s*\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const bm = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(body);
  return bm ? { name: pm[1], baseUrl: bm[1].replace(/\/+$/, '') } : null;
}

async function qDeepseek({ home, fetchImpl }) {
  const envFile = join(home, '.reasonix', '.env');
  const key = readEnvValue(envFile, 'DEEPSEEK_API_KEY');
  if (!key) return { ok: false, error: '未找到 ~/.reasonix/.env 的 DEEPSEEK_API_KEY' };
  const res = await fetchImpl('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { ok: false, error: `deepseek 余额接口 HTTP ${res.status}` };
  const j = await res.json();
  const b = j.balance_infos?.find((x) => x.currency === 'CNY') || j.balance_infos?.[0];
  if (!b) return { ok: false, error: '余额接口返回异常' };
  return { ok: true, balance: b.total_balance, currency: b.currency };
}

async function qKimi({ home, fetchImpl }) {
  const credFile = join(home, '.kimi-code', 'credentials', 'kimi-code.json');
  if (!existsSync(credFile)) return { ok: false, error: '未找到 kimi 登录凭证（~/.kimi-code）' };
  let cred;
  try { cred = JSON.parse(readFileSync(credFile, 'utf8')); } catch { return { ok: false, error: 'kimi 凭证文件损坏' }; }
  if (!cred.access_token) return { ok: false, error: 'kimi 凭证缺少 access_token' };
  if (cred.expires_at && cred.expires_at * 1000 <= Date.now()) {
    return { ok: false, error: 'kimi 凭证已过期，请在本机运行一次 kimi 刷新' };
  }
  const res = await fetchImpl('https://api.kimi.com/coding/v1/usages', {
    headers: { authorization: `Bearer ${cred.access_token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { ok: false, error: `kimi 用量接口 HTTP ${res.status}` };
  const j = await res.json();
  const win = j.limits?.[0]?.detail;
  const wallet = j.boosterWallet?.balance;
  return {
    ok: true,
    plan: j.user?.membership?.level ?? null,
    weekly: j.usage ? {
      limit: Number(j.usage.limit), used: Number(j.usage.used),
      remaining: Number(j.usage.remaining), reset_time: j.usage.resetTime,
    } : null,
    window: win ? {
      minutes: (j.limits[0].window?.duration ?? 300),
      limit: Number(win.limit), used: Number(win.used), remaining: Number(win.remaining),
      reset_time: win.resetTime ?? null,
    } : null,
    // boosterWallet 金额单位是纳元（1e9 = ¥1）
    extra_balance: wallet?.amountLeft != null ? Math.round(Number(wallet.amountLeft) / 1e7) / 100 : null,
  };
}

async function qCodex({ home, fetchImpl }) {
  const provider = readCodexProvider(join(home, '.codex', 'config.toml'));
  let key = null;
  try { key = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY; } catch { /* 无 auth.json */ }
  if (!key) return { ok: false, error: 'codex 未使用 API key 登录（ChatGPT 登录暂无额度接口）' };
  if (!provider) return { ok: false, error: '未在 ~/.codex/config.toml 找到 provider base_url' };
  // OpenAI 标准计费端点；第三方中转站大多没有，404 就报不支持
  for (const p of ['/v1/dashboard/billing/subscription', '/v1/dashboard/billing/credit_grants']) {
    const res = await fetchImpl(`${provider.baseUrl}${p}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) continue;
    if (!res.ok) return { ok: false, error: `codex 计费接口 HTTP ${res.status}` };
    const j = await res.json();
    if (j.total_available != null) return { ok: true, balance: String(j.total_available), currency: 'USD', provider: provider.name };
    if (j.hard_limit_usd != null) return { ok: true, balance: String(j.hard_limit_usd), currency: 'USD（限额）', provider: provider.name };
    return { ok: false, error: '计费接口返回无法解析' };
  }
  return { ok: false, error: `provider「${provider.name}」未提供标准余额接口` };
}

const safe = (fn) => async (ctx) => {
  try { return await fn(ctx); } catch (err) { return { ok: false, error: err.message }; }
};

export function createQuota({ fetchImpl = fetch, home = homedir(), cacheMs = 60_000 } = {}) {
  const ctx = { home, fetchImpl };
  const query = { deepseek: safe(qDeepseek), kimi: safe(qKimi), codex: safe(qCodex) };
  let cache = null;
  let cacheAt = 0;
  async function get({ refresh = false } = {}) {
    if (!refresh && cache && Date.now() - cacheAt < cacheMs) return cache;
    const [deepseek, kimi, codex] = await Promise.all([
      query.deepseek(ctx), query.kimi(ctx), query.codex(ctx),
    ]);
    cache = { fetched_at: new Date().toISOString(), deepseek, kimi, codex };
    cacheAt = Date.now();
    return cache;
  }
  return { get };
}
