/**
 * test/purify-shadow-cursor.mjs —— 影子管道游标判定单测（sol 复审③整改）
 *
 * 针对 2026-10-23 sol 第二次复审阻断项③：
 *   原判定只有 `st.size < prev.size`，三类场景全漏——
 *     ① 同尺寸替换  ② mtime 变但内容被换  ③ 文件删除重建（路径复用）
 *   且条目身份只看 seq，同 seq 不同内容会被误跳过。
 *
 * 覆盖：
 *   C1-C7  decideScanMode 七种形态（含原实现漏判的三类）
 *   C8-C9  条目身份内容感知（同 seq 同 hash 跳过 / 不同 hash 重处理）
 *   C10-C13 锚点分歧 detectDivergence 四种取值
 *   C14-C16 trimSums / fileIdentity / sha256Short 稳定性与退化
 *
 * 纪律：纯函数，零文件写入、零解压、零宿主依赖。
 *
 * 跑法：node test/purify-shadow-cursor.mjs
 */
const {
  sha256Short, fileIdentity, decideScanMode,
  buildSeenMap, isProcessed, detectDivergence, trimSums,
  judgeScanCompletion, scanPriority, shouldSkip,
} = await import('../tools/purify-shadow/cursor.mjs')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('ok   ' + name) }
  else { fail++; console.log('FAIL ' + name) }
}

const BASE = { fileId: '123:456', mtimeMs: 1000, size: 5000, tailHash: 'aaaaaaaaaaaaaaaa', sums: [] }
const p = (o) => ({ ...BASE, ...o })

console.log('C1-C7 decideScanMode 形态判定')
ok(decideScanMode(null, BASE).action === 'reset', '无 prev → reset（首次全量）')
ok(decideScanMode(null, BASE).reason === 'new-file', '  reason=new-file')

// ★ 原实现漏判①：同尺寸替换
ok(decideScanMode(p({}), p({ size: 5000, tailHash: 'bbbbbbbbbbbbbbbb', mtimeMs: 2000 })).action === 'reset',
  '★同尺寸替换（size 同/尾变）→ reset')
ok(decideScanMode(p({}), p({ size: 5000, tailHash: 'bbbbbbbbbbbbbbbb', mtimeMs: 2000 })).reason === 'same-size-replaced',
  '  reason=same-size-replaced')

// ★ 原实现漏判②：mtime 变但内容被换（size 不变）
ok(decideScanMode(p({}), p({ size: 5000, tailHash: 'cccccccccccccccc', mtimeMs: 9999 })).action === 'reset',
  '★mtime 变+内容换（size 不变）→ reset')

// ★ 原实现漏判③：删除重建（路径复用，inode 变）
ok(decideScanMode(p({ fileId: '123:456' }), p({ fileId: '123:789', size: 9000, mtimeMs: 3000, tailHash: 'dddddddddddddddd' })).action === 'reset',
  '★删除重建/路径复用（inode 变）→ reset')
ok(decideScanMode(p({ fileId: '123:456' }), p({ fileId: '123:789', size: 9000, mtimeMs: 3000, tailHash: 'dddddddddddddddd' })).reason === 'file-replaced(inode)',
  '  reason=file-replaced(inode)')

// 原有能力保持
ok(decideScanMode(p({}), p({ size: 3000 })).action === 'reset', '截断/回滚（size 变小）→ reset')
ok(decideScanMode(p({}), p({ size: 3000 })).reason === 'truncated', '  reason=truncated')
ok(decideScanMode(p({}), BASE).action === 'skip', '三维度全同 → skip（省解压）')
ok(decideScanMode(p({}), BASE).reason === 'unchanged', '  reason=unchanged')
ok(decideScanMode(p({}), p({ size: 8000, mtimeMs: 2000, tailHash: 'eeeeeeeeeeeeeeee' })).action === 'incremental',
  '正常追加（size 变大）→ incremental')
ok(decideScanMode(p({}), p({ size: 8000, mtimeMs: 2000, tailHash: 'eeeeeeeeeeeeeeee' })).reason === 'appended',
  '  reason=appended')
ok(decideScanMode(p({}), p({ mtimeMs: 2000 })).action === 'incremental', '仅 mtime 变 → incremental（内容感知兜底）')
ok(decideScanMode({ fileId: '123:456', mtimeMs: 1000, size: 5000, tailHash: 'aaaaaaaaaaaaaaaa', seqs: [7] }, BASE).action === 'reset',
  '★旧格式游标（无 sums）→ reset（一次性迁移，不做不安全增量）')
