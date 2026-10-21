# dsh-bili-reply

> DeepSeek Harness（DSH）插件：把 **B站「@我的」自动回复** 这套能力（技能 + 看门狗脚本）打包成一键安装。
>
> 别人 @ 你 → 看门狗发现 → AI 用 `video-watch` 读懂视频 → 写一条评论 → 在「@我的」里回复 → 匿名复查是否真的公开可见。

**一句话安装**：

```powershell
dsh plugin --profile desktop add github:YOGEMOW/dsh-bili-reply
```

装完重启 DSH，技能会落到 `~/.dsh/skills/bilibili-reply`，对话里就能用 `bili_reply_*` 工具。

---

## 前置条件（缺一样都跑不起来）

| 依赖 | 用途 | 怎么装 |
|---|---|---|
| **DSH**（桌面版或 web） | 宿主 | 你已经有了 🙂 |
| **BrowserSkill** | 读 @ 通知、发评论、复查可见性 —— **最关键** | 见 [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) 的 README。两种形态按需选：**对话里**装 DSH 插件 `@wxg-prc-cpg/browser-skill-dsh-plugin`（`bsk_*` 工具，先用 `/browser-skill` 激活）；**后台自动回复**只用 `bsk` CLI 就够（看门狗走这条）。两条腿都要求浏览器里登录着 B站 |
| **`video-watch` 技能** | 把视频转成带时间戳的文字稿 + 抽帧 | 放到 `~/.dsh/skills/video-watch`（含 `SKILL.md` / `scripts/` / `vw.py`） |
| **Python 3.10+** | `video-watch` 转写（faster-whisper / yt-dlp） | 见 video-watch 的 README |
| **PowerShell 5.1+（Windows）** | 看门狗脚本 | Windows 自带；**看门狗目前只支持 Windows** |
| **一个 B 站账号** | 执行回复（建议用小号） | 在浏览器里登录它 |

> 插件本身只检测这些依赖、给指引，不会替你安装第三方工具。

## 安装

```powershell
# GitHub 直装（推荐）
dsh plugin --profile desktop add github:YOGEMOW/dsh-bili-reply

# 本地开发
dsh plugin --profile desktop add link:D:\path\to\dsh-bili-reply
```

然后**重启 DSH**。启动日志里会看到：

```
dsh-bili-reply 已挂载（技能目录 C:\Users\<你>\.dsh\skills\bilibili-reply）
```

## 配置（两步）

### 1. 技能身份（`config.md`）

```powershell
cd $env:USERPROFILE\.dsh\skills\bilibili-reply
Copy-Item config.example.md config.md
```

填 `owner_name`（发 @ 的人）、`self_name` / `self_uid`（机器人账号）。取值方法见 `config.example.md`。

### 2. 看门狗（`tools/watch-at.config.ps1`）

```powershell
cd $env:USERPROFILE\.dsh\skills\bilibili-reply\tools
Copy-Item watch-at.config.example.ps1 watch-at.config.ps1
```

至少要改：

```powershell
$Bsk      = "C:\path\to\bsk.exe"       # BrowserSkill CLI
$Dsh      = "C:\path\to\dsh.cmd"       # DSH CLI
$Py       = "C:\path\to\python.exe"    # 跑 video-watch 的 python
$OwnerMid = 350649481                  # 你的 B站 UID（发 @ 的人）
$SelfMid  = 3747572818643757           # 机器人账号 UID（被 @ 的那个）
```

> 这两个 UID 是**白名单**：只回 `OwnerMid` 发、且 @ 的是 `SelfMid` 的通知。群里一次 @ 一串人的通知会被丢掉。

## 用法

### 对话里（模型工具）

| 工具 | 作用 |
|---|---|
| `bili_reply_status` | 技能装没装、配置填没填、计划任务在不在、看门狗最近日志 |
| `bili_reply_install` | 把插件内置技能铺到 `~/.dsh/skills/bilibili-reply`（`force:true` = 连技能文件一起更新） |
| `bili_reply_task` | `status` / `install` / `remove` 计划任务 |
| `bili_reply_run` | 手动跑一次：`check`（默认只通知）、`init`（设基准）、`test`（测试通知通道）、`status` |
| `bili_reply_log` | 看 `watch-at.log` / `replies.log` 尾巴 |

直接说人话也行，例如：

> 「看看 B站 @ 我那条，回一下」
> 「把看门狗的计划任务装上」
> 「B站回复这套现在什么状态？」

### 手动（不用模型）

