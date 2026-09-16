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
- [x] 24h base/quote volume、永续 funding rate/next funding time WebSocket 指标
- [x] Open Interest 合并轮询、窗口变化、SQLite 重启恢复与错误状态
- [x] gauge/event Metric、持久化 eventId 去重与事件规则一次性消费
- [x] Event processing/processed inbox、失败重试、超时回收和 Rule/Alert 事务幂等
- [x] sampling presets、Market ruleMetrics Catalog 与 Rule 能力校验

### 3. 链上协议

- [x] 通用 EVM RPC 集成、链 ID 校验、非重叠轮询调度与任务故障隔离
- [x] Aave V3 地址式多链仓位适配器（Ethereum、Arbitrum、Base、BNB Chain）
- [x] Aave V3 结构化仓位快照 API、空仓位/部分失败/过期状态建模
- [x] Metric label 规则过滤与按网络幂等创建的 Aave 健康因子预设规则
- [x] Aave 固定区块读取、Multicall 分批、重试/故障转移/熔断和 stale watchdog
- [x] 使用公开 Ethereum RPC 运行显式 Aave 全仓位读取冒烟测试
- [x] 数据源目录、就绪状态、Alchemy/Infura/QuickNode 标识和 Binance 默认配置 API
- [x] 单个 EVM RPC Integration 多 chainId 与 fixed/URL/Header/Query 路由
- [x] 逐链真实能力测试、持久化能力状态和细粒度 Readiness
- [x] Aave Account/Reserve/Event Logs 与 Uniswap V3/V4 完全隔离的分项探测
- [x] 显式 Monitor 类型、新 Aave/Uniswap 配置与 legacy 类型兼容
- [x] AND/OR Rule Group、条件表迁移、三态执行与状态持久化
- [x] RPC PATCH 路由/Header 替换语义与密文掩码保留
- [x] Monitor 创建/更新共用 capability 与 RPC chainId 校验
- [x] Rule condition 按 Monitor `maxStaleSeconds` 失效，unknown 中断 ARMED 持续时间并清理生命周期缓存
- [x] market/Aave/Uniswap 统一结构化 Snapshot API
- [x] Ethereum Aave V3 Reserve 目录与 Account/Reserve/EventLogs 分项能力测试
- [x] Aave Account 无借款语义、抵押/债务窗口变化与 SQLite 样本恢复
- [x] Aave Account/Pool 五类事件、确认区块、分片扫描、重扫窗口、游标与 eventId 去重
- [x] Aave confirmed tip 进度语义与逐事件实际区块时间戳
- [x] Aave Pool Monitor、资源校验、结构化 Snapshot 与 Account/Pool 规则指标目录
- [ ] 使用部署用 RPC 与目标钱包完成服务器环境验收
- [x] Robinhood Chain Uniswap V3 钱包枚举、固定块仓位读取与结构化快照 API
- [x] Robinhood Chain Uniswap V4 PositionManager/PoolManager/StateView 仓位适配器
- [x] V4 钱包 Transfer 日志分块索引、SQLite 检查点与 ownerOf 对账
- [x] Ethereum/Robinhood Uniswap V3/V4 官方部署、逐链能力测试和 Readiness
- [x] V3/V4 Pool 后台分片索引、重扫游标、token metadata 缓存、搜索与分页 API
- [x] Pool `eth_getLogs` 自适应二分、成功子区间即时游标与持久错误状态
- [x] Position token 数量、边界距离、V3 fees owed、稳定币链上估值与跨链 tokenId 隔离
- [x] Uniswap Pool Monitor 基础 gauge、事件去重、统一 Snapshot 和资源存在性校验
- [x] Uniswap Pool 窗口 token/USD volume、相邻窗口 change 与持久样本
- [x] Position tokenId 创建/PATCH 实读校验与 Wallet 多字段资源搜索
- [ ] V4 可可靠归属的单池 TVL/完整手续费，以及非稳定币 Binance 估值回退
- [ ] Uniswap V3 其他网络与 PancakeSwap V3 LP 适配器
- [ ] LP 当前代币数量、价格方向和完整未领取手续费计算

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
- 首批实际 RPC 服务商、Aave/Uniswap 钱包地址；Aave 与 Uniswap 合约地址均由后端官方部署目录管理。
- 告警详情链接的资产看板基础 URL，以及是否发送恢复通知。
