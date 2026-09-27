# Agent Note: 资金端点凭证门禁与 host 回退的只读边界

Status: implemented — PR #116 (aeb89a4) 落地;接受的残余风险记录在案

## Problem

审计 B1(critical):`resolveApplicationContext` 在无 Bearer token 时凭 `Host` 头即可解析应用身份,而 `/api/checkout`、`/api/credits/{debit,reserve,capture,release}`、`/api/usage/report`、`/api/portal/sessions`、`/api/customers` 全部资金变更端点无任何 `context.source` 检查——能把 Host 设为某注册应用域名的客户端可无凭证扣积分/开 checkout/铸造 portal 会话。B2:`AUTH_SECRET` 缺失时回退到源码内占位符。

## Decision

1. **资金变更端点一律 `source === "credential"`**(`resolveCredentialApplicationContext` 守卫,401 `credential_required`);host 回退只保留给**只读面**(branded host 的 entitlements/check、credits/balance、application-context)。
2. `AUTH_SECRET` 经 `getAuthSecret()` fail-fast(缺失即抛,对齐 `DATABASE_URL` 的模式),占位符全库清除;CI 注入 build-only 值。
3. cron 端点 `/api/cron/credit-expiry` 以 `CRON_SECRET` 时序安全比对,未配置即 401(fail-closed,无默认回退)。

## Alternatives considered

- **一刀切禁用 host 回退**:否决(圆桌共识)。branded-host 只读展示与 portal 品牌面是合法场景;"账务系统老兵"提出的折中(资金面立即强制凭证、只读面保留带日志限流的过渡窗口)被三方接受。
- **配置开关默认放行、给迁移期**:否决。开源项目可以给 opt-out,不能给默认洞;守卫直接启用,调用方迁移靠发版说明。
- **仅告警不阻断**(针对 AUTH_SECRET 占位符):否决。可伪造控制台 JWT 属密钥管理最低级失分,必须 fail-fast。

## Consequences

- **接受的残余风险**:只读端点仍可被 Host 伪造访问,攻击面限于"知道某注册应用域名 + externalCustomerId"时可读该应用的权益/余额——应用域内信息,当前接受;若未来引入跨应用敏感数据则须重议。
- 部署前置条件(必须项):生产环境设置 `AUTH_SECRET` 与 `CRON_SECRET`,并给 cron 路由配 5–15 分钟调度(见 `docs/credits-ledger.md`)。
- 依赖 host 回退调用资金端点的集成方会从 200 变 401—— breaking change,已在 PR 发版说明中声明。

## Verification

`tests/integration/credential-gate.test.ts`:8 条资金路由逐一断言 host-only 请求得 401 `credential_required`、有效凭证穿过门禁到达字段校验、无效凭证 401 `unauthorized`;`tests/env.test.ts` 钉住 fail-fast 语义。
