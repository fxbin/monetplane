# Agent Note: 客户级短时效读取令牌(读端点第三认证层)

Status: implemented — Issue #138 部分落地(Advances,非 Closes):随分支 feat/customer-read-tokens / PR #141 交付 customer read token 认证层;**#138 保持 open**,剩余部分是真正退役 Host 回退(见 Consequences)

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
- **直接把 Host 回退升级为客户令牌必选(一步到位)**:否决——会立刻打断现存 branded-host 集成;本设计使终态成为"新集成的默认路径",Host 层退役变为配置/文档动作(再议条件不变,见 credential-gate 决策笔记)。复核轮次确认了这一取舍:**先合令牌层、保留 Host 层(#138 保持 open)**,而不是在本 PR 里顺手退役。

## Consequences
- 读端点认证现为三层:customer-token(单客户)→ credential(全应用)→ host(限流迁移窗)。**Host 层仍在**,所以 #138 未关闭:本 PR 只交付终态的载体,退役 Host 回退(#138 剩余)需要存量 branded-host 集成迁移证据后再做。
- 跨应用隔离在**服务层** fail-closed,不只是路由层:`issueCustomerReadToken` 校验 `applicationId`+`applicationCustomerId` 绑定,`resolveCustomerReadToken` 以 join 复查令牌行指向的客户确属同一应用(外部写坏/恢复出来的行也解析不出)。
- Bearer 解析对 `mprt_*` 与 `mp_app_*` 一律大小写不敏感;两者都不匹配的 Bearer 头**不再静默降级**到 Host 回退(401),避免"带了个坏令牌却被当成匿名读"。
- 非法 `environment` 值在进入任何认证层之前就 400 `invalid_environment`(不再 coerce 也不 500)。
- 迁移 0018 的时间列一律 `timestamp with time zone`(Drizzle schema `withTimezone: true`);expiry 是认证边界,时区漂移会直接变成"多活/少活"。
- `POST /api/customers` 静态路由与新增 `/api/customer-read-tokens` 共存(Next.js 静态优先于动态段,无冲突)。
- SDK 封装已落地(`createCustomerReadToken` / `revokeCustomerReadToken`,后继 PR);saturation 信号只进日志,告警管道的载体待议(#128 已关闭,接线时需先定归属 issue)。
- 迁移 0018 无数据回填;表随应用级联删除。

## Verification
tests/integration/customer-read-tokens.test.ts:凭证签发 201、令牌读自身余额 200(不传 externalCustomerId)、他客户 403 customer_mismatch、未知/过期/吊销 401 read_token_invalid、环境不一致 403、签发必须凭证(401)、TTL 边界 400、非法 environment 400、小写 `bearer` 方案可用、畸形 Bearer 不降级、`mp_app_` 凭证不被误判为畸形;**service 级跨应用**:为 A 应用的客户签 B 应用的令牌 → 抛错且不落行;被外部写坏的绑定行 → resolve 抛错。host-read-rate-limit.test.ts 增饱和一次性告警断言。
变异测试:分别撤掉绑定校验(resolve/issue)与环境 400 前置,对应新用例转红后恢复。
全量:unit 148/148、integration 243/243(迁移 0018 双跑,`information_schema` 确认三列均为 `timestamp with time zone`)。
