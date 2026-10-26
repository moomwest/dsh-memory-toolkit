#!/usr/bin/env node
/**
 * purify-shadow.mjs —— 影子管道（compaction 净化层 2a · S3）
 *
 * 职责（任务书 S3）：只读宿主 compaction/summary 事件 → purify 净化 → 写影子日志。
 *   ★ 宿主产物全程不动（2a 零侵入）；影子日志禁存原文（凭据事件纪律）。
 *
 * 三项工程约束（评审点，全部落地）：
 *   ① cursor 五维度身份：fileId(dev:ino) + mtimeMs + size + tailHash + lastSummaryHash，
 *      持久化在 ~/.dsh/compaction-purify-shadow.cursor，重启不重复处理
 *      ★ 2026-10-23 sol 复审③：原先只有 size 单调判断，同尺寸替换/mtime 变内容换/
 *        删除重建三类场景全漏；现由 tools/purify-shadow/cursor.mjs 纯函数统一判定
 *   ② 半帧保护：解压子进程（python zstandard 多帧）坏帧只告警不崩；node 侧
 *      逐行 JSON parse，残行跳过
 *   ③ shadow 轮转：~/.dsh/compaction-purify-shadow.jsonl 超 5MB 转 .1，最多 2 代
 *
 * 行结构（禁含原文——凭据纪律）：
 *   { source, input_sha256, input_chars, purified, coverage, report, at }
 *   degraded 且 report.unscrubbed 时不写 purified（只记失败类型+哈希）。
 *
 * 用法：
 *   node purify-shadow.mjs --once    单轮（冒烟/手动用）
 *   node purify-shadow.mjs           常驻轮询（默认 60s）
 *   node purify-shadow.mjs --stats   只看影子日志统计
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readFileSync, renameSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const { purifySummary, scanSecrets } = await import('../lib/purify.js')
const {
  sha256Short, fileIdentity, decideScanMode,
  buildSeenMap, isProcessed, detectDivergence, trimSums,
  judgeScanCompletion, scanPriority, shouldSkip,
} = await import('./purify-shadow/cursor.mjs')

/* ── 配置（S0 实证：宿主 config 通道 fail-fast，purify 参数只用本地默认）── */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = process.env.INTERCOM_SESSIONS || join(DSH_HOME, 'sessions')
const SHADOW_LOG = join(DSH_HOME, 'compaction-purify-shadow.jsonl')
const CURSOR_FILE = join(DSH_HOME, 'compaction-purify-shadow.cursor')
const ZSTD_DUMP = resolve(import.meta.dirname, 'purify-shadow', 'zstd-dump.py')
const PYTHON = process.env.PURIFY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const MAX_SHADOW_BYTES = 5 * 1024 * 1024
const POLL_MS = 60000

/* ── U18 性能债务（2026-10-23 三轮复核）：单轮工作量必须有上限 ──
 *
 *   ★ 她的判断是对的：增量模式只省掉**未变化**的文件；一旦文件变了（活跃会话每轮都在变），
 *     `processFile` 仍然把整份日志解压重扫 —— 104 份全扫在沙箱里 2 分钟内跑不完（实测被 SIGTERM）。
 *     而且**处理到一半被中断时，cursor 一点没写** ⇒ 下一轮从头再来 ⇒ 永远扫不完。
 *
 *   ★ 三条修法（都不改判定逻辑，只改"一次干多少、什么时候落盘"）：
 *     ① MAX_FILES_PER_TICK：单轮最多处理 N 份文件，**优先扫最久没扫过的**。
 *        ⇒ 冷启动自然分成几轮推进，不会卡在一轮里被杀。
 *     ② 中途游标：每处理 FLUSH_EVERY 条条目就落盘一次 cursor
 *        ⇒ 单文件处理到一半被杀，下一轮从断点续，不丢进度。
 *     ③ 单轮耗时上报：轮末打印耗时与剩余未扫数，冷启动的进度**看得见**。
 *
 *   ★ 为什么不做"超时就跳过"：跳过 = 漏扫，而**漏报比报错更坏**（C1 那条教训）。
 *     宁可多轮慢慢推进，也不让一份日志被静默略过。
 */
