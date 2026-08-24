// 看板前端：项目切换、列渲染、拖拽/按钮改状态、详情抽屉、SSE 实时刷新。
const COLUMNS = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done'];
// 状态元数据：label 用于展示，desc 为列头说明文字；颜色由 CSS 按 data-col/data-status 渲染
const STATUS_META = {
  backlog: { label: '待规划', desc: '想法池 · 想清楚再排进待办' },
  todo: { label: '待办', desc: '已就绪 · Agent 从这里认领' },
  in_progress: { label: '进行中', desc: 'Agent 正在执行' },
  blocked: { label: '阻塞', desc: '卡住了 · 看评论里需要什么' },
  in_review: { label: '待验收', desc: '做完了 · 等你验收' },
  done: { label: '已完成', desc: '验收通过 · 只有你能放进这列' },
  canceled: { label: '已取消', desc: '不再执行' },
};
const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label]));
const PRIORITY_LABEL = { low: '低', normal: '普通', high: '高' };
// 与服务端 TRANSITIONS 保持一致
const TRANSITIONS = {
  backlog: ['todo', 'canceled'],
  todo: ['in_progress', 'backlog', 'canceled'],
  in_progress: ['in_review', 'blocked', 'todo', 'backlog', 'canceled'],
  blocked: ['in_progress', 'todo', 'canceled'],
  in_review: ['done', 'in_progress', 'todo', 'backlog', 'canceled'],
  done: ['todo', 'backlog', 'canceled'],
  canceled: [],
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// 轻量 markdown 渲染（评论正文用）：先整体转义防 XSS，再转换语法。
// 支持：围栏/行内代码、标题(# ~ ####)、无序/有序列表、**加粗**、*斜体*、[链接](http(s)://…)。
// 代码块/行内代码/链接先替换成占位符，避免被后续规则二次处理，结尾统一还原。
function md(src) {
  const raw = String(src ?? '');
  if (!raw.trim()) return esc(raw);
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0001${stash.length - 1}\u0002`; };
  let text = esc(raw);
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre class="md-code"><code>${code.replace(/\n$/, '')}</code></pre>`));
  text = text.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="md-inline">${code}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  const inline = (s) => s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 表格：| 表头 | 行 + | --- | 分隔行，后续连续的 | … | 行为数据行
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const block = line.match(/^(\u0001\d+\u0002)\s*$/);
    if (block) { closeList(); out.push(stash[+line.trim().slice(1, -1)]); continue; } // 占位符独占一行 = 代码块
    const h = line.match(/^(#{1,4})\s+(.+)/);
    if (h) { closeList(); out.push(`<div class="md-h md-h${h[1].length}">${inline(h[2])}</div>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.+)/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(line.trim() === '' ? '<div class="md-gap"></div>' : `<div>${inline(line)}</div>`);
  }
  closeList();
  return out.join('').replace(/\u0001(\d+)\u0002/g, (m, i) => stash[+i]);
}

const state = {
  projects: [],
  projectId: null, // null = 全部项目
  tasks: [],
  runs: new Map(), // taskId -> {agent, pid, started_at}
  colToggles: {}, // 移动端手风琴：col -> true=固定展开 / false=固定折叠
  showCanceled: localStorage.getItem('taskboard_canceled') === '1',
  settings: { agents: ['codex', 'kimi', 'reasonix', 'dsh'] }, // 服务端全局设置，loadSettings 覆盖
  agentOptions: null, // 各 agent 可选的思考/权限档位，loadAgentOptions 覆盖（GET /api/agent-options）
  promptDefaults: null, // 内置执行 prompt 模板（首次打开设置页时拉取）
  openTaskId: null,
  openTask: null, // 抽屉中任务详情（含 version、comments）
};

// ---------- Token 与 API ----------
function getToken() { return localStorage.getItem('taskboard_token') || ''; }

// 支持 ?token=xxx 与 #token=xxx 链接直接登录：写入 localStorage 后从地址栏抹掉
// （#token= 是分享链接格式：hash 不发给服务器，只能在这里读出；?token= 保留兼容旧链接）
(function adoptTokenFromUrl() {
  let t = new URLSearchParams(location.search).get('token');
  const hashMatch = location.hash.match(/[#&]token=([^&]+)/);
  if (!t && hashMatch) t = decodeURIComponent(hashMatch[1]);
  if (!t) return;
  localStorage.setItem('taskboard_token', t.trim());
  const url = new URL(location.href);
  url.searchParams.delete('token');
  if (hashMatch) {
    // 从 hash 中抹掉 token 参数，保留其余片段；抹完只剩 "#" 则清空
    const clean = url.hash.replace(/#token=[^&]*&?/, '#').replace(/&token=[^&]*/, '');
    url.hash = clean === '#' ? '' : clean;
  }
  history.replaceState(null, '', url);
})();

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    const t = await promptDlg('需要访问 Token（服务端 TASKBOARD_TOKEN）：', token);
    if (t !== null) {
      localStorage.setItem('taskboard_token', t.trim());
      return api(path, { method, body });
    }
    throw new Error('未授权');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 (${res.status})`);
    err.code = data?.error?.code;
    err.current = data?.error?.current;
    throw err;
  }
  return data;
}

// type: 'info'（默认，中性深色）| 'error'（红色，仅真正的错误用，避免普通提示被误读成报错）
function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.toggle('error', type === 'error');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// 操作按钮防重复点击/抖动：请求期间禁用 + loading 动画，结束后恢复
async function withLoading(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('loading');
  try { await fn(); } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// ---------- 自定义确认/输入对话框（替代原生 confirm/prompt，移动端风格统一） ----------
// confirm 语义 resolve(true/false)；带 input 时 resolve(输入串/null)
function showDialog({ message, okText = '确定', danger = false, input = null }) {
  return new Promise((resolve) => {
    const bd = $('#dlg-backdrop');
    const inputEl = $('#dlg-input');
    const okBtn = $('#dlg-ok');
    const cancelBtn = $('#dlg-cancel');
    const useInput = input !== null;
    $('#dlg-msg').textContent = message;
    okBtn.textContent = okText;
    okBtn.classList.toggle('danger', danger);
    inputEl.classList.toggle('hidden', !useInput);
    if (useInput) inputEl.value = input.value ?? '';
    const cleanup = (val) => {
      bd.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      okBtn.onclick = cancelBtn.onclick = null;
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(useInput ? null : false);
      else if (e.key === 'Enter' && useInput && document.activeElement === inputEl) cleanup(inputEl.value);
    };
    okBtn.onclick = () => cleanup(useInput ? inputEl.value : true);
    cancelBtn.onclick = () => cleanup(useInput ? null : false);
    // 注意：点击背板不关闭（防止误触丢失选择），只能点按钮或 Esc
    document.addEventListener('keydown', onKey);
    bd.classList.remove('hidden');
    setTimeout(() => (useInput ? inputEl : okBtn).focus(), 50);
  });
}
const confirmDlg = (message, opts = {}) => showDialog({ ...opts, message });
const promptDlg = (message, value = '') => showDialog({ message, input: { value } });

// ---------- 数据加载 ----------
async function loadSettings() {
  state.settings = await api('/api/settings');
  syncAgentToggles();
}

// 各 agent 的模型/思考/权限清单由后端统一下发（GET /api/agent-options，读各家 CLI 本地配置）；
// 拉取失败（如旧版服务进程没这个接口）时用 AGENT_OPTIONS_FALLBACK 兜底，保证选项行不消失
async function loadAgentOptions() {
  state.agentOptions = await api('/api/agent-options');
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  if (state.projectId != null && !state.projects.some((p) => p.id === state.projectId)) {
    state.projectId = null; // 项目被删则回退到「全部」
  }
  renderProjectSelect();
  renderSettingsProjects();
  await loadTasks();
}

async function loadTasks() {
  const qs = state.projectId == null ? '' : `project_id=${state.projectId}&`;
  const [tasks, runs] = await Promise.all([
    api(`/api/tasks?${qs}include_canceled=1`),
    api('/api/runs'),
  ]);
  state.tasks = tasks;
  state.runs = new Map(runs.map((r) => [r.task_id, r]));
  renderBoard();
  scheduleRunsPoll();
  if (state.openTaskId != null) await refreshDrawer();
}

// 变更重载统一入口：SSE 广播与本地操作成功后的显式刷新都走这里，300ms 内合并为一次
// loadTasks——否则同一次变更（发评论/启动执行等）会被 SSE 和操作处理器各渲染一遍，
// renderBoard 是整板 innerHTML 重建，两遍连着来就是肉眼可见的「闪一下」
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadTasks().catch((err) => toast(err.message, 'error'));
  }, 300);
}

