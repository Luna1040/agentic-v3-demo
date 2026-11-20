# 代码仓库与服务器更新

公开仓库：[Luna1040/agentic-v3-demo](https://github.com/Luna1040/agentic-v3-demo)。仅包含源代码、自动化测试和开发文档。`.env`、`.local`、数据库、角色卡数据、聊天/审计日志、验收原文、服务器 HANDOFF 和生成构建均不提交。公开源代码不等于公开实例的登录信息和用户数据。

第一版提交是服务器实际在运行的代码；本地 UI 改造作为未提交改动保留。提交历史不会伪造之前开发阶段的版本。Harness 保持独立工程，`harness-runtime.lock.json` 固定本应用依赖的已部署运行版本；不把完整 Harness 仓库一起公开。

## 本地开发

仓库根目录就是 `agentic-v3-demo`。DeepSeek Harness 或其他编辑器继续使用现有目录，不需要移动文件。

```powershell
git status
git diff
git add web shared
git commit -m "Improve chat interface"
git push origin main
```

按实际修改选择文件，不要强制添加被忽略的配置或数据。提交并推送只更新仓库，不触发线上发布。多人开发时各自建立分支并合并，避免同一目录多人同时执行 Git 提交和切换分支。

## 更新线上版本

使用已经配置 SSH 的电脑：

首次升级为双入口前，先按 [入口与身份](ENTRY_POINTS.md) 配置可信身份网关、服务端共享密钥和独立的 `agentic-v3-admin.service`。旧的统一 `local` 身份与 `ENABLE_DEVELOPER_TOOLS=true` 不再适用于生产。

```powershell
ssh my-remote-server "bash /opt/AgenticV3/scripts/deploy-remote.sh"
```

默认更新 `origin/main`，也可传入已推送的提交号。脚本只接受当前提交的向前更新，发现服务器源文件有改动会停止；不自动 reset 或清理文件。

只检查候选版本能否构建、Harness 是否匹配及是否有活动任务，不迁移数据库、不重启服务：

```powershell
ssh my-remote-server "bash /opt/AgenticV3/scripts/deploy-remote.sh --check"
```

流程为：拉取 → 独立候选目录安装锁定依赖、类型检查与两份构建 → 校验身份配置、Harness 锁定版本与活动任务 → 保存旧源码 → 停止两服务后复查并备份数据库 → 数据库迁移 → 向前更新代码与替换两份构建 → 启动并分别检查健康。相同 Git 提交也重新检查和构建，避免上次发布中断后误报成功。

预检同时核对数据库已应用迁移的校验和。迁移 SQL 使用原始字节保存，Git 不转换换行；不能修改已应用迁移或通过改数据库中的校验和绕过检查。结构变更应新增迁移。

有正在生成的聊天或后台 Agent 时会停止本次部署；用户稍后重试即可。后台 pending 任务保留在数据库，不会重建数据库、导入角色卡或自动发布 Prompt。数据库迁移失败前不会更新当前 Git 提交。

更新脚本要求当前部署环境的 root 权限、两个 systemd 服务、PostgreSQL 和既有迁移配置。它不是通用托管平台脚本。备份在 `/opt/AgenticV3-backups/git-<UTC时间>/`，含旧提交号、Git bundle、数据库快照及替换后的旧构建；旧 `dist/verification` 仅随旧构建进入私有备份，不复制到新站点。候选目录包含本机配置，不能上传仓库。部署中断后检查两服务和备份；脚本不自动回滚数据库迁移。

## Harness 变更

仅改 UI 无需重新构建 Harness。修改 Harness 协议后，先在完整 Harness 工程构建并验证，再部署匹配的 `.harness-contract` 和运行依赖，同时更新锁定文件。部署脚本发现源码锁与服务器运行版本不同会拒绝继续，不会自行拉取或重建第三方 Harness。