const MAX_FILES_PER_TICK = Number(process.env.PURIFY_MAX_FILES) || 25
const FLUSH_EVERY = Number(process.env.PURIFY_FLUSH_EVERY) || 40
// ★ 单轮里"失败重试"最多占的比例：剩下的位置强制留给首次扫描/正常轮换的文件，
//   防止持续失败的文件吃满配额饿死健康文件（详见 tick 里的注释）。
const RETRY_SHARE = Number(process.env.PURIFY_RETRY_SHARE) || 0.5

/* ── 日志：同时写 stdout 与文件（2026-10-25 补）──
 *
 * 为什么要自己写文件：常驻进程靠「登录时静默启动」（启动文件夹里的 vbs）拉起，
 * 那条路径**没有 shell 重定向**。原来只 console.log ⇒ 无窗口启动 = 一个字都不留，
 * 出了问题只能看到「进程没了」而看不到死因。
 *
 * 轮转：单文件超 5MB 改名 .1（只留一代）。日志只是查死因用，不需要长期归档。
 * 写失败静默 —— 日志本身不能把主流程带崩（此处不递归记日志）。
 */
const WATCH_LOG = join(DSH_HOME, 'purify-watch.out.log')
const WATCH_LOG_MAX = 5 * 1024 * 1024

function log(...a) {
  const line = new Date().toISOString() + ' ' +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  try {
    try {
      if (statSync(WATCH_LOG).size > WATCH_LOG_MAX) renameSync(WATCH_LOG, WATCH_LOG + '.1')
    } catch {}
    appendFileSync(WATCH_LOG, line + '\n', 'utf8')
  } catch {}
}

