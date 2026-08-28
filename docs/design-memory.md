# 项目记忆架构调研与推荐方案

> 调研日期：2026-08-28。结论：保持文件式记忆路线，在其上补「索引 + 检索 + 遗忘」三层；不引入外部记忆服务/向量库。一期（索引+检索）与二期（遗忘）已实施（2026-08-28）；三期巩固未做。

## 背景与现状

Taskpin 的项目记忆现状：

- 任务验收进 `done` 时，`server/db.mjs` 的 `appendProjectMemory` 把任务摘要按固定结构追加到**项目主目录** `.taskpin/` 下的 `TASKBOARD_MEMORY.md`（2026-08-28 起收纳进 `.taskpin/`，旧布局按需自动迁移）；
- 执行/问答 prompt 约定 agent 开工前全量读该文件；
- 纯追加、无轮转/截断/归档——只增不减（调研时 14 条 / 36KB，单次执行全量读入约占一万多 token）。

需求约束：**同一项目下的任务共享项目记忆，不同项目之间不共享**。

## 业界记忆架构路线对比

| 路线 | 代表 | 核心思想 | 对本项目的适配度 |
| --- | --- | --- | --- |
| 文件/Markdown 记忆 | Claude Code `CLAUDE.md`、Anthropic memory tool、`MEMORY.md` | 纯文本文件 + 渐进披露（先看索引、按需读详情），用户可读可改可 git 管理 | ★★★★★ 现状就是，零成本演进 |
| 虚拟内存分页 | Letta (MemGPT) | 上下文当 OS 内存页：core/recall/archival 三层换入换出 | ★★ 要整套 runtime，杀鸡用牛刀 |
| 向量抽取式 | Mem0 | 每次写入走 LLM 抽取事实 → 向量库；检索语义+BM25 混合 | ★★ 抽取链路贵且依赖 embedding 服务 |
| 时序知识图谱 | Zep/Graphiti | 实体-关系图 + 边失效机制，适合「事实会过期」的多租户场景 | ★ 单人看板用不上 |
| 卡片盒笔记 | A-MEM | 记忆间自动建语义连接 | ★★ 思想可借鉴，实现过重 |

关键数据点：

- Letta 自己的评测里，纯文件系统 agent（GPT-4o-mini）在 LoCoMo 基准拿 74.0%，反超 Mem0 最强图谱变体（68.5%）；Anthropic 2025-09 的官方 memory tool 本身就是文件目录，不是向量库；
- Claude Code 的记忆设计明确选择纯文本 Markdown：牺牲表达力换可审计性（用户能读、能改、能版本管理 agent 看到的一切）；
- 记忆系统标准生命周期是 `编码 → 存储 → 检索 → 巩固 → 遗忘`（Generative Agents 及后续综述），本项目目前只有前两环。

## 项目隔离设计

多租户记忆隔离的业界标准做法是 namespace/scoping：

- Mem0 用四级 scope（`user_id`/`agent_id`/`run_id`/`app_id`），每次 add/search 强制携带，scope key 必须来自服务端鉴权层、不能信客户端传参；
- 向量库层面用 namespace / collection / 物理隔离三档；Engram 用「每团队/项目一个 scoped collection」，LangGraph store 用 namespace 隔离。

映射到本项目：**`project_id` 就是天然的 tenant key**。现状记忆按主目录物理隔离（各项目主目录各自 `.taskpin/` 下的 `TASKBOARD_MEMORY.md`），比 namespace 过滤更彻底——连「过滤条件写错导致串租户」的风险都没有。**隔离层面不需要改**，推荐方案的索引表沿用同一原则：所有记忆查询强制带 `WHERE project_id = ?`，scope 由服务端从任务记录解析，不接受调用方传入。

## 可行性实测（零依赖约束下）

铁律约束：零 npm 依赖 + `node:sqlite`。实测（Node 23.10）：

- ❌ 内置 SQLite **没编译 FTS5**（`CREATE VIRTUAL TABLE ... USING fts5` 报 `no such module`）——全文检索不能靠数据库自带功能；
- ✅ 但记忆语料极小（14 条/36KB；500 条也才 1MB 级），BM25 用几十行 JS 全量打分是毫秒级，**不需要向量库也不需要 FTS5**；
- ⚠️ 向量化需 embedding 模型：本地跑要引依赖（违反铁律），走 HTTP API 引入外部服务依赖与 token 成本。此语料规模下关键词匹配（自实现 BM25）足够，语义检索是过度设计。

## 推荐方案：文件式记忆 + 三层增强

保持 `.taskpin/TASKBOARD_MEMORY.md` 文件式记忆不动，在其上加「索引 + 检索 + 遗忘」三层，全部在现有零依赖栈内实现：

### 一期：索引 + 检索（收益/成本比最高的一步）

- **存储层**：新增 `memories` 表（`id, project_id, task_id, summary, created_at, archived`），验收时与写 md 文件同事务落库（`appendProjectMemory` 里一并写）；`project_id` 列为隔离边界。
- **检索层**：`taskctl memory search <关键词>` + 执行 prompt 注入改为「最近 N 条全文 + 检索命中条」替代全量读文件；自实现 BM25（JS 全量算分）。md 文件继续写——它是人类可读的权威副本，索引表是检索加速器，两者以索引表为准做查询、以 md 做审计。

### 二期：遗忘（防无限膨胀）

- 保留最近 N 条全文，超出部分折叠为一行摘要归档到 `.taskpin/TASKBOARD_MEMORY.archive.md`；
- 检索评分加时间衰减：`score = bm25 × decay(t)`（`decay` 取指数衰减，对应业界 `relevance × importance × decay(t)` 的简化版；个人场景 importance 恒 1 即可）。

### 三期（可选）：巩固

- 定期让 agent 把多条相关记忆合并成一条「经验条目」（Generative Agents 的反思机制）。要写库依赖 agent 参与，引入不确定性，观察一二期效果后再定。

## 明确不做

- 不引入 Mem0/Zep 等外部记忆服务、不引向量库——单人、语料 KB~MB 级，它们解决的扩展性/多租户/事实过期问题本项目都不存在，还会破零依赖铁律；
- 不做跨项目共享记忆——需求明确要求项目间隔离，架构上也不留这个口子；
- 不做记忆的手工编辑 UI——md 文件本身就是编辑入口。

## 参考来源

- [AI Agent 记忆系统综述（JavaGuide）](https://javaguide.cn/ai/agent/agent-memory.html)
- [AI Agent Memory in 2026: Vector DBs vs MEMORY.md vs Graphs](https://www.jakecuth.com/work/agent-memory-lab/)
- [Mem0 多级记忆 scoping](https://mem0.ai/blog/multi-agent-memory-systems)
- [长期记忆落地指南：multi-user/namespace scoping（Atlan）](https://atlan.com/know/how-to-implement-long-term-memory-ai-agents/)
- [Mem0 vs Letta vs Zep vs Cognee 对比](https://menuagentic.com/blogs/mem0-vs-letta-vs-zep-vs-cognee/)
- [多 agent 共享记忆实现（AI Memory Works）](https://aimemoryworks.com/memory-types/shared-memory/)
- [Claude Code 架构报告（记忆系统设计哲学）](https://zhiqiangshen.com/projects/Claude_Code_Report/Claude_Code_Report.pdf)
- [Mem0 vs Letta 架构对比](https://vectorize.io/articles/mem0-vs-letta)
