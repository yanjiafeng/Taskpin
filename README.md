# Taskpin

个人本地 AI 任务看板：把任务丢上看板，Agent 认领执行，你只管验收。

浏览器看板 UI + REST API + SQLite + `taskctl` CLI + Agent Skill 协议。**零 npm 依赖**，只用 Node 内置模块（`node:http` / `node:sqlite` / `node:test`），Node.js ≥ 22.5 即可运行，无构建步骤。

<p>
  <img src="docs/screenshot-desktop.png" width="60%" alt="桌面端看板">
  <img src="docs/screenshot-mobile-board.png" width="18%" alt="手机端看板">
  <img src="docs/screenshot-mobile.png" width="18%" alt="手机端任务详情">
</p>

```
你（浏览器/手机看板）                       Agent（Codex / Kimi / Reasonix / DSH）
      |                                       |
      | 建任务、排进 todo                      | taskctl list --status todo
      v                                       v
   SQLite  ←——————— taskctl claim <id>（原子认领）
      ^                                       |
      |                                       | 实现 + 自验证
      | 验收 → done                            | comment + 置 in_review
      └──────── SSE 实时刷新 ←—————————————————┘
```

## 特性

- **多 Agent 执行**：从看板一键拉起 Codex / Kimi / Reasonix / DSH（DeepSeek Harness）执行任务，可指定模型、思考强度、权限；不需要的 Agent 可在设置页停用
- **实时输出**：执行中卡片上的 agent 名/用时可点开输出弹框，实时滚动显示思考/输出流（3s 轮询，自动滚底）
- **异常退出告警**：Agent 进程非零退出的任务卡片标红（⚠ 异常退出角标），下次执行或正常结束自动消除
- **额度一览**：顶栏 💰 展开可隐藏的额度区——DeepSeek 钱包余额、Kimi 周额度/5h 窗口/Extra Usage、Codex 计费（OpenAI 标准接口，第三方中转站可能不支持）；全部走元数据接口、不消耗模型 token，60s 缓存
- **问答模式**：执行前的需求澄清——Agent 只讨论不实现，通过评论来回问答，把需求/规则/验收标准写回任务描述；待规划/待办/阻塞可发起
- **验收标准前置**：开发类任务没有「验收标准」时 Agent 不动手，给草案并进阻塞问你；交付时对照标准逐条自验证
- **会话续跑**：打回重做时恢复原 CLI 会话（`codex exec resume` / `kimi -S` / `reasonix run --resume`），Agent 记得上轮细节；DSH 的 headless 模式不支持续跑（每次新会话），跨 Agent 同样靠评论继承记忆
- **执行中提问**：Agent 遇到需要你决策的事会发 `[提问]` 评论并把任务置「阻塞」；抽屉底部评论框自动进入「答复模式」（高亮 + 「答复并继续」），提交即答复并自动续跑会话——评论与答复共用一个输入框
- **快捷执行**：任务执行过后，详情里的执行入口变成拆分按钮——主区「▶ 执行 · agent」用上次的模型/思考/权限一键再跑，不再弹选择面板；▾ 下拉里有「💬 问答 · agent」和「⚙ 更换工具/参数…」（打开面板改工具或参数）
- **评论折叠**：任务详情默认只显示「最新一轮」对话，更早评论收进「▸ 查看更早评论」折叠条，点击展开按原顺序查看
- **语音播报**：任务详情「最新一轮」旁 🔊 一键朗读 Agent 回答——免费、不烧 token；优先用浏览器内置 Web Speech API（手机端本机发声），浏览器不支持时自动走服务端 Windows SAPI 离线合成兜底；自动剥离 markdown、按句分段朗读，再点一次中断
- **项目记忆与规则**：任务验收进 `done` 时摘要追加到主目录 `TASKBOARD_MEMORY.md`；跨任务规则可沉淀到 `TASKBOARD_RULES.md`，执行和问答都会先读
- **多项目**：每个项目可配多个仓库路径（查找范围）和一个主目录（工作目录）；「全部项目」总览视图
- **手机可用**：移动端纵向手风琴布局 + 按钮操作，不依赖拖拽；内置 cloudflared 隧道管理，一键把看板暴露到公网
- **自定义提示词**：执行（新会话/续跑）和问答三个模板都可在设置页查看、修改、恢复默认
- **亮暗双主题**，SSE 实时刷新（`taskctl` CLI 直写 SQLite 也会经数据库文件监听触发广播），乐观锁防并发冲突，原子认领防重复执行；对话框点外部不关闭，操作按钮带 loading 防重复点击

