/**
 * strip.js —— 摘要请求体瘦身：摘掉 reasoning（思维链）block。
 *
 * ── 为什么需要它（2026-10-25 实测，不是推测）──
 *
 * 示例会话的 /compact 失败，报 `Compaction could not produce a useful summary.`
 * 会话日志里 `compaction/end.error` = `DeepSeek Messages transport failed`（code=TRANSPORT，
 * 即「拿到 HTTP 响应之前」就断了，重试 5 次全败）。
 *
 * 宿主诊断点显示我们的 override **正常进入、位置范围也取到了**，然后就卡在
 * `await super.summarize()` 里 —— 那段是调模型。所以不是门牌逻辑的问题。
 *
 * 按「事件原始体积」统计那次压缩范围（seq 55561–56011）：
 *
 *     assistant/message   770,191 字符   68.5%   ← 大头是 reasoning
 *     user/message        118,021       10.5%
 *     tool/call            69,369        6.2%
 *     tool/result          24,760        2.2%   ← 工具结果其实很小
 *     合计              1,123,839       ≈562K token
 *
 * ⇒ 摘要请求把大段思维链原样重放给模型，请求体过大，在回包前被中间层掐断。
 *   （这就是 summarizer replay overflow：摘要把大段思维链重放给模型、请求体过大、在回包前被中间层掐断。官方口径里
 *    上下文超限会报 CONTEXT_WINDOW_EXCEEDED；报 TRANSPORT 说明响应根本没回来。）
 *
 * ── 为什么摘掉是安全的 ──
 *
 * reasoning 是模型**思考时的草稿**，不是对话内容。摘要要复述的是「说了什么、
 * 定了什么、卡在哪」，这些都在 text / tool_use / tool_result 里。去掉草稿：
 *   ① 请求体大幅下降（本例约 −68%）
 *   ② 摘要不会被思维链里的推演过程污染
 *
 * ── 边界 ──
 *   · 纯函数，不抛错。输入不是数组时原样返回（removedBlocks=0）。
 *   · **没有 reasoning 时是 no-op** —— 正常会话不受任何影响。
 *   · 某条消息摘完会变空（内容只有 reasoning）时，放一个极短占位 `(reasoning omitted)`，
 *     避免「空 content」被上游 API 拒绝；这行字进摘要也无害。
 *   · 只动 `type` 字段判定，不碰 tool_use / tool_result 的配对关系。
 */

/** 视为「思维链草稿」的 block 类型。 */
const REASONING_TYPES = new Set(['reasoning', 'thinking', 'redacted_reasoning'])

/**
 * 统计 messages 里各类 block 的字符量。只读，用于诊断与前后对比。
 * @param {unknown} messages
 * @returns {{ total: number, reasoning: number, byType: Record<string, number>, blocks: number }}
 */
export function measureBlocks(messages) {
  const out = { total: 0, reasoning: 0, byType: {}, blocks: 0 }
  if (!Array.isArray(messages)) return out
  for (const m of messages) {
    const content = m && typeof m === 'object' ? m.content : null
    if (!Array.isArray(content)) {
      // 有的实现 content 是纯字符串
      if (typeof content === 'string') {
        out.total += content.length
        out.byType.string = (out.byType.string || 0) + content.length
        out.blocks += 1
      }
      continue
    }
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const t = String(b.type || 'unknown')
      const n = blockChars(b)
      out.blocks += 1
      out.total += n
      out.byType[t] = (out.byType[t] || 0) + n
      if (REASONING_TYPES.has(t)) out.reasoning += n
    }
  }
  return out
}

/** 估一个 block 的字符量（text 用正文；其它用序列化长度）。 */
function blockChars(b) {
  if (typeof b.text === 'string') return b.text.length
  try {
    return JSON.stringify(b).length
  } catch {
    return 0
  }
}

/**
 * 递归截断过长的字符串值。
 *
 * 为什么用「通用截断」而不是按字段名裁：
 * 我们**不能确定** `tool-call` block 的字段名（`input` / `args` / `arguments` 都可能），
 * 按名裁一旦猜错就是空操作、而且错得没有声音。改成：任何字符串超过 cap 就截断，
 * 保留头部 + 一个明确的截断标记。结构（键名、id、类型）全部不动，
 * 所以 tool_use / tool_result 的配对关系不可能被破坏（配对靠 id）。
 *
 * @param {unknown} node
 * @param {number} cap 单个字符串保留的最大字符数
 * @param {Set<string>} skipKeys 这些键不做截断（都是短标识，截了只会坏事）
 * @returns {unknown} 新对象（不改入参）
 */
const SKIP_KEYS = new Set([
  'type', 'id', 'name', 'role', 'callId', 'call_id', 'tool_use_id', 'tool_call_id', 'toolUseId',
])

/**
 * 安全截断：不要在 surrogate pair 中间切。
 *
 * 2026-10-25 追加。用 `slice(0, cap)` 直接切，如果切口正好落在 emoji / 罕见字的
 * 代理对中间（高位 0xD800–0xDBFF + 低位 0xDC00–0xDFFF），就会留下**孤立代理**——
 * 这种字符串无法编码成合法 UTF-8，`fetch` 在构造请求体时可能直接抛错，
 * 而外层看到的正是 `TRANSPORT`（拿到响应之前就失败）。
 * 这条无法确证是不是主因，但它是明确的缺陷，先修掉再谈别的。
 */
function safeSlice(s, cap) {
  if (s.length <= cap) return s
  let cut = cap
  const c = s.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1 // 别把高位代理单独留下
  return s.slice(0, cut)
}

