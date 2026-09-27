# Agent Note: 审计日志下沉到 journal 操作层

Status: implemented — PR #116 (3845144) 落地

## Problem

审计写入挂在路由层:`payments/[paymentId]/refund` 路由写 `recordAuditEntry`,而 customer-scoped 孪生路由不写——控制台从客户详情页发起的每笔退款/取消在审计日志里不可见(A4,合规上属"抽样即见的证据链断裂")。逐路由补丁会制造第三次分叉,未来新路由还会再漏。

## Decision

**journal 操作函数拥有审计写入**:`refundPaymentWithJournal` / `cancelSubscriptionWithJournal` 接受 `actor` 参数,在把 journal 翻转为 `completed` 的**同一个事务**内调用 `recordAuditEntry(..., tx)`(`audit.ts` 第二参数收窄为 `Pick<Database, "insert">` 以接受事务客户端)。审计行与 journal 行原子同生共死;provider 拒绝(journal `failed`)与不确定结局(`needs_reconciliation`)均不写成功审计。路由层只负责传 actor,不再自行写操作审计——每次操作恰好一条审计。

Portal 路径例外:portal 调用不传 actor(操作层静默),保留其自身 `portal.*` 条目(`actorType: customer_portal`)——单操作单审计的保证对 portal 同样成立。

## Alternatives considered

- **逐路由补 `recordAuditEntry`**:否决——这正是缺陷的成因;补丁会造成第三处分叉,想漏还是能漏。
- **审计放在 journal 提交后、独立事务**:否决——审计与 journal 可能分叉(审计写成功但 journal 后续回滚),违反"审计 ⇔ 账务变动"的不可抵赖性要求。

## Consequences

- `src/modules/operations/audit-schema.ts` 的 actor check 约束必须与迁移文本同步(本次曾发现 TS 定义漏了 `customer_portal` 而迁移 0016 已含——`db:generate` 会把数据库约束改回去的静默回归,已修复并加注释)。教训:**check 约束在 TS schema 与迁移间会无声漂移**,改约束时两侧必须同 PR。
- `needs_reconciliation` 结局只在 journal/UI 可见,不产生成功审计条目——若未来需要审计"不确定结局",须新增独立 action 而非复用成功条目。

## Verification

`tests/integration/operator-audit.test.ts`:refund/cancel 各产生恰一条审计(含 actor 字段)、失败路径零审计、customer-scoped 路由 E2E(mocked auth + 真实 DB 成员关系)命中审计;全库 grep 确认 `payment.refunded`/`subscription.cancelled` 仅操作层一个写入点。
