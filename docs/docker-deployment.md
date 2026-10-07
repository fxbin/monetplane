# Docker 部署(自托管)

两种模式共用同一个镜像(多阶段构建,运行时仅含生产依赖 + 构建产物 + `drizzle/` 迁移 journal):

| 模式 | 适用 | 数据库 | 迁移执行 |
|---|---|---|---|
| 1. 外部 PostgreSQL | 已有 DB(Neon / RDS / 自管) | `DATABASE_URL` 指向外部 | `docker run --rm <image> migrate`(操作员显式) |
| 2. docker-compose 集成 | 单机自托管起步 | compose 内置 PostgreSQL 17(与 CI 同版本) | 一次性 `migrate` 服务,`app` 依赖其成功退出 |

**迁移永远不会在 `serve` 启动时隐式执行**——涉钱系统的 schema 变更是操作员步骤,先回读再应用(见 §升级)。

## 镜像内密钥语义(fail-closed)

镜像不包含任何密钥;全部运行时注入。缺失时的行为与源码语义一致(`src/config/env.ts`):

- `DATABASE_URL` / `AUTH_SECRET` 缺失或非法 → **入口 preflight 在起服务前退出(容器 exit 1,不进 serving 状态)**——standalone 会把 env 校验内联进按需加载的 route chunk(缺密钥时进程照常启动、请求全 500),`scripts/preflight-env.mts` 复用同一份 getter 恢复进程级 fail-closed;
- `MONETPLANE_ENCRYPTION_KEY` 缺失或非 32 字节 base64 → 首次加解密使用时抛错;
- `CRON_SECRET` 留空 → `/api/cron/*` 全部 401(过期任务不会运行);
- `ADMIN_PASSWORD` 留空 → 首个操作员的自举登录禁用(已有操作员走正常登录)。

## 模式 1:外部 PostgreSQL

```bash
# 构建并推送到你的 registry
docker build -t <registry>/monetplane:<tag> .
docker push <registry>/monetplane:<tag>

# 1) 迁移前回读(对账,发现意外漂移即停)
docker run --rm \
  -e DATABASE_URL=<prod-url> \
  <registry>/monetplane:<tag> migrate

# 2) 起服务(0.0.0.0:3000,容器内端口 3000)
docker run -d --name monetplane \
  -p 3000:3000 \
  -e DATABASE_URL=<prod-url> \
  -e AUTH_SECRET=<secret> \
  -e MONETPLANE_ENCRYPTION_KEY=<key> \
  -e CRON_SECRET=<secret> \
  -e ADMIN_PASSWORD=<初始操作员密码> \
  <registry>/monetplane:<tag>

# 3) 健康检查(DB 连通性)
curl -fsS http://localhost:3000/api/health
```

自托管于反向代理之后时:仅当代理会覆写 `x-forwarded-for` 才设置 `MONETPLANE_TRUST_PROXY=true`(否则勿设,见 `.env.example` 的 host-read 限流说明)。

## 模式 2:docker-compose(集成 PostgreSQL)

```bash
# .env 放在项目根(compose 变量插值;缺必填项会直接报错拒绝启动)
cat > .env <<'EOF'
POSTGRES_PASSWORD=<为内置 PG 生成>          # 必填,无默认值
AUTH_SECRET=<openssl rand -base64 32>
MONETPLANE_ENCRYPTION_KEY=<openssl rand -base64 32>
CRON_SECRET=<openssl rand -base64 32>
ADMIN_PASSWORD=<初始操作员密码,可后改>
# 可选:POSTGRES_USER / POSTGRES_DB / APP_PORT(默认 monetplane / monetplane / 3000)
EOF

docker compose up -d          # pg healthy → migrate(一次性)→ app
docker compose logs migrate   # 审计应用了哪些迁移
curl -fsS http://localhost:3000/api/health
```

数据卷 `postgres-data` 持久化数据库;`docker compose down` 不删数据,`down -v` 会删(危险)。

### 定时任务(可选)

`CRON_SECRET` 已设置时,从任意调度器触发:

```bash
# 每小时积分过期清扫(按 docs/credits-ledger.md 的运维说明调整频率)
0 * * * * curl -fsS -H "Authorization: Bearer <CRON_SECRET>" \
  http://<host>:3000/api/cron/credit-expiry
```

## 升级流程(与发布门禁交接一致)

```text
1. 回读生产迁移历史,与本地 drizzle/ journal(21 条)对账
   docker exec <pg> psql -U <user> -d <db> \
     -c 'select count(*), max(created_at) from drizzle.__drizzle_migrations;'
   远端出现本地没有的迁移 → 停,先对账
2. 换新镜像标签;compose 模式:docker compose up -d(migrate 服务幂等重放,0 应用)
   外部 PG 模式:先 docker run --rm <new-image> migrate 再滚动重启 app
3. 回读计数 = journal 条数;curl /api/health = 200
```

## 构建细节

- 运行时采用 Next `output: "standalone"`(运行时文件追踪),镜像 ≈ **217MB**(node:22-alpine 基础 ~155MB + 追踪产物);`next start`/Vercel 部署不受该配置影响。
- `scripts/migrate.mts` 与 `scripts/preflight-env.mts` 从独立的 `migrator/` 依赖树解析(drizzle-orm 与 postgres 均零传递依赖,从构建层解引用拷贝)——服务端代码会被内联进 standalone chunk,追踪产物里没有这两个包。
- `next build` 阶段仅需 build-only 的 `AUTH_SECRET`(模块级求值);真实密钥运行时注入,不进镜像层。
- 迁移器与 `drizzle-kit migrate` 使用同一 migrator 与同一 `drizzle/` journal;重复执行幂等(升级路径测试覆盖)。
- 运行容器以非 root 用户 `nextjs` 运行;`HEALTHCHECK` 走 `/api/health`。
- 构建期 npm registry 默认官方源;网络不稳时可覆盖(compose 在 `.env` 加 `NPM_REGISTRY=...`,裸 docker 加 `--build-arg NPM_REGISTRY=...`)。lockfile 的 sha512 完整性校验与 registry 无关,镜像源无法注入被篡改的包。
