# Sub2API

Sub2API 将 `deepseek-harness-codearts` 的账号池和上游模型适配能力移植为一个独立网关，
对外提供 OpenAI 兼容 API，并附带中文 Web 管理台。管理台的导航、账号池操作和常用
运维视图参考了 `workbuddy2api-hub`。

## 一键启动

双击项目根目录下的 `Start.bat` 即可。脚本会自动完成以下操作：

1. 检查 Node.js 是否已安装
2. 首次运行时自动安装依赖（`pnpm install`）
3. 首次运行时自动构建（`pnpm build`）
4. 启动网关并自动打开浏览器访问管理台
5. 关闭命令行窗口即可停止服务

首次打开管理台时会要求设置管理员密码（至少 8 位），之后用密码登录即可。

## 功能

- OpenAI 兼容接口：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- 支持普通响应和 SSE 流式响应
- 多服务商账号池：`codearts`、`buddy`、`workbuddy`、`lobsterai`、`qoder`、
  `qodercn`、`trae`、`cline`、`loomy`、`raccoon`
- 账号添加、启停、排序、刷新、重测、重置、短信或设备码登录
- 模型目录与可见性控制
- API Key 创建、启停和模型白名单
- 用量、请求日志、定时巡检和手动巡检
- 管理台登录、首次初始化、备份导入导出
- 单容器 Docker 部署

## 架构

```text
apps/web                 React + Vite 管理台
apps/gateway             Fastify 网关和管理 API
vendor/deepseek-harness  CodeArts 及九个服务商适配器
```

生产模式下由 Fastify 直接托管 `apps/web/dist`。开发模式下 Vite 在 `5173`
端口运行，并把 `/api` 和 `/v1` 代理到 `8787` 端口的网关。

## 环境要求

- Node.js `22.19+` 或 `24+`
- pnpm `11.19.0`
- Docker 和 Docker Compose，可选

## 本地开发

```bash
pnpm install
pnpm dev
```

- 管理台：http://127.0.0.1:5173
- 网关：http://127.0.0.1:8787

首次启动时，如果未设置 `SUB2API_ADMIN_PASSWORD`，网关会在启动日志中打印一次性
设置令牌。打开管理台后输入该令牌并设置至少 8 位的管理员密码。

## 生产构建

```bash
pnpm install
pnpm build
pnpm start
```

默认访问地址为 http://127.0.0.1:8787。若将 Web 构建产物放在其他位置，可设置：

```bash
SUB2API_WEB_DIST=/absolute/path/to/apps/web/dist
```

## Docker 部署

```bash
docker compose up -d --build
```

打开 http://localhost:8787。Compose 使用命名卷 `sub2api-data` 持久化数据。

如果需要固定管理员密码，可以先在 `.env` 中设置：

```dotenv
SUB2API_ADMIN_PASSWORD=replace-with-a-strong-password
SUB2API_PUBLIC_URL=http://localhost:8787
```

注意：`SUB2API_ADMIN_PASSWORD` 只在首次创建 `admin.json` 时生效。后续修改环境变量
不会覆盖已经保存的密码。

查看首次初始化令牌：

```bash
docker compose logs -f sub2api
```

停止服务：

```bash
docker compose down
```

删除命名卷会同时删除账号凭据、API Key 和管理配置，请先备份：

```bash
docker compose down -v
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUB2API_DATA_DIR` | `./data` | 持久化数据目录 |
| `SUB2API_HOST` | `127.0.0.1` | 监听地址；容器内使用 `0.0.0.0` |
| `SUB2API_PORT` | `8787` | 监听端口 |
| `SUB2API_PUBLIC_URL` | `http://host:port` | 对外访问地址，HTTPS 下会启用安全 Cookie |
| `SUB2API_WEB_DIST` | `apps/web/dist` | Web 构建产物目录 |
| `SUB2API_API_KEY` | 空 | 可选启动 API Key，仅首次写入时创建 |
| `SUB2API_ADMIN_PASSWORD` | 空 | 可选管理员密码，仅首次初始化时生效 |
| `SUB2API_ALLOWED_MODELS` | 空 | 全局模型白名单，逗号分隔，支持 `*` |
| `SUB2API_DEFAULT_PROVIDER` | 空 | 请求未指定模型时的默认服务商 |
| `SUB2API_DEFAULT_MODEL` | 空 | 请求未指定模型时的默认模型 |
| `SUB2API_REQUEST_TIMEOUT_MS` | `300000` | 上游请求超时，毫秒 |
| `SUB2API_SCHEDULER_INTERVAL_MS` | `1800000` | 自动巡检间隔，设为 `0` 关闭 |
| `SUB2API_CORS_ORIGINS` | 空 | 允许跨域访问的浏览器源，逗号分隔 |
| `SUB2API_LOG_LEVEL` | `info` | Fastify 日志级别 |