/* ── cursor 三维度持久化 ── */
function loadCursor() {
  try { return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')) } catch { return {} }
}
function saveCursor(c) {
  try {
    writeFileSync(CURSOR_FILE + '.tmp', JSON.stringify(c, null, 2), 'utf8')
    renameSync(CURSOR_FILE + '.tmp', CURSOR_FILE)
  } catch (e) { log('cursor 写入失败（不致命）:', e.message) }
}

/* ── 解压子进程（python 多帧）──
 * ★ U18-b：原来**不看出退出码**、启动失败也 resolve('')，返回值无法区分
 *   "文件真的是空的" 和 "解压崩了"。主循环拿着空串照样往下走 ⇒ 标成已扫完
 *   ⇒ 下一轮 skip ⇒ 这份文件从此扫不到。
 *   现在返回 { text, decompressOk, empty, error }：
 *     decompressOk=false  子进程退出码非 0 / python 压根没起来 ⇒ **失败，不许记完成**
 *     decompressOk=true   正常；其中 empty=true 表示"退出码 0 但没产出"＝空文件（合法，算扫完）
 *
 * ★★ 字段名必须**逐字**对上 judgeScanCompletion 的入参（decompressOk）。
 *   本文件第一版这里返回的是 `ok`，纯函数读的是 `decompressOk` ⇒ 恒 undefined
 *   ⇒ fail-closed ⇒ **全库每一份都判失败**。集成测试 5 passed / 11 failed 当场抓到。
 *   ★ 教训：纯函数 + 穷举用例能证明"函数内部没这条路"，**证明不了调用方传对字段名**。
 *      契约错配只能靠跑真实调用路径（集成测试）兜住 —— 两层都要有。
 */
function decompress(file) {
  return new Promise((res) => {
    const py = existsSync(PYTHON) ? PYTHON : 'python'
    let ps
    try {
      ps = spawn(py, [ZSTD_DUMP, file], { maxBuffer: 512 * 1024 * 1024 })
    } catch (e) {
      log('  python 启动失败:', e.message)
      res({ text: '', decompressOk: false, empty: false, error: 'spawn:' + e.message })
      return
    }
    const chunks = []
    let err = ''
    ps.stdout.on('data', (d) => chunks.push(d))
    ps.stderr.on('data', (d) => { err += d.toString() })
    ps.on('close', (code) => {
      const errText = err.trim()
      if (errText) log('  zstd-dump:', errText.slice(0, 120))
      const text = Buffer.concat(chunks).toString('utf8')
      if (code !== 0) {
        // 退出码非 0 = 真失败（坏帧 / 脚本异常 / 信号杀死）。★ 不猜，不重试就算了。
        res({ text, decompressOk: false, empty: false, error: `exit:${code}${errText ? ':' + errText.slice(0, 200) : ''}` })
        return
      }
      // ★★ 退出码 0 时**必须把 stderr 传下去**（外部复核第六轮阻断，契约错配第二次）：
      //   这里原来硬编码 `error: ''`，于是 `partial-read` 分支在生产路径上**永远不触发**
      //   —— 纯函数测试全绿（测试直接传 error），真实调用链却静默失效。
      //   ★ 同一天第二次踩"纯函数测试通过 ≠ 真实调用链对"：**昨天错在字段名，今天错在丢值**。
      //   语义：zstd-dump.py 对坏帧是 exit 0 + stderr 告警（设计如此：坏帧也要交出已读到的完整帧）
      //   ⇒ 有 stderr = 只抢救到一部分 = partial-read（详见 judgeScanCompletion）。
      res({ text, decompressOk: true, empty: text.length === 0, error: errText.slice(0, 200) })
    })
    ps.on('error', (e) => { log('  python 启动失败:', e.message); res({ text: '', decompressOk: false, empty: false, error: 'error:' + e.message }) })
  })
}

/* ── 文件尾指纹（sol 复审项：同尺寸替换/内容回换检测）──
 * 读文件尾 4KB 算 sha256 短码：size 不变但内容被换（替换/回滚/同尺寸改写）时
 * 尾指纹必变——补 size 单调判断的盲区。成本：每文件 4KB 读取。 */
function tailHash(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const st = fstatSync(fd)
      const len = Math.min(4096, st.size)
      if (len === 0) return 'empty'
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, st.size - len)
      return createHash('sha256').update(buf).digest('hex').slice(0, 16)
    } finally { closeSync(fd) }
  } catch { return '' }
}

/* ── shadow 轮转（约束③）── */
function rotateIfNeeded() {
  try {
    if (!existsSync(SHADOW_LOG)) return
    if (statSync(SHADOW_LOG).size <= MAX_SHADOW_BYTES) return
    const old = SHADOW_LOG + '.1'
    if (existsSync(old)) renameSync(old, SHADOW_LOG + '.2')  // 最多 2 代
    renameSync(SHADOW_LOG, old)
    log('shadow 轮转完成（>5MB）')
  } catch (e) { log('轮转失败（不致命）:', e.message) }
}

