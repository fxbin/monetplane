# Agent Note: 支付 webhook 记账不变量与退款逻辑合并边界

Status: implemented — PR #116 (d053015) 落地,不变量由集成测试钉死

## Problem

审计 (B5) 发现 provider webhook 的支付记账可被事件改写:已结算支付的 `amountMinor`/`currency` 会被后续事件 `onConflictDoUpdate` 覆盖;任何 `payment.refunded` 事件(含部分退款)都会把支付/订单打成终态 `refunded` 并吊销全部权益;退款金额不封顶。同时退款/取消业务逻辑存在三份副本(journal 路径、webhook 事件路径、以及一套无 journal 无幂等的死代码),无人能说清哪份是权威。

## Decision

四条不变量收敛在 `src/modules/commerce/webhook.ts` 单点执行:

1. **币种强校验** — 事件币种与订单/已存支付币种不符 → 事件 `failed`(大小写不敏感比较,统一大写存储),不产生任何写。
2. **已结算金额不可变** — upsert 的 `set` 中不含 `amountMinor`/`currency`;`succeeded` 支付上出现金额漂移时以 `console.error`(带 provider event id)暴露但不改写。
3. **退款封顶** — 可退余额 = captured amount − 已成功退款行之和(payment 行 `FOR UPDATE` 先于求和,串行化并发退款);超退事件 → inbox `ignored`(持久化,含原因)。
4. **累计全额才终态** — `fullyRefunded = 累计退款 ≥ captured` 才翻转支付/订单状态并吊销权益;部分退款保持 `succeeded` 但仍记录退款行。乱序送达的退款(无既有 payment 行)以订单总额作为记账基数,而非退款额自身。

合并边界(圆桌"账务系统老兵"裁定,重构派接受):命令路径(`billing-operation-actions.ts` 的 journal 流)与事实路径(webhook 记账)语义不同,**保持两份;只共享最内层记账原语**(封顶/币种校验/幂等),provider 调用绝不进共享原语。三份收敛为两份——死代码副本删除(见 [simplification 决策](../scope/2026-09-26-remediation-cuts.md))。

## Alternatives considered

- **三份逻辑合并为一个领域函数**:否决。命令路径(先记录后调 provider + reconcile)与事实路径(到账记账)的失败语义不同,强行合并会在迁移中引入新 bug,且掩盖差异。
- **容忍重复、靠测试锁行为**:否决。币种表的教训(见 [货币注册表决策](2026-09-26-zero-decimal-currency-registry.md))证明两套测试各自都绿时,锁住的是各自对规格的理解,不是规格本身。

## Consequences

- 部分退款后支付保持 `succeeded`(schema check 约束无 `partially_refunded` 状态,按范围纪律不加迁移);仪表盘因此看不到部分退款的可视差异,只能从退款行识别。
- `getRefundEligibility` 尚不感知部分退款:已部分退款(仍 `succeeded`)的支付会被以"A refund already exists"拒绝再次退款——净安全但理由不精确,补足至全额的运营退款暂不支持(再议条件:运营出现真实诉求)。
- webhook 驱动的退款不追回购买时赠送的积分(仅控制台路径有积分守卫)——已接受的残余风险。

## Verification

`tests/integration/commerce-webhooks.test.ts` 不变量块(7 测试):币种不匹配不改行、金额不可覆写(含 console.error 断言)、部分退款保持 succeeded、累计全额才吊销、封顶、超退 ignored、乱序退款按订单总额种子。独立 Verifier 对封顶算术与锁序做过全量人工推演。
