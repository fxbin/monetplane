# Creem 退款链路实测验证清单(#130)

> 目的:在真实 Creem 沙箱中实测两件代码侧只能静态推断的事——
> ① journal 合成退款 ID(`refund:<paymentId>`,`creem.ts` 的 `refundPayment`)与真实 webhook
> `refund.created` 携带的 `object.id` 的 superseded 对齐(已随 PR #129 落地);
> ② `subscription.past_due` 事件的 `last_transaction_id` 语义(指向新失败交易还是旧成功交易)——
> 决定 B4 的"同 providerPaymentId 抑制"是否需要细化。
>
> 全程 test-mode;不碰真实资金。

## 环境准备

1. 部署或本地启动本仓库 main(head ≥ `ae97842`),`.env` 配好 `DATABASE_URL`/`AUTH_SECRET`/`MONETPLANE_ENCRYPTION_KEY`/`CRON_SECRET`。
2. Creem 沙箱应用:拿到 API key + webhook secret;webhook 指向可达隧道(如 cloudflared/ngrok)→ `POST /api/webhooks/<connectionId>`。
3. 控制台建 application + Creem 连接(test mode),记下 `connectionId`。

## 场景 A:合成退款 ID → 真实退款 webhook 的 superseded 对齐

| 步骤 | 操作 | 预期(代码依据) |
|---|---|---|
| A1 | 控制台对一个已成功支付的 Creem 订单发起退款(全额) | journal 落一行退款,`provider_refund_id = refund:<paymentId>`,状态 pending 或 succeeded(`creem.ts` 无法同步返回真实 ID) |
| A2 | 等 Creem 发 `refund.created`/`refund.succeeded` webhook(带真实 `object.id`) | webhook ingest:真实 ID 行落 succeeded;合成行同事务标 **superseded**(PR #129 B1) |
| A3 | 查库核对 | `SELECT provider_refund_id, status, amount_minor FROM refunds ORDER BY created_at;` 恰两行:合成=s superseded、真实=succeeded;支付/订单 refunded;权益 revoked |
| A4 | 跑对账脚本 | `node --experimental-strip-types --env-file=.env scripts/reconcile-refunds.mts` 第 [5] 节 superseded ≥1,其余分区 0 |

**要采集的证据**:A3 的 SQL 输出、A4 脚本输出、原始 `refund.created` payload(webhook 日志或 inbox `raw_body`)。

## 场景 B:`subscription.past_due` 的 `last_transaction_id` 语义

| 步骤 | 操作 | 预期/观测点 |
|---|---|---|
| B1 | 创建订阅并完成首次成功支付(真实 webhook 到达) | 订阅 active;记下首笔成功交易的 `transaction_id`(= providerPaymentId) |
| B2 | 制造续费失败(沙箱常用:换失败测试卡/卡额度手段,以 Creem 沙箱支持为准) | 收到 `subscription.past_due` webhook |
| B3 | **核心观测**:该事件的 `last_transaction_id` 是**新失败交易的 ID**还是**B1 的旧成功交易 ID** | 新 ID → B4 抑制逻辑安全(不同 payment id 正常处理);旧 ID → 需要在 #130 记录并在 ingest 对 past_due 增加交易状态判断(follow-up) |
| B4 | 查库:支付/订阅状态 | 新失败支付存在且 failed;订阅 past_due;B1 成功支付不受影响 |

**要采集的证据**:B2 原始 payload(重点 `last_transaction_id` + `object.id`)、B4 SQL 输出。

## 场景 C(顺带):webhook 重投与 sweeper

- 手工重发一条 Creem webhook(dashboard replay):inbox 去重(ignored/duplicate)不重复入账;
- 若有条件杀进程再恢复,观察 `/api/cron/webhook-deliveries` 清扫 pending 开发者投递(#126)。

## 结论回填

把 A/B 的证据贴回 Issue #130,按结果:
- A 通过 → #130 关闭(映射已验证);
- B 为新 ID → 顺手关闭该子项;B 为旧 ID → 在 #130 描述追加发现,开 follow-up(ingest 对 past_due 加交易状态前置判断)。