/* ── 扫会话文件 ── */
function listSessionFiles() {
  const out = []
  let buckets = []
  try { buckets = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return out }
  for (const b of buckets) {
    const dir = join(SESSIONS_DIR, b)
    let sessions = []
    try { sessions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { continue }
    for (const s of sessions) {
      // 只认现行 v4 压缩代（v5 明文实验已证伪，升代明文导致 list 崩——不碰明文根）
      const f = join(dir, s, 'session.v4.jsonl.zstd')
      if (existsSync(f)) out.push(f)
    }
  }
  return out
}

/* ── 抽 compaction/summary 事件并净化 ──
 * ★ 两阶段（sol 复审③）：先整体抽条目算锚点，再决定是否 reset，最后才处理。
 *   顺序不能反——边扫边跳会错过"历史被回绕"的信号。 */
async function processFile(file, cursorEntry, onProgress, sizeBytes) {
  // ★ U18-b：失败时的"保底返回值"—— 原样保留上一轮进度（不倒退），但**明说没完成**。
  //   主循环据此决定要不要写 scannedAt。**决不允许返回"看起来正常"的结果。**
  let d
  try { d = await decompress(file) } catch (e) {
    return keepProgress(cursorEntry, false, 'exception', 'decompress-threw:' + e.message)
  }
  // ★ sizeBytes 必须传进来：空输出时要靠"文件是否真的为空"区分真空文件与读失败
  const verdict = judgeScanCompletion({ ...d, sizeBytes })
  if (!verdict.completed) return keepProgress(cursorEntry, false, verdict.reason, d.error || '')
  // ★ 空文件是**合法且确实扫完了**的：退出码 0、里面确实没有摘要。
  //   判成失败会让它每轮都重试，白烧 CPU。
  if (verdict.reason === 'empty-file') return keepProgress(cursorEntry, true, 'empty-file', '')

  const text = d.text
  let maxSeq = cursorEntry.maxSeq || 0
  const seen = buildSeenMap(cursorEntry.sums)  // ★ (seq → hash) 内容感知身份
  let found = 0
  let fileLastHash = ''
  let writeFailed = 0   // ★ 影子日志写失败的条数（外部复核第五轮阻断）
  // 主体可能抛异常（purify 内部 / shadow 写盘）—— 不能让一个坏文件掀翻整轮 tick
  try {

  // ── 阶段 1：抽出全部 summary 条目（顺序保留）──
  const entries = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let e
    try { e = JSON.parse(t) } catch { continue }  // 半帧残行：跳过（约束②）
    if (e.type !== 'compaction/summary') continue
    const seq = typeof e.seq === 'number' ? e.seq : 0
    const blocks = Array.isArray((e.data || {}).summary) ? e.data.summary : []
    if (blocks.length === 0) continue
    entries.push({ seq, blocks, hash: sha256Short(JSON.stringify(blocks)) })
  }
  fileLastHash = entries.length ? entries[entries.length - 1].hash : ''

  // ── 阶段 2：锚点分歧检测（回滚后重追加——size 不降、尾指纹也变，靠锚点抓）──
  if (detectDivergence(entries, cursorEntry.lastSummaryHash)) {
    log('  ', file.replace(SESSIONS_DIR, ''), '→ 历史锚点丢失（回绕/重写），重置该游标全量重扫')
    seen.clear()
  }

  // ── 阶段 3：处理（跳过 = seq 与 hash 同时命中）──
  for (const entry of entries) {
    const { seq, blocks, hash } = entry
    if (isProcessed(seen, seq, hash)) continue
    maxSeq = Math.max(maxSeq, seq)
    seen.set(seq, hash)
    found++
    const sid = file.match(/session-([0-9a-f]{8})-/i)
    const source = (sid ? 'session-' + sid[1] : 'unknown') + '#seq=' + seq
    const inputJson = JSON.stringify(blocks)
    const r = purifySummary(blocks, { minKeepChars: 400 })
    const row = {
      source,
      input_sha256: sha256Short(inputJson),
      input_chars: inputJson.length,
      at: new Date().toISOString(),
    }
    if (r.report.unscrubbed) {
      // 铁律：可能含未脱敏秘密 → 不写 purified
      row.failed = r.report.reason
      row.note = 'unscrubbed-不写原文'
    } else {
      const purifiedJson = JSON.stringify(r.summary)
      // ★ 最终秘密扫描（sol 独立审查项）：purify 自身保证之外的第二道闸，
      //   管道写入前独立复核——命中>0 一律不写 purified（纵深防御）。
      const secretHits = scanSecrets(purifiedJson)
      if (secretHits > 0) {
        row.failed = 'secret-scan:' + secretHits
        row.note = '终扫命中秘密，不写 purified'
      } else {
        row.purified = purifiedJson
        row.coverage = r.report.coverage
        row.report = { redacted: r.report.redacted, deduped: r.report.deduped, degraded: r.report.degraded, reason: r.report.reason }
      }
    }
    try {
      appendFileSync(SHADOW_LOG, JSON.stringify(row) + '\n', 'utf8')
    } catch (e2) {
      log('  shadow 写入失败:', e2.message)
      // ★★ 外部复核第五轮阻断：写失败**必须回滚 seen**，否则这一行永远补不回来。
      //   原因是 `seen.set(seq, hash)` 发生在写之前 ⇒ 若只把文件标成"未完成"，
      //   cursor 里保存的 sums 仍含这条 ⇒ 下轮 `isProcessed` 命中 ⇒ 跳过 ⇒ 永久漏写。
      //   ★ 又是"记录了处理"被当成"处理成功了"—— 与 U18-b 同款病的第五张脸。
      //   解法：**只有写成功了才算处理过**，失败就从 seen 里撤下来，下轮重试。
      seen.delete(seq, hash)
      writeFailed++
    }

    // ★ 中途游标（U18②）：每 FLUSH_EVERY 条把进度落盘一次。
    //   单文件处理到一半被杀时，下一轮从断点续，而不是整份重来。
    if (onProgress && found % FLUSH_EVERY === 0) {
      onProgress({ maxSeq, sums: trimSums(seen), lastSummaryHash: fileLastHash })
    }
  }
  // ★ 写失败 ⇒ 整个文件不算完整扫完（那些行下轮要补写）
  if (writeFailed > 0) {
    log('  ', file.replace(SESSIONS_DIR, ''), '→ 影子日志写失败', writeFailed, '条（已从 seen 撤下，下轮补写）')
  }
  return {
    maxSeq, found, sums: trimSums(seen), lastSummaryHash: fileLastHash,
    completed: writeFailed === 0, reason: writeFailed > 0 ? 'shadow-write-failed' : 'ok',
  }
  } catch (e) {
    log('  ', file.replace(SESSIONS_DIR, ''), '→ 处理异常（记为未完成，下轮重试）:', e.message.slice(0, 120))
    return {
      maxSeq, found, sums: trimSums(seen), lastSummaryHash: fileLastHash,
      completed: false, reason: 'exception', error: e.message.slice(0, 200),
    }
  }
}

