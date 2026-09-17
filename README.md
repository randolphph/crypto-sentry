# CryptoSentry

CryptoSentry 是一个单进程、API 驱动的个人加密资产监控服务。它部署在独立服务器上，即使资产看板关闭，也会持续采集数据、执行规则并保存告警。

首期目标包括：

- Binance 现货与 U 本位永续价格监控
- 绝对价格、滚动涨跌幅、持续时间、冷却时间和 hysteresis 规则
- Aave V3 借贷仓位监控
- Uniswap V3/V4 与 PancakeSwap V3 LP 监控
- Telegram 告警，以及可扩展的通知适配器接口
- 提供给资产看板使用的状态和历史告警 API

当前仓库已经完成核心 API、SQLite 持久化、敏感配置加密、Metric 处理管线、持久化规则执行、告警落库和规则引擎健康诊断。Binance 现货与 U 本位永续已支持实时行情、成交量、资金费率和 Open Interest；Aave V3 已支持 Ethereum Account、官方 Reserve 目录和 Pool 事件监控，并保留旧多链地址 Monitor；Uniswap V3/V4 已支持 Ethereum 与 Robinhood Chain 的 Position、Wallet、按用户指定 Pool ID 的直接监听和持久化窗口成交量。服务不再自动扫描全链 Pool 目录。Telegram 尚未接入；V4 单池 TVL/完整手续费、非稳定币 USD 回退和 V3 完整 fee-growth 模拟仍按不可用返回。详细进度见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

Dashboard 下一版使用的多链 RPC、Monitor 类型、Rule Group、Readiness 与统一 Snapshot 契约见 [docs/dashboard-api.md](./docs/dashboard-api.md)。

## 技术栈

- Node.js 24 LTS、TypeScript、Fastify
- Zod、OpenAPI 3、Swagger UI
- SQLite WAL、Drizzle ORM、better-sqlite3
- decimal.js 高精度数值运算
- viem EVM JSON-RPC 与合约读取底座、Aave 官方 Address Book
- Vitest、ESLint
- systemd 与 Caddy 生产部署

## 项目结构

```text
src/
├── api/             # Bearer Token、错误处理和 REST API
├── core/            # Metric、规则、状态和配置事件
├── db/              # Schema、迁移与仓储
├── security/        # AES-256-GCM 配置加密
└── app.ts           # 应用装配和进程生命周期
deploy/              # systemd 与 Caddy 配置
scripts/             # 安装、发布、回滚和备份脚本
tests/               # 单元与 API 测试
```

## 本地开发

要求：

- Node.js 24 LTS
- npm 11 或更高版本
- 编译 `better-sqlite3` 所需的本机构建工具

初始化：

```bash
cp .env.example .env
openssl rand -base64 32
```

编辑 `.env`，设置一个至少 32 个字符的 `API_TOKEN`，并把上一步结果写入 `MASTER_ENCRYPTION_KEY`。随后执行：

```bash
npm install
npm run db:migrate
npm run dev
```

按照 `.env.example` 启动时，服务只监听 `127.0.0.1:3001`：

- 健康检查：`GET /health`
- Swagger UI：`GET /docs/`
- OpenAPI JSON：`GET /docs/json`
- 业务 API：`/api/v1/*`

EVM RPC 请求会经过统一的脱敏观测层：失败请求和耗时超过 2 秒的请求按 warn 记录；需要排查请求数量或慢请求时，把 `LOG_LEVEL=debug` 写入 `.env`，日志会额外记录每次 JSON-RPC 的方法、耗时、HTTP 状态和成功结果。安全的传输审计（时间、调度任务 ID、方法、耗时、状态）还会批量保留到 SQLite 7 天，可用 `GET /api/v1/status/rpc-requests?limit=100&taskId=...` 查询；不会记录 RPC URL、认证 Header、Token、调用参数或返回内容。

前端 API 请求和 Integration/Monitor/Rule 配置变更也会写入结构化日志，包含请求路径、脱敏后的参数、响应状态、耗时和配置事件。日志字段与查看方式见 [`docs/observability.md`](docs/observability.md)。