function truncateDeep(node, cap, skipKey = false) {
  if (typeof node === 'string') {
    if (skipKey || node.length <= cap) return node
    const head = safeSlice(node, cap)
    return head + `\n…(truncated, ${node.length - head.length} chars omitted)`
  }
  if (Array.isArray(node)) return node.map((x) => truncateDeep(x, cap, false))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = truncateDeep(v, cap, SKIP_KEYS.has(k))
    }
    return out
  }
  return node
}

/**
 * 把「摘要用不到、又可能让请求构造失败」的块类型换成纯文本占位。
 *
 * 2026-10-25 追加。诊断显示某会话的 `input.messages` 里有 `image` 块（虽然只占 276 字符）。
 * 摘要请求要的是「说了什么、定了什么」，不需要图片本身；而带媒体块的消息在部分
 * 接口上会被拒绝（或需要完全不同的 payload 形状）。**哪怕它只有 276 字节，
 * 也可能让整个请求在构造阶段就被拒** —— 实测那个会话的失败特征正是
 * 「SLIM 完成到抛错只隔 81 毫秒」，属于请求没发出去就死了。
 *
 * 做法：只保留摘要真正需要的类型，其余（image / audio / file / 未知类型）
 * 一律替换成 `(type omitted for summarization)`。结构仍是合法消息，体积更小。
 */
const SUMMARY_SAFE_TYPES = new Set([
  'text', 'reasoning', 'thinking', 'redacted_reasoning',
  'tool-call', 'tool-result', 'tool_use', 'tool_result',
])

export function simplifyBlocks(messages) {
  const stats = { messages, replaced: 0, byType: {} }
  if (!Array.isArray(messages)) return stats

  let anyTouched = false
  const out = []
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    let touched = false
    const kept = []
    for (const b of m.content) {
      if (!b || typeof b !== 'object') {
        kept.push(b)
        continue
      }
      const t = String(b.type || '')
      if (t && SUMMARY_SAFE_TYPES.has(t)) {
        kept.push(b)
        continue
      }
      touched = true
      anyTouched = true
      stats.replaced += 1
      stats.byType[t || '(empty)'] = (stats.byType[t || '(empty)'] || 0) + 1
      kept.push({ type: 'text', text: `(${t || 'unknown'} omitted for summarization)` })
    }
    out.push(touched ? { ...m, content: kept } : m)
  }
  if (anyTouched) stats.messages = out
  return stats
}

/**
 * 预算式瘦身：先剥 reasoning → 再把异类块换成占位 → 最后按预算自动降低字符串上限。
 *
 * 背景：剥离 reasoning 只降了 20%（实测 691,717 → 551,134 字符），仍然 TRANSPORT。
 * 剩下的大头是 `text` 与 `tool-call`，都是内容 —— 用户裁决「伤点摘要影响不大，
 * 压缩后都会好的」，所以这里允许截断正文。
 *
 * ★ 保底：最后 tailKeep 条消息**不裁**，保证紧邻的上下文完整连贯。
 *
 * @param {unknown} messages
 * @param {{targetChars?: number, tailKeep?: number}} opts
 * @returns {{ messages: unknown, removedReasoning: number, replacedBlocks: number,
 *             cap: number|null, totalBefore: number, totalAfter: number, truncatedChars: number }}
 */
export function slimMessages(messages, opts = {}) {
  const targetChars = Number.isFinite(opts.targetChars) ? opts.targetChars : 150_000
  const tailKeep = Number.isFinite(opts.tailKeep) ? opts.tailKeep : 12

  const totalBefore = measureBlocks(messages).total

  // ① 剥 reasoning（无 reasoning 时是 no-op）
  const s1 = stripReasoning(messages)
  // ② 异类块换占位（无 image/audio 等时是 no-op）
  const s2 = simplifyBlocks(s1.messages)
  let cur = s2.messages
  let total = measureBlocks(cur).total

  const base = {
    removedReasoning: s1.removedChars,
    replacedBlocks: s2.replaced,
    totalBefore,
  }

  if (!Array.isArray(cur) || total <= targetChars) {
    return { ...base, messages: cur, cap: null, totalAfter: total, truncatedChars: 0 }
  }

  // ③ 按档位逐步收紧，找到第一个达标的
  const CAPS = [4000, 2000, 1000, 600, 400, 250, 150, 90, 50]
  let best = null
  for (const cap of CAPS) {
    const head = cur.slice(0, Math.max(0, cur.length - tailKeep))
    const tail = cur.slice(Math.max(0, cur.length - tailKeep))
    const trial = [...head.map((m) => truncateDeep(m, cap)), ...tail]
    const t = measureBlocks(trial).total
    best = { messages: trial, total: t, cap }
    if (t <= targetChars) break
  }

  return {
    ...base,
    messages: best.messages,
    cap: best.cap,
    totalAfter: best.total,
    truncatedChars: Math.max(0, total - best.total),
  }
}

export function stripReasoning(messages) {
  const stats = { messages, removedBlocks: 0, removedChars: 0, emptied: 0 }
  if (!Array.isArray(messages)) return stats

  const out = []
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    const kept = []
    let touched = false
    for (const b of m.content) {
      if (b && typeof b === 'object' && REASONING_TYPES.has(String(b.type || ''))) {
        stats.removedBlocks += 1
        stats.removedChars += blockChars(b)
        touched = true
        continue
      }
      kept.push(b)
    }
    if (!touched) {
      out.push(m)
      continue
    }
    if (kept.length === 0) {
      // 摘完变空：放个极短占位，避免空 content 被上游拒
      stats.emptied += 1
      out.push({ ...m, content: [{ type: 'text', text: '(reasoning omitted)' }] })
    } else {
      out.push({ ...m, content: kept })
    }
  }
  stats.messages = out
  return stats
}
