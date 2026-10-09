# Agent Note: Creem 商品自动创建的幂等与不确定态语义(#156)

Status: implemented — 状态机 pending→creating→synced/NR/failed;Idempotency-Key=映射行 id;不确定态绝不自动重发;恢复=link 采纳或显式标记失败

## Problem

#156 要求从 MonetPlane Price 自动创建 Creem 商品并保存映射,核心难点是外部创建的非原子性:请求可能成功而响应丢失(崩溃/超时/5xx),此时盲目重试 POST 会在 Creem 制造重复商品;而 429 这类「确定未执行」的失败又应该可以安全重试。

## Decision

1. **幂等键 = 映射行 id**:创建意图先持久化(唯一索引占位),行 id 作为 `Idempotency-Key` 发给 Creem(官方文档明确该头使重试返回原商品,2026-10-08 核实)。同一意图的所有重试共用同一键——崩溃后重新走 failed→pending→creating 也不会分叉。
2. **失败三分法**(编排层分类,状态机落库):
   - 确定性拒绝(4xx/预检违规/能力缺失/429 重试耗尽)→ `failed`,可显式重试;
   - 不确定(超时/5xx/网络)→ `needs_reconciliation`(Product ID 未知),**绝不自动重发**;
   - 429 → 同键有界重试(默认 1s/3s 两次),耗尽才落 `failed`。
   为此 `ProviderOperationError` 增加 `status?` 字段,classifyHttpFailure 透传,429 判定不靠消息解析。
3. **外部调用位置**:所有 HTTP 严格发生在两次行状态转换之间(事务外);行转换全部是带 WHERE 前置状态的条件 UPDATE,天然单写者。
4. **创建后双向核对**:POST 只信任返回的 id,随后 GET 商品并全字段比对;不一致 → `needs_reconciliation`(带 id,人工核对),拒绝「成功假象」。
5. **恢复路径(受审计,无自动)**:①操作员在 Creem 后台/查重找到商品 → 走既有 link 端点「采纳」(NR/failed 行 → synced,audit `provider_catalog.recovered`);②显式标记失败(`/catalog-products/fail-intent`,audit `intent_failed`)→ 重试。崩溃残留:下次 provision 对超过 5 分钟的 pending/creating 行做 stale 探测 → NR(audit `provision_stale`)。
6. **不破坏 #158 语义**:synced 行指向不同商品仍 409;legacy metadata 已有映射的价格拒绝自动创建(防静默改道);in-flight(pending/creating)拒绝并发第二写;synced 只读返回绝不重复创建。
7. **UI 归属**:控制台按钮留给 #157;#156 只交付 API(控制台会话 + catalog:write),产品详情页既有状态标签(需人工核对等)已能显示 NR 态。

## Alternatives

- 不确定态自动用同键重试(Idempotency-Key 文档语义下技术上安全;否决:issue 明确「不确定成功的创建不得无条件重试」,且键行为未在真实 Sandbox 验证前不应依赖,#157 端到端时再评估);
- 用 billing_operations journal 承载创建意图(否决:非资金事实变更,journal 契约是资金操作;独立状态机 + operator audit 足够);
- 采纳时改写 source 为 linked(否决:保留 created 表达映射来源是自动创建,便于审计与 #157 UI 区分)。

## Revisit when

- #157 真实 Sandbox 验证 Idempotency-Key 实际行为后,可重新评估「不确定态同键安全重试」;
- 需要按 name 查重(search-products)或批量恢复操作面时,另起 issue;
- 其他 provider 实现创建时,预检规则(currency/税种/最低金额)应留在各自 adapter 内,不上移编排层。
