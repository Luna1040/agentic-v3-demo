# 多人物角色卡与旧数据修复

角色卡是作者内容和会话目录，不等于恰好一位 NPC。一张卡有多人时，导入阶段提供经过审核的 `characters.source.cast`：

```json
{
  "version": 1,
  "sharedBackground": "这里只放共同背景，不合并个人秘密。",
  "members": [
    {"key":"owner","name":"乔安","description":"店主","personality":"谨慎","aliases":["Joan"]},
    {"key":"baker","name":"麦芮","description":"烘焙师","personality":"开朗","aliases":["Mary"]}
  ]
}
```

仅显式结构化资料触发拆分，不用标题分隔符或临时对话猜人数。支持 2–6 人，首成员必须初始在场；其他成员可设置 `presentAtStart:false`。首人沿用根卡 ID 兼容会话和历史来源；其他人使用由卡 ID 与成员 key 派生的稳定 ID。会话目录仍显示卡标题，每位 NPC 独立保存身份、personality、记忆与位置。前台 Actor 仍只发起一次流式请求、生成一条场景消息。

已有世界不会在一次普通读取中自动改写。维护人员应先备份并暂停服务，审核卡成员与旧公开经历，再运行：

```sh
node --env-file=/private/migration.env --import tsx scripts/repair-authored-world.ts /private/reviewed-repair.json
```

修复 JSON 必须给出 `ownerId/worldId/expectedRevision/cast`。可选 `sharedMemory:{summary,sourceTurnIds}` 只接受本世界已提交、原角色参与的轮次，summary 最多 240 字；人工审核只保留共同公开经历，不把旧合并记录直接复制为两人的私人记忆。旧合并摘要和原聊天仍存档；记忆投影设置拆分边界，防止旧合并日志重新覆盖首人的独立摘要。

可选 `itemIntents` 每项提供 `name/summary/sourceTurnId/quote`，用于明确的历史选择漏记修复；quote 必须是该轮玩家原文且含物品名。只补计划事件及 `pendingIntent`，不写入已持有、已送达或已完成。`sharedEntityIds` 仅供显式审核过的共同场景实体补充知情关系，来源必须在审核轮次中，不广播整个世界档案。维护操作不会触发模型，不能用于自动推断玩家未做的事。

正常后台 WorldOps 现在可直接为尚未完成的具体物品创建实体，已选事项保存在 `state.pendingIntent`，实际持有人和地点继续独立保存。闲聊、补充口味或配菜不应把已选主菜重置；后续实际完成仍需要证据并复用同一实体。原文和模型提案保留用于排查语义漏提取；不能保证小模型永不遗漏。