除 `/health` 和 API 文档外，业务接口需要认证：

```http
Authorization: Bearer <API_TOKEN>
```

## 已建立的 API

```text
/api/v1/integrations
/api/v1/monitors
/api/v1/rules
/api/v1/alerts
/api/v1/status/summary
/api/v1/status/monitors
/api/v1/status/rpc-requests
```

当前可以通过 API 创建、查询、修改和删除配置。尚未接入的外部适配器操作会返回明确的 `ADAPTER_NOT_READY`，不会伪造成功结果。

Dashboard 可先读取数据源目录和当前就绪状态，避免在前端硬编码支持网络、服务商和公共端点：

```text
GET  /api/v1/integrations/catalog            # 服务商、网络和安全默认值
GET  /api/v1/integrations/readiness          # Aave/Binance/Uniswap 是否可创建有效 Monitor
GET  /api/v1/integrations/:id/aave/reserves # Ethereum Aave V3 官方 Reserve 目录
GET  /api/v1/integrations/:id/uniswap/pools # 仅查询既有的 legacy Pool 缓存；不会触发索引
GET  /api/v1/integrations/:id/uniswap/wallet-positions # 创建 Monitor 前发现 LP
POST /api/v1/integrations/binance/default    # 幂等创建无需密钥的 Binance 公共行情源
```

`evm_rpc` 的 `provider` 支持 `alchemy`、`infura`、`quicknode` 和 `custom`。一个 Integration 可通过 fixed、URL 模板、Header 或 Query 路由多个 chainId；RPC URL 与全部静态 Header 值在查询响应中保持脱敏。旧单链配置继续兼容。

Binance `market_data` 集成还提供：

```text
POST /api/v1/integrations/:id/test          # 测试现货和 U 本位 REST/WebSocket 连通性
POST /api/v1/integrations/:id/sync-markets  # 同步可交易现货和永续市场
GET  /api/v1/integrations/:id/markets       # 查询本地市场缓存
```

同步只保留状态为 `TRADING` 的现货和 `PERPETUAL` 合约，并把 USDT、USDC、FDUSD 等美元稳定币报价统一映射为 canonical `BASE/USD`，同时保留 Binance 原始交易对代码。只有现货和永续两侧都拉取成功时才会事务替换缓存。

启用 `market` Monitor 后，服务会按集成共享连接并动态订阅行情：现货使用 `<symbol>@miniTicker` 的最新成交价，U 本位永续使用 `<symbol>@markPrice@1s` 的标记价格。连接器负责协议级 ping/pong、指数退避重连、自动恢复订阅和 23.5 小时主动换线。配置中的旧 `wss://fstream.binance.com` 地址会自动迁移到 Binance 当前的 `/market` 入口。

行情处理层每 5 秒为每个启用市场写入一个 SQLite 价格采样，并滚动清理 30 分钟以前的数据。服务启动时先恢复本地窗口；窗口不足则使用 Binance 1 分钟 K 线补齐，现货读取 `/api/v3/klines`，永续标记价格读取 `/fapi/v1/markPriceKlines`。预热未完成时，`price_change_percent` 为 `warming_up`，不会进入规则引擎。

每个市场的基础 Metric 包括：

- `price`：WebSocket 最新成交价或标记价格
- `price_change_percent`：按规则的 `windowSeconds` 独立计算；默认同时提供 5 分钟窗口
- `data_age_seconds`：最后一条实时行情距当前时间的秒数；超过 Monitor 的 `maxStaleSeconds` 后状态变为 `stale`

滚动涨跌幅的参考价是“不晚于当前时间减窗口长度的最近样本”。不同窗口通过 Metric 的 `labels.windowSeconds` 区分，只会匹配相同窗口的规则。过期的涨跌幅不会触发规则；`data_age_seconds` 虽处于 `stale` 状态，其年龄数值仍可用于配置断流告警。

