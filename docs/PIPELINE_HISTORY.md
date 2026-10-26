# 续章 · Agentic V3 demo

## 当前本地版本：pipeline34（2026-10-23，共同背景与按需原文）

各职责使用同一版角色 `contextPack`：完整作者背景、personality、原卡开场背景、本人压缩记忆及待整理回合索引。Actor 只获得本人的资料；Main、WorldOps、Pulse 和 Arbiter 按其任务读取相关角色各自的背景，服务审查不代表秘密自动广播给角色。作者开场保留为背景，不在续聊中重演。

默认不重复附带历史聊天。需要核对具体旧言行、精确引用或摘要尚未覆盖的指代时，模型可调用 `read_dialogue`；世界、角色与源回合由程序绑定，每阶段最多一次、三轮、12,000字。原文保留在 PostgreSQL，返回前再次按角色观察范围投影；读不到不表示没发生。后台保留作者背景快照，摘要可承接本角色严格更早的已提交回合刚整理好的结果；若当前数据库摘要属于本轮或未来，则从已完成整理结果查找合法历史摘要，再退回冻结摘要，不能借新数据库状态读到未来记忆。

普通 Actor 仍直接流式输出，没有额外的检索决策请求，也不等待 Main。实际选择查原文时需要一次续写请求，会增加该轮首字等待；两次请求共用截止时间。正文开始后才要求查询会明确失败，不偷偷重复生成。调试调用记录的 `dialogueReads` 保存实际查询、投影后的结果与读取错误。

已建立的关系及兼容的生活背景允许自然承接并进入角色摘要。证据拆分区分回忆和随后真实发生的动作；历史钟点不再直接当作当前报时。当前完成、玩家同意、隐私与真正矛盾仍单独校验。这不是放开凭空完成任务，也不表示所有长期剧情问题已经解决。当前验证记录见 `.verification/context-pack/`。

本轮短测共三次已保存聊天：第一轮首字4.015秒、未查原文；第三轮按“先记账上”检索原句并正确回答“卢娜老师”，首字3.196秒。第二轮测试脚本截断问题，两次隔离复测也继承半句，均不用于检索准确性结论，已修脚本并保留记录。三轮整理最终完成；旁观NPC重复追问仍存在。短测发现摘要承接边界问题后修复，24项宿主定向回归验证；历史摘要未批量重算。Harness最终225/225、宿主基线219/219以及后续定向检查通过；详细事实见 [.verification/context-pack/report.html](.verification/context-pack/report.html)。

## 历史版本：pipeline33（2026-10-23，角色先回复）

普通聊天直接调用 Actor 流式回应，不等待 Main 或 Pulse。读取已经保存的世界状态、授权原始互动和仍然有效的后台建议；没有建议也能自行推进。首个角色先开始回复，可用建议里的其他角色随后按独立知识边界出演。显式生成新开场仍使用 Opening，作者原开场不调用模型。

Main 改为每世界一条可覆盖的后台请求：记忆整理优先，连续聊天合并到最新进展，过时结果丢弃。建议只供下一次演出参考，不直接改变世界；源回合、世界版本、场景、身份不匹配或用户明确拒绝/离开/转题时不使用。世界调整会使已有建议失效，待后续聊天重新规划。

记忆队列仍按世界顺序处理，每次最多合并三轮同角色对话，一次模型提取、逐轮证据校验、原子提交。跨轮新实体依赖或审查失败会拆回单轮，最多三次尝试后等待手动重试。离线活动先按原回合冻结的时间与知识结算，再做记忆整理；前台不预先宣称这些未完成的活动发生过。旧状态更新不能覆盖后来的场景。

这降低积压和重复规划，但不承诺无限吞吐：输入长期快于整理仍会落后；全量原文持久保存，模型上下文有界。界面显示实际待整理/失败数量及后台导演状态，后台运行不锁住发送。迁移012增加批次和离线检查点，013增加每世界唯一的导演请求表，没有空闲世界tick，也未修改公共 Harness SDK。

真实 Scarlet 连续三轮首字分别为7.709、3.967、3.568秒，全部回复提交，后两轮实际合成一个WorldOps调用；最终后台整理与最新导演请求均完成。证据及实际记录见 [.verification/actor-first/report.html](.verification/actor-first/report.html)。宿主核心全量回归207/207、后续前端55项及导演2项针对性回归通过，类型检查和构建通过。这里验证响应链路和积压处理，不代表长期剧情、自然NPC和语义记忆已全面通过。

## 历史版本：pipeline32（后台世界整理）

角色正文流式完成后，宿主先把消息、原始观察与回应、场景、时间、身份和后台任务同事务保存，立即发送 committed 并解锁下一轮。WorldOps／必要的 Arbiter 由持久队列执行，失败不会撤销回复。界面显示后台进度，失败可单独重试；重试不再执行 Main／Actor／Pulse。

同一世界按原回合顺序整理。后台落库避开正在生成的前台回合；实体版本改变时重新合并，旧移动不覆盖更新的场景。输入事实、权限与运行配置未变时复用已完成检查点。任务失败或版本冲突最多尝试三次，之后保留任务等待手动重试；服务重启通过租约恢复。没有待整理任务时不调用模型。原始互动始终保存，角色检索额外包含最早两条未整理经历，保持有界上下文。

真实 Scarlet 连聊三轮、后台期间重启与最终落库证据保存在 `.verification/background/`。三轮从最后流式片段到提交分别为 107、165、168 毫秒，全部后台任务已完成。此验证针对解耦和恢复，不代表长期剧情质量已经全面通过。

最终宿主全量回归 201/201 通过（`.verification/background/host-tests-final.log`），Harness 世界回归 100/100 通过；类型检查与前端构建通过。初次全量测试的旧夹具和同步提交断言失败记录保留，已按当前严格协议更新后重新验证。迁移 010 新增持久队列，011 将证据文本长度与已验证的用户原文上限 8000 对齐。

