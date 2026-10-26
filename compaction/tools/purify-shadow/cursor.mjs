/**
 * cursor.mjs —— 影子管道游标判定（纯函数，可独立单测）
 *
 * 抽出原因（2026-10-23 sol 第二次复审阻断项③）：
 *   原判定只有 `st.size < prev.size` 一条，三类真实场景全部漏判——
 *     ① 同尺寸替换（回滚后重写等长内容）
 *     ② mtime 变但内容被换（size 不变）
 *     ③ 文件被删除重建（路径复用，但已不是同一个文件）
 *   且身份只记路径、不记文件本体；seq 身份不看内容（同 seq 不同内容会被误跳过）。
 *
 * 四处修正：
 *   ① 文件身份 fileId = dev:ino（inode 级，路径复用也能识破）
 *   ② 尾指纹 tailHash（文件尾 4KB sha256 短码）→ 覆盖同尺寸替换
 *   ③ 锚点 lastSummaryHash（本文件最后一条 summary 的内容 hash）→ 覆盖"回滚后重追加"
 *   ④ 条目身份 (seq, hash) 二元——同 seq 不同内容一律重处理（幂等靠影子日志天然去重）
 *
 * ★ 本文件不落盘、不解压、不依赖宿主，import 无副作用。
 */
import { createHash } from 'node:crypto'

