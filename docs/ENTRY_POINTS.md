# C 端、管理端与身份

| 入口 | 开发 | 生产 | 构建目录 | 默认监听 |
| --- | --- | --- | --- | --- |
| C 端 | `npm run dev` | `npm start` | `dist` | `127.0.0.1:7633`（`PORT`） |
| 管理端 | `npm run dev:admin` | `npm run start:admin` | `dist-admin` | `127.0.0.1:7634`（`ADMIN_PORT`） |

分别执行 `npm run build` 和 `npm run build:admin`。两端可共用数据库与匹配的 Harness，使用既有数据库租约协调后台任务。C 端没有 Prompt 开发台、模型调用链或运行审计入口，服务端也不挂载对应管理 API。管理端保留这些工具，HTML、静态资源及管理 API 都要求管理身份。普通用户不能通过更改前端路由获得权限。

生产服务不启用 Vite。两个监听器各自只提供自己的构建目录；`/admin`、`/dist-admin`、`/verification` 不在 C 端公开。历史验收报告只留在私有备份中，不能重新复制进 `dist` 或通过 nginx alias 绕过应用暴露。

## 生产身份网关

本项目没有新增账号、密码或登录页。部署前必须接入宿主已有的登录系统或可信身份网关。两个进程均要求 `AUTH_GATEWAY_SECRET` 至少 32 字节；密钥仅保存于网关和后端，不能下发浏览器、写入前端环境变量或提交仓库。

网关完成登录验证后，覆盖客户端传入的以下请求头，再转发至 loopback 服务：

| 请求头 | 网关提供的值 |
| --- | --- |
| `X-Agentic-Gateway-Secret` | 与后端相同的服务端共享密钥 |
| `X-Agentic-User-Id` | 已登录账号的稳定身份；最长 200 字符，不含空白、控制字符或逗号 |
| `X-Agentic-Roles` | 逗号分隔的角色；仅精确的 `admin` 授予管理权限 |

客户端自行填写用户或角色头不能通过认证。网关必须覆盖全部三个头，不能透传或拼接浏览器值；必须验证登录及角色，单纯添加共享密钥并信任客户端用户 ID 不构成身份接入。网关还负责 HTTPS、登录 Cookie 的 SameSite/CSRF 防护以及 SSE 长连接配置。管理端建议使用独立受控域名或内网入口，不能将公开域名的 `/admin` 路径转发到它。

应用的写 API 额外拒绝 `Sec-Fetch-Site: cross-site`（403），并要求 `Content-Type: application/json`（415）；包括取消、重试等无业务正文的操作也发送 `{}`。当前只提供同源浏览器接入，不提供跨来源 CORS 支持。这层检查不能代替网关的会话与 CSRF 防护，尤其是没有 Fetch Metadata 头的客户端。

管理身份仍以该账号作为数据归属，不会自动读取其他账号的聊天。浏览器调用同源 `/api`，不持久化服务端密钥。管理端默认只在内存保留 Prompt 草稿；宿主显式提供账号命名空间后才能启用本地草稿持久化。嵌入官方宿主时，继续通过 `createApiClient` 注入请求方式，并为不同账号设置独立的 `storageNamespace`。

## 仅本机演示

显式设置 `LOCAL_DEMO_ONLY=true` 后，`dev` / `dev:admin` 可使用 `local` 身份，仅接受 socket 的 loopback 地址，不信任 `X-Forwarded-For`。不要把开发监听器转发到公网。`npm start`、`start:admin` 或 `NODE_ENV=production` 会拒绝此选项，即使同时配置了共享密钥。默认不开启本地身份。

## 升级已有部署

1. 在现有身份网关配置上述契约与密钥，关闭 `LOCAL_DEMO_ONLY`。为 C 端和管理端配置不同端口。
2. 保留 `agentic-v3.service` 为 C 端，并配置独立 `agentic-v3-admin.service`；同一工作目录、非 root 应用账号和后端环境，分别运行 `npm start` 与 `npm run start:admin`。
3. 更新反代：公众入口只指向 C 端；管理入口验证管理员后指向管理端。移除旧的静态 `verification` 映射。
4. 使用部署脚本的 `--check` 验证两份构建、身份配置、Harness 与数据库。正式部署时停止两服务后备份，替换两个构建，再分别检查健康。

`/health/live`、`/health/ready` 不调用模型。健康通过不等于网关已配置正确；上线验收需分别确认未登录 API 返回 401、普通账号访问管理端返回 403、管理员可进入管理端，以及 C 端的管理 API/报告路径不可用。本地安全测试不替代这一网关验收。
