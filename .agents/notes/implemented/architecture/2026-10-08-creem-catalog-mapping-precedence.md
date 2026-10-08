# Agent Note: Creem 价格级映射的优先级与兼容策略(#155)

Status: implemented — 新表 `provider_catalog_mappings` 优先、legacy `metadata.catalog` 回退;不做 SQL backfill;legacy 冲突 fail-closed;修订(review round 2):`provider_product_id` 可空以承接 #156 创建意图;`billing_period` 按 Creem 文档仅 recurring 必需

## Problem

Creem Checkout 此前唯一的价格→商品映射来源是 `provider_connections.metadata.catalog[priceId]`(手工 JSON,无校验、无审计、无并发保护)。#155 引入受控的价格级持久映射,必须同时满足:既有连接 Checkout 行为零回归、迁移可回滚、禁止一条 Price 静默重绑到不同 Creem 商品。

## Decision

1. **读取优先级**:Checkout 在 provider runtime 层先查 `provider_catalog_mappings`(仅 `status='synced'` 行参与),命中则把 `providerProductId` 注入 `CreateCheckoutInput.items[]`;adapter 优先使用注入值,未注入则回退 legacy metadata——无映射行的连接行为与升级前逐字节一致。
2. **不做迁移期 SQL backfill**:legacy metadata 保持原样永不改动;想受控化的操作员走 Console 绑定流程逐条验证入表。理由:SQL 无法执行「拉取 Creem 商品并比对」的业务校验,批量 backfill 会制造未经验证的 synced 假象;空表 + 回退使得升级/回滚边界干净(删表即完全回退)。
3. **legacy 冲突 fail-closed**:若连接 metadata 已把该价格映射到不同 productId,绑定请求拒绝(`legacy_mapping_conflict`),不静默改道。显式 rebind/unlink 需要独立审计流程,留给后续 issue(记录于 PR)。
4. **幂等语义**:同一 (app, env, connection, price, productId) 重复绑定 → `already_linked`,仅刷新验证快照;不同 productId → 唯一索引冲突 → 409,绝不覆盖。
5. **DB 层隔离**:复合外键 `(connection_id, application_id)`、`(connection_id, environment)` 借助 provider_connections 上的两个新复合唯一索引,在数据库层强制同应用/同环境;service 层再做诊断级校验(revoked、跨应用、价格归属)满足双层要求。
6. **GET /v1/products 形态**:采用现行官方文档的 path 参数 `GET /v1/products/{id}`(2026-10-08 核实);issue 正文写的 `?product_id=` 为旧版形态。同批核实:POST /v1/products 支持 `Idempotency-Key` 头(供 #156 使用,未在本 PR 假定其语义之外的行为)。

## Alternatives

- 迁移期把 metadata.catalog 全量 backfill 进新表(否决:见 Decision 2,制造未验证 synced 假象,且违反"禁止迁移直接丢弃/改写旧 metadata"边界);
- 映射读取放 adapter 内(否决:adapter 是纯 HTTP 层,不持有 DB;分层 app→components→control-plane→modules→db 会破);
- environment 用 service-only 校验不用复合外键(否决:issue 明确要求 DB constraints 与 service 双重校验,复合 FK 是唯一能在 DB 层表达该不变量的方式)。

## Revisit when

- #156 自动创建落地时,status 机(`pending/creating/needs_reconciliation/failed`)与 Idempotency-Key 语义需按当时官方契约再核实;
- 若需要显式 rebind/unlink 操作面,须新增带二次确认与审计的专用流程,不得复用本 PR 的 link 端点放宽 409。

## Revision (review round 2,人工复核 PR #158 后)

1. **`provider_product_id` 改为可空 + 状态形状约束**(面向 #156,合并前修正):#156 需要「先持久化创建意图、后获得外部商品 ID」——`pending/creating/failed` 状态允许 NULL,`synced/needs_reconciliation` 必须非空(DB CHECK `provider_catalog_mappings_product_shape_check` 强制)。0021 未部署,原地修订迁移 + 手动 ALTER 本地开发库对齐;synced⇒非空由 DB 保证,checkout 解析层仍按非空过滤防御。
2. **`billing_period` 仅 recurring 必需**(Creem 官方文档核实):一次性商品可缺省该字段——缺省归一化为「无周期」;recurring 商品缺省周期同样归一化为无周期,由比对层输出 `billingInterval` mismatch 诊断拒绝,而不是 adapter 抛通用错误。原实现会把缺省周期的一次性商品误拒。
3. **`provider_unsupported` 接线修正**:首轮宣称的修复因脚本补丁未命中被静默跳过(biome 先行换行导致 old_string 不匹配);本轮以工具显式接线并补集成回归测试(lookup-less adapter → 400 `provider_unsupported` 而非 `provider_lookup_failed`)。教训:脚本化 str.replace 补丁必须校验命中。
4. **控制台校验竞态**(F2):verify 在途时改价格/商品 ID,旧响应会覆盖新选择并可能解锁未验证组合(服务器仍兜底)。修复:AbortController 中断在途请求 + `verified = {priceId, providerProductId}` 精确配对门禁,任一输入变化即失效。round-3 独立验证发现首版修复存在 verifying 标志泄漏(被中断的请求跳过 setVerifying(false),按钮永久卡死)——改为所有权语义清理:仅当前持有 ref 的请求负责复位,中断方同步复位;未持有所有权的 finally 不碰标志。
5. **Issue 关闭条件**:PR 由 `Closes #155` 改为 `Refs #155`——#155 验收第一条(真实 Sandbox 绑定)属外部证据,按 #58 §11 保持门禁开放,待 #157 端到端验收或人工 Sandbox 证据后再关闭 Issue。