<img src="docs/screenshot-settings.png" width="60%" alt="设置页：项目、Agent 开关、提示词模板">

## 快速开始

```bash
npm start            # 或 node server/index.mjs
# 打开 http://127.0.0.1:47824
```

- 看板列：`待规划 / 待办 / 进行中 / 阻塞 / 待验收 / 已完成`，`已取消` 默认隐藏（设置页可开启显示）。
- 桌面端可直接拖拽卡片改状态；手机端点卡片进详情，用状态按钮操作。
- 删除：**只能删「已取消」的任务**。单个删除在任务详情（抽屉）的「🗑 删除任务」按钮（有确认）；「已取消」列头的 🗑 按钮批量删除当前视图下全部已取消任务。对应 API：`DELETE /api/tasks/:id`、`POST /api/tasks/batch-delete {ids}`（事务，混着未取消任务会整体失败）。
- 状态机：`待规划 → 待办 → 进行中 → 待验收 → 已完成`；「进行中」可进「阻塞」（答复后回「待办」继续），各活动状态可进「已取消」（终态）。进「已完成」必须由用户验收，Agent 无法自判完成；「待验收」可回退「进行中」（打回重做）或「待办」「待规划」（重新规划）；「已完成」允许回退到「待办」「待规划」或取消。
- 数据默认在 `~/.codex-task-dashiboard/taskboard.sqlite`（`TASKBOARD_DB` 可覆盖）。
- **评论可附图**：在评论框直接粘贴截图，或点 📎 从相册/文件选择（最多 6 张、单张 ≤8MB，png/jpg/gif/webp）。图片存数据库同目录的 `attachments/`，评论里显示缩略图（点击看原图）；Agent 执行时会从 `taskctl show` 拿到图片的本地绝对路径，可直接读图。

## 手机访问（内网穿透）

顶栏 🌐 按钮（仅本机访问时显示）→「开始分享」即可：服务端拉起 `cloudflared` 快速隧道，弹框显示外网域名和 Token，「复制完整链接」得到带 `#token=` 的地址（hash 形式，token 不出现在服务器日志里）发给手机。「重新生成」换新域名，「停止」关隧道。隧道关闭后弹框仍显示上次使用的域名（标注已失效）。前提：主机已安装 `cloudflared`。对应 API：`GET /api/tunnel`、`POST /api/tunnel/start|stop|restart`。

<img src="docs/screenshot-share.png" width="60%" alt="公网分享对话框">

也可以用任意隧道工具手动转发本机端口：

```bash
cloudflared tunnel --url http://127.0.0.1:47824
# 或 frpc 配置 local_port = 47824
```

**暴露公网前务必设置访问 Token**，否则任何拿到链接的人都能操作看板：

```bash
TASKBOARD_TOKEN=你的随机长字符串 npm start
```

本机浏览器用 `localhost` / `127.0.0.1` 打开时**免 Token**（按 HTTP Host 判断，隧道流量的 Host 是公网域名，照常校验）。手机经隧道访问时输入一次 Token 即可（存在 localStorage，或用 `#token=` 链接直接登录，旧 `?token=` 链接也兼容）。若想让局域网设备直连（不走隧道），用 `HOST=0.0.0.0 npm start`，仅在可信网络下这样做——同网段主机可伪造 `Host: localhost` 绕过 Token 校验。

## 立即执行（从看板拉起 Agent）

任务卡片右下角有 ▶ 按钮，点击后**先选择工具**（**Codex**、**Kimi**、**Reasonix** 或 **DSH**；设置页可停用某个 Agent，停用后按钮隐藏且 API 拒绝执行，至少启用一个），面板随即联动出该工具可用的**模型、思考强度、权限**下拉选项（清单由后端 `GET /api/agent-options` 统一下发：思考/权限是固定档位，模型读各家 CLI 本地配置——codex 取 `~/.codex/config.toml` 当前值、kimi 取 `~/.kimi-code/config.toml` 的 `[models.*]` 别名、reasonix 取 `~/.reasonix/config.toml` 的 `[[providers]]`；Kimi 的思考/权限不生效、DSH 的模型/思考不生效（模型在 dsh 自己的设置里配），对应行整行隐藏），选好后点「开始执行」，服务端在本机拉起对应 CLI 执行该任务。**每次执行选用的 agent + 模型/思考/权限会按任务记住**（`tasks.exec_opts`），下次打开执行面板自动回填上一次的选择；任务卡片显示「⚙ agent · 模型 · 思考 · 权限」摘要标签，任务明细属性栏显示「最近执行」一行（含时间）：

