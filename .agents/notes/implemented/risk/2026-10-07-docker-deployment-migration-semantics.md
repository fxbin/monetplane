# Agent Note: Docker 化部署的迁移显式性决策

Status: implemented — 外部 PG 与 compose 集成两模式共用镜像;迁移仅在显式 `migrate` 命令或一次性 compose 服务中执行

## Problem

Docker 化引入一个结构选择:迁移在容器启动时隐式执行(entrypoint 自动 `migrate`),还是保持操作员显式步骤?涉钱系统的 schema 变更如果随每个 app 副本自动应用,会在滚动发布/多副本场景下产生并发迁移与"未经对账就变更"的风险,且与发布门禁(production-bound 协议)要求的"先回读生产迁移历史、对账后再应用"流程冲突。

## Decision

**迁移显式化,永不随 `serve` 隐式执行**:

- 镜像入口 `docker-entrypoint.sh` 仅两态:`serve`(next start)/ `migrate`(应用 journal 后退出);
- 外部 PG 模式:`docker run --rm <image> migrate`,操作员在对账后执行;
- compose 模式:独立一次性 `migrate` 服务,`app` 通过 `service_completed_successfully` 依赖其成功——迁移成为可见、可审计的离散步骤,而非隐藏的 boot 副作用;
- 未采用 `MIGRATE_ON_BOOT` 类自迁移开关:减少一条代码路径,避免"开关误开 + 多副本并发应用"的事故类别。

## Alternatives

- entrypoint 自动迁移(否决:绕过对账流程;多副本并发风险);
- 运行时镜像内携带 drizzle-kit(否决:devDep 入生产镜像,面扩大;`drizzle-orm` 自带 migrator 足够)。

## Revisit when

出现单副本不可行的部署形态(多 app 副本必须自动收敛 schema)时,重新评估受控自动迁移(如 leader-election + 锁)。