ok(decideScanMode({ fileId: '123:456', mtimeMs: 1000, size: 5000, tailHash: 'aaaaaaaaaaaaaaaa', seqs: [7] }, BASE).reason === 'legacy-cursor',
  '  reason=legacy-cursor')

console.log('C8-C9 条目身份内容感知（同 seq 不同内容必重处理）')
const m1 = buildSeenMap([[7, 'hashAAA']])
ok(isProcessed(m1, 7, 'hashAAA') === true, '同 seq 同 hash → 已处理（跳过）')
ok(isProcessed(m1, 7, 'hashBBB') === false, '★同 seq 不同 hash → 重处理（回滚重写不再漏）')
ok(isProcessed(m1, 8, 'hashAAA') === false, '不同 seq → 重处理')
ok(buildSeenMap(undefined).size === 0, '空 sums → 空 Map（首次不炸）')
ok(buildSeenMap([[1, 'a'], 'bad', [2]]).size === 1, '脏数据行不污染（非数组/短数组跳过）')

console.log('C10-C13 锚点分歧 detectDivergence')
const e1 = [{ hash: 'h1' }, { hash: 'h2' }]
ok(detectDivergence(e1, 'h2') === false, '锚点（末条）仍在 → 无分歧')
ok(detectDivergence(e1, 'h1') === false, '锚点在中段仍在 → 无分歧')
ok(detectDivergence(e1, 'hX') === true, '★锚点丢失 → 分歧（回滚后重追加，需全量重扫）')
ok(detectDivergence(e1, '') === false, '无 prev 锚点 → 不算分歧（交给 decideScanMode）')
ok(detectDivergence([], 'h1') === true, '★文件被掏空（无条目但有锚点）→ 分歧')
ok(detectDivergence([], '') === false, '全新空文件 → 无分歧')

console.log('C14-C16 辅助函数')
const big = new Map()
for (let i = 0; i < 1200; i++) big.set(i, 'h' + i)
const trimmed = trimSums(big, 500)
ok(trimmed.length === 500, 'trimSums 限长 500（cursor 不无限增长）')
ok(trimmed[499][0] === 1199, '  保留最近的（末条不丢）')
ok(trimSums(big, 2000).length === 1200, '  未超限则原样返回')
ok(fileIdentity({ dev: 3, ino: 9 }) === '3:9', 'fileIdentity = dev:ino')
ok(fileIdentity({}) === 'na:na', '★取不到 inode → 退化 na:na（不误判新文件）')
ok(fileIdentity(undefined) === 'na:na', '  undefined 不炸')
ok(sha256Short('abc') === sha256Short('abc'), 'sha256Short 稳定')
ok(sha256Short('abc') !== sha256Short('abd'), '  不同输入不同输出')
ok(sha256Short('abc').length === 16, '  16 hex 短码')

/* ── C17-C24 扫描完成判定（外部复核四轮阻断 U18-b）──
 *
 * 她抓到的：decompress 崩了/起不来 ⇒ processFile 返回"看起来正常"的结果
 * ⇒ 主循环无条件写 scannedAt ⇒ 下一轮 skip ⇒ **这份文件从此扫不到**。
 *
 * 判定标准不是"跑没跑完"，是**"有没有真的看到全部内容"**。
 */
console.log('C17-C24 扫描完成判定 judgeScanCompletion')

// ① 正常完成
ok(judgeScanCompletion({ decompressOk: true, empty: false }).completed === true, '解压正常 → 完成')
ok(judgeScanCompletion({ decompressOk: true, empty: false }).reason === 'ok', '  reason=ok')

// ② ★ 核心：解压失败 ⇒ 绝不算完成（她抓的阻断项）
ok(judgeScanCompletion({ decompressOk: false }).completed === false, '★解压失败 → 不算完成')
ok(judgeScanCompletion({ decompressOk: false }).reason === 'decompress-failed', '  reason=decompress-failed')
ok(judgeScanCompletion({ decompressOk: false, empty: true }).completed === false,
  '★崩了还返回空 ⇒ 仍算失败（空不能洗白失败）')

// ③ ★ 空文件是合法的：退出码 0、文件 0 字节、无 stderr ⇒ 扫完了（里面确实没有摘要）
ok(judgeScanCompletion({ decompressOk: true, empty: true, sizeBytes: 0, error: '' }).completed === true,
  '★真空文件（0 字节、无告警）→ 算完成（判失败会每轮白重试）')
ok(judgeScanCompletion({ decompressOk: true, empty: true, sizeBytes: 0, error: '' }).reason === 'empty-file',
  '  reason=empty-file')