/** 内容短哈希（16 hex，够身份用，不占空间） */
export function sha256Short(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 文件身份：dev:ino。
 * 路径会被复用（删了重建、重命名轮换），inode 不会——用它才算"同一个文件"。
 * 取不到时（异常/虚拟盘）退化为 'na:na'，此时靠 size+tailHash 兜底，不误判为新文件。
 */
export function fileIdentity(st) {
  if (!st || st.dev === undefined || st.ino === undefined) return 'na:na'
  return `${st.dev}:${st.ino}`
}

/**
 * 扫描模式判定。
 *
 * @param {object|null} prev  游标中该文件的上一条记录（无则全新）
 * @param {object}      cur   { fileId, mtimeMs, size, tailHash }
 * @returns {{action:'skip'|'incremental'|'reset', reason:string}}
 *
 * 判定顺序（严格，先身份后形态）：
 *   1. 无 prev            → reset（首次见，全量）
 *   2. fileId 不同        → reset（文件被替换/重建——原 ③ 漏判）
 *   3. size 变小          → reset（截断/回滚）
 *   4. size 相同 & 尾不同 → reset（同尺寸替换——原 ①② 漏判）
 *   5. 三维度全同         → skip（无新写入）
 *   6. 其余               → incremental（正常追加）
 */
export function decideScanMode(prev, cur) {
  if (!prev) return { action: 'reset', reason: 'new-file' }
  // 旧格式游标（只有 seqs、没有 sums）缺内容身份，无法安全增量 → 全量重扫一次
  if (!Array.isArray(prev.sums)) return { action: 'reset', reason: 'legacy-cursor' }
  if (prev.fileId && cur.fileId && prev.fileId !== cur.fileId) {
    return { action: 'reset', reason: 'file-replaced(inode)' }
  }
  if (cur.size < prev.size) {
    return { action: 'reset', reason: 'truncated' }
  }
  if (cur.size === prev.size && prev.tailHash !== cur.tailHash) {
    return { action: 'reset', reason: 'same-size-replaced' }
  }
  if (prev.mtimeMs === cur.mtimeMs && prev.size === cur.size && prev.tailHash === cur.tailHash) {
    return { action: 'skip', reason: 'unchanged' }
  }
  return { action: 'incremental', reason: 'appended' }
}

/** 由 cursor.sums（[[seq,hash],...]）还原身份 Map */
export function buildSeenMap(sums) {
  const m = new Map()
  for (const p of sums || []) {
    if (Array.isArray(p) && p.length >= 2) m.set(p[0], p[1])
  }
  return m
}

/**
 * 内容感知的"已处理"判定：seq 与 hash 同时命中才算处理过。
 * ★ 只看 seq 会把"同 seq 但内容被重写"的条目误判为已处理（sol 复审③）。
 * 非 Map（脏游标/旧格式）一律按未处理，宁可重扫也不漏。
 */
export function isProcessed(seenMap, seq, hash) {
  if (!(seenMap instanceof Map)) return false
  return seenMap.get(seq) === hash
}

/**
 * 锚点分歧检测：上次处理的"最后一条 summary"在本文件里还找不找得到。
 * 找不到 → 说明历史被回绕/重写过，之前按 seq 跳过的判断全部作废 → 必须 reset。
 * 首次（无 prevLastHash）不算分歧，交给 decideScanMode 处理。
 */
export function detectDivergence(entries, prevLastHash) {
  if (!prevLastHash) return false
  if (!entries || entries.length === 0) return true
  return !entries.some((e) => e.hash === prevLastHash)
}

/** 游标瘦身：只保留最近 cap 条 (seq,hash)，防 cursor 无限增长 */
export function trimSums(seenMap, cap = 500) {
  const arr = [...seenMap.entries()]
  if (arr.length <= cap) return arr
  return arr.slice(arr.length - cap)
}

/**
 * ★ 扫描完成判定（外部复核四轮阻断 U18-b，2026-10-23）
 *
 * 背景：U18 第一轮我引入了 `scannedAt`（完成标记，与"身份三元组"分开写），
 *   为的是修掉"处理到一半被杀 ⇒ 下一轮三维度全同 ⇒ 直接 skip ⇒ 剩下半份永远扫不到"。
 *   但主循环是**无条件**写 `scannedAt` 的，于是：
 *     解压子进程崩了 / python 起不来 / 解压产出空串
 *       ⇒ processFile 照样返回一个"看起来正常"的结果
 *       ⇒ 主循环照样写 scannedAt
 *       ⇒ 下一轮 skip ⇒ **这份文件从此再也扫不到**
 *   ★ 这是同一个病的第三张脸：**"跑过一遍"被当成"扫完了"**。
 *     第一张脸 = C1 的"只解了尾部就当全库"；第二张脸 = 上面那个 skip 漏洞。
 *
 * 三条边界（容易矫枉过正，写在这儿免得后人改错）：
 *   ① **"空输出"有两种成因，必须分开**：
 *        · 真空文件（**0 字节**且 stderr 干净）⇒ 里面确实没摘要 ⇒ **算扫完**
 *        · 读不出来（**非空文件却零字节输出** / stderr 有告警）⇒ **算失败**
 *      ★★ 这条是 U18-b 的**同一类病的另一条路径**（子代理独立复核发现）：
 *      `zstd-dump.py` 对任何读取异常都 `sys.exit(0)`（设计如此：坏帧也要把已读到的
 *      完整帧交出来）。于是"首帧即截断的坏文件"＝ 退出码 0 + 空输出
 *      ⇒ 若一律按空文件放行 ⇒ 写 scannedAt ⇒ **永久 skip、永不重试**。
 *   ② **"读到了一部分" ≠ "完整扫完"**（外部复核第五轮阻断）：
 *      `zstd-dump.py` 遇到坏帧时是**在坏帧处停止输出**的 —— 它后面所有帧都丢了。
 *      所以 stderr 有告警 = 只抢救到一部分 = **不许记完成**，否则：
 *        · 本次没读到的后续帧被永久跳过（元数据没变的话连重扫都不会触发）
 *        · 且它长得跟"正常扫完"一模一样（输出非空、退出码 0）
 *      ★ 这正是"漏报比报错更坏"的典型：判失败只是多耗一轮，判漏了这条永远补不回来。
 *   ③ `threw` 在生产路径上目前是死代码（decompress 从不返回它，processFile 的
 *      catch 直接 return 绕过了本函数），但**保留**：它是契约的一部分，且单测在覆盖。
 *
 * @param {{decompressOk?:boolean, empty?:boolean, threw?:boolean, error?:string, sizeBytes?:number}} e
 *   缺省一律按"失败"处理（fail-closed）：忘传只会重试，不会漏扫。
 * @returns {{completed:boolean, reason:'ok'|'empty-file'|'decompress-failed'|'unreadable'|'partial-read'|'exception'}}
 */
export function judgeScanCompletion(e) {
  if (e?.threw === true) return { completed: false, reason: "exception" }
  // ★ fail-closed：decompressOk 缺省/非 true 一律算失败（忘传只会重试，不会漏扫）
  if (e?.decompressOk !== true) return { completed: false, reason: "decompress-failed" }
  // ★② 读到内容但 stderr 有告警 = 只抢救到一部分 ⇒ 不算完整扫完
  if (e?.empty !== true && !!e?.error) return { completed: false, reason: "partial-read" }
  if (e?.empty === true) {
    const unreadable = !!e?.error || Number(e?.sizeBytes) > 0
    return unreadable
      ? { completed: false, reason: "unreadable" }
      : { completed: true, reason: "empty-file" }
  }
  return { completed: true, reason: "ok" }
}

/**
 * ★ 当前文件版本是否允许跳过（外部复核第五轮阻断，2026-10-24）
 *
 * 背景：我为了让"失败重试"的退避生效，让重建游标时**继承** `prev.scannedAt`。
 *   这引入了一条新漏路（她抓到，我完全没想到）：
 *     ① 文件曾被成功扫过，`scannedAt = T1`
 *     ② 文件内容更新（mtime/size/tailHash 变）⇒ 本轮不 skip，进入处理
 *     ③ 处理**失败** ⇒ 游标保存旧 `scannedAt=T1`，但身份三元组**已更新为当前值**，
 *        且 `failCount=1`
 *     ④ 下一轮：三维度全同 ⇒ `decideScanMode` 判 skip；而旧 `scannedAt` 又存在
 *        ⇒ **直接跳过 ⇒ 这个失败的文件版本永远不再被扫**
 *   ⇒ 硬配额救不了它，因为它连 pending 都进不去。
 *
 * 修法：skip 必须满足"见过 + **扫完且此后没失败过** + 没变"三者兼备。
 *   即 `failCount` 必须为 0 —— 有未解决的失败，就说明当前版本还没被完整扫过。
 *   ★ `failCount` 只在成功时清零，所以这个条件精确等价于"当前版本扫成功过"。
 *
 * @param {{scannedAt?:number, failCount?:number}} prev
 * @param {{action:'skip'|'reset'|'rescan'|string}} mode decideScanMode 的返回值
 * @returns {boolean} true = 可以跳过
 */
export function shouldSkip(prev, mode) {
  if (mode?.action !== "skip") return false
  if (!prev?.scannedAt) return false          // 从没扫完过 ⇒ 不能跳
  if (Number(prev?.failCount) > 0) return false // 当前版本扫失败过 ⇒ 必须重试
  return true
}

/**
 * ★ 待扫优先级排序键（U18-b 配套）
 *
 * 为什么需要：引入"失败就不写 scannedAt"之后，失败文件下一轮会**排在最前面**
 * （scannedAt 缺失 = 0 = 最久没扫过）。一个持续失败的文件（坏 zstd、权限问题）
 * 会**永久占据单轮配额，把其他文件饿死** —— 修一个漏洞造出另一个。
 *
 * 解法：连续失败次数 × 惩罚时长，加到排序键上 ⇒ 失败越多次排得越靠后，
 *   但**仍然排在"刚扫过且成功"的文件之前**（会重试，只是不抢别人的位置）。
 * 成功时 caller 负责把 failCount 清零。
 *
 * @param {{scannedAt?:number, failCount?:number}} prev
 * @param {number} [penaltyMs] 每次连续失败的退避时长，默认 1 小时
 * @returns {number} 越小越优先
 */
export function scanPriority(prev, penaltyMs = 60 * 60 * 1000) {
  const scannedAt = Number(prev?.scannedAt) || 0
  const failCount = Number(prev?.failCount) || 0
  return scannedAt + failCount * penaltyMs
}
