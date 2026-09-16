# CryptoSentry Dashboard API（阶段二）

本文档对应 Dashboard 下一版的后端契约。服务默认地址为 `http://127.0.0.1:3001`，业务接口统一位于 `/api/v1`，并要求：

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

Swagger UI：`GET /docs/`；OpenAPI JSON：`GET /docs/json`。

## 1. EVM RPC Integration

完整配置类型：

```ts
type EvmRpcIntegrationConfig = {
  rpcUrl: string;
  chainIds: number[];
  routing:
    | { mode: "fixed" }
    | { mode: "url_template"; chainIdPlaceholder?: string }
    | { mode: "header"; headerName: string; valueTemplate?: string }
    | { mode: "query"; parameterName: string };
  headers?: Record<string, string>;
  timeoutMilliseconds: number;       // 默认 5000
  multicallBatchSizeBytes: number;   // 默认 8192
};
```

`chainIds` 会去重。`fixed` 只能包含一个 chainId。URL 模板会在替换占位符后校验最终 HTTP(S) URL。`header` 的 `valueTemplate` 默认 `{chainId}`。所有静态 Header 值和 `rpcUrl` 都是敏感信息，列表、详情、创建和修改响应中均显示 `********`，错误与日志不会输出它们。

旧请求 `{ "chainId": 1, "rpcUrl": "..." }` 继续接受，并在运行时规范化为 `chainIds: [1]` 与 `routing: {mode:"fixed"}`。新响应只使用 `chainIds` 和 `routing`；旧字段 `chainId` 已废弃。

### fixed：普通单链 RPC

```json
{
  "name": "Ethereum RPC",
  "type": "evm_rpc",
  "provider": "alchemy",
  "enabled": true,
  "config": {
    "rpcUrl": "https://eth-mainnet.example/v2/secret",
    "chainIds": [1],
    "routing": { "mode": "fixed" },
    "timeoutMilliseconds": 5000,
    "multicallBatchSizeBytes": 8192
  }
}
```

### url_template：URL 路由

```json
{
  "rpcUrl": "https://gateway.example/{chainId}/rpc",
  "chainIds": [1, 4663],
  "routing": { "mode": "url_template" },
  "headers": { "Authorization": "Bearer secret" },
  "timeoutMilliseconds": 5000,
  "multicallBatchSizeBytes": 8192
}
```

可用 `chainIdPlaceholder` 指定其他占位符。

### header：Header 路由

```json
{
  "rpcUrl": "https://gateway.example/rpc",
  "chainIds": [1, 4663],
  "routing": {
    "mode": "header",
    "headerName": "X-Chain-Id",
    "valueTemplate": "chain-{chainId}"
  },
  "headers": { "X-API-Key": "secret" },
  "timeoutMilliseconds": 5000,
  "multicallBatchSizeBytes": 8192
}
```

### query：查询参数路由

```json
{
  "rpcUrl": "https://gateway.example/rpc",
  "chainIds": [1, 4663],
  "routing": { "mode": "query", "parameterName": "chainId" },
  "timeoutMilliseconds": 5000,
  "multicallBatchSizeBytes": 8192
}
```

### 创建、修改与查询

```http
POST   /api/v1/integrations
PATCH  /api/v1/integrations/:id
GET    /api/v1/integrations
GET    /api/v1/integrations/:id
DELETE /api/v1/integrations/:id
```

创建成功为 `201`，修改/查询成功为 `200`，删除成功为 `204` 且无响应体。修改 RPC 配置或启停状态后，原能力测试结果立即失效，必须重新测试。

RPC 的 PATCH 合并规则需要由 Dashboard 明确处理：

- `routing` 一旦出现在请求中就是整体替换；从 Header 切换到 Query、fixed 或 URL template 时，不需要也不能携带旧模式字段。
- `headers` 一旦出现在请求中也是整体替换；请求中省略的 Header 会被删除。
- 已存在 Header 的值可提交 `********` 以保留原始密文；新 Header 必须提交真实值。
- `headers: null` 清空全部静态 Header；完全省略 `headers` 则保持当前集合不变。
- `rpcUrl: "********"` 保留当前 URL。合并后的完整配置会重新执行严格校验。

脱敏响应示例：

