# Agent Note: 审计整改的明确不做清单

Status: implemented — 随 PR #116/#118 交付;重开任何一项须新立决策

## Problem

审计暴露的重复与改进点远超一次整改应消化的量(13 个模块、3 个适配器、双分析、7 份工具函数……)。不把"明确不做"写下来,每一轮后续工作都会重新争论一遍,或在 review 中被当作遗漏。

## Decision

以下为 2026-09-26 整改轮的**明确范围裁定**(圆桌共识或 Verifier 评审后的有意保留):

**可容忍的重复**
- 5–10 行纯函数(`isRecord`/`stringValue`/`slugify`/`hashToken`/`formatMonth` 等)保持各处本地副本——过早抽象的耦合成本高于重复成本。仅三处达到"变更放大器"标准的做了抽取:`src/lib/money.ts`、`adapters/shared.ts`、`getWebhookConsoleData`。
- `parseEnvironment` ×7 与 service 层环境 resolver **未统一**(失败语义差异:路由 throw vs service 静默 coerce)——风险已知,整改优先级未到,重议条件:出现一次真实的静默环境错配事故或新增第 8 份副本时。

**有意不合并**
- catalog-mapping 读取器不从适配器抽取:PayPal 需要 `{productId, planId}`、Creem 接受 `string|{productId}`,契约真不同,强行统一会改契约。
- `getUsageAnalytics`(credit ledger)与 `getUsageTrends`(usage events)保持两函数:不同指标,非重复(审计原始判断有误)。
- `modules/admin/guard.ts` 留在 modules 层并 `import next/server`:32 处 import 的迁移是独立重构;边界测试中以显式豁免记录,迁移完成后删除豁免。

**有意不新增**
- 不添加 `vercel.json`(仓库无部署信号;调度方式写入 `docs/credits-ledger.md` 由部署方选择)。
- 不给 schema 加 `partially_refunded` 状态(无迁移必要,见[记账不变量](../architecture/2026-09-26-money-ingest-invariants.md))。
- 不做 `api-client.ts` 的复活/统一 fetch 包装(已删除;UI 端 16 处 fetch 包装的收敛未排期)。

**删除而非收编**
- 无 journal 的退款/取消死代码、8 个零引用 module barrel、孤儿导出、`lib/api-client.ts`:全删。理由:内部代码没有"公共 API",git 历史就是;为零调用函数补齐 journal/幂等是负 ROI。将来需要 customer-scoped 退款入口时,从 `refundPaymentWithJournal` 接线,不复活旧实现。

**延后(已开票跟踪于 PR 描述)**
- 部分退款感知的退款资格补足(当前净安全:拒绝理由不精确)。
- webhook 驱动退款的积分追回策略(当前仅控制台路径有守卫)。
- pending 投递行清扫(见 [webhook 重试策略](../risk/2026-09-26-webhook-retry-policy.md))。

## Alternatives considered

- **一次整改全做**:否决。涉钱代码的变更放大风险与评审负担都会失控;安全修复(小 diff)先行、重构按风险分批是本轮的实际执行顺序。

## Consequences

- 边界测试(`tests/module-boundaries.test.ts`)中的每条豁免都是**已评审决策**,新增豁免须在 PR 中给出等价论证。
- 本清单是范围争议时的第一引用;推翻任何一条 = 新决策笔记 + 双向链接,不改写本篇。

## Verification

`tests/module-boundaries.test.ts`(6 条机械规则);死代码删除后全量集成套件通过;`grep` 零引用证据留存在 PR #116 描述与 `.vidt` 本地决策日志(不提交)。