## pipeline31：真实聊天阻断修复

Main 的 NPC 工具契约允许省略 definition，执行校验现与契约一致：省略时使用已经验证的 description，不补造身份或经历；显式非法 definition 仍拒绝。姓名展开后的 NPC 描述只能在与冻结身份计算出的模板展开完全一致时被视为等价，提交仍保留原模板，真正修改人设仍拒绝。

同场见过一个人不等于获得其私密档案。宿主对没有原档案授权的同场 NPC 仅存姓名、头像样式等身份快照，旧版本误存的完整快照在读取时也按身份范围投影，不能靠扩大 knownByCharacterIds 放过校验。原始私密描述不进入旁观 NPC 的输入。

实际失败与流式计时保存在 `.verification/scarlet-opening/live-p31*.json`。首次实测收到 23 个增量块，首字 25.5 秒，两位角色约 31.9 秒完成；首次提交被模板描述等价问题拒绝，修复后复用全部检查点于约 0.1 秒恢复提交，无新增模型调用。后续新鲜请求发现同场快照问题，修复后最终全新回合 7d220308-7461-4a79-8c18-a1eb3aff2839 一次提交成功：12.548 秒首字，17.441 秒两位 Actor 完成，39.185 秒 committed，19 个流式增量块；数据库消息、角色和地点已核对。证据为 live-p31-final.json 与 final-db-proof.json。回归检查与真实模型验收分开记录，不用重放冒充全流程成功。

pipeline31 当时仍等待 WorldOps／Arbiter 完成再提交；pipeline32 拆出了整理，pipeline33 又将普通聊天的 Main 规划移到后台。

## pipeline30：身份与模板展开


聊天显示、复制和模型输入都支持 `{{char}}` / `{{user}}`（大小写及空格兼容）。作者原开场按当前世界身份动态显示；已发生的对话按消息姓名快照显示，切换 persona 不重命名旧对话。无姓名时称为“玩家”。后端构造上下文时，角色卡的 description、definition、greeting、导演开场参考及 NPC 描述使用对应角色姓名和本轮玩家姓名，普通用户原话、历史证据与数据库原卡模板保持不变。角色显式 narrativeName 优先于展示名称。身份面板提供“保存并应用到当前世界”和“仅保存到身份库”，应用后开场显示立即更新，下一轮模型使用新的姓名/persona。

迁移 009 保留消息姓名快照。普通旧消息取当轮输入；旧欢迎语优先取本会话最早回合身份，无回合才取迁移时世界身份。前端对欢迎语展示使用当前世界身份，存储的旧快照不重写。18 项身份与开场针对性回归通过；通过读取模型输入验证姓名展开，不消耗模型额度。

新世界默认直接显示角色卡作者的原开场（导入的 `welcomeMessage` 存于 `greeting`），不调用 Opening/Actor，也不预先生成 NPC。前端可显式选择“自定义场景并生成新开场”；已有世界创建新场景仍走动态开场。原开场模式不提交自定义地点与情境，避免与作者正文冲突；它不会自动从正文提取结构化世界档案，后续聊天仍走正常更新流程。

动态开场的 `new_encounter` 若误把已有 NPC 当作新角色锚点，仅在已验证的 `nextBeat.characterId` 明确指向本轮新增 NPC 时纠正；无明确目标仍拒绝，不随机挑选、不自动补造角色。失败或取消的开场在版本升级后可手动重新请求，旧失败记录保留，新请求使用新检查点；已成功开场仍幂等，运行中的请求不能重复。

本次前后端针对性回归 24 项、Harness 回归 15 项通过，类型检查和构建通过。Scarlet 未开始聊天的失败会话已恢复为原卡 654 字开场，原文完全一致，新增 NPC 为 0，失败 trace 保留，修复未调用模型。证据位于 `.verification/scarlet-opening/`。这不表示其他历史剧情质量问题已解决。

## 历史版本：pipeline28（2026-10-23，本次实测已停止）

pipeline28 已构建发布，第10、11轮在固定版本下提交，身份与源码稳定检查均为 true。显式观察映射已成为必填，缺失成员会报错，显式无感知不会自动回填；未完整观察的目标不接收自由 nextBeat，旧检查点需重新核对观察与 Actor 输入。完整公开消息已在第9轮实测传入，但这不证明所有导演自由文字均有知识来源保证。玩家身份支持多套姓名/persona 保存、编辑、删除；模板与世界快照分开，新世界可选择，当前世界需显式应用，同世界续聊继承快照，运行中禁止切换。每轮冻结身份，历史消息保留当轮姓名。续聊现已同时修复消息与输入回填：只有全新静态世界写入原卡欢迎语，旧世界新会话不重插欢迎消息，也不因空历史把原卡开场补成已发生对话；新静态世界的完整欢迎语、旧消息和授权经历仍保留。动态导演的原卡参考继续独立提供。

导演可向指定 Actor 提供 `nextBeat`，它只是当轮演出意图，不是已发生事实、其他演员的共享知识或直接写库依据。每位实际出演 Actor 都必须有 `followUpReviews`，明确区分没有新未决事项、仅为角色说法、需要写入约定或已有约定仍有效；“声称派人”不证明派遣已执行，结构审查通过也不保证模型一定推进剧情。

物品交接检查仅对冻结 `playerProfile.name`、角色 `name`/显式 `narrativeName`、已知 NPC 实体姓名/显式正文姓名作完整匹配：把已知人物交给警卫，不再强制将其建成 item。交接审查仍必需，可明确选择 `not_persistent_item`；未知姓名不推断，“周宁的工作证”或同句后续放下钥匙仍要求物品命令。Provider 失败诊断只保留经过验证的请求标识、状态/错误码、完成原因与已报告用量等安全字段，不附带原始响应、请求头或隐藏推理；缺失用量不记为零。

