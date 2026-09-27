# Agent Note: 零小数货币注册表是唯一权威

Status: implemented — PR #116 (eddf97c) 落地,含对账脚本

## Problem

三个位置对"某币种是否零小数"给出互相矛盾的答案:PayPal 适配器表认 MGA/XAF 不认 ISK,Waffo 表认 ISK 不认 MGA/XAF,向导硬编码 ×100,仪表盘硬编码 ÷100。同一 JPY/ISK 商品经不同 provider 可产生 **100 倍价差**——这是全审计中唯一"已经实际漂移且直接改写资金金额"的冗余(A1)。

## Decision

`src/lib/money.ts` 是唯一权威:`ZERO_DECIMAL_CURRENCIES` = ISO-4217 零小数集(BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF)**+ ISK**(采用 Stripe 式实务 0 位小数,有意取代 PayPal 旧表的 2 位处理——统一即要有单一答案);`currencyDecimals` 只返回 `0 | 2`;`parseDisplayAmountToMinor` / `parseProviderAmountToMinor` / `minorToDisplayString` 全部纯函数、无浮点、客户端安全。两个适配器、向导、`lib/format.ts` 全部改接注册表;Creem 经查为纯透传(provider 已给 minor unit),无需统一。

## Alternatives considered

- **保留各 provider 自己的表**:否决。规格是外部事实(ISO 4217),重复即规格分裂;两套测试各自都绿恰恰说明测试锁不住它。
- **支持 3 位小数货币(KWD/BHD 等)**:否决。全库 grep 证明不存在 3 位小数处理与相关币种使用;引入即过度设计。
- **只统一适配器、不动向导/展示层**:否决。向导 ×100 与展示 ÷100 是同一规格的另外两面,留下任何一处都保留 100 倍错误类。

## Consequences

- **存量数据风险**:按旧表写入的历史行(PayPal-ISK、Waffo-MGA/XAF、旧向导录入的零小数币种价格)可能偏差 100 倍。代码已统一,数据未迁移——配套只读对账脚本 `scripts/reconcile-currency-decimals.mts`(经 100 倍种子行冒烟验证),每行须与 provider 结算单核对后人工处置,脚本永不写库。
- PayPal 渠道的 ISK 行为变化(2 位 → 0 位)是有意的;若有真实 PayPal-ISK 历史流量,对账脚本会列出。
- 再议条件:引入任何 3 位小数币种,或新增 provider 自带 decimals 语义时,必须改本注册表而非本地表。

## Verification

`tests/money.test.ts` 18 个单元测试(含 JPY 分数拒绝、大小写、分组、溢出、非安全整数抛错);paypal/waffo 适配器测试钉住序列化后的请求金额;Verifier 做过全库浮点运算清扫(`10 **`/`toFixed`/`Math.round` 仅存于非 decimals 语境)。
