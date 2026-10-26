// lib/doorsign.js —— 门牌（回取指针）的纯函数层 · 零外部依赖
// ============================================================================
// ★ 为什么要从 index.js 里抽出来（2026-10-23，doctor 门牌项报红的根治）：
//
//   门牌是「压缩之后还能不能回到一手原文」的命脉 —— 05-doctor.md 第 3 句话
//   的判据就是「能不能一把回到原文」。但它原先是 index.js 里的一个**内部函数**，
//   而 index.js 顶部 import 了 `@deepseek-ai/dsh-compaction-basic` 与
//   `@deepseek-ai/dsh-compaction` —— **这两个包磁盘上根本不存在**（宿主运行时注入的
//   bundle）。后果：
//
//     · 任何 `import('./index.js')` 都直接 `Cannot find package` ⇒ **门牌无法被单测**；
//     · 于是它只能靠「真机压缩一次」来验证，而真机压缩要等上下文涨到阈值 ——
//       实测全库 9 条 compaction/summary 里，**接管后 0 条**（截至 2026-10-23）。
//
//   ★ 这就是 index.js 里那句「自动兜底那条路仍未验」的**结构性根因**：
//     不是不想验，是**结构上验不了** —— 一个只能靠真机触发才能验证的函数，等于没验证。
//
//   抽出来之后：本文件零 import、零宿主依赖，test/doorsign.mjs 可以直接单测。
//   index.js 只做 `import { pointerText, MARK } from './lib/doorsign.js'`，
//   运行期行为逐字不变（纯搬运，未改任何逻辑）。
// ============================================================================

/** 摘要框的行首标记 —— 醒目的一个词，让后来的我一眼认出这是压缩产物。 */
export const MARK = '> ⛬ 压缩索引（非原文）'

// ★ node:util 是 Node 内置，不破坏本文件"零宿主依赖"的定位
//   （它不 import 任何 @deepseek-ai/* 包，test/doorsign.mjs 仍能直接单测）。
import { isDeepStrictEqual } from 'node:util'

/**
 * 两次快照是否是「同一选区」（外部复核"两次快照"设计的收尾判断）。
 *
 * ★ 为什么抽成导出函数（2026-10-25 踩过）：这行判断原先写在 index.js 里，用
 *   `isDeepStrictEqual(after.shadowedSeqs, before.shadowedSeqs)`；后来把
 *   captureShadowed 挪进本文件时，把 `import { isDeepStrictEqual }` 也挪了过来，
 *   **漏了 index.js 那一处使用** ⇒ 运行期 `ReferenceError` ⇒ 被 summarize 的
 *   try/catch 吞掉 ⇒ **门牌静默消失**（16:35 那次手动的实测症状）。
 *   ★ 语法检查查不出这种错（它是运行期引用错误，不是语法错误）。
 *   ★ 修法不只是补 import —— 是把判断本身也收进本文件：index.js 只调 helper，
 *     不再直接引用任何本文件私用的依赖 ⇒ 这类"挪走了一半"的错从结构上消失。
 *
 * 三条全同才认：同一 session 对象、同一 sid、shadowedSeqs 逐项相等（保序）。
 */
export function sameSelection(a, b) {
  if (!a || !b) return false
  if (a.session !== b.session) return false
  if (a.sid !== b.sid) return false
  return isDeepStrictEqual(a.shadowedSeqs, b.shadowedSeqs)
}