```json
{
  "id": "int_rpc",
  "name": "Multi-chain gateway",
  "type": "evm_rpc",
  "provider": "custom",
  "enabled": true,
  "config": {
    "rpcUrl": "********",
    "chainIds": [1, 4663],
    "routing": { "mode": "header", "headerName": "X-Chain-Id", "valueTemplate": "{chainId}" },
    "headers": { "Authorization": "********" },
    "timeoutMilliseconds": 5000,
    "multicallBatchSizeBytes": 8192
  }
}
```

## 2. 逐链连接与能力测试

```http
POST /api/v1/integrations/:id/test
```

测试流程执行完成一律返回 HTTP `200`。每条链先校验 `eth_chainId`，再验证当前真正实现的协议。Ethereum 的 Aave 测试分别验证账户读取、Reserve 目录和事件日志；单项失败不会被配置存在所掩盖。单链失败不会丢弃其他链结果。顶层 `ok` 只有全部链成功时才为 `true`。

```json
{
  "ok": false,
  "provider": "custom",
  "networks": [
    {
      "chainId": 1,
      "chainName": "Ethereum",
      "ok": true,
      "blockNumber": "12345678",
      "connectivity": { "rpc": "ok", "aaveV3": "ok" },
      "aaveCapabilities": { "accountRead": "ok", "reserveCatalog": "ok", "eventLogs": "ok" },
      "error": null
    },
    {
      "chainId": 4663,
      "chainName": "Robinhood Chain",
      "ok": false,
      "blockNumber": null,
      "connectivity": { "rpc": "error" },
      "error": { "code": "RPC_CONNECTION_FAILED", "message": "RPC or protocol capability test failed" }
    }
  ]
}
```

## 3. Catalog

```http
GET /api/v1/integrations/catalog
```

重要结构示例（Binance provider 与 Uniswap deployment 目录仍保留）：

```json
{
  "marketData": {
    "providers": [{ "id": "binance", "name": "Binance", "requiresCredentials": false, "supportedMarketTypes": ["spot", "perpetual"] }]
  },
  "evmRpc": {
    "providers": [{ "id": "alchemy", "name": "Alchemy" }, { "id": "infura", "name": "Infura" }, { "id": "quicknode", "name": "QuickNode" }, { "id": "custom", "name": "Custom RPC" }],
    "routingModes": [{ "id": "fixed", "name": "单链" }, { "id": "url_template", "name": "URL 模板" }, { "id": "header", "name": "Header 选链" }, { "id": "query", "name": "Query 选链" }],
    "networks": [
      { "chainId": 1, "name": "Ethereum", "productEnabled": true, "capabilities": { "aaveV3": "available", "uniswapV3": "planned", "uniswapV4": "planned" } },
      { "chainId": 4663, "name": "Robinhood Chain", "productEnabled": true, "capabilities": { "aaveV3": "unsupported", "uniswapV3": "available", "uniswapV4": "available" } }
    ],
    "configDefaults": { "timeoutMilliseconds": 5000, "multicallBatchSizeBytes": 8192 }
  },
  "monitorTypes": [
    { "id": "market", "status": "available" },
    { "id": "aave_account", "status": "available", "chainIds": [1] },
    { "id": "aave_pool", "status": "available", "chainIds": [1] },
    { "id": "uniswap_position", "status": "available", "chainIds": [4663], "versions": ["v3", "v4"] },
    { "id": "uniswap_wallet", "status": "available", "chainIds": [4663], "versions": ["v3", "v4"] },
    { "id": "uniswap_pool", "status": "planned", "chainIds": [1, 4663], "versions": ["v3", "v4"] }
  ]
}
```

第二阶段 Catalog 还返回采样预设和规则指标目录。Dashboard 必须从这里渲染可选指标、operator、window 和 labels，不应硬编码：

```json
{
  "samplingPresets": [
    { "id": "realtime", "intervalSeconds": 5 },
    { "id": "standard", "intervalSeconds": 20 },
    { "id": "economy", "intervalSeconds": 60 }
  ],
  "ruleMetrics": {
    "market": [
      {
        "id": "open_interest_change_percent",
        "name": "未平仓量变化率",
        "kind": "gauge",
        "valueType": "decimal",
        "operators": ["gt", "gte", "lt", "lte", "eq", "neq"],
        "units": ["percent"],
        "requiresWindow": true,
        "windowSecondsMin": 5,
        "windowSecondsMax": 1800,
        "monitorTypes": ["market"],
        "marketTypes": ["perpetual"],
        "labels": ["marketType", "providerSymbol", "canonicalSymbol", "windowSeconds"]
      }
    ]
  }
}
```