<img src="docs/screenshot-run.png" width="60%" alt="立即执行面板">

- Codex：`codex exec -s <权限> -C <项目主目录> --add-dir <看板数据库目录>`（沙箱内可写工作区和看板库；权限可选只读/工作区可写/完全开放/YOLO（`--dangerously-bypass-approvals-and-sandbox`，跳过审批且无沙箱，与 `-s`/`--add-dir` 互斥），思考强度 `-c model_reasoning_effort=low|medium|high`）
- Kimi：`kimi -p <prompt>`（kimi 的 `-p` 不能与 `--auto`/`-y` 组合——0.36.0 实测报错；自动审批由 `~/.kimi-code/config.toml` 的 `default_permission_mode` 控制，看板侧不提供思考/权限选项）
- Reasonix：`reasonix run --dir <项目主目录> --permission-mode <模式> --add-dir <看板数据库目录> --output-format stream-json`（stream-json 事件流让执行过程在输出弹框中可见：agent 发言 + 工具调用/结果逐条渲染，末尾同样带 `{"type":"result"}` 结果行用于成功判定与用量解析；权限选项映射：只读→plan、工作区可写→auto、完全开放→bypassPermissions，YOLO→bypassPermissions，也可直接传 reasonix 的模式名；模型是 provider 名如 `deepseek-flash`/`deepseek-pro`）
- DSH（DeepSeek Harness）：`dsh --profile headless <prompt>`（一次性执行：新建会话、跑完把最终答复打 stdout，completed 退出码 0 否则 1。权限经 `DSH_PERMISSION_MODE` 环境变量下发，取值与 codex 沙箱同名，YOLO→danger-full-access，默认工作区可写；模型/思考在看板侧不生效——在 dsh 自己的设置里配；headless 不输出会话 id，**不支持续跑**，再执行自动新会话、靠评论继承记忆。执行过程输出由 `dsh-taskpin` 插件补齐：插件订阅 dsh 的 session 事件流，把 agent 发言、工具调用（▸）、工具结果（✓）实时写到 stderr，实时输出弹框即可看到过程（dsh headless 自身的 stdout 只在结束时有内容）。**回写看板优先用 `dsh-taskpin` 插件提供的 taskboard_show / taskboard_comment / taskboard_transition 原生工具**——沙箱内 taskctl 直写看板数据库会被权限拦截；插件在仓库 `dsh-taskpin/` 目录，用 `dsh plugin --profile headless add <路径>` 安装，看板地址默认 `http://127.0.0.1:47824`，可用 `TASKBOARD_API` 环境变量覆盖）
- 工作目录 = 项目主目录；项目未配置主目录时自动创建 `~/<项目名>` 并使用
- **执行即进「进行中」**：点击执行后任务自动流转到 `进行中`（待规划先经待办，阻塞/待验收直接流转；认领由看板自动完成，Agent 无需再 claim），卡片位置实时反映后台执行状态
- 执行 prompt 内置了 manage-taskboard 协议（实现 → 自验证 → 交付待验收），且会先读主目录的 `TASKBOARD_MEMORY.md`（已验收任务的项目记忆）
- **会话续跑**：执行结束自动把 CLI 会话 id 记入任务 `thread_id`；再次执行时若上次是同 agent 则恢复原会话（`codex exec resume <id>` / `kimi -S <id>` / `reasonix run --resume <会话文件>`），Agent 记得上轮改过的细节。跨 agent 执行无法续跑，自动开新会话、靠评论继承任务记忆
- **执行中提问**：Agent 需要用户决策时会发 `[提问]` 评论并把任务置为「阻塞」（抽屉里该评论带"等你答复"徽章）；底部评论框自动进入「答复模式」（琥珀高亮，按钮变「答复并继续」），提交 = 发评论 + 自动同 agent 续跑（阻塞续跑执行，待规划/待办续跑问答），也可以手动评论后重新执行
- **问答模式**：执行面板切到「问答」（仅待规划/待办/阻塞可发起，API `mode: 'qa'`），Agent 只讨论不实现、不自动流转状态；讨论结论由它结构化写回任务描述（需求/目标/规则约束/验收标准），跨任务规则可追加到主目录 `TASKBOARD_RULES.md`
- **验收标准前置**：开发类任务描述中没有「验收标准」时，Agent 不动手实现——给 2-4 条标准草案发 `[提问]` 并置「阻塞」，问答补齐后放回待办再执行；交付时对照标准逐条验证。点执行时若描述缺标准，面板会提示建议先问答（不拦截）
- **提示词模板可自定义**：设置页 →「执行提示词模板」可查看/修改新会话、续跑、问答三个模板（占位符 `{{task_id}}` `{{tctl}}` `{{project_name}}` `{{scope}}` `{{claim_step}}`），留空或点「恢复默认」回到内置版本
- **自动认领提示词**：设置页 →「自动认领提示词」一键复制，贴给终端里常驻的 Agent 会话，它会循环认领「待办」任务逐个执行（每 5 分钟空转检查一次）
- 同一任务同时只允许一个执行（重复点击返回 409）；执行中的卡片显示 ■ 按钮可停止（SIGTERM）。**停止执行、或进程退出时任务仍停在「进行中」的，都会自动放回「待规划」**并写评论说明（Agent 已自行交付/提问流转的不打扰）。**残留「进行中」自动回收**：运行跟踪在内存，服务重启/进程失联/启动失败会让任务停在「进行中」却没有活跃 run（卡片无执行中样式），看板启动时与每 30s 自动把它们放回「待规划」并写说明评论（正在跑的不打扰）；手动把卡片拖进「进行中」列会被拦截并提示走「执行」
- 进程结束时自动在任务评论里追加一条 `[runner]` 记录（退出码、用时、输出尾部）；**非零退出的任务卡片会标红**（`tasks.last_run` 字段，新执行开始或正常结束时清除）
- **上下文大小**：任务详情属性栏显示「上下文」一行——优先用最近一次执行从 agent 输出解析到的会话用量（`tasks.usage`：codex 的 `tokens used`、reasonix 结果行的 `usage`；kimi/dsh 无用量输出），没有则用任务描述+全部评论粗估；两种都标注统计来源
- 执行中点击卡片上的 agent 名/用时：弹框实时滚动显示 Agent 输出（3s 轮询 `run/output` 接口，保留 64KB 尾部缓冲）；任务详情（左侧双栏抽屉）里也可直接发起执行/停止
- 前提：主机已安装并登录 `codex` / `kimi` / `reasonix` / `dsh` CLI（dsh 即 `npm i -g @deepseek-ai/dsh`，凭据为 `~/.dsh/.env` 的 `DEEPSEEK_API_KEY`）。运行状态在内存中，重启看板服务即丢失跟踪（残留任务由上面的自动回收兜底）