程序验证分版本记录：[pipeline23 最终宿主全量 184/184](.verification/eva/host-pipeline23-final-tests.log)；pipeline24 受影响 [WorldOps 测试 12/12](.verification/eva/host-pipeline24-ops-tests.log)及类型检查通过；Harness pipeline24 157/157 通过。这些数字不是 pipeline24 宿主重新全量验收或真实剧情通过的声明。

**最终记录：11轮玩家对话提交成功，另有开场，4次旧失败完整保留。** 第9轮已验证跨会话身份、第三人称、客人表带线索和工作证延续；pipeline28第10/11轮均 identityVerified/sourceStableDuringRequest=true。第10轮首次归档伊娃的待核实责任，第11轮维持同一quest（active、completedMilestones=[]），NPC/地点/物品/quest为1/1/1/1，新增NPC为0。模型明确给出的 pendingResponsibility+applied 可展开为来源校验的待办命令，仅在没有同owner可见开放quest时补命令；不从原文猜责任，不生成已完成外部事实，trace保留expandedPendingQuestKey。applied指归档命令执行，active仍未完成。

第11轮Main虽用advance_goal锚定待办，演出仍以烟刺激和增加嫌疑延续等待，**有效剧情推进仍未解决**。phase“新约定”用于单方待办措辞不准；自然NPC、长离线及全面知情隔离未验收，导演自由文字仍可能携带其他旧秘密。第8轮漏观察及误写沉默的历史证据不删除。4次失败为pipeline21第6轮、pipeline23第7轮、pipeline26/27第10轮，不计成功；[报告](.verification/eva/report.html)保留用量和失败原文。相关程序验证42项、此前runtime回归127项，姓名长度收尾后followup17/17；这些范围不等于完整剧情通过。[辅助审阅纠偏](.verification/eva/review-9-10/adjudication.json)明确：不能把applied/active误读成调查完成或重复任务，但连续等待批评成立。

22张中文角色副本已独立入库，原卡保留。[导入证明](.verification/cards-zh/import-proof.json)与[API核验](.verification/cards-zh/api-proof.json)确认总卡133张、中文33张，本批22张均存在且名称一致。以下版本章节均为历史记录，不追认后续修复。

## 历史增量：玩家身份与第三人称（pipeline22，2026-10-22）

聊天顶部「玩家身份」或「偏好与说明 → 玩家身份」支持多套姓名/persona 的创建、编辑、删除和应用。保存只更新身份库；新世界开场面板选择身份后才将其复制到新世界。同一世界的新会话沿用世界快照，不重新读取模板。模板修改/删除不改写旧世界，显式「应用到当前世界」后影响本世界全部会话的后续轮次；「停用当前设定」仅清除当前世界的额外设定。运行中的回合禁止切换。切换是创作设定调整，不会建立新玩家实体或清空旧经历；独立人物请新开世界。

每轮冻结完整身份和版本，用户消息及历史互动 episode 保留当轮 `playerName`；旧正文不重写。当前姓名用于后续叙述，不把历史名字替换成新名字，也不自动编造改名、换人或失忆剧情。未保存的前端草稿按 API client 与世界隔离，切换模板或关闭面板后仍在本次页面内保留；刷新前需保存。版本冲突可刷新身份列表、显式放弃草稿载入最新版本或另存为新身份，不静默覆盖。

新增迁移 008：一张 `player_profiles` 模板表、`worlds.player_profile` 快照字段。接口为 `/api/player-profiles`（GET/POST）、`/:id`（PUT/DELETE，`expectedVersion`）和 `/api/worlds/:id/player-profile`（PATCH，`profileId`/`expectedRevision`）；创建新世界时可传 `playerProfileId`，已有世界续聊不能另传该字段。身份按宿主默认认证 owner 隔离。官方应用可直接调用同一 API，每位 owner 最多 30 套，persona 最多 3000 字，姓名最多 80 字。

Actor 输入和 Prompt 明确要求第三人称有限视角：动作主体为角色名，玩家叙述称呼取配置姓名或已公开姓名；未知时用 `{{user}}`，对白中的我/你保留自然人称。persona 是创作资料，不是 NPC 已知事件，不自动写入记忆。Main、Opening、根 Actor、新生成 Actor 均收到冻结身份。WorldOps 按证据 `source`/`characterId` 归属人物，不能按“我”猜主体；这些约束不等于模型每次都遵守。

角色的正文姓名可以由作者资料显式提供 `narrativeName`，创建世界时冻结到根角色实体，再传给 Actor 与人物移动证据校验。它不是玩家姓名字段，不从当前模型回复推断别名；模型实体变更不能自行创建或修改该字段。此次修改位于 Demo 宿主、UI 与 Harness 的 `apps/agentic-v3` 应用层，无需修改公共 Harness SDK、Tools 或 LLM 层。

验证记录：[宿主 182 项回归](.verification/eva/host-pipeline22-tests.log)通过；Harness `.verification/pipeline22-tests.log` 记录 102 项针对性回归通过。真实中文 Eva 当前已提交 6 轮玩家对话（另有开场）；第 6 轮 pipeline21 旧尝试超时，随后 pipeline22 的新尝试已提交，原失败完整保留且不计成功轮。当前聊天调用已知用量 188,534 tokens，其中失败尝试已知 9,135；另有 1 次失败 Actor 用量未知，不记为零。报告单列 Probe 与辅助审阅用量。