/** 保底返回值：保留上一轮进度（不倒退），并**显式标注完成与否** */
function keepProgress(cursorEntry, completed, reason, error) {
  return {
    maxSeq: cursorEntry.maxSeq || 0, found: 0,
    sums: cursorEntry.sums || [], lastSummaryHash: cursorEntry.lastSummaryHash || '',
    completed, reason, error: error || '',
  }
}

/* ── 主循环 ── */
async function tick() {
  const t0 = Date.now()
  const cursor = loadCursor()
  const files = listSessionFiles()
  let totalFound = 0

  // ★ U18①：先挑出本轮**真正要处理**的文件（skip 的不算工作量），
  //   再按"最久没扫过"排序 ⇒ 冷启动时每轮推进一批，不会卡在同一轮里被杀。
  const pending = []
  let skipped = 0
  let failed = 0
  for (const f of files) {
    // ★ stat 可能失败（会话文件被清理/权限）。原来它在 try 外 ⇒
    //   **一个文件 stat 不到就掀翻整轮，前面几十份的进度全丢**（U18 主题：中断不丢进度）。
    let st
    try { st = statSync(f) } catch {
      log('  ', f.replace(SESSIONS_DIR, ''), '→ 读不到文件状态，跳过（可能已被删除）')
      continue
    }
    const key = f
    const th = tailHash(f)                 // 尾指纹（同尺寸替换检测）
    const fid = fileIdentity(st)           // ★ inode 身份（删除重建/路径复用检测）
    const prev = cursor[key]
    const mode = decideScanMode(prev, { fileId: fid, mtimeMs: st.mtimeMs, size: st.size, tailHash: th })
    // ★★ 只在本文件**上一轮真的扫完了**时才允许跳过。
    //   反例（我自己写出来的第一版就踩了）：处理到一半被杀时，游标里已经写进了
    //   fileId/mtime/size/tailHash ⇒ 下一轮三维度全同 ⇒ 直接 skip ⇒ **剩下那半份永远扫不到**。
    //   ★ 这就是 C1 那个病的又一张脸：**"记录了看到"被当成"处理完了"**。
    //   解法：身份三元组照记（下次续扫要用），但**完成标记另立 `scannedAt`**，
    //         skip 必须两者兼备 —— 见过 + 扫完 + 此后没变。
    //   ★★ 外部复核第五轮又抓到第三条（我加"继承 scannedAt"引入的新漏路）：
    //      文件更新后**扫描失败** ⇒ 游标保留旧 `scannedAt`、但身份三元组已更新为当前值
    //      ⇒ 下一轮三维度全同 ⇒ 命中 skip，而旧 `scannedAt` 又存在 ⇒ **直接跳过**，
    //        这个失败的文件版本永远不再被扫 —— 硬配额也救不了（它连 pending 都进不去）。
    //   解法：`shouldSkip` 额外要求 `failCount === 0`（有未解决的失败 = 当前版本没扫成）。
    if (shouldSkip(prev, mode)) { skipped++; continue }
    pending.push({ f, st, th, fid, prev, mode, key })
  }
  // 最久没扫过的排前面（没记录过的当 0，最优先）
  // ★ 但**连续失败的要退避**（scanPriority）：失败 ⇒ 不写 scannedAt ⇒ 下一轮它排最前，
  //   一个持续失败的文件会**永久占满单轮配额、饿死其他文件**（修一个洞造另一个）。
  pending.sort((a, b) => scanPriority(a.prev) - scanPriority(b.prev))

  // ★★ 失败重试的**硬配额**：单轮里 failed-retry 最多占 RETRY_SHARE（默认一半）。
  //   为什么光靠 scanPriority 不够退避：从未成功过的文件 scannedAt 恒缺失(0)，
  //   排序键 ≈ failCount×1h（≈1e7），而健康文件是时间戳量级（≈1.8e12）
  //   ⇒ 失败文件**永远排在所有扫过的健康文件前面** ⇒ 25 个持续失败文件就能
  //   把 25 个配额全占满 ⇒ 健康文件饿死（子代理用真实数据实测复现了这一点）。
  //   ★ 硬配额是最后一道保险：**无论排序怎么算，健康文件每轮都至少有一半位置**。
  const retryCap = Math.max(1, Math.floor(MAX_FILES_PER_TICK * RETRY_SHARE))
  const batch = []
  let retries = 0
  for (const p of pending) {
    if (batch.length >= MAX_FILES_PER_TICK) break
    const isRetry = Number(p.prev?.failCount) > 0
    if (isRetry && retries >= retryCap) continue  // 跳过它继续挑，本轮不占健康文件的位
    batch.push(p)
    if (isRetry) retries++
  }
  const deferred = pending.length - batch.length
  if (deferred > 0) {
    log(`  本轮处理 ${batch.length} 份（共 ${pending.length} 份待扫，留 ${deferred} 份到下一轮 · 单轮上限 ${MAX_FILES_PER_TICK}）`)
  }

  for (const p of batch) {
    const { f, st, th, fid, prev, mode } = p
    const entry = mode.action === 'reset'
      ? { mtimeMs: 0, size: 0, maxSeq: 0, sums: [], lastSummaryHash: '' }
      : (prev || { mtimeMs: 0, size: 0, maxSeq: 0, sums: [], lastSummaryHash: '' })
    if (mode.action === 'reset' && prev) {
      log('  ', f.replace(SESSIONS_DIR, ''), '→', mode.reason, '→ 重置游标全量重扫')
    }
    cursor[p.key] = {
      fileId: fid,                         // ★ 真文件身份（非路径）
      mtimeMs: st.mtimeMs,
      size: st.size,
      tailHash: th,
      maxSeq: entry.maxSeq || 0,
      sums: entry.sums || [],
      lastSummaryHash: entry.lastSummaryHash || '',
      // ★★ 历史成功时间**必须继承**（子代理独立复核发现的第一版 bug）：
      //   这里原来是整体重建、不带 scannedAt ⇒ **失败一次就把过去的成功记录抹掉**
      //   ⇒ 排序键塌回 `0 + failCount×1h`（≈1e7），而健康文件是时间戳量级（≈1.8e12）
      //   ⇒ 惩罚项差 6 个数量级，**根本排不动** ⇒ 退避形同虚设、饿死健康文件。
      //   ★ 又一次"重建对象时把不该丢的字段丢了" —— 与 U18 第一轮 skip 漏洞同源。
      ...(prev?.scannedAt ? { scannedAt: prev.scannedAt } : {}),
      ...(prev?.failCount ? { failCount: prev.failCount } : {}),
      ...(prev?.lastError ? { lastError: prev.lastError } : {}),
    }
    // ★ 中途游标：处理到一半被杀也不丢进度（flush 由 processFile 周期性回调触发）
    //   ★ 这里**刻意不写 scannedAt** —— 中途落盘只保存进度，不算扫完。
    const r = await processFile(f, entry, (snap) => {
      cursor[p.key] = { ...cursor[p.key], ...snap }
      saveCursor(cursor)
    }, st.size)
    // ★★ U18-b（外部复核四轮阻断）：**只有真的扫完才写 scannedAt**。
    //   原实现无条件写 ⇒ 解压崩了/抛异常也标成"已完整扫描" ⇒ 下一轮三维度全同
    //   ⇒ 直接 skip ⇒ **这份文件从此再也扫不到**。
    //   ★ 这是"跑过一遍"被当成"扫完了"—— 与 C1、与 U18 第一轮 skip 漏洞同款病的第三张脸。
    //   fail-closed：没**明确**说完成，就不算完成。
    const done = r.completed === true
    cursor[p.key] = {
      ...cursor[p.key],
      maxSeq: r.maxSeq,
      sums: r.sums || [],
      lastSummaryHash: r.lastSummaryHash || '',  // ★ 锚点：下次比对用
      ...(done
        ? { scannedAt: Date.now(), failCount: 0, lastError: '' }
        : {}),
    }
    if (!done) {
      const fc = (Number(prev?.failCount) || 0) + 1
      cursor[p.key].failCount = fc
      cursor[p.key].lastError = r.error ? `${r.reason}:${r.error}` : r.reason
      failed++
      log('  ', f.replace(SESSIONS_DIR, ''), '→ 未完成（', cursor[p.key].lastError, '）· 连续', fc, '次 · 不写 scannedAt，下轮重试')
    }
    if (r.found > 0) log('  ', f.replace(SESSIONS_DIR, ''), '→ 新摘要', r.found, '条')
    totalFound += r.found
  }
  saveCursor(cursor)
  rotateIfNeeded()
  // ★ U18③：冷启动进度必须**看得见** —— 否则不知道还要跑几轮
  if (batch.length > 0 || deferred > 0) {
    log(`  本轮耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s｜新摘要 ${totalFound} 条｜跳过(未变) ${skipped}｜未完成 ${failed}｜还剩 ${deferred} 份待扫`)
  }
  return totalFound
}

