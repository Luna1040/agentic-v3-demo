# 远程部署交接（2026-10-23）

当前版本已部署至 SSH 主机 `my-remote-server`（16.58.237.83）。

## 运行位置

| 项目 | 配置 |
| --- | --- |
| 网站入口 | http://16.58.237.83:7005/ ，nginx Basic 登录保护 |
| 当前应用 | `/opt/AgenticV3` |
| Harness | `/opt/roleplay-harness`，运行版本 0.6.0 |
| 后端监听 | `127.0.0.1:7081`，通过 nginx 7005 访问 |
| 服务 | `agentic-v3.service`，已启用开机自启及异常重启 |
| 数据库 | 本机 PostgreSQL 16，`agentic_v3_demo`，迁移版本 17 |
| 应用数据库角色 | `agentic_demo_app`，迁移角色 `agentic_demo_migrator` 独立保存 |
| 运行系统用户 | `agenticv3`，非 root |
| 应用配置 | `/opt/AgenticV3/.env`，权限 600 |
| nginx 配置 | `/etc/nginx/conf.d/agentic-v3-demo.conf` |
| 登录密码文件 | `/etc/nginx/agentic-v3.htpasswd`，不含明文密码 |
| 私有迁移材料 | `/root/agentic-v3-deploy-20261023` |

网站是单用户 demo：Basic 登录后使用同一个 `local` 身份，并非多租户账号系统。开发调试功能已开启。当前入口为 HTTP；正式对外服务应配置域名和 HTTPS。

## 数据与构建

迁移本地数据库的全部数据，包括角色卡、会话、世界状态、记忆、玩家身份、Prompt 版本及调用记录。总计 133 张角色卡、39 个会话；当前 `local` 身份下可见 35 个会话、21 个世界和 2 个玩家身份。其余会话属于其他验证身份，不会混入用户会话列表。

Actor 使用 `kaon/gemini-3.8-flash`，Main 使用 `kaon/claude-opus-4-8`，WorldOps 使用 `kaon/gpt-5.6-luna`。启用的 Prompt 版本为 Main 19、Actor 26、Updater 32、Opening 12、Pulse 5、Arbiter 4。

Harness 随版本交付匹配的编译运行依赖图、`apps/agentic-v3` 源码和构建标识，不是完整的 Harness 开发仓库。后续应在完整 Harness 仓库构建，再连同匹配的 demo 一起更新，不能直接把精简运行目录当作完整源码工程构建。

构建标识位于应用 `.harness-contract/build.json`：源码提交 `2476e02737f53ddedf06cdbc8c0b531cf7e76f11`；应用源码哈希 `1d2dd4dbf674468bb43225ed6d0d1764d9c0655458222e2f153c69cf31460cbb`。构建包含该提交之后的工作区修改。

## 运维

在远程执行：

```sh
systemctl status agentic-v3 --no-pager
journalctl -u agentic-v3 -n 80 --no-pager
curl -fsS http://127.0.0.1:7081/health/ready
systemctl restart agentic-v3
```

nginx 已关闭响应缓冲并允许较长的流式响应。后台整理进程由同一应用服务启动。应用数据库凭据不含迁移权限；升级 schema 时应单独使用 root 私有目录中的迁移配置，不能扩大应用角色权限。

## 旧版与回退

旧版完整保留在 `/opt/AgenticV3-backups/20261023T114404Z/old-app`，原数据库 `agentic_v3` 未改写，另有同目录 `old-database.dump` 快照及原三个服务文件。

旧服务 `agentic-v3-backend`、`agentic-v3-frontend`、`agentic-v3-worker` 已停止并关闭自启；其他应用未变更。

回退时先备份新版数据库和文件，再停止并禁用 `agentic-v3.service`，移走本次 nginx 配置并重新加载 nginx，释放 7005；把当前应用目录另存后将备份中的 `old-app` 放回 `/opt/AgenticV3`，最后启用原三个服务。旧版使用原数据库，无需把新版数据导入旧版 schema。

## 本次验收范围

- 远程服务、PostgreSQL、Harness 均正常；开机自启已启用。
- 从本地经公网确认：未登录返回 401，登录后页面、健康检查、角色卡、会话、玩家身份、Prompt 配置及世界状态可读。
- 原有客厅地点已保留。
- 经 nginx 重放已完成对话，收到 SSE accepted/committed，确认没有新增模型调用。

首次部署只验证代理连通和流式重放，未新增真实 RP 对话。20:03 的人物/物品修复更新了应用及 Harness 应用层代码，并将 Updater 发布为 v31；原历史版本保留。该补丁已通过两轮独立测试库的真实自然点餐，后台两轮均归档成功，但不代表上游模型首字延迟有改善。

当前露兹与米莉的旧世界已按审核原文拆分成两个 NPC；三杯鸡补为已选、待下单事项，米饭和汤的购物车状态保留。聊天原文未改写。补丁前快照：`/opt/AgenticV3-backups/cast-intent-20261023T120329Z`，含数据库和应用/Harness 代码。人物模型与维护规范见 [多人物角色卡与旧数据修复](AUTHORED_CAST.md)。


2026-10-26：已完成全链路记忆修复及五轮连续状态验收，详情见 [入库链路核查](MEMORY_PIPELINE_AUDIT.md)。远程补丁前备份 `/opt/AgenticV3-backups/memory-flow-20261026T071635Z`。当前报告入口 `/verification/memory-pipeline.html`，沿用网站登录保护。

2026-10-26：新增追加式 `world_runtime_audit` 审计表和「世界状态与剧情 → 队列与入库」观测入口，用于用户手动进行七轮快速聊天验收。使用流程、冲突规则与日志导出见 [七轮队列观测](QUEUE_STRESS_TEST.md)。升级不修改模型或 Prompt，不迁移替换用户数据库内容；应用角色仅能读取、追加审计，不自动清理日志。