第 6 轮确认周宁身份快照和伊娃显式正文姓名进入 Actor，正文使用第三人称；外部查证仍只停留在伊娃说法与等待，没有执行者、调查结果或新 NPC，剧情未决事项承接问题仍在修。真实运行版本为 pipeline22，`narrativeName` 长度校验收尾补丁尚未重启生效。此前成功轮次不能视为 pipeline22 固定版本验收；完整剧情、长期节奏、自然 NPC 和 persona 保密质量尚未验收通过。当前证据见[实测报告](.verification/eva/report.html)及[已知问题](KNOWN_ISSUES.md)。

## 历史版本：pipeline18（2026-10-22）

本轮已修复：交接信号的必审覆盖、短离线窗口累计、不可执行活动不能伪装成邀请、明确实物放置不得豁免、工具参数分支和ID枚举、玩家持有物品的独立表示。同地点重复确认不再请求额外裁决。物品 `holderCharacterId="$player"` 表示玩家持有，NPC ID 表示对应角色持有，null 表示无人持有；旧记录不自动改写，不创建虚假的玩家NPC。

角色背景/阶段上下文/离线先结算后规划继续保持。修改仅涉及Harness应用层与Demo宿主/UI，没有修改公共SDK/Tools/LLM，也没有新增数据库表。当前针对性应用回归98项、持有人相关宿主/UI测试22项通过；此前pipeline17完整宿主172项通过，检查与UI构建通过。

真实验收按用户最新选择已由Amélie切换到独立中文Mafia boss Eva；英文原卡保留，中文卡未增加固定剧情。Amélie7轮及失败证据见[修复报告](.verification/pipeline13/report.html)，Eva正在进行，见[当前报告](.verification/eva/report.html)。本轮运行中有修复换版，不能称为固定版本30轮全部通过。自然NPC和长离线只按实际记录报告，不以测试数代替体验。

以下为各版本历史记录，与当前说明冲突时以顶部当前版本说明和对应运行证据为准。


<!-- pipeline13-implementation-unverified -->
当前本地实现更新为 pipeline 13（待用户实测）：角色卡背景通过独立directorContext/directorCard传给Main，不随greeting清空；stageProgress区分未完目标与最近结束阶段，新增resolve_goal演出方向；确定性时间计算、按需Pulse及必要结算裁决先于Main规划。没有针对某一角色卡写固定剧情，没有NPC轮数配额。按本次用户要求，仅修改、构建和启用版本，不运行测试或模型聊天；下方pipeline12及历史测试数字不代表此次改动验收通过。

<!-- round3-current -->
当前为第三轮代码修复（pipeline 12）。新增验收入口：[短测报告](.verification/round3/report.html)。本次最多6轮玩家聊天，逐轮检查，另有单Agent历史重放；不是又跑30轮。已修时间解析、离场/受众分离、必需状态审查、约定条款与进度合并、摘要写入DTO及导演方向传递。程序回归172/172 + Harness应用121/121；短测发现的最后一个“有点导致十分钟失效”由原句测试、真实候选本地重放及隔离PG验证修复。原短测错误仍保留，不能把修后重放冒充新版本实聊。自然新增NPC为0，体验尚未全通过。

以一张角色卡建立世界，让新 NPC、地点、物品与任务从场景中生成并持久化。玩家可以继续同一世界的新场景、观看多位角色分别演出，并查看有出处的互动与世界动态。花笺只作为视觉参考；前后端为独立新工程，旧工程与备份保留。

当前链路：React → HTTP/SSE → PostgreSQL → Harness 应用层 → 原生 Pi / Kaon Router。模型规划和演绎归 Harness，身份、知识授权、幂等、时钟、检查点与正式提交归宿主。实现合同见 [WORLD_IMPLEMENTATION.md](WORLD_IMPLEMENTATION.md)；测试和真实浏览器验收证据以 [VERIFICATION.md](VERIFICATION.md) 为准，本文不把代码完成当作真实模型验收通过。

RP 预设的来源、改编和编辑入口见 [RP_PRESET.md](RP_PRESET.md)。调试工作室支持导出六职责当前启用的 Prompt、版本和模型，便于复现与交接。

2026-10-22 中文 Amélie 修复后实测已完成 30 轮玩家对话：地点 3、物品 1、约定任务 1 已自动入库，新增 NPC 为 0。过程中有三次配置阶段及两条保留的失败 turn，不能当成单版本连续验收；31 个实际 Actor 输入的程序审计通过，叙事节奏、时序误判和条款同步仍有明确边界。本次未验收跨会话或真实长离线，详细证据见 [VERIFICATION.md](VERIFICATION.md)，旧基线不覆盖。

第二轮已加入故事时间、角色实体知识版本、相关经历检索和任务阶段，并在 pipeline 9 固定版本完成中文30轮、另计开场、跨4个同世界会话。报告为 [.verification/amelie-round2/report.html](.verification/amelie-round2/report.html)：31个回合存档及输入结构审计通过，3地点/1物品/1任务/0新NPC，实际离线活动1条。仍有时间遗漏、离场状态、物品更新和摘要滞后，体验未全通过。源码包与复现说明在同目录，旧实验不覆盖。

## 本地安装与升级

需要 Node.js 22.19+、Windows PowerShell 5.1+，以及并列的 `roleplay-harness` 源码工程。本地 PostgreSQL 18.6 使用官方 EDB Windows 二进制，位于 `.local/postgres/`，仅监听 `127.0.0.1:55432`，不安装系统服务。

