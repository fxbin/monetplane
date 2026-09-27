# Agent Note: webhook 失败响应策略(422/503 取代一律 200)

Status: implemented — PR #118 (19e52a7) 落地;接受的残余风险与再议条件在案

## Problem

#97 有意让处理失败也返回 `200 processed:false`(防 provider 重试风暴),副作用是**瞬时失败被永久静默丢弃**且无任何自动重试路径(M4)——一次 DB 竞争就能永久丢一条 provider 生命周期事件,漏记的退款只能人工补。

## Decision

签名验证通过后:

- `InvalidNormalizedCommerceEventError`(币种不匹配、缺金额/客户引用、上下文错位等**确定性**失败)→ **422 `permanent:true`**:重试不可能成功,事件照旧停在 inbox `failed` 供人工处置。
- **其余一切** → **503**:事件停在 inbox `failed` 且**可重放**——provider 的重投就是自动重试路径(重放命中既有行、`failed` 不在短路集合、从头重处理;幂等索引 + 账本幂等键保证不双重应用)。
- 未注册适配器 rethrow 至外层 404(部署错误,非瞬时)。
- **fan-out 自愈**:开发者事件发布对 duplicate 重放也尝试——若首次尝试在"事务已提交、发布未执行"瞬间崩溃,重投会补发;确定性开发者事件 id(`dev_<webhookEventId>`)+ 投递表 `(endpoint, eventId)` 唯一索引使重发布为严格空操作。

## Alternatives considered

- **维持一律 200**:否决。静默丢失是完整性缺陷;重试风暴应靠幂等压住,不是靠吞。
- **一律 5xx**:否决。确定性失败会无意义地循环到 provider 重试耗尽。
- **毒载荷返回 4xx 以阻止 provider 重试**:部分成立——部分 provider 对 4xx 也重试,真正的止损是 inbox 停车 + 事件 ID;422 的价值在语义诚实,不在止投。

## Consequences(接受的残余)

- 少数**确定性但未归入 422 集合**的失败(积分 grant-config 错误、已停用连接)会得到有界且幂等的 503 重试——可接受;若将来 provider 重试配额成为实际负担,扩充永久集合(再议条件)。
- **mid-publish 崩溃窗口**:投递行已插入但未投递时崩溃,留下 `pending` 行——重放因冲突跳过、retry 端点不收 `pending`、现无清扫任务。需 pending-delivery sweeper 时另立决策。
- 消费 `processed:false` 的调用方需感知新状态码;仓库内唯一 UI 消费点已同步。

## Verification

`tests/integration/webhook-retry-policy.test.ts`:503/422 分类、fan-out 自愈端到端(直调 processor 跳过发布 → 路由重放 → 恰一条开发者投递)、非重复首次发布;`webhook-receiver-route.test.ts` 停车测试更新为 422(即本决策有意的行为变更)。
