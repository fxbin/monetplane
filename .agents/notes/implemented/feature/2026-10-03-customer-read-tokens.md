# Agent Note: 客户级短时效读取令牌(读端点第三认证层)

Status: implemented — Issue #138(亦为 #127 复核登记的 saturation anomaly),随分支 feat/customer-read-tokens 落地

## Problem
#127 的过渡态下,读端点(balance/entitlements)有三档身份:凭证(可信)、Host 回退(限流+告警)——但 branded-host 浏览器场景缺少**客户级**凭证:要么后端代读(凭证,无浏览器路径),要么依赖被限流压制的 Host 回退(应用域内数据仍可被知道域名+externalCustomerId 的一方枚举)。终态(复核要求)是读端点凭证必选 + 浏览器用短时效客户令牌。

## Decision
新增第三认证层 **customer read token(`mprt_*`)**,范式对齐 portal_sessions:
- **签发**:应用后端以 `mp_app_*` 凭证调 `POST /api/customer-read-tokens {externalCustomerId, environment?, ttlSeconds?}`,为其**单个客户**铸造令牌;TTL 强制 60–3600s(默认 900);返回原文一次,库存 SHA-256 哈希(`customer_read_tokens` 表,迁移 0018,级联删除、环境 check)。
- **消费**:读端点识别 `Authorization: Bearer mprt_*` 为第三层——上下文(应用/客户/环境)**完全来自令牌行**,Host 头不参与(跨应用使用在构造上不可能);显式 externalCustomerId/environment 与令牌不一致 → 403 customer/environment_mismatch;无效/过期/吊销 → 401 `read_token_invalid`。
- **吊销**:`DELETE /api/customer-read-tokens/<id>`(凭证认证,应用隔离)。
- **Host 回退不变**:仍限流 + 硬上限;饱和(硬上限 fail-closed)时输出**节流的一次性**运营信号(#138 登记的 polish)。
- 令牌读不进限流器(已认证、单客户枚举面为零)。

## Alternatives considered
- **从 portal session 派生读取能力**:否决——portal 令牌是一次性入口令牌,非承载式 API 凭证;复用会把两个生命周期耦合。
- **JWT 自包含令牌(无状态)**:否决——撤销需要黑名单,有状态化后与哈希存储等价;不透明随机串 + 哈希表与 portal 既有安全范式一致。
- **直接把 Host 回退升级为客户令牌必选(一步到位)**:否决——会立刻打断现存 branded-host 集成;本设计使终态成为"新集成的默认路径",Host 层退役变为配置/文档动作(再议条件不变,见 credential-gate 决策笔记)。

## Consequences
- 读端点认证现为三层:customer-token(单客户)→ credential(全应用)→ host(限流迁移窗)。
- `POST /api/customers` 静态路由与新增 `/api/customer-read-tokens` 共存(Next.js 静态优先于动态段,无冲突)。
- SDK 封装(`createCustomerReadToken`)留作后续(REST 面已稳定);saturation 信号只进日志,告警管道归 #128 的运维接线。
- 迁移 0018 无数据回填;表随应用级联删除。

## Verification
tests/integration/customer-read-tokens.test.ts:凭证签发 201、令牌读自身余额 200(不传 externalCustomerId)、他客户 403 customer_mismatch、未知/过期/吊销 401 read_token_invalid、环境不一致 403、签发必须凭证(401)、TTL 边界 400;host-read-rate-limit.test.ts 增饱和一次性告警断言。全量:unit 148/148、integration 239/239(迁移 0018 双跑)。
