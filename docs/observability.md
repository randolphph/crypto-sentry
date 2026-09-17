# CryptoSentry 日志与联调观测

后端使用 Fastify 结构化日志。日志默认输出到进程标准输出，systemd 部署时可用 `journalctl` 查看；本地开发时直接查看 `npm run dev` 的终端输出。

## API 请求日志

所有 `/api/v1/*` 请求完成后都会记录：

```json
{
  "msg": "API request completed",
  "requestId": "req-...",
  "method": "POST",
  "route": "/api/v1/monitors",
  "statusCode": 201,
  "durationMilliseconds": 42,
  "request": {
    "params": {},
    "query": {},
    "body": {
      "type": "uniswap_wallet",
      "config": {
        "rpcIntegrationId": "int_rpc",
        "chainIds": [4663],
        "versions": ["v3"],
        "walletAddress": "0x..."
      }
    }
  }
}
```

错误响应会使用 `API request completed with error`，同时保留 HTTP 状态、路由、脱敏请求参数和 requestId；错误处理器还会记录 `API request rejected`（包含稳定错误码和字段）。前后端可以通过同一个 requestId 对照。

## 配置变更日志

Integration、Monitor、Rule 创建、修改和删除成功后会记录：

```json
{
  "msg": "Configuration changed",
  "entity": "monitor",
  "operation": "created",
  "id": "mon_..."
}
```

## RPC 请求日志

失败请求、耗时超过 2 秒的请求在 `info` 级别配置下会记录。设置：

```dotenv
LOG_LEVEL=debug
```

后会额外记录每次 JSON-RPC HTTP 请求的方法、耗时、HTTP 状态和成功结果。例如：

```json
{
  "msg": "EVM RPC request",
  "methods": ["eth_call"],
  "durationMilliseconds": 118,
  "statusCode": 200,
  "ok": true
}
```

Multicall 在 HTTP 层通常显示为一个 `eth_call`；合约内部子调用数量仍由节点服务商自己的 CU 规则计算。

每个 RPC HTTP 请求还会被批量写入 SQLite（不是只存在终端输出），保留最近 7 天。用于排查请求量与失败率的接口为：

```http
GET /api/v1/status/rpc-requests?limit=100&taskId=uniswap:mon_...
```

返回的每项只包含 `observedAt`、调度 `taskId`（如果请求由监控任务发起）、JSON-RPC `methods`、耗时、HTTP 状态、成功标志和错误名称：

```json
{
  "items": [
    {
      "observedAt": "2026-09-17T09:41:20.123Z",
      "taskId": "uniswap:mon_abc",
      "methods": ["eth_call"],
      "durationMilliseconds": 118,
      "statusCode": 200,
      "ok": true,
      "errorName": null
    }
  ]
}
```

`taskId` 可用于把一轮调度内的请求归因到具体 Monitor；没有调度上下文的 API 操作会显示为 `null`。该审计记录故意不保存 RPC URL、认证 Header、Token、JSON-RPC 参数或返回内容，避免把密钥和链上调用载荷写入数据库。审计写入按批次提交，过期记录最多每小时清理一次，不会为每个 RPC 请求单独创建 SQLite 事务。

## 敏感字段

日志不会记录 RPC URL、API Token、Authorization、静态 Header 值、密码、私钥、主加密密钥或请求中的密钥字段。日志中的 `rpcUrl` 和 `headers` 会显示为 `[REDACTED]`。钱包地址、chainId、tokenId、monitorId 和资源选择参数会保留，方便定位联调问题。

## 查看方式

本地：

```bash
npm run dev
```

服务器 systemd：

```bash
journalctl -u cryptosentry -f
```

按 requestId、route、statusCode、entity 或 operation 过滤即可定位一次前端操作的完整链路。日志文件不要提交到 Git；仓库已忽略 `*.log`。

服务启动失败（例如端口已被占用）时，进程会主动关闭 Scheduler、WebSocket、RPC 客户端与 SQLite 连接后再退出；不会保留仍在后台请求 RPC 的半初始化进程。
