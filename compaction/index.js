/**
 * dsh-agent-compaction —— 给兜底压缩装上「门牌」
 * ================================================
 *
 * ★ 为什么要有这个包
 * ------------------
 * DSH 的上下文压缩有两条路：
 *   ① ACP（billion-context-dsh）—— 模型驱动，摘要**我自己写**，因此天然带指针；
 *   ② compaction-basic（DSH 内置）—— **自动兜底**，在我没响应 nudge 时出手。
 *
 * 确认：这份兜底压出来的 checkpoint 无法回溯。原因在它那段硬编码
 * 指令（`@deepseek-ai/dsh-compaction-basic` lib/index.js:220-255）——
 * 它要求保留 exact file paths / commands / error strings / numeric values /
 * function signatures，**但通篇没有一句要求标注「这话从哪来」**。
 * 它写出来的东西每一条都对，每一条都无从核对。
 *
 * 而记忆架构里只有一条硬规矩：**摘要只能是索引，不能是记忆本体**
 * （见本包 README 的「门牌」一节）。
 * 所以兜底不能停在「写得好」，它得**写得出门牌**。
 *
 * ★ 做法：不重写 LLM 调用、不碰落盘策略，只加一段指针
 * ----------------------------------------------------
 * 三步：
 *   1. 覆盖 `compactRegion` —— 它参数里就有 start/end seq，先记下来再交给 super；
 *   2. 覆盖 `summarize`    —— 调 super 拿到摘要，然后在**最前面**插一个 text block；
 *   3. 全程兜底：任何一步出错都降级成「没加指针」，**绝不让压缩本身失败**。
 *
 * ★ 每条判据都读过源码，不是猜的（照「没验过的不写」）
 * --------------------------------------------------
 *  - `lib/types/index.d.ts:20`   「`summarize()` is the sole subclass customization hook;
 *                                  the replay and durable mutation strategy stays fixed」
 *                                ⇒ 继承类是被设计支持的，且只需动这一处
 *  - `lib/types/index.d.ts:34-38` 「`compactIfNeeded` stays dynamically dispatched so
 *                                  subclass overrides are honored at event time」
 *                                ⇒ 覆盖在事件发生时一定被采纳
 *  - `lib/index.js:975`          `summarize: (input, owner, abort) => this.summarize(...)`
 *                                ⇒ 覆盖 `this.summarize` 就是覆盖 dependencies.summarize
 *  - `lib/index.js:542-562`      `prepared` 里有 `start` / `end` / `shadowedSeqs`
 *  - `lib/index.js:666-675`      `buildSummarizationInput` 把 seq 映射成 messages 后就丢了，
 *                                `SummarizationInput` 只有 `{tools, messages}`
 *                                ⇒ **摘要模型看不到 seq，所以指针必须由外面补**
 *  - `lib/index.js:572`          `if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw`
 *                                ⇒ 摘下来的必须比原文小；所以指针块要极短（见下面 SIZE 的权衡）
 *  - `dsh-session/lib/types/index.d.ts:121`  `get id(): SessionId`
 *  - `dsh-agent/lib/types/runtime-types.d.ts:143`  `readonly session: Session`
 *                                ⇒ `agent.session.id` 就是门牌上的会话号
 *
 * ★★ 补：手动 `/compact` 那条路也修好了
 * ----------------------------------------------------
 * 上面第 1 步只覆盖了 `compactRegion`，而 `lib/index.js:930` 的 `compactRegion` 只被
 * **自动路径**调用（`compactIfNeeded` 的 `:893` 与 `:915`）。
 * **手动 `/compact` 走 `compactNow`（`:944-970`），它在 `:953` 直调模块私有的
 * `compactSurfaceRegion`（`:433`），根本不经过 `compactRegion`** ⇒ `#range` 是 null。
 *
 * 想覆盖 `compactNow` 是死路：`selectCompactableRange`（`:393`）与 `compactSurfaceRegion`
 * 都**没有导出**（`:980` 只导出 `BasicCompactionEngine`）。
 * ⇒ 改为**在 `summarize` 里把范围复原出来**：`compactNow` 在 `:951` 用的是
 * `selectCompactableRange(session, meter.measure(session), 0)`，而 `retainTokens = 0`
 * 把 `:400-405` 那个累加循环**退化成「第一次迭代就 break」**，
 * 于是 `keepFromIdx` 恒等于 `pricedNodes.length - 1`，`end = surfaceNodes[length - 2]`。
 * 剩下的只有 `start`：`:398` 的 `firstIdx` 只可能是 0 或 1。**两个候选都试，用内容自检定夺。**
 *
 * ★★★ 自检是这一版的命门 —— 「错的门牌比没有更坏」
 * ------------------------------------------------
 * 复原出来的范围**必须通过往返校验**才会被采用：
 *   `input.messages` 的末条应当等于 `session.deriveEventMessage(session.eventAt(end))`；
 *   首条（或次条，system 头占位）应当等于 `...eventAt(start)` 的文本。
 * 对不上就**丢掉门牌、退回降级式**。宁可只说「会话号 + 检索入口」，也不写一个会引我去翻无关原文的 seq。
 *
 * ★ 指针为什么长这样
 * ----------------
 * 指针形如
 *   `log:session-5c6fa2d9-19d8-4bc2-b9e3-35008a5e1340#seq=8405`
 * 而 `agent.session.id` 的值正好是 `session-5c6fa2d9-...`，一字不差 —— 所以拼得出来。
 * 事后用你自己的检索入口打开它即可：
 *   <你的检索命令> log:<会话>#seq=<起点>
 *
 * ★ 本包只负责【写指针】，不规定你用什么工具去【回取】。
 *   换一套检索系统也能用 —— 只要它认 `log:<会话>#seq=<n>` 这种形式。
 *
 * ★ SIZE：指针块有多大，为什么不担心把压缩压失败
 * --------------------------------------------
 * 第 572 行那个检查要求「框好的摘要 < 被遮蔽原文」。指针块约 60–90 token，
 * 而压缩比常态在 10:1 上下 —— 影响不到 3%。真正危险的是压缩比本来就接近 1:1，
 * 那种情况**不加指针也一样会抛**，所以指针不是把「本来成功」变成「失败」的原因。
 * 仍然保留 try/catch：出错就原样返回，让兜底照常工作。
 *
 * @module dsh-agent-compaction
 */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'


