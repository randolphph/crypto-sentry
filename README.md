# CryptoSentry

CryptoSentry 是一个单进程、API 驱动的个人加密资产监控服务。它部署在独立服务器上，即使资产看板关闭，也会持续采集数据、执行规则并保存告警。

首期目标包括：

- Binance 现货与 U 本位永续价格监控
- 绝对价格、滚动涨跌幅、持续时间、冷却时间和 hysteresis 规则
- Aave V3 借贷仓位监控
- Uniswap V3/V4 与 PancakeSwap V3 LP 监控
- Telegram 告警，以及可扩展的通知适配器接口
- 提供给资产看板使用的状态和历史告警 API

当前仓库已经完成核心 API、SQLite 持久化、敏感配置加密、Metric 处理管线、持久化规则执行、告警落库和规则引擎健康诊断。Binance 现货与 U 本位永续已支持 REST/WebSocket 连通测试、市场发现、本地缓存、实时价格、滚动涨跌幅和数据过期检测；Aave V3 已支持按钱包地址自动扫描多链仓位，LP 协议读取和 Telegram 尚未接入。详细进度见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

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
- pnpm 10.15.1
- 编译 `better-sqlite3` 所需的本机构建工具

初始化：

```bash
cp .env.example .env
openssl rand -base64 32
```

编辑 `.env`，设置一个至少 32 个字符的 `API_TOKEN`，并把上一步结果写入 `MASTER_ENCRYPTION_KEY`。随后执行：

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

服务默认只监听 `127.0.0.1:3000`：

- 健康检查：`GET /health`
- Swagger UI：`GET /docs/`
- OpenAPI JSON：`GET /docs/json`
- 业务 API：`/api/v1/*`

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
```

当前可以通过 API 创建、查询、修改和删除配置。尚未接入的外部适配器操作会返回明确的 `ADAPTER_NOT_READY`，不会伪造成功结果。

Binance `market_data` 集成还提供：

```text
POST /api/v1/integrations/:id/test          # 测试现货和 U 本位 REST/WebSocket 连通性
POST /api/v1/integrations/:id/sync-markets  # 同步可交易现货和永续市场
GET  /api/v1/integrations/:id/markets       # 查询本地市场缓存
```

同步只保留状态为 `TRADING` 的现货和 `PERPETUAL` 合约，并把 USDT、USDC、FDUSD 等美元稳定币报价统一映射为 canonical `BASE/USD`，同时保留 Binance 原始交易对代码。只有现货和永续两侧都拉取成功时才会事务替换缓存。

启用 `market` Monitor 后，服务会按集成共享连接并动态订阅行情：现货使用 `<symbol>@miniTicker` 的最新成交价，U 本位永续使用 `<symbol>@markPrice@1s` 的标记价格。连接器负责协议级 ping/pong、指数退避重连、自动恢复订阅和 23.5 小时主动换线。配置中的旧 `wss://fstream.binance.com` 地址会自动迁移到 Binance 当前的 `/market` 入口。

行情处理层每 5 秒为每个启用市场写入一个 SQLite 价格采样，并滚动清理 30 分钟以前的数据。服务启动时先恢复本地窗口；窗口不足则使用 Binance 1 分钟 K 线补齐，现货读取 `/api/v3/klines`，永续标记价格读取 `/fapi/v1/markPriceKlines`。预热未完成时，`price_change_percent` 为 `warming_up`，不会进入规则引擎。

每个市场目前输出三个 Metric：

- `price`：WebSocket 最新成交价或标记价格
- `price_change_percent`：按规则的 `windowSeconds` 独立计算；默认同时提供 5 分钟窗口
- `data_age_seconds`：最后一条实时行情距当前时间的秒数；超过 Monitor 的 `maxStaleSeconds` 后状态变为 `stale`

滚动涨跌幅的参考价是“不晚于当前时间减窗口长度的最近样本”。不同窗口通过 Metric 的 `labels.windowSeconds` 区分，只会匹配相同窗口的规则。过期的涨跌幅不会触发规则；`data_age_seconds` 虽处于 `stale` 状态，其年龄数值仍可用于配置断流告警。

