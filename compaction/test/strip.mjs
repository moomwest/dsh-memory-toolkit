// strip.js 单测：摘要请求体瘦身（摘 reasoning）
// 跑法：node test/strip.mjs

import assert from 'node:assert/strict'
import { measureBlocks, stripReasoning, slimMessages, simplifyBlocks } from '../lib/strip.js'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300))
  }
}

// ── measureBlocks ──
console.log('measureBlocks')

ok('非数组 ⇒ 全 0', (() => {
  const r = measureBlocks(null)
  return r.total === 0 && r.reasoning === 0 && r.blocks === 0
})())

ok('空数组 ⇒ 全 0', (() => {
  const r = measureBlocks([])
  return r.total === 0 && r.reasoning === 0
})())

{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'AAAA' },
      { type: 'text', text: 'BB' },
    ] },
  ]
  const r = measureBlocks(msgs)
  ok('统计 text 与 reasoning 分开', r.reasoning === 4, r)
  ok('total 含全部 block', r.total === 2 + 4 + 2, r)
  ok('byType 有 reasoning / text', r.byType.reasoning === 4 && r.byType.text === 4, r.byType)
  ok('blocks 计数正确', r.blocks === 3, r)
}

{
  const r = measureBlocks([{ role: 'user', content: 'plain string' }])
  ok('content 是字符串也能计', r.total === 12 && r.byType.string === 12, r)
}

// ── stripReasoning ──
console.log('\nstripReasoning')

ok('非数组 ⇒ 原样返回，removedBlocks=0', (() => {
  const r = stripReasoning(undefined)
  return r.messages === undefined && r.removedBlocks === 0
})())

{
  // 没有 reasoning ⇒ 必须是 no-op（正常会话完全不受影响）
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
  ]
  const before = JSON.stringify(msgs)
  const r = stripReasoning(msgs)
  ok('无 reasoning ⇒ 内容不变', JSON.stringify(r.messages) === before)
  ok('无 reasoning ⇒ removedBlocks=0', r.removedBlocks === 0)
}

{
  // 有 reasoning ⇒ 摘掉，其它 block 保留且顺序不变
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '问题' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'X'.repeat(100) },
      { type: 'text', text: '答案' },
      { type: 'reasoning', text: 'Y'.repeat(50) },
    ] },
  ]
  const r = stripReasoning(msgs)
  ok('摘掉 2 个 reasoning block', r.removedBlocks === 2, r)
  ok('removedChars 精确', r.removedChars === 150, r.removedChars)
  const kept = r.messages[1].content
  ok('保留 text 且只剩 1 个 block', kept.length === 1 && kept[0].type === 'text' && kept[0].text === '答案', kept)
  ok('role 等字段保留', r.messages[1].role === 'assistant')
  ok('user 消息不动', JSON.stringify(r.messages[0]) === JSON.stringify(msgs[0]))
}

{
  // thinking / redacted_reasoning 也算
  const msgs = [{ role: 'assistant', content: [
    { type: 'thinking', text: 'a' },
    { type: 'redacted_reasoning', text: 'b' },
    { type: 'text', text: 'keep' },
  ] }]
  const r = stripReasoning(msgs)
  ok('thinking 与 redacted_reasoning 都摘', r.removedBlocks === 2 && r.messages[0].content.length === 1, r)
}

{
  // 摘完变空 ⇒ 放占位，不产出空 content
  const msgs = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'Z'.repeat(10) }] }]
  const r = stripReasoning(msgs)
  ok('变空时放占位', r.emptied === 1, r)
  const c = r.messages[0].content
  ok('占位不是空数组', Array.isArray(c) && c.length === 1 && c[0].type === 'text', c)
  ok('占位文案固定', c[0].text === '(reasoning omitted)', c[0])
}

{
  // ★ 关键回归：tool_use / tool_result 绝不能被动
  const msgs = [
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'r' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }] },
    ] },
  ]
  const r = stripReasoning(msgs)
  ok('tool_use 保留', r.messages[0].content.some((b) => b.type === 'tool_use'))
  ok('tool_result 保留', r.messages[1].content.some((b) => b.type === 'tool_result'))
  ok('配对 id 未变', r.messages[0].content.find((b) => b.type === 'tool_use').id === 't1')
}