```powershell
cd C:\Users\11043\Desktop\roleplay-harness
npm ci

cd C:\Users\11043\Desktop\AgentV3\agentic-v3-demo
npm ci
# 仅首次创建；已有 .env 请编辑，不要覆盖密钥。
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 配置 KAON_API_KEY、KAON_MODEL。
npm run db:setup
# 升级已有数据库时，先停止应用写入并备份，再执行迁移。
npm run db:backup -- before-living-world
npm run db:migrate
npm run harness:build
npm run db:seed-prompts
# 显式发布当前六职责协议的默认 Prompt；保留旧版本历史。
npm run db:publish-world-prompts
# 默认读取 ../agentic_v3_db.dump，也可在 -- 后传备份路径。
npm run db:import-characters
npm run db:import-agents
npm run build
npm start
```

打开 `http://127.0.0.1:7633/`。`npm start` 提供已构建前端；`npm run dev` 启用 Vite 热更新。应用停止不自动停止数据库。

| 命令 | 行为 |
| --- | --- |
| `db:setup` | 下载/初始化本地 PG、独立应用与迁移账号和测试数据库；保留已有数据 |
| `db:start` / `db:stop` / `db:status` | 管理本地 PG，后台启动不弹可见窗口 |
| `db:backup -- <label>` | 使用本地 `pg_dump` 生成 `.local/backups/` 自定义格式备份，输出文件位置和校验和，不输出密码 |
| `db:migrate` | 以迁移身份应用 SQL 与校验和检查，并收紧应用权限；启动过程不执行 DDL |
| `db:seed-prompts` | 只补缺失默认项，不覆盖已启用版本 |
| `db:publish-world-prompts` | 将构建产物中的六份兼容 Prompt 显式追加为启用版本；内容相同则不重复追加 |
| `db:import-characters` | 导入 106 张原角色卡及版本来源 |
| `db:import-agents` | 导入原版 16 项配置、关联 Prompt 及版本来源，只读留档 |

`db:publish-world-prompts` 是部署者主动更新共享配置的操作，会替换后续调用所用的默认协议文本，不能当成无影响的每次启动步骤。自定义 Prompt 先审阅兼容性；旧历史不会删除。旧版 Main 的工具协议与新的 `run_scene` 不同，仅补齐缺失项不足以升级旧配置。

Harness 应用重新构建后必须重启业务服务。Node 会缓存已加载模块；服务检测到构建身份改变时返回 `HARNESS_RESTART_REQUIRED`，避免让旧代码冒用新版本摘要。单纯发布兼容的 Prompt 新版本无需重启，运行中的回合仍使用自己的冻结版本。

`MODEL_MODE=live` 调用真实 Kaon，配置缺失会拒绝启动，不回退成假回复。`MODEL_MODE=demo` 使用确定性 fixture，仍走实际应用协议、Harness/Pi 与 PG，界面明确显示演示模式。`KAON_MODEL` 指定角色演绎模型；`KAON_MAIN_MODEL` 可单独指定 Main/Opening，`KAON_UPDATER_MODEL` 可单独指定 WorldOps/Pulse/Arbiter，未设置的分组沿用 `KAON_MODEL`。`KAON_TIMEOUT_MS` 是每次请求时限。配置环境变量后需重启服务，实际调用模型以 trace 为准。

密钥仅存后端环境；本地随机数据库密码位于忽略提交的 `.local/postgres/credentials.json`，不要复制到浏览器或提交。部署使用 `DATABASE_URL` 与 `MIGRATION_DATABASE_URL` 分离账号。应用角色不能建表、修改角色种子库、原 Agent 归档或迁移记录；当前 Prompt 版本只读和追加。

## 从一张卡到持续的世界

1. 角色库浏览、搜索与语言筛选的是根角色模板。106 张迁移卡保留完整 `init_prompt`、原开场参考、媒体地址和版本来源；3 个示例默认隐藏，可切换查看。左栏仅显示最近角色。
2. 选卡打开场景创建器，填写地点、情境和参与方式。新世界只有这一张根卡；Opening 可以依据情境提出新 NPC 或地点，不能从全局角色库随意拉另一张卡冒充生成角色。
3. 动态开场和后续聊天会选出 1–3 位独立 Actor，按真实流式输出显示各自的名字与气泡。场景最多 6 人，不代表每轮所有人都发言。每轮最多生成 2 位 NPC，单世界最多 24 位；稳定实体 ID 与最终提交共同保证重试不会重复建人。
4. 世界档案展示本世界 NPC、地点、物品、任务、组织、完整互动和世界动态。可从 NPC、地点或邀请开启新场景，生成角色也可成为关注角色。新场景延续同一世界；再次从根卡库创建故事则是独立世界。
5. 会话保存自己的场景，包含地点、在场人物、情境与参与方式。`direct` 仅关注角色听见本轮私聊；`ensemble` 允许在场角色参与；`observe` 通过每次点击“继续演出”推进一幕，没有无限自动生成。

地点最长 120 字符，情境最长 1000 字符。场景编辑、开新场景、记忆操作及节奏修改受世界版本检查；生成中不允许并行修改。版本冲突必须读取最新状态后再操作，不能静默覆盖。当前关注角色不在场时，需让其重新登场或切换场景。

用户明确填写地点时，宿主在同一事务内复用本世界地点或创建仅带名称的用户来源记录，不补写虚构地理。创建/编辑场景及成功回合提交时，已知地点同步到实际在场 NPC 的 `state.locationId`，并让这些角色知晓该地点；`direct` 只更新关注角色。演出后的移动另走有来源的 `actorLocations`：只接受本人当轮实际外显离开/到达，目的地必须是本人已知地点；离开而尚未到达存 `null`，不把“朝宿舍走去”算成已到宿舍。本轮 episode 和知情者仍按演出时现场保存；新 camera 只带有独立移动证据的角色，不推断玩家同行。模型不能通过普通实体更新直接改写 NPC 位置。