/**
 * 捕获「本次压缩实际遮掉的全部 seq」—— 外部复核 2026-10-25 给的方案 A。
 *
 * ★ 为什么需要它：`shadowedSeqs` 只存在于宿主 `compactSurfaceRegion` 内部
 *   （落盘前才补进事件 data）。三条"看起来能走"的路全断（2026-10-25 逐个实证）：
 *     ① `super.summarize()` 的返回值 —— `summarizeWithLlm` 只返回
 *        {summary, rawOutput, llmStreamCall, provider, model, maxTokens, usage}；
 *     ② `super.compactRegion()` 的返回值 —— **那里有**（prepareCompaction 的 selection
 *        一路透传），但 **summarize 是在 compactRegion 内部被调用的，比返回值早**；
 *     ③ `input.messages` —— buildSummarizationInput 投影时 seq 就丢了。
 *   ⇒ 只能自己从 surface 复刻，并用**完整消息结构比对**验证复刻对不对。
 *
 * ★ 宿主算法（asar `dsh-compaction-basic/lib/index.js` 实证）：
 *   `nodes.slice(startIdx, endIdx + 1)`，而 `startIdx/endIdx = nodes.indexOf(start/end)`
 *   —— **按位置切，不是按数值范围筛**。surface 的 seq **不保证单调**
 *   （实测有 [10, 4, 30, 12, 40] 这种形状），按 `start ≤ seq ≤ end` 筛会漏掉
 *   中间的位置段（上例会漏 4 和 30）。
 *
 * ★ 校验（外部复核：完整消息结构比对，比任何范围校验都强）：把截出来的 seq 按宿主的
 *   投影方式（system 头 + 过滤 null）重建成 messages，与 `input.messages` 做
 *   `isDeepStrictEqual` —— 不一致返回 null。这同时兜住四类错：range 拿错、
 *   surface 在等待期间变了、会话串了（共享实例）、以及我们自己复刻复错。
 *   **首尾文字相同不代表中间一致**，所以比的是整个对象。
 *
 * ★ 绝不做：排序、按数值范围过滤、把 null 投影节点从 shadowedSeqs 里剔掉
 *   （宿主没剔，我们剔了就和宿主口径不一致）。
 *
 * @returns {{session, sid, start, end, shadowedSeqs}|null} 校验不过 ⇒ null（调用方降级）
 */
export function captureShadowed(agent, input, range) {
  try {
    const session = agent !== null && agent !== undefined ? agent.session : null
    if (session === null || session === undefined) return null
    const raw = session.surface ? session.surface.nodes : null
    if (!range || !Array.isArray(raw) || !Array.isArray(input && input.messages)) return null

    const nodes = raw.slice()
    if (nodes.length === 0) return null
    // 形状预检：非负整数、无重复（重复节点会让 indexOf 定位到错的位置）
    if (nodes.some((n) => !Number.isSafeInteger(n) || n < 0)) return null
    if (new Set(nodes).size !== nodes.length) return null

    const i = nodes.indexOf(range.start)
    const j = nodes.indexOf(range.end)
    if (i < 0 || j < i) return null

    const seqs = nodes.slice(i, j + 1)

    // 与宿主 buildSummarizationInput 的投影方式逐字对齐（system 头 + null 过滤）
    const head = session.eventAt(nodes[0])
    const system = head && head.type === 'system/message' ? session.deriveEventMessage(head) : null
    const region = seqs
      .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
      .filter((message) => message !== null)
    const expected = system === null ? region : [system, ...region]
    if (!isDeepStrictEqual(expected, input.messages)) return null

    return { session, sid: String(session.id ?? ''), start: range.start, end: range.end, shadowedSeqs: seqs }
  } catch {
    return null   // 取不到不猜 —— 错的门牌比没有更坏
  }
}

/**
 * ★ 取回命令 —— 换成你自己的检索工具。
 *
 * 门牌会被渲染成：`<MEMQ> open log:<会话号>#seq=<n>`
 * 所以它只要认 `open <指针>` 这个形式就行。
 *
 * 包只负责【写指针】，不规定你用什么工具去【回取】。
 *
 * ★★ 回取命令：**没配置就不给命令，只给指针**（2026-10-22 全面验证报告 P2-6）。
 *
 *   原来这里写死 '<你的检索命令>'，渲染出来是一条**不可执行的假命令**：
 *     > 回取：`<你的检索命令> open log:session-x#seq=123`
 *   而指针本身（log:...#seq=）是好的。
 *
 *   ★ 给一条假命令**比不给更坏**：读的人（人或 agent）会照着敲，敲不通之后
 *     可能反过来怀疑「这个门牌是坏的」—— 而那恰好是这套机制最要紧的东西。
 *   所以没配置时只说「用你自己的检索命令打开它」，不假装知道那是什么。
 *
 *   配置方式（任一即可）：SOUL_MEMQ / MEMQ
 *     例：SOUL_MEMQ='node /path/to/memq.mjs'
 */
