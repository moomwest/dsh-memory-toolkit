/**
 * test/purify-smoke.mjs —— compaction 净化层 2a 冒烟（任务书 S2）
 *
 * 纪律：假宿主、零真实文件写入（除 tmp 目录）、语料=合成样例
 * （贴近真实摘要形态，不含任何个人 / 项目标识，仅驱动净化逻辑）。
 *
 * 十条（任务书 §6-S2）：
 *   T1 幂等            purify(purify(x)) === purify(x)
 *   T2 幂等五项扩展    无重复时点值/索引/来源/占位符不二次包装/block 顺序稳定
 *   T3 输入零修改      调用前后深比较快照
 *   T4 R0 六模式       输出脱敏 + 假 logger 验证日志零原值
 *   T5 R2 正反样本     8080/3001 不合并；完全重复才去重（行级+段级）
 *   T6 R5 正反样本     约束行整行保留；净化器不制造反向语义
 *   T7 R6 人工破坏     抽掉路径 → 覆盖率 degraded（且脱敏成果保住）
 *   T8 结构化不破坏    markdown 代码块/JSON/表格原样
 *   T9 噪声闸门       500 字符纯噪声 → too-small degraded
 *   T10 异常路径      恶意 getter 触发异常 → 原件+unscrubbed；调用方纪律模拟
 *
 * 跑法：node test/purify-smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { purifySummary } = await import('../lib/purify.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('ok   ' + name) }
  else { fail++; console.log('FAIL ' + name) }
}
const deep = (x) => JSON.stringify(x)

/* ── 样例语料（合成，贴近真实摘要形态；不含任何个人 / 项目标识，仅用于驱动净化 / 去重 / 脱敏逻辑）── */
const REAL = `## Primary Request and Intent

- Original: "能不能把助手接进群聊，先不执行" — 用户问助手能否接入群聊（最初不执行）。
- 演变为完整建设：群聊↔LLM 桥接 + 协议端，让机器人账号在群里以某种人格应答。
- 用户选择"协议端"路线，提供了备用账号。
- 会话跑在 DSH 0.1.7-rc.1 上，会话文件较大（约数十 MB）。

## 架构（第 3 次复制，宿主摘要典型病态）

- 架构：网关服务 + Python 桥 + 守护进程，双向转发。
- 架构：网关服务 + Python 桥 + 守护进程，双向转发。
- 部署路径 C:\\Users\\me\\project\\demo-bot\\，禁止整份覆盖目标配置。
- 必须先备份、逐文件部署，目标机回读验证；不要跳过验证直接宣布完成。
- 待办：语音线联调通过，等待灰度发布。

## 约束与边界

- 不重启网关，否则会触发重连风暴，需要重新握手。
- 配置项 thresholdRatio 设为 0.5，retainRatio 0.16，auto 为 true。
- 错误码 TRANSPORT 表示响应根本没回来；CONTEXT_WINDOW_EXCEEDED 才是上下文超限。
- 来源 seq=123-456，参考文档 https://example.com/docs/page。
- 这些段落互不相同，只是把正文撑过最小保留阈值，避免被闸门误判为噪声。`

/* ═══ T1 幂等 ═══ */
console.log('T1 幂等')
{
  const blocks = [{ type: 'text', text: REAL }]
  const once = purifySummary(blocks)
  const twice = purifySummary(once.summary)
  ok(deep(twice.summary) === deep(once.summary), 'purify(purify(x)) === purify(x)')
  ok(!once.report.degraded, '真实语料不被闸门误伤（degraded=false）')
}

