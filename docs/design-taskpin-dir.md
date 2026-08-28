# 项目主目录文件收纳进 `.taskpin/` 目录方案

> 状态：已实施（2026-08-28）。采用「按需迁移」策略（验收时触发，不扫描不相关目录）。

## 需求与动机

项目主目录根目录下的 `TASKBOARD_RULES.md` / `TASKBOARD_MEMORY.md` 改为收纳进 `.taskpin/` 子目录（与 `.claude/`、`.codex/`、`.agents/` 等工具的惯例一致），保持主目录根整洁；`.taskpin/` 同时为后续记忆索引表、归档文件（见 `docs/design-memory.md` 的 `TASKBOARD_MEMORY.archive.md`）预留位置。

目标布局：

```text
<项目主目录>/
└── .taskpin/
    ├── TASKBOARD_RULES.md    # 项目规则（人工/agent 维护，可选存在）
    └── TASKBOARD_MEMORY.md   # 项目记忆（验收时自动追加）
```

## 兼容性结论（为什么必须迁移）

现有项目主目录根已有 `TASKBOARD_MEMORY.md`（含历史验收记忆）。若只切路径不迁移，新 prompt 指引 agent 去读 `.taskpin/` 会**读不到旧记忆**，等于记忆清零。因此采用**一次性自动迁移**，本地文件移动、可逆、历史不丢。

## 改动清单

### 1. `server/db.mjs`

- 新增路径常量与解析函数，例如 `taskpinDir(mainDir)` 返回 `join(mainDir, '.taskpin')`，写盘前 `mkdirSync(dir, { recursive: true })`；
- `appendProjectMemory`（`db.mjs:169-184`）写盘点改为 `.taskpin/TASKBOARD_MEMORY.md`；
- **迁移逻辑**：在 `appendProjectMemory` 写入前（或服务启动 `openDb` 后兜底扫一次已知项目主目录——二选一，推荐前者：按需迁移，不扫描不相关的目录）检查：
  - `<主目录>/TASKBOARD_MEMORY.md` 存在且 `.taskpin/TASKBOARD_MEMORY.md` 不存在 → `renameSync` 移入；
  - `<主目录>/TASKBOARD_RULES.md` 存在且 `.taskpin/TASKBOARD_RULES.md` 不存在 → 同样移入（服务端本不读写 RULES，但顺手迁移避免 agent 读不到旧规则）；
  - 两边都存在时**不动旧文件**（避免覆盖新内容），只在日志打印一条提示由人工合并；
  - 迁移失败只打印错误，不阻断验收流转（与 append 失败处理一致）。

### 2. `server/runner.mjs`（prompt 模板文案）

四套引用改为 `.taskpin/` 路径（约 `runner.mjs:230,245,257,260`）：

- new：「若当前工作目录（项目主目录）存在 `.taskpin/TASKBOARD_RULES.md`，先通读它……若存在 `.taskpin/TASKBOARD_MEMORY.md`……」
- resume / qa / qa 收尾追加规则：同步改路径。

### 3. 测试

- `test/db.test.mjs:131`、`test/api.test.mjs:82`：断言路径改为 `.taskpin/TASKBOARD_MEMORY.md`；
- 新增迁移用例：主目录根预置旧 `TASKBOARD_MEMORY.md` / `TASKBOARD_RULES.md` → 验收任务后断言文件已移入 `.taskpin/` 且新摘要追加在其后；两边都存在时旧文件不动。

### 4. 文档同步

- `README.md`（38、93、96、132 行附近共 3~4 处）；
- `AGENTS.md`（`db.mjs` 段落与 prompt 模板段落的路径描述）；
- `skills/manage-taskboard/SKILL.md:38`；
- `docs/design-memory.md` 里的路径引用（含归档文件改为 `.taskpin/TASKBOARD_MEMORY.archive.md`）。

## 验证

- `npm test` 全绿（含新迁移用例）；
- 临时库实测：旧布局主目录（根目录放两个 md）→ 验收任务 → 文件迁入 `.taskpin/`、记忆续写不断档；
- 本仓库自身（`/Users/eric/codex-task-dashiboard` 即 Taskpin 项目主目录，根目录有真实 `TASKBOARD_MEMORY.md`）在服务下次验收时自动迁移，人工确认一次结果。

## 不做的事

- 不做双路径 fallback（迁移后 prompt 只提 `.taskpin/`，不留两套说法）；
- 不动 `.gitignore` 建议——是否把 `.taskpin/` 纳入 git 由各项目自行决定（本仓库的 `TASKBOARD_MEMORY.md` 迁移后是否继续跟踪，届时按现状保留跟踪）；
- 不迁移附件目录、tts-cache 等其他数据——它们在数据库目录下，与主目录无关。