export const MEMQ = String(process.env.SOUL_MEMQ || process.env.MEMQ || '').trim()

/**
 * 算「区间外还有多少条同批归档」—— 门牌只写直接压缩范围时，
 * 读的人会以为被遮的就那一段，按它回取会**静默漏掉**更早的条目。
 *
 * ★ 为什么单独抽成导出函数（2026-10-25，师姐“认不出门牌”的直接根因）：
 *   实测 session-dfc57f53 seq=5865：门牌写「本段覆盖 4812–5305」，
 *   而同一事件的 shadowedSeqs 有 **423 项、起自 4218** —— **237 项在区间外**。
 *   师姐照着门牌回取，要找的东西（4218–4809 那一整段）门牌上根本没提。
 *   ⇒ 她不是不认门牌，是**门牌给的信息不够她做判断**。
 *
 *   ★ 更坑的是原文那句「完整来源见本条 shadowedSeqs」—— 读摘要的人
 *     **看不到事件的 shadowedSeqs 字段**，那句提示只对能读原始事件的人有效。
 *     ⇒ 必须把 min/max/项数**直接写进门牌文本**，不能指望着别人去挖字段。
 *
 * @param {Array<number>} shadowedSeqs 同事件里记录的、被这次归档影响到的全部 seq
 * @param {number} start 直接压缩范围起点
 * @param {number} end   直接压缩范围终点
 * @returns {{extraCount:number, extraMin:number, extraMax:number}|null}
 *          区间外一条都没有 ⇒ null（调用方退回不提这笔的格式）
 */
export function shadowedExtra(shadowedSeqs, start, end) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null
  const nums = []
  for (const v of shadowedSeqs) {
    const n = Number(v)
    if (Number.isFinite(n)) nums.push(n)
  }
  if (nums.length === 0) return null
  const outside = nums.filter((n) => n < start || n > end)
  if (outside.length === 0) return null
  outside.sort((a, b) => a - b)
  return { extraCount: outside.length, extraMin: outside[0], extraMax: outside[outside.length - 1] }
}

/**
 * 把 seq 范围渲染成一小段指针。取不到会话号时退化成没有门牌的一句。
 *
 * @param {string} sid   会话号（自带 `session-` 前缀）；空串表示取不到
 * @param {number} start 本段起始 seq
 * @param {number} end   本段结束 seq
 * @param {Array<number>|{extraCount:number, extraMin?:number, extraMax?:number}} [opts]
 *        第三种形状（2026-10-25 起）：
 *          · 传**数组** = 直接把事件的 `shadowedSeqs` 喂进来，内部算区间外统计；
 *          · 传**对象** = 已算好的 extra（旧契约，`{extraCount}` 就够用）；
 *          · 不传 = 不提这笔（拿不到 shadowedSeqs 时的退路，格式与旧版逐字一致）。
 * @returns {string} 两行：第一行是门牌，第二行是回取说明
 */
