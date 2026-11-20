# 续章 · Agentic V3 demo

从一张角色卡开始的持续角色故事。默认由 Main 按职责、人物和证据派发旧 Agent 团队，再由一个 Actor 流式生成一条完整场景回复。后台分别整理记忆、物品、地点、人物、任务与约定，保留统一的证据验证与事务提交。

当前核心结构与接入边界见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。旧 pipeline 文档完整保存在 [历史文档](docs/PIPELINE_HISTORY.md)，其中旧流程和测试数字不代表当前版本。

C 端和管理端现在使用独立入口、构建和端口。C 端只提供角色、会话与故事体验；Prompt、调用链、队列审计等在管理端。身份网关契约与上线步骤见 [入口与身份](docs/ENTRY_POINTS.md)。

## 安装与升级

只看本地界面时，安装依赖后运行 `npm run preview:local`，打开 `http://127.0.0.1:7633`（C 端）和 `http://127.0.0.1:7634`（管理端）。两端共用内存演示数据，支持聊天、场景、玩家身份和 Prompt 编辑预览；回复固定，数据重启后清空，不连接数据库、Harness 或真实模型。该命令仅监听本机且拒绝生产模式，不能用作对外服务。前端修改后刷新页面即可。

需要 Node.js 22.19+、PostgreSQL，以及并列的 roleplay-harness 工程。本地 PG 监听127.0.0.1:55432，应用地址 http://127.0.0.1:7633/ 。

先在两个工程安装依赖。首次复制 .env.example 为 .env，配置后端模型密钥，不覆盖现有配置。已有数据库升级前停止应用写入并备份，然后依次执行：

```powershell
npm run db:backup -- before-upgrade
npm run db:migrate
npm run harness:build
npm run db:seed-prompts
# 仅在确认发布当前协议默认 Prompt 时执行，保留旧版本。
npm run db:publish-world-prompts
npm run build
npm run build:admin
# 生产启动前先配置可信身份网关与 AUTH_GATEWAY_SECRET。
npm start
# 另一个进程：npm run start:admin
```

首次建库使用 db:setup；db:start / db:stop / db:status 管理本地 PG（这些本地 PG 脚本仅支持 Windows，macOS/Linux 需单独配置 PostgreSQL）。仅本机演示时，在忽略提交的 `.env` 显式设置 `LOCAL_DEMO_ONLY=true`，分别运行 `npm run dev` 和 `npm run dev:admin`，默认地址为 `127.0.0.1:7633` 与 `127.0.0.1:7634`。生产启动拒绝本地演示身份。Harness 修改后须重新构建并重启服务，不能只刷新网页。构建同时生成宿主应用类型与时间规则，禁止手工修改 .harness-contract。

MODEL_MODE=live 使用真实 Kaon；配置缺失拒绝启动。demo 使用明确标识的确定性夹具。KAON_MODEL 控制 Actor，KAON_MAIN_MODEL 控制 Main/Opening，KAON_UPDATER_MODEL 控制 WorldOps/Pulse/Arbiter；环境变量变更后重启。实际模型及用量以调用记录为准。

Prompt 开发台保留六类兼容策略的编辑与版本；旧十六项 Prompt 从原目录读取并接入独立调度，调用记录用真实职责名称展示。保存和试跑分开，Main 试跑使用当前团队入口且不提交世界，实际模型试跑仍可能收费。自定义 Actor 文风继续保留。旧目录只读，不在每次启动时覆盖原 Prompt。

`OLD_AGENT_TEAM` 默认启用；启动前须已导入全部十六项旧 Prompt（缺项会拒绝启动）。可显式设置 `OLD_AGENT_TEAM=false` 使用兼容流程。团队模式使用逐回合持久后台任务；`SCENE_LOCATOR` 开启时保留专用定位器，移动到 Main 地点任务的后台子步骤，不再同步拖住正文交付。Wiki 输出显示在世界档案的剧情页，并保留来源回合。

## 操作与数据

- 首次开场默认使用作者 welcomeMessage，展开角色与玩家姓名，不调用模型；动态开场须显式选择。
- 一张根卡对应一个世界；正文中自然出现的新人物登记为 NPC，不拉入其他根卡。同世界新会话延续经历。
- 玩家身份支持多套姓名/persona；应用后影响后续回合，历史消息保留当时身份。
- 世界档案展示 NPC、地点、物品、约定、记忆和剧情进度。主线是建议，事件账本是有来源的状态。
- 整理失败保留回复和原文，显示重试入口；持续聊天可能暂时领先于后台。

db:import-characters 和 db:import-agents 导入旧库模板及配置；db:import-sqlite 是独立的旧 demo 导入入口。它们不会迁入旧分钟 tick。表结构以 server/migrations 为准；迁移身份与应用身份分离。密钥仅存后端忽略提交的配置。

## 官方应用接入

前端 App 可注入 createApiClient（baseUrl、fetch、getHeaders、storageNamespace）。样式限定 .agentic-app，导航不占宿主 URL，每账号使用独立本地命名空间。

后端 `createApp({store,runtime,authenticate,resolveRuntime,audience,developer})` 必须注入官方身份；省略身份处理时拒绝访问。`audience` 默认为 `consumer`，不挂载管理接口；`admin` 必须提供逐请求的管理授权。生产使用 `StoryStore(pool,{livingWorld:true})`；默认 false 仅兼容旧夹具。`ENABLE_DEVELOPER_TOOLS` 不再授予管理权限。

| API | 用途 |
| --- | --- |
| GET /api/bootstrap | 角色库、世界、会话与配置 |
| POST /api/sessions | 新世界/同世界新会话，默认作者开场 |
| POST /api/sessions/:id/turns | clientTurnId、content；幂等、SSE单条回复 |
| GET /api/turns/:id | 断流后读取持久状态 |
| POST /api/turns/:id/cancel | 取消生成 |
| GET /api/worlds/:id | 归档、剧情、事件与后台进度 |
| PATCH /api/worlds/:id/scene | 带 expectedRevision 编辑场景 |
| /api/player-profiles | 多套玩家身份模板 |
| GET /api/turns/:id/trace | 仅管理端：输入输出与来源 |
| /api/dev/prompts、/api/dev/agents/:key/test | 仅管理端：Prompt 版本与独立试跑 |

SSE accepted 对账输入，delta 更新同一消息，committed 确认保存并解锁发送。failed / cancelled 为生成终态；EOF 不等于成功，须查询持久状态。后台整理独立于消息终态；旧会话的回调不能污染新会话。

创建会话尚无请求幂等键；断网后先核对列表，不能盲目重建。官方宿主另需 TLS、真实鉴权、SSE代理配置、配额及备份恢复设施。

## 验证

npm run verify 构建 Harness、检查类型、运行宿主回归并构建前端；`npm run build:admin` 生成管理端。消费者构建自动检查不包含管理组件，独立安全测试为 `node --import tsx --test test/auth-entry.test.ts`。PG 测试使用独立测试库随机 schema；Harness 协议测试用本地假提供商。真实短聊另存 .verification，不能用单测数量代替剧情质量结论。验收报告不再进入公开静态目录。

/health/live 与 /health/ready 不调用模型。以前的验收与限制保留在 VERIFICATION.md 和 KNOWN_ISSUES.md，核查时注意版本。

