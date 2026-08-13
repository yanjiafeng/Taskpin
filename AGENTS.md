# AGENTS.md

## 项目

个人本地任务看板：浏览器 UI + REST API + SQLite + `taskctl` CLI + Agent Skill 协议。

## 铁律

- **零 npm 依赖**：只用 Node 内置模块（`node:http` / `node:sqlite` / `node:test` 等）。不要引入任何第三方包，不要加构建步骤。
- 前端是无构建的 vanilla HTML/CSS/JS（`public/`），必须保持移动端可用（≤768px 为纵向手风琴布局 + 按钮操作，不能依赖 hover/拖拽/横向滑动作为唯一操作路径）。
- Node ≥ 22.5。

## 命令

- 启动：`npm start`（或 `node server/index.mjs`；env: `PORT` / `HOST` / `TASKBOARD_DB` / `TASKBOARD_TOKEN`）
- 测试：`npm test`（`node --test test/`）
- CLI：`node cli/taskctl.mjs <command>`（见 README）

## 结构约定

- `server/db.mjs` 是唯一数据层：schema、状态机（`TRANSITIONS`）、乐观锁（`version`）都在这里；server 与 CLI 共用，业务规则不要写进路由或 CLI。任务验收进 `done` 时会调用 `appendProjectMemory`，把任务摘要按固定结构追加到主目录的 `TASKBOARD_MEMORY.md`（写失败只打印错误，不阻断流转）。`tasks.last_run` 是最近一次执行结果标记（`setTaskLastRun` 写 JSON `{agent, code, error, at}` 或 null，runner 在异常退出时写入、新执行开始/正常结束时清除；元数据不 bump version），前端据此渲染红色「异常退出」卡片。`tasks.usage` 是最近一次执行从 agent 输出解析到的上下文用量（`setTaskUsage` 写 JSON `{agent, tokens, input_tokens?, output_tokens?, at}`；解析函数是 runner.mjs 的 `parseUsage`：codex 读尾部 `tokens used`、reasonix 读结果行的 `usage`、kimi 无用量输出不解析；元数据不 bump version），详情抽屉属性栏据此显示「上下文」一行（无 usage 时回退为任务描述+评论的字符数粗估，两种都标注统计来源）。全局设置存 `settings` 表（key-value，value 为 JSON），目前有 `agents`（启用的执行 Agent，`AGENT_NAMES` 定义在 db.mjs，至少一个，`GET/PATCH /api/settings`）和 `prompt_new`/`prompt_resume`/`prompt_qa`（执行/问答 prompt 模板覆盖，null 回退 runner.mjs 的 `PROMPT_DEFAULTS`，占位符 `{{task_id}}`/`{{tctl}}`/`{{project_name}}`/`{{scope}}`/`{{claim_step}}`，前两个必填；内置默认值经 `GET /api/prompt-defaults` 暴露给设置页）。
- 状态机：`backlog → todo → in_progress → in_review → done`，分支 `blocked`、`canceled`（终态）；另允许 `in_progress → backlog`（停止执行时回待规划）和 `done → todo` / `done → backlog` / `done → canceled`（已完成任务回退重新规划或取消）。进 `done` 必须 `by: 'user'`；新建任务只能落在 `backlog`/`todo`。删除走 `deleteTasks`：**只能删已取消**，评论级联删除，批量在同一事务（`DELETE /api/tasks/:id` 单个、`POST /api/tasks/batch-delete {ids}` 批量）。
- 评论图片：`comments.images` 存附件相对路径 JSON（`saveAttachments` 落盘到 `<db 目录>/attachments/<taskId>/`，校验 ≤6 张、单张 ≤8MB、png/jpg/gif/webp 的 dataURL），有图时 `addComment` 的 body 可空。读取走 `GET /api/attachments/:taskId/:file`（api.mjs，防路径穿越）；`taskctl show` 把 images 转成绝对路径输出（agent 直接读图），`taskctl comment --image` 可多次附图；API 请求体上限 60MB（base64 图）。删除项目走 `deleteProject`：**仅限没有未取消任务**（否则 422），其任务与评论由外键 `ON DELETE CASCADE` 一并删除（`DELETE /api/projects/:id`、CLI `project-delete`）。
- `server/runner.mjs` 是 Agent 执行器：`POST /api/tasks/:id/execute` 拉起 codex/kimi/reasonix 子进程，运行状态在内存，进程退出时自动写 `[runner]` 评论。`DELETE /api/tasks/:id/run` 停止（SIGTERM）后任务自动回 `backlog` 并写一条 user 评论（仅当任务仍在 `in_progress`；先流转再 kill，避免与 finish 重复）；进程退出时任务仍停在 `in_progress` 的（agent 什么都没流转就死了）同样由 `finish` 放回 `backlog`。工作目录 = 项目主目录（`projects.main_dir`，未配置时 `resolveMainDir` 自动创建 `~/<项目名>`）；执行可带 `model`/`effort`（kimi 不生效）/`permission`（kimi 不生效）参数；kimi 固定 `-p`（此版本不能与 `--auto`/`-y` 组合）；reasonix 走 `run --output-format json`，permission 的沙箱名映射到 `--permission-mode`（`REASONIX_MODE_MAP`）。执行前校验该 agent 在 settings 里已启用，停用则 403 `AGENT_DISABLED`。`mode`（默认 `execute`）：`execute` 模式**执行开始即把任务流转到 `in_progress`**（backlog 先经 todo 再 `claimTask` 原子认领，blocked/in_review 直接 `updateTask` 流转；prompt 的 `{{claim_step}}` 因此固定为"已自动认领、无需再 claim"）；`qa` 模式（问答，只讨论不实现）仅允许 `backlog`/`todo`/`blocked` 发起（否则 422），**不自动流转状态**，用 `PROMPT_DEFAULTS.qa` 模板，结论由 agent 写回任务描述。执行/问答模板里都约定了：先读主目录 `TASKBOARD_RULES.md`（项目规则）和 `TASKBOARD_MEMORY.md`（项目记忆）；开发类任务缺「验收标准」时给草案发 `[提问]` 并置 blocked，不许动手。执行结束从输出解析会话 id 写入 `tasks.thread_id`（`setTaskThread`，格式 `<agent>:<sessionId>`；reasonix 存的是会话文件完整路径，由 `findReasonixSessionFile` 按 session_id 在 Reasonix home 定位），再执行时**同 agent** 用 `codex exec resume` / `kimi -S` / `reasonix run --resume` 续跑原会话；跨 agent 无法续跑，自动新会话、靠评论继承任务记忆。
- 前端 `public/app.js` 里的 `TRANSITIONS` 是 `server/db.mjs` 的副本，改动状态机时两处同步。
- `server/quota.mjs` 是三家额度查询（`GET /api/quota?refresh=1`，60s 缓存）：DeepSeek 读 `~/.reasonix/.env` 的 key 查 `api.deepseek.com/user/balance`；Kimi 读 `~/.kimi-code/credentials/kimi-code.json` 的 OAuth token 查 `api.kimi.com/coding/v1/usages`（token 约 10 分钟过期，过期报错提示本机跑一次 kimi 刷新）；Codex 按 `~/.codex/config.toml` 的 provider base_url + `auth.json` 的 key 试 OpenAI 标准计费端点（第三方中转站一般 404，报"未提供"）。全是元数据接口，不耗模型 token；凭证只在本机读取、不出现在响应里。
- runner 的运行输出在内存保留 64KB 尾部（`OUTPUT_CAP`），`GET /api/tasks/:id/run/output` 返回实时输出（未在运行 404），执行中卡片上的 agent 名/用时可点开输出弹框 3s 轮询渲染（自动滚底，用户上翻则不打扰；reasonix 的 JSON 事件行做轻量文本提取）。任务详情是左侧宽抽屉双栏布局：左栏属性/描述/流转，右栏评论流（「最新一轮」= 最后一次用户评论到末尾的所有评论，置顶高亮；大输入框 + 「发表评论」与「执行/问答/停止」同行）。
- API 错误统一 `{error:{code,message}}`；冲突错误（409）附带 `current` 任务快照。
- 数据库默认 `~/.codex-task-dashiboard/taskboard.sqlite`，测试一律用临时文件，不得污染默认库。
- `server/tunnel.mjs` 是 cloudflared 快速隧道管理器：`POST /api/tunnel/start|stop|restart`（restart = 重新生成域名，旧进程退出后自动起新进程），从输出正则解析 trycloudflare 域名，最近一次域名持久化到 `settings.tunnel_url`；`GET /api/tunnel` 返回 `{state, url, live, token}`。服务退出（SIGTERM/SIGINT）会带走隧道进程。
- SSE 只有一个事件：`data: {"type":"change"}`，任何任务/评论/项目变更后调用 `broadcast()`。此外 `server/index.mjs` 用 `fs.watch` 监听数据库目录（WAL 模式下变更落在 `-wal` 文件），taskctl CLI 直写 SQLite 的外部变更也会触发广播（防抖 300ms；`:memory:` 库不监听）。
- Token 认证在 `server/index.mjs` 的 `checkAuth`：Host 为 localhost/127.0.0.1/::1 的本机访问免认证（按 Host 头判断而非连接来源，因为 cloudflared 也从本机回连）。

## 修改后

- 跑 `npm test` 确认全绿；改了 API 契约就同步更新 `test/api.test.mjs`、`cli/taskctl.mjs` 和 README。
- 改了任务流程协议就同步 `skills/manage-taskboard/SKILL.md`。
