# Agent Note: 开发者事件身份按业务事实派生

Status: implemented — Issue #131,随 PR(feature 分支 fix/dev-event-identity)落地

## Problem
开发者事件 id 原为 `dev_<webhook inbox 行 id>`,而 inbox 唯一键是 (connection, providerEventId)。同一业务事实在两个 provider 事件 id 下到达时(provider 重试重造 id、或 ingest 层仍会 processed 的重放路径:订阅生命周期重放、对已 failed 支付的 failed 重放),产生两个不同 dev id → (endpoint, eventId) 去重被绕过 → 对外双投递;消费者拿不到稳定幂等键。首发 publish 崩溃 + 渠道换 id 重投的漏发场景同理无法自愈。

## Decision
事件 id 从**业务事实**派生(billing-events.ts `factBasedDeveloperEventId`):
- 支付:`dev_<conn>_payment_<providerPaymentId>_(succeeded|failed)`
- 退款:`dev_<conn>_refund_<providerRefundId>`(每退款事实一条事件)
- 续费:`dev_<conn>_subscription_<subId>_renewed_<periodStart>`(每周期一条)
- 其他订阅事件:`dev_<conn>_subscription_<subId>_<type>[_<periodStart 若在场>]`
- 规格不全的回退原始 inbox id(无稳定退款 id 的退款、无周期边界的续费)——§二D 已知限制,归 #130 关闭时的能力声明结论。

同一事实 ⇒ 同一 id ⇒ (endpoint, eventId) 唯一索引成为事实级去重;首发崩溃后下一次 ingest(无论渠道是否换 id)自愈补发。组件净化为 [A-Za-z0-9_-]。

## Alternatives considered
- **保持原始 id + 消费者自行按 paymentId 幂等**:否决——平台字面上承诺了 deliveries 按 (endpoint, eventId) 去重,而 eventId 语义漏洞使承诺对"同事实两 id"失效,属契约设计缺陷;把修复成本转嫁给所有消费者。
- **ingest 层对全部事件类型补"重复业务事实→ignored"**:部分已做(B3/B1/B4),但订阅重放与 failed 重放按设计是幂等 processed(状态机需要),逐类型加守卫治标且遗漏面大;事实 id 在投递层一次性收口。

## Consequences
- **对外 id 格式变化**(仅新事件;存量行不变):docs 未承诺 id 格式稳定性,判可控;payload version 仍为 1,已在 architecture.md 写明"id 即消费者幂等键"的语义。
- 无 schema 变更(eventId 为 text;唯一索引语义从"事件级"升级为"事实级",正是目的)。
- 适配器仍应提供稳定退款 id 与周期边界(否则回退旧行为);与 #130 的能力声明结论一致。

## Verification
3 个判别测试(developer-billing-events.test.ts):同 activation 两 provider 事件 id → 恰 1 次投递(父提交红:旧 id + 2 次);failed 重放新事件 id → 恰 1 次(父提交红:2 次);不同周期续费 → 2 个不同 id。Mutation 证据:父提交上 failed 重放实际投递 2 次。
