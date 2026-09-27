# VIDT Agent Notes 契约

> **状态：正式（Accepted）** — 决策见 `docs/decisions/vidt-agents-notes-namespace-brief.md` 采纳 **方案 B**。  
> **目的**：补全开发过程中的**决策流程**——把「为什么选这条路径 / 放弃了什么 / 边界在哪」固化成可检索、可治理的笔记，而不是散落在对话、`decision-log.jsonl` 的短 `reason`、或被下一轮覆盖的 round memory。  
> **对标**：deepseek-harness `.agents/notes`（lifecycle 路径 + 封闭分类 + supersession + 冻结归档）。

---

## 1. 根目录与唯一解析

**唯一根**：目标项目 **canonical state-root** 下的

```text
<state-root>/.agents/notes/
```

- 与 `.vidt/` **共用同一 state-root**，由 `resolve_repository_roots()`（`route_request.py`）解析主 worktree；**禁止**在 linked worktree 或执行 cwd 另建第二份 notes。
- 相对路径一律锚定 state-root，不锚定进程 cwd（与 `completion-evidence` 等共享状态同一约定）。
- **`.vidt` 不改名**：长期作为 VIDT **机器状态**专名；不设 `.vidt` ↔ `.agents` 双读兼容期。若曾试写 `.vidt/notes/`，由落地者一次性迁到 `.agents/notes/` 并修复链接，此后只认新路径。

---

## 2. 与 `.vidt/` 的归属边界（真源表）

| 表面 | 回答的问题 | 形态 | 可变性 |
|---|---|---|---|
| `.vidt/metrics/decision-log.jsonl` | **何时、谁、哪条轨道、通过/持有** | Schema 约束的 append-only JSONL | 只追加，不改历史 |
| `.vidt/metrics/telemetry.jsonl` | 运行轨迹与探测 | 事件流 | 只追加 |
| `.vidt/evidence/` | **凭什么**过门禁 | 证据文件 + digest | 按门禁协议更新 |
| `.vidt/iterations/` | **本轮**工作记忆、待办、临时结论 | round-memory / distilled-patterns | 高频覆写 |
| `.vidt/context/project-context.md` | 项目稳定事实与约束 | 短文档 | 少改 |
| **`.agents/notes/`（本契约）** | **为什么**这样定、放弃了什么、何时再议 | 决策笔记（见 §4） | 生命周期迁移，不改写决策本身 |
| `project-memory-lite` | 跨任务可复用锚点 | 摘要 | 按巩固协议 |

**硬边界**

1. **Notes 不承载机器门禁状态。** ship/hold、allowed/blocked 仍以 `decision-log` + `evidence` + release gate 为准；笔记只解释裁决理由与长期约束。
2. **Notes 不写瞬时状态。** 「当前进度、还差哪步、轮次结论」进 `.vidt/iterations/`；笔记只保留跨轮仍成立的决策。
3. **Notes 不直接改 active 技能/生产代码语义。** 它是决策语料，不是 mutation 控制面。
4. **决策 log 与 notes 单向引用为主。** 笔记可引用 `decision-log` 条目/证据路径；log 侧仅可选 `note_ref`，不把正文塞进 JSONL。
5. **跨树引用可机检。** 指向代码/文档的相对链接必须存在；指向 **`.vidt/`** 的路径是**本地状态指针**，允许在他人克隆中不存在（校验降为 warning），笔记正文宜用代码样式路径（如 `.vidt/evidence/completion-evidence.json`）而非硬依赖的死链。
6. **归属不混淆**：`.vidt` = 机器状态；`.agents/notes` = 决策语料。不在 notes 里复制 gate 结果字段作为权威。

### 2.1 版本控制边界（强制）

| 路径 | 是否随代码提交 | 说明 |
|---|---|---|
| **`.vidt/`** | **否** | **本地运行过程产物**：decision log、telemetry、evidence、iterations、harness/delivery/handoff 等。目标仓库 `.gitignore` 应含 `.vidt/`（或 `**/.vidt/`）。**禁止**把 `.vidt/` 树当作交付内容推入版本库。 |
| **`.agents/notes/`** | **是** | **可版本化的决策语料**；与实现同一变更提交（见 §7）。 |
| 源码 / 评测 / 文档 | 是 | 常规交付物。 |

- 审计需要留痕时，把**结论**写成 Agent Note（可提交），而不是提交整棵 `.vidt/`。
- `verify_agent_notes.py` 会检测 `git ls-files` 是否错误跟踪了 `.vidt/` 下文件并 **fail closed**。
- 跨 clone 分享证据请导出摘要/哈希进笔记或独立证据包，而不是提交 `.vidt/` 原树。

---

## 3. 目录布局

