# Agent Note: #157 控制台统一操作面的状态-动作映射

Status: implemented — 单面板按映射状态渲染可用动作;盲重试结构性缺席;生产环境二次确认

## Problem

#157 要求把「Create in Creem」与「Link existing」收敛进一个可理解、可审计的商品管理入口:synced 不得默认提供创建第二份,不确定态提供恢复而非盲目重试,生产环境外部写需显著确认。

## Decision

1. **状态驱动的动作可见性**(而非禁用):`unconfigured` → 创建+关联;`pending/creating` → 仅提示等待;`synced` → 仅展示映射(无任何写入口);`needs_reconciliation` → 采纳(link)+ 标记失败重试 + 解释文案;`failed` → 重试创建 + 关联。UI 层面让「错误操作」不可见而非可点击后报错。
2. **生产确认**:environment==='live' 时,create 与 link 提交前强制 `window.confirm`(显著文案含「真实商品/正式流量」);preview 只读不确认。
3. **面板按 `key={env:connection}` 重挂载**(承接 #158 round-4 结论)+ 四元组验证身份 + AbortController 所有权检查——create/mark-failed 动作天然无客户端校验态,直接走服务端二次校验。
4. **恢复即现有 API**:采纳=link 端点(服务端 NR/failed→synced 语义来自 #159),标记失败=fail-intent 端点;#157 未新增任何服务端写路径。
5. **文档**:`docs/creem-catalog.md` 承接 issue 要求的接口边界/映射策略/Webhook 与 SDK 区别/DB 恢复升级说明,并内嵌真实 Sandbox 验收清单(外部证据,操作员执行)。

## Alternatives

- 每价格一行表格化(否决:多价格产品较少,选择器+单状态卡信息密度更合适;#157 后续真实使用反馈再演化);
- 禁用而非隐藏不适用的按钮(否决:隐藏更能传达「此状态无此操作」的语义,避免禁用态的权限歧义);
- 新增 recovery 专用端点(否决:复用 #159 的采纳/失败语义,避免第二套恢复逻辑)。

## Revisit when

- 真实 Sandbox 验收(#157 外部证据)反馈恢复流程文案/步骤是否充分;
- 若需要批量操作(多价格同时创建)或搜索渠道商品(查重),另起 issue。
