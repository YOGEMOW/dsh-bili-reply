/**
 * selfcheck.mjs —— 不装插件也能跑的冒烟测试
 *   node selfcheck.mjs
 * 检查：技能资产齐不齐 / 插件能加载 / 工具注册 5 个 / 能把技能铺到临时目录 / 用户配置不被覆盖
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const problems = []
const check = (cond, msg) => { if (!cond) problems.push(msg) }

// 1) 技能资产
const ASSETS = [
  'SKILL.md',
  'config.example.md',
  'README.md',
  'LICENSE',
  'tools/watch-at.ps1',
  'tools/watch-at.config.example.ps1',
  'tools/README.md',
]
for (const f of ASSETS) check(existsSync(join(HERE, 'assets', 'skill', f)), `缺少技能资产：assets/skill/${f}`)

// 2) 插件能加载 + 工具注册
const { apply } = await import('./index.js')
const tools = []
const ctx = {
  logger: { info() {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: () => () => {} },
  effect: (fn) => {
    const d = fn()
    return () => { if (typeof d === 'function') d() }
  },
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-reply-'))
try {
  apply(ctx, { skillDir: tmp, autoInstallSkill: true })
  check(tools.length === 5, `工具数量应为 5，实际 ${tools.length}`)
  check(existsSync(join(tmp, 'SKILL.md')), '技能没有铺出来（缺 SKILL.md）')
  check(existsSync(join(tmp, 'tools', 'watch-at.ps1')), '技能没有铺出来（缺 tools/watch-at.ps1）')
  check(!existsSync(join(tmp, 'tools', 'watch-at.config.ps1')), '不该自动生成用户配置（应由用户复制 example 后自己填）')

  // 用户文件保护
  writeFileSync(join(tmp, 'tools', 'watch-at.config.ps1'), '# mine\n')
  writeFileSync(join(tmp, 'config.md'), '# my config\n')
  apply(ctx, { skillDir: tmp, autoInstallSkill: true })
  check(readFileSync(join(tmp, 'tools', 'watch-at.config.ps1'), 'utf8') === '# mine\n', '用户配置 tools/watch-at.config.ps1 被覆盖了')
  check(readFileSync(join(tmp, 'config.md'), 'utf8') === '# my config\n', '用户配置 config.md 被覆盖了')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (problems.length) {
  console.error('selfcheck FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('selfcheck OK：资产齐全 · 插件可加载 · 工具 5 个 · 技能可铺装 · 用户配置受保护')