自动化验收覆盖 WebSocket 意外断开后的指数退避、重新订阅、旧连接消息隔离，以及断流期间 `stale`、新行情到达后恢复 `ok` 的完整状态链路。容量用例验证 100 个现货市场共用单条连接，并能在一个 5 秒周期内完成采样与派生指标处理。

`evm_rpc/custom` 集成的 `POST /api/v1/integrations/:id/test` 会通过 viem 调用 `eth_chainId` 与 `eth_blockNumber`：配置网络不一致时返回 `RPC_CHAIN_ID_MISMATCH`，传输错误不会把带密钥的 RPC URL 暴露给 API。RPC 配置还可设置 `timeoutMilliseconds`（默认 5000）和 `multicallBatchSizeBytes`（默认 8192）。通用轮询器采用“本轮完成后再安排下一轮”的方式避免同一任务重叠，并隔离不同监控任务的失败；移除或关闭任务时会发送 abort，并等待仍在清理的任务结束。

## Aave V3 地址监控

先为需要扫描的网络各创建一个启用的 `evm_rpc/custom` 集成。当前自动识别 Ethereum（1）、Arbitrum（42161）、Base（8453）和 BNB Chain（56）；同一网络配置多个 RPC 时会按顺序故障转移。Pool、Oracle、Data Provider 和资产地址均来自 Aave 官方 Address Book，无需手工填写合约地址。

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

响应包含 `status`、数据时间与年龄、扫描成功/失败网络数，以及按网络分组的账户风险和逐资产余额。`status` 明确区分 `warming_up`、`ok`、`empty`、`partial`、`stale` 和 `error`；没有仓位的网络只出现在 `networkScans`，不会生成空仓位卡片。底层原始数据仍可通过 `GET /api/v1/monitors/:id/metrics` 读取：

- 账户级：`total_collateral_base`、`total_debt_base`、`available_borrows_base`、`ltv_percent`、`liquidation_threshold_percent`、`health_factor`
- 资产级：`supplied_amount`、`stable_debt_amount`、`variable_debt_amount`、`total_debt_amount`、`supplied_base`、`debt_base`、`usage_as_collateral`
- 扫描级：`rpc_status`、`position_chain_count`、`position_asset_count`

每个链和资产通过 Metric labels 区分。读取完全只读，不需要私钥、助记词或钱包签名；单链读取失败会进入 `error`，不会把失败伪装成零仓位。

每轮 Aave 扫描先取得最新区块号，账户汇总、Oracle 和所有资产读取均固定在同一块高，结构化仓位中的 `blockNumber` 可供网页展示和排障。Multicall 按配置的 calldata 字节数自动分批。单个 RPC 最多尝试两次并进行指数退避，同链多个 RPC 会自动故障转移；连续三轮失败后打开 60 秒熔断器。独立 freshness watchdog 会在最后成功数据超过 `maxStaleSeconds` 时产生 `data_age_seconds` stale 指标。

真实 RPC 冒烟测试默认不会加入普通测试套件。部署环境配置好测试参数后可显式运行：

```bash
AAVE_SMOKE_RPC_URL='https://...' \
AAVE_SMOKE_CHAIN_ID=1 \
AAVE_SMOKE_WALLET_ADDRESS='0x...' \
pnpm test:aave:live
```

命令输出固定块高的结构化仓位，但错误输出不会打印 RPC URL。

规则支持可选的 `labels` 精确匹配。例如 `{"chainId":"1"}` 只消费 Ethereum 指标，不会被其他网络的同名 `health_factor` 更新或恢复。完成首次 Aave 扫描后，可一键为每个已发现网络创建默认健康因子规则：

```text
POST /api/v1/monitors/:id/aave-risk-rules
Content-Type: application/json

{}
```

默认创建 `health_factor <= 1.2` 的 warning（持续 60 秒）和 `health_factor <= 1.05` 的 critical（立即触发），冷却时间为 30 分钟。请求体可覆盖 `warningThreshold`、`criticalThreshold`、两级持续时间、`cooldownSeconds` 和 `notificationIntegrationIds`。接口是幂等的：同一 Monitor 和网络重复调用不会重复创建默认规则。

## 质量检查

提交或发布前运行：

```bash
pnpm check
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