/* ═══ T2 幂等五项扩展 ═══ */
console.log('T2 幂等五项扩展')
{
  const blocks = [{ type: 'text', text: REAL }, { type: 'image', url: 'x' }, { type: 'text', text: '尾段' }]
  const once = purifySummary(blocks)
  const twice = purifySummary(once.summary)
  const t = once.summary[0].text
  ok(!t.includes('〔时点值〕'), '① 无重复时点值（2a 不加时点值）')
  ok(!t.includes('【索引】'), '② 无重复索引（2a 不插索引）')
  ok((t.match(/seq[=#:]/g) || []).length === (REAL.match(/seq[=#:]/g) || []).length, '③ seq 指针数量不变')
  ok((t.match(/<REDACTED_CREDENTIAL>/g) || []).length === (twice.summary[0].text.match(/<REDACTED_CREDENTIAL>/g) || []).length, '④ 占位符不二次包装')
  ok(once.summary.length === twice.summary.length && once.summary[1].type === 'image' && twice.summary[1].type === 'image', '⑤ block 数量/非 text block 顺序稳定')
}

/* ═══ T3 输入零修改 ═══ */
console.log('T3 输入零修改')
{
  const blocks = [{ type: 'text', text: REAL }, { type: 'text', text: '另一段完全重复\n\n另一段完全重复' }]
  const snap = deep(blocks)
  purifySummary(blocks)
  purifySummary(blocks, { minKeepChars: 1 })
  ok(deep(blocks) === snap, '两条路径（正常/degraded）后输入零修改')
}

/* ═══ T4 R0 六模式 + 日志零原值 ═══ */
console.log('T4 R0 六模式')
{
  const secretful = [
    'key1: sk-0000deadbeefdeadbeefdeadbeef0000 泄露',
    'key2: api_key="test-value-abcdefghijklmnopqrstuvwxyz01" 配置',
    'key3: SESSDATA=TEST-fake-cookie-000  cookie',
    'key4: https://ti.qq.com/safe/tools/captcha/TEST-fake-link-000?aid=0 链接',
    'key5: token: test-value-abcdefghijklmnopqrstuvwxyz01 头',
    'key6: http://x.com/p?token=abcdefghijklmnopqrstuvwxyz&sig=zzzz 参数',
  ].join('\n')
  const r = purifySummary([{ type: 'text', text: secretful + '\n\n' + REAL }])
  const out = deep(r.summary)
  ok(r.report.redacted === 6, '六模式全命中（redacted=6，实际 ' + r.report.redacted + '）')
  ok(!out.includes('sk-0000deadbeefdeadbeefdeadbeef0000'), 'sk- 原值不在输出')
  ok(!out.includes('test-value-abcdefghijklmnopqrstuvwxyz01'), '长值原值不在输出')
  ok(!out.includes('TEST-fake-cookie'), 'SESSDATA 假值不在输出')
  ok(!out.includes('TEST-fake-link'), 'QQ 链接假值不在输出')
  // 假 logger 验证：调用方纪律——report/输出都不得含原值
  const fakeLog = []
  fakeLog.push(JSON.stringify(r.report))
  ok(!fakeLog.join('').includes('sk-0000deadbeefdeadbeefdeadbeef0000'), 'report 序列化后零原值（日志安全）')
}

/* ═══ T5 R2 正反样本 ═══ */
console.log('T5 R2 正反样本')
{
  const r = purifySummary([{ type: 'text', text: REAL }])
  const t = r.summary[0].text
  ok((t.match(/架构：网关服务/g) || []).length === 1, '完全相同行只留一条（宿主复制病态被治）')
  ok(r.report.deduped >= 1, '去重计数在案（deduped=' + r.report.deduped + '）')
  // 反样本：相似但语义相反/对象不同——绝不合并
  const ports = '端口 8080 正常。\n\n端口 3001 正常。\n\n快速登录成功。\n\n快速登录失败，需要验证码。\n\n配置已部署。\n\n配置已写入但目标机尚未验证。'
  const rp = purifySummary([{ type: 'text', text: ports }])
  const tp = rp.summary[0].text
  ok(tp.includes('8080') && tp.includes('3001'), '端口 8080/3001 两条都在')
  ok(tp.includes('登录成功') && tp.includes('登录失败'), '登录成功/失败两条都在')
  ok(tp.includes('配置已部署') && tp.includes('尚未验证'), '已部署/已写入未验证两条都在')
}

/* ═══ T6 R5 正反样本 ═══ */
console.log('T6 R5 正反样本')
{
  const constraint = '不要重启 QQ，否则会触发验证。\n\n必须先备份再部署，目标机回读验证。\n\n禁止整份覆盖手机配置。\n\n其他普通说明段落其他普通说明段落其他普通说明段落。'
  const r = purifySummary([{ type: 'text', text: constraint }])
  const t = r.summary[0].text
  ok(t.includes('不要重启 QQ，否则会触发验证。'), '约束行①整行原样')
  ok(t.includes('必须先备份再部署，目标机回读验证。'), '约束行②整行原样')
  ok(t.includes('禁止整份覆盖手机配置。'), '约束行③整行原样')
  // 净化器不得制造反向语义（输入没有的句子不许出现）
  ok(!t.includes('重启 QQ，会触发验证；不要遗漏'), '不制造反向语义样本')
  // 约束行重复也保留（豁免去重）
  const dup = '必须重启才生效。\n\n必须重启才生效。\n\n说明段落说明段落说明段落说明段落说明段落说明段落。'
  const rd = purifySummary([{ type: 'text', text: dup }])
  ok((rd.summary[0].text.match(/必须重启才生效/g) || []).length === 2, '约束行重复也保留（豁免去重）')
}

/* ═══ T7 R6 人工破坏 ═══ */
console.log('T7 R6 人工破坏')
{
  // 构造：路径被"去重"丢掉的场景——用两段几乎相同但路径不同的段，段级去重误删会丢路径
  const trap = '检查 C:\\\\Users\\\\me\\\\aaa 下的配置是否正确并记录结论。\n\n检查 C:\\\\Users\\\\me\\\\bbb 下的配置是否正确并记录结论。\n\n补充说明补充说明补充说明补充说明补充说明补充说明补充说明。'
  const r = purifySummary([{ type: 'text', text: trap }])
  const t = r.summary[0].text
  ok(t.includes('aaa') && t.includes('bbb'), '相似段不去重（路径都在）')
  // 真破坏：直接验证覆盖率闸门逻辑——手工构造 lost（黑进 FACT_RULES 不可行，用输入侧验证）
  // 输入含路径+版本+约束+待办+seq+URL 的"全家福"，净化后必须全在
  // 结尾段互不相同（避免被正确去重后太小触发 too-small——那会是测试构造问题不是 bug）
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `结尾段落第${i}节，内容各不相同，用于把全文撑过 minKeepChars 阈值。\n\n`
  const full = '路径 C:\\\\Users\\\\me\\x 版本 v1.2.3-rc.1 配置 thresholdRatio: 0.7 错误 code: TRANSPORT 必须重启。\n待办：下一步验证。\n来源 seq=123-456 文档 https://example.com/docs/page。\n\n' + pad
  const rf = purifySummary([{ type: 'text', text: full }])
  const tf = rf.summary[0].text
  ok(tf.includes('C:\\\\Users\\\\me\\x') && tf.includes('v1.2.3-rc.1') && tf.includes('thresholdRatio: 0.7'), '全家福：路径/版本/配置键在')
  ok(tf.includes('TRANSPORT') && tf.includes('必须重启'), '全家福：错误码/约束行在')
  ok(tf.includes('下一步') && tf.includes('seq=123-456') && tf.includes('example.com/docs/page'), '全家福：待办/seq/URL 在')
  ok(!rf.report.degraded, '全家福不误触闸门')
}

/* ═══ T8 结构化不破坏 ═══ */
console.log('T8 结构化不破坏')
{
  const structured = '配置示例：\n\n```json\n{"thresholdRatio": 0.7, "retainRatio": 0.16}\n```\n\n| 字段 | 值 |\n|---|---|\n| auto | true |\n\n命令：adb -s 192.168.8.100:5555 shell input tap 540 1200。\n\n表格之后表格之后表格之后表格之后表格之后表格之后表格之后。'
  const r = purifySummary([{ type: 'text', text: structured }])
  const t = r.summary[0].text
  ok(t.includes('{"thresholdRatio": 0.7, "retainRatio": 0.16}'), 'JSON 代码块原样')
  ok(t.includes('| auto | true |') && t.includes('|---|---|'), 'markdown 表格原样')
  ok(t.includes('adb -s 192.168.8.100:5555 shell input tap 540 1200'), '命令串原样（端口不删）')
}

/* ═══ T9 噪声闸门 ═══ */
console.log('T9 噪声闸门')
{
  const noise = '啊啊啊'.repeat(100)  // 300 字符纯噪声（< minKeepChars 400）
  const r = purifySummary([{ type: 'text', text: noise }])
  ok(r.report.degraded === true, '纯噪声 degraded')
  ok(r.report.reason === 'too-small' || r.report.reason.startsWith('coverage'), 'reason 记录在案（' + r.report.reason + '）')
  // 脱敏成果仍在 degraded 输出里（安全优先）
  const noiseSecret = 'x'.repeat(300) + ' sk-0000deadbeefdeadbeefdeadbeef0000'
  const rs = purifySummary([{ type: 'text', text: noiseSecret }])
  ok(!deep(rs.summary).includes('sk-0000deadbeefdeadbeefdeadbeef0000'), '噪声+密钥：degraded 也不吐明文')
}

/* ═══ T10 异常路径 + 调用方纪律 ═══ */
console.log('T10 异常路径')
{
  // 恶意 block：读 text 时抛错 → 总 try-catch 必须兜住
  const evil = { type: 'text', get text() { throw new Error('boom') } }
  const r = purifySummary([evil])
  ok(r.report.degraded === true, '异常被兜住（degraded=true）')
  ok(r.report.unscrubbed === true, 'unscrubbed 标志置位（R0 可能没跑完）')
  ok(r.report.reason.startsWith('exception:'), 'reason=exception:...')
  ok(r.summary[0] === evil, '返回入参原件（同一引用）')
  // 调用方纪律模拟：影子管道见此标志不写原文
  const shadowWrite = (report, summary) => (report.unscrubbed ? '(不写原文，只记失败类型+哈希)' : JSON.stringify(summary))
  const written = shadowWrite(r.report, r.summary)
  ok(written === '(不写原文，只记失败类型+哈希)', '调用方纪律：unscrubbed→不写原文')
}

/* ═══ T11-T13 影子管道实测修复（2026-10-23，真实历史抓到的三处）═══ */
console.log('T11 段级约束豁免')
{
  // 复刻 seq=48400 病态：含约束行的段重复出现——段级去重不许连约束行一起删
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const trap = '第一批说明文字第一批说明文字第一批说明文字第一批说明文字。\n\n禁止整份覆盖手机配置，必须先备份。\n\n第二批说明文字第二批说明文字第二批说明文字第二批说明文字。\n\n禁止整份覆盖手机配置，必须先备份。\n\n' + pad
  const r = purifySummary([{ type: 'text', text: trap }])
  ok((r.summary[0].text.match(/禁止整份覆盖手机配置/g) || []).length === 2, '含约束行的重复段：约束行两条都在')
  ok(!r.report.degraded, '不误触 coverage 闸门（reason=' + r.report.reason + '）')
}

console.log('T12 秘密 URL 不算 lost')
{
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const trap = '文档地址 https://example.com/docs/page 正常保留。\n\n带凭据的 https://evil.com/x?token=abcdefghijklmnopqrstuvwxyz 会被脱敏。\n\n' + pad
  const r = purifySummary([{ type: 'text', text: trap }])
  const t = r.summary[0].text
  ok(t.includes('example.com/docs/page'), '正常 URL host+path 在')
  ok(!t.includes('abcdefghijklmnopqrstuvwxyz'), '秘密 URL 参数已脱敏')
  ok(!r.report.degraded, '秘密 URL 脱敏不算 coverage-lost（reason=' + r.report.reason + '）')
}

console.log('T13 grew-but-scrubbed 不回退')
{
  // 短秘密换长占位符 → 变大，但 redacted>0 绝不回退（回退=吐明文）
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const trap = 'x'.repeat(50) + ' token=test-value-abcdefghijklmnopqrstuvwxyz01 ' + 'y'.repeat(50) + '\n\n' + pad
  const r = purifySummary([{ type: 'text', text: trap }])
  ok(r.report.redacted === 1, 'token 脱敏执行')
  ok(!deep(r.summary).includes('test-value-abcdefghijklmnopqrstuvwxyz01'), '★变大也保留脱敏版（不回退原文）')
  ok(r.report.reason.includes('grew-but-scrubbed') || !r.report.degraded, 'reason 记录 grew-but-scrubbed（' + r.report.reason + '）')
}

/* ═══ T14-T18 sol 独立审查整改项（2026-10-23）═══ */
console.log('T14 R6 破坏样本（经 _scrub 注入制造真丢失）')
{
  // 审查项：必须构造"事实在净化后真消失"并断言 lost>0 + degraded 回退。
  // 注入恶意 scrub 模拟"净化把路径删了"——R6 必须抓住。
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const input = '检查 C:\\Users\\me\\victim 路径下的配置并记录。\n\n' + pad
  const r = purifySummary([{ type: 'text', text: input }], {
    _scrub: (t) => ({ text: t.replace('C:\\Users\\me\\victim', 'XX'), redacted: 0 }),  // 模拟净化删事实
  })
  ok(r.report.degraded === true, '破坏样本触发 degraded')
  ok(r.report.reason.startsWith('coverage-lost'), 'reason=coverage-lost（' + r.report.reason + '）')
  ok((r.report.coverage.paths.lost || 0) > 0, 'paths 类 lost>0（' + r.report.coverage.paths.lost + '）')
  // degraded 回退到 _scrub 后版本（脱敏成果线），路径确实不在输出里
  ok(!r.summary[0].text.includes('C:\\Users\\me\\victim'), '回退版也不含被删路径（一致）')
  // 对照：不注入时同一输入正常通过
  const ok2 = purifySummary([{ type: 'text', text: input }])
  ok(!ok2.report.degraded, '对照样本不误触闸门')
}

console.log('T15 _scrub 抛错路径（审查项：异常只记类型不记 message）')
{
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const input = '正文含敏感路径 C:\\secret\\path 需要处理。\n\n' + pad
  const r = purifySummary([{ type: 'text', text: input }], {
    _scrub: () => { const err = new Error('boom with C:\\secret\\path fragment'); err.name = 'ScrubError'; throw err },
  })
  ok(r.report.degraded === true && r.report.unscrubbed === true, 'scrub 抛错→degraded+unscrubbed')
  ok(r.report.reason === 'exception:ScrubError', 'reason 只含错误类型名（' + r.report.reason + '）')
  ok(!JSON.stringify(r.report).includes('C:\\secret\\path'), '★report 不含输入片段（message 不拼接）')
  ok(r.summary[0].text.includes(input), '返回入参原件')
}

console.log('T16 R0 字段名前缀（审查项：_SESSDATA/xsk-/bili_api_key 不绕过）')
{
  const prefixed = [
    '_SESSDATA=abc123def456ghi cookie 值',
    'xSESSDATA=abc123def456ghi cookie 值',
    'bili_api_key=abcdefghijklmnopqrstuvwxyz012345 配置',
    'bili_sessdata=abc123def456ghi cookie 值',
    'x_token=abcdefghijklmnopqrstuvwxyz012345 令牌',
  ].join('\n')
  let pad = ''
  for (let i = 1; i <= 12; i++) pad += `填充段第${i}节，互不相同以撑过 minKeepChars 阈值。\n\n`
  const r = purifySummary([{ type: 'text', text: prefixed + '\n\n' + pad }])
  const out = JSON.stringify(r.summary)
  ok(r.report.redacted >= 5, '前缀形态全部命中（redacted=' + r.report.redacted + '）')
  ok(!out.includes('abc123def456ghi'), 'SESSDATA 值不直穿（含前缀形态）')
  ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'), 'api_key/token 值不直穿（含前缀形态）')
}

console.log('T17 normalizeKey 保留标点（审查项：命令差异不吞）')
{
  const cmds = 'git status --short\n\ngit status --short.\n\nadb shell input tap 540 1200\n\nadb shell input tap 540,1200\n\n结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落。'
  const r = purifySummary([{ type: 'text', text: cmds }])
  const t = r.summary[0].text
  ok(t.includes('--short') && t.includes('--short.'), 'git status --short / --short. 两条都在')
  ok(t.includes('tap 540 1200') && t.includes('tap 540,1200'), '空格坐标/逗号坐标两条都在')
  ok(r.report.deduped === 0, '零误合并（deduped=0）')
}

console.log('T18 scanSecrets 终扫函数（审查项：shadow 第二道闸）')
{
  const { scanSecrets } = await import('../lib/purify.js')
  ok(scanSecrets('干净文本，无任何秘密。') === 0, '干净文本零命中')
  ok(scanSecrets('sk-0000deadbeefdeadbeefdeadbeef0000 密钥') === 1, 'sk- 命中')
  ok(scanSecrets('_SESSDATA=abc123def456ghi') === 1, '前缀 SESSDATA 命中')
  // ★ sol 复审项：五种字段形态的占位符必须全部豁免（终扫误报曾拦掉 8/33 条）
  ok(scanSecrets('api_key=<REDACTED_CREDENTIAL>') === 0, 'api_key= 占位符豁免')
  ok(scanSecrets('bili_api_key=<REDACTED_CREDENTIAL>') === 0, 'bili_api_key= 占位符豁免')
  ok(scanSecrets('SESSDATA=<REDACTED_CREDENTIAL>') === 0, 'SESSDATA= 占位符豁免')
  ok(scanSecrets('bili_sessdata=<REDACTED_CREDENTIAL>') === 0, 'bili_sessdata= 占位符豁免')
  ok(scanSecrets('token=<REDACTED_CREDENTIAL>') === 0, 'token= 占位符豁免')
  // 真值仍必须命中（豁免不等于失灵）
  ok(scanSecrets('api_key=abcdefghijklmnopqrstuvwxyz012345') === 1, 'api_key 真值仍命中')
  ok(scanSecrets('bili_sessdata=abc123def456ghi') === 1, 'bili_sessdata 真值仍命中')
}

console.log('T19 真源/installed 一致性（结构自描述，防再漂移）')
{
  // 本测试只验证"本文件能被加载且行为正确"；真源逐字节回读由施工方
  // 用外部 diff 完成（sol 复审项 2）——此处锁死"测试本身跑在哪个副本上
  // 都对"的行为同一性。★ 用同一 input 变量（曾因复制两份字面量差 4 字符误报）。
  const input = 'git status --short\n\ngit status --short.\n\n结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落结尾段落。'
  const a = purifySummary([{ type: 'text', text: input }])
  const b = purifySummary([{ type: 'text', text: input }])
  ok(deep(a.summary) === deep(b.summary), '同输入同输出（副本无关性）')
}

/* ═══ 汇总 ═══ */
console.log('\n────────────────────────────')
console.log(`purify-smoke: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
