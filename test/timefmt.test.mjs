// public/timefmt.js 单元测试：接口返回的 UTC 时间按本机/指定时区渲染（+8 换算 + 容错）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtDateTime, fmtClock } from '../public/timefmt.js';

const CST = 480; // 东八区

test('fmtDateTime：UTC 时刻按 +8 换算成北京时间（含跨天/跨年）', () => {
  assert.equal(fmtDateTime('2026-09-11T02:30:00Z', CST), '09-11 10:30');
  assert.equal(fmtDateTime('2026-09-10T20:00:00.000Z', CST), '09-11 04:00');
  assert.equal(fmtDateTime('2026-12-31T16:00:00Z', CST), '01-01 00:00');
  // kimi 接口实测返回 6 位小数秒，同样要能解析
  assert.equal(fmtDateTime('2026-09-11T01:04:00.675475Z', CST), '09-11 09:04');
  // 不再出现「原样截 UTC」的旧行为
  assert.notEqual(fmtDateTime('2026-09-11T02:30:00Z', CST), '09-11 02:30');
});

test('fmtClock：更新时刻按 +8 换算且带秒', () => {
  assert.equal(fmtClock('2026-09-11T02:30:05Z', CST), '10:30:05');
  assert.equal(fmtClock('2026-09-10T20:00:00Z', CST), '04:00:00');
});

test('省略 offsetMinutes 时按本机时区换算（前端默认路径）', () => {
  const iso = '2026-09-11T02:30:00Z';
  const dt = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const expected = `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  assert.equal(fmtDateTime(iso), expected);
  // 本机不是 UTC 时必须与 UTC 字面量不同（证明真的做了时区换算）
  if (dt.getTimezoneOffset() !== 0) assert.notEqual(fmtDateTime(iso), '09-11 02:30');
});

test('容错：null/空串/非法串/非字符串一律返回空串，不抛错、不出 NaN', () => {
  for (const bad of [null, undefined, '', 'not-a-date', 'x', 123, {}, []]) {
    assert.equal(fmtDateTime(bad), '');
    assert.equal(fmtClock(bad), '');
  }
});