Market 目录当前包含 `price`、`price_change_percent`、`base_volume_24h`、`quote_volume_24h`、`funding_rate_percent`、`next_funding_time`、`open_interest`、`open_interest_change_percent` 和 `data_age_seconds`。资金费率和 OI 仅适用于 perpetual。窗口上限与 30 分钟样本保留一致。

Aave Account 目录包含账户汇总、逐资产供应/债务、抵押开关、抵押/债务窗口变化，以及 `account_supply`、`account_withdraw`、`account_borrow`、`account_repay`、`account_liquidation`、`account_position_opened`、`account_position_closed` 事件。仓位开关事件仅在持久化的账户状态发生变化且能关联到新链上事件时产生。Aave Pool 使用 `aave_event_amount_token` 与 `aave_event_amount_usd`，用 `labels.eventType` 区分五类事件；Oracle 不可用时只产生 token amount，绝不把 USD 金额伪装为 0。

Arbitrum、Base、BNB 的旧 Aave Monitor 可继续运行，但新建产品目录不开放。Ethereum Uniswap 和 Uniswap Pool 在 2C 完成前不会伪装成 available。

### Aave Reserve 资源目录

```http
GET /api/v1/integrations/:rpcIntegrationId/aave/reserves?chainId=1
```

该接口要求 Integration 已启用、覆盖 Ethereum，并且最近的 `reserveCatalog` 能力测试通过。Pool、Addresses Provider、Data Provider、Oracle 和 token 地址均来自后端内置的 Aave 官方部署；Dashboard 不提交协议合约地址。成功响应：

```json
{
  "chainId": 1,
  "chainName": "Ethereum",
  "protocol": "aave",
  "version": "v3",
  "poolAddress": "0x...",
  "poolAddressesProviderAddress": "0x...",
  "status": "ok",
  "stale": false,
  "items": [{
    "underlyingAsset": "0x...",
    "symbol": "USDC",
    "name": "USD Coin",
    "decimals": 6,
    "aTokenAddress": "0x...",
    "stableDebtTokenAddress": "0x...",
    "variableDebtTokenAddress": "0x...",
    "active": true,
    "frozen": false,
    "borrowingEnabled": true,
    "usageAsCollateralEnabled": true,
    "priceUsd": "1",
    "priceStatus": "ok",
    "metadataStatus": "ok"
  }],
  "blockNumber": "12345678",
  "observedAt": "2026-09-16T00:00:00.000Z",
  "error": null
}
```

单个 token 元数据或价格失败返回 `status: "partial"`；对应 `name`/`priceUsd` 为 `null`。缓存读取失败时可以返回带 `stale: true` 的旧目录。尚未测试能力返回 `409 RESOURCE_CATALOG_NOT_READY`。

## 4. Readiness

```http
GET /api/v1/integrations/readiness
```

Readiness 只使用“启用且最近配置未改变，并已通过真实连接/能力测试”的 Integration。仅保存配置不会 ready。

```json
{
  "aave": {
    "ready": true,
    "configuredNetworkCount": 1,
    "networks": [{
      "chainId": 1,
      "name": "Ethereum",
      "ready": true,
      "integrationIds": ["int_rpc"],
      "capabilities": { "accountRead": true, "reserveCatalog": true, "eventLogs": true }
    }]
  },
  "uniswap": {
    "ready": true,
    "configuredNetworkCount": 1,
    "networks": [{ "chainId": 4663, "name": "Robinhood Chain", "versions": { "v3": true, "v4": true }, "integrationIds": ["int_rpc"] }]
  },
  "binance": {
    "ready": true,
    "sources": [{ "integrationId": "int_binance", "name": "Binance", "enabled": true, "marketCount": 1937 }]
  }
}
```

## 5. Monitor 类型与配置

```ts
type MonitorType =
  | "market"
  | "aave_account"
  | "aave_pool"
  | "uniswap_position"
  | "uniswap_pool"
  | "uniswap_wallet";
```

通用接口：

```http
GET    /api/v1/monitors
POST   /api/v1/monitors
GET    /api/v1/monitors/:id
PATCH  /api/v1/monitors/:id
DELETE /api/v1/monitors/:id
```

Monitor 可以没有 Rule，只做快照采集。Monitor 与 Rule 分别启停。

创建和 PATCH 更新使用同一套类型、协议能力和 RPC chainId 校验。PATCH `config` 可以只提交要修改的字段，后端先与当前配置合并，再验证最终配置并一次性写入；验证失败不会修改 Monitor，也不会发布配置变更事件。当前将 Uniswap 配置更新为 Ethereum 仍返回 `409 PROTOCOL_NOT_READY`，引用未覆盖目标链的 RPC 返回 `RPC_CHAIN_UNSUPPORTED`。