// ★★ 门牌（回取指针）2026-10-23 抽到 lib/doorsign.js —— 抽走的原因必须留在这里：
//
//   本文件顶部 import 的 `@deepseek-ai/dsh-compaction-basic` 与 `@deepseek-ai/dsh-compaction`
//   是**宿主运行时注入的 bundle，磁盘上根本没有这个包**。后果是：
//   任何 `import('./index.js')` 都直接 `Cannot find package` ⇒ **门牌逻辑永远无法单测**。
//
//   ★ 这正是本文件里那句「自动兜底那条路仍未验」的**结构性根因** ——
//     不是不想验，是结构上验不了：一个只能靠真机压缩才能触发的函数，
//     而真机压缩要等上下文涨到阈值（实测：全库 9 条摘要，接管后 0 条）。
//
//   抽走之后：lib/doorsign.js 零 import、零宿主依赖 ⇒ test/doorsign.mjs 可直接单测；
//   **本文件运行期行为逐字不变**（纯搬运，未改任何逻辑）。
import { MARK, MEMQ, pointerText, fallbackText, captureShadowed, sameSelection } from './lib/doorsign.js'
// ★ 2026-10-25：摘要请求体瘦身。理由见 lib/strip.js 顶部（请求体过大 ⇒ 回包前被掐断
//   ⇒ TRANSPORT）。纯函数：无 reasoning 且未超预算时是 no-op。
import { slimMessages } from './lib/strip.js'
// ★ 诊断期临时用（2026-10-25，定位"门牌静默消失"；定位后连同各处 _dbg 一起删）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 摘要请求体瘦身预算 ──
 * 150,000 字符 ≈ 75K token：对齐已知能成功的那次（某会话 Compacted 102 items ~69,672 tokens）。
 * 超了就交给 slimMessages 自动收紧（它会逐档降低单串上限，并保住最后 SLIM_TAIL_KEEP 条）。
 * 数值是经验值，不是精确阈值 —— 想调就改这两行，不需要动逻辑。
 */
const SLIM_TARGET_CHARS = 150_000
const SLIM_TAIL_KEEP = 12

