# Agent Note: Waffo 订阅状态映射 fail-closed(未知状态不再推断 active)

Status: implemented — 2026-10-04 项目审查 Phase 1(finding 1.1)落地,契约测试钉死

## Problem

`subscriptionStatusFrom` 的 default 分支把缺失/未知的 `orderStatus` 一律映射为 `"active"`(包括一段两分支同值的无意义三元),而 entitlement/credits 授权恰好以 `status === "active"` 为闸门:`subscription.past_due` 事件在 `orderStatus` 缺失或新枚举值下会把订阅写成 active 并(重新)发放权益——fail-open,违反项目自身 fail-closed 原则。此外 SDK 状态机里明确的 `canceling`(active 的子态,服务到周期末)与 `closed`(从未激活的终态)也落入 default 被错判为 active。

## Decision

以 `@waffo/pancake-ts` 的 `SubscriptionOrderStatus` 状态机(docstring 内嵌)为唯一权威重写映射:7 个枚举值一一映射——`canceling`→`active`(同时由事件类型置 `cancelAtPeriodEnd: true`,服务持续到周期末)、`closed`→`cancelled`;default(含 pending、缺失、任何未来新枚举)→`pending`,永不推断 active。SDK 文档明确 `orderStatus` 仅在 `subscription.payment_succeeded` 缺席,而该事件归一为支付事件、不经过此函数,故"缺失"必属异常,fail-closed 是正确姿态。

## Alternatives considered

- **保留 activated 事件类型推断 active 的旧意图**:否决。事件类型不是状态真相;新枚举/字段缺失下的激活推断正是本次要堵的洞。
- **未知状态抛错使事件 failed**:否决(本轮)。`pending` 已足够安全(不授权、订阅行可观察),抛错会把可静默降级的场景变成重投循环;若未来发现 waffo 高频发送未知状态,再升级为 failed。

## Consequences

- 依赖旧行为的集成(若有消费方把"orderStatus completed 的订阅激活事件"当作 active):`completed` 不在 SubscriptionOrderStatus 订阅枚举里(它是 OnetimeOrderStatus),落 default→pending;契约测试已按新语义固定。
- Creem 侧 `mapSubscriptionStatus` 本就 pending 兜底,两 adapter 口径现已一致;PayPal `mapSubscriptionStatus` 同样 pending 兜底。
