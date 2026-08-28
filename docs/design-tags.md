# 任务标签（Tags）功能方案

> 状态：已实施（2026-08-28）。

## 需求

- 任务可挂多个标签；标签在**任务明细抽屉**中维护（增删）。
- 标签在**任务卡片**上以胶囊形式显示，位置在**标题下方**（标题与现有元信息胶囊之间）。
- 样式上与现有 `.pill` 胶囊（白底 + 描边）**一眼可区分**。

## 技术选型（关键决策）

**存储：`tasks.tags` 列存 JSON 数组字符串**（`TEXT NOT NULL DEFAULT '[]'`），与项目现有约定一致（`projects.paths`、`comments.images`、`tasks.exec_opts` 都是这个模式）。不建独立 tags 表 / 关联表——个人看板无按标签筛选、无标签元数据需求，建表是过度设计。

## 改动清单

### 1. `server/db.mjs`（数据层，业务规则都在这里）

- 迁移：仿照 `last_run`/`usage` 段（`db.mjs:93-104`），`PRAGMA table_info(tasks)` 检查，无 `tags` 列则 `ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`。
- `updateTask` 白名单（`db.mjs:311`）加 `'tags'`，并加校验函数 `normalizeTags(v)`：
  - 必须是数组；元素取 `String(x).trim()`，去空、去重（大小写敏感即可）；
  - 单个 ≤ 20 字符，总数 ≤ 8 个，超限抛 `DbError('VALIDATION', ...)`；
  - 落库前 `JSON.stringify`（`updateTask` 的 fields 直写，所以在 normalize 阶段返回 JSON 字符串）。
- `getTask`/`listTasks` 是 `SELECT *`，标签自动随任务下发，前端/CLI 自行 `JSON.parse`（同 `exec_opts` 的吃法）。
- 不进 `createTask`（新建任务走抽屉补标签即可，保持最小改动）。

### 2. `server/api.mjs`

- 无需改路由：`PATCH /api/tasks/:id` 已把 body 透传给 `updateTask`，tags 随白名单生效。

### 3. 明细抽屉标签编辑器（`public/app.js`，`renderDrawer` 的 `.d-props` 区，约 `app.js:1000-1010`）

- 在「优先级」下方加「标签」区块：
  - 现有标签渲染为可删除小 chip（`.d-tag` + `×` 按钮）；
  - 一个输入框 `#d-tag-input`，按 Enter 或逗号加入新标签（本地 DOM 态，即时去重/超限提示 toast）；
- 「保存修改」提交时（`app.js:1067` 的 `#d-save` handler）把当前 chips 收集成数组，加进 PATCH body 的 `tags` 字段；冲突/校验失败走现有 toast + `refreshDrawer` 路径。
- 草稿抢救：重渲会重建抽屉 DOM，标签编辑未保存会丢——渲染前从 `#d-tags` 容器读出当前 chips 数组暂存，渲染后回填（与标题/描述的 drafts 抢救同位置、同思路）。

### 4. 卡片标签胶囊（`public/app.js` `cardHtml` + `public/style.css`）

- `cardHtml`（`app.js:359-372`）：在 `.c-head` 之后、`.c-pills` 之前插入 `.c-tags` 行：

  ```html
  <div class="c-tags"><span class="tag-pill">#前端</span>…</div>
  ```

  - 无标签时不渲染该行（不占高度）；
  - 最多显示 3 个，超出追加 `<span class="tag-pill more">+N</span>`；标签行整体加 `title` 悬浮展示全部标签。
- 样式区分（`style.css`，紧跟 `.pill` 规则后新增 `.tag-pill`）。现有胶囊是「白底 45% + 实线描边 + 圆角 999px」，标签改为**美纹胶带风**，四个差异点叠加：

  | 维度 | 元信息胶囊 `.pill` | 标签胶囊 `.tag-pill` |
  | --- | --- | --- |
  | 底色 | 半透明白 | 实色琥珀渐变白字（`linear-gradient(135deg, #f0a832, #dd8f14)`，初版半透明琥珀偏灰暗已调亮） |
  | 描边 | 实线细边 | 无 |
  | 圆角 | 999px 全圆 | 6px 方形胶囊 |
  | 前缀 | 无 | `#` 前缀 |

- 移动端：`.c-tags` 同样 `flex-wrap: wrap`，与 `.c-pills` 行为一致，无 hover 依赖。

### 5. CLI（`cli/taskctl.mjs`）

- `update ID --tags "a,b,c"`（逗号分隔；`--tags ""` 清空），patch 里组装成数组交给 `updateTask`；
- `show` 输出加一行 `tags: a, b`（无标签不输出）；
- 帮助文本补 `--tags` 说明。

### 6. 测试

- `test/db.test.mjs`：迁移后 `tags` 列存在且默认 `[]`；`updateTask` 写标签 roundtrip；校验用例（非数组 / 超 8 个 / 单条超长 / 自动去重去空）。
- `test/api.test.mjs`：PATCH 带 `tags` 数组 → 200 且 GET 读回一致；PATCH 非法 tags → 400 VALIDATION。

### 7. 文档同步

- `AGENTS.md`：db.mjs 段落补一句 `tasks.tags`（JSON 数组，明细页维护，卡片标题下方胶带风胶囊展示，≤8 个/≤20 字符）。
- `README.md`：CLI update 的 `--tags` 说明。

## 验证

- `npm test` 全绿（含新增用例）；
- `node --check public/app.js`；
- 起临时服务器（临时 DB）实测：建任务 → 抽屉加/删标签 → 保存 → 卡片标题下方出现胶带风标签胶囊 → 刷新/SSE 重渲后保持 → `--tags ""` 清空。

## 不做的事（范围控制）

- 不做按标签筛选/过滤看板（存储层已留好 JSON 数据，将来要加只需前端过滤 + 可选 SQL 索引）；
- 不做标签颜色自定义、标签管理页；
- agent prompt 模板不注入标签（`taskctl show` 已能看到，够用）。
