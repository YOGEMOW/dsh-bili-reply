# Changelog

## 0.1.2 — 2026-10-22

**修（真实宿主上跑出来的问题）**

- **工具参数 schema 形态不对**：DSH 的 `defineTool` 要的是「参数名 → 值 schema spec」的映射，
  我们原来传的是完整 JSON Schema（`{type:'object', properties:{...}}`）⇒ 激活时抛
  `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`，
  整条插件不激活。5 个工具全改成映射形态。
- **配置值类型守卫**：宿主传进来的 config 里 `skillDir` 可能不是字符串（实测是对象），
  直接用会拼出 `[object Object]` 目录。改成 `asStr/asBool` 守卫。
- **webServer 改成可选**：`inject` 只留 `tools`，没有 HTTP 的 profile（headless）也能加载；
  有 webServer 才注册 `/api/bili-reply/*`。
- **每次加载都补技能**（原来只在缺 SKILL.md 时才铺，导致版本 marker 永远不写）；
  版本号改成从 `package.json` 读，避免两处不一致。
- 新增 `~/.dsh/bili-reply/boot.log`：宿主控制台看不到插件日志时靠它排障。
## 0.1.1 — 2026-10-21

**修（文档同步）**

- BrowserSkill **0.3.3** 起把工具名从 `browser_*` 改成了 `bsk_*`；技能文档 `SKILL.md` / `README.md` / `README.en.md`
  里的示例改用新名，并补了「两种形态」说明：
  **对话里**用 `bsk_*` 工具（需 DSH 插件 `@wxg-prc-cpg/browser-skill-dsh-plugin`）、
  **后台自动回复**看门狗直接调 `bsk` CLI（不需要 DSH 插件）。
- 插件 README 的「前置条件」同步说明两种形态。
- 关闭 [#1](https://github.com/YOGEMOW/dsh-bili-reply/issues/1)。
## 0.1.0 — 2026-10-21

首个版本：把 `bilibili-reply` 技能（含看门狗 `tools/watch-at.ps1`）打包成 DSH 插件。

**新**

- 插件加载时自动把技能铺到 `$DSH_HOME/skills/bilibili-reply`（缺什么补什么；用户配置 / 日志 / 运行状态永不覆盖）。
- 5 个工具：`bili_reply_status` / `bili_reply_install` / `bili_reply_task` / `bili_reply_run` / `bili_reply_log`。
- HTTP 接口：`/api/bili-reply/{status,install,task,log}`。
- 插件配置项（DSH 原生设置页可改）：`autoInstallSkill` / `autoUpdateSkill` / `skillDir` / `taskName`。
- `node selfcheck.mjs` 冒烟测试：资产、加载、工具注册、铺装、用户配置保护。

**已知限制**

- 看门狗依赖 PowerShell + Windows 计划任务，目前只支持 Windows。
- 无设置页（v0.1 用对话工具 / DSH 原生设置页）。
- `video-watch` / BrowserSkill（`bsk`）是外部依赖，插件只检测并给指引。
