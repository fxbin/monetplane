# Agent Note: standalone 运行时削弱 env fail-closed,入口 preflight 恢复

Status: implemented — `scripts/preflight-env.mts` 在容器 serve 前复跑 env.ts 强制项;镜像 603MB→217MB

## Problem

镜像从 `next start` 全量运行时切换为 Next `output: "standalone"`(运行时文件追踪)以把 603MB 压到 ~217MB。切换暴露一个语义差异:standalone 把 `src/config/env.ts` 的 fail-closed 校验**内联进按需加载的 route chunk**——缺 `AUTH_SECRET` 时进程照常 Ready,只是所有请求 500(middleware 模块求值即抛)。没有认证旁路(无 secret 无法签发 session),但"缺关键密钥 → 进程即崩"的运维可见性契约(发布门禁 V1 审计确认过的行为)在打包层被静默削弱。

## Decision

1. 采用 standalone(收益:体积 -64%、攻击面缩小到追踪产物);
2. 入口 `serve` 分支先跑 `scripts/preflight-env.mts`:调用与 `next start` 时代模块求值**同一组 getter**(`getDatabaseUrl` + `getAuthSecret`),缺任一 → exit 1,容器不进 serving 状态。范围严格限定原先模块级求值会崩的两项;可选项(CRON_SECRET/ADMIN_PASSWORD)与使用时校验(加密钥结构)保持原语义——不在打包层发明新规则。

## Alternatives

- 回退 `next start` 全量运行时(否决:603MB + 更大依赖面,仅为省一个 preflight);
- `serverExternalPackages` 强制 drizzle-orm/postgres 外置以复用 node_modules 供迁移器(否决:改变应用打包行为;改为独立 `migrator/` 依赖树,两包零传递依赖,从构建层解引用拷贝)。

## Revisit when

应用新增"模块级求值即抛"的环境强制项时,preflight 同步纳入(保持与 next start 行为等价)。