// ③b ★★ 空输出的**另一种成因**（子代理独立复核发现的第一版漏网）：
//    `zstd-dump.py` 对任何读取异常都 exit 0（坏帧也要交出已读到的完整帧）。
//    于是"首帧即截断的坏文件"＝ 退出码 0 + 空输出 ⇒ 若一律按空文件放行
//    ⇒ 写 scannedAt ⇒ 永久 skip、永不重试。**判据：非空文件却零输出 = 读失败。**
ok(judgeScanCompletion({ decompressOk: true, empty: true, sizeBytes: 4096, error: '' }).completed === false,
  '★★非空文件却零输出 → 失败（不能当空文件放行，否则永久 skip）')
ok(judgeScanCompletion({ decompressOk: true, empty: true, sizeBytes: 4096, error: '' }).reason === 'unreadable',
  '  reason=unreadable')
ok(judgeScanCompletion({ decompressOk: true, empty: true, sizeBytes: 0, error: '读取中断' }).completed === false,
  '★★有 stderr 告警 → 失败（哪怕文件是 0 字节）')
// ③b ★ 有 stderr 告警但读到了内容：**不算完整扫完**（外部复核第五轮阻断）
//   zstd-dump.py 遇到坏帧是"在坏帧处停止输出"的 ⇒ 它后面所有帧都丢了。
//   有告警 = 只抢救到一部分 ⇒ 判完成会让未读到的后续帧被永久跳过。
ok(judgeScanCompletion({ decompressOk: true, empty: false, sizeBytes: 4096, error: '读取中断' }).completed === false,
  '★★有告警但只读到部分内容 → 不算完成（partial-read，否则后续帧永久丢失）')
ok(judgeScanCompletion({ decompressOk: true, empty: false, sizeBytes: 4096, error: '读取中断' }).reason === 'partial-read',
  '  reason=partial-read')
ok(judgeScanCompletion({ decompressOk: true, empty: false, sizeBytes: 4096, error: '' }).completed === true,
  '  读到内容且无告警 → 完成')

// ④ 抛异常
ok(judgeScanCompletion({ decompressOk: true, threw: true }).completed === false,
  '★抛异常 → 不算完成（哪怕解压报成功）')
ok(judgeScanCompletion({ threw: true }).reason === 'exception', '  reason=exception')

// ⑤ ★ fail-closed：忘传/脏数据一律按失败（只会重试，不会漏扫）
{
  let crashed = false
  const statuses = []
  for (const e of [undefined, null, {}, { decompressOk: 1 }, { decompressOk: 'yes' }, { empty: false }]) {
    try { statuses.push(judgeScanCompletion(e).completed) } catch { crashed = true }
  }
  ok(!crashed, '脏入参不抛异常')
  ok(statuses.every((c) => c === false), '★脏入参一律按未完成（fail-closed）')
}

// ⑥ ★ 穷举不变式（比"数条数"更本质的两条）：
//    甲：**读到内容且无告警 ⇒ 算完成**（其余"读到内容"的组合都因告警而不算）
//    乙：**无输出 ⇒ 只有真空文件算完成**（1/4），其余判读失败
{
  let okClean = 0, nClean = 0
  let okWhenEmpty = 0, nEmpty = 0
  for (const hasErr of [false, true])
    for (const nonEmptyFile of [false, true]) {
      const base = { decompressOk: true, threw: false, error: hasErr ? '读取中断' : '', sizeBytes: nonEmptyFile ? 4096 : 0 }
      // 甲：读到了内容 —— 只有"无告警"才算完整扫完
      nClean++
      if (judgeScanCompletion({ ...base, empty: false }).completed) okClean++
      // 乙：一点都没读到
      nEmpty++
      if (judgeScanCompletion({ ...base, empty: true }).completed) okWhenEmpty++
    }
  ok(okClean === nClean / 2, `★甲：读到内容 + **无告警**才算完成（${okClean}/${nClean}，一半——有告警即部分抢救）`)
  ok(okWhenEmpty === 1, `★乙：无输出 ⇒ 只有真空文件放行（${okWhenEmpty}/${nEmpty}，其余判读失败）`)
  // 乙的具体落点：只有"无告警 + 0 字节"那一种
  ok(judgeScanCompletion({ decompressOk: true, empty: true, error: '', sizeBytes: 0 }).reason === 'empty-file',
    '  乙-落点：唯一放行的组合 = 无告警 + 0 字节')
  for (const [err, sz] of [['读取中断', 0], ['', 4096], ['读取中断', 4096]]) {
    ok(judgeScanCompletion({ decompressOk: true, empty: true, error: err, sizeBytes: sz }).reason === 'unreadable',
      `  乙-其余三种（${err || '无告警'}/${sz}B）→ unreadable`)
  }
}