自动化验收覆盖 WebSocket 意外断开后的指数退避、重新订阅、旧连接消息隔离，以及断流期间 `stale`、新行情到达后恢复 `ok` 的完整状态链路。容量用例验证 100 个现货市场共用单条连接，并能在一个 5 秒周期内完成采样与派生指标处理。

`evm_rpc` 集成的 `POST /api/v1/integrations/:id/test` 会逐个测试全部 `chainIds`：先调用 `eth_chainId` 与 `eth_blockNumber`，再检查该网络当前已实现协议的真实合约。Ethereum 分别验证 Aave Account、Reserve Catalog 与事件日志，Readiness 只有在三项真实探测均成功时才开放；Robinhood Chain 检查 Uniswap V3 Factory/NonfungiblePositionManager 和 V4 PoolManager/PositionManager/StateView 字节码。响应使用 `networks[]` 保留每条链的独立结果；测试流程完成返回 HTTP 200，只有全部链成功时顶层 `ok` 才为 true。配置网络不一致使用 `RPC_CHAIN_ID_MISMATCH`，连接或能力失败使用不含敏感 URL 的稳定错误码。RPC 配置还可设置 `timeoutMilliseconds`（默认 5000）和 `multicallBatchSizeBytes`（默认 8192）。通用轮询器采用“本轮完成后再安排下一轮”的方式避免同一任务重叠，并隔离不同监控任务的失败；移除或关闭任务时会发送 abort，并等待仍在清理的任务结束。

Binance market Monitor 还输出 24 小时 base/quote volume；永续合约输出 funding rate、next funding time、open interest 和窗口 OI 变化率。价格、volume、funding 优先复用共享 WebSocket，OI 按 Integration + symbol 合并 REST 轮询并遵循 Monitor interval。价格和 OI 样本持久化到 SQLite，重启后可继续窗口计算；缺失值使用 warming/error 状态和 `unavailable`，不会伪装为数值 0。Catalog 的 `samplingPresets` 与 `ruleMetrics` 是 Dashboard 渲染规则表单的唯一能力来源。

Metric 支持 gauge/event 两种语义。链上 event 必须带 `chainId:txHash:logIndex` 形式的稳定 eventId。Event 先以 processing 状态持久占位，只有全部 consumer 成功后才提交 processed；失败可重试，进程异常遗留的占位会超时回收。规则状态、Alert 和该规则的 Event 幂等记录在同一事务提交，因此后续 consumer 失败后的重试不会重复创建 Alert。event 不会因后续 gauge 更新或 cooldown 到期而被重复消费。

所有窗口条件统一使用 `condition.windowSeconds` 匹配 Metric 的 `labels.windowSeconds`，不再按指标名称设特例；规则 labels 若也填写 windowSeconds，必须与 condition 字段一致。

## Aave V3 地址监控

先为需要扫描的网络各创建一个启用的 `evm_rpc` 集成。当前自动识别 Ethereum（1）、Arbitrum（42161）、Base（8453）和 BNB Chain（56）；同一网络配置多个 RPC 时会按顺序故障转移。Pool、Oracle、Data Provider 和资产地址均来自 Aave 官方 Address Book，无需手工填写合约地址。

创建 Monitor 时只需要钱包地址：

```json
{
  "name": "My Aave V3 account",
  "type": "aave_position",
  "intervalSeconds": 20,
  "maxStaleSeconds": 90,
  "config": {
    "walletAddress": "0x0000000000000000000000000000000000001234"
  }
}
```

服务会自动扫描所有已配置且受支持的网络。没有 Aave 仓位的网络不会产生仓位资产指标；RPC 状态仍会保留，便于区分“没有仓位”和“网络读取失败”。前端优先使用结构化接口：

```text
GET /api/v1/monitors/:id/positions
```