### 当前 available

`market` 配置保持不变：

```json
{ "integrationId": "int_binance", "marketType": "spot", "providerSymbol": "BTCUSDT", "canonicalSymbol": "BTC/USD", "priceType": "last" }
```

`aave_account` 目前只开放 Ethereum，并只使用指定 Integration：

```json
{ "rpcIntegrationId": "int_rpc", "chainId": 1, "walletAddress": "0x0000000000000000000000000000000000001234" }
```

`aave_pool` 监控 Ethereum Aave V3 的协议事件。`reserveAssetAddresses` 来自 Reserve 目录；省略或空数组表示全部 Reserve。创建与 PATCH 都拒绝目录外地址：

```json
{
  "rpcIntegrationId": "int_rpc",
  "chainId": 1,
  "reserveAssetAddresses": ["0x..."]
}
```

`uniswap_position` 目前支持 Robinhood V3/V4：

```json
{ "rpcIntegrationId": "int_rpc", "chainId": 4663, "version": "v3", "tokenId": "123" }
```

`uniswap_wallet` 的数组会去重；同轮按链与版本展开，部分失败保留成功结果：

```json
{ "rpcIntegrationId": "int_rpc", "chainIds": [4663], "versions": ["v3", "v4"], "walletAddress": "0x0000000000000000000000000000000000001234" }
```

### 当前 planned

- `uniswap_pool`：创建返回 `409 MONITOR_TYPE_NOT_READY`。
- Ethereum Uniswap：创建返回 `409 PROTOCOL_NOT_READY`。

### Legacy / deprecated

- `aave_position`：`{ "walletAddress": "0x..." }`，继续扫描原先支持的全部已配置 Aave 网络。
- `lp_position`：原 Robinhood 单版本 `walletAddress` 或 `tokenId` 配置继续运行。

列表与详情仍会返回已有 legacy Monitor，不进行删除或强制转换。

## 6. Rule Group

```ts
type RuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
type RuleCondition = {
  metric: string;
  labels: Record<string, string>;
  operator: RuleOperator;
  threshold: string;
  windowSeconds?: number;
  hysteresis: string;
};
type RuleGroup = {
  monitorId: string;
  name: string;
  combinator: "and" | "or";
  conditions: RuleCondition[]; // 1..20，不嵌套
  durationSeconds: number;
  cooldownSeconds: number;
  severity: "info" | "warning" | "critical" | "emergency";
  notificationIntegrationIds: string[];
  enabled: boolean;
};
```

接口不变：

```http
GET    /api/v1/rules
POST   /api/v1/rules
GET    /api/v1/rules/:id
PATCH  /api/v1/rules/:id
DELETE /api/v1/rules/:id
```

GET 始终返回 `combinator` 与 `conditions`。为旧 Dashboard 暂时保留首个 condition 的 `metric/labels/operator/threshold/windowSeconds/hysteresis` 响应别名；旧单条件 POST/PATCH 仍会自动转成 `and` + 单条件组。DELETE 成功为 `204`。

```json
{
  "monitorId": "mon_xxx",
  "name": "BTC 放量上涨",
  "combinator": "and",
  "conditions": [
    { "metric": "price_change_percent", "labels": { "windowSeconds": "300" }, "operator": "gte", "threshold": "3", "windowSeconds": 300, "hysteresis": "0.2" },
    { "metric": "price", "labels": {}, "operator": "gte", "threshold": "100000", "hysteresis": "100" }
  ],
  "durationSeconds": 60,
  "cooldownSeconds": 1800,
  "severity": "warning",
  "notificationIntegrationIds": [],
  "enabled": true
}
```

所有数字阈值保持 decimal string；Boolean 只支持 `eq/neq`。`notificationIntegrationIds` 本阶段只保存和校验，不投递 Telegram。

三态语义：