对应 API：`POST /api/tasks/:id/execute {agent, model?, effort?, permission?}`、`GET /api/runs`、`GET /api/tasks/:id/run/output`、`DELETE /api/tasks/:id/run`、`GET /api/agent-options`（各 Agent 可选的思考/权限档位）。

## taskctl CLI

CLI 直接读写同一个 SQLite，看板服务不在线也能用。默认输出 JSON，`--pretty` 人性化输出。

```bash
alias taskctl="node $PWD/cli/taskctl.mjs"   # 或加到你的 shell 配置

taskctl projects                            # 项目列表
taskctl project-create --name demo --path ~/code/demo,~/code/lib   # 路径可多个，逗号分隔
taskctl project-update 1 --path ~/code/demo # 重置路径列表（--path "" 清空）
taskctl project-delete 1                    # 删除项目（仅限没有未取消任务）
taskctl create --title "修 bug" --desc "..." --priority high
taskctl list --status todo
taskctl show 3                              # 详情 + 全部评论
taskctl claim 3                             # 原子认领 todo -> in_progress
taskctl comment 3 --body "完成，测试通过" --author agent
taskctl comment 3 --body "看截图" --image a.png --image b.jpg   # --image 可多次
taskctl update 3 --status in_review --if-version 2
taskctl done 3 --if-version 3               # 仅用户：验收
taskctl serve                               # 等同于 npm start
```

错误以 JSON 打到 stderr 且退出码非零：`CLAIM_CONFLICT`（认领冲突）、`VERSION_CONFLICT`（版本过期）、`INVALID_TRANSITION`（非法状态跳转）。

