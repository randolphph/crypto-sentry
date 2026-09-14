# CryptoSentry

CryptoSentry 是一个单进程、API 驱动的个人加密资产监控服务。它部署在独立服务器上，即使资产看板关闭，也会持续采集数据、执行规则并保存告警。

首期目标包括：

- Binance 现货与 U 本位永续价格监控
- 绝对价格、滚动涨跌幅、持续时间、冷却时间和 hysteresis 规则
- Aave V3 借贷仓位监控
- Uniswap V3/V4 与 PancakeSwap V3 LP 监控
- Telegram 告警，以及可扩展的通知适配器接口
- 提供给资产看板使用的状态和历史告警 API

当前仓库处于阶段一开发。已经具备可运行的 API、SQLite 持久化、敏感配置加密、Metric 处理管线、持久化规则执行、告警落库、规则引擎健康诊断和部署脚本骨架；Binance、链上协议与 Telegram 的真实连接器尚未接入。详细进度见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 技术栈

- Node.js 24 LTS、TypeScript、Fastify
- Zod、OpenAPI 3、Swagger UI
- SQLite WAL、Drizzle ORM、better-sqlite3
- decimal.js 高精度数值运算
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
