// quota.mjs 单元测试：重点是 kimi 凭证过期自动刷新（createQuota 支持 home/fetchImpl 注入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuota } from '../server/quota.mjs';

function makeHome(cred) {
  const home = mkdtempSync(join(tmpdir(), 'quota-test-'));
  const dir = join(home, '.kimi-code', 'credentials');
  mkdirSync(dir, { recursive: true });
  if (cred) writeFileSync(join(dir, 'kimi-code.json'), JSON.stringify(cred));
  return home;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

const USAGE_JSON = { user: { membership: { level: 'pro' } }, usage: { limit: 100, used: 5, remaining: 95, resetTime: 'x' } };

// 记录调用并按 URL 分发响应的假 fetch
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const h = handlers.find((x) => url.startsWith(x.url));
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: h.ok ?? true,
      status: h.status ?? 200,
      json: async () => h.json,
    };
  };
  fn.calls = calls;
  return fn;
}

const CRED = { access_token: 'old-access', refresh_token: 'old-refresh', expires_in: 900, scope: 'kimi-code', token_type: 'Bearer' };

test('kimi 未过期：直接查用量，不发刷新请求', async () => {
  const home = makeHome({ ...CRED, expires_at: future() });
  const fetchImpl = fakeFetch([{ url: 'https://api.kimi.com/coding/v1/usages', json: USAGE_JSON }]);
  const q = createQuota({ home, fetchImpl });
  const r = await q.get();
  assert.equal(r.kimi.ok, true);
  assert.equal(r.kimi.plan, 'pro');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('auth.kimi.com')).length, 0);
  rmSync(home, { recursive: true, force: true });
});

test('kimi 过期：自动用 refresh_token 换新、回写凭证文件、用新 token 查询', async () => {
  const home = makeHome({ ...CRED, expires_at: past() });
  const fetchImpl = fakeFetch([
    { url: 'https://auth.kimi.com/api/oauth/token', json: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900, token_type: 'Bearer' } },
    { url: 'https://api.kimi.com/coding/v1/usages', json: USAGE_JSON },
  ]);
  const q = createQuota({ home, fetchImpl });
  const r = await q.get();
  assert.equal(r.kimi.ok, true);
  // 刷新请求：form 编码、grant_type/client_id/旧 refresh_token 正确
  const refresh = fetchImpl.calls.find((c) => c.url.includes('auth.kimi.com'));
  assert.equal(refresh.opts.method, 'POST');
  const body = new URLSearchParams(refresh.opts.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'old-refresh');
  assert.ok(body.get('client_id'));
  // 用量查询带新 access_token
  const usage = fetchImpl.calls.find((c) => c.url.includes('usages'));
  assert.equal(usage.opts.headers.authorization, 'Bearer new-access');
  // 凭证文件已回写：新 token、refresh_token 轮换、expires_at 在未来
  const saved = JSON.parse(readFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), 'utf8'));
  assert.equal(saved.access_token, 'new-access');
  assert.equal(saved.refresh_token, 'new-refresh');
  assert.ok(saved.expires_at * 1000 > Date.now());
  assert.equal(saved.scope, 'kimi-code'); // 原有字段保留
  rmSync(home, { recursive: true, force: true });
});

test('kimi 过期 + refresh 响应缺 refresh_token：保留旧 refresh_token', async () => {
  const home = makeHome({ ...CRED, expires_at: past() });
  const fetchImpl = fakeFetch([
    { url: 'https://auth.kimi.com/api/oauth/token', json: { access_token: 'new-access', expires_in: 900 } },
    { url: 'https://api.kimi.com/coding/v1/usages', json: USAGE_JSON },
  ]);
  const r = await createQuota({ home, fetchImpl }).get();
  assert.equal(r.kimi.ok, true);
  const saved = JSON.parse(readFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), 'utf8'));
  assert.equal(saved.refresh_token, 'old-refresh');
  rmSync(home, { recursive: true, force: true });
});

test('kimi 过期 + 刷新被拒（401）：报过期错误，不查用量，不泄漏 token', async () => {
  const home = makeHome({ ...CRED, expires_at: past() });
  const fetchImpl = fakeFetch([{ url: 'https://auth.kimi.com/api/oauth/token', ok: false, status: 401 }]);
  const r = await createQuota({ home, fetchImpl }).get();
  assert.equal(r.kimi.ok, false);
  assert.match(r.kimi.error, /已过期/);
  assert.ok(!r.kimi.error.includes('old-refresh'));
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('usages')).length, 0);
  rmSync(home, { recursive: true, force: true });
});

test('kimi 过期 + 无 refresh_token：直接报过期，不发任何请求', async () => {
  const home = makeHome({ access_token: 'old-access', expires_at: past() });
  const fetchImpl = fakeFetch([]);
  const r = await createQuota({ home, fetchImpl }).get();
  assert.equal(r.kimi.ok, false);
  assert.match(r.kimi.error, /已过期/);
  assert.equal(fetchImpl.calls.length, 0);
  rmSync(home, { recursive: true, force: true });
});

test('kimi 过期 + 刷新成功但凭证回写失败：本次查询仍成功并带 note', async () => {
  const home = makeHome({ ...CRED, expires_at: past() });
  const credFile = join(home, '.kimi-code', 'credentials', 'kimi-code.json');
  chmodSync(credFile, 0o444); // 只读 → 回写失败
  const fetchImpl = fakeFetch([
    { url: 'https://auth.kimi.com/api/oauth/token', json: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 } },
    { url: 'https://api.kimi.com/coding/v1/usages', json: USAGE_JSON },
  ]);
  const r = await createQuota({ home, fetchImpl }).get();
  assert.equal(r.kimi.ok, true);
  assert.match(r.kimi.note ?? '', /回写失败/);
  chmodSync(credFile, 0o600);
  rmSync(home, { recursive: true, force: true });
});

test('kimi 无凭证文件 / 凭证损坏 / 缺 access_token 的报错保持原样', async () => {
  const r1 = await createQuota({ home: makeHome(null), fetchImpl: fakeFetch([]) }).get();
  assert.match(r1.kimi.error, /未找到/);
  const home2 = mkdtempSync(join(tmpdir(), 'quota-test-'));
  mkdirSync(join(home2, '.kimi-code', 'credentials'), { recursive: true });
  writeFileSync(join(home2, '.kimi-code', 'credentials', 'kimi-code.json'), '{bad json');
  const r2 = await createQuota({ home: home2, fetchImpl: fakeFetch([]) }).get();
  assert.match(r2.kimi.error, /损坏/);
  const r3 = await createQuota({ home: makeHome({ refresh_token: 'x' }), fetchImpl: fakeFetch([]) }).get();
  assert.match(r3.kimi.error, /缺少 access_token/);
  rmSync(home2, { recursive: true, force: true });
});
