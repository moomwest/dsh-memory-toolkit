/**
 * test/purify-shadow-integration.mjs —— 影子管道端到端集成测试（sol 复审③整改验收）
 *
 * 与 purify-shadow-cursor.mjs（纯函数单测）互补：这里造**真实 zstd 会话文件**，
 * 真跑 `node tools/purify-shadow.mjs --once`，从外部观察影子日志行数变化，
 * 验证"文件被替换/回滚/重写后不会漏处理"。
 *
 * 六个场景（I1-I6）：
 *   I1 首次全量            → 2 条
 *   I2 无变化再跑          → 0 条（cursor 生效，且不重复写影子日志）
 *   I3 正常追加 seq3       → 1 条（增量）
 *   I4 同尺寸替换（尾变）  → ★全量重扫 3 条（原实现漏判）
 *   I5 回滚+重追加（锚丢）  → ★全量重扫（原实现漏判）
 *   I6 中段改写（seq1 内容变、seq2 不变、size 变大）
 *                          → ★只重扫 seq1（内容感知身份，原实现漏判）
 *
 * 隔离：全部落在 mkdtemp 临时目录，env 覆盖 DSH_HOME / INTERCOM_SESSIONS，
 *       不动真实 ~/.dsh 的会话与影子日志。
 *
 * 跑法：node test/purify-shadow-integration.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const TOOL = new URL('../tools/purify-shadow.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PYTHON = process.env.PURIFY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

/* ── 前置探测：没有可用的 python + zstandard 就整体跳过，不判红 ──
 * 本文件要造真实 zstd 会话文件，必须有 python 侧支持。开箱环境不该因为
 * 「没装 zstandard」而红 —— 这正是 README 承诺的「未设置环境变量时自动跳过」。
 * 要让本文件真跑：PURIFY_PYTHON=<装好 zstandard 的解释器> node test/purify-shadow-integration.mjs
 */
{
  const probe = spawnSync(PYTHON, ['-c', 'import zstandard'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.log(`skip: 没有可用的 python + zstandard（PURIFY_PYTHON=${process.env.PURIFY_PYTHON || '(未设)'}）`)
    process.exit(0)
  }
}

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('ok   ' + name) }
  else { fail++; console.log('FAIL ' + name) }
}

/* ── 造真实 zstd 会话文件 ── */
function writeSession(file, summaries) {
  const lines = summaries.map(([seq, text]) => JSON.stringify({
    type: 'compaction/summary', seq,
    data: { summary: [{ type: 'text', text }] },
  }))
  const plain = lines.join('\n') + '\n'
  const tmpPlain = file + '.plain'
  writeFileSync(tmpPlain, plain, 'utf8')
  const r = spawnSync(PYTHON, ['-c',
    'import sys,zstandard,io;' +
    'src=open(sys.argv[1],"rb").read();' +
    'open(sys.argv[2],"wb").write(zstandard.ZstdCompressor().compress(src))',
    tmpPlain, file])
  rmSync(tmpPlain, { force: true })
  if (r.status !== 0) throw new Error('zstd 压缩失败: ' + (r.stderr || '').toString())
}

const A = 'alpha 摘要：端口 8080 与 3001 各自独立，互不合并。'
const B = 'bravo 摘要：git status --short 与 --short. 是两条不同命令，不能吞。'
const C = 'charlie 摘要：约束行必须整行保留，净化器不得制造反向语义。'
const A2 = 'alpha 摘要【已改写】：端口 8080 与 3001 已确认合并为单一入口。'
const B2 = 'bravo 摘要【已改写】：--short 与 --short. 现已统一处理。'

const home = mkdtempSync(join(tmpdir(), 'purify-shadow-it-'))
const sessDir = join(home, 'sessions', 'bucket-test', 'session-abcdef12-test')
mkdirSync(sessDir, { recursive: true })
const sf = join(sessDir, 'session.v4.jsonl.zstd')
const shadow = join(home, 'compaction-purify-shadow.jsonl')

const env = { ...process.env, DSH_HOME: home, INTERCOM_SESSIONS: join(home, 'sessions') }