响应包含 `status`、数据时间与年龄、扫描成功/失败网络数，以及按网络分组的账户风险和逐资产余额。`status` 明确区分 `warming_up`、`ok`、`empty`、`partial`、`stale` 和 `error`；没有仓位的网络只出现在 `networkScans`，不会生成空仓位卡片。账户没有债务时，结构化响应使用 `healthFactor: null` 和 `healthFactorInfinite: true` 表达无限健康因子，Dashboard 应显示 `∞` 或“无借款”，而不是展示 Aave 合约的巨大整数哨兵值；有债务时返回实际 `healthFactor` 且 `healthFactorInfinite` 为 `false`。底层原始数据仍可通过 `GET /api/v1/monitors/:id/metrics` 读取：

- 账户级：`total_collateral_base`、`total_debt_base`、`available_borrows_base`、`ltv_percent`、`liquidation_threshold_percent`、`health_factor`
- 资产级：`supplied_amount`、`stable_debt_amount`、`variable_debt_amount`、`total_debt_amount`、`supplied_base`、`debt_base`、`usage_as_collateral`
- 扫描级：`rpc_status`、`position_chain_count`、`position_asset_count`

每个链和资产通过 Metric labels 区分。读取完全只读，不需要私钥、助记词或钱包签名；单链读取失败会进入 `error`，不会把失败伪装成零仓位。

每轮 Aave 扫描先取得最新区块号，账户汇总、Oracle 和所有资产读取均固定在同一块高，结构化仓位中的 `blockNumber` 可供网页展示和排障。Multicall 按配置的 calldata 字节数自动分批。单个 RPC 最多尝试两次并进行指数退避，同链多个 RPC 会自动故障转移；连续三轮失败后打开 60 秒熔断器。独立 freshness watchdog 会在最后成功数据超过 `maxStaleSeconds` 时产生 `data_age_seconds` stale 指标。

新 Dashboard 使用 `aave_account` 并显式指定 `rpcIntegrationId` 与 `chainId: 1`。Account 还提供 `health_factor_infinite`、抵押/债务窗口变化指标和 supply/withdraw/borrow/repay/liquidation 事件。窗口样本持久化到 SQLite，重启后继续计算；无借款不会把 Aave 的最大整数哨兵作为可执行健康因子。

`aave_pool` 使用同一个 Ethereum RPC，可选 `reserveAssetAddresses`；空数组监控全部官方 Reserve。事件扫描按 Integration 合并，采用确认区块、RPC 范围分片、持久游标和重扫窗口，eventId 使用 `chainId:txHash:logIndex` 并持久去重。每个事件保留 token 原始精度格式化数量；Aave Oracle 失败时 USD 为 `null`、valuationStatus 为 unavailable，不返回 0。统一快照通过 `GET /api/v1/monitors/:id/snapshot` 返回最近事件和扫描进度，其中 caughtUp 比较 `scannedThroughBlock >= confirmedTipBlock`；`chainTipBlock` 是未扣确认数的链头。事件 observedAt 使用各自 blockNumber 的时间戳，并缓存同区块查询。

真实 RPC 冒烟测试默认不会加入普通测试套件。部署环境配置好测试参数后可显式运行：

```bash
AAVE_SMOKE_RPC_URL='https://...' \
AAVE_SMOKE_CHAIN_ID=1 \
AAVE_SMOKE_WALLET_ADDRESS='0x...' \
npm run test:aave:live
```

命令输出固定块高的结构化仓位，但错误输出不会打印 RPC URL。

规则支持可选的 `labels` 精确匹配。例如 `{"chainId":"1"}` 只消费 Ethereum 指标，不会被其他网络的同名 `health_factor` 更新或恢复。完成首次 Aave 扫描后，可一键为每个已发现网络创建默认健康因子规则：

```text
POST /api/v1/monitors/:id/aave-risk-rules
Content-Type: application/json

{}
```

默认创建 `health_factor <= 1.2` 的 warning（持续 60 秒）和 `health_factor <= 1.05` 的 critical（立即触发），冷却时间为 30 分钟。请求体可覆盖 `warningThreshold`、`criticalThreshold`、两级持续时间、`cooldownSeconds` 和 `notificationIntegrationIds`。接口是幂等的：同一 Monitor 和网络重复调用不会重复创建默认规则。