/* ── 失败诊断：主策略失败后自动降档重试（2026-10-25）──
 *
 * 为什么：某会话压缩恒失败，`SUPER_THREW` 显示 `TRANSPORT / cause=null`，且
 * **从 SLIM 完成到抛错只有 81 毫秒** —— 网络往返不可能这么快，说明请求在
 * 本地准备阶段就被拒了。要判断"到底多小才够 / 是不是内容本身的问题"，
 * 靠反复重启逐次试太慢，所以一次压缩内自动降档（每档都是一次真实请求）。
 *
 * 判读方式：
 *   · 某一档成功            → 就是量的问题，取该档作为以后的默认预算
 *   · 连 2K 字符都失败      → 不是内容量/内容本身 ⇒ 问题更底层（provider / 会话 / 宿主）
 *   · 连去掉 tools 都失败    → 排除工具定义，落到上一条
 *
 * 只在第一档失败后才继续，正常会话不会多花请求。
 */
const DIAG_ATTEMPTS = [
  { name: 'slim-150k', targetChars: SLIM_TARGET_CHARS, tailKeep: SLIM_TAIL_KEEP },
  { name: 'slim-20k', targetChars: 20_000, tailKeep: 4 },
  { name: 'slim-2k', targetChars: 2_000, tailKeep: 2 },
  { name: 'slim-2k-no-tools', targetChars: 2_000, tailKeep: 2, dropTools: true },
]

// ════════════════ 手动路径的范围复原（外部可单测） ════════════════

/** 从一个派生出来的 Message 里取纯文本；取不到返回 null。 */
export function msgText(message) {
  if (message === null || message === undefined || typeof message !== 'object') return null
  const content = message.content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/** seq → 该节点派生出的消息文本；任何一步不成立都返回 null（调用方据此降级）。 */
function textAtSeq(session, seq) {
  try {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) return null
    return msgText(session.deriveEventMessage(event))
  } catch {
    return null
  }
}

/**
 * 复原手动 `/compact`（`compactNow`）将要压的 seq 范围。
 *
 * 依据（`@deepseek-ai/dsh-compaction-basic` lib/index.js）：
 *  - `:951` `selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0)`
 *  - `:400-405` `retainTokens = 0` ⇒ 累加循环第一次迭代即 break ⇒ `keepFromIdx = length - 1`
 *  - `:407-410` 从 `keepFromIdx` 往回退，直到 `toolPairingBalancedBefore` 成立
 *  - `:398` `firstIdx` 只可能是 0（无 system 头）或 1（有）
 *  - `:412-415` 返回 `{ start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }`
 *
 * ★ `systemHead` 已照源码复刻（basic `lib/index.js:379-381` 就一句：
 *   `return head.type === "system/message" ? head : void 0;`），所以 `firstIdx` 是**算出来的、不是猜的**。
 * ★ 最后仍有**往返校验**兜底：`input.messages` 的末条必须由 `end` 派生、首条（或次条，
 *   `buildSummarizationInput` 会把 system 头拼在最前）必须由 `start` 派生。
 *   对不上就返回 null —— **宁可退回降级式，也不写一个会引我去翻无关原文的 seq**。
 *
 * @param agent - 拥有目标 session 的 agent。
 * @param input - `SummarizationInput`，即 `{ tools?, messages }`。
 * @param deps - 仅供单测注入 `{ toolPairingBalancedBefore }`；生产路径省略即用官方实现。
 * @returns `{ start, end }` 或 `null`（拿不准一律 null）。
 */