/* ── C25-C28 失败退避排序 scanPriority ──
 * 引入"失败不写 scannedAt"之后的新漏洞：失败文件下一轮排最前，
 * 持续失败的文件会永久占满单轮配额、饿死其他文件。
 */
console.log('C25-C28 失败退避 scanPriority')
{
  const HOUR = 3600000
  ok(scanPriority({ scannedAt: 0, failCount: 0 }) < scanPriority({ scannedAt: 1000, failCount: 0 }),
    '没扫过的排前面（冷启动逐批推进）')
  ok(scanPriority({ scannedAt: 1000, failCount: 0 }) < scanPriority({ scannedAt: 1000, failCount: 1 }),
    '★同一起点，失败过的排后面（不抢别人的位置）')
  ok(scanPriority({ scannedAt: 1000, failCount: 3 }) > scanPriority({ scannedAt: 1000, failCount: 1 }),
    '  失败越多退得越远')
  // ★ 关键不变式：失败文件仍要排在"刚成功扫过"的前面 —— 会重试，只是不抢第一
  ok(scanPriority({ scannedAt: 1000, failCount: 1 }) < scanPriority({ scannedAt: Date.now(), failCount: 0 }),
    '★但仍优先于"刚扫过且成功"的（保证会重试，不是永久沉底）')
  ok(scanPriority(undefined) === 0 && scanPriority(null) === 0, '  脏入参 = 最优先，不炸')
}

/* ── C29-C33 shouldSkip：失败过的文件版本不许跳过（外部复核第五轮阻断）──
 * 场景：文件曾被成功扫过（scannedAt=T1）⇒ 内容更新后**扫描失败** ⇒
 *   游标保留旧 scannedAt 但身份三元组已更新为当前值 ⇒ 下一轮三维度全同判 skip
 *   ⇒ 旧 scannedAt 又存在 ⇒ **直接跳过，这个失败版本永远不再被扫**。
 *   ⇒ 硬配额也救不了它，因为它连 pending 都进不去。
 */
console.log('C29-C33 shouldSkip 失败版本不许跳过')
{
  const skip = { action: 'skip' }
  // ① 正常跳过：扫完过、没失败过、元数据没变
  ok(shouldSkip({ scannedAt: 1000, failCount: 0 }, skip) === true, '扫完过且无失败 → 可跳过')
  // ② ★ 核心阻断项：扫完过但**当前版本失败过** ⇒ 不许跳
  ok(shouldSkip({ scannedAt: 1000, failCount: 1 }, skip) === false,
    '★★有旧 scannedAt 但当前版本失败过 → **不许跳过**（否则该版本永远不再被扫）')
  ok(shouldSkip({ scannedAt: 1000, failCount: 3 }, skip) === false, '  连续失败 3 次同理')
  // ③ 从没扫完过 ⇒ 不许跳
  ok(shouldSkip({ scannedAt: 0, failCount: 0 }, skip) === false, '无 scannedAt → 不许跳')
  ok(shouldSkip({}, skip) === false, '  空 prev → 不许跳')
  // ④ 不是 skip 动作 ⇒ 一律不跳（reset/rescan 本来就该处理）
  ok(shouldSkip({ scannedAt: 1000, failCount: 0 }, { action: 'reset' }) === false, 'reset → 不跳')
  ok(shouldSkip({ scannedAt: 1000, failCount: 0 }, { action: 'rescan' }) === false, 'rescan → 不跳')
  // ⑤ 脏入参不炸
  let crashed = false
  for (const e of [undefined, null, {}, { scannedAt: 'x', failCount: 'y' }]) {
    try { shouldSkip(e, skip) } catch { crashed = true }
  }
  ok(!crashed, '脏入参不抛异常')
  // ⑥ ★ 不变式：只要 failCount>0，任何情况都不许跳
  {
    let blocked = 0
    for (const scannedAt of [0, 1000, 1.8e12])
      for (const action of ['skip', 'reset', 'rescan']) {
        if (!shouldSkip({ scannedAt, failCount: 1 }, { action })) blocked++
      }
    ok(blocked === 9, `★failCount>0 时 9 种组合全部拦住（实测 ${blocked}/9）`)
  }
}

console.log('────────────────────────────')
console.log(`purify-shadow-cursor: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
