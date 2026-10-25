# Agent Note: docs/ 收敛为现行参考——点时证据语料迁入 notes

Status: implemented — 2026-10-25 迁移 7 篇验收/实测证据;此后新增 gate/live 验证证据直接写 notes(verification 类),docs/ 只留现行参考

## Problem

`docs/` 同时承载两类生命周期相反的内容:随代码同 PR 就地更新的现行参考(`architecture.md`、`sdk-quickstart.md`、`provider-adapter-guide.md` 等),与一旦产生即冻结的点时验收/实测记录(P0/P1/P2 gate evidence、四篇 provider live evidence、#130 验证清单)。后者语义上是「凭什么过门禁」的验证语料,留在 `docs/` 稀释了公开参考面,也与 AGENTS.md 知识地图对 `docs/` 的定位(「是什么 / 怎么用 / 怎么接」)不符。

## Decision

1. 点时验收/实测证据归 `implemented/verification/`,按契约命名 `yyyy-mm-dd-slug.md`,**日期取议题首次提出日**(原文件的 git 创建日);正文逐字节保留原文,仅前置 Agent Note 头(`# Agent Note:` 标题 + `Status:` 行 + 迁移出处引用)。
2. 本次迁移清单(7 篇):`p0-acceptance-evidence`(2026-08-26)、`p1-gate-evidence`(2026-09-17)、`p2-gate-dogfood-evidence`(2026-09-18)、`waffo-live-evidence`(2026-09-19)、`creem-live-evidence`(2026-09-20)、`paypal-live-evidence`(2026-09-26)、`creem-live-verification`(2026-10-03,#130 清单,当日执行完毕随 issue 关闭)。
3. `docs/` 只保留现行参考文档;ADR(`adr-environment-isolation.md`)按行业惯例留在 `docs/`,不迁。
4. 现行参考维持「随代码同 PR 就地更新」的可变性规则,不适用 notes 的「决策不改写、推翻须新建笔记」——两套规则不混用同一批文件。
5. 引用同步:README Status 区、`docs/provider-adapter-guide.md`、`paypal.ts` 注释、`paypal-adapter.test.ts` 注释中的证据路径随迁移同 PR 改指 notes 路径。

## Alternatives considered

- **`docs/` 全部文件迁入 notes**:否决——现行参考是 living docs,契约(日期=首次提出、决策不改写)容纳不了就地更新;且 `docs/` 是开源项目的公开集成面(README 8+ 处链接),埋进 `.agents/` 点目录损害可达性。
- **证据文件原地不动**:否决——`docs/` 定位与证据语义不匹配;notes 已有 verification 类先例(2026-09-26-money-path-evidence-standard.md),双处并存继续稀释。
- **证据正文改写为标准 Problem/Decision 结构**:否决——历史证据是事实记录,改写引入漂移风险;只加头、不改正文。

## Consequences

- 证据正文保持英文原文,与 notes「首期中文」约定不冲突(迁移保留原语种;新增笔记仍中文)。
- README Status 区以 notes 路径引用证据,读者仍可点击直达。
- GitHub issue/PR 描述中的旧路径(`docs/*-evidence.md`)属不可变历史文本,不改;以迁移头部的出处引用保持可追溯。
- 若未来证据被推翻(如重测),按 supersession 规则新建笔记交叉链接,不回改本批迁移文件。
- 再议条件:若对外需要面向访客的「项目状态证明」页面,在 README 内做摘要即可,不再回迁文件。

## Verification

`python3 <vidt-skill>/scripts/verify_agent_notes.py --repo-root .` 通过;全仓 grep 无残留 `docs/(p0-acceptance-evidence|p1-gate-evidence|p2-gate-dogfood-evidence|creem-live-evidence|creem-live-verification|paypal-live-evidence|waffo-live-evidence)` 现行引用(迁移笔记头部记载出处的历史指针除外)。