export function recoverManualRange(agent, input, deps) {
  try {
    const session = agent !== null && agent !== undefined ? agent.session : null
    if (session === null || session === undefined) return null
    const surface = session.surface
    if (surface === null || surface === undefined) return null
    const surfaceNodes = surface.nodes
    if (!Array.isArray(surfaceNodes) || surfaceNodes.length < 3) return null

    const messages = input !== null && input !== undefined && Array.isArray(input.messages) ? input.messages : []
    if (messages.length === 0) return null

    const balancedBefore =
      deps !== null && deps !== undefined && typeof deps.toolPairingBalancedBefore === 'function'
        ? deps.toolPairingBalancedBefore
        : toolPairingBalancedBefore

    // retainTokens = 0 ⇒ 起点恒为最后一个索引（第一次迭代就 break）
    let keepFromIdx = surfaceNodes.length - 1
    const floor = 0
    while (keepFromIdx > floor) {
      if (balancedBefore(session, surfaceNodes[keepFromIdx])) break
      keepFromIdx -= 1
    }
    if (keepFromIdx <= floor) return null

    // 复刻 systemHead：只决定 firstIdx 是 0 还是 1
    let firstIdx = 0
    try {
      const headEvent = session.eventAt(surfaceNodes[0])
      if (headEvent !== null && headEvent !== undefined && headEvent.type === 'system/message') firstIdx = 1
    } catch {
      firstIdx = 0
    }
    if (keepFromIdx <= firstIdx) return null

    // 宽松校验：shadowedSeqs 里若有节点不投影成 message，messages 只会更短，绝不会更长
    if (messages.length > keepFromIdx) return null

    const startSeq = surfaceNodes[firstIdx]
    const endSeq = surfaceNodes[keepFromIdx - 1]

    // ★ 往返校验：末条对应 end
    const endText = textAtSeq(session, endSeq)
    if (endText === null || msgText(messages[messages.length - 1]) !== endText) return null

    // ★ 往返校验：首条或次条对应 start（次条命中 = system 头占了首位）
    const startText = textAtSeq(session, startSeq)
    if (startText === null) return null
    const hitFirst = msgText(messages[0]) === startText
    const hitSecond = messages.length > 1 && msgText(messages[1]) === startText
    if (!hitFirst && !hitSecond) return null

    return { start: startSeq, end: endSeq }

  } catch {
    return null
  }
}

export default class YanqingCompaction extends BasicCompactionEngine {
  /**
   * 本次被压缩的 seq 范围。只在 compactRegion 的调用栈里有效，
   * 出栈即清空 —— 免得下一次 summarize 用错门牌。
   *
   * ★★★ 踩过的坑：这里原来写的是 `#range`（真私有字段），**绝不能那样写**。
   * preset 里这一行带着 `isolate: { compaction: true }`，cordis 的 realm 会把插件实例包成
   * **Proxy** 再交出去（`this` 是 Proxy，不是那个类的实例），而**私有字段的 brand check
   * 对 Proxy 一律失败** —— 一读就抛：
   *   `Cannot read private member #range from an object whose class did not declare it`
   * 现场就在会话日志的 `compaction/end` 里（一次手动 `/compact`）。
   *
   * 后果分两层，都很坏：
   *   · 旧版把这个读取放在 `summarize` 的 try **内部** ⇒ 抛错被 catch 吞掉 ⇒
   *     **压缩照常成功、门牌静默丢失**（20:30 探针那次「压通了但没门牌」就是它）；
   *   · 一旦这个读取被挪到 try 外面（哪怕只是写进诊断的参数里），
   *     同一个 bug 就升级成**压缩直接失败**。
   *
   * ⇒ 在 realm 里只能用**普通属性**：Proxy 会把 get/set 转发到 target。
   *   不能用 `#private`；也不能用 WeakMap —— Proxy 与 target 是两个对象，按对象取键一样落空。
   */
  __yqRange = null

  /**
   * 记下范围再交回去。**不动 super 的任何行为** —— 落盘、定价、边界校验都原样。
   * 这里只做一件事：把调用方知道、而 summarize 拿不到的 seq 留下来。
   */
  async compactRegion(start, end, agent, signal) {
    this.__yqRange = { start, end }
    try {
      return await super.compactRegion(start, end, agent, signal)
    } finally {
      this.__yqRange = null
    }
  }

