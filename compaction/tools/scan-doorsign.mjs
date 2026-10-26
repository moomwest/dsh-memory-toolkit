// 扫所有会话日志的 compaction/summary，统计「门牌」有没有写上。
// ============================================================================
// ★★ 2026-10-23 大修（外部复核 C1 阻断项：扫描不完整 ⇒ 报出来的总数不可信）
//
//   原写法：**只从尾部解、每份限 32 MiB**。两个后果：
//     · 大日志（实测全库 104 份、合计 135 MB、**最大 45.1 MB**）前面的帧被整段丢掉；
//     · `if (total + b.length > MAX_TOTAL) { if (chunks.length === 0) …; break }`
//       —— 累积超限时**直接 break**，更早的帧一个都不解。
//   ⇒ 脚本报「全库 10 条摘要」，而跨帧全量解码实测是 **34 条物理记录**。
//
//   ★ 漏报比报错更坏：看报告的人会以为「全库就 10 条，只有 1 条带门牌」，
//     据此下的所有结论（覆盖率、接管前后对比）**全部是错的**，
//     而它长得跟正常结果一模一样 —— 这是静默失效，不是崩。
//
//   ★ 修法：**逐帧解码、逐帧扫描、扫完即弃**。
//     · 不再把整份拼成一个大 Buffer ⇒ 内存只占一帧（原写法最多 32 MiB 常驻）；
//     · 不再有任何截断 ⇒ 全量覆盖；
//     · 附带把「物理记录 / 去重后」分开报 —— 实测 34 条物理里有 9 条是**重复归档**
//       （同一 `(会话, seq)` 出现在多个代次文件 `session.vN` 里），
//       混在一起报会让「有多少次压缩」这个问题答错。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

// 会话日志根目录：可用 DSH_SESSIONS 覆盖，否则默认 <DSH_HOME>/sessions 或 ~/.dsh/sessions。
const SESSIONS = process.env.DSH_SESSIONS
  || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions')
     : path.join(os.homedir(), '.dsh', 'sessions'))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MARK = '⛬ 压缩索引（非原文）'

/**
 * 逐帧解码并回调每一条 compaction/summary（**扫完即弃，不拼整份**）。
 *
 * @param {string} file
 * @param {(e:object, gen:string)=>void} onSummary
 * @returns {number} 该文件里扫到的物理条数
 */
function scanFile(file, onSummary) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return 0 }
  const gen = (/session\.v(\d+)\.jsonl\.zstd$/.exec(path.basename(file)) || [])[1] || '?'
  let found = 0
  let i = buf.indexOf(MAGIC, 0)
  while (i >= 0) {
    const j = buf.indexOf(MAGIC, i + 4)
    let b
    try { b = zlib.zstdDecompressSync(buf.subarray(i, j === -1 ? buf.length : j)) } catch { i = j; continue }
    for (const line of b.toString('utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      let e
      try { e = JSON.parse(t) } catch { continue /* 半行/杂字节：跳过，不猜 */ }
      if (e && e.type === 'compaction/summary') { onSummary(e, gen); found++ }
    }
    i = j
  }
  return found
}