```powershell
cd $env:USERPROFILE\.dsh\skills\bilibili-reply\tools

.\watch-at.ps1 -Init          # 首次接入：把当前最新一条设为基准（历史积压不处理）
.\watch-at.ps1 -Test          # 给通知通道发条测试消息
.\watch-at.ps1 -InstallTask   # 装计划任务（每 1 分钟 + 脚本内 30 秒补检）
.\watch-at.ps1 -ShowStatus    # 看状态 / 最近日志 / 最近回复
.\watch-at.ps1 -NoReply       # 手动跑一轮，只通知不回复
```

### HTTP 接口（设置页 / 脚本化）

```
GET  /api/bili-reply/status
POST /api/bili-reply/install[?force=1]
POST /api/bili-reply/task?action=status|install|remove
GET  /api/bili-reply/log?which=watch|replies&lines=40
```

## 工作方式（看门狗）

```
① 检查（0 token）   bsk 在登录着的浏览器里 fetch /x/msgfeed/at
② 白名单筛选        user.mid == OwnerMid 且 at_details 含 SelfMid
③ 有新 @            抓最旧的那一条（一次只回一条，多条自动排队）
④ 看视频            video-watch：下载 → 转写；歌曲类自动 --no-vad
⑤ 写评论            dsh --profile headless 按 prompt-last.txt 写一条
⑥ 发出去            先切到那条视频页（Referer 要对）再 POST /x/v2/reply/add
⑦ 复查可见性        匿名请求再拉一次，看不到就判失败（防影子隐藏）
⑧ 收尾              标签页回首页，通知通道告诉主人回了什么
```

细节（节拍 / 阈值 / 踩过的坑）见技能里的 `tools/README.md`。

## 目录结构

```
dsh-bili-reply/
├─ index.js              # host 插件：铺技能 + 注册工具 + HTTP 接口
├─ cordis.patch.yml      # DSH bundle patch（插件自带挂载声明）
├─ lib/hostdeps.mjs      # 从宿主树取 schemastery / dsh-tools（拿不到就降级）
└─ assets/skill/         # 技能资产（会铺到 ~/.dsh/skills/bilibili-reply）
   ├─ SKILL.md
   ├─ config.example.md
   ├─ README.md / README.en.md
   ├─ examples/
   └─ tools/
      ├─ watch-at.ps1
      ├─ watch-at.config.example.ps1
      └─ README.md
```

**插件升级时**：用户自己的 `config.md`、`tools/watch-at.config.ps1`、日志、`at-state.json`、`prompt-last.txt` 永远不覆盖；只有缺的文件会自动补，或者在插件配置里开 `autoUpdateSkill` 才更新技能文件。

## 安全与边界

- 它会**以你的身份在公开评论区发言**。建议用小号，自己确认内容得体。
- **不要在一条视频下连发多条**，也不要批量刷（B站风控会弹验证码 / 返回 `-352`）。
- 看门狗每轮只回**最旧的一条**，两次回复默认至少隔 3 分钟，超过 60 分钟的视频只通知不自动回。
- 浏览器必须开着且登录着；没开只写日志，不会误报。
- 关机/睡眠期间的 @ 会在下次开机后按游标补上（一次一条）。

## 跨平台

- 技能本身（读 @、看视频、写评论）跟平台无关；
- **看门狗是 PowerShell 脚本，目前只支持 Windows**（计划任务 + `schtasks`）。Linux/macOS 可以自己用 cron/systemd 定时跑 `watch-at.ps1`（需要 pwsh 7）。

## 常见问题

| 现象 | 处理 |
|---|---|
| `bili_reply_status` 说没装技能 | 在对话里说「装一下 B站回复技能」，或 `bili_reply_install` |
| 计划任务装了但没动静 | 浏览器没开 / 没登录 / `bsk` 路径不对：看 `bili_reply_log` |
| 接口取不到数据 | 登录态过期，重新登录 B站 |
| 转写 0 段 | 歌曲/纯音乐：技能里会自动 `--no-vad` 重跑 |
| 评论发了但别人看不到 | 影子隐藏：脚本会用匿名请求复查，失败会告警并重试（不要连发） |

## 许可

MIT。技能内容与看门狗脚本同为本项目的一部分；`assets/skill/LICENSE` 保持原样。

## 路线图

- [ ] 设置页（现在靠对话工具 / DSH 原生设置页改插件配置）
- [ ] 非 Windows 的计划任务安装助手（cron / systemd --user）
- [ ] 把 `video-watch` 作为可选依赖一键检测/安装
