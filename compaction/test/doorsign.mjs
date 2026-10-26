// test/doorsign.mjs —— 门牌（回取指针）单测
// ============================================================================
// ★ 为什么要有这份测试（2026-10-23 doctor 门牌项报红的根治）：
//
//   门牌逻辑原先埋在 index.js 里，而 index.js import 的
//   `@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-compaction`
//   **磁盘上不存在**（宿主运行时注入）⇒ `import('./index.js')` 必失败
//   ⇒ 门牌**无法单测** ⇒ 只能等真机压缩验证，而真机压缩要等上下文涨到阈值。
//
//   实测（2026-10-23 全库扫描）：104 份会话日志里只有 9 条 compaction/summary，
//   **全部无门牌，且接管后 0 条** —— 也就是说门牌至今**一次都没在真实环境验过**。
//
//   现在 lib/doorsign.js 零依赖，这份测试终于能离线跑通。
//   ★ 它验的是「写出来的牌子对不对」，不是「压不压得出来」——
//     后者仍需一次真实压缩（S4 观测期在等的就是它）。
// ============================================================================

import { MARK, MEMQ, pointerText, fallbackText, shadowedExtra, captureShadowed, sameSelection } from '../lib/doorsign.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label) }
}

// ★ doctor 侧的常量（echo-doctor.mjs 里写死的），这里必须与它保持兼容。
//   doctor 判门牌用正则 /#seq=(\d+)/，判 mark 用 includes('⛬ 压缩索引（非原文）')。
//   ★ 这两个是**跨文件的隐式契约**：哪天改了 MARK 的前缀，doctor 就认不出我们的产物，
//     报「压缩发生了但回取链断了」—— 而真正的病因是两边的字符串对不上。锁死它。
const DOCTOR_MARK = '⛬ 压缩索引（非原文）'
const DOCTOR_SEQ_RE = /#seq=(\d+)/

console.log('门牌单测 · lib/doorsign.js')
console.log('')

console.log('D1 与 doctor 的隐式契约')
ok(MARK.includes(DOCTOR_MARK), `我们的 MARK 含 doctor 认的那个串（"${DOCTOR_MARK}"）`)
ok(MARK.startsWith('> '), 'MARK 带 "> " 引用前缀（渲染成引用块）')