  /**
   * 先让兜底照常工作，再在它的成果前面加一块门牌。
   * ★ 顺序不能反：先 super（该抛的让它抛），再加。加的部分单独兜底。
   */
  async summarize(input, agent, signal) {
    // 可选诊断：把每一步落盘到 debug 日志（DSH_COMPACTION_DEBUG_LOG 可覆盖路径，默认 ~/.dsh/compaction-debug.log）。
    //   仅用于排查门牌生成失败；写入失败被 try/catch 吞掉，不影响主流程。
    const _dbg = (label, extra) => {
      try {
        fs.appendFileSync(process.env.DSH_COMPACTION_DEBUG_LOG
          || path.join(os.homedir(), '.dsh', 'compaction-debug.log'),
          new Date().toISOString() + ' ' + label + ' ' + (() => { try { return JSON.stringify(extra) } catch { return String(extra) } })() + '\n')
      } catch { /* 诊断失败不影响主流程 */ }
    }
    let _dbgBefore = null
    try {
      _dbg('ENTER', {
        yqRange: this.__yqRange,
        inputKeys: input && typeof input === 'object' ? Object.keys(input) : typeof input,
        messagesIsArray: !!(input && Array.isArray(input.messages)),
        messagesLen: input && Array.isArray(input.messages) ? input.messages.length : null,
        hasAgentSession: !!(agent && agent.session),
        sid: agent && agent.session ? String(agent.session.id) : null,
      })
    } catch { /* 诊断自身失败就放弃，不影响主流程 */ }

    // ★★ 2026-10-25（外部复核方案 A）：在 await **之前**取本次快照。
    //   为什么必须在 await 前：等待摘要期间 surface 可能变（新事件、别的会话压完），
    //   事后再取就未必是"本次选区"了。每次重试都会重新进这个函数 ⇒ 快照也会重新取。
    let before = null
    try {
      const range = this.__yqRange === null ? recoverManualRange(agent, input) : this.__yqRange
      _dbg('RANGE', { range, yqRangeNull: this.__yqRange === null })
      before = captureShadowed(agent, input, range)
      _dbgBefore = before
      _dbg('BEFORE', before === null ? null : { sid: before.sid, start: before.start, end: before.end, seqs: before.shadowedSeqs.length })
    } catch (e) {
      _dbg('BEFORE_THREW', { message: e && e.message, stack: String(e && e.stack).slice(0, 400) })
      /* 取不到不猜，走降级 */
    }

    // ★★ 2026-10-25：摘要请求体瘦身 + 失败降档诊断。
    //   实测某会话 `input.messages` 691,717 字符：text 42.7% / tool-call 36.9% /
    //   reasoning 20.3%。只剥 reasoning 降 20% 无效；压到 141K（≈师姐成功的 70K token 量级）
    //   仍然失败，且 `SUPER_THREW` 显示 **SLIM 完成到抛错只隔 81 毫秒** ⇒ 不是网络、不是体积。
    //   所以改成「一次压缩、多档重试」，把"多小才够 / 是不是内容本身的问题"一次问清。
    //   ★ 只改「传给 super 的 input」；captureShadowed 仍用**原始** input 作比对基准，
    //     否则 before/after 的深度相等校验会因为被瘦身而恒不等、门牌全部降级。
    // ★★ 宿主会把详细失败折叠成一句「Compaction could not produce a useful summary」，
    //   真正的错误只在这里看得到。所以先记全再**原样抛出**（行为不变，只是看得见了）。
    let result
    let lastErr = null
    let ok = false
    for (let ai = 0; ai < DIAG_ATTEMPTS.length; ai++) {
      const a = DIAG_ATTEMPTS[ai]
      let inp = input
      let slimmed = null
      try {
        const sb = slimMessages(input && input.messages, {
          targetChars: a.targetChars,
          tailKeep: a.tailKeep,
        })
        slimmed = sb
        inp = a.dropTools
          ? { messages: sb.messages }
          : (sb.totalAfter < sb.totalBefore ? { ...input, messages: sb.messages } : input)
      } catch (e) {
        _dbg('ATTEMPT_PREP_THREW', { i: ai, name: a.name, message: e && e.message })
      }
      try {
        result = await super.summarize(inp, agent, signal)
        ok = true
        _dbg('ATTEMPT_OK', {
          i: ai, name: a.name, dropTools: !!a.dropTools,
          totalAfter: slimmed ? slimmed.totalAfter : null,
          replacedBlocks: slimmed ? slimmed.replacedBlocks : null,
        })
        break
      } catch (e) {
        lastErr = e
        let cause = null
        try {
          const c = e && e.cause
          cause = c ? { name: c.name, message: c.message, code: c.code, status: c.status } : null
        } catch { /* 取 cause 失败不能影响重试 */ }
        _dbg('ATTEMPT_FAIL', {
          i: ai, name: a.name, dropTools: !!a.dropTools,
          totalAfter: slimmed ? slimmed.totalAfter : null,
          replacedBlocks: slimmed ? slimmed.replacedBlocks : null,
          name_: e && e.name, message: e && e.message, code: e && e.code, cause,
          stack: String(e && e.stack).slice(0, 500),
        })
      }
    }
    if (!ok) throw lastErr || new Error('compaction summarize failed (no error captured)')
    _dbg('SUPER_RETURN', {
      resultNull: !result,
      summaryIsArray: !!(result && Array.isArray(result.summary)),
      summaryLen: result && Array.isArray(result.summary) ? result.summary.length : null,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : typeof result,
    })
    if (!result || !Array.isArray(result.summary) || result.summary.length === 0) {
      _dbg('EARLY_RETURN_NO_SUMMARY', null)
      return result
    }

    try {
      // 等待摘要期间选区可能变过 —— 再取一次，两次一致才认（外部复核的"两次快照"设计）。
      // ★ 判断本身收在 lib/doorsign.js 的 sameSelection 里，本文件不直接引用
      //   isDeepStrictEqual —— 2026-10-25 就是"挪走了一半 import"导致 ReferenceError、
      //   门牌静默消失（见 sameSelection 的注释）。
      const after = before && captureShadowed(agent, input, before)
      const verified = sameSelection(after, before)
      _dbg('VERIFIED', { beforeNull: before === null, afterNull: after === null, verified })

      let sid = ''
      try {
        const raw = agent && agent.session ? agent.session.id : ''
        sid = raw === undefined || raw === null ? '' : String(raw)
      } catch {
        // 取不到会话号不是错误 —— 退化成按关键词检索
        sid = ''
      }

      // ★ 两条路，两种拿范围的方式（**已在 await 之前统一取过一次**，见 summarize 开头）：
      //   · 自动兜底（pressure / overflow）走官方 `this.compactRegion(...)`
      //     （dsh-compaction-basic/lib/index.js:893 与 :915）⇒ 我覆盖了它 ⇒ __yqRange 就是精确的
      //   · 手动 `/compact` 走官方 `compactNow`，它**直调模块私有的 compactSurfaceRegion**
      //     （:953），不经过我覆盖的 compactRegion ⇒ __yqRange 是 null
      //     ★ 于是现场**复原**一次（recoverManualRange），并用往返校验确认；
      //     复原不出来就退回降级式 —— **绝不猜 seq**，错的门牌比没有更坏。
      //   ★ 已验证：手动路径端到端验通 —— 门牌插进 `compaction/summary`
      //     的第一个 block，且那段门牌能用 `memq open` 打开一手原文（会话 session-3c7f289d，
      //     范围 {start:10, end:15}）。自动兜底那条路仍未验。
      // ★★ 2026-10-25 收官（外部复核方案 A 落地，替换上面那段"数据通路是断的"注释）：
      //
      //   区间外信息的来源 = **自己从 surface 复刻 + 完整消息结构比对**（captureShadowed）。
      //   为什么不用 result.shadowedRange / result.shadowedSeqs：宿主 `summarizeWithLlm`
      //   根本不返回它们（落盘前才补进事件 data）—— 当天 asar 实证，两条"看起来能走"的
      //   路（super 返回值 / input.messages）都因时序或投影丢 seq 而断。
      //
      //   ★ verified = await 前后两次快照一致（选区没在等待期间变、会话没串），
      //     且每次都快照都通过了「重建 messages 与 input.messages 逐字节相等」。
      //     **任一不过 ⇒ 降级式门牌**，不声称精确范围 —— 外部复核：错的门牌比没有更坏。
      //   ★ shadowedSeqs **不加进返回对象**（宿主合并结果时可能覆盖它自己准备好的字段），
      //     只作为生成门牌的局部数据。
      //   ★ 遗留（外部复核风险清单第 5 条）：`__yqRange` 是实例级单槽，一个实例服务多个
      //     会话时会互相覆盖。当前靠 captureShadowed 的比对兜底（range 错 ⇒ 比对失败
      //     ⇒ 降级），**不会出错误牌**，但会白白降级。彻底修法是把 __yqRange 改成按
      //     会话存（Map）—— 记账，未做。
      const text = verified
        ? pointerText(before.sid, before.start, before.end, before.shadowedSeqs)
        : fallbackText(sid)

      return { ...result, summary: [{ type: 'text', text }, ...result.summary] }
    } catch (e) {
      // ★ 绝不因为「加不上门牌」让压缩失败 —— 兜底的职责是先兜住
      // ★★ 2026-10-25 外部复核抓到：这里原来是 `catch {` 却用了 `e` ⇒ 真异常时
      //   诊断语句自己再抛一次，把"门牌失败"升级成"压缩失败"—— 兜底反被兜底干掉。
      //   ★ 同类教训：catch 里写的每一行都必须是"不会抛"的；不确定就再包一层 try。
      _dbg('OUTER_THREW', { message: e && e.message, stack: String(e && e.stack).slice(0, 600) })
      return result
    }
  }
}
