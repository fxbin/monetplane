# Agent Note: 设置页与积分页的第一版范围(2026-10-06 圆桌裁定)

Status: implemented — PR1-PR4 落地(操作员改密、/settings 聚合页、/credits 总览、grant 过期管线)

## Problem

侧边栏 Settings 与 Credits 两项长期 comingSoon。设置能力散落(项目信息创建后不可改、操作员无法自助改密——密码泄露只能重置 ADMIN_PASSWORD 环境变量并重启,是真实安全债);积分账本核心完整但控制台无任何总览面,credit type 是自由字符串,bucket 过期 cron 无 UI 入口。

## Decision

圆桌(陈砚秋/苏婉/林小雨,2 轮收敛)裁定:

1. **设置第一版** = 操作员密码自助修改(最高优先,复用 team/password.ts,工作区级守卫+审计)+ /settings 两 tab(workspace 聚合链接卡 + profile 改密表单)。环境切换**留在顶栏**(上下文语义,非配置语义)。
2. **积分第一版** = /credits 四区块:按类型余额分布、近 7 天流水、30 天内过期 buckets、生效中预留(带"不会自动释放"告警——reservations 有 expiresAt 列与 expired 枚举但无 sweeper)。
3. **无目录方案**:类型列表从账本 group by 反推,不建 registry 表;发放入口由 normalize 校验兜底。registry 后置,回归条件=第二个真实需求(如面向客户的积分商城)。
4. **grant 过期管线**:admin grant 路由补解析 expiresAt(ex ISO / expiresInDays 整天数),发放对话框加有效期字段;过期 cron 从此有 UI 入口。
5. **机械护栏**:写路径强制 normalizeCreditType(trim+小写+正则白名单,失败报错);集成测试钉死"带空格/大写的输入被规范化"与"expiresAt 落到 bucket 行"。

## Alternatives considered

- **项目改名(PATCH+审计)进第一版**:否决——没人问过,PATCH 牵动 SDK 鉴权/webhook 校验/portal 域名路由;回归条件=只走 PATCH+审计事件。
- **项目归档**:直接否决——applications 对 credit_accounts 是 onDelete cascade,硬删级联毁账本;软标志语义未定义。红线入本笔记。
- **credit type registry 表**:否决(第一版)——新迁移+grant config 改造+双语词典,隐性三周;先让字符串聚合上线,等拼写漂移被真实报上来再建。届时最小化:软删+key 不可复用,不回填 FK。
- **credit type 改名工具**:否决——账本 append-only,改名断审计链。
- **批量发放/CSV 导入**:否决——单人维护,误操作半径必须压小。
- **发行总量虚荣指标**:否决——运营者真正关心"钱发出去了谁在烧",不是总量。

## Consequences

- reservations 过期 sweeper 仍缺(有列有枚举无写入点):第一版只读展示+告警文案;sweeper 另立议题,落地时按 release 语义处理并同步更新 /credits 页告警。
- 未来 registry 落地时与商品 grant config referenceKey 的衔接:运行时校验优先,不回填 FK(存量回填是一次性大迁移,风险大于收益)。
- 改密后既有会话不强制失效(credentials provider 每请求验密):可接受的残余风险;强制下线另立议题。