// 有任务在执行时，每 3s 轮询运行状态；集合有变化（开始/完结）才整板重渲，
// 没变化只就地刷新用时文字——避免重建 DOM 把卡片的 CSS 动画（缝线/吊牌）打断重启
let runsTimer = null;
function scheduleRunsPoll() {
  if (state.runs.size > 0) {
    if (!runsTimer) runsTimer = setInterval(refreshRuns, 3000);
  } else if (runsTimer) {
    clearInterval(runsTimer);
    runsTimer = null;
  }
}

function runsSignature(runs) {
  return [...runs.values()].map((r) => `${r.task_id}:${r.agent}:${r.started_at}`).sort().join('|');
}

// 只更新卡片上的「agent 名 + 用时」文字，不动 DOM 结构（计时器是本地推算的近似值，
// 任务完结触发整板重渲时自然刷新，见 refreshRuns）
function tickRunElapsed() {
  document.querySelectorAll('.run-agent-name[data-started]').forEach((el) => {
    el.textContent = `${el.dataset.agent} ${fmtElapsed(el.dataset.started)}`;
  });
}

async function refreshRuns() {
  try {
    const runs = await api('/api/runs');
    const next = new Map(runs.map((r) => [r.task_id, r]));
    const changed = runsSignature(next) !== runsSignature(state.runs);
    state.runs = next;
    if (changed) renderBoard();
    else tickRunElapsed();
    scheduleRunsPoll();
  } catch { /* 忽略瞬时网络错误，下轮再试 */ }
}

// ---------- 渲染 ----------
function visibleTasks(status) {
  return state.tasks.filter((t) => t.status === status);
}

function renderProjectSelect() {
  const sel = $('#project-select');
  sel.innerHTML = `<option value="all"${state.projectId == null ? ' selected' : ''}>全部项目</option>`
    + state.projects.map((p) => (
      `<option value="${p.id}"${p.id === state.projectId ? ' selected' : ''}>${esc(p.name)}</option>`
    )).join('');
}

function fmtElapsed(startedAt) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

// ISO（UTC）时间串 → 本地时区 'YYYY-MM-DD HH:mm'（任务详情/评论展示用，非法值原样返回）
function fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 每张卡片一个确定性的伪随机倾斜角（按任务 id 取哈希，重渲时角度不跳变）
function cardTilt(id) {
  const h = (Math.imul(Number(id) || 0, 2654435761) >>> 0) % 1000;
  return ((h / 1000) * 5.6 - 2.8).toFixed(2); // -2.8° ~ +2.8°
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function cardHtml(t) {
  const comments = t.comment_count ? `💬 ${t.comment_count}` : '';
  const run = state.runs.get(t.id);
  // 执行中样式只认任务状态：状态已离开「进行中」的（提问进阻塞/已交付等），
  // 即使进程尚未退出也不再闪——残留的 run 只保留一个停止入口（防进程挂死时无法杀）
  const live = Boolean(run) && t.status === 'in_progress';
  // 停在「进行中」但没有活跃 run：执行中断/失联的残留态（服务端会自动回收回「待规划」，
  // 此处先给个可见标记，避免它伪装成普通卡片）
  const orphan = t.status === 'in_progress' && !run;
  const proj = state.projects.find((p) => p.id === t.project_id);
  const projBadge = proj ? `<span class="proj-badge">${esc(proj.name)}</span>` : '';
  // 上次执行异常退出的告警标记（新执行/正常结束由服务端清除）
  let failBadge = '';
  if (t.last_run && !live) {
    try {
      const lr = JSON.parse(t.last_run);
      if (lr && lr.code !== 0) {
        failBadge = `<span class="fail-tag" title="上次 ${esc(lr.agent || '')} 执行异常退出${lr.code != null ? `（码 ${lr.code}）` : ''}${lr.error ? `：${esc(lr.error)}` : ''}">⚠ 异常退出</span>`;
      }
    } catch { /* 坏值忽略 */ }
  }
  // 上一次执行选用的 agent + 模型/思考/权限摘要（tasks.exec_opts，按任务记忆，执行开始时由服务端写入）
  let execTag = '';
  if (t.exec_opts && !live) {
    try {
      const eo = JSON.parse(t.exec_opts);
      if (eo && eo.agent) {
        const parts = [eo.agent, eo.model, eo.effort, eo.permission].filter(Boolean);
        execTag = `<span class="exec-tag" title="上次执行：${esc(parts.join(' · '))}">⚙ ${esc(parts.join(' · '))}</span>`;
      }
    } catch { /* 坏值忽略 */ }
  }
  // 卡片级执行/删除按钮已移除（操作集中在任务详情抽屉）；
  // 仅保留：执行中卡片的 agent 名（点开输出弹框）与停止按钮，以及进程残留时的停止入口（防进程挂死时无法杀）
  const runBtn = live
    ? `<button class="run-agent-name run-open" data-output="${t.id}" data-agent="${esc(run.agent)}" data-started="${esc(run.started_at)}" title="点击查看实时输出">${run.agent} ${fmtElapsed(run.started_at)}</button><button class="run-btn running" data-stop="${t.id}" title="停止 ${run.agent}"><span class="stop-ic"></span></button>`
    : run
      ? `<button class="run-btn" data-stop="${t.id}" title="进程尚未退出（任务已「${STATUS_META[t.status].label}」），点击停止 ${run.agent}"><span class="stop-ic"></span></button>`
      : '';
  return `
    <div class="card${live ? ' running' : ''}${failBadge ? ' run-failed' : ''}" draggable="true" data-id="${t.id}" style="--rot:${cardTilt(t.id)}deg">
      ${live ? '<span class="hang-tag">执行中</span>' : ''}
      ${orphan ? '<span class="orphan-tag" title="任务停在「进行中」但没有活跃执行进程（执行中断/失联），将自动收回「待规划」">⚠ 执行中断</span>' : ''}
      <div class="title-row">
        <span class="prio ${esc(t.priority)}" title="优先级：${PRIORITY_LABEL[t.priority] || t.priority}"></span>
        <span class="title">${esc(t.title)}</span>
      </div>
      <div class="meta"><span>#${t.id}</span>${projBadge}${comments ? `<span>${comments}</span>` : ''}${execTag}${failBadge}${runBtn}</div>
    </div>`;
}

function renderBoard() {
  const board = $('#board');
  const cols = state.showCanceled ? [...COLUMNS, 'canceled'] : COLUMNS;
  board.innerHTML = cols.map((s) => {
    const tasks = visibleTasks(s);
    return `
      <section class="column" data-col="${s}">
        <div class="column-header">
          <div class="col-main">
            <span class="chev">▾</span>
            <span class="name">${STATUS_META[s].label}</span>
            <span class="count">${tasks.length}</span>
            ${s === 'backlog' || s === 'todo' ? '<button class="add" title="新建任务">＋</button>' : ''}
            ${s === 'canceled' ? '<button class="add clear-canceled" title="删除全部已取消任务">🗑</button>' : ''}
          </div>
          <div class="column-caption">${STATUS_META[s].desc}</div>
        </div>
        <div class="column-list" data-col="${s}">${tasks.map(cardHtml).join('') || '<div class="empty-hint">暂无任务</div>'}</div>
      </section>`;
  }).join('');

  board.querySelectorAll('.column-header .add').forEach((btn) => {
    btn.onclick = () => openTaskForm(btn.closest('.column').dataset.col);
  });
  // 移动端手风琴：空列默认折叠，点列头切换；用户手动选择后固定
  board.querySelectorAll('.column').forEach((col) => {
    const s = col.dataset.col;
    const pinned = state.colToggles[s];
    const collapsed = pinned !== undefined ? !pinned : visibleTasks(s).length === 0;
    if (matchMedia('(max-width: 768px)').matches && collapsed) col.classList.add('collapsed');
    col.querySelector('.column-header').addEventListener('click', (e) => {
      if (e.target.closest('.add')) return;
      if (!matchMedia('(max-width: 768px)').matches) return;
      state.colToggles[s] = col.classList.toggle('collapsed') ? false : true;
    });
  });
  board.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDrawer(Number(card.dataset.id));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  // 执行中卡片：点 agent 名/用时弹框看实时输出
  board.querySelectorAll('[data-output]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openOutputView(Number(btn.dataset.output));
    };
  });
  // 批量删除当前视图下全部已取消任务
  board.querySelectorAll('.clear-canceled').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const ids = visibleTasks('canceled').map((t) => t.id);
      if (!ids.length) return;
      if (!(await confirmDlg(`确定删除当前视图下 ${ids.length} 个已取消任务？此操作不可恢复`, { okText: '全部删除', danger: true }))) return;
      withLoading(btn, async () => {
        try {
          await api('/api/tasks/batch-delete', { method: 'POST', body: { ids } });
          toast(`已删除 ${ids.length} 个任务`);
          scheduleReload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    };
  });
  board.querySelectorAll('[data-stop]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmDlg('停止正在执行的 Agent？', { okText: '停止', danger: true }))) return;
      withLoading(btn, async () => {
        try {
          await api(`/api/tasks/${btn.dataset.stop}/run`, { method: 'DELETE' });
          toast('已发送停止信号');
          scheduleReload();
        } catch (err) {
          toast(err.message, 'error');
          scheduleReload();
        }
      });
    };
  });
  board.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!col.classList.contains('drag-over')) col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', (e) => {
      // 进入子元素也会触发 dragleave，只有真正离开整列才取消高亮
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const task = state.tasks.find((t) => t.id === id);
      const target = col.dataset.col;
      if (!task || task.status === target) return;
      // 「进行中」由执行自动认领：手动拖入会产生「in_progress 但无活跃 run」的残留任务
      // （卡片没有执行中样式却停在进行中列），直接拦下并提示走「执行」
      if (target === 'in_progress') {
        toast('「进行中」由执行自动认领：请打开任务点「执行」按钮');
        return;
      }
      await moveTask(task, target);
    });
  });
}

