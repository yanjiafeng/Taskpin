// 任务执行完成通知：向设置页配置的 Webhook（企业微信群机器人）POST 一条文本消息。
// 火后即忘：通知是旁路，发送失败/超时只打日志，绝不影响执行收尾流程
export function notifyTaskFinished(webhook, { task, agent, status, secs, tail }) {
  if (!webhook) return;
  const brief = String(tail || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const lines = [
    `任务 #${task.id}「${task.title}」执行完成`,
    `${agent} ${status}，用时 ${secs}s`,
  ];
  if (brief) lines.push(`结果摘要：${brief}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  timer.unref?.();
  fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: lines.join('\n') } }),
    signal: ctrl.signal,
  })
    .then((res) => { if (!res.ok) console.error(`[notify] webhook 响应 ${res.status}`); })
    .catch((err) => console.error(`[notify] 通知发送失败：${err.message}`))
    .finally(() => clearTimeout(timer));
}