/** @type {Array} 物理记录（每条一次压缩，含重复归档） */
const phys = []
for (const b of fs.readdirSync(SESSIONS)) {
  const bp = path.join(SESSIONS, b)
  if (!fs.statSync(bp).isDirectory()) continue
  for (const sid of fs.readdirSync(bp)) {
    const sd = path.join(bp, sid)
    if (!fs.statSync(sd).isDirectory()) continue
    for (const n of fs.readdirSync(sd)) {
      if (!/^session\.v(\d+)\.jsonl\.zstd$/.test(n)) continue
      const f = path.join(sd, n)
      scanFile(f, (s, gen) => {
        const raw = JSON.stringify(s.data || {})
        phys.push({
          sid: sid.slice(0, 12),
          seq: s.seq,
          time: s.time,
          gen,
          hasSeqTag: /#seq=(\d+)/.test(raw),
          seqTag: (/#seq=(\d+)/.exec(raw) || [])[1] || null,
          hasMark: raw.includes(MARK),
          chars: raw.length,
          // ★★ 三轮复核（外部复核 C1 补充）：原来用的是 `seq|time|chars` 当"内容指纹" ——
          //   那不是哈希，只是三个字段拼起来的**坐标**，却叫"指纹"（命名夸大）。
          //   更实在的问题是：同一会话里两条**不同**摘要若 seq/time/长度都撞上会被误并。
          //   ⇒ 直接对摘要原文取真哈希，名字才名副其实，碰撞概率也可忽略。
          fp: createHash('sha256').update(raw).digest('hex').slice(0, 16),
        })
      })
    }
  }
}

// ★ 两级去重，口径都报出来 —— 「全库有几次压缩」这个问法本身是歧义的：
//   ① 按 (会话, seq)：同一份日志里同一条记录被写了两次（代次文件并存）⇒ 合并；
//   ② 按内容指纹（摘要原文的 sha256 前 16 位）：**同一份会话被复制进了多个会话目录**
//      （实测 1367 / 5253 / e784 三个目录里有逐字节相同的历史日志 —— 污染种子拷过去的）
//      ⇒ 那是同一件事的三份拷贝，不该算三次压缩。
//   ★ 两个数字差多少，就说明有多少是这种拷贝。只报一个会被误读成"扫描又漏了/又重了"。
const bySidSeq = new Map()
const byContent = new Map()
for (const r of phys) {
  const k1 = `${r.sid}#${r.seq}`
  if (!bySidSeq.has(k1)) bySidSeq.set(k1, r)
  // ★ 真哈希（不是 seq|time|chars 那种坐标拼接）；对未算指纹的老记录退化到坐标
  const k2 = r.fp || `${r.seq}|${r.time}|${r.chars}`
  if (!byContent.has(k2)) byContent.set(k2, r)
}
const rows = [...bySidSeq.values()].sort((a, b) => Number(a.time) - Number(b.time))

const iso = (t) => new Date(Number(t)).toISOString().replace('T', ' ').slice(0, 19)
console.log('=== 全部 compaction/summary 的门牌状态（按时间升序，已去重）===')
for (const r of rows) {
  console.log(
    `${iso(r.time)}  ${r.sid.padEnd(12)} v${r.gen} seq=${String(r.seq).padEnd(6)} ` +
    `${r.hasSeqTag ? '门牌#' + r.seqTag : '★无门牌'}  mark=${r.hasMark ? 'Y' : 'N'}  ${r.chars}B`
  )
}
const noTag = rows.filter((r) => !r.hasSeqTag)
const dupWrite = phys.length - rows.length                 // 同一日志里的重复写入
const dupCopy = rows.length - byContent.size               // 同一份会话被复制到多个目录
const uniq = [...byContent.values()].sort((a, b) => Number(a.time) - Number(b.time))
const uniqNoTag = uniq.filter((r) => !r.hasSeqTag)
console.log('')
console.log(`物理记录        ${String(phys.length).padStart(3)} 条（每帧扫到的原始条数）`)
console.log(`按 (会话,seq)   ${String(rows.length).padStart(3)} 条${dupWrite ? `（同一日志重复写入 ${dupWrite} 条）` : ''}`)
console.log(`按 内容指纹     ${String(uniq.length).padStart(3)} 条${dupCopy ? `（同一会话被复制到多个目录 ${dupCopy} 条）` : ''}`)
console.log('')
console.log(`★ 真正不同的压缩事件 = ${uniq.length} 次 | 有门牌 ${uniq.length - uniqNoTag.length} | 无门牌 ${uniqNoTag.length}`)
const cut = Number(new Date('2026-10-23T00:00:00+08:00'))
const after = rows.filter((r) => Number(r.time) >= cut)
const afterNo = after.filter((r) => !r.hasSeqTag)
console.log(`10-23 之后（接管后）: ${after.length} 条 | 其中无门牌 ${afterNo.length} 条`)
if (afterNo.length) for (const r of afterNo) console.log('   ★', iso(r.time), r.sid, 'v' + r.gen, 'seq=' + r.seq)
// ★ 只靠 #seq= 认门牌会被「正文里引用了回取命令」骗到 —— 把两者不一致的单独点出来。
const tagNoMark = rows.filter((r) => r.hasSeqTag && !r.hasMark)
if (tagNoMark.length) {
  console.log('')
  console.log(`★ ${tagNoMark.length} 条有 #seq= 但没有门牌标记 —— 多半是模型在正文里引用了回取命令，不是真门牌：`)
  for (const r of tagNoMark) console.log('   ·', iso(r.time), r.sid, 'seq=' + r.seq, '#' + r.seqTag)
}
