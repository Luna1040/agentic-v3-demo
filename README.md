# 续章 · Agentic V3 demo

从一张角色卡开始的持续角色故事。普通聊天由一个 Actor 直接流式生成一条完整场景回复，多位 NPC 在同一正文中行动和说话。后台负责记忆、事件状态与跨多轮主线。

当前核心结构与接入边界见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。旧 pipeline 文档完整保存在 [历史文档](docs/PIPELINE_HISTORY.md)，其中旧流程和测试数字不代表当前版本。

## 安装与升级

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
npm start
```

首次建库使用 db:setup；db:start / db:stop / db:status 管理本地 PG。npm run dev 使用热更新前端。Harness 修改后须重新构建并重启服务，不能只刷新网页。构建同时生成宿主应用类型与时间规则，禁止手工修改 .harness-contract。

MODEL_MODE=live 使用真实 Kaon；配置缺失拒绝启动。demo 使用明确标识的确定性夹具。KAON_MODEL 控制 Actor，KAON_MAIN_MODEL 控制 Main/Opening，KAON_UPDATER_MODEL 控制 WorldOps/Pulse/Arbiter；环境变量变更后重启。实际模型及用量以调用记录为准。

Prompt 开发台显示六项职责、版本、试跑与调用记录。保存和试跑分开，试跑仍可能收费。发布脚本替换启用文本，自定义文风须先核对再迁移，不能每次启动自动发布。旧16项配置只读留档。

## 操作与数据

- 首次开场默认使用作者 welcomeMessage，展开角色与玩家姓名，不调用模型；动态开场须显式选择。
- 一张根卡对应一个世界；正文中自然出现的新人物登记为 NPC，不拉入其他根卡。同世界新会话延续经历。
- 玩家身份支持多套姓名/persona；应用后影响后续回合，历史消息保留当时身份。
- 世界档案展示 NPC、地点、物品、约定、记忆和剧情进度。主线是建议，事件账本是有来源的状态。
- 整理失败保留回复和原文，显示重试入口；持续聊天可能暂时领先于后台。

db:import-characters 和 db:import-agents 导入旧库模板及配置；db:import-sqlite 是独立的旧 demo 导入入口。它们不会迁入旧分钟 tick。表结构以 server/migrations 为准；迁移身份与应用身份分离。密钥仅存后端忽略提交的配置。

## 官方应用接入

前端 App 可注入 createApiClient（baseUrl、fetch、getHeaders、storageNamespace）。样式限定 .agentic-app，导航不占宿主 URL，每账号使用独立本地命名空间。

后端 createApp({store,runtime,authenticate,resolveRuntime,developer}) 注入官方身份。生产使用 StoryStore(pool,{livingWorld:true})；默认 false 仅兼容旧夹具。开发接口须授权，本地固定身份不适用于线上。

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
| GET /api/turns/:id/trace | 开发权限下的输入输出与来源 |
| /api/dev/prompts、/api/dev/agents/:key/test | Prompt 版本与独立试跑 |

SSE accepted 对账输入，delta 更新同一消息，committed 确认保存并解锁发送。failed / cancelled 为生成终态；EOF 不等于成功，须查询持久状态。后台整理独立于消息终态；旧会话的回调不能污染新会话。

创建会话尚无请求幂等键；断网后先核对列表，不能盲目重建。官方宿主另需 TLS、真实鉴权、SSE代理配置、配额及备份恢复设施。

## 验证

npm run verify 构建 Harness、检查类型、运行宿主回归并构建前端。PG 测试使用独立测试库随机 schema；Harness 协议测试用本地假提供商。真实短聊另存 .verification，不能用单测数量代替剧情质量结论。

/health/live 与 /health/ready 不调用模型。以前的验收与限制保留在 VERIFICATION.md 和 KNOWN_ISSUES.md，核查时注意版本。