## Ethereum / Robinhood Chain Uniswap V3/V4 LP 监控

支持 Ethereum（Chain ID `1`）和 Robinhood Chain（Chain ID `4663`）上的 Uniswap V3/V4 NFT 仓位。后端内置官方 Factory/PoolManager/PositionManager/StateView 与部署块，不接受前端传入协议合约地址。服务不会自动扫描全链 Pool 创建事件；`/uniswap/pools` 只读取历史遗留缓存，不能作为创建 Pool Monitor 的前置条件。V4 钱包发现使用可恢复的 Transfer 索引，API 可以先返回 warming_up，再在后续轮询中返回已发现仓位。

Position Snapshot 的分组键为 `chainId + version + tokenId`。后端计算边界距离、token0/token1 数量、V3 已记账手续费和关闭状态；Wallet 汇总 position/in-range/out-of-range/failed 数量。包含可信稳定币的池可用链上价格计算 USD，否则 `positionValueUsd`/`tvlUsd` 为 `null` 且 valuationStatus 为 unavailable，绝不显示成 0。

`uniswap_pool` 由 Dashboard 直接提交用户确认的 V3 `poolAddress` 或 V4 `poolId` 与 chainId；创建前会验证 RPC 和对应协议能力，但不会进行全链目录扫描。V3 会在首次扫描时只读取这一个 Pool 的 token/fee 元数据并缓存；V4 poolId 是不可逆的 PoolKey 哈希，因此仅凭 poolId 能可靠提供 tick、liquidity、费用和过滤后的事件，token 数量、价格、TVL 和 USD 估值保持 `null`/unavailable。Pool Monitor 输出 tick、双向价格（可用时）、活跃流动性、V3 token TVL、可靠时的 USD TVL，以及 swap/mint/burn 事件；V3 另提供 fee_collection。启用对应窗口 Rule 后，Swap 样本按 eventId 去重并持久化，输出 `volume_token0`、`volume_token1`、可靠时的 `volume_usd`，以及当前窗口相对前一等长窗口的 `volume_change_percent`。不同窗口通过 labels.windowSeconds 与 Snapshot 的 volumes 数组隔离。eventId 按 `chainId:txHash:logIndex` 去重。

先创建 RPC 集成：

```http
POST /api/v1/integrations
Content-Type: application/json

{
  "name": "Robinhood Chain RPC",
  "type": "evm_rpc",
  "provider": "alchemy",
  "config": {
    "chainId": 4663,
    "rpcUrl": "https://your-robinhood-chain-rpc.example"
  }
}
```

`provider` 也可以使用 `quicknode` 或 `custom`。保存后调用 `POST /api/v1/integrations/:id/test`；成功响应应包含：

```json
{
  "ok": true,
  "networks": [{
    "connectivity": { "rpc": "ok", "uniswapV3": "ok", "uniswapV4": "ok" },
    "chainId": 4663,
    "blockNumber": "...",
    "ok": true,
    "error": null
  }]
}
```

随后直接使用钱包地址创建 Monitor；`version` 可取 `v3` 或 `v4`：

```http
POST /api/v1/monitors
Content-Type: application/json

{
  "name": "Robinhood Uniswap V4 wallet",
  "type": "lp_position",
  "intervalSeconds": 20,
  "maxStaleSeconds": 90,
  "config": {
    "protocol": "uniswap",
    "version": "v4",
    "chainId": 4663,
    "walletAddress": "0x0000000000000000000000000000000000001234",
    "rpcIntegrationId": "int_..."
  }
}
```

创建后轮询结构化接口：

```text
GET /api/v1/monitors/:id/uniswap-positions
```

`status` 为 `warming_up`、`ok`、`empty`、`partial`、`stale` 或 `error`。响应的 `positions` 数组包含钱包中发现的全部目标版本 LP；公共字段包括 NFT owner、币对地址/符号/decimals、费率、上下界 tick、当前 tick、流动性和是否处于价格区间。V3 额外返回池地址和 PositionManager 已记账的 `tokensOwed0/1`；V4 额外返回 `poolId`、PoolManager、StateView、实际 LP fee、protocol fee、tick spacing 和 hooks 地址。所有单轮仓位读取固定在同一个块高。

