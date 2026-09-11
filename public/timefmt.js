// 前端时间显示：接口返回的都是 UTC 的 ISO 串（如 2026-09-11T02:30:00Z），
// 直接截字符串展示等于把 UTC 当本地时间，比北京时间少 8 小时。
// 这里统一换算到目标时区再渲染（默认本机时区，可显式传 offsetMinutes 便于测试）。
const pad2 = (n) => String(n).padStart(2, '0');

// getTimezoneOffset 是反向的（UTC = 本地 + offset），所以取负得到东八区的 480
const offsetOf = (ms, offsetMinutes) => (
  Number.isFinite(offsetMinutes) ? offsetMinutes : -new Date(ms).getTimezoneOffset()
);

function parse(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// 把 UTC 时刻平移 offset 分钟后按 UTC 字段读出来 = 该时区的墙上时间
function shifted(iso, offsetMinutes) {
  const ms = parse(iso);
  if (ms === null) return null;
  return new Date(ms + offsetOf(ms, offsetMinutes) * 60000);
}

// '2026-09-11T02:30:00Z' + 480 → '09-11 10:30'；空值/非法串 → ''（不崩、不出现 NaN）
export function fmtDateTime(iso, offsetMinutes) {
  const d = shifted(iso, offsetMinutes);
  return d ? `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : '';
}

// 同上，带秒：'2026-09-11T02:30:00Z' + 480 → '10:30:00'
export function fmtClock(iso, offsetMinutes) {
  const d = shifted(iso, offsetMinutes);
  return d ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` : '';
}