新动态会话不插静态欢迎语。创建成功后，只有从未尝试过的新会话会自动调用固定 `opening:<sessionId>` 的首次开场请求。刷新、切换后重新进入或组件重新挂载时，已有开场记录一律只通过 GET 查询持久状态；失败或停止后必须显式点击重试，不能自动再次请求模型。失败且世界/运行配置已改变时，通过“重新搭建场景”创建延续本世界的新场景，保留原场景填写内容；不无限重试失效 ID。已提交开场和旧会话不会因刷新重新调用模型。

## 六个实际执行职责

正式世界回合为：可选 Pulse → Main 或 Opening 场景计划 → 1–3 个独立 Actor → 消息与场景原子保存、解锁发送；持久队列随后执行 WorldOps → 有明确冲突时的 Arbiter → 世界档案原子更新。

| 当前 key | 职责与真实调用边界 |
| --- | --- |
| `main` | 下一幕规划。原生工具 `run_scene` 执行场景演员及后续候选处理，不追加 Main 总结调用 |
| `opening` | 新场景第一幕的规划；与正式回合共用演员、提交、幂等和检查点机制 |
| `actor` | 每位选中 NPC 单独演绎，只读取自己的授权资料和可听见的当轮回应 |
| `updater`（WorldOps） | 提议玩家原话记忆与实体、任务变化；普通聊天可以无变化 |
| `pulse` | 真实间隔足够且有可处理角色时，一次有界结算日常活动或待参与邀请 |
| `arbiter` | 对已经标出的冲突或高风险候选实际裁决，不能绕过宿主的范围和证据校验 |

实际调用数量随演员数和条件阶段变化，不再固定为旧版的 2–3 次。Main/Opening 只收到公共规划资料，不能读取所有 Actor 的私密包。场景模式、身份、实体来源、任务状态、时间范围及最终写入均由程序校验；模型候选不直接等于持久事实。

各阶段完成后保存检查点。前台失败重试遵循冻结输入和配置边界；后台有独立检查点及执行编号，只有授权事实与配置一致时复用，trace 显示 `reused` 和原调用 ID。正文、原始记忆、场景、活动、时钟游标和后台任务先同事务提交；整理失败保留已提交事实和任务，不影响聊天。后台档案与任务完成状态另行同事务提交。

## 互动、记忆与知识边界

三类数据分别保留来源：

- **完整互动 episode**：由成功回合和原始消息投影，保留玩家消息、各 NPC 回应、场景、参与者及来源回合。NPC 当下做过的行为与拒绝可以跨会话承接；其台词只能证明“说过”，不能把台词里的过去传闻自动变为事实。演员只读自己参与或有授权来源的互动。
- **玩家原话记忆 event**：WorldOps 按需选择需跨会话保留的信息。新世界链路保存本轮该角色可感知的原文片段，旧单角色入口保留完整冻结原文；Harness 与 Store 复验来源，每轮至多一条，强制 private。多段观察以换行呈现，数据库保留各段原始边界，查询时复验顺序与来源；实体的用户证据必须完整落在某一原始片段内，不能跨拼接边界引用。完整用户消息仍在聊天归档保留。
- **世界实体**：保存已提交的 NPC、地点、物品、任务和组织，带出处与可知角色。根卡定义不能被模型重写，变化另存状态。任务结果仍受当前互动、活动证据和状态校验限制。

旧无证据记忆在迁移中隔离为 `unverified`，保留展示而不注入角色。故事抽屉标明“玩家原话 / 旧记录待核对 / 已停用”；待核对项可以停用，不能直接启用；有有效玩家证据的停用记录才可恢复。停用也会阻止该来源回合作为当前角色可读 episode 再次绕过记忆状态，但不会删除原聊天或开发 trace，也不会撤回其他原有听众的互动。正式 `livingWorld` 路径不再另注入同会话对话历史来绕过停用；静态欢迎语只供初次开场，已有互动后不再重复注入。

故事抽屉展示当前角色可用的最多 100 条有效记忆与 100 条近期待核对/停用记录。Actor 的宿主输入以 14000 字符为软预算、23000 为硬上限：完整角色卡、物品和活跃约定的已知状态优先，最多 6 段近期 episode 加 2 段与当前实体、地点或人物相关的旧经历，两路都受知情与停用过滤。预算紧张时丢完整记录，不截断否认；完整互动仍在数据库保存。这是有界结构化检索，旧经历进入输入不自动证明模型在正文正确召回。

新的互动按 NPC 保存 `observations: Record<string, string | string[]>`。当前模型输出必须为数组：1–8 段逐字、按原文顺序且不重叠的摘录，换行连接后最多 8000 字符；没有观察输出 `[]`，规范化存为空字符串。旧字符串仅作兼容，Actor 与后续记忆只读取本人的合法观察，owner 的完整聊天记录保留。非法来源或乱序片段在 trace 中显式丢弃，绝不以全文补齐；宿主提交和读取再次校验。`playerPresent=false` 时玩家远处动作不传给此场角色。升级前缺少观察分域的 living 记录保留供用户查看，玩家原文不直接灌入 NPC。当前第二轮源码使用 `episode-observation-v5` / pipeline 9，新增迁移 `007_story_time_entity_knowledge.sql`；不同配置身份的未完成检查点不能混用。旧实验仍保留当时的真实版本。

世界档案是玩家的观察视角，不是给每个 NPC 开全知权限。角色在场也不会自动得知其他角色的历史私密记录。

NPC 的 `state.arc` 保存为角色的视角摘要。新变更携带 `arcSource`，宿主复验本轮本人可见原话、本人回应或已接受活动后记录来源；查询时投影为本人专有的 `characterView`，不再以裸 arc 当作当前事实注入。来源可追溯也不证明摘要中的动机推断为真；旧无来源摘要标 `legacy_unverified`，不回填历史。真实行为、承诺和拒绝仍保存在完整 episode。共享实体保存版本和各角色最近获知的快照：持有当前版本的角色可私下更新，缺席者仍读旧版本，旧快照不能覆盖当前状态，部分更新不自动泄露此前未知内容。该机制不是字段级知识推理或自动广播。