```text
<state-root>/.agents/notes/
  README.md                 # 本契约在项目内的副本或链接
  proposed/                 # 已提出、未落地（或部分落地）
  implemented/              # 决策已生效并随交付落地
  rejected/                 # 考虑过但否决；仅当能防再犯时保留
  archived/                 # 冻结历史归档（只进不出，append-only manifest）
    manifest.json
    <class>/...
  <lifecycle>/<class>/yyyy-mm-dd-topic-slug.md
```

- **路径即元数据**：`{lifecycle}/{class}/{date}-{slug}.md`，不另建 `INDEX.md`。
- **日期** = 议题首次提出的日期。
- **交叉引用**使用**相对 markdown 链接**，禁止裸编号/口语指代。
- **skill 自身**的演进决策写在 skill 仓库与 issue，不与**目标项目** notes 混写。

### 3.1 分类封闭集（`class`）

| class | 覆盖 |
|---|---|
| `architecture` | 已交付源码的结构性决策：模块边界、真源、依赖方向 |
| `process` | 工作流与治理：门禁、worktree/状态根、发布策略、角色分工 |
| `scope` | 范围裁定：做/不做、slice 切法、明确放弃的方案与原因 |
| `verification` | 验证策略：证据标准、为何 hold、人工 vs 自动、回归口径 |
| `risk` | 风险与安全边界：接受的残余风险、禁止路径、恢复条件 |
| `feature` | 新能力的产品/接口语义（非实现细节） |
| `bug-fix` | 缺陷的根因判定与「为何这样修、不那样修」 |
| `simplification` | 删除/收敛的决策（减面、合并、降级） |

新增 class 必须同步改契约与校验脚本的封闭集；禁止自创文件夹。`refactor` 故意不设。

---

## 4. 生命周期

```text
proposed ──────────────► implemented ──► archived
   │                         │
   │                         ▼
   └─────────────► rejected  （仅当仍能阻止诱人错误）
```

| 状态 | 进入条件 | 退出 |
|---|---|---|
| `proposed/` | 重大决策未实施，或仅部分实施 | 落地 → `implemented/`；废弃 → `rejected/`（写诚实原因） |
| `implemented/` | 决策已生效且事实与代码一致 | 几乎不再指导 → `archived/`；完全被取代 → 可合并删除（§6） |
| `rejected/` | 已评审否决 | 仅当失去「防再犯」价值时删除 |
| `archived/` | 完整、历史有价值、未来指导弱 | **永不修改**；不作为现行权威 |

**规则**

- **Proposed 不进 archived。** 过时提案改为 `rejected` 并写原因。
- **Implemented 与实现同步：** 路径/默认值/所有权变了，在同一变更里改「事实」，**不改「决策」**；推翻决策必须新建笔记并交叉链接。
- **Archived 冻结：** 不编辑、不移动、不删除、不当现行依据；`manifest.json` 追加记录。
- **不按字数/年龄/配额归档**，按「未来决策价值」语义判定。

---

## 5. 文件格式（单篇）

```markdown
# Agent Note: <标题>

Status: proposed | implemented | rejected — <一句话状态说明>
Archived: <仅 archived 时 YYYY-MM-DD>

## Problem
要解决什么、为何现在必须定。

## Decision   （rejected 时改为 Proposal）
选了什么；关键机制/边界/所有权。

## Alternatives considered
放弃了什么、为何不够好（可并列多条）。

## Consequences
接受的代价、后续约束、再议条件（reintroduction / reopen）。

## Verification   （可选）
如何证明该决策被遵守（测试、门禁、命令）。
```

- **语种**：首期**中文单文件**；后续若引入中英配对再扩三元组。
- **Status 行必填**；`rejected` 的 Status 须带简短理由。
- 实现细节只写到「能理解决策与边界」为止。

---

## 6. 何时写 / 不写

**同一次变更内写**（实现与笔记一并进入交付物；见 §7 worktree 交付）：

- 影响后续多轮工作的：范围裁定、验证标准、状态根/门禁约定、安全边界、为何 hold/砍掉某条路径。
- 代码、测试、现有文档**说不清 why** 时。

**不写**：

- 机械改名、局部 UI、一次性排查记录。
- 已有 owning note 时——应**更新**那篇，不新开重复决策。
- 纯瞬时进度、待办、本轮打分。

**取代与合并**

- 决策被推翻：新 note + 双向链接，旧文不改写成相反含义。
- 旧 note **完全**被吸收：迁移独有理由/反例/约束后可删除并修链接；**部分**取代则两篇都留、交叉链接。

---

## 7. Worktree 与版本控制交付（强制）

笔记写在 **state-root（主 worktree）**。linked worktree 上跑工作流时：

