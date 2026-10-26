#!/usr/bin/env node
/**
 * s0-verify.mjs —— S0 运行态验收（sol 第三次复审剩余项）
 *
 * 回答两个问题，输出 PASS / FAIL，不做任何写操作：
 *
 *   ① 补丁写入后有没有过一次真实重启？
 *      判据：探针最后一条 result 记录的时间 > cordis.patch.yml 的 mtime。
 *      （补丁是 load-time 生效的，探针记录是运行时才写的——
 *        时间在后，才说明这次运行是在补上 disabled: true 之后启动的。）
 *
 *   ② 接管者身份与阈值对不对？
 *      判据：最新 result 记录里
 *        ctor === 'YanqingCompaction'
 *        configValues.thresholdRatio === 0.7   （用户 10-14 亲调的遗忘速度）
 *        configValues.retainRatio    === 0.16
 *
 * 附带：在常见 DSH 日志位置里找 `did not activate` /
 *       `has been registered` 这两条告警，找到就列出来（人工复核用）。
 *
 * 用法：node tools/s0-verify.mjs
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const PATCH = join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const PROBE = join(tmpdir(), 'dsh-s0-config-probe.log')

const line = (s = '') => console.log(s)
let bad = 0

/* ── 读探针日志，取最后一条 result ── */
function latestProbe() {
  if (!existsSync(PROBE)) return null
  const rows = readFileSync(PROBE, 'utf8').trim().split('\n').filter(Boolean)
  let last = null
  for (const r of rows) {
    const i = r.indexOf('{')
    if (i < 0) continue
    try {
      const o = JSON.parse(r.slice(i))
      if (o.phase === 'result') last = { at: r.slice(0, i).trim(), ...o }
    } catch { /* 残行跳过 */ }
  }
  return last
}

line('══════════ S0 运行态验收 ══════════')
line()

/* ── ① 重启时间证据 ── */
line('【① 补丁写入后是否重启过】')
if (!existsSync(PATCH)) {
  line('  ✗ 找不到补丁文件: ' + PATCH)
  bad++
} else {
  const pt = statSync(PATCH).mtime
  line('  补丁写入时间: ' + pt.toISOString())
  const p = latestProbe()
  if (!p) {
    line('  ✗ 探针日志里没有 result 记录')
    bad++
  } else {
    const at = new Date(p.at)
    line('  探针最新记录: ' + at.toISOString())
    if (at.getTime() > pt.getTime()) {
      line('  ✓ PASS 运行发生在补丁之后')
    } else {
      const gapMin = Math.round((pt.getTime() - at.getTime()) / 60000)
      line('  ✗ FAIL 探针记录早于补丁 ' + gapMin + ' 分钟（还是旧实例）')
      bad++
    }
  }
}
line()

/* ── ② 身份与阈值 ── */
line('【② 接管者身份与阈值】')
const p = latestProbe()
if (!p) {
  line('  ✗ 无记录可判')
  bad++
} else {
  const checks = [
    ['ctor', p.ctor, 'YanqingCompaction'],
    ['thresholdRatio', p.configValues?.thresholdRatio, 0.7],
    ['retainRatio', p.configValues?.retainRatio, 0.16],
  ]
  for (const [name, got, want] of checks) {
    const okPass = got === want
    line(`  ${okPass ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}${okPass ? '' : ' （期望 ' + JSON.stringify(want) + '）'}`)
    if (!okPass) bad++
  }
  if (p.chain) line(`  — chain: ${JSON.stringify(p.chain)}`)
  if (p.overrides) line(`  — overrides: ${JSON.stringify(p.overrides)}`)
}
line()

/* ── ③ 扫启动告警 ── */
line('【③ 启动告警扫描（人工复核）】')
const dirs = [
  join(HOME, 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'logs'),
  join(DSH_HOME, 'logs'),
]
let found = 0
for (const d of dirs) {
  if (!existsSync(d)) { line('  · 不存在: ' + d); continue }
  for (const f of readdirSync(d)) {
    if (!/\.(log|txt)$/i.test(f)) continue
    const fp = join(d, f)
    try {
      const t = readFileSync(fp, 'utf8')
      for (const m of t.matchAll(/^.*(did not activate|has been registered at).*$/gm)) {
        line('  ⚠ ' + f + ': ' + m[0].trim().slice(0, 160))
        found++
      }
    } catch { /* 读不动跳过 */ }
  }
}
if (found === 0) line('  ✓ 常见日志位置未发现激活告警')
line()

line('═══════════════════════════════')
line(bad === 0 ? '结论：两项均通过 → S0-S3 完成，可开始 S4 观测期' : `结论：${bad} 项未通过 → 暂不放行 S4`)
if (bad > 0) process.exitCode = 1