async function moveTask(task, target) {
  const oldStatus = task.status;
  task.status = target; // 乐观更新，立即渲染
  renderBoard();
  try {
    const updated = await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: { version: task.version, status: target, by: 'user' },
    });
    Object.assign(task, updated); // 对齐 version 等字段；SSE 会再做全量对齐
  } catch (err) {
    task.status = oldStatus;
    renderBoard();
    toast(err.message, 'error');
    scheduleReload();
  }
}

// ---------- 详情抽屉 ----------
async function openDrawer(id) {
  state.openTaskId = id;
  // 立即打开抽屉并显示图钉加载动画，避免点击卡片后「卡一下」的空白等待
  $('#drawer').innerHTML =
    '<div class="drawer-loading"><div class="load-note"></div><div class="load-text">正在打开任务…</div></div>';
  $('#drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  await refreshDrawer();
}

function closeDrawer() {
  state.openTaskId = null;
  state.openTask = null;
  pendingImages = []; // 未发送的附图随抽屉关闭丢弃
  $('#drawer').innerHTML = ''; // 同时丢弃残留输入，避免污染下一个打开的任务（见 openDrawer）
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
}

// ---------- 图片灯箱（评论附图页面内查看） ----------
function openLightbox(src) {
  $('#lightbox img').src = src;
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox img').removeAttribute('src');
}

async function refreshDrawer() {
  try {
    state.openTask = await api(`/api/tasks/${state.openTaskId}`);
  } catch {
    closeDrawer();
    return;
  }
  renderDrawer();
}

// ---------- 评论图片附件（粘贴/选择，最多 6 张，单张 ≤8MB） ----------
let pendingImages = []; // [{name, data(dataURL)}]，模块级：SSE 重渲染抽屉时不丢
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function tokenQS() {
  const t = getToken();
  return t ? `?token=${encodeURIComponent(t)}` : '';
}

function addPendingImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (pendingImages.length >= MAX_IMAGES) { toast(`最多 ${MAX_IMAGES} 张图片`); break; }
    if (f.size > MAX_IMAGE_BYTES) { toast(`「${f.name || '粘贴的图片'}」超过 8MB，已跳过`); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImages.push({ name: f.name || `pasted-${Date.now()}.png`, data: reader.result });
      renderPendingStrip();
    };
    reader.readAsDataURL(f);
  }
}

function renderPendingStrip() {
  const strip = $('#img-strip');
  if (!strip) return;
  strip.classList.toggle('hidden', pendingImages.length === 0);
  strip.innerHTML = pendingImages.map((img, i) => `
    <span class="img-thumb">
      <img src="${img.data}" alt="${esc(img.name)}">
      <button type="button" class="img-del" data-img-del="${i}" title="移除">×</button>
    </span>`).join('');
  strip.querySelectorAll('[data-img-del]').forEach((btn) => {
    btn.onclick = () => { pendingImages.splice(Number(btn.dataset.imgDel), 1); renderPendingStrip(); };
  });
}

// 执行输出弹框：从任务卡片上点开，3s 轮询全量输出缓冲，自动滚底（用户上翻则不打扰）
let outputTaskId = null;
let outputTimer = null;
let outputStick = true;

// reasonix 输出是 stream-json 事件流（v1.25.0 实测）：message（agent 完整发言）、
// tool_dispatch（带 args 且非 partial/refreshed = 工具调用开始）、tool_result（工具结果，
// 含 output/durationMs）、末尾 {"type":"result"} 结果行。reasoning/text 增量块、turn_*、
// stream_attempt、usage、tool_progress 等只作过程心跳，不展示；
// stdout/stderr 混刷的 warning:/INFO 日志（同一条会重复多次）照常滤掉
const RX_NOISE = /^(warning: |\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (INFO|WARN|WARNING|ERROR|DEBUG)\b)/;

// tool.args 是 JSON 字符串：提取最典型的参数（命令/路径），提取不了就截断原文
function rxToolArgs(tool) {
  let args = tool.args;
  if (typeof args === 'string') {
    try {
      const p = JSON.parse(args);
      args = p.command ?? p.file_path ?? p.path ?? p.url ?? p.pattern ?? args;
    } catch { /* 半截 JSON 直接截断 */ }
  }
  args = String(args ?? '').replace(/\s+/g, ' ').trim();
  return args.length > 120 ? `${args.slice(0, 120)}…` : args;
}

// dsh 结束时会把最终答复再打一遍 stdout，与进度上报的最后一条发言同文且相邻，去掉尾部重复块
function dedupeDshTail(lines) {
  const n = lines.length;
  for (let k = Math.floor(n / 2); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (lines[n - k + i] !== lines[n - 2 * k + i]) { same = false; break; }
    }
    if (same) return lines.slice(0, n - k);
  }
  return lines;
}

function formatRunOutput(agent, raw) {
  const lines = stripAnsi(raw).split('\n');
  if (agent === 'dsh') return dedupeDshTail(lines).join('\n').trim();
  if (agent !== 'reasonix') return lines.join('\n').trim();
  const out = [];
  for (const l of lines) {
    let text = null;
    if (l.startsWith('{')) {
      try {
        const j = JSON.parse(l);
        if (j.type === 'result') {
          // 末尾结果行与最后一条 message 通常同文，避免重复显示
          const r = j.result ?? null;
          text = r && out[out.length - 1]?.text !== r ? r : null;
        }
        else if (j.kind === 'message') text = typeof j.text === 'string' ? j.text : null;
        else if (j.kind === 'tool_dispatch') {
          const t = j.tool;
          if (t?.name && t.args != null && !t.partial && !t.refreshed) text = `▸ ${t.name} ${rxToolArgs(t)}`;
        } else if (j.kind === 'tool_result') {
          const t = j.tool;
          if (t?.name) {
            let o = typeof t.output === 'string' ? t.output.replace(/\s+/g, ' ').trim() : '';
            if (o.length > 200) o = `${o.slice(0, 200)}…`;
            text = `✓ ${t.name}${t.durationMs != null ? `（${t.durationMs}ms）` : ''}${o ? ` ${o}` : ''}`;
          }
        }
        // 其余事件 kind 不展示
      } catch { /* 截断的半行 JSON，按噪音丢弃 */ }
      if (text === null) continue; // 未识别的 JSON 事件行（对象字段不可读），丢弃
    }
    if (text === null) {
      if (RX_NOISE.test(l)) continue;
      text = l;
    }
    if (!text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.text === text) last.n++;
    else out.push({ text, n: 1 });
  }
  return out.map((e) => (e.n > 1 ? `${e.text}（×${e.n}）` : e.text)).join('\n').trim();
}