## 创建 API Key

1. 登录管理台。
2. 打开“API 密钥”。
3. 创建密钥并可选设置模型白名单。
4. 完整密钥只会在创建时显示一次，请立即保存。

也可以通过 `SUB2API_API_KEY` 在首次启动时预置一个 Key。若需要轮换，建议在管理台
创建新 Key、切换客户端，再禁用或删除旧 Key。

## OpenAI 兼容调用

模型 ID 推荐使用 `provider/model` 形式，例如：

```text
workbuddy/gpt-5.5
codearts/deepseek-v4-pro
```

也可以直接使用不产生歧义的裸模型名。若多个服务商暴露同名模型，网关会要求显式
指定服务商。

列出模型：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-sub2api-..."
```

Chat Completions：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-sub2api-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "workbuddy/gpt-5.5",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

Responses：

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-sub2api-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codearts/deepseek-v4-pro",
    "input": "用一句话介绍这个网关。"
  }'
```

流式请求使用 `"stream": true`。网关会返回标准 SSE，并在结束后发送 `[DONE]`
或对应的完成事件。

### Codex / Codex++ 模型能力

`/v1/models` 会携带 Codex 需要的能力元数据：`context_window`、
`max_output_tokens`、`input_modalities`、`supported_reasoning_levels` 和
`default_reasoning_level`。Codex++ 的模型选择器读取的是本地
`model_catalog_json`，若该目录是用旧版本生成的，思考等级会为空，模型便无法使用。

重新生成后，可用脚本把网关能力同步进当前目录（会先自动备份）：

```bash
node scripts/sync-codex-catalog.mjs
```

脚本读取 `~/.codex/config.toml` 中的 `model_catalog_json`，也支持 `--catalog`、
`--gateway`、`--key` 参数。未声明思考等级的模型会补一个 `Default`（`medium`）
占位等级，仅供选择器使用，不会发往上游。同步后重启 Codex++ 即可生效。

## 数据、备份与升级

所有持久化数据都在 `SUB2API_DATA_DIR`：

- `admin.json`：管理员凭据和会话签名密钥
- `api-keys.json`：API Key 哈希、状态和模型白名单
- `settings.json`：默认模型、白名单、超时和日志级别
- `usage.json`：请求用量
- `logs.json`：运行日志
- 上游账号凭据和 `dsh-home`：服务商账号池及运行时状态

升级前建议同时备份整个数据目录。管理台“备份”页面用于操作上游适配器暴露的
备份数据，不能替代整个数据目录的副本。

源码升级流程：

```bash
git pull
pnpm install
pnpm build
pnpm start
```

Docker 升级流程：

```bash
docker compose build --pull
docker compose up -d
```

## 反向代理和 CORS

同源部署时不需要设置 `SUB2API_CORS_ORIGINS`。若管理台或 API 从其他源直接访问
网关，请将完整源加入：

```dotenv
SUB2API_CORS_ORIGINS=https://console.example.com,https://api.example.com
```

HTTPS 部署应把 `SUB2API_PUBLIC_URL` 设置为外部 HTTPS 地址，管理会话 Cookie 才会
带 `Secure` 标记。反向代理需要关闭 SSE 响应缓冲，并允许长连接。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
```

上游服务可能要求账号登录、地区网络或有效额度。没有真实账号凭据时，单元测试和
启动检查可以完成，但真实模型推理无法验证。

## 许可证

本项目移植并修改了 MIT 许可的
`deepseek-harness-codearts`。管理台参考了 MIT 许可的
`workbuddy2api-hub`。详细来源和版权信息见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
