# Agent Note: 涉钱变更的证据标准(Worker/Verifier 分离)

Status: implemented — 整改轮(PR #116/#118)全量执行;后续涉钱变更沿用

## Problem

资金路径的变更(认证门禁、记账不变量、账本并发)出错的代价是真实资金损失,而"测试全绿"对自产自验的 Worker 不是充分证据——PR2 的独立评审在实际合并前抓到了两个测试没覆盖的真实边界缺陷(乱序退款的记账基数错误、INSERT 路径状态洞),证明该标准不是仪式。

## Decision

对触及**资金、认证、并发幂等**的变更,最低证据标准:

1. **独立 Verifier**(全新上下文、只读、以 file:line 证据回答固定核查清单、输出 JSON 裁决 pass/fail/hold)——与实现者不得为同一上下文;findings 必须在合并前处置(修掉或在 PR 描述记录为接受的残余)。
2. **全量集成套件**(不是只跑受影响文件)作为合并门禁;新行为必须有**断言数据库状态**的测试(经 service/SQL 查询,而非"没抛异常")。
3. **删除类变更**:先 grep 证明零引用(含 tests/packages/examples),删后跑全量;测试引用的死路径须确认 journal 等价覆盖存在后才可删测试。
4. **分层约束机械化**:`tests/module-boundaries.test.ts` 是文档架构的可执行形态;豁免清单条目即评审决策。
5. 审计留痕:结论写入 `.agents/notes/`(可提交),机器状态留 `.vidt/`(不提交)——二者边界见 `.agents/notes/README.md` §2。

## Alternatives considered

- **实现者自查 + 测试通过即合并**:否决——本次整改中独立评审在 5 个涉钱 PR 上均产出实质发现(2 个合并前修复的资金边界 bug、锁序倒置、约束漂移、注释与实现不符),自查覆盖不到。
- **每个 PR 都上 Verifier**(含纯删除/机械变更):否决——低风险变更的评审成本大于收益;按风险分级,删除/机械类由 Lead 以全量门禁自查。

## Consequences

- 涉钱 PR 的周期变长(多一轮独立评审)——接受的代价;换到的是两个真实资金缺陷在合并前被拦截。
- Verifier 裁决与 findings 处置记录在各 PR 描述(#116/#118),可追溯。
- 若未来引入更快的验证通道(如高频内部迭代),对"资金/认证/并发"三类变更本标准不放松。

## Verification

每轮的 Verifier JSON 裁决存于 PR 描述;`pnpm test:integration` 全量作为合并门禁;`.vidt/metrics/decision-log.jsonl`(本地)记录每 PR 的 worker/verifier/结果三元组。