{
  // 不可变：不修改入参
  const msgs = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'q' }, { type: 'text', text: 'w' }] }]
  const snapshot = JSON.stringify(msgs)
  stripReasoning(msgs)
  ok('不改动入参数组', JSON.stringify(msgs) === snapshot)
}

{
  // 异常 block 不能把整个流程带崩
  const msgs = [
    null,
    { role: 'user' },
    { role: 'assistant', content: [null, 42, { type: 'text', text: 'ok' }] },
  ]
  let threw = false
  let r = null
  try {
    r = stripReasoning(msgs)
  } catch {
    threw = true
  }
  ok('脏数据不抛异常', !threw)
  ok('脏数据下仍保留 text', !threw && r.messages[2].content.some((b) => b && b.text === 'ok'))
}

{
  // 体积下降的真实比例（用类似典型长会话的形状：大 reasoning + 小 text）
  const msgs = [
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'R'.repeat(6000) },
      { type: 'text', text: 'T'.repeat(400) },
    ] },
  ]
  const before = measureBlocks(msgs).total
  const r = stripReasoning(msgs)
  const after = measureBlocks(r.messages).total
  ok('体积明显下降（本例 ≥80%）', after <= before * 0.2, { before, after })
}

// ── slimMessages（预算式瘦身）──
console.log('\nslimMessages')

{
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'short' }] }]
  const r = slimMessages(msgs, { targetChars: 100000 })
  ok('达标时不裁（cap=null）', r.cap === null, r.cap)
  ok('达标时内容不变', JSON.stringify(r.messages) === JSON.stringify(msgs))
}

{
  // 模拟典型长会话的形状：reasoning + text + tool-call 都很大
  const big = []
  for (let i = 0; i < 40; i++) {
    big.push({ role: 'assistant', content: [
      { type: 'reasoning', text: 'R'.repeat(3000) },
      { type: 'text', text: 'T'.repeat(5000) },
      { type: 'tool-call', id: 'c' + i, name: 'bash', input: { cmd: 'X'.repeat(6000) } },
    ] })
  }
  const before = measureBlocks(big).total
  const r = slimMessages(big, { targetChars: 150000, tailKeep: 5 })
  ok('超预算时总量降到目标内', r.totalAfter <= 150000, { before, after: r.totalAfter, cap: r.cap })
  ok('总量确实大幅下降（<40% 原量）', r.totalAfter < before * 0.4, { before, after: r.totalAfter })
  ok('记录下实际使用的 cap', typeof r.cap === 'number', r.cap)
  ok('removedReasoning 已统计', r.removedReasoning > 0, r.removedReasoning)
}

{
  // 最后 tailKeep 条保持完整
  const msgs = []
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'Y'.repeat(3000) }] })
  }
  const r = slimMessages(msgs, { targetChars: 10000, tailKeep: 3 })
  const last3 = r.messages.slice(-3).map((m) => m.content[0].text.length)
  ok('最后 3 条保持完整', last3.every((n) => n === 3000), last3)
  ok('更早的被裁短', r.messages[0].content[0].text.length < 3000, r.messages[0].content[0].text.length)
  ok('截断处带明确标记', r.messages[0].content[0].text.includes('truncated'), r.messages[0].content[0].text.slice(-50))
}

{
  // 关键标识字段绝不能被截（截了 tool 配对就废了）
  const msgs = [{ role: 'assistant', content: [
    { type: 'tool-call', id: 'call-abc-123', name: 'very_long_tool_name_that_is_still_short', input: { x: 'Z'.repeat(5000) } },
  ] }]
  const r = slimMessages(msgs, { targetChars: 500, tailKeep: 0 })
  const b = r.messages[0].content[0]
  ok('type 未被截', b.type === 'tool-call', b.type)
  ok('id 未被截', b.id === 'call-abc-123', b.id)
  ok('name 未被截', b.name === 'very_long_tool_name_that_is_still_short', b.name)
  ok('长参数被截且带标记', typeof b.input.x === 'string' && b.input.x.includes('truncated'), String(b.input.x).slice(-40))
  ok('input 结构保留（仍是对象）', typeof b.input === 'object' && b.input !== null)
}

{
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'Q'.repeat(4000) }] }]
  const snap = JSON.stringify(msgs)
  slimMessages(msgs, { targetChars: 1000 })
  ok('slimMessages 不改入参', JSON.stringify(msgs) === snap)
}