async function refreshOutputView() {
  if (outputTaskId == null) return;
  const taskId = outputTaskId;
  const run = state.runs.get(taskId);
  let output = run?.output_tail || '';
  try {
    const d = await api(`/api/tasks/${taskId}/run/output`);
    output = d.output || output;
  } catch {
    // 进程刚好退出：接口 404，用 runs 列表尾部兜底；连 runs 都没有就是已结束
    if (!run) {
      $('#output-term').textContent = '执行已结束。';
      clearInterval(outputTimer);
      outputTimer = null;
      return;
    }
  }
  if (outputTaskId !== taskId) return; // 等待期间弹框已关闭/切换
  const term = $('#output-term');
  term.textContent = formatRunOutput(run?.agent, output) || '运行中，暂无可显示输出…';
  if (outputStick) term.scrollTop = term.scrollHeight;
}

function openOutputView(taskId) {
  const run = state.runs.get(taskId);
  outputTaskId = taskId;
  outputStick = true;
  $('#output-title').textContent = `任务 #${taskId} 执行输出${run ? ` · ${run.agent}${run.mode ? ` (${run.mode})` : ''} ${fmtElapsed(run.started_at)}` : ''}`;
  $('#output-backdrop').classList.remove('hidden');
  refreshOutputView();
  clearInterval(outputTimer);
  outputTimer = setInterval(refreshOutputView, 3000);
}

function closeOutputView() {
  outputTaskId = null;
  clearInterval(outputTimer);
  outputTimer = null;
  $('#output-backdrop').classList.add('hidden');
}

