# Codex Task Orchestration Project Research

调查日期：2026-08-04  
调查对象：

- [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)
- [openai/symphony](https://github.com/openai/symphony)

## 摘要

两个项目都在探索如何让 Codex 围绕明确任务持续工作，但处于不同层级：

- **dashi-taskboard** 是一个面向 Codex 的本地优先任务管理系统。它提供自己的看板、数据库、CLI、Skill、Codex 桌面端嵌入和小规模云协作。
- **Symphony** 是一个以外部 Issue Tracker 为任务权威源的 Agent 编排服务。它轮询任务，为每个 Issue 创建隔离工作区，并启动、监督和重试 Codex Agent。

如果需要一个能在 Codex 旁边直接使用的任务板，dashi-taskboard 更接近成品形态。如果需要多个 Agent 持续消费团队任务并交付 PR，Symphony 的架构方向更合适。

## dashi-taskboard

### 项目定位

[dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) 不只是 Kanban UI，而是一套以 Issue 为中心的 Codex 工作流：

```text
创建 Issue
  -> 绑定仓库、Branch 或 Worktree
  -> 在 Codex 中打开任务
  -> $manage-taskboard 读取并认领任务
  -> Codex 实现、验证并记录进展
  -> 任务进入 in_review
  -> 用户验收后进入 done
```

它的差异化主要来自 `taskctl + manage-taskboard Skill + Codex thread 归属 + 状态协议`，而不是看板界面本身。

### 主要组成

| 路径 | 职责 |
| --- | --- |
| `web/` | React 19、TypeScript、Vite 前端 |
| `server/` | Node.js HTTP API、SQLite、Git 扫描和 AI Chat |
| `cli/taskctl.mjs` | Agent 和用户操作任务的 CLI |
| `skills/manage-taskboard/` | Codex 认领、更新、审核和完成任务的流程协议 |
| `inject/` | 注入 Codex 桌面端的用户脚本 |
| `scripts/codex-injector.mjs` | CDP 启动、注入和宿主消息桥 |
| `cloud/` | Cloudflare Worker、D1、R2 云协作实现 |
| `shared/` | 自动化及可视化工作流控制逻辑 |
| `test/` | API、CLI、云端、注入、AI Chat 和 UI 测试 |

### 本地架构

```text
React / Vite UI
        |
        | REST + SSE
        v
Node.js 原生 HTTP Server
   |-- SQLite
   |-- Git / Worktree 扫描
   |-- taskctl CLI API
   |-- Codex CLI 子进程
   `-- Codex 桌面端 CDP Bridge
```

服务默认运行在 `http://127.0.0.1:47823`，SQLite 数据位于 `.data/taskboard.sqlite`。开发模式下 Vite 运行在 `http://127.0.0.1:5173`。

### 云协作架构

```text
浏览器或 taskctl
        |
        v
本地 Companion
   |-- 本机项目路径映射
   |-- Git / Worktree
   |-- Codex / Skill / MCP
   `-- Basic Auth 代理
        |
        v
Cloudflare Worker
   |-- D1：项目、任务、评论和工作流
   |-- R2：附件
   `-- Static Assets：前端
```

云端以 D1 为业务数据权威源。每台设备继续在本地保存仓库绝对路径，并负责 Git、Worktree、Codex、Skill 和 MCP 能力。系统会在发送云端请求前移除 Worktree 绝对路径等机器特定信息。

### 数据模型

核心表包括：

- `projects`
- `tasks`
- `task_relations`
- `comments`
- `attachments`
- `workflow_workspaces`
- `ai_chat_threads`
- `ai_chat_runs`
- `ai_chat_events`

任务状态：

```text
backlog -> todo -> in_progress -> in_review -> done
                         |              
                         +-> blocked
                         +-> canceled
```

任务关系支持 `parent`、`blocks` 和 `related`。任务、评论和工作流通过递增 `version` 实现乐观并发控制，过期写入会返回 `409`。

### Codex 集成

项目存在两条 Codex 集成路径。

第一条是较稳定的 Skill 和 CLI 路径：

- `manage-taskboard` Skill 要求 Agent 开始前读取 Issue 和全部评论。
- Agent 使用最新版本号将 `todo` 原子地改为 `in_progress`。
- 每次并发更新都携带 `--if-version`。
- 完成实现和自验证后，Agent 添加结果评论并将任务改为 `in_review`。
- 只有用户明确验收后才能进入 `done`。
- `CODEX_THREAD_ID` 用于记录产生任务变更的 Codex 对话。

第二条是 Codex macOS 客户端注入：

- 通过独立 CDP 端口启动 Codex。
- 注册 document-start 脚本并绕过阻止 iframe 的 CSP。
- 在原生侧栏中加入 Taskboard 入口。
- 使用 iframe 覆盖主工作区。
- 通过校验 origin 和 source window 的消息桥打开原生 Codex composer。

注入没有直接修改 `ChatGPT.app` 或 `app.asar`，但仍然依赖 Codex DOM、CSP 和内部路由，客户端升级可能造成兼容性问题。

### AI Chat

项目内置一个独立的 Codex Chat 界面：

- 枚举本机可用模型、Skill 和 MCP。
- 通过 `codex exec --json` 启动和恢复 Codex thread。
- 支持 `read-only`、`workspace-write` 和 `danger-full-access`。
- 保存 thread、run 和可见事件到 SQLite。
- 将命令、文件变化、MCP 调用等 JSONL 事件转换为时间线。
- 支持中断整个 Codex 子进程组。
- `danger-full-access` 每一轮都要求重新确认。

### 可视化工作流

源码中包含基于 `@xyflow/react` 的工作流编辑器，支持触发器、Skill、MCP、API、条件分支、计划容器、Codex 审核和 Issue 更新等节点。

不过主应用当前设置了：

```ts
const SHOW_WORKFLOW_BOARD_ENTRY = false;
```

这表示工作流代码虽然规模较大，但入口仍被关闭，应视为开发中功能，而不是稳定核心能力。

### 安全边界

已实现的安全措施包括：

- 本地 AI API 只允许 loopback 请求。
- 云地址强制 HTTPS，仅 loopback 开发环境允许 HTTP。
- 云配置文件使用 `0600` 权限。
- Cloudflare 端使用 timing-safe secret comparison。
- iframe 消息校验精确 origin 和 source window。
- 云代理删除客户端伪造的身份 Header。
- Worktree 绝对路径不进入 D1。
- SQLite 开启 foreign keys、WAL 和 busy timeout。
- 前端附件大小默认限制为 25 MB。

主要风险是本地服务默认绑定 `0.0.0.0`，而 LAN 模式没有账户认证，只应在可信网络使用。

### 工程状态

调查时的仓库状态：

- 版本：`0.1.0`
- 主分支提交：`677b54451db707ae6132486b6593b7be11e4ee09`
- 最新提交：`merge: integrate cloud collaboration release`
- 提交数：76
- Stars：约 295
- Forks：约 36
- 主要贡献者：1
- 正式 Release：0
- License：未声明

核心维护风险：

- `web/src/App.tsx` 约 2,357 行。
- `AiChat.tsx` 约 2,550 行。
- `WorkflowBoard.tsx` 约 1,479 行。
- `server/app.mjs` 约 2,087 行。
- `server/database.mjs` 约 1,586 行。
- 本地 API 和 Cloudflare Worker API 存在重复业务逻辑。
- SQLite 迁移依赖启动时字段检查和 `ALTER TABLE`。
- 前端主包构建后约 554 KB，构建工具给出 chunk size 警告。
- 没有明确开源许可证，复制、修改、分发和商用授权不明确。

### 本地验证

在临时目录中使用当前 `main` 和锁文件执行了验证：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 通过 |
| TypeScript 检查 | 通过 |
| Vite 生产构建 | 通过 |
| `npm test` | 349 项中 331 通过、18 失败 |
| `npm run check` | 失败 |

失败覆盖 AI Chat、附件、云代理、Codex 注入自动化、工作流、数据迁移和若干 UI 契约。至少两份测试仍引用已经不存在的 `insertSkillMention` 导出，说明云协作合并后的实现和测试尚未完全同步。

### 适用判断

适合：

- 个人或少数开发者管理 Codex 任务。
- 实验 Issue 驱动的 Agent 工作方式。
- 接受自行维护 Codex 桌面注入兼容性。
- 两个可信协作者通过 Cloudflare 共享任务。

暂不适合：

- 需要 RBAC、SSO、审计和组织隔离的团队。
- 需要稳定升级和数据迁移保证的核心任务系统。
- 需要明确商业授权的产品。
- 无人值守且要求高可靠性的 Agent 调度平台。

## OpenAI Symphony

### 项目定位

[OpenAI Symphony](https://github.com/openai/symphony) 是一个 Codex Agent 编排服务。它持续监控外部项目管理系统，为符合条件的 Issue 创建隔离工作区，并启动 Agent 自主完成实现、验证、PR 和交付流程。

```text
Linear / GitHub / Jira / Asana / GitLab
                  |
                  | 定时轮询
                  v
          Symphony Orchestrator
                  |
          状态、标签、阻塞和容量检查
                  v
       每个 Issue 一个隔离 Workspace
                  |
          初始化 hooks / clone
                  v
          Codex app-server Session
                  |
          连续执行多个 turn
                  v
       commit / push / PR / 验证 / 评论
                  |
                  v
          人工审核 / 合并 / Done
```

Symphony 不提供自己的任务数据库。外部 Issue Tracker 是任务状态权威源，Workspace 是执行产物载体，运行调度状态主要存在于内存中。

### 规范优先

项目最重要的产物不是 Elixir 实现，而是约 9 万字节的语言无关 `SPEC.md`。规范定义了：

- 领域模型和稳定标识符。
- `WORKFLOW.md` 配置格式。
- 调度状态机。
- 轮询、并发、重试与运行协调。
- Workspace 生命周期和文件系统安全。
- Coding Agent app-server 协议。
- Tracker Adapter 契约。
- Prompt 构造。
- 日志、指标和可观测性。
- 故障恢复、安全边界和一致性要求。
- 实现符合性检查清单。

仓库明确鼓励使用者根据 `SPEC.md` 用其他语言实现自己的 Symphony。Elixir 版本是实验性参考实现。

### `WORKFLOW.md` 契约

每个接入仓库通过 `WORKFLOW.md` 定义运行方式：

```md
---
tracker:
  kind: linear
  provider:
    project_slug: "..."
workspace:
  root: ~/code/workspaces
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex app-server
---

You are working on {{ issue.identifier }}.

Title: {{ issue.title }}
Body: {{ issue.description }}
```

YAML front matter 是服务配置，Markdown 正文是 Agent Prompt。配置支持动态重载；如果新文件无效，服务保留最后一份有效配置并持续记录错误。

### Elixir/OTP 架构

参考实现选择 Elixir、BEAM 和 OTP，核心原因是需要监督大量长时间运行的 Agent：

- `Orchestrator` 使用 `GenServer` 维护轮询和运行状态。
- `TaskSupervisor` 管理 Issue Worker。
- `AgentRunner` 管理单次 Issue 执行。
- `Codex.AppServer` 处理 Codex app-server JSON-RPC/事件流。
- `Workspace` 管理本地或远程隔离目录。
- Tracker Adapter 统一不同项目管理系统。
- Phoenix LiveView 提供可选观察面板。

该选择适合大量并发、进程监控、故障隔离和不中断热重载，但对不熟悉 Elixir/OTP 的团队有明显学习成本。

### 调度与恢复

核心调度行为包括：

- 周期性轮询 Tracker 活跃状态。
- 根据状态、标签、负责人、优先级和阻塞关系决定是否分发。
- 支持全局最大并发 Agent 数。
- 支持本地和 SSH Worker 容量分配。
- 同一 Issue 同时只能有一个活跃执行。
- Issue 离开活跃状态时停止 Agent。
- Issue 进入终态时停止 Agent 并清理 Workspace。
- 正常结束但 Issue 仍活跃时启动 continuation。
- 失败使用指数退避，基础延迟约 10 秒。
- 检测长时间没有事件的 stalled session 并重启。
- Agent 明确需要用户输入时进入 blocked，而不是循环重试。
- 服务启动时清理已处于终态的遗留 Workspace。

服务没有持久化作业队列的精确恢复语义。重启后依靠 Tracker 当前状态和已有 Workspace 重新协调，因此 Issue Tracker 必须保持为权威来源。

### Codex app-server 集成

Symphony 使用 `codex app-server`，而不是只执行一次 `codex exec`：

- 初始化长期 Codex session。
- 为 Issue 创建或继续 thread。
- 流式接收 turn 和工具事件。
- 一个 Agent invocation 最多连续执行 `max_turns` 个 turn。
- 记录 Token、运行时间和 Rate Limit。
- turn timeout 以“没有收到流式更新的时长”计算，而非总运行时长。
- 默认使用 `workspace-write`。
- 默认拒绝沙箱提权、规则修改和 MCP elicitation。
- 显式沙箱策略可直接透传给 Codex app-server。

### Tracker Adapter

当前实现支持：

- Linear
- GitHub Issues
- Jira Cloud
- Asana
- GitLab

Adapter 负责查询、分页、状态规范化、阻塞关系和路由判断，并向 Agent 暴露宿主侧工具：

- `linear_graphql`
- `github_api`
- `jira_rest`
- `asana_api`
- `gitlab_api`

认证信息保留在 Symphony 宿主侧，不进入 Codex 子进程环境。这是一个重要的安全边界。不过原始 Tracker 工具的实际访问范围仍由 Token 权限决定，因此必须使用最小权限凭证。

### 默认交付状态机

仓库自带的 `WORKFLOW.md` 定义了完整开发交付流程：

```text
Backlog
  -> Todo
  -> In Progress
  -> Human Review
  -> Merging
  -> Done

Human Review
  -> Rework
  -> 创建新分支并从头执行
```

Agent 在 Issue 中维护唯一的 `## Codex Workpad` 评论，用于记录：

- 分层实施计划。
- 验收条件。
- 测试和验证结果。
- Workspace、主机和提交信息。
- 进展和疑点。

进入 `Human Review` 前要求：

- PR 已关联到 Issue。
- 分支已经推送。
- 必需验证已经通过。
- PR Checks 为绿色。
- 所有人工或机器人反馈已处理或明确回复。
- Workpad 中的计划、验收和验证与实际结果一致。

人工批准后将 Issue 改为 `Merging`，Agent 使用专用 `land` Skill 完成合并，再进入 `Done`。

### Workspace 和 Worker

每个 Issue 使用独立 Workspace。`hooks.after_create` 可以 clone 仓库、安装依赖或执行其他初始化操作。

规范要求：

- Workspace 路径必须由经过清理的 Issue 标识符生成。
- 删除目录前必须验证目标位于配置的 Workspace Root 内。
- 不能允许路径遍历或删除根目录。
- Hook 在 Workspace 内运行。
- 终态任务的 Workspace 可以被清理。

参考实现还支持 SSH Worker，可以把 Agent 调度到远程主机。官方 E2E 能使用 Docker 启动临时 SSH Worker，挂载本机 Codex 认证并执行真实调度流程。

### 可观测性

可选 Phoenix LiveView 服务提供：

- 当前运行、等待、阻塞和重试的 Issue。
- Agent session、Worker Host 和 Workspace。
- 最近 Codex 事件。
- Token 使用量和运行时间。
- Codex Rate Limit。
- `/api/v1/state`。
- `/api/v1/<issue_identifier>`。
- `/api/v1/refresh`。

它是观察和诊断面板，不是任务编辑器。

### 安全和运维边界

Symphony 明确假定运行在可信环境，并在 README 中标注为 engineering preview。

主要安全设计：

- Tracker Token 保留在宿主侧。
- 注入 Codex 子进程的环境会移除相关 Token 变量。
- Workspace 有路径安全约束。
- 默认 Codex 权限和沙箱策略较保守。
- Issue 状态变化会停止不再应该运行的 Agent。
- 需要输入的 Agent 会阻塞而不是无限重试。

主要风险：

- `WORKFLOW.md` Hook 本质上是宿主命令执行。
- Tracker 原始 API 工具可能拥有超过当前项目的访问权。
- Prompt、Issue 内容和仓库代码均可能影响 Agent 行为。
- 没有持久化任务队列，重启后的恢复依赖外部状态协调。
- 自主推送、开 PR 和合并要求仓库拥有非常成熟的测试和权限治理。

### 工程状态

调查时的仓库状态：

- 创建时间：2026-02-26
- 版本：`v0.0.2`
- 默认分支最新提交：`f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7`
- 提交数：43
- Stars：约 26.4k
- Forks：约 2.7k
- Contributors：11
- Releases：2
- License：Apache 2.0
- 主要语言：Elixir，约 96.7%
- 支持 macOS/Linux、ARM64/x86_64 二进制发布

工程治理包括：

- 版本化二进制 Release 和 SHA-256 文件。
- GitHub Actions。
- ExUnit 测试。
- Credo 严格检查。
- Dialyzer 配置。
- `make all` 统一验证入口。
- 100% 覆盖率阈值配置，部分集成和边界模块排除在统计外。
- 可选真实 Linear、Codex、SSH、GitHub、Jira、Asana 和 GitLab E2E。

### 验证限制

本次可以通过 GitHub API 和 Raw Content 读取 README、`SPEC.md`、`WORKFLOW.md`、`mix.exs` 和关键 Elixir 模块。

但当前网络下载速度约为 10 KB/s，Git clone 和 GitHub tarball 下载均超时，因此没有在本地执行：

```bash
cd elixir
make all
```

不能据此断言当前主分支测试全部通过。仓库的测试策略、覆盖范围和 Release 信息来自源码与 CI 配置，而非本地复现结果。

### 适用判断

适合：

- 已有成熟 CI、测试、代码审查和 Issue 规范的团队。
- 希望多个 Agent 持续消费 Linear、GitHub、Jira 等任务。
- 接受将 Agent 执行放入隔离 Workspace。
- 有能力维护权限、Worker 和故障恢复策略。
- 希望参考一份语言无关的 Agent Orchestrator 规范。

暂不适合：

- 缺少可靠测试和自动化交付体系的仓库。
- 需求和验收标准不清晰的团队。
- 需要强持久化队列和精确一次执行语义的系统。
- 不愿让 Agent 自主 push、开 PR 或操作 Tracker 的环境。
- 需要即装即用任务看板的个人用户。

## 横向比较

| 维度 | dashi-taskboard | OpenAI Symphony |
| --- | --- | --- |
| 核心定位 | Codex 任务看板 | Codex Agent 编排器 |
| 权威任务源 | 自带 SQLite 或 D1 | 外部 Issue Tracker |
| UI | 完整任务管理 UI | 运维和观察面板 |
| CLI | `taskctl` | Symphony 服务 CLI |
| Agent 协议 | `manage-taskboard` Skill | `WORKFLOW.md` + Codex app-server |
| 隔离执行 | 可绑定 Branch 或 Worktree | 每个 Issue 独立 Workspace |
| 并发 Agent | 辅助能力 | 核心能力 |
| Tracker 支持 | 自有任务系统 | Linear、GitHub、Jira、Asana、GitLab |
| Codex 桌面注入 | 有 | 不需要 |
| 云端 | Cloudflare D1/R2 | Tracker 和代码托管平台本身 |
| 恢复方式 | SQLite/D1 持久化 | Tracker + Workspace 协调 |
| 主要语言 | JavaScript/TypeScript | Elixir |
| License | 未声明 | Apache 2.0 |
| 当前成熟度 | 社区早期原型 | 官方工程预览 |

## 选择建议

选择 dashi-taskboard，当目标是：

- 在 Codex 旁边获得一个轻量任务板。
- 自己维护项目、Issue、评论和附件。
- 个人或少数可信协作者使用。
- 希望直接从任务进入 Codex 对话。

选择 Symphony，当目标是：

- 让多个 Codex Agent 持续消费团队 Issue。
- 每个 Issue 使用独立执行环境。
- 自动完成实现、验证、PR 和审核前准备。
- 继续使用现有 Linear、GitHub、Jira、Asana 或 GitLab。
- 将工程师工作方式从“监督 Agent”提升为“管理待完成工作”。

也可以组合两者的思想，但没有必要直接同时部署：使用 Symphony 时外部 Tracker 已经承担任务权威源；使用 dashi-taskboard 时再引入 Symphony 需要先实现新的 Tracker Adapter，并解决两套状态机的所有权冲突。

## 总结

dashi-taskboard 最值得借鉴的是：

- `taskctl` 稳定写入接口。
- 乐观版本控制。
- Codex thread 归属。
- `in_review` 后必须由用户验收的状态协议。
- 本地能力和云端业务数据的明确分离。

Symphony 最值得借鉴的是：

- 规范优先的 `SPEC.md`。
- 仓库级 `WORKFLOW.md` 契约。
- 外部 Tracker 作为权威状态源。
- 每个 Issue 一个 Workspace。
- OTP Supervisor 驱动的 Agent 生命周期。
- 宿主侧执行带凭证的 Tracker 工具。
- 状态变化、重试、阻塞和终止的明确协调规则。

现阶段，dashi-taskboard 更适合试用和产品交互探索；Symphony 更适合作为团队级 Agent 编排架构的参考或可信环境中的受控实验。
