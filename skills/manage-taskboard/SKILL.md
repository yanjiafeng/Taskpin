---
name: manage-taskboard
description: 从本地任务看板（taskboard）认领、执行并交付任务。当用户让你"去看板领任务"、"做看板上的任务"、"更新看板任务状态"或提到 taskboard / taskctl 时使用。协议：读任务 → 原子认领 → 实现并自验证 → 评论结果 → 置 in_review 等待用户验收。
---

# manage-taskboard

你通过一个本地任务看板与用户协作。看板的权威数据在 SQLite，所有操作通过 `taskctl` CLI 完成：

```bash
node /Users/eric/codex-task-dashiboard/cli/taskctl.mjs <command>
```

（下文将这条命令简写为 `taskctl`。若项目已移动，以用户告知的路径为准。）

所有命令默认输出 JSON。失败时 stderr 输出 `{"error":{"code","message"}}` 且退出码非零。

## 工作流程

1. **挑选任务**：`taskctl list --status todo`。
   用户指定了任务 ID 时直接用该 ID。一次只认领一个任务。

2. **完整阅读**：`taskctl show <id>`。
   必须读完标题、描述和**全部评论**再动手。评论里可能有验收标准和前轮进展；评论的 `images` 字段是图片附件的绝对路径（用户粘贴的截图等），需要时用读图工具查看。

3. **原子认领**：`taskctl claim <id>`。
   - 成功：任务变为 `in_progress`，返回里的 `version` 记好，之后所有更新都要带它。
   - 失败（`CLAIM_CONFLICT`）：任务已被认领或状态不对，**放弃它**，换下一个任务，不要强行更新。
   - 如果你的运行环境提供会话/线程 ID，用 `taskctl claim <id> --thread-id <你的thread id>` 记录归属。

4. **验收标准检查（开发类任务铁律）**：若任务涉及代码改动/功能实现/文件产出，描述中必须有「验收标准」。没有就**不要开始实现**：
   ```bash
   taskctl comment <id> --body "[提问] 任务缺少验收标准，我建议：1. …；2. …；3. …。请确认或修改" --author agent
   taskctl update <id> --status blocked --if-version <version>
   ```
   主动给 2-4 条可验证的标准草案（如"运行 X 命令输出 Y"），等用户确认。拿不准算不算开发类时宁问勿猜；纯调研/问答类不强制。

5. **开工确认（开发类任务铁律）**：开发类任务，只有任务描述或用户评论中明确出现「开工」二字时才允许开始实现。还没有就**不要动手**：
   ```bash
   taskctl comment <id> --body "[提问] 实现计划：1. …；2. …。确认请回复「开工」" --author agent
   taskctl update <id> --status blocked --if-version <version>
   ```
   与验收标准同时缺失时合并成一条 [提问] 一次问清；用户答复「开工」后（答复会触发续跑）再动工；纯调研/问答类不受限。

6. **实现并自验证**：在任务描述指定的仓库/路径中完成实现，运行相关测试与检查；开发类任务须对照描述中的「验收标准」**逐条验证**。项目主目录若存在 `.taskpin/TASKBOARD_RULES.md`（项目规则）/`.taskpin/TASKBOARD_MEMORY.md`（已验收任务记忆），动手前先读；记忆也可用 `taskctl memory search <关键词>` 检索（BM25 + 时间衰减）。

7. **交付（不自判完成）**：
   ```bash
   taskctl comment <id> --body "<结果摘要：改了什么、验证结果、验收标准逐项核对、遗留疑点>" --author agent
   taskctl update <id> --status in_review --if-version <version>
   ```
   评论要包含：变更摘要、执行的验证命令及结果、验收标准逐项核对、未解决的疑点。

8. **遇到阻塞**：确实无法继续（缺信息、缺权限、外部依赖失败）时：
   ```bash
   taskctl comment <id> --body "<阻塞原因，需要什么帮助>" --author agent
   taskctl update <id> --status blocked --if-version <version>
   ```

9. **需要用户决策（提问）**：信息不全或有多个合理方案时，**不要猜测**。以 `[提问]` 开头评论，列出问题和可选方案，然后置 `blocked` 等答复：
   ```bash
   taskctl comment <id> --body "[提问] <问题>；方案 A：…；方案 B：…；你倾向哪个？" --author agent
   taskctl update <id> --status blocked --if-version <version>
   ```
   用户会在评论里答复并把任务移回 `todo`（或在抽屉里点「提交并继续」直接续跑你）；再次被调度时先 `show` 读答复再继续。

## 工作目录与查找范围

- `taskctl show <id>` 的返回中带 `project_name` 和 `project_paths`（数组）：**优先在这些路径下定位仓库工作**。
- `taskctl projects` 列出用户配置的全部项目路径，这是你的默认查找范围——任务没指明代码位置时，在这些路径下定位相关仓库。
- 查找范围是提示，**不是沙箱边界**：任务确实需要时，可以在这些路径之外读写，但交付评论里要说明实际工作的位置。

## 铁律

- **永远不要**把任务置为 `done`（`taskctl done` 和 `--status done` 都禁止）。`done` 只能由用户验收后操作。系统也会拒绝 Agent 的 done 请求。
- 认领前必须完整 `show`；不要只看标题就动手。
- 更新必须带 `--if-version`。出现 `VERSION_CONFLICT` 时先重新 `show`，基于最新 version 重试；连续冲突则放弃并报告用户。
- 不要并发认领多个任务；做完一个交付一个。
- 验收被打回（`in_review → in_progress`；用户也可能把待验收任务手动退回 `todo`/`backlog` 重新规划）时，先读新评论里的反馈意见，修复后重新走交付流程。
