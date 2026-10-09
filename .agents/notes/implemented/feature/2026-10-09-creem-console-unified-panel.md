# Agent Note: #157 控制台统一操作面的状态-动作映射

Status: implemented — 单面板按映射状态渲染可用动作;盲重试结构性缺席;生产环境二次确认;修订(review round 1):创建按钮能力门控(双层);标记失败加专用确认;快照恢复文档重写

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

## Revision (review round 1,人工复核 PR #160)

1. **创建能力双层门控(F2)**:服务端在 beginProvision **之前**做能力预检(无 catalog_provisioning → 400 provider_unsupported,**零意图行残留**);控制台由 getProductBuilderDetail 解析能力并作为 `providerSupportsCreate` 门控创建按钮,无能力时显示「请改用关联」提示,能力解析失败 fail-closed。
2. **标记失败加专用确认(F4)**:解除不确定态保护在任何环境都是审慎动作(若原商品实际存在,后续重建可能重复)——`window.confirm(markFailedConfirm)` 无条件执行,与生产确认相互独立。
3. **canLink 补 !failing(F3)**:四个写动作(create/link/mark-failed/verify)现已完全互斥。
4. **快照恢复文档重写(F1)**:明确「数据库快照回滚 ≠ 目录回滚」——新幂等键**不能**去重遗留商品,直接重建会产出第二个外部商品;给出五步安全恢复顺序(暂停→查找→核实→采纳→确认不存在才新建)。
5. **(round 2)回滚规则修正**:禁止把 DROP 映射表当默认回滚——仅存在于新表的商品 ID 会使 Checkout 失去映射来源;正确顺序=先回滚应用代码、保留数据库映射,仅在旧版 Checkout 映射来源确认完整 + 备份核对 + 人工审批后才可清理新表。四操作互斥补齐 verify(failing 期间禁用)。

## Revisit when

- 真实 Sandbox 验收(#157 外部证据)反馈恢复流程文案/步骤是否充分;
- 若需要批量操作(多价格同时创建)或搜索渠道商品(查重),另起 issue。