WorldOps 通过一次原生 `submit_world_ops` 工具提交。当前演员负责、且知情范围允许的至多5项活跃/待开展约定必须逐项 `questReviews`：明确保持，或提供本轮证据更新描述、进度与状态。当前原文连续片段放入 `sourceSegments`，修订选择现成 `evidenceId`，程序恢复逐字引文并校验权限；实体变化与移动仍校验原 quote。任务可保存相对故事到期时间、一次/每日规则、当前阶段、已完成里程碑及下一步，意图不能记成完成。缺失、非法和超范围审查均留 trace，不把角色摘要当任务更新，也不增加总结模型调用。工具格式不保证模型每次作出正确语义判断。

## 世界时钟与返场动态

服务端 UTC 记录、界面本地显示和 `storyTime` 分开。故事时间保存相对第几日、时刻/时段、精度与来源，未知不补造日历。Main 可提出来自本轮玩家当前叙述的时间推进，Harness 与宿主独立按同规则复验；未来约定、否定或跑步成绩不能当成当前时刻。活跃在场场景不会只因真实请求间隔而快进；已离场且未暂停时，宿主可按真实间隔和倍率推进。暂停、安静和活跃模式保留，倍率 0.1–60；真实间隔不证明用户离开了应用。

每个 NPC 分别保存上次相遇与上次结算记录。Pulse 按该角色未审阅的故事跨度判断，最小窗口 1 秒、单次生成预算最多一天，只处理有限相关人物；没有符合条件的角色不请求模型，长离线也不逐分钟调用。实际审阅后可推进该角色的游标，即使结果为空，空结果不是发生了活动。日常活动受物理时长和地点约束，重大结果仅为邀请；失败/取消不提交游标，未处理角色不被全局时间宣布已结算。

已完成活动必须携带与角色本轮冻结位置一致、且该角色已知的本世界地点。位置缺失、未知或异地候选由 Harness 降为待参与邀请，Store 再次独立校验，不能靠省略地点绕过移动限制。邀请进入后续 episode 时明确标为“尚未发生”；当前没有旅行时间或地图路径模拟，结构检查也不能证明模型正文始终准确描述该地点。

Pulse 候选属于当前聊天事务，前台取消时一起丢弃。查看世界档案、修改节奏、刷新已完成会话不调用模型；仅尚未尝试过的新动态会话会自动发起首次开场；已有开场记录只做 GET 状态恢复。没有自行推进剧情的后台 tick 或离线自动推送；持久队列只整理已保存回合。

## Prompt 开发台与原版 16 项归档

开发台根据服务端目录显示六个当前 Agent。每份 Prompt 最长 12000 字符，可载入默认内容或最近历史到草稿；编辑、试跑和“保存并启用”分别触发，试跑不会自动发布。草稿按宿主提供的非秘密账号命名空间保存在 localStorage，刷新和导航后恢复；不存 provider 密钥或试跑上下文。

Main 试跑使用所选会话的真实授权快照，执行完整主子链，但不提交故事。Actor、WorldOps、Opening、Pulse、Arbiter 可独立试跑；Opening 独立试跑检查规划，不自动演出子链；WorldOps 要求助手输出；Pulse 保留真实时间门槛，不为测试伪造经过的时长。自然语言测试意图即可，不强制手写 JSON。live 试跑仍产生真实模型用量，点击停止会取消请求；同 owner 单进程最多一场，整体上限 180 秒。

试跑展示实际输出、失败摘要、主子调用树、模型与已返回用量；更改输入后标注旧结果。正式 trace 可查看各次尝试的实际 input/output、状态、父子关系、复用来源和运行配置元数据，不展示密钥、隐藏思考或原始 provider 响应包。未返回的 usage 显示未知，不填成零；trace 不是提供商完整账单。

原版目录包含 16 项配置。`db:import-agents` 从备份提取指定表的 COPY 数据、校验 Prompt 校验和并保存原来源，不执行备份 SQL；重复来源保持不变，冲突整批回滚。开发台只读显示原职责、启用状态、原运行配置、启用 Prompt 和历史。**原 Agent 配置版本与原 Prompt 版本是两套编号**，分别展示；归档不能直接作为新协议发布。

| 原版 key | 当前承接 |
| --- | --- |
| `world_orchestrator` | Main / Opening / Pulse 调度；宿主承担事务与恢复 |
| `scene_conductor` | Main 场景规划与独立演员选择 |
| `character_actor`、`phase1_actor` | Actor；早期配置另行留档 |
| `opening_director` | Opening 动态开场 |
| `teacher_worldops` | WorldOps 玩家证据与世界候选 |
| `knowledge_audit`、`user_agency_audit` | 程序知识授权、Actor 约束及条件 Arbiter；原独立审查 Prompt 留档 |
| `world_arbiter` | Arbiter 条件裁决 |
| `wiki_summarizer` | WorldOps 实体档案与原始互动展示，不额外生成攻略文章 |
| `quest_keeper` | WorldOps 任务状态与 Pulse 有界活动 |
| `world_pulse_planner` | Pulse 返场结算 |
| `location_generator` | Main / Opening / WorldOps 提议地点并验证提交 |
| `encounter_resolver` | 场景规划、演员演出与冲突裁决；没有独立战斗引擎 |
| `delivery_formatter` | 程序负责多角色消息渲染和持久化，无额外模型调用 |
| `auto_reply` | Pulse 返场动态与邀请，没有后台定时发送 |