export function pointerText(sid, start, end, opts) {
  // ★★ 口径声明（2026-10-23 二轮复核，外部复核 C2）：门牌上的 `seq 起–止` 是
  //   **本次直接压缩的那一段**，不是"被这次压缩影响到的全部条目"。
  //
  //   实测（session-dfc57f53，seq=3837 那条）：`shadowedRange = 2566–3821`，
  //   而同一个事件里的 `shadowedSeqs` 有 **701 项**，其中 **284 项**落在 2566–3821 之外
  //   （最小 1681、最大 3834）—— 更老的条目也被这一批归档了。
  //   ⇒ 只写「本段覆盖 seq 2566–3821」，读的人会以为被遮的就这 1256 条，
  //     按这个范围去回取就会**漏掉那 284 条**。★ 漏是静默的：回取看起来成功了。
  //
  //   ★ 修法（两轮）：
  //     一轮（10-23）改说法：① 明确它是"直接压缩范围"；② 指向同事件的 shadowedSeqs。
  //       —— 但 shadowedSeqs 读摘要的人看不到，那句指向等于没指（10-25 师姐实证）。
  //     二轮（10-25）**把区间外的 min/max/项数直接写进门牌文本**：
  //       见 shadowedExtra 的注释。现在门牌自己就告诉读者「还有更早的，别在这段里找」。
  let extra = null
  if (Array.isArray(opts)) {
    extra = shadowedExtra(opts, start, end)
  } else if (opts && Number(opts.extraCount) > 0) {
    const mn = Number(opts.extraMin)
    const mx = Number(opts.extraMax)
    extra = {
      extraCount: Number(opts.extraCount),
      extraMin: Number.isFinite(mn) ? mn : null,
      extraMax: Number.isFinite(mx) ? mx : null,
    }
  }
  // ★★ 2026-10-25 文案第三轮（外部复核风险清单逐条处理）：
  //   ① 「更早条目」→「**范围外**条目」—— surface 的 seq **不是单调的**（实测有
  //      [10, 4, 30, 12, 40] 这种形状），区间外的条目完全可能比 start 更**大**，
  //      叫"更早"是错的，会把读者引向错误的方向。
  //   ② min/max 标明是**包络**（envelope），不是"连续覆盖 4218–4808 全段"——
  //      中间有大量空洞（实测 237 项散在 4218–4808 之间，不成段）。
  //   ③ 删掉「完整来源见本条 shadowedSeqs」—— 读摘要的人**看不到事件字段**，
  //      那句话只对能读原始事件的人有效，对读者是不可操作的噪音（外部复核原话）。
  const extraDesc = extra
    ? `；另有 ${extra.extraCount} 条范围外条目同批归档` +
      (Number.isFinite(extra.extraMin)
        ? `（包络 seq ${extra.extraMin}–${extra.extraMax}，中间有空洞，不成连续段）`
        : '')
    : ''
  const span = `seq ${start}–${end}（本次直接压缩范围${extraDesc}）`
  if (sid) {
    // ★ 第一行就带指针 —— 和 systemPrompt 里那条门牌要求同构：
    //   一律 `log:<sid>#seq=<起>`（sid 自带 `session-` 前缀），可被 `memq open` 直接消费。
    return [
      `${MARK} · log:${sid}#seq=${start}（本段覆盖 ${span}）`,
      // ★ 有配置才给命令；没配置只给指针 + 说清怎么用（见上面 MEMQ 那段注释）
      MEMQ
        ? `> 回取：\`${MEMQ} open log:${sid}#seq=${start}\``
        : `> 回取：用你自己的检索命令打开下面这个指针 —— \`log:${sid}#seq=${start}\``,
    ].join('\n')
  }
  return [
    `${MARK}　本段覆盖 ${span}。`,
    `> 原文仍在一手层（append-only 会话日志）。会话号取不到，按 seq 找。`,
  ].join('\n')
}

/**
 * 降级式门牌：**拿不到 seq 范围**时用（绝不猜 seq —— 错的门牌比没有更坏）。
 *
 * ★ 注意它**不含 `#seq=`**。doctor 的门牌项正则 `/#seq=(\d+)/` 扫不到它会报 error ——
 *   这是**设计如此**，不是 bug：会话号都取不到时写一条 seq 门牌，等于给后来者
 *   一条指错路的牌子。★ 但它意味着「降级式出现时 doctor 会亮红」，看报告的人
 *   要知道这个红是**降级**而不是**机制坏了**（本文件抽出来就是为了能把它测清楚）。
 */
export function fallbackText(sid) {
  return [
    `${MARK}　${sid ? `会话 ${sid}` : '本会话'}。`,
    `> ★ 本段 seq 范围未取到（手动压缩路径，复原后未通过往返校验，不猜）。`,
    MEMQ
      ? `> 原文仍在 append-only 会话日志；按关键词检索：\`${MEMQ} <关键词>\``
      : `> 原文仍在 append-only 会话日志；按关键词检索你自己那套（本插件不知道它叫什么）。`,
  ].join('\n')
}
