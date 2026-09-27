# AGENTS.md — AI agent 入口(知识地图与硬约束)

> 本文件是给 AI agent / 新贡献者的**入口地图**,只放指针与硬约束,不复制正文——
> 正文只在一处维护,避免第二份拷贝漂移。最后更新:2026-09-27(post-remediation)。

## 这个仓库是什么

MonetPlane:开源的多产品货币化控制平面(Next.js 16 + Drizzle + PostgreSQL,
pnpm,biome,TS strict)。当前状态:P0/P1 完成,P2 已实现(见 `README.md` Status)。

## 知识地图(什么信息住在哪里)

| 位置 | 回答的问题 | 形态 |
|---|---|---|
| `docs/` | **是什么 / 怎么用 / 怎么接** —— 面向集成方与贡献者的参考 | 随代码同 PR 更新的现行文档 |
| `.agents/notes/` | **为什么这样定 / 放弃了什么 / 何时再议** —— 决策语料 | VIDT agent-notes 契约;lifecycle 迁移;校验门禁 `scripts/verify_agent_notes.py`(在 VIDT skill 内) |
| `tests/` | **可执行的真源** —— 行为与边界的最终裁决 | `tests/module-boundaries.test.ts` = 分层契约的机械形态;集成测试需真实 PG |
| `.vidt/` | 本地机器状态(decision log / evidence / iterations) | **永不提交**;他人克隆中不存在属正常 |
| `docs/architecture.md` | 系统边界、模块、数据规则(§6 十二条不变量) | 架构参考起点 |
| `docs/sdk-quickstart.md` | 集成方接入(SDK 方法表、凭证要求、错误处理) | 接口契约的用户视角 |
| `docs/provider-adapter-guide.md` | 新增支付适配器的步骤与共享层 | 先读 §"Shared adapter kit" |
| `docs/credits-ledger.md` | 积分账本语义 + 过期 cron 运维 | 含调度与密钥说明 |

## 常用命令

```bash
pnpm lint            # biome(0 错误基线;警告 ~17 条为已知)
pnpm typecheck       # tsc --noEmit
pnpm test            # 单元(148)
pnpm test:integration  # 集成(179);需 DB:先 `set -a && source .env && set +a`
pnpm build           # 需要 AUTH_SECRET(CI 用 build-only 值)
node --experimental-strip-types --env-file=.env scripts/reconcile-currency-decimals.mts
                     # 只读货币对账报告(永不写库)
```

## 改代码前必须知道的硬约束(违者=资金/安全风险)

1. **金额一律 minor-unit 整数** + `Number.isSafeInteger`;禁止浮点货币运算;币种小数位只认 `src/lib/money.ts` —— 任何地方都不得自建零小数货币表(历史教训:双表分歧造成过 100 倍价差)。
2. **涉钱写路径必须走 journal**(`billing-operation-actions.ts`):带幂等键、record-before-provider、审计与 journal 同事务。不得新增绕过 journal 的退款/取消/发放实现;审计写入属于操作层,路由不得自行写操作审计。
3. **资金变更端点必须 `source === "credential"`**(`resolveCredentialApplicationContext`);Host 回退只允许只读面。密钥全部 fail-closed(`AUTH_SECRET`/`CRON_SECRET`/`MONETPLANE_ENCRYPTION_KEY` 无默认回退)。
4. **环境解析 fail-closed**:非法 environment 报错,禁止静默 coerce。
5. **分层方向**:app → components → control-plane → modules → db,由 `tests/module-boundaries.test.ts` 机械化;测试里的豁免清单条目 = 已评审决策,新增豁免需等价论证。
6. **check 约束**:`src/modules/*/schema.ts` 与 `drizzle/` 迁移必须同 PR 同步(曾有 actor-check 漂移)。
7. **文档分层**:行为/接口变化 → 同 PR 更新 `docs/` 对应文件;产生跨轮成立的决策(范围裁定、接受的残余风险、否决方案)→ 在 `.agents/notes/` 按契约写笔记(路径 `{lifecycle}/{class}/yyyy-mm-dd-slug.md`,Status 行必填)。

## 快速校验清单

```bash
python3 <vidt-skill>/scripts/verify_agent_notes.py --repo-root .   # notes 契约门禁
pnpm vitest run tests/module-boundaries.test.ts                    # 分层契约
```
