# CryptoSentry 开发计划

## 架构原则

1. 单一 Node.js 进程承载 API、调度、适配器、规则与通知，模块故障隔离。
2. API 是唯一业务配置入口；写入数据库后发布配置事件，实现热加载。
3. 适配器只输出统一 `Metric`，规则引擎不识别 Binance、Aave 或 Uniswap。
4. 金额与阈值全程以字符串和 `decimal.js` 处理；SQLite 开启 WAL 与外键。
5. 外部失败转化为连接器/指标状态，不允许未捕获异常终止主进程。
6. 先以纯函数和端口接口固定核心语义，再连接真实网络服务。

## 分阶段交付

### 1. 基础服务（当前）

- [x] TypeScript/Fastify/Vitest 工程骨架与环境配置校验
- [x] SQLite schema、事务迁移、WAL/外键配置
- [x] AES-256-GCM 配置加密和查询脱敏
- [x] Bearer Token、统一错误响应、健康检查、OpenAPI
- [x] integrations、monitors、rules、alerts、status 的仓储与 API 骨架
- [x] Metric 类型、配置事件总线、规则状态机基础实现
- [x] Metric 运行时校验、按监控串行处理、乱序保护、最新快照和健康状态聚合
- [x] 规则匹配、状态持久化、冷却去重、重复提醒、恢复和告警事务闭环
- [x] 规则引擎运行健康状态、故障恢复和 OpenAPI 请求模型
- [ ] 完成阶段一所有 API 行为测试与热加载编排
- [x] systemd、Caddy、安装/发布/回滚/备份脚本初稿与 Shell 语法检查
- [ ] 在干净 Ubuntu 24.04 环境演练安装、发布、回滚与备份恢复

### 2. Binance 行情

- [x] 现货与 U 本位永续 REST 连通测试
- [x] 市场同步、事务缓存与 canonical symbol 映射
- [x] 共享现货/永续 WebSocket、动态订阅、ping/pong、重连与 23.5 小时换线
- [x] 5 秒采样、30 分钟窗口、SQLite 重启恢复与 REST K 线预热
- [x] 价格、按规则窗口计算的涨跌幅与数据过期指标
- [x] 断线过期/恢复链路和 100 市场共享连接、指标周期容量测试

### 3. 链上协议

- [x] 通用 EVM RPC 集成、链 ID 校验、非重叠轮询调度与任务故障隔离
- [x] Aave V3 地址式多链仓位适配器（Ethereum、Arbitrum、Base、BNB Chain）
- [x] Aave V3 结构化仓位快照 API、空仓位/部分失败/过期状态建模
- [x] Metric label 规则过滤与按网络幂等创建的 Aave 健康因子预设规则
- [x] Aave 固定区块读取、Multicall 分批、重试/故障转移/熔断和 stale watchdog
- [x] 使用公开 Ethereum RPC 运行显式 Aave 全仓位读取冒烟测试
- [x] 数据源目录、就绪状态、Alchemy/Infura/QuickNode 标识和 Binance 默认配置 API
- [ ] 使用部署用 RPC 与目标钱包完成服务器环境验收
- [x] Robinhood Chain Uniswap V3 NFT 仓位适配器、RPC 合约探针与结构化快照 API
- [ ] Uniswap V3 其他网络与 PancakeSwap V3 LP 适配器
- [ ] Uniswap V4 PositionManager/StateView 适配器
- [ ] tick、价格方向、decimals、hooks 与 unsupported 费用测试

### 4. 通知与看板接入

- [ ] Telegram 测试、发送、指数退避重试和投递记录
- [ ] 告警去重、恢复通知、冷却与持久化状态完整闭环
- [ ] 看板轮询示例与关闭期间告警游标
- [ ] Bark、飞书等通知端口的扩展示例

### 5. 部署与验收

- [ ] Ubuntu 24.04 安装、标签发布、失败自动回滚
- [ ] SQLite 一致性备份与干净环境恢复
- [ ] 首尔节点外部服务连通性验证
- [ ] 72 小时稳定性、内存与 P95 规则延迟验收

## 每个阶段的完成门槛

每个阶段必须同时满足：类型检查通过、Lint 通过、单元测试通过、生产构建通过；涉及外部系统时还需显式启用的真实集成测试通过。未实现能力返回明确错误或 `unsupported`，不得伪造成功或数值 0。

## 待部署前确认

- 资产看板是否有后端代理层；若为纯静态站点，需要增加登录代理，不能暴露长期 Token。
- 首批实际 RPC 服务商、Aave 钱包地址和 LP tokenId；Aave 合约地址由官方 Address Book 管理。
- 告警详情链接的资产看板基础 URL，以及是否发送恢复通知。