function renderDrawer() {
  const t = state.openTask;
  if (!t) return;
  // 保留未提交的输入：SSE/轮询触发 renderDrawer 会重建 innerHTML，
  // 不抢救草稿的话，用户正在打的评论/答复/标题/描述会被清空
  const draftIds = ['d-comment', 'd-reply', 'd-title', 'd-desc', 'd-priority'];
  const drafts = {};
  for (const id of draftIds) {
    const el = document.getElementById(id);
    if (el) drafts[id] = el.value;
  }
  const focusedId = document.activeElement?.id;
  const sel = focusedId && draftIds.includes(focusedId)
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
    : null;
  const targets = TRANSITIONS[t.status] || [];
  const moveBtns = targets.filter((s) => s !== 'done').map((s) => (
    `<button class="btn" data-move="${s}" data-target="${s}">移到「${STATUS_META[s].label}」</button>`
  )).join('');
  const acceptBtn = targets.includes('done')
    ? '<button class="btn accept-btn" data-accept="1">✓ 验收完成</button>' : '';
  // 已取消任务的删除入口（替代原卡片上的 × 按钮）
  const delBtn = t.status === 'canceled'
    ? '<button class="btn danger" id="d-del">🗑 删除任务</button>' : '';
  // 执行/停止入口（与卡片按钮同一套逻辑）：终态不显示；放在评论输入区，发布评论后顺手点
  const drawerRun = state.runs.get(t.id);
  const runCtl = drawerRun
    ? '<button class="btn danger" id="d-stop">■ 停止执行</button>'
    : (!['done', 'canceled'].includes(t.status)
        ? '<button class="btn primary" id="d-exec">▶ 执行 / 问答</button>' : '');

  const commentHtml = (c) => {
    const isQuestion = c.author === 'agent' && c.body.trimStart().startsWith('[提问]');
    const imgs = (c.images || []).map((img) => {
      const src = `/api/attachments/${img}${tokenQS()}`;
      return `<img class="comment-img" src="${src}" alt="附图" loading="lazy">`;
    }).join('');
    return `
    <div class="comment${isQuestion ? ' question' : ''}${c.author === 'user' ? ' from-user' : ''}">
      <div class="who"><span class="author ${esc(c.author)}">${c.author === 'agent' ? 'Agent' : '用户'}</span>${isQuestion ? '<span class="q-badge">等你答复</span>' : ''}<span>${esc(fmtLocal(c.created_at))}</span></div>
      <div class="body">${md(c.body)}</div>
      ${imgs ? `<div class="comment-imgs">${imgs}</div>` : ''}
    </div>`;
  };

  // 最新一轮：最后一次用户输入到最后的 Agent 回答（还没有用户评论时取最后一条）
  const lastUserIdx = t.comments.reduce((acc, c, i) => (c.author === 'user' ? i : acc), -1);
  const roundStart = lastUserIdx >= 0 ? lastUserIdx : Math.max(0, t.comments.length - 1);
  const latestRound = t.comments.slice(roundStart);
  const history = t.comments.slice(0, roundStart);
  // 未答复的 [提问]：最后一条 agent 提问之后没有用户评论、当前无运行会话、非终态
  const lastQIdx = t.comments.reduce((acc, c, i) => (
    c.author === 'agent' && c.body.trimStart().startsWith('[提问]') ? i : acc
  ), -1);
  const showReply = lastQIdx >= 0
    && !t.comments.slice(lastQIdx + 1).some((c) => c.author === 'user')
    && !state.runs.get(t.id)
    && !['done', 'canceled'].includes(t.status);
  // 问答成对：答复框直接跟在 [提问] 评论下方（而非底部输入区），问与答视觉上同一串
  const replyFormHtml = showReply ? `
    <form id="reply-form" class="reply-box inline">
      <label>↩ 答复这个提问（提交后自动续跑会话）</label>
      <textarea id="d-reply" rows="3" placeholder="输入你的答复…"></textarea>
      <button type="submit" class="btn primary">提交并继续</button>
    </form>` : '';
  const renderRange = (list, offset) => list.map((c, j) => (
    commentHtml(c) + (offset + j === lastQIdx ? replyFormHtml : '')
  )).join('');
  const commentsHtml = t.comments.length
    ? `<div class="latest-round"><div class="lr-tag">◆ 最新一轮</div>${renderRange(latestRound, roundStart)}</div>
       ${history.length ? `<div class="d-sec">更早的评论 · ${history.length}</div>${renderRange(history, 0)}` : ''}`
    : '<div style="color:var(--text-dim)">暂无评论</div>';

  // 上下文大小：优先用最近执行从 agent 输出解析到的会话用量（tasks.usage，codex/reasonix 有，kimi 无）；
  // 没有则用任务内容（描述+全部评论）粗估。两种都标注统计来源；数值以 k 为单位（<1000 原样）。
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const usage = (() => { try { return t.usage ? JSON.parse(t.usage) : null; } catch { return null; } })();
  const contextLine = usage && Number.isFinite(usage.tokens)
    ? `上下文：~${fmtK(usage.tokens)} tokens（来源：${usage.agent || 'agent'} 会话输出）`
    : (() => {
        const chars = (t.description || '').length + t.comments.reduce((n, c) => n + c.body.length, 0);
        return chars
          ? `上下文：${fmtK(chars)} 字符 ≈ ${fmtK(Math.ceil(chars / 2))} tokens（来源：任务描述+评论，估算）`
          : '上下文：0（任务描述+评论为空）';
      })();

  // 最近一次执行选用的 agent + 模型/思考/权限（tasks.exec_opts，按任务记忆）
  const execOpts = (() => { try { return t.exec_opts ? JSON.parse(t.exec_opts) : null; } catch { return null; } })();
  const execLine = execOpts?.agent
    ? `最近执行：${[execOpts.agent, execOpts.model, execOpts.effort, execOpts.permission].filter(Boolean).join(' · ')}${execOpts.at ? `（${fmtLocal(execOpts.at)}）` : ''}`
    : '';

  // 布局：左侧属性栏 + 右侧评论流（demo C 选定方向）；执行输出不在详情里，走卡片上的弹框
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <span class="id">#${t.id}</span>
      <span class="d-head-title">${esc(t.title)}</span>
      <span class="status-name" data-status="${t.status}">${STATUS_META[t.status].label}</span>
      <button class="close" title="关闭">×</button>
    </div>
    <div class="d-cols">
      <div class="d-props">
        <div class="d-sec">属性</div>
        <label>标题</label>
        <input id="d-title" value="${esc(t.title)}" maxlength="200">
        <label>描述</label>
        <textarea id="d-desc" rows="8">${esc(t.description)}</textarea>
        <label>优先级</label>
        <select id="d-priority">
          ${Object.entries(PRIORITY_LABEL).map(([k, v]) => `<option value="${k}"${k === t.priority ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
        <div class="row"><button class="btn primary" id="d-save">保存修改</button></div>
        <div class="d-sec">状态操作</div>
        <div class="row status-actions">${moveBtns || '<span style="color:var(--text-dim)">终态，无可用操作</span>'}</div>
        ${acceptBtn}
        ${delBtn}
        <div class="version-info">version ${t.version}${t.thread_id ? ` · thread ${esc(t.thread_id)}` : ''} · 更新于 ${esc(fmtLocal(t.updated_at))}</div>
        ${execLine ? `<div class="version-info">${esc(execLine)}</div>` : ''}
        <div class="version-info">${esc(contextLine)}</div>
      </div>
      <div class="d-comments-col">
        <div class="d-comments-scroll">${commentsHtml}</div>
        <div class="d-composer">
          <form id="comment-form">
            <textarea id="d-comment" rows="4" placeholder="写评论…（验收意见、补充说明；可直接粘贴截图）"></textarea>
            <div id="img-strip" class="img-strip hidden"></div>
            <div class="row comment-actions">
              <button type="button" class="btn ghost" id="img-btn" title="添加图片（也可直接粘贴）">📎</button>
              <input type="file" id="img-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
              <button type="submit" class="btn primary">发表评论</button>
              ${runCtl}
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  // 恢复草稿与焦点（渲染前抢救的）
  for (const [id, v] of Object.entries(drafts)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) {
      el.focus();
      if (sel && el.setSelectionRange) {
        try { el.setSelectionRange(sel[0], sel[1]); } catch { /* number 等类型不支持，忽略 */ }
      }
    }
  }

  $('#drawer .close').onclick = closeDrawer;
  // 评论附图：页面内灯箱查看（不开新页）
  $('#drawer').querySelectorAll('.comment-img').forEach((img) => {
    img.onclick = () => openLightbox(img.src);
  });
  $('#d-save').onclick = () => withLoading($('#d-save'), async () => {
    try {
      const updated = await api(`/api/tasks/${t.id}`, {
        method: 'PATCH',
        body: {
          version: t.version,
          title: $('#d-title').value.trim(),
          description: $('#d-desc').value,
          priority: $('#d-priority').value,
          by: 'user',
        },
      });
      state.openTask = { ...state.openTask, ...updated };
      toast('已保存');
      scheduleReload();
    } catch (err) {
      toast(err.message, 'error');
      await refreshDrawer();
    }
  });
  $('#drawer').querySelectorAll('[data-move]').forEach((btn) => {
    btn.onclick = () => withLoading(btn, async () => {
      try {
        await api(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          body: { version: state.openTask.version, status: btn.dataset.move, by: 'user' },
        });
        scheduleReload();
      } catch (err) {
        toast(err.message, 'error');
        scheduleReload();
      }
    });
  });
  $('#drawer').querySelector('[data-accept]')?.addEventListener('click', (e) => {
    withLoading(e.currentTarget, async () => {
      try {
        await api(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          body: { version: state.openTask.version, status: 'done', by: 'user' },
        });
        toast('已验收 ✓');
        scheduleReload();
      } catch (err) {
        toast(err.message, 'error');
        scheduleReload();
      }
    });
  });
  // 抽屉内执行/停止：复用卡片的执行面板与停止接口
  $('#d-exec')?.addEventListener('click', () => openRunSheet(t.id));
  // 抽屉内删除（仅已取消任务显示）：替代原卡片 × 按钮
  $('#d-del')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    confirmDlg(`确定删除任务 #${t.id}？此操作不可恢复`, { okText: '删除', danger: true }).then((ok) => {
      if (!ok) return;
      withLoading(btn, async () => {
        try {
          await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
          toast('任务已删除');
          closeDrawer();
        } catch (err) {
          toast(err.message, 'error');
        }
        scheduleReload();
      });
    });
  });
  $('#d-stop')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    confirmDlg('停止正在执行的 Agent？', { okText: '停止', danger: true }).then((ok) => {
      if (!ok) return;
      withLoading(btn, async () => {
        try {
          await api(`/api/tasks/${t.id}/run`, { method: 'DELETE' });
          toast('已发送停止信号');
        } catch (err) {
          toast(err.message, 'error');
        }
        scheduleReload();
      });
    });
  });
  // 答复 [提问]：发评论后自动续跑——阻塞中的提问续跑执行，待规划/待办续跑问答
  $('#reply-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    withLoading(btn, async () => {
      const body = $('#d-reply').value.trim();
      if (!body) return;
      try {
        await api(`/api/tasks/${t.id}/comments`, { method: 'POST', body: { author: 'user', body } });
        const mode = ['backlog', 'todo'].includes(state.openTask.status) ? 'qa' : 'execute';
        const threadAgent = (state.openTask.thread_id || '').split(':')[0];
        const agent = state.settings.agents.includes(threadAgent) ? threadAgent : state.settings.agents[0];
        await api(`/api/tasks/${t.id}/execute`, { method: 'POST', body: { agent, mode } });
        toast(`已提交答复，${agent} 继续中`);
        scheduleReload();
      } catch (err) {
        toast(err.message, 'error');
        scheduleReload();
      }
    });
  });
  // 评论附图：textarea 直接粘贴截图，或点 📎 选择（手机端走相册）
  $('#d-comment').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile());
    if (files.length) { e.preventDefault(); addPendingImages(files); }
  });
  $('#img-btn').onclick = () => $('#img-input').click();
  $('#img-input').onchange = (e) => { addPendingImages([...e.target.files]); e.target.value = ''; };
  renderPendingStrip(); // 抽屉重渲染后恢复未发送的附图
  $('#comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    withLoading(btn, async () => {
      const body = $('#d-comment').value.trim();
      if (!body && pendingImages.length === 0) return;
      try {
        await api(`/api/tasks/${t.id}/comments`, {
          method: 'POST',
          body: { author: 'user', body, images: pendingImages },
        });
        pendingImages = [];
        scheduleReload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };
}

// ---------- 项目表单（新建/编辑，路径行动态增删） ----------
function pathRow(value = '') {
  const row = document.createElement('div');
  row.className = 'path-row';
  row.innerHTML = `<input value="${esc(value)}" placeholder="/Users/you/repo" maxlength="500"><button type="button" class="btn ghost del" title="删除该路径">×</button>`;
  row.querySelector('.del').onclick = () => row.remove();
  return row;
}

function openProjectForm(project = null) {
  $('#pf-title').textContent = project ? `编辑项目 #${project.id}` : '新建项目';
  $('#pf-id').value = project?.id ?? '';
  $('#pf-name').value = project?.name ?? '';
  $('#pf-maindir').value = project?.main_dir ?? '';
  const box = $('#pf-paths');
  box.innerHTML = '';
  const paths = project?.paths?.length ? project.paths : [''];
  paths.forEach((p) => box.appendChild(pathRow(p)));
  $('#project-backdrop').classList.remove('hidden');
  setTimeout(() => $('#pf-name').focus(), 50);
}

function closeProjectForm() {
  $('#project-backdrop').classList.add('hidden');
}

// ---------- 设置页 ----------
function syncAgentToggles() {
  document.querySelectorAll('[data-agent-toggle]').forEach((cb) => {
    cb.checked = state.settings.agents.includes(cb.dataset.agentToggle);
  });
}