/* ── ★ 单实例锁（2026-10-25 补）──
 *
 * 背景：本脚本无锁。两个常驻进程同时跑 ⇒ 同时 tick ⇒ 同时读写 cursor
 * ⇒ 后写的覆盖先写的 ⇒ **新摘要重复写进影子日志 / cursor 进度回退**。
 * 而且这种损坏长得跟正常一样（日志变长、退出码 0），事后很难分辨。
 *
 * 做法：`wx` 独占创建锁文件（原子），内容写 pid + 起始时间。
 *   · 已存在 ⇒ 读 pid，若该 pid 还活着（同机进程存在）⇒ 拒启，退出码 0（不是错误）
 *   · 该 pid 已死 ⇒ 陈旧锁，抢占重建（覆盖被异常退出的进程留下的锁）
 *   · 进程退出时（含 SIGINT/SIGTERM）删自己的锁
 *   · `--once` 不加锁：单轮补扫必须随时能跑，且它和常驻共用 cursor 只会有一次
 *     竞争的写窗口（可接受），加锁反而会让手动补扫被常驻挡住。
 */
const LOCK_FILE = join(DSH_HOME, 'compaction-purify-shadow.lock')

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但没权限（同机另一个用户）⇒ 仍算活着，不能抢锁
    return e && e.code === 'EPERM'
  }
}