{
  // ★ surrogate pair 不能被切开：切出孤立代理 ⇒ 无法编码 UTF-8 ⇒ fetch 可能在
  //   构造请求体时直接失败（外层只看到 TRANSPORT）。构造一个「切口落在 pair 中间」的样本：
  //   前面放 1 个 ASCII，让 emoji 从奇数下标开始，这样偶数 cap 就会切在高位代理上。
  const s = 'a' + '😀'.repeat(200) // 401 code units，emoji 从 index 1 开始成对
  const msgs = [{ role: 'user', content: [{ type: 'text', text: s }] }]
  const r = slimMessages(msgs, { targetChars: 100, tailKeep: 0 })
  const out = r.messages[0].content[0].text
  let lone = 0
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = out.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) lone++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = out.charCodeAt(i - 1)
      if (!(p >= 0xd800 && p <= 0xdbff)) lone++
    }
  }
  ok('截断后没有孤立代理（不会切碎 emoji）', lone === 0, { lone, tail: out.slice(-30) })
  ok('截断后仍可编码为合法 UTF-8', (() => {
    try {
      Buffer.from(out, 'utf8').toString('utf8') === out
      return !out.includes('\uFFFD')
    } catch {
      return false
    }
  })())
}

{
  let threw = false
  try { slimMessages(null) } catch { threw = true }
  ok('非数组不抛异常', !threw)
}

// ── simplifyBlocks（把摘要用不到的块换成占位）──
console.log('\nsimplifyBlocks')

{
  const msgs = [{ role: 'user', content: [
    { type: 'text', text: '看图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ] }]
  const r = simplifyBlocks(msgs)
  ok('image 被换成 text 占位', r.messages[0].content[1].type === 'text', r.messages[0].content[1])
  ok('占位文案说明原因', String(r.messages[0].content[1].text).includes('image omitted'), r.messages[0].content[1].text)
  ok('text 块保留', r.messages[0].content[0].type === 'text')
  ok('replaced 计数正确', r.replaced === 1, r.replaced)
  ok('byType 记录 image', r.byType.image === 1, r.byType)
}

{
  const msgs = [{ role: 'assistant', content: [
    { type: 'text', text: 'a' },
    { type: 'tool-call', id: 'c1', name: 'bash', input: { cmd: 'ls' } },
  ] }, { role: 'user', content: [
    { type: 'tool-result', tool_use_id: 'c1', content: [{ type: 'text', text: 'out' }] },
  ] }]
  const before = JSON.stringify(msgs)
  const r = simplifyBlocks(msgs)
  ok('全是安全类型 ⇒ no-op', JSON.stringify(r.messages) === before)
  ok('replaced=0', r.replaced === 0, r.replaced)
}

{
  const msgs = [{ role: 'user', content: [{ type: 'audio', data: 'x' }, { type: 'file', id: 'f1' }] }]
  const r = simplifyBlocks(msgs)
  ok('audio / file 都被替换', r.replaced === 2, r.byType)
  ok('替换后仍是合法消息数组', Array.isArray(r.messages[0].content) && r.messages[0].content.length === 2)
}

{
  // ★ 关键：即使全被替换，也不能产出空 content
  const msgs = [{ role: 'user', content: [{ type: 'image', data: 'x' }] }]
  const r = simplifyBlocks(msgs)
  ok('整条只有 image 时也非空', r.messages[0].content.length === 1, r.messages[0].content)
}

{
  const msgs = [{ role: 'user', content: [{ type: 'image', data: 'q' }] }]
  const snap = JSON.stringify(msgs)
  simplifyBlocks(msgs)
  ok('simplifyBlocks 不改入参', JSON.stringify(msgs) === snap)
}

{
  // slimMessages 必须把 image 一起处理掉（端到端）
  const msgs = [{ role: 'user', content: [
    { type: 'image', data: 'Z'.repeat(5000) },
    { type: 'text', text: 'T'.repeat(100) },
  ] }]
  const r = slimMessages(msgs, { targetChars: 100000 })
  const types = r.messages[0].content.map((b) => b.type)
  ok('slimMessages 内部已替换 image', !types.includes('image'), types)
  ok('slimMessages 报告 replacedBlocks', r.replacedBlocks === 1, r.replacedBlocks)
}

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exitCode = fail ? 1 : 0