// 执行提示词模板：覆盖值优先，否则展示内置默认；只在打开设置页时填充，避免 SSE 覆盖编辑中内容
async function renderPromptSettings() {
  if (!state.promptDefaults) {
    try { state.promptDefaults = await api('/api/prompt-defaults'); } catch { return; }
  }
  $('#prompt-new').value = state.settings.prompt_new || state.promptDefaults.new;
  $('#prompt-resume').value = state.settings.prompt_resume || state.promptDefaults.resume;
  $('#prompt-qa').value = state.settings.prompt_qa || state.promptDefaults.qa;
  $('#auto-claim-prompt').value = state.promptDefaults.auto_claim || '';
}

function openSettings() {
  renderSettingsProjects();
  syncAgentToggles();
  renderPromptSettings();
  $('#token-view').textContent = getToken() || '（未设置）';
  $('#board').classList.add('hidden');
  $('#settings-page').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-page').classList.add('hidden');
  $('#board').classList.remove('hidden');
}

function renderSettingsProjects() {
  const box = $('#settings-projects');
  if (!box) return;
  box.innerHTML = state.projects.map((p) => `
    <div class="sp-row">
      <div class="sp-info">
        <div class="sp-name">${esc(p.name)}</div>
        <div class="sp-paths">主目录：${esc(p.main_dir || `~/${p.name}（默认）`)}</div>
        <div class="sp-paths" title="${esc((p.paths || []).join('\n'))}">查找范围：${p.paths?.length ? esc(p.paths.join('，')) : '未配置'}</div>
      </div>
      <button class="btn ghost" data-edit-project="${p.id}">编辑</button>
      <button class="btn ghost danger" data-del-project="${p.id}" title="删除项目（仅限没有未取消任务）">删除</button>
    </div>`).join('') || '<div style="color:var(--text-dim)">暂无项目</div>';
}

// ---------- 立即执行 / 问答 ----------
let runTaskId = null;
let runMode = 'execute'; // execute=实现任务；qa=问答（只讨论不实现）
let runAgent = null; // 弹框里当前选中的执行工具（先选工具，再出对应可用的模型/思考/权限选项）
const QA_STATUSES = ['backlog', 'todo', 'blocked']; // 问答只允许这三个状态发起

// 思考/权限档位的显示名（值来自 GET /api/agent-options；reasonix 模式名直接用原名）
const EFFORT_LABELS = { low: '低', medium: '中', high: '高' };
const PERMISSION_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全开放',
  yolo: 'YOLO（跳过审批，无沙箱）',
  bypassPermissions: 'bypassPermissions（YOLO）',
};
// agent-options 接口不可用（如旧版服务进程）时的回退档位——server/runner.mjs 的 AGENT_OPTIONS 副本，改动时两处同步
const AGENT_OPTIONS_FALLBACK = {
  codex: { efforts: ['low', 'medium', 'high'], permissions: ['read-only', 'workspace-write', 'danger-full-access', 'yolo'], models: [], defaultModel: null },
  kimi: { efforts: [], permissions: [], models: [], defaultModel: null },
  reasonix: { efforts: ['low', 'medium', 'high'], permissions: ['manual', 'ask', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions', 'yolo'], models: [], defaultModel: null },
  dsh: { efforts: [], permissions: ['read-only', 'workspace-write', 'danger-full-access', 'yolo'], models: [], defaultModel: null },
};

function fillSelect(sel, values, labels, defaultText) {
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(defaultText)}</option>`
    + values.map((v) => `<option value="${esc(v)}">${esc(labels[v] || v)}</option>`).join('');
  sel.value = values.includes(prev) ? prev : ''; // 之前的值在新清单里就保留，否则回默认
}

// 选中执行工具：按钮高亮 + 按该工具的清单联动重建模型/思考/权限选项（kimi 思考/权限不生效则整行隐藏）
function selectRunAgent(agent) {
  runAgent = agent;
  document.querySelectorAll('.run-agent').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.agent === agent);
  });
  const opts = state.agentOptions?.[agent] || AGENT_OPTIONS_FALLBACK[agent];
  const modelSel = $('#run-model');
  // dsh 的模型在 dsh 自己的设置里配（headless 无 model 参数），看板侧隐藏模型行
  $('#run-model-row').classList.toggle('hidden', agent === 'dsh');
  const prevModel = modelSel.value;
  modelSel.innerHTML = `<option value="">默认（${esc(opts.defaultModel || '读 CLI 配置')}）</option>`
    + (opts.models || []).map((mo) => `<option value="${esc(mo.id)}">${esc(mo.label || mo.id)}</option>`).join('');
  modelSel.value = (opts.models || []).some((mo) => mo.id === prevModel) ? prevModel : '';
  $('#run-effort-row').classList.toggle('hidden', opts.efforts.length === 0);
  fillSelect($('#run-effort'), opts.efforts, EFFORT_LABELS, '默认');
  $('#run-permission-row').classList.toggle('hidden', opts.permissions.length === 0);
  fillSelect($('#run-permission'), opts.permissions, PERMISSION_LABELS,
    agent === 'reasonix' ? '默认（ask）' : '默认（工作区可写）');
  syncRunGo();
}

function syncRunGo() {
  const label = runAgent ? runAgent[0].toUpperCase() + runAgent.slice(1) : '';
  $('#run-go').textContent = runMode === 'qa' ? `💬 用 ${label} 开始问答` : `▶ 用 ${label} 开始执行`;
  $('#run-go').disabled = !runAgent;
}

function openRunSheet(taskId) {
  runTaskId = taskId;
  runMode = 'execute';
  const t = state.tasks.find((x) => x.id === taskId);
  $('#run-task-title').textContent = t ? `#${t.id} ${t.title}` : `#${taskId}`;
  // 状态不允许问答时藏起问答页签
  document.querySelector('[data-rmode="qa"]').classList.toggle('hidden', !(t && QA_STATUSES.includes(t.status)));
  // 只显示设置页启用的 Agent 按钮
  document.querySelectorAll('.run-agent').forEach((btn) => {
    btn.classList.toggle('hidden', !state.settings.agents.includes(btn.dataset.agent));
  });
  // 回填该任务上一次执行的选择（按任务记忆，tasks.exec_opts）；没执行过则用第一个启用的 Agent + 全默认
  let last = null;
  try { last = JSON.parse(t?.exec_opts || 'null'); } catch { /* 坏值忽略 */ }
  const agent = last?.agent && state.settings.agents.includes(last.agent) ? last.agent : state.settings.agents[0];
  selectRunAgent(agent);
  if (last?.model) {
    const sel = $('#run-model');
    // 上次用的模型不在当前清单里（自定义过/配置变了）：补一个选项让它能显示并回填
    if (![...sel.options].some((o) => o.value === last.model)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(last.model)}">${esc(last.model)}（上次使用）</option>`);
    }
    sel.value = last.model;
  }
  if (last?.effort) $('#run-effort').value = last.effort; // 不在当前工具档位里的会回默认
  if (last?.permission) $('#run-permission').value = last.permission;
  syncRunMode();
  $('#run-backdrop').classList.remove('hidden');
}

