# Agent Note: 订阅续费发放的幂等键推进(PayPal 不发货缺陷)

Status: implemented — 2026-10-04 项目审查 Phase 1(finding 1.2)落地,集成测试钉死

## Problem

PayPal `PAYMENT.SALE.COMPLETED` 被归一为 `subscription.renewed` 但不携带账期边界;webhook 层回退到订阅行**上一期**的 period,导致本期发放的幂等键(`grant:subscription:<id>:<periodKey>:<creditType>`,periodKey=periodStart)与激活期完全相同,`grantCreditsInTransaction` 命中 duplicate 静默返回——客户每期正常扣款,MonetPlane 不发放该期 credits、entitlement 的 validUntil 不延长。方向为少发的错账,且无任何告警信号。该缺陷对任何"续费事件不带自身 period"的 provider 均成立,不只 PayPal。

## Decision

双层修复:

1. **Adapter 补齐真相(主修)**:`paypal.ts` 在归一 `PAYMENT.SALE.COMPLETED` 时调用 `GET /v1/billing/subscriptions/{agreementId}`,以 `billing_info.last_payment.time` / `next_billing_time` 作为本期边界,并透传 API 侧订阅状态。补齐失败直接抛错——webhook 落 503、PayPal 重投,绝不退回"无边界继续处理"的旧路径。
2. **Commerce 层兜底(防复发)**:`webhook.ts` 中,`subscription.renewed` 且事件自身无 periodStart 时,entitlement/credits 发放键回退为 `event:<providerEventId>`——对同一事件的重放稳定(幂等),对不同周期的事件唯一(键必然前进)。有边界的续费行为不变。

## Alternatives considered

- **只在 commerce 层用 occurredAt 派生 periodKey**:否决。无法得出正确的 validUntil(entitlement 需要真实周期末端),且虚构键掩盖 adapter 数据缺失。
- **webhook 层对无边界续费直接 failed 留待人工**:否决。钱已扣,应尽力自动发货;failed 会把正常续费变成运营工单。

## Consequences

- 已接受的残余风险(Verifier 复核确认):若 PayPal 首周期 SALE 事件先于 `last_payment` 推进到达,enriched period 与激活期相同 → 发放幂等 no-op(不报错、不冲突),仅事件流异常时可能出现;观察即可。
- 开发者事件流(`billing-events.ts`)的续费去重键仍以 period 为准、无 period 回退 inbox id——该行为与本修复正交,保持不变。
- normalizeWebhook 首次引入网络调用(仅此一个事件分支);重投递也会付一次 GET,代价可接受。
