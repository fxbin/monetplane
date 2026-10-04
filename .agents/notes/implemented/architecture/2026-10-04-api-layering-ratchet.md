# Agent Note: API 面分层的窄红线棘轮(Phase 2.2 裁定)

Status: implemented — 2026-10-04 圆桌(四角色两轮)裁定,roundtable batch 1 落地,由 tests/module-boundaries.test.ts 机械执法

## Problem

分层契约 `app → components → control-plane → modules → db` 由 module-boundaries 测试执法,但只扫描 `(dashboard)` 与 `components`;`src/app/api` 下 47 个文件 value-import `@/modules`、8 个文件直连 `@/db`,资金主面完全未设防。两个候选方案都有硬伤:方案甲(全量收敛 route → control-plane)在单人维护下是烂尾大扫除的标准开局;方案乙(官方化"route 即编排层")是把现状盖章合法化,双路径教义并存后 46 处会涨到 90+。

## Decision

圆桌合并案(陈砚秋/Kate/老麦/林小雨四方收敛):

1. **窄红线**:API route 禁止 `import @/db`——**任何形式,含 `import type`**(刻意严于 UI 规则的 type 豁免;route 层不应依赖 schema 形状)。存量 8 处进 `API_DIRECT_DB_ALLOWLIST`(health 是刻意永久居民——存活探针本就要摸库)。新违规 CI 硬失败。已知边界:无 `from` 的纯副作用 import(如 `import "@/db/client"`)不被正则捕获,当前零实例,出现时以同样语义处置。
2. **零豁免棘轮**:白名单只减不增,长度上限 8 由断言机械锁定,无人工豁免通道;白名单数字就是收敛进度条。新增条目必须先删另一条。
3. **hof 先行,童子军收敛**:先抽 route hof(guard 序言×28 / JSON 解析×15 / 错误映射),让"过 control-plane"从加层变成删样板;资金 route 因修缺陷或重构被触碰时顺手搬离红线。**不设限期**——搬迁永远给资金修复让路(陈砚秋当轮撤回限期归零;原搬迁工时预算砍半拨给契约测试)。
4. 定位共识:测试是抓缺陷的网,分层是压爆炸半径的墙;墙只砌资金面最窄一条(`@/db` 直连),modules 深层 import 暂不划线。

## Alternatives considered

- **方案甲全量限期收敛**:否决——窗口期与资金缺陷修复抢同一批人,无人担保不烂尾在第 30 个 route。
- **方案乙官方化 route 为编排层**:否决——盖章即双教义,重复的幂等/审计/失败分类实现会继续在 route 层繁殖。
- **红线切"资金 route 禁 @/modules"**(更宽执法):否决(本轮)——47 处起步的白名单维护成本超过单人收益;等 hof 落地、样板删除后再评估扩线。

## Consequences

- 8 处存量(含 health、cron、webhook receiver、entitlements/check、console-context、credits/balance、customer-read-tokens×2)继续直连,直到各自被触碰;`tests/module-boundaries.test.ts` 的长度断言(≤8)保证不会变多。
- 圆桌同时裁定的批次排序(第 1 批已落地:审计同事务、adapter 失败分类统一、最小集成 testSetup、本红线;第 2 批:webhook.ts 拆分+路由顺手收敛+hof+错误码 SSOT;不做清单见路线图)与本笔记互为上下文。
- 圆桌原始记录:`.vidt/roundtable-r2/`(本地不入库);Memory 契约 lint 0 错 0 警。