function syncRunMode() {
  const t = state.tasks.find((x) => x.id === runTaskId);
  document.querySelectorAll('[data-rmode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.rmode === runMode);
  });
  $('#run-backdrop h2').textContent = runMode === 'qa' ? '问答（只讨论不实现）' : '立即执行';
  syncRunGo();
  const hint = $('#run-hint');
  if (runMode === 'qa') {
    hint.textContent = '通过评论来回问答，澄清需求 / 规则 / 验收标准；结论由 Agent 写回任务描述，状态不动';
    hint.classList.remove('hidden');
  } else if (t && !(t.description || '').includes('验收标准')) {
    hint.textContent = '💡 描述中没有「验收标准」，开发类任务建议先切到「问答」明确（Agent 发现缺失也会进阻塞来问你）';
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

function closeRunSheet() {
  $('#run-backdrop').classList.add('hidden');
}

// ---------- 公网分享（cloudflared 隧道） ----------
let shareTimer = null;

async function refreshShare() {
  let s;
  try { s = await api('/api/tunnel'); } catch (err) { return toast(err.message, 'error'); }
  const statusText = {
    stopped: '未开启',
    starting: '隧道启动中…',
    running: '🟢 运行中',
    error: `启动失败：${s.error || '未知错误'}`,
  }[s.state] || s.state;
  $('#share-status').textContent = `状态：${statusText}`
    + (!s.live && s.url && s.state !== 'starting' ? '（下方是上次使用的域名，已失效）' : '');
  $('#share-url').textContent = s.url || '（尚未生成）';
  $('#share-token').textContent = s.token || '（未设置 TASKBOARD_TOKEN）';
  const active = s.state === 'running' || s.state === 'starting';
  $('#share-start').classList.toggle('hidden', active);
  $('#share-stop').classList.toggle('hidden', !active);
  $('#share-regen').classList.toggle('hidden', s.state !== 'running');
  const copyBtn = $('#share-copy');
  copyBtn.dataset.link = s.url ? (s.token ? `${s.url}/#token=${encodeURIComponent(s.token)}` : s.url) : '';
  copyBtn.disabled = !s.url;
  clearInterval(shareTimer);
  shareTimer = s.state === 'starting' ? setInterval(refreshShare, 1000) : null;
}

function openShare() {
  $('#share-backdrop').classList.remove('hidden');
  refreshShare();
}

function closeShare() {
  $('#share-backdrop').classList.add('hidden');
  clearInterval(shareTimer);
  shareTimer = null;
}

// ---------- 额度区（DeepSeek / Kimi / Codex） ----------
function quotaCard(name, inner) {
  return `<div class="quota-card"><div class="quota-name">${name}</div>${inner}</div>`;
}

// Kimi 额度：复刻官方「用量进度」布局（Code 用量百分比进度条 + 重置时间）
function usageRow(label, used, limit, resetISO) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const reset = resetISO ? `${resetISO.slice(5, 16).replace('T', ' ')} 后重置` : '';
  return `
    <div class="usage-row">
      <div class="usage-label"><span>${label} <b>${pct.toFixed(2)}%</b></span><span class="usage-reset">${esc(reset)}</span></div>
      <div class="usage-bar"><i style="width:${Math.min(100, pct).toFixed(2)}%"></i></div>
    </div>`;
}

function renderQuota(data) {
  const cards = [];
  const d = data.deepseek || {};
  cards.push(d.ok
    ? quotaCard('DeepSeek · Reasonix', `<div class="quota-main">¥ ${esc(d.balance)}</div><div class="quota-sub">钱包余额</div>`)
    : quotaCard('DeepSeek · Reasonix', `<div class="quota-err">${esc(d.error || '不可用')}</div>`));
  const k = data.kimi || {};
  if (k.ok) {
    const parts = [];
    if (k.window) parts.push(usageRow(`${k.window.minutes / 60} 小时用量`, k.window.used, k.window.limit, k.window.reset_time));
    if (k.weekly) parts.push(usageRow('7 天用量', k.weekly.used, k.weekly.limit, k.weekly.reset_time));
    if (k.extra_balance != null) parts.push(`<div class="quota-sub">Extra Usage：¥ ${esc(k.extra_balance)}</div>`);
    cards.push(quotaCard(`Kimi${k.plan ? ` · ${esc(k.plan.replace('LEVEL_', ''))}` : ''}`, parts.join('') || '<div class="quota-sub">无数据</div>'));
  } else {
    cards.push(quotaCard('Kimi', `<div class="quota-err">${esc(k.error || '不可用')}</div>`));
  }
  const c = data.codex || {};
  cards.push(c.ok
    ? quotaCard('Codex', `<div class="quota-main">${esc(c.balance)}</div><div class="quota-sub">${esc(c.currency || '')}${c.provider ? ` · ${esc(c.provider)}` : ''}</div>`)
    : quotaCard('Codex', `<div class="quota-err">${esc(c.error || '不可用')}</div>`));
  $('#quota-cards').innerHTML = cards.join('');
  $('#quota-time').textContent = data.fetched_at ? `${data.fetched_at.slice(11, 19)} 更新` : '';
}

async function loadQuota(refresh = false) {
  $('#quota-cards').innerHTML = '<div class="quota-hint">查询中…</div>';
  try {
    renderQuota(await api(`/api/quota${refresh ? '?refresh=1' : ''}`));
  } catch (err) {
    $('#quota-cards').innerHTML = `<div class="quota-hint">${esc(err.message)}</div>`;
  }
}

function setQuotaBar(open) {
  $('#quota-bar').classList.toggle('hidden', !open);
  localStorage.setItem('taskboard_quota', open ? '1' : '0');
  if (open) loadQuota(); // 每次展开都刷新一次（服务端有 60s 缓存兜底）
}

// ---------- 新建任务弹窗 ----------
function openTaskForm(status = 'todo') {
  $('#tf-status').value = status;
  $('#task-form-title').textContent = `新建任务 → ${STATUS_LABEL[status] || status}`;
  const sel = $('#tf-project');
  sel.innerHTML = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  // 当前筛选是单项目则默认该项目，否则默认第一个
  sel.value = String(state.projectId ?? state.projects[0]?.id ?? '');
  $('#tf-title-input').value = '';
  $('#tf-desc').value = '';
  $('#modal-backdrop').classList.remove('hidden');
  setTimeout(() => $('#tf-title-input').focus(), 50);
}

function closeTaskForm() {
  $('#modal-backdrop').classList.add('hidden');
}

// ---------- 主题 ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('taskboard_theme', theme);
  $('#theme-btn').textContent = theme === 'light' ? '🌙 切换为暗色' : '☀️ 切换为亮色';
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', theme === 'light' ? '#c89866' : '#4a3524');
}

// ---------- SSE ----------
function connectEvents() {
  const token = getToken();
  const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
  const es = new EventSource(url);
  let timer = null;
  es.onmessage = () => {
    // 任务/评论/项目变更：走统一去抖重载（与本地操作后的显式刷新合并，防同一次变更重渲两遍）
    scheduleReload();
    clearTimeout(timer);
    timer = setTimeout(() => loadSettings().catch(() => { /* 设置拉取失败沿用本地状态 */ }), 300);
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 3000);
  };
}

