/**
 * dsh-bili-reply —— B站「@我的」自动回复 · DSH 插件（host 半端）
 * ============================================================================
 * 它是什么：把 `bilibili-reply` 技能（含看门狗 `tools/watch-at.ps1`）打包成一键安装的 DSH 插件。
 *
 * 插件做的事：
 *   1. **铺技能**：把 `assets/skill/` 里的技能资产复制到 `$DSH_HOME/skills/bilibili-reply`
 *      （用户自己的 `config.md` / `watch-at.config.ps1` / 日志 / 状态一律**不覆盖**）；
 *   2. **给工具**：状态 / 安装更新 / 计划任务 / 手动跑一次 / 看日志 —— 模型在对话里就能操作；
 *   3. **给 HTTP 接口**：`/api/bili-reply/*`，方便做设置页或脚本化（v0.1 暂无设置页）。
 *
 * 它**不**做的事（外部依赖，插件只检测并给指引）：
 *   - BrowserSkill（`bsk` CLI + 已登录 B站的浏览器）—— 读 @ 通知、发评论都靠它；
 *   - `video-watch` 技能（转写 + 抽帧）；
 *   - `dsh` CLI / PowerShell / python（看门狗要用）。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'bili-reply'

/** 只强依赖工具注册表；webServer 是**可选**的（headless 之类没有 HTTP 的 profile 也要能加载） */
export const inject = ['tools']

/**
 * 🔴 字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *（`volatileForm(schema)`）；另外 loader entry 的 id 必须等于本插件名（`bili-reply`）。
 */
export const Config = !z ? undefined : z.object({
  /** 插件加载时自动把技能铺到 `$DSH_HOME/skills/bilibili-reply`（缺什么补什么） */
  autoInstallSkill: z.boolean().default(true).extra('volatile', true),
  /** 技能文件跟着插件版本更新（会覆盖 SKILL.md / watch-at.ps1；用户配置与日志始终保留） */
  autoUpdateSkill: z.boolean().default(false).extra('volatile', true),
  /** 技能装到哪（留空 = `$DSH_HOME/skills/bilibili-reply`） */
  skillDir: z.string().default('').extra('volatile', true),
  /** Windows 计划任务名（要跟 watch-at.config.ps1 里的 $TaskName 一致才查得到状态） */
  taskName: z.string().default('DSH-BiliAtWatch').extra('volatile', true),
})

// 版本号从 package.json 读，避免两处不一致（踩过：包 0.1.1、marker 里写 0.1.0）
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version
  } catch { return '0.0.0' }
})()
const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = join(HERE, 'assets', 'skill')

/** 这些相对路径属于**用户**：插件永远不覆盖（配置、日志、运行状态、模型提示词、锁） */
const USER_OWNED = new Set([
  'config.md',
  'tools/watch-at.config.ps1',
  'tools/at-state.json',
  'tools/at-state.json.bak',
  'tools/prompt-last.txt',
  'tools/watch-at.log',
  'tools/replies.log',
  'tools/reply.lock',
])

