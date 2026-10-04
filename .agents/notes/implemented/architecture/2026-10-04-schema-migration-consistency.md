# Agent Note: schema 入口全量 re-export 与迁移一致性机械化

Status: implemented — 2026-10-04 项目审查 Phase 2(finding 2.1)落地,tests/db-schema-consistency.test.ts 钉死

## Problem

`src/db/schema.ts`(drizzle.config.ts 的生成入口)只 re-export 9 个模块 schema,而含 `pgTable` 的模块 schema 文件有 14 个——team/portal/usage/customers.read-token/operations.audit 共 5 个缺席,即 `pnpm db:generate` 会基于落后 9 个迁移的不完整基线产出错误 diff。AGENTS.md 硬约束 6("schema 与迁移同 PR 同步")此前纯靠人工纪律;`drizzle/meta/` 从未提交 snapshot,journal 后 5 条的 `when` 时间戳为人工编造的等差数列。

## Decision

1. 补齐 14 个 re-export,入口处注释声明"每个声明 pgTable 的模块 schema 必须 re-export"。
2. 新增 `tests/db-schema-consistency.test.ts` 把约束机械化(与 module-boundaries 测试同风格):①扫描 src/modules 下含 `pgTable(` 的 schema 文件必须被入口 re-export;②入口运行时导出的表集合(经 `is(v, Table)` 枚举)与全部迁移 SQL 的 `CREATE TABLE` 并集**双向**对齐——schema 落后或迁移缺失任一方向都红;③`_journal.json` 条目与 .sql 文件名集合严格对齐。双向比对同时覆盖了 `export *` 符号撞名被静默吞掉的工况(表会从导出集合消失→红)。

## Alternatives considered

- **重建 drizzle snapshot 基线(introspect)+ CI 跑 generate --check**:方向正确但需对本地库 introspect 并生成 meta 文件,涉及对 `drizzle/meta` 历史的处置,本轮不做——见 Consequences 的再议条件。
- **只在 CI 数文件个数**:否决。计数无法发现"表建了但 schema 没写/写错"的漂移,双向集合比对才有约束力。

## Consequences

- 已接受的残余:`drizzle/meta/*.snapshot` 仍未入库、journal 时间戳仍是手工值——**migration 工具链的 diff 能力未恢复**,新增迁移仍须手写 + 本测试对账。再议条件:下一次需要 `db:generate` 自动 diff 时,以 `drizzle-kit introspect` 重建 snapshot 并入 PR(届时测试③可作为锚点验证)。
- 迁移史确认无 `DROP TABLE`/`RENAME`(测试注释已声明该前提);未来首次出现 DROP/RENAME 时,CREATE 并集口径需同步演进。