// ---------- 入口 ----------
function init() {
  $('#toggle-canceled').checked = state.showCanceled;
  $('#toggle-canceled').onchange = (e) => {
    state.showCanceled = e.target.checked;
    localStorage.setItem('taskboard_canceled', e.target.checked ? '1' : '0');
    renderBoard();
  };
  // Agent 启用开关：乐观更新 + 服务端持久化；至少保留一个
  document.querySelectorAll('[data-agent-toggle]').forEach((cb) => {
    cb.onchange = async () => {
      const agents = [...document.querySelectorAll('[data-agent-toggle]')]
        .filter((x) => x.checked)
        .map((x) => x.dataset.agentToggle);
      if (agents.length === 0) {
        cb.checked = true;
        toast('至少需要启用一个 Agent');
        return;
      }
      const prev = state.settings.agents;
      state.settings.agents = agents;
      try {
        state.settings = await api('/api/settings', { method: 'PATCH', body: { agents } });
      } catch (err) {
        state.settings.agents = prev;
        toast(err.message, 'error');
      }
      syncAgentToggles();
    };
  });
  $('#project-select').onchange = async (e) => {
    state.projectId = e.target.value === 'all' ? null : Number(e.target.value);
    await loadTasks();
  };
  $('#settings-btn').onclick = openSettings;
  $('#settings-close').onclick = closeSettings;
  // 额度区：💰 切换显示，展开状态持久化
  $('#quota-btn').onclick = () => setQuotaBar($('#quota-bar').classList.contains('hidden'));
  $('#quota-close').onclick = () => setQuotaBar(false);
  $('#quota-refresh').onclick = (e) => withLoading(e.currentTarget, () => loadQuota(true));
  if (localStorage.getItem('taskboard_quota') === '1') setQuotaBar(true);
  // 切回页面时对齐一次数据（移动端浏览器挂起 SSE 期间的变更兜底）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadTasks().catch(() => { /* 忽略瞬时错误 */ });
  });
  // 公网分享对话框
  // 公网分享按钮只在本机访问（localhost/127/::1）时显示——隧道那端就是手机，不需要分享入口
  const isLocalAccess = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  $('#share-btn').classList.toggle('hidden', !isLocalAccess);
  $('#share-btn').onclick = openShare;
  $('#share-close').onclick = closeShare;
  // 所有对话框：点击背板（其他区域）不自动关闭，只能点按钮或 Esc，防误触
  $('#share-start').onclick = (e) => withLoading(e.currentTarget, async () => {
    try { await api('/api/tunnel/start', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
    refreshShare();
  });
  $('#share-regen').onclick = (e) => withLoading(e.currentTarget, async () => {
    try { await api('/api/tunnel/restart', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
    setTimeout(refreshShare, 800); // 等旧进程退出、新进程进入 starting
  });
  $('#share-stop').onclick = (e) => withLoading(e.currentTarget, async () => {
    try { await api('/api/tunnel/stop', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
    setTimeout(refreshShare, 500);
  });
  $('#share-copy').onclick = (e) => withLoading(e.currentTarget, async () => {
    const link = $('#share-copy').dataset.link;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const ta = $('#share-url');
      const range = document.createRange();
      range.selectNodeContents(ta);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
    }
    toast('完整链接已复制');
  });
  // 提示词模板：与默认相同或留空 = 清除覆盖（服务端回退内置模板）
  const tplOrNull = (id, def) => {
    const v = $(id).value;
    return !v.trim() || v === def ? null : v;
  };
  $('#auto-claim-copy').onclick = (e) => withLoading(e.currentTarget, async () => {
    const text = $('#auto-claim-prompt').value;
    if (!text) return toast('提示词加载中，请稍候');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文降级：选中原样复制
      $('#auto-claim-prompt').select();
      document.execCommand('copy');
    }
    toast('已复制，去贴给常驻 Agent 会话');
  });
  $('#prompt-save').onclick = (e) => withLoading(e.currentTarget, async () => {
    if (!state.promptDefaults) return toast('模板加载中，请稍候');
    try {
      state.settings = await api('/api/settings', {
        method: 'PATCH',
        body: {
          prompt_new: tplOrNull('#prompt-new', state.promptDefaults.new),
          prompt_resume: tplOrNull('#prompt-resume', state.promptDefaults.resume),
          prompt_qa: tplOrNull('#prompt-qa', state.promptDefaults.qa),
        },
      });
      toast('提示词模板已保存');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#prompt-reset').onclick = (e) => withLoading(e.currentTarget, async () => {
    if (!state.promptDefaults) return toast('模板加载中，请稍候');
    try {
      state.settings = await api('/api/settings', {
        method: 'PATCH',
        body: { prompt_new: null, prompt_resume: null, prompt_qa: null },
      });
      $('#prompt-new').value = state.promptDefaults.new;
      $('#prompt-resume').value = state.promptDefaults.resume;
      $('#prompt-qa').value = state.promptDefaults.qa;
      toast('已恢复内置模板');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#sp-new-project').onclick = () => openProjectForm();
  $('#settings-projects').onclick = (e) => {
    const btn = e.target.closest('[data-edit-project]');
    if (btn) {
      const p = state.projects.find((x) => x.id === Number(btn.dataset.editProject));
      if (p) openProjectForm(p);
      return;
    }
    const delBtn = e.target.closest('[data-del-project]');
    if (!delBtn) return;
    const p = state.projects.find((x) => x.id === Number(delBtn.dataset.delProject));
    confirmDlg(`确定删除项目「${p?.name ?? delBtn.dataset.delProject}」？其下已取消的任务会一并删除，此操作不可恢复`, { okText: '删除', danger: true })
      .then((ok) => {
        if (!ok) return;
        withLoading(delBtn, async () => {
          try {
            await api(`/api/projects/${delBtn.dataset.delProject}`, { method: 'DELETE' });
            toast('项目已删除');
            await loadProjects();
          } catch (err) {
            toast(err.message, 'error'); // 有未取消任务时服务端 422，message 会说明
          }
        });
      });
  };
  $('#pf-add-path').onclick = () => $('#pf-paths').appendChild(pathRow());
  $('#pf-cancel').onclick = closeProjectForm;
  $('#project-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    withLoading(btn, async () => {
      const id = $('#pf-id').value;
      const paths = [...document.querySelectorAll('#pf-paths input')]
        .map((i) => i.value.trim())
        .filter(Boolean);
      const name = $('#pf-name').value.trim();
      const main_dir = $('#pf-maindir').value.trim();
      try {
        if (id) {
          await api(`/api/projects/${id}`, { method: 'PATCH', body: { name, paths, main_dir } });
        } else {
          await api('/api/projects', { method: 'POST', body: { name, paths, main_dir } });
        }
        closeProjectForm();
        await loadProjects();
        toast('项目已保存');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };
  $('#token-btn').onclick = async () => {
    const cur = getToken();
    const t = await promptDlg(cur ? '更新 Token（清空则删除）：' : '设置访问 Token：', cur);
    if (t === null) return;
    if (t.trim()) localStorage.setItem('taskboard_token', t.trim());
    else localStorage.removeItem('taskboard_token');
    location.reload();
  };
  // 抽屉也只靠 × 按钮关闭（点背板不关闭）
  // 灯箱：点击任意处或 Esc 关闭
  $('#lightbox').onclick = closeLightbox;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lightbox').classList.contains('hidden')) closeLightbox();
  });
  // 执行输出弹框：×/Esc 关闭；上翻时停止自动滚底
  $('#output-close').onclick = closeOutputView;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#output-backdrop').classList.contains('hidden')) closeOutputView();
  });
  $('#output-term').addEventListener('scroll', (e) => {
    const term = e.target;
    outputStick = term.scrollHeight - term.scrollTop - term.clientHeight < 24;
  });
  // 视口跨断点时重算手风琴折叠（用户手动选择仍保留）
  matchMedia('(max-width: 768px)').addEventListener('change', () => renderBoard());
  applyTheme(localStorage.getItem('taskboard_theme') || 'light');
  $('#theme-btn').onclick = () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  };
  $('#run-cancel').onclick = closeRunSheet;
  document.querySelectorAll('[data-rmode]').forEach((b) => {
    b.onclick = () => { runMode = b.dataset.rmode; syncRunMode(); };
  });
  document.querySelectorAll('.run-agent').forEach((btn) => {
    btn.onclick = () => selectRunAgent(btn.dataset.agent); // 先选工具，选项联动，再点「开始」
  });
  $('#run-go').onclick = () => withLoading($('#run-go'), async () => {
    if (!runAgent) return;
    const agent = runAgent;
    const taskId = runTaskId;
    const body = { agent, mode: runMode };
    const model = $('#run-model').value;
    const effort = $('#run-effort').value;
    const permission = $('#run-permission').value;
    if (model) body.model = model;
    if (effort) body.effort = effort;
    if (permission) body.permission = permission;
    try {
      await api(`/api/tasks/${taskId}/execute`, { method: 'POST', body });
      closeRunSheet();
      // 从任务明细发起的执行：启动成功后顺手关掉明细页，回到看板看运行卡片
      if (state.openTask?.id === taskId) closeDrawer();
      toast(`已启动 ${agent} ${runMode === 'qa' ? '问答' : '执行'}任务 #${taskId}`);
    } catch (err) {
      toast(err.message, 'error');
    }
    scheduleReload();
  });
  $('#tf-cancel').onclick = closeTaskForm;
  $('#task-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    withLoading(btn, async () => {
      try {
        await api('/api/tasks', {
          method: 'POST',
          body: {
            project_id: Number($('#tf-project').value),
            title: $('#tf-title-input').value.trim(),
            description: $('#tf-desc').value,
            status: $('#tf-status').value || 'todo',
            priority: $('#tf-priority').value,
          },
        });
        closeTaskForm();
        scheduleReload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };

  loadAgentOptions().catch(() => { state.agentOptions = null; /* 弹框回退到内置档位副本 */ });
  loadSettings()
    .catch(() => { /* 首次拉取失败用默认（全部启用） */ })
    .then(() => loadProjects().catch((err) => toast(err.message, 'error')));
  connectEvents();
}

init();
