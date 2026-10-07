# Agent Note: 迁移重编号必须以升级路径判别验证（fresh-migrate 绿不算数）

Status: implemented — 已随 #151 落地为 `tests/integration/migration-upgrade-path.test.ts`（commit db5109f）。

## Problem

PR #150 合并 `0019_operator_credential_version` 到 main 后，#151 的迁移从 0019 重编号为 0020。重编号时直接改写了 `_journal.json` 里 main 已存在的 0019 条目（idx 19→20），并为 0020 填了一个**早于** 0019 的 `when`（1790800000000 < 1790900000000）。

两处都错了，但第二处是静默的 P0：drizzle migrator（pg-core dialect）只应用满足 `Number(lastDbMigration.created_at) < migration.folderMillis` 的迁移。已部署 main@0019 的真实升级库，lastDbMigration = 1790900000000，0020 的 folderMillis 更小 → **被静默跳过**。跳过意味着旧 `credit_transactions_type_check` 不含 `grant.revoked`，订阅取消的 clawback INSERT 将失败、已付积分无法撤销。

而仓库现有 CI（fresh DB → `db:migrate` → 再 `db:migrate`）对空库跑全部条目，**永远不会暴露这个缺陷**。外部评审四轮才抓住，前三轮的"已修复"声明中还有两次是字符串编辑静默失败导致的虚报。

## Decision

1. **journal 对 main 只允许纯追加**：不改写任何已合并在 main 的条目（idx/when/tag 均不动），新迁移追加且满足 `idx` 严格递增唯一、`when` 严格大于前一条。
2. **迁移类变更的验证标准升级**：fresh-migrate 绿不构成放行证据；必须有**升级路径判别**——scratch 库先迁移到 base 分支的 tip（journal 截断），再用分支完整 journal 迁移，断言新条目真的应用了（行数 +1）、目标约束/DDL 生效、相关写路径可用、再迁移 repeat-safe。
3. **负面验证纪律**：鉴别器测试必须证明"坏状态会红"——在真实 PG 上分别用坏/好 journal 各跑一次升级流，确认坏 journal 行数不动（静默跳过复现）、好 journal 应用成功，然后才相信测试有效。

## Alternatives considered

- **只修 journal 数值、不加测试**：下一个重命名/重排迁移的人会原样再犯（CI 仍然全绿），不可接受。
- **在 CI 里加"部署模拟"job（先 checkout main 迁移、再切分支迁移）**：能抓到，但慢且重复了集成测试已有的基建；判别测试用程序化 migrator（`drizzle-orm/postgres-js/migrator`）在 scratch 数据库上等价复现同一谓词，代价小得多。
- **静态 lint 规则校验 journal**：只覆盖结构（idx/when 单调），覆盖不了"新 SQL 的 DDL 是否真在升级库上生效"；作为测试的前置断言保留，不单独作为门禁。

## Consequences

- 重编号/重排迁移时，journal 编辑必须配合升级判别测试同 PR；`migration-upgrade-path.test.ts` 的静态断言（idx 递增、when 递增）会让 journal 结构性损坏在碰库前就失败。
- 该测试以 `MAIN_TIP_TAG = 0019_...` 锚定 base；未来 main tip 变化时需同步该常量（与 `drizzle/meta/_journal.json` 同 PR）。
- 接受的残余：升级判别只覆盖 journal→DDL 一层，不自动覆盖"新列对旧数据的回填语义"（如 0010 那类 backfill 迁移），那类仍需按迁移自身语义补测试。

## Verification

`pnpm vitest run tests/integration/migration-upgrade-path.test.ts --config vitest.integration.config.ts`：
20 条（main@0019）→ 21 条（0020 应用）→ 约束含 `grant.revoked` → 真实 clawback INSERT 成功 → 第三次迁移仍 21。
坏 journal（when 前移）双向实证：测试红（静态断言先行命中），独立 node 探针在 PG 上复现行数 20→20 的静默跳过。