项目可配置多个本地仓库路径（看板 ⚙ 设置页 → 项目 → 编辑，或 `project-update`，逗号分隔），这些路径合起来是 Agent 的默认查找范围（提示性质，不作沙箱限制）。每个项目还有一个**主目录**（可配置，默认自动创建 `~/<项目名>`），是 Agent 执行时的工作目录。任务验收进 `done` 时，看板会把任务摘要（标题、需求、Agent 结果、验收意见）按固定结构追加到主目录的 `TASKBOARD_MEMORY.md`，同一项目的记忆都汇总在这一个文件里。看板顶栏的项目下拉支持「全部项目」视图（默认），任务卡片以徽章标注所属项目；新建任务时可在弹窗中选择项目。

## 接入 Agent（Codex / Kimi / Reasonix / DSH）

把 Skill 安装到 Agent 的 skill 目录：

```bash
# Kimi Code / Claude Code 风格
cp -r skills/manage-taskboard ~/.agents/skills/

# Codex：按你的 skills 目录放置，例如
cp -r skills/manage-taskboard ~/.codex/skills/
```

然后在对话里说"去看板领一个任务做"，Agent 会按协议执行：读任务与评论 → 原子认领 → 实现并自验证 → 评论结果 → 置 `待验收`。**只有你能把任务拖进 `已完成`**。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `47824` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（`0.0.0.0` 可局域网直连，注意 Token 绕过风险） |
| `TASKBOARD_DB` | `~/.codex-task-dashiboard/taskboard.sqlite` | SQLite 数据文件 |
| `TASKBOARD_TOKEN` | （空） | 访问 Token；暴露公网前必须设置，本机 Host 访问免校验 |
| `REASONIX_HOME` | `~/.reasonix` | Reasonix 会话文件定位（续跑用） |

## Windows 常见问题

在 Windows（尤其通过非 Bash 终端启动服务）容易遇到下面几个坑：

### 1. Kimi 执行报 `spawn kimi ENOENT`

**现象**：点任务卡片上的 ▶ 执行 Kimi，评论里出现 `[runner] kimi 启动失败：spawn kimi ENOENT`。  
**原因**：看板服务进程继承到的 `PATH` 里没有 `~/.kimi-code/bin`。当前终端能跑 `kimi --version`，不代表服务进程也能。  
**解决**：
- 代码已在 `server/runner.mjs` 里兜底：Windows 下会优先尝试 `~/.kimi-code/bin/kimi.exe`，一般重启服务即可生效。
- 若仍失败，把 `C:\Users\<你的用户名>\.kimi-code\bin` 加到**系统 PATH**（不是用户 PATH），然后重启服务。
- 如果之前用脚本修复 PATH 时留下了一条乱码条目（如 `C:Usersyan.kimi-codein`），请去「系统环境变量 → Path」里删掉。

### 2. 点击「开始分享」报 `spawn cloudflared ENOENT`

**现象**：顶栏 🌐 →「开始分享」直接报错，提示找不到 cloudflared。  
**原因**：cloudflared 官方发布包在 GitHub Release，部分网络环境下本机无法直接下载。  
**解决**：
- 从 SourceForge 镜像下载对应版本的 `cloudflared-windows-amd64.exe`：
  ```
  https://sourceforge.net/projects/cloudflare-tunnel.mirror/files/<版本>/cloudflared-windows-amd64.exe/download
  ```
  例如 `2026.8.2` 版本：
  ```
  https://sourceforge.net/projects/cloudflare-tunnel.mirror/files/2026.8.2/cloudflared-windows-amd64.exe/download
  ```
- 下载后重命名为 `cloudflared.exe`，放到 `C:\Users\<你的用户名>\.local\bin\cloudflared.exe`。
- 代码会自动查找这个路径；也可以显式设置环境变量：
  ```powershell
  $env:CLOUDFLARED_PATH="C:\Users\<你的用户名>\.local\bin\cloudflared.exe"
  ```
- 重启看板服务。

### 3. 分享弹窗没有 Token / Token 显示「未设置 TASKBOARD_TOKEN」

**现象**：公网分享弹窗里「访问 Token」为空。  
**原因**：`TASKBOARD_TOKEN` 环境变量未设置。  
**解决**：启动服务时带上 Token：

```bash
# Git Bash
TASKBOARD_TOKEN=你的随机长字符串 node server/index.mjs
```