这张表描述职责承接，不表示 16 项旧配置全部独立调用，也不把 enabled 当作调用证据。原工程中配置是否存在、是否发布与实际模型调用本来就是不同概念。

## API 与官方应用嵌入

前端 `App` 接受注入 `client`，`createApiClient` 支持 `baseUrl`、`fetch`、`getHeaders`、取消信号与 `storageNamespace`。导航不占用宿主 URL，样式限定在 `.agentic-app`；独立 reset 位于 `standalone.css`。宿主须按账号切换稳定命名空间，如 `agentic:tenant-a:user-123:`；`App.draftKeyPrefix` 可显式覆盖。不能把 token 当作命名空间，不能让多个账号共用本地演示身份。

后端 `createApp({store,runtime,authenticate,resolveRuntime,developer})` 接收官方身份与开发权限。生产世界模式必须用 `new StoryStore(pool, { livingWorld: true })`，独立入口已这样接线；默认 false 仅保留旧宿主/测试兼容。运行前完成迁移、Harness 构建与兼容 Prompt 发布。

| 接口 | 用途 / 主要输入 |
| --- | --- |
| `GET /api/bootstrap` | 当前授权角色模板、会话、世界与 runtime 状态 |
| `POST /api/sessions` | `{characterId,worldId?,dynamicOpening:true,scene?,expectedRevision?}`；既有世界只接受根角色或该世界已生成 NPC |
| `GET /api/sessions/:id` | 当前场景、角色范围记忆及最新消息 |
| `GET /api/sessions/:id/messages?before=ID` | 较早消息分页 |
| `POST /api/sessions/:id/opening` | SSE 动态开场，服务端固定 `opening:<sessionId>` |
| `POST /api/sessions/:id/turns` | `{clientTurnId,content}`；相同键幂等，失败重试保留该键 |
| `GET /api/turns/:id` / `POST /api/turns/:id/cancel` | 断流恢复与显式停止 |
| `GET /api/worlds/:id` | owner 世界观察视图，实体、近期 episode、活动、时钟 |
| `PATCH /api/worlds/:id/scene` | `{expectedRevision,sessionId,scene}`；当前会话场景必须传 `sessionId` |
| `PATCH /api/worlds/:id/clock` | `{expectedRevision,mode,rate}`，不能伪造过去时间 |
| `PATCH /api/worlds/:id/events/:eventId` | `{expectedRevision,status:'retracted'|'active'}` |
| `GET /api/turns/:id/trace` | 有开发权限的真实调用记录 |
| `GET /api/dev/prompts` / `PUT /api/dev/prompts/:key` | 当前目录；以 `{content,expectedVersion}` 追加启用版本 |
| `POST /api/dev/agents/:key/test` | `{sessionId,userText,prompt,assistantText?}`，只试跑不提交 |
| `GET /api/dev/agent-catalog` | 原版 16 项只读归档及当前职责映射 |

SSE 事件名与 JSON `type` 一致。`accepted` 对账持久消息，`delta` 带发言角色/消息身份，只有 `committed` 才确认正式结果；`failed` / `cancelled` 为终态。EOF 不代表成功，前端会查询持久回合状态。切会话会取消旧流，旧回调不能污染新会话。

创建会话当前没有请求幂等键。网络中断可能发生在服务端创建完成之后；界面只刷新授权会话列表并提示核对，不自动重复创建。正式宿主若需要无感创建恢复，应补请求级幂等协议。

独立入口仅监听回环地址、使用本机身份，开发工具默认开启；可设 `ENABLE_DEVELOPER_TOOLS=false`。官方宿主必须注入 `authenticate` 与 `developer.authorize`，并保留每个世界/会话的 owner 校验。未传 developer 不开放开发 API。调试数据包含私密上下文，不能当公开日志。

## 数据、部署与验证

共 **10 张业务表 + 1 张迁移表**：`characters`、`worlds`、`sessions`、`turns`、`messages`、`events`、`agent_calls`、`agent_prompt_versions`、`world_entities`、`legacy_agent_catalog`，以及 `schema_migrations`。episode 和活动视图由成功回合与消息投影，不另复制无来源摘要。实体归世界；角色模板和原 Agent 档案对应用账号只读。

同世界回合通过 PG 行锁、运行回合唯一约束、revision 和 30 秒租约限制并发；模型请求在事务外，运行期间续租。进程中断后的过期回合在下一次读取或发送时处理；取消通过数据库信号收尾，没有后台自动重放业务任务。

策略、Prompt、模型适配和新世界编排均在 `roleplay-harness/apps/agentic-v3`；公共 Harness SDK、LLM、adapters 未改。部署须提供该应用构建产物、`build.json` 身份及运行依赖，用 `HARNESS_ROOT` 或 `HARNESS_MODULE_PATH` 指定位置。运行冻结模型、Prompt 版本和配置指纹，新版本用于后续调用。

`/health/live` 检查进程，`/health/ready` 检查数据库，不调用模型。上线需由官方部署补齐 TLS、SSE 代理超时、真实鉴权、开发权限、资源/费用配额及备份恢复演练；本地 Windows 备份脚本不等于跨平台托管恢复服务。

`npm run verify` 执行 Harness 构建、类型检查、业务测试及前端构建。PG 测试使用独立测试库随机 schema，只清理测试数据；自动测试不调用付费模型。Harness 协议测试在对应工程中运行，使用本地假 Kaon。真实调用次数、用量、浏览器路径和重启验证单独记录于 [VERIFICATION.md](VERIFICATION.md)。

旧 demo SQLite 迁移另有 `npm run db:import-sqlite -- <源路径>`，只读源文件、按 ID 幂等；它与旧 PostgreSQL 的卡片/Agent 目录导入不同。旧 V3 世界、聊天、分钟 tick 和后台任务未整体迁入。后续路线与当前限制见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。