V3 使用 PositionManager 的 `balanceOf` 与 `tokenOfOwnerByIndex` 自动枚举。V4 PositionManager 不支持 Enumerable，因此后端从官方部署块开始按钱包过滤 `Transfer` 日志，分块同步并把每个成功区块范围的检查点和当前 token 所有权写入 SQLite；后续轮询只扫描增量区块，再用 `ownerOf` 对账。首次 V4 历史同步默认每轮最多扫描一个 50,000 块区间；节点拒绝日志范围或超时时自动缩小区间，并记住较小区间，避免单个 20 秒 Monitor 反复触发大范围 `eth_getLogs`。`discovery.caughtUp` 为 `false` 时状态保持 `warming_up`，并返回 `scannedThroughBlock` 和 `chainTipBlock` 供 Dashboard 展示同步进度。RPC 报错不会推进检查点。

同一 RPC Integration、链、版本和钱包的 Position/Wallet 读取会在短暂缓存窗口内合并；同一 Pool 的多个 Monitor 则按其中最短 interval 合并一次链上读取，再分别写入各自的 Metric/Rule 流。新增同资源 Monitor 不会按 Monitor 数量线性增加 RPC 请求。

新 `uniswap_position` 创建时，以及修改 RPC/chain/version/tokenId 时，会先要求对应能力测试 ready，再实际读取并验证 tokenId；不存在返回 `POSITION_NOT_FOUND`，RPC 临时故障返回 `RPC_CONNECTION_FAILED`，验证失败不写配置。钱包发现接口的 `q` 支持 tokenId、Pool 标识、token symbol/address 和正反向币对。

旧的单 `tokenId` 配置仍可用于 V3/V4，并继续通过 `GET /api/v1/monitors/:id/uniswap-position` 读取；钱包配置必须使用集合接口。底层指标可从 `GET /api/v1/monitors/:id/metrics` 获取。V3 `tokensOwed0/1` 仅是 PositionManager 已记账待领取金额，不代表完整 fee-growth 模拟；V4 当前不返回待领取手续费，避免伪装成准确数值。

有实际 LP tokenId 时可显式运行真实读取测试：

```bash
UNISWAP_SMOKE_RPC_URL='https://...' \
UNISWAP_SMOKE_VERSION='v4' \
UNISWAP_SMOKE_TOKEN_ID='42' \
npm run test:uniswap:live
```

## 质量检查

提交或发布前运行：

```bash
npm run check
```

该命令依次执行 ESLint、Shell 语法检查、TypeScript 类型检查、Vitest 和生产构建。普通测试不访问 Binance、RPC 或 Telegram；真实外部接口测试将在对应适配器阶段单独启用。

## 生产部署

生产目标为 Ubuntu Server 24.04 LTS。服务由 systemd 守护，只监听 `127.0.0.1:3000`，Caddy 对外提供 HTTPS。

仓库包含：

- `scripts/install-server.sh`：首次安装
- `scripts/deploy.sh <tag>`：按 Git 标签发布并进行健康检查
- `scripts/rollback.sh <tag>`：切换至已安装的历史版本
- `scripts/backup.sh`：使用 SQLite backup API 创建一致性备份

生产环境只保留三个启动变量：

```dotenv
DATABASE_PATH=/opt/cryptosentry/data/monitor.sqlite
API_TOKEN=<long-random-token>
MASTER_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

真实 Token、RPC Key、数据库、日志、备份和本地技术方案均不会提交到 Git。

## 安全边界

- 不接收或保存钱包私钥、助记词和签名权限
- 敏感集成配置使用 AES-256-GCM 加密后写入 SQLite
- API 查询敏感字段时返回 `********`
- Authorization 请求头经过日志脱敏
- 仅支持单用户固定 Bearer Token，不实现多用户或 RBAC

## License

当前仓库未声明开源许可证，保留所有权利。