```powershell
# PowerShell
$env:TASKBOARD_TOKEN="你的随机长字符串"
node server/index.mjs
```

本机 `localhost` / `127.0.0.1` 访问仍免 Token；手机/公网经隧道访问时必须带 Token。

### 4. 局域网直连

分享弹窗除了公网地址，还会显示一个「局域网地址」（如 `http://192.168.1.xxx:47824`）。同一 Wi-Fi 下的设备可以直接用这个地址访问，不需要 cloudflared。

## API 一览

统一 JSON；错误格式 `{error:{code,message}}`（409 冲突附带 `current` 任务快照）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects` / POST 同路径 | 项目列表 / 新建项目 |
| PATCH/DELETE | `/api/projects/:id` | 编辑项目（名称、路径列表、主目录）/ 删除项目（仅限没有未取消任务，任务与评论级联删除） |
| GET | `/api/tasks?project_id=&status=&include_canceled=1` | 任务列表 |
| POST | `/api/tasks` | 新建任务（只能落 `backlog`/`todo`） |
| GET/PATCH/DELETE | `/api/tasks/:id` | 详情（含评论）/ 更新（乐观锁 `version`）/ 删除（仅已取消） |
| POST | `/api/tasks/batch-delete {ids}` | 批量删除（事务） |
| POST | `/api/tasks/:id/claim` | 原子认领 |
| POST | `/api/tasks/:id/comments` | 评论（`author: user\|agent`，`images` 可附图片 dataURL 数组） |
| GET | `/api/attachments/:taskId/:file` | 评论图片附件 |
| POST | `/api/tasks/:id/execute` | 拉起 Agent（`agent, mode?: execute\|qa, model?, effort?, permission?`；qa 仅待规划/待办/阻塞） |
| GET | `/api/runs` · DELETE `/api/tasks/:id/run` | 运行列表 / 停止执行 |
| GET | `/api/tasks/:id/run/output` | 运行中任务的实时输出（未在运行返回 404） |
| GET | `/api/agent-options` | 各 Agent 可选的模型/思考/权限（执行面板联动选项；模型读各家 CLI 本地配置） |
| GET | `/api/quota?refresh=1` | 三家 Agent 额度/余额（60s 缓存，`refresh=1` 强制刷新） |
| GET/PATCH | `/api/settings` | 全局设置（启用的 Agent、prompt 模板覆盖） |
| GET | `/api/prompt-defaults` | 内置 prompt 模板 + 自动认领提示词 |
| GET | `/api/tunnel` · POST `/api/tunnel/start\|stop\|restart` | 公网隧道状态与管理 |
| GET | `/api/events` | SSE（只有 `{"type":"change"}` 一种事件） |

## 开发

```bash
npm test             # node --test test/
```

结构：`server/db.mjs`（schema + 状态机 + 乐观锁，server 与 CLI 共用）、`server/api.mjs` + `server/index.mjs`（REST + 静态 + SSE + Token 认证 + 数据库文件监听广播）、`server/runner.mjs`（Agent 执行器）、`server/quota.mjs`（三家额度查询）、`server/tunnel.mjs`（cloudflared 隧道管理）、`cli/taskctl.mjs`、`public/`（无构建前端）、`skills/manage-taskboard/`（Agent 协议）、`dsh-taskpin/`（DSH 看板对接插件）。更多约定见 [AGENTS.md](AGENTS.md)。

## 灵感来源

- **[dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)** —— 看板界面和「用任务状态驱动 Agent」的工作方式，最初的灵感就来自它。借鉴点：taskctl 稳定写入接口、乐观锁版本控制、Codex thread 归属、`in_review` 必须用户验收的状态协议、本地能力与云端数据分离。状态机 `backlog → todo → in_progress → in_review → done`（分支 `blocked` / `canceled`）完整沿用。
- **[openai/symphony](https://github.com/openai/symphony)** —— OpenAI 官方的 Codex 编排器（Elixir，Apache 2.0）。借鉴点：规范优先，以及「Agent 需要用户输入时进 blocked，而不是循环重试」——本项目的 `[提问]` 评论 + 阻塞交互即源于这条思路。

本项目是参考两者思想的**零依赖自研实现**（dashi-taskboard 为 React 19 + TS + Vite 构建、未附 License；本项目为无构建 vanilla 前端 + Node 内置模块）。开发前的详细对比调研见 [RESEARCH.md](RESEARCH.md)。
