# Agent Note: 收入/用量分析的口径收敛与货币维度

Status: implemented — PR #116 (cfc539) 落地

## Problem

`overview.ts` 与 `analytics.ts` 各有一份收入分析,environment 过滤字段不同(`providerConnections.mode` vs `payments.environment`),且 revenue 页同时 await 两份——同一页面同请求数字可能互相矛盾;`byProduct` 还把所有币种的 minor unit 直接求和。何时用哪个口径,无人能答。

## Decision

1. **事实表反范式列是唯一口径**:所有资金/订阅分析按 `payments.environment` / `orders.environment` / `subscriptions.environment` / credit ledger 的 environment 过滤(历史事实,不随连接漂移)。`providerConnections.mode` 仅用于"当前连接状态"类查询(provider 健康度、缺失 provider 提示)。
2. **货币是聚合的必要维度**:`byProduct` 按 (product, currency) 分组,月度趋势按 (month, currency) 零填充,totals 按 currency 排列;任何跨币种求和都不得以单一币种标注。空 KPI 渲染 `—` 而非 `$0.00`。
3. `getRevenueAnalytics`/`getUsageAnalytics` 收敛到 `analytics.ts` 单一实现,`overview.ts` 只保留 command-center 聚合。

## Alternatives considered

- **维持 mode 过滤**:否决。连接模式可被切换,历史支付会在报表里"搬家";审计场景要求口径锚定在事件发生时的事实上。
- **保留双实现**:否决。同页双口径是即时的信任损耗。
- **`getUsageAnalytics` 与 `getUsageTrends` 合并**:否决——二者是不同指标(前者基于 credit ledger 的赠送/扣减,后者基于 usage_events 的计量事件),审计原始判断有误;仅收敛了存放位置。

## Consequences

- 口径变更会让部分报表数字变化(mode 过滤 → environment 过滤的差异行),已在 PR 说明中提示与业务对齐。
- overview 的 `topProducts`/`recentPayments` 至今不带 environment 范围(先于本次整改即如此,未动)。
- 口径若要再议,必须先推翻本笔记并更新 `docs/analytics-definitions.md` 与分歧钉死测试。

## Verification

`tests/integration/analytics-v1.test.ts` 与 `overview-analytics.test.ts` 的**分歧钉死测试**:构造 `payments.environment='live'` 但连接 `mode='test'` 的支付,断言按 live 计入、被 test 排除——三处实现(KPI、V1、统一后)一致。货币维度测试断言 `(product, currency)` 行与 2 币种 × 12 月 = 24 个零填充点。