1. **禁止**在执行 worktree 下新建 `.agents/notes/` 副本；一律写 `resolve_repository_roots(execution_root)["state_root"]` 下的唯一树。
2. **「与实现同一变更提交」按写入位置解释：**
   - 若执行工作发生在**主 worktree**：笔记与代码同变更进入该 worktree 的提交。
   - 若执行发生在**linked worktree**：笔记落在主 worktree 的工作区，**不会**自动进入执行 worktree 的提交。此时交付方必须显式其一：
     - 在主 worktree 对 notes 做一次独立提交/随交付 PR 合入；或
     - 在交付说明中声明 notes 路径与 commit，由合并方纳入。
   - **禁止默认「已经随代码提交」**。验收时检查：`status: implemented` 的笔记必须能指出其**版本控制来源**（commit 或明确的未提交工单）。
3. 临时实验笔记不得只存在于执行 worktree 且无人合并——否则视为未交付，不得标记 implemented。

---

## 8. 与 decision-log / 工作流的挂接

| 工作流节点 | 动作 |
|---|---|
| 路由 / 意图确认 | 仅当产生**长期**轨道/所有权约定时写 `process`/`scope` |
| 多专家审查（P0/P1/P2） | 被采纳的范围裁定与「明确不做」→ `scope`/`risk` |
| release gate **hold/ship** | hold 根因与证据标准 → `verification`；ship 接受风险 → `risk` |
| beta / post-release | 归因与再议条件 → `bug-fix`/`verification` |
| 迭代结束 | `.vidt/iterations/` 中**跨轮仍成立**的结论升级为 note |

### 8.1 最小闭环挂接（防丢 why）

下列事件若产生**跨轮仍成立**的结论，工作流应在 `recommended_next_step` 中提示（不强制造空笔记）：

| 事件 | 建议 class | 建议路径模板 |
|---|---|---|
| `release-hold` / 完成证据不足 | `verification` | `.agents/notes/proposed/verification/<date>-release-hold-<slug>.md` |
| 砍范围 / 明确不做 | `scope` | `.agents/notes/implemented/scope/<date>-cut-<slug>.md` |
| 否决方案（防再犯） | `process`/`architecture` | `.agents/notes/rejected/<class>/<date>-reject-<slug>.md` |
| 接受残余风险 / 安全边界 | `risk` | `.agents/notes/implemented/risk/<date>-accept-<slug>.md` |
| 迭代结束升级结论 | 按主题 | 由 round-memory 升级，`implemented/` |

`verify_action` 在相关 check **失败**时返回顶层字段 `recommended_agent_note`（模板路径；与 `recommended_next_step` 同级，不放在 `details` 内，以免破坏各 check 的封闭 details schema）。  
`check=release-gate` 只回答「是否需要跑门禁」，**不是** ship/hold 结论，因此不产生 release-hold / risk-accepted 提示。  
**不**因「没有笔记」而阻断门禁。CLI：`verify_agent_notes.py` 必须传 `--repo-root <目标项目>` 或 `--state-root`，且路径必须真实存在。

可选：`decision-log` 条目增加可选 `note_ref`（相对 state-root 路径）；不要求每条 log 都有 note。

---

## 9. 校验门禁（最小集）

实现于 `scripts/verify_agent_notes.py`，并由工作流/`verify_action` 可选调用：

1. 根目录为 `<state-root>/.agents/notes/`；执行 worktree 下不得存在第二份 `notes` 树（检测到即 fail closed；首期**不允许**符号链接树）。
2. 路径符合 `{lifecycle}/{class}/yyyy-mm-dd-slug.md`，`lifecycle` ∈ {proposed, implemented, rejected, archived}，`class` ∈ 封闭集。
3. 存在 `Status:` 行，且前缀必须与目录 lifecycle 一致（`proposed/`→`proposed`，`implemented/`→`implemented`，`rejected/`→`rejected`，`archived/`→`implemented` 或 `rejected` 并带 `Archived:`）。
4. markdown 相对链接：非 `.vidt/` 目标必须存在；`.vidt/` 目标缺失仅 **warning**（本地状态）。
5. **`.vidt/` 不得被 git 跟踪**（以 **canonical state-root** 的 `git ls-files` 为准；linked worktree 索引不够）。未跟踪 ≠ 已忽略；未 ignore 时告警。
6. notes 根**不得**为符号链接；根下仅允许四个 lifecycle 目录与 `README.md`；禁止 `INDEX.md` 与游离目录/文件。
7. `archived/` 双向冻结：磁盘文件 ⊆ manifest，manifest 条目 ⊆ 磁盘（删除也会失败）；哈希不得漂移。

---

## 10. 非目标

- 不取代 `.vidt/metrics` 机器真源。  
- 不做全文检索服务；浏览 = 目录树 + 仓库搜索。  
- 不在 skill 仓库写目标项目业务决策。  
- 首期不做中英三元组与 i18n hash。