function acquireLock() {
  const payload = JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME || '', at: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx')
      try { writeFileSync(fd, payload) } finally { closeSync(fd) }
      return { ok: true }
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { ok: false, reason: 'lock-error:' + (e && e.message) }
    }
    // 已存在：看持有者是否还活着
    let holder = null
    try { holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) } catch { holder = null }
    if (holder && pidAlive(holder.pid)) {
      return { ok: false, reason: 'already-running', pid: holder.pid, since: holder.at }
    }
    // 陈旧锁 ⇒ 清掉后重试一次
    log(`陈旧锁（pid=${holder && holder.pid} 已不存在），清除后重试`)
    try { writeFileSync(LOCK_FILE, '') } catch {}
    try { renameSync(LOCK_FILE, LOCK_FILE + '.stale-' + Date.now()) } catch {}
    try {
      const fd = openSync(LOCK_FILE, 'wx')
      try { writeFileSync(fd, payload) } finally { closeSync(fd) }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: 'lock-race:' + (e && e.message) }
    }
  }
  return { ok: false, reason: 'lock-exhausted' }
}

function releaseLock() {
  try {
    const holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    if (holder && holder.pid === process.pid) writeFileSync(LOCK_FILE, '')
    if (holder && holder.pid === process.pid) renameSync(LOCK_FILE, LOCK_FILE + '.released-' + Date.now())
  } catch {}
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--stats') {
    if (!existsSync(SHADOW_LOG)) { log('影子日志不存在（还没压缩过或没跑过）'); return }
    const rows = readFileSync(SHADOW_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const degraded = rows.filter((r) => r.report && r.report.degraded).length
    const failed = rows.filter((r) => r.failed).length
    log(`影子日志: ${rows.length} 行 | degraded ${degraded} | failed(unscrubbed) ${failed} | 文件 ${SHADOW_LOG}`)
    return
  }
  log('影子管道启动 | sessions=' + SESSIONS_DIR + ' | shadow=' + SHADOW_LOG)
  if (mode === '--once') {
    const n = await tick()
    log('单轮完成：新摘要', n, '条')
    return
  }
  // 常驻
  const lock = acquireLock()
  if (!lock.ok) {
    if (lock.reason === 'already-running') {
      log(`拒绝启动：已有常驻进程在跑（pid=${lock.pid}，自 ${lock.since}）。本进程退出，不做任何写入。`)
      return
    }
    // 锁相关错误不致命（比如目录只读）：告警后继续，靠 cursor 自身幂等兜底
    log(`⚠ 未能取得单实例锁（${lock.reason}），继续运行但可能与另一实例竞争 cursor`)
  } else {
    log(`已取得单实例锁 pid=${process.pid}`)
  }
  const onExit = () => { if (lock.ok) releaseLock() }
  process.on('exit', onExit)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(sig, () => { onExit(); process.exit(0) }) } catch {}
  }
  for (;;) {
    try { await tick() } catch (e) { log('tick 异常（不死）:', e.message) }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((e) => { log('管道致命:', e); process.exitCode = 1 })