- AND：全 true 为 true；任一 false 为 false；无 false 且有 unknown 为 unknown。
- OR：任一 true 为 true；全 false 为 false；无 true 且有 unknown 为 unknown。
- 缺失、未预热、stale、error、unsupported，以及最后有效更新超过 Monitor `maxStaleSeconds` 的条件都为 unknown；只有 `data_age_seconds` 的 stale 数值仍可执行，但该 Metric 更新本身也必须未过期。
- unknown 不触发告警，也不恢复已触发告警。`TRIGGERED` 状态会原样保持，等待有效数据恢复后再判断恢复条件。
- `ARMED` 状态进入 unknown 时会清空 `conditionSince`；重新取得完整有效数据后重新累计 `durationSeconds`，unknown 时间不会计入持续满足时长。
- `durationSeconds`、`cooldownSeconds` 作用于整个组；hysteresis 分别作用于各 condition 的恢复边界。
- 修改 Rule 会清理对应条件缓存；删除 Rule 或 Monitor 也会清理缓存。修改条件、combinator、duration 或启停状态会重置组运行状态；状态在 SQLite 持久化。

Metric 分为 `gauge` 与 `event`。省略 `kind` 的旧 Metric 按 gauge 处理；event 必须携带稳定 `eventId`，链上格式为 `chainId:txHash:logIndex`。eventId 在 SQLite 去重，重放不会再次触发。event 只在到达时参与规则计算，可与当前未过期 gauge 组合；后续 gauge 更新不会重放旧 event。event 条件不允许非零 `durationSeconds`。

Rule 创建和更新会按 Catalog 校验 Monitor 类型、marketType/network/version、operator、window 和 labels。稳定错误包括 `RULE_METRIC_UNSUPPORTED`、`RULE_LABEL_INVALID` 与 `EVENT_RULE_DURATION_UNSUPPORTED`。

## 7. 统一 Snapshot

```http
GET /api/v1/monitors/:id/snapshot
```

```ts
type SnapshotStatus = "warming_up" | "ok" | "empty" | "partial" | "stale" | "error" | "unsupported";
type MonitorSnapshot = {
  monitorId: string;
  monitorType: string;
  status: SnapshotStatus;
  observedAt: string | null;
  dataAgeSeconds: number | null;
  maxStaleSeconds: number;
  capability: { available: boolean; reason: string | null };
  summary: Record<string, unknown>;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
};
```

- market：`data.metrics` 为真实最新 Metric。
- Aave Account：`data.networkScans`、`data.positions` 与钱包信息复用现有结构化仓位数据。无借款时 `healthFactor:null`、`healthFactorInfinite:true`，底层 `health_factor` Metric 为 `unsupported`，不会因无限值误告警。
- Aave Pool：`data.discovery` 返回扫描块高，`data.recentEvents` 返回最近的去重事件；token/USD 数量分别可空，`summary.eventCount` 按 eventId 计数。
- Uniswap：`data.positions`、发现进度、链/版本选择为真实当前数据；多版本可返回 `partial`。
- planned 类型返回 `unsupported` 与 `capability.available=false`，不生成伪造协议字段。
- 链上整数、tokenId、blockNumber、金额与 liquidity 保持字符串。

旧接口保留：

```http
GET /api/v1/monitors/:id/positions
GET /api/v1/monitors/:id/uniswap-position
GET /api/v1/monitors/:id/uniswap-positions
GET /api/v1/monitors/:id/metrics
```

## 8. 错误与 204

统一错误格式：

```json
{
  "error": {
    "code": "STABLE_CODE",
    "message": "Human-readable message",
    "fields": { "field": "detail" }
  }
}
```

稳定码包括：`RPC_ROUTING_CONFIG_INVALID`、`RPC_CHAIN_UNSUPPORTED`、`RPC_CHAIN_ID_MISMATCH`、`RPC_PARTIAL_FAILURE`、`MONITOR_TYPE_NOT_READY`、`PROTOCOL_NOT_READY`、`RULE_CONDITION_INVALID`、`METRIC_NOT_AVAILABLE`、`RESOURCE_CATALOG_NOT_READY`、`RESOURCE_NOT_FOUND`、`INDEXER_WARMING_UP`、`INDEXER_PARTIAL_FAILURE`、`VALUATION_UNAVAILABLE`、`RULE_METRIC_UNSUPPORTED`、`RULE_LABEL_INVALID`、`EVENT_RULE_DURATION_UNSUPPORTED`。

前端处理 `204` 时不要调用 `response.json()`：

```ts
if (response.status === 204) return null;
const body = await response.json();
```

## 9. 2C 与第三阶段待实现（当前不可视为 ready）

- Ethereum Uniswap V3/V4 读取器。
- Uniswap Pool 指标。
- LP USD 估值与完整手续费计算。
- Telegram 实际投递。
- 新告警提醒去重与恢复通知。