export function apply(ctx, config) {
  // ⚠️ 宿主传进来的 config 里，值不保证是原始类型（实测 skillDir 会拿到一个对象）——
  //    配置一律先过类型守卫再拼路径，别直接 String(object)（会拼出 "[object Object]" 目录）。
  const asStr = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
  const asBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
  const raw = (config && typeof config === 'object') ? config : {}
  const cfg = {
    autoInstallSkill: asBool(raw.autoInstallSkill, true),
    autoUpdateSkill: asBool(raw.autoUpdateSkill, false),
    skillDir: asStr(raw.skillDir, ''),
    taskName: asStr(raw.taskName, 'DSH-BiliAtWatch'),
  }

  const log = (msg) => {
    try { ctx.logger?.info?.(String(msg)) } catch { /* 日志绝不能影响主流程 */ }
  }
  /** ⭐ 落一份自己的启动日志：宿主控制台看不到插件日志时，排障只看这个文件 */
  const bootLog = (msg) => {
    try {
      const d = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-reply')
      mkdirSync(d, { recursive: true })
      appendFileSync(join(d, 'boot.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
    } catch { /* 写不进去就算了 */ }
  }
  bootLog(`apply 开始（profile=${process.env.DSH_PROFILE || '?'} home=${process.env.DSH_HOME || '(default)'} cfgKeys=${Object.keys(raw).join(',')} skillDirType=${typeof raw.skillDir}）`)
  const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
  const skillDir = () => String(cfg.skillDir || '').trim() || join(dshHome(), 'skills', 'bilibili-reply')
  const toolsDir = () => join(skillDir(), 'tools')
  const scriptPath = () => join(toolsDir(), 'watch-at.ps1')
  const skillConfigPath = () => join(toolsDir(), 'watch-at.config.ps1')
  const markerPath = () => join(skillDir(), '.dsh-plugin.json')
  const isWindows = process.platform === 'win32'

  /* ─────────────── 资产：铺技能 ─────────────── */

  const walkAssets = (dir = ASSET_ROOT, out = []) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walkAssets(abs, out)
      else out.push(relative(ASSET_ROOT, abs).replace(/\\/g, '/'))
    }
    return out
  }

  const readMarker = () => {
    try { return JSON.parse(readFileSync(markerPath(), 'utf8')) } catch { return null }
  }

  /**
   * 铺技能：缺什么补什么；`force` 时连技能文件一起更新（用户配置 / 日志不动）。
   * @returns {{ok:boolean, dir:string, copied:string[], skipped:string[], error?:string}}
   */
  const installSkill = ({ force = false } = {}) => {
    const out = { ok: false, dir: skillDir(), copied: [], skipped: [] }
    try {
      const assets = walkAssets()
      if (assets.length === 0) { out.error = `插件包里没有技能资产（${ASSET_ROOT}）`; return out }
      for (const rel of assets) {
        const src = join(ASSET_ROOT, rel)
        const dst = join(skillDir(), rel)
        if (USER_OWNED.has(rel)) { out.skipped.push(rel); continue }
        const exists = existsSync(dst)
        if (exists && !force) { out.skipped.push(rel); continue }
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
        out.copied.push(rel)
      }
      writeFileSync(markerPath(), JSON.stringify({
        version: PLUGIN_VERSION,
        installedAt: new Date().toISOString(),
      }, null, 2) + '\n')
      out.ok = true
      if (out.copied.length) log(`bili-reply：技能已铺到 ${skillDir()}（${out.copied.length} 个文件）`)
    } catch (e) {
      out.error = String(e?.message ?? e)
    }
    return out
  }

  /* ─────────────── 看门狗：查状态 / 跑一次 / 计划任务 ─────────────── */

  const exec = (cmd, args, { timeout = 120000 } = {}) => new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      resolve({ code: -1, output: String(e?.message ?? e) })
      return
    }
    let output = ''
    const add = (b) => { output += String(b); if (output.length > 200000) output = output.slice(-100000) }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeout)
    try { timer.unref?.() } catch { /* 老 node */ }
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e?.message ?? e) }) })
  })

  const runWatch = (args = [], timeout = 180000) => {
    if (!isWindows) return Promise.resolve({ ok: false, error: '看门狗是 PowerShell 脚本，目前只支持 Windows' })
    if (!existsSync(scriptPath())) {
      return Promise.resolve({ ok: false, error: `技能还没装好：找不到 ${scriptPath()}（先 bili_reply_install）` })
    }
    return exec('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), ...args,
    ], { timeout }).then((r) => ({ ok: r.code === 0, code: r.code, output: r.output.slice(-4000) }))
  }

  const taskInstalled = () => {
    if (!isWindows) return null
    try {
      const r = spawnSync('schtasks.exe', ['/Query', '/TN', cfg.taskName], { windowsHide: true })
      return r.status === 0
    } catch { return null }
  }

  const tail = (file, lines) => {
    try {
      const text = readFileSync(file, 'utf8')
      return text.split(/\r?\n/).slice(-Math.max(1, lines)).join('\n')
    } catch { return '' }
  }

  const status = () => {
    const dir = skillDir()
    const marker = readMarker()
    const result = {
      ok: true,
      pluginVersion: PLUGIN_VERSION,
      skillDir: dir,
      skillInstalled: existsSync(join(dir, 'SKILL.md')),
      skillVersion: marker?.version ?? null,
      skillUpdatedAt: marker?.installedAt ?? null,
      files: {
        script: existsSync(scriptPath()),
        userConfig: existsSync(skillConfigPath()),
        promptTemplate: existsSync(join(toolsDir(), 'prompt-last.txt')),
      },
      deps: {
        platform: process.platform,
        videoWatch: existsSync(join(dshHome(), 'skills', 'video-watch', 'SKILL.md')),
        task: taskInstalled(),
      },
      lastWatchLog: tail(join(toolsDir(), 'watch-at.log'), 12),
      lastReplies: tail(join(toolsDir(), 'replies.log'), 6),
      hints: [],
    }
    if (!result.files.userConfig) result.hints.push('还没填配置：把 tools/watch-at.config.example.ps1 复制成 tools/watch-at.config.ps1 再填 $OwnerMid / $SelfMid')
    if (!result.deps.videoWatch) result.hints.push('没装 video-watch 技能（看视频要用）：见 README「前置条件」')
    if (result.deps.task === false) result.hints.push('计划任务还没装：装好配置后执行 bili_reply_task(install)，或手动 .\\watch-at.ps1 -InstallTask')
    return result
  }

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  /** 宿主只吃无损 JSON：函数 / 循环引用 / 类实例都会报 value is not lossless JSON */
  const safe = (v) => {
    try { return JSON.parse(JSON.stringify(v)) } catch { return { ok: false, error: '返回值无法序列化为 JSON' } }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, execCtx) { return safe(await spec.execute(args, execCtx)) },
  }))

  tool({
    name: 'bili_reply_status',
    description: 'B站「@我的」自动回复插件的状态：技能装没装、配置填没填、计划任务在不在、看门狗最近日志。',
    parameters: {},
    execute: () => status(),
  })

  tool({
    name: 'bili_reply_install',
    description: '把插件内置的 bilibili-reply 技能铺到 ~/.dsh/skills/bilibili-reply（或更新）。\n'
      + '用户自己的 config.md / watch-at.config.ps1 / 日志不会被覆盖。',
    // ⚠️ DSH 的 defineTool 吃的是「参数名 → 值 schema spec」的映射（不是完整 JSON Schema）
    parameters: {
      force: { type: 'boolean', description: 'true = 连技能文件（SKILL.md、watch-at.ps1…）一起更新；默认只补缺文件' },
    },
    execute: (args = {}) => installSkill({ force: Boolean(args.force) }),
  })

  tool({
    name: 'bili_reply_task',
    description: 'Windows 计划任务：status=查在不在 / install=装（每 1 分钟，脚本内 30 秒补检）/ remove=删。'
      + '装任务前要先填好 tools/watch-at.config.ps1。',
    parameters: {
      action: { type: 'string', description: 'status=查在不在 / install=装（每 1 分钟 + 脚本内 30 秒补检）/ remove=删' },
    },
    async execute(args = {}) {
      const action = String(args.action || 'status')
      if (!isWindows) return { ok: false, error: '计划任务只有 Windows 有；其他系统请自己用 cron / systemd 定时跑 watch-at.ps1' }
      if (action === 'status') return { ok: true, taskName: cfg.taskName, installed: taskInstalled() }
      if (action === 'install') {
        const r = await runWatch(['-InstallTask'], 60000)
        return { ...r, taskName: cfg.taskName, installed: taskInstalled() }
      }
      if (action === 'remove') {
        const r = await exec('schtasks.exe', ['/Delete', '/TN', cfg.taskName, '/F'], { timeout: 30000 })
        return { ok: r.code === 0, code: r.code, output: r.output.slice(-1000), installed: taskInstalled() }
      }
      return { ok: false, error: `未知 action：${action}` }
    },
  })

  tool({
    name: 'bili_reply_run',
    description: '手动跑一次看门狗。mode：check=查一遍（默认只通知不回复）/ noreply=只看不回复 / init=把当前最新一条设为基准（历史不处理）/ '
      + 'test=给通知通道发测试消息 / status=打印脚本自己的状态。',
    parameters: {
      mode: { type: 'string', description: 'check（默认，只通知不回复）/ noreply / init（设基准）/ test（测通知通道）/ status' },
    },
    execute(args = {}) {
      const mode = String(args.mode || 'check')
      const flags = {
        check: ['-NoReply'],
        noreply: ['-NoReply'],
        init: ['-Init'],
        test: ['-Test'],
        status: ['-ShowStatus'],
      }[mode]
      if (!flags) return { ok: false, error: `未知 mode：${mode}` }
      return runWatch(flags)
    },
  })

  tool({
    name: 'bili_reply_log',
    description: '查看看门狗的日志尾巴（which=watch 运行日志 / replies 回复存档）。排障用。',
    parameters: {
      which: { type: 'string', description: 'watch=运行日志（默认）/ replies=回复存档' },
      lines: { type: 'number', description: '看多少行（默认 40，最多 400）' },
    },
    execute(args = {}) {
      const which = String(args.which || 'watch')
      const lines = Math.max(1, Math.min(Number(args.lines) || 40, 400))
      const file = which === 'replies'
        ? join(toolsDir(), 'replies.log')
        : join(toolsDir(), 'watch-at.log')
      return { ok: existsSync(file), file, lines, text: tail(file, lines) }
    },
  })

  /* ─────────────── HTTP 接口（设置页 / 脚本化都走这里） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-reply/status') return sendJson(res, 200, status())
    if (req.method === 'POST' && path === '/api/bili-reply/install') {
      return sendJson(res, 200, installSkill({ force: /[?&]force=1/.test(url.search) }))
    }
    if (req.method === 'POST' && path === '/api/bili-reply/task') {
      const action = url.searchParams.get('action') || 'status'
      if (!isWindows) return sendJson(res, 200, { ok: false, error: 'only windows' })
      if (action === 'status') return sendJson(res, 200, { ok: true, taskName: cfg.taskName, installed: taskInstalled() })
      if (action === 'install') return sendJson(res, 200, { ...(await runWatch(['-InstallTask'], 60000)), installed: taskInstalled() })
      if (action === 'remove') {
        const r = await exec('schtasks.exe', ['/Delete', '/TN', cfg.taskName, '/F'], { timeout: 30000 })
        return sendJson(res, 200, { ok: r.code === 0, output: r.output.slice(-1000), installed: taskInstalled() })
      }
      return sendJson(res, 400, { ok: false, error: 'unknown action' })
    }
    if (req.method === 'GET' && path === '/api/bili-reply/log') {
      const which = url.searchParams.get('which') || 'watch'
      const lines = Math.max(1, Math.min(Number(url.searchParams.get('lines')) || 40, 400))
      const file = which === 'replies' ? join(toolsDir(), 'replies.log') : join(toolsDir(), 'watch-at.log')
      return sendJson(res, 200, { ok: existsSync(file), file, text: tail(file, lines) })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  // ⭐ webServer 是**可选**的：有就注册 HTTP 接口；headless 这类没有 HTTP 的 profile 就跳过（不然整条插件不激活）
  try {
    const web = (typeof ctx.get === 'function' ? ctx.get('webServer') : null) || ctx.webServer
    if (web && typeof web.register === 'function') {
      ctx.effect(() => web.register({
        kind: 'prefix',
        path: '/api/bili-reply',
        handler: async (req, res) => {
          try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
            try { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch { /* 连接已断 */ }
          }
        },
      }), 'bili-reply: /api/bili-reply 路由')
    } else {
      log('bili-reply：这个 profile 没有 webServer，跳过 /api/bili-reply 路由（工具照常可用）')
    }
  } catch (e) {
    log(`bili-reply：注册 HTTP 路由失败（不影响工具）—— ${e?.message ?? e}`)
  }

  /* ─────────────── 加载时：铺技能 ─────────────── */

  try {
    if (cfg.autoInstallSkill !== false) {
      const marker = readMarker()
      // 每次加载都跑一遍「缺什么补什么」（很便宜），顺便写版本标记；
      // 只有开了 autoUpdateSkill 且版本变了才覆盖技能文件
      const force = cfg.autoUpdateSkill === true && marker?.version !== PLUGIN_VERSION
      const r = installSkill({ force })
      bootLog(`install: ${JSON.stringify(r)}`)
      if (!r.ok) log(`bili-reply：铺技能失败 —— ${r.error}`)
    }
  } catch (e) {
    log(`bili-reply：铺技能异常（插件照常加载）—— ${e?.message ?? e}`)
  }

  bootLog('apply 完成（工具已注册）')
  log(`dsh-bili-reply 已挂载（技能目录 ${skillDir()}）`)
}