function runOnce() {
  const r = spawnSync(process.execPath, [TOOL, '--once'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) console.log('  [stderr]', (r.stderr || '').slice(0, 500))
  return (r.stdout || '')
}
function shadowRows() {
  if (!existsSync(shadow)) return []
  return readFileSync(shadow, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function cleanup() { try { rmSync(home, { recursive: true, force: true }) } catch {} }

try {
  console.log('I1 首次全量')
  writeSession(sf, [[1, A], [2, B]])
  let out = runOnce()
  ok(/新摘要 2 条/.test(out), '2 条摘要被处理')
  ok(shadowRows().length === 2, '影子日志 2 行')

  console.log('I2 无变化再跑（cursor 生效）')
  out = runOnce()
  ok(shadowRows().length === 2, '★不重复处理（影子日志仍 2 行）')
  ok(!/重置/.test(out), '  未误判为替换/回滚')

  console.log('I3 正常追加 seq3')
  writeSession(sf, [[1, A], [2, B], [3, C]])
  out = runOnce()
  ok(/新摘要 1 条/.test(out), '★只处理新增的 1 条（增量生效）')
  ok(shadowRows().length === 3, '影子日志 3 行')

  console.log('I4 同尺寸替换（size 不变、尾指纹变）')
  // 造等长不同内容：A2 与 A 等长需人工配平——用占位串补齐到与 [1,A],[2,B] 总长一致
  const base = [JSON.stringify({ type: 'compaction/summary', seq: 1, data: { summary: [{ type: 'text', text: A }] } }),
    JSON.stringify({ type: 'compaction/summary', seq: 2, data: { summary: [{ type: 'text', text: B }] } })]
  const baseLen = base.join('\n').length + 1
  const repl = [JSON.stringify({ type: 'compaction/summary', seq: 1, data: { summary: [{ type: 'text', text: A2 }] } }),
    JSON.stringify({ type: 'compaction/summary', seq: 2, data: { summary: [{ type: 'text', text: B2 }] } })]
  let replJoined = repl.join('\n') + '\n'
  const pad = baseLen - replJoined.length
  if (pad > 0) {
    // 把补齐放在 seq2 文本末尾（不影响规则判定）
    repl[1] = JSON.stringify({ type: 'compaction/summary', seq: 2, data: { summary: [{ type: 'text', text: B2 + '.' .repeat(pad) }] } })
    replJoined = repl.join('\n') + '\n'
  }
  const tmpPlain = sf + '.plain'
  writeFileSync(tmpPlain, replJoined, 'utf8')
  const rc = spawnSync(PYTHON, ['-c',
    'import sys,zstandard;' +
    'src=open(sys.argv[1],"rb").read();' +
    'open(sys.argv[2],"wb").write(zstandard.ZstdCompressor().compress(src))',
    tmpPlain, sf])
  rmSync(tmpPlain, { force: true })
  if (rc.status !== 0) throw new Error('zstd 压缩失败')
  const beforeLen = shadowRows().length
  out = runOnce()
  const afterLen = shadowRows().length
  // 说明：替换后的 zstd 压缩长度未必恰好等于原长度，因此这里只断言"没漏处理"。
  // 严苛的 size 相等分支由单测 C4 直接覆盖（decideScanMode 纯函数）。
  ok(afterLen > beforeLen, `★内容被替换后重新处理（${beforeLen}→${afterLen} 行，原实现会漏）`)
  const reason = (out.match(/→ (\S+) →/) || [, '(未触发重置，按增量处理)'])[1]
  console.log('     [实测判定] ' + reason)

  console.log('I4b 游标接线：fileId 为 inode 形态、tailHash 随文件变化')
  const cur = JSON.parse(readFileSync(join(home, 'compaction-purify-shadow.cursor'), 'utf8'))
  ok(/^\d+:\d+$/.test(String(cur[sf].fileId)), '★fileId=dev:ino（非路径，可识破删除重建）')
  ok(typeof cur[sf].lastSummaryHash === 'string' && cur[sf].lastSummaryHash.length === 16,
    '★lastSummaryHash 锚点已落盘（16 hex）')

  console.log('I5 回滚后重追加（历史锚点消失）')
  // 回滚为只有一条**新**摘要（seq 1，内容是 C），再追加 seq 2（内容 B）
  writeSession(sf, [[1, C], [2, B]])
  const b5 = shadowRows().length
  out = runOnce()
  const a5 = shadowRows().length
  ok(a5 > b5, '★锚点丢失触发全量重扫（原实现按 seq 跳过会漏）')

  console.log('I6 中段改写（seq1 内容变、seq2 不变、size 变大）')
  // 关键点：seq 集合与上一次一致（都是 1、2），但 seq1 内容被改写。
  //   旧实现只认 seq → 会跳过 seq1，影子日志里永远是旧内容（漏网）。
  //   新实现 (seq,hash) 二元 → 只重扫 seq1，seq2 不重复。
  // 内容刻意做得比 I5 的版本长，保证 size 单调（走 incremental 分支，最严苛）。
  const A2L = A2 + ' 补充说明：' + '改写后的正文与原文不同，必须被重新净化。'.repeat(6)
  writeSession(sf, [[1, A2L], [2, B]])
  const b6 = shadowRows().length
  const seq2Before = shadowRows().filter((r) => /#seq=2$/.test(r.source || '')).length
  out = runOnce()
  const rows6 = shadowRows()
  const a6 = rows6.length
  const seq2After = rows6.filter((r) => /#seq=2$/.test(r.source || '')).length
  ok(a6 === b6 + 1, `★只重扫被改写的 1 条（新增 ${a6 - b6} 行）`)
  ok(seq2After === seq2Before, '★未改写的 seq2 不重复处理（增量精确）')
  const last = rows6.slice(-1)[0]
  ok(!!last && /#seq=1$/.test(last.source || ''), '  新行的 source=seq1')
  ok(!!last && /已改写/.test(last.purified || ''), '  新行内容=改写后的 seq1（旧实现会留旧值）')
  ok(!/重置/.test(out), '  未被误判为全量重置')

  console.log('I7 幂等收口：再跑一次不增行')
  const b7 = shadowRows().length
  runOnce()
  ok(shadowRows().length === b7, '  连续跑不产生重复行')

  /* ── I8-I9 半帧文件 ⇒ partial-read（外部复核第六轮阻断：契约错配第二次）──
   *
   * 背景：`decompress()` 原来在退出码 0 时硬编码 `error: ''`，把 stderr 丢掉
   *   ⇒ `partial-read` 分支在生产路径上**永远不触发**（纯函数测试全绿，真实调用链静默失效）。
   *   ★ 同一天第二次"纯函数测试通过 ≠ 真实调用链对"——昨天错在字段名，今天错在丢值。
   *   ⇒ 这两个用例必须走**真实子进程 + 真实 zstd 文件**，只靠纯函数证明不了。
   *
   * 构造：帧1 完整压缩 + 帧2 截断（只留前一半字节）。
   *   `zstd-dump.py` 用 stream_reader(read_across_frames=True) 会读出帧1，
   *   碰到截断的帧2 抛异常 ⇒ 按设计 **exit 0** + stderr 告警 + 只交出已读到的完整帧。
   *   ⇒ 这正是"只抢救到一部分"的真实长相：退出码 0、输出非空、但有 stderr。
   */
  console.log('I8 半帧文件 → partial-read（真实调用链）')
  {
    const halfDir = join(home, 'sessions', 'bucket-half', 'session-halfdead-test')
    const half = join(halfDir, 'session.v4.jsonl.zstd')
    mkdirSync(halfDir, { recursive: true })
    const r8 = spawnSync(PYTHON, ['-c',
      'import sys,zstandard as zstd;' +
      'c=zstd.ZstdCompressor();' +
      'g=c.compress(b\'{"type":"compaction/summary","seq":1,"data":{"summary":[{"type":"text","text":"frame1 summary half-frame"}]}}\\n\');' +
      'f2=c.compress(b\'{"type":"compaction/summary","seq":2,"data":{"summary":[{"type":"text","text":"frame2 summary should-not-appear"}]}}\\n\');' +
      'open(sys.argv[1],"wb").write(g+f2[:len(f2)//2])',
      half])
    if (r8.status !== 0) throw new Error('半帧文件构造失败: ' + (r8.stderr || '').toString())
    const before = shadowRows().length
    const out8 = runOnce()
    ok(/未完成/.test(out8), '★★半帧文件被判未完成（partial-read 在真实链路上生效）')
    ok(/partial-read/.test(out8), '  reason=partial-read')
    ok(shadowRows().length === before, '★整份不处理（帧1 的摘要也不写，保证不漏）')
    // 游标状态：失败被记下，且**不许被 skip**
    const cur = JSON.parse(readFileSync(join(home, 'compaction-purify-shadow.cursor'), 'utf8'))
    const e8 = Object.entries(cur).find(([k]) => k.includes('halfdead'))
    ok(!!e8 && e8[1].failCount === 1, '★failCount=1（失败被记账）')
    ok(!!e8 && !e8[1].scannedAt, '★未写 scannedAt（下轮必须重试）')
    // 下一轮：因为 failCount>0，shouldSkip 不许跳过 ⇒ 仍然尝试
    const out8b = runOnce()
    ok(/未完成/.test(out8b), '★★下一轮仍尝试处理（shouldSkip 拦住了"旧 scannedAt + 三维度全同"的跳过）')

    console.log('I9 文件补全后恢复')
    // 把帧2 补完整 ⇒ 下一轮应读到两条摘要，failCount 清零
    const r9 = spawnSync(PYTHON, ['-c',
      'import sys,zstandard as zstd;' +
      'c=zstd.ZstdCompressor();' +
      'g=c.compress(b\'{"type":"compaction/summary","seq":1,"data":{"summary":[{"type":"text","text":"frame1 summary half-frame"}]}}\\n\');' +
      'f2=c.compress(b\'{"type":"compaction/summary","seq":2,"data":{"summary":[{"type":"text","text":"frame2 summary should-not-appear"}]}}\\n\');' +
      'open(sys.argv[1],"wb").write(g+f2)',
      half])
    if (r9.status !== 0) throw new Error('补全失败: ' + (r9.stderr || '').toString())
    const before9 = shadowRows().length
    const out9 = runOnce()
    ok(/新摘要 2 条/.test(out9), '★补全后读到全部 2 条（partial 期间没丢数据）')
    ok(shadowRows().length === before9 + 2, '  影子日志 +2 行')
    const cur9 = JSON.parse(readFileSync(join(home, 'compaction-purify-shadow.cursor'), 'utf8'))
    const e9 = Object.entries(cur9).find(([k]) => k.includes('halfdead'))
    ok(!!e9 && (e9[1].failCount || 0) === 0, '★failCount 清零（恢复成功）')
    ok(!!e9 && !!e9[1].scannedAt, '★补写 scannedAt')
  }
} finally {
  cleanup()
}

console.log('────────────────────────────')
console.log(`purify-shadow-integration: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