console.log('D2 标准门牌（有会话号）')
const t = pointerText('session-dfc57f53-f0b4-4c09-a517-5f349be28cb1', 5472, 15993)
const lines = t.split('\n')
ok(t.includes(MARK), '含门牌行首标记')
ok(lines.length === 2, '两行：门牌 + 回取说明')
const mSeq = DOCTOR_SEQ_RE.exec(t)
ok(!!mSeq, '★ doctor 的正则能扫到门牌（否则体检必报红）')
ok(mSeq && Number(mSeq[1]) === 5472, '★ 门牌上的 seq = 起始 seq（5472），不是结束 seq')
ok(!/#seq=15993/.test(t), '门牌不写成结束 seq')
ok(t.includes('log:session-dfc57f53-f0b4-4c09-a517-5f349be28cb1#seq=5472'), '指针形如 log:<sid>#seq=<n>')
ok(t.includes('seq 5472–15993'), '覆盖区间写给用户看')

console.log('D3 回取命令：没配置时不给假命令')
ok(!t.includes('<你的检索命令>'), '★ 不含不可执行的假命令占位')
ok(Memq0(t), '给出指针 + 让用者换自己的检索命令')
function Memq0(s) { return s.includes('用你自己的检索命令') || s.includes('open log:') }

console.log('D4 降级式：拿不到会话号')
const t2 = pointerText('', 100, 200)
ok(t2.includes(MARK), '降级式仍带标记（认得出是压缩产物）')
ok(!DOCTOR_SEQ_RE.test(t2), '★ 降级式不写 #seq= —— 拿不准就不写，错的门牌比没有更坏')

console.log('D5 fallbackText（范围复原失败）')
const t3 = fallbackText('session-abc')
ok(t3.includes(MARK), '带标记')
ok(!DOCTOR_SEQ_RE.test(t3), '★ 同样不写 #seq=')
ok(t3.includes('不猜'), '明说「不猜」，不留歧义')
ok(!t3.includes('<你的检索命令>'), '也不给假命令')
const t3b = fallbackText('')
ok(t3b.includes('本会话'), '无会话号时退化成「本会话」')

console.log('D6 边界')
const t4 = pointerText('session-x', 0, 0)
ok(DOCTOR_SEQ_RE.exec(t4)[1] === '0', 'start=0 也正常输出（不是被当成空值吞掉）')
const t5 = pointerText('session-x', 999999, 1000000)
ok(DOCTOR_SEQ_RE.exec(t5)[1] === '999999', '大 seq 不丢精度')

// ── MEMQ 配置了之后要给真命令 ──
// MEMQ 是模块加载期读 env 的，用 ?v= 绕过 ESM 缓存重新加载。
console.log('D7 MEMQ 已配置时给可执行命令')
const saved = process.env.SOUL_MEMQ
process.env.SOUL_MEMQ = 'node /x/memq.mjs'
const mod2 = await import('../lib/doorsign.js?v=memq1')
const t6 = mod2.pointerText('session-y', 10, 20)
ok(t6.includes('node /x/memq.mjs open log:session-y#seq=10'), '给出可直接敲的命令')
ok(!t6.includes('<你的检索命令>'), '不给假命令')
if (saved === undefined) delete process.env.SOUL_MEMQ
else process.env.SOUL_MEMQ = saved

// ── D8 shadowedExtra：区间外统计（2026-10-25 师姐“认不出门牌”的根治）──
// 真实样本：session-dfc57f53 seq=5865 —— 门牌写 4812–5305，
// shadowedSeqs 423 项、起自 4218 ⇒ 237 项在区间外（4218–4809 整段）。
console.log('D8 shadowedExtra（区间外同批归档统计）')
ok(shadowedExtra(undefined, 10, 20) === null, 'shadowedSeqs 取不到 ⇒ null（调用方退回不提）')
ok(shadowedExtra([], 10, 20) === null, '空数组 ⇒ null')
ok(shadowedExtra(['a', 'b'], 10, 20) === null, '全非数字 ⇒ null（不猜）')
ok(shadowedExtra([10, 11, 12, 20], 10, 20) === null, '全在区间内 ⇒ null（无外溢就不提）')
const x1 = shadowedExtra([10, 11, 12, 20, 5, 7, 30], 10, 20)
ok(x1 && x1.extraCount === 3, '区间外 3 条 ⇒ extraCount=3')
ok(x1 && x1.extraMin === 5 && x1.extraMax === 30, 'min/max 取区间外的极值（5/30），不是全体的')
const x2 = shadowedExtra([4218, 4219, 4221, 4812, 5305, 5304], 4812, 5305)
ok(x2 && x2.extraCount === 3 && x2.extraMin === 4218 && x2.extraMax === 4221,
  '★ 师姐样本同形状：3 项在 4812 之前，min=4218')
ok(shadowedExtra([10, '11', 12], 10, 12) === null, '数字字符串也能比（Number() 归一）')

console.log('D9 门牌把区间外信息写进文本（读者看不到 shadowedSeqs 字段）')
// ★ 2026-10-25 文案第三轮（外部复核风险清单逐条处理）：
//   ① 「更早」→「范围外」—— surface 的 seq **不单调**，区间外的条目可能比 start 更大
//   ② min/max 标明是**包络**，中间有空洞、不成连续段
//   ③ 删掉「完整来源见本条 shadowedSeqs」—— 读者看不到事件字段，那句是不可操作的噪音
const t7 = pointerText('session-dfc57f53-f0b4-4c09-a517-5f349be28cb1', 4812, 5305,
  [4218, 4219, 4221, 4812, 5000, 5305])
ok(t7.includes('另有 3 条范围外条目同批归档'), '★ 写明区间外有多少条（叫「范围外」不叫「更早」——seq 不单调）')
ok(t7.includes('包络 seq 4218–4221'), '★ min/max 标明是包络（不是连续覆盖）')
ok(t7.includes('中间有空洞，不成连续段'), '★ 明说中间有空洞（不让人以为 4218–4221 全段都在）')
ok(!t7.includes('更早'), '★ 不再出现「更早」这个词（会把读者引向错误方向）')
ok(!t7.includes('完整来源见本条'), '★ 删掉「完整来源见本条 shadowedSeqs」（读者看不到该字段，是不可操作的噪音）')
ok(t7.includes('seq 4812–5305'), '直接压缩范围照旧在')
ok(t7.includes('本次直接压缩范围'), '口径声明没被顶掉')
ok(DOCTOR_SEQ_RE.exec(t7) && Number(DOCTOR_SEQ_RE.exec(t7)[1]) === 4812,
  '★ doctor 正则仍只认起始 seq（没被新文本干扰）')
ok(t7.includes(MARK), '门牌标记仍在')
const t8 = pointerText('session-x', 4812, 5305, [4812, 5000, 5305])
ok(!t8.includes('另有'), '区间外为空 ⇒ 不提这笔（不制造噪音）')
const t9 = pointerText('session-x', 4812, 5305)
ok(!t9.includes('另有') && t9.includes('seq 4812–5305'),
  '★ 不传第三参 ⇒ 与旧版逐字一致（拿不到 shadowedSeqs 时的退路）')
const t10 = pointerText('session-x', 10, 20, { extraCount: 5 })
ok(t10.includes('另有 5 条范围外条目同批归档') && !t10.includes('包络'),
  '旧对象契约 {extraCount} 仍可用（只说条数、不猜起止）')
const t11 = pointerText('session-x', 10, 20, { extraCount: 5, extraMin: 3, extraMax: 4 })
ok(t11.includes('包络 seq 3–4'), '对象契约带 min/max 时也渲染（同为包络口径）')

// ── D10 captureShadowed：从 surface 复刻 + 完整消息结构比对（外部复核方案 A）──
// ★ 为什么值得单测：它是**运行时取数**，而今天的教训正是"写了代码≠生效了"。
//   这里用假 session 把宿主的形状（非单调 nodes / system 头 / null 投影）复刻出来，
//   逐条验证；**真实宿主的端到端验收仍要靠一次真压缩**（本测试证明不了那条）。
console.log('D10 captureShadowed（位置切片 + 完整消息比对）')
const mkSession = (nodes, opts = {}) => {
  const ev = (seq) => ({ seq, type: seq === nodes[0] && opts.systemHead ? 'system/message' : 'user/message', text: 't' + seq })
  return {
    id: 'session-x',
    surface: { nodes },
    eventAt: (s) => (nodes.includes(s) ? ev(s) : null),
    deriveEventMessage: (e) => (e === null || e === undefined ? null : { role: e.type === 'system/message' ? 'system' : 'user', text: e.text }),
  }
}
const R = (start, end) => ({ start, end })
{
  // 非单调：按位置切，不是按数值筛
  const nodes = [10, 4, 30, 12, 40]
  const s = mkSession(nodes)
  const input = { messages: [
    { role: 'user', text: 't10' }, { role: 'user', text: 't4' },
    { role: 'user', text: 't30' }, { role: 'user', text: 't12' },
  ] }
  const r = captureShadowed({ session: s }, input, R(10, 12))
  ok(r && JSON.stringify(r.shadowedSeqs) === '[10,4,30,12]', '★ 非单调：按位置切得 [10,4,30,12]（按数值筛会漏 4 和 30）')
}
{
  // ★ 注意 input 的形状：nodes[0] 会**出现两次** —— 一次作为 system 头，一次在 region 里
  //   （宿主 buildSummarizationInput 就是 `[system, ...regionMessages]`，nodes[0] 同时在两边）。
  //   这是宿主口径，不是 bug；我们的 captureShadowed 必须按同一口径比对。
  const nodes = [5, 6, 7, 8, 9]
  const s = mkSession(nodes, { systemHead: true })
  const input = { messages: [
    { role: 'system', text: 't5' },
    { role: 'system', text: 't5' }, { role: 'user', text: 't6' }, { role: 'user', text: 't7' },
  ] }
  const r = captureShadowed({ session: s }, input, R(5, 7))
  ok(r && JSON.stringify(r.shadowedSeqs) === '[5,6,7]', 'system 头 + 单调：slice 正确')
  ok(r && r.sid === 'session-x', 'sid 取自 session.id')
}
{
  // 反过来：把 nodes[0] 只当 user 传（漏了 system 头那次）⇒ 必须拒绝
  const nodes = [5, 6, 7]
  const s = mkSession(nodes, { systemHead: true })
  const wrong = { messages: [{ role: 'user', text: 't5' }, { role: 'user', text: 't6' }, { role: 'user', text: 't7' }] }
  ok(captureShadowed({ session: s }, wrong, R(5, 7)) === null, '★ 漏了 system 头那次投影 ⇒ 拒绝（比对的是整个结构）')
}
ok(captureShadowed({ session: mkSession([5, 6, 7]) }, { messages: [{ role: 'user', text: 't5' }, { role: 'user', text: 'WRONG' }, { role: 'user', text: 't7' }] }, R(5, 7)) === null,
  '★ 中间内容错配 ⇒ null（首尾同不代表中间一致）')
ok(captureShadowed({ session: mkSession([5, 6, 6, 7]) }, { messages: [] }, R(5, 7)) === null, '重复节点 ⇒ null（indexOf 会定位错）')
ok(captureShadowed({ session: mkSession([5, 6, 7]) }, { messages: [] }, R(7, 5)) === null, 'end 在 start 之前 ⇒ null')
ok(captureShadowed({ session: mkSession([5, 6, 7]) }, { messages: [] }, R(5, 99)) === null, '端点不在 surface ⇒ null')
ok(captureShadowed({ session: null }, { messages: [] }, R(5, 7)) === null, '拿不到 session ⇒ null（不猜）')
ok(captureShadowed({ session: mkSession([5, 6, 7]) }, null, R(5, 7)) === null, 'input 异常 ⇒ null')
{
  // null 投影节点仍留在 shadowedSeqs（宿主没剔，我们也不剔）
  const nodes = [5, 6, 7]
  const s = mkSession(nodes)
  s.deriveEventMessage = (e) => (e && e.seq === 6 ? null : { role: 'user', text: 't' + e.seq })
  const r = captureShadowed({ session: s }, { messages: [{ role: 'user', text: 't5' }, { role: 'user', text: 't7' }] }, R(5, 7))
  ok(r && JSON.stringify(r.shadowedSeqs) === '[5,6,7]', '★ null 投影节点仍留在 shadowedSeqs（与宿主口径一致）')
}

// ── D11 sameSelection：两次快照是否同一选区 ──
// ★ 2026-10-25 实盘抓到：这行判断原先写在 index.js、直接引用 isDeepStrictEqual，
//   而 captureShadowed 挪文件时那个 import 被一起挪走、index.js 漏了一处使用
//   ⇒ 运行期 ReferenceError ⇒ 被 summarize 的 try/catch 吞掉 ⇒ **门牌静默消失**。
//   ⇒ 判断收进 doorsign.js 并由这里直击，本测试就是那次事故的锁定装置。
console.log('D11 sameSelection')
{
  const s = { id: 'session-x' }
  const a = { session: s, sid: 'session-x', start: 5, end: 7, shadowedSeqs: [5, 6, 7] }
  const b = { session: s, sid: 'session-x', start: 5, end: 7, shadowedSeqs: [5, 6, 7] }
  ok(sameSelection(a, b) === true, '同一 session + 同 sid + seqs 逐项相等 ⇒ true')
  ok(sameSelection(a, { ...a, shadowedSeqs: [5, 6, 8] }) === false, 'seqs 不同 ⇒ false')
  ok(sameSelection(a, { ...a, shadowedSeqs: [7, 6, 5] }) === false, '★ 同元素不同序也算不同（保序比对）')
  ok(sameSelection(a, { ...a, session: { id: 'other' } }) === false, 'session 对象不同 ⇒ false（防串会话）')
  ok(sameSelection(a, { ...a, sid: 'session-y' }) === false, 'sid 不同 ⇒ false')
  ok(sameSelection(null, a) === false, '一边为 null ⇒ false（调用方走降级）')
  ok(sameSelection(a, undefined) === false, '另一边 undefined ⇒ false')
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
