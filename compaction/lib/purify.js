/**
 * lib/purify.js —— compaction 净化层 2a（规则冻结版 v2.1 的 S1 交付物）
 *
 * 纪律出处（★任务书_compaction净化层2a施工_v1_20261023.md）：
 *   ① R0 优先于一切（先脱敏，再判 minKeepChars——短摘要也可能含 token）
 *   ② 输入不可变：不修改输入数组/block；异常返回入参原件；禁"处理一半"
 *   ③ R0 失败≠安全回退：本库只负责"脱敏+净化"，失败一律 degraded+原样返回，
 *      调用方（影子管道/未来接线）负责"不写原文/标注 R0 未完成"
 *   ④ 块序：本库不重排不插索引（2a 零语义层），seq 门牌块作为普通 text 原样净化
 *   ⑤ 约束行整行保留：含约束/否定词的行豁免去重
 *   ⑥ 禁模糊相似合并：只做规范化后的逐行/逐段完全重复去重
 *   ⑦ 拿不准就不动：闸门不过→放弃去重，但★脱敏成果永不丢★
 *
 * ★ v1→v2 自修（施工中发现，非评审点）：
 *   "R0 成功 + 后续闸门失败 → 返回未脱敏原文"是把脱敏成果吐回给密钥的漏洞。
 *   现改分级回退：闸门失败 → 回退到 R0+R1 版本（脱敏+空白规范化，不去重）；
 *   异常（R0 可能没跑完）→ 原件 + report.unscrubbed=true 标志，调用方据此不写原文。
 *
 * 配置来源（S0 实证）：宿主 config 通道 unknown keys fail-fast（11 键白名单），
 *   purify 自有参数禁入——本库只用 opts 默认值，不读宿主 config。
 *
 * 纯 ESM 零依赖零宿主 import——不碰 peerDeps（intercom T16 / echo duplicate 两场事故的整个雷区避开）。
 */

const PLACEHOLDER = '<REDACTED_CREDENTIAL>'
const DEFAULT_MIN_KEEP = 400

/* ── R0：Secret scrub（最高优先级，先于一切）──────────────────────────
 * 模式库源自凭据暴露事件实证的三类 + 评审补充。
 * 全部用替换函数（不用 $1 式），因为要在函数内防"占位符二次包装"（幂等）。
 *
 * ★ 边界修复（2026-10-23 sol 独立审查）：原规则的 `\b` 词边界可被字段名前缀绕过——
 *   `_SESSDATA=` / `xSESSDATA=` / `bili_api_key=` 里前缀与键名之间无词边界（都是词
 *   字符）→ 整条不匹配 → 原值直穿。现去掉左边界限制（键名模式允许任意前缀），
 *   保守方向=多脱敏（罕见误伤好过可绕过）。 */
const R0_RULES = [
  // ① DeepSeek API key（sk- 开头十六进制以上）
  [/sk-[a-f0-9]{16,}/gi, () => PLACEHOLDER],
  // ② api_key="长值"——保留键名，脱敏值（允许 bili_api_key 等前缀）
  [/(api[_-]?key\s*[=:]\s*["']?)([^\s"']{16,})/gi, (m, head) => head + PLACEHOLDER],
  // ③ SESSDATA=cookie 值（允许 bili_sessdata 等前缀）
  [/SESSDATA=[\w%+-]+/gi, () => PLACEHOLDER],
  // ④ QQ 短信验证登录链接（整段）
  [/https:\/\/ti\.qq\.com\/safe\/tools\/captcha\/\S+/gi, () => PLACEHOLDER],
  // ⑤ token/password/authorization 值（允许 x_token 等前缀）
  [/(token|password|passwd|authorization)\s*[=:]\s*["']?([^\s"']{4,})/gi, (m, head) => head + '=' + PLACEHOLDER],
  // ⑥ URL 凭据参数（?token= / &sig= 等）
  [/([?&](?:token|key|sig|sign|secret)=)([\w-]{4,})/gi, (m, head) => head + PLACEHOLDER],
]

function scrub(text) {
  let redacted = 0
  for (const [re, build] of R0_RULES) {
    text = text.replace(re, (...m) => {
      // ★ replace 回调参数是 (match, p1..pn, offset, string)——
      //   最后一个捕获组在 m[m.length-3]，不是 m[m.length-1]（那是整串文本，
      //   会导致"串里任何位置有占位符就全局跳过"的误判，2026-10-23 冒烟抓到的真 bug）。
      //   无捕获组的规则（m.length===3）取全匹配。
      const val = m.length > 3 ? m[m.length - 3] : m[0]
      // 幂等：已是占位符（或含占位符）的不再包装
      if (typeof val === 'string' && val.includes(PLACEHOLDER)) return m[0]
      redacted++
      return build(...m)
    })
  }
  return { text, redacted }
}

/* ── R1：空白规范化（2a 只剩这一个，不动任何非空白内容）────────────── */
function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/* ── R5：约束行识别（含约束/否定词的行整行保留，豁免 R2）──────────────
 * 词表故意放宽："未"会误伤"未来"等正常行——误伤后果=该行豁免去重=保留，
 * 保守方向无害（评审：宁可不优化，不可损坏）。 */
const CONSTRAINT_RE = /禁止|必须|不要|不能|不可|未|失败|无法|绝不|需要|应该|务必|谨慎/

function isConstraintLine(line) { return CONSTRAINT_RE.test(line) }

/* ── R2：完全重复去重（规范化后逐行/逐段完全相同才去重）──────────────
 * 禁模糊相似合并（"端口 8080 正常/3001 正常"语义反例，评审点）。
 *
 * ★ normalizeKey 修复（2026-10-23 sol 独立审查）：原版删除所有标点+忽略大小写，
 *   会把 `git status --short` 和 `git status --short.`（命令/配置差异）归一成同键
 *   合并——违反 R2"完全相同"限制。现只去空白、保留全部标点（大小写仍不敏感），
 *   保守方向=少去重（全角/半角差异不去除，好过吞差异）。 */
function normalizeKey(s) {
  return s.toLowerCase().replace(/\s+/g, '')
}

function dedupe(text) {
  // 段级（按空行分段，覆盖"标题块复制"形态）
  // ★ 段级也守约束行豁免：段内任一行是约束行 → 整段不参与段级去重
  //   （2026-10-23 影子管道实测：只豁免行级不够，重复段里的约束行会连段被删）
  const paras = text.split(/\n{2,}/)
  const seenPara = new Set()
  const keptParas = []
  let deduped = 0
  for (const p of paras) {
    if (p.split('\n').some((l) => isConstraintLine(l))) { keptParas.push(p); continue }  // R5 段级豁免
    const key = normalizeKey(p)
    if (key && seenPara.has(key)) { deduped += p.split('\n').filter((l) => l.trim()).length; continue }
    if (key) seenPara.add(key)
    keptParas.push(p)
  }
  // 行级（段内重复行）
  const seenLine = new Set()
  const out = []
  for (const p of keptParas) {
    for (const line of p.split('\n')) {
      if (isConstraintLine(line)) { out.push(line); continue }  // R5 豁免
      const key = normalizeKey(line)
      if (key && seenLine.has(key)) { deduped++; continue }
      if (key) seenLine.add(key)
      out.push(line)
    }
    out.push('')  // 段间空行还原
  }
  if (out.length && out[out.length - 1] === '') out.pop()
  return { text: out.join('\n'), deduped }
}

/* ── R6：关键事实覆盖率（8 类保护事实，任一类丢失即闸门不过）────────── */
const FACT_RULES = {
  paths: (t) => [...t.matchAll(/([A-Za-z]:\\[^\s"'`）)]+|~\/[^\s"'`）)]+|(?:\/usr|\/home|\/etc)\/[^\s"'`）)]*)/g)].map((m) => m[1]),
  versions: (t) => [...t.matchAll(/\b\d+\.\d+(?:\.\d+)?(?:-rc\.\d+)?\b/g)].map((m) => m[0]),
  configKeys: (t) => [...t.matchAll(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[a-z_]{2,}:\s/g)].map((m) => m[0]),
  errorCodes: (t) => [...t.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b|\bcode[:=]\s*["']?(\w+)/g)].map((m) => m[0]),
  constraintLines: (t) => t.split('\n').filter((l) => l.trim() && isConstraintLine(l)).map((l) => normalizeKey(l)),
  todoLines: (t) => t.split('\n').filter((l) => l.trim() && /待|未完成|TODO|下一步|待复核/.test(l)).map((l) => normalizeKey(l)),
  seqMarks: (t) => [...t.matchAll(/seq[=#:]\s*\d+|\bseq\s+\d+\s*(?:→|->|至)\s*\d+/gi)].map((m) => m[0].toLowerCase()),
  // ★ URL 只保护"非秘密"的：带凭据参数的 URL 注定被 R0 脱敏（host+path 之外的 query
  //   会被削），把秘密 URL 算进保护事实=把"故意的安全脱敏"误判成数据丢失
  //   （2026-10-23 影子管道实测 4 条 coverage-lost 全是这个误报）。
  urlHosts: (t) => [...t.matchAll(/https?:\/\/([^\/\s"'`]+)([^\s"'`）)]*)/g)]
    .map((m) => m[1] + m[2].split('?')[0])
    .filter((u) => !/[?&](?:token|key|sig|sign|secret)=/i.test(u)),
}

function coverage(beforeText, afterText) {
  const result = {}
  let missing = 0
  // ★ before 侧先过 scrub（脱敏对齐）：R0 注定会改的事实（captcha 链接整条削、
  //   含秘密的约束行被改写），在 before 侧就按脱敏后形态抽取——
  //   否则"故意的安全脱敏"全被误判成数据丢失（2026-10-23 影子管道实测 4 条）。
  //   语义：保护事实 = 脱敏后仍应存在的事实。
  const beforeScrubbed = scrub(beforeText).text
  for (const [name, extract] of Object.entries(FACT_RULES)) {
    const before = new Set(extract(beforeScrubbed))
    const after = new Set(extract(afterText))
    const lost = [...before].filter((x) => !after.has(x))
    result[name] = { before: before.size, after: after.size, lost: lost.length }
    missing += lost.length
  }
  return { missing, detail: result }
}

/* ── 主入口 ────────────────────────────────────────────────────────────
 * @param {Array} summaryBlocks 宿主摘要 blocks（[{type:'text',text}, ...]）
 * @param {{minKeepChars?: number, _scrub?: Function}} opts
 *   · _scrub：测试/诊断注入点（sol 审查项）——契约同内置 scrub：
 *     (text) => { text, redacted }。默认用内置 scrub。异常由总 try-catch 兜住。
 * @returns {{summary: Array, report: object}}
 *   · 正常：summary = R0+R1+R2 版本
 *   · 闸门 degraded：summary = R0+R1 版本（★脱敏成果保住，只放弃去重）
 *   · 异常：summary = 入参原件 + report.unscrubbed=true（R0 可能没跑完，
 *     调用方见此标志一律不写原文——影子纪律） */
export function purifySummary(summaryBlocks, opts) {
  const minKeepChars = (opts && typeof opts.minKeepChars === 'number') ? opts.minKeepChars : DEFAULT_MIN_KEEP
  // _scrub 注入（审查项：R0 scrub 异常路径需要可测的注入点）
  const scrubFn = (opts && typeof opts._scrub === 'function') ? opts._scrub : scrub
  const report = { redacted: 0, deduped: 0, constraintLines: 0, coverage: null, degraded: false, reason: '', unscrubbed: false }
  try {
    if (!Array.isArray(summaryBlocks) || summaryBlocks.length === 0) {
      return { summary: summaryBlocks, report: { ...report, reason: 'empty-input' } }
    }
    const outFinal = []   // R0+R1+R2
    const outSafe = []    // R0+R1（闸门失败时的回退版，脱敏成果在此）
    const beforeTexts = []
    const afterTexts = []
    const safeTexts = []
    let totalBefore = 0
    let totalFinal = 0

    for (const block of summaryBlocks) {
      // 非 text block：浅拷贝透传（不修改输入）
      if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
        const pass = block && typeof block === 'object' ? { ...block } : block
        outFinal.push(pass)
        outSafe.push(pass)
        continue
      }
      const before = block.text
      totalBefore += before.length
      // 顺序（任务书）：R0 → R1 → R2
      const s = scrubFn(before)
      const n = normalizeWhitespace(s.text)   // ← 脱敏成果线到此为止都安全
      const d = dedupe(n)
      const after = d.text
      totalFinal += after.length
      report.redacted += s.redacted
      report.deduped += d.deduped
      beforeTexts.push(before)
      safeTexts.push(n)
      afterTexts.push(after)
      outFinal.push({ ...block, text: after })
      outSafe.push({ ...block, text: n })
    }

    const beforeAll = beforeTexts.join('\n')
    const afterAll = afterTexts.join('\n')

    if (afterAll.length === 0) {
      return { summary: summaryBlocks, report: { ...report, degraded: true, unscrubbed: true, reason: 'empty-result' } }
    }

    // R6 覆盖率闸门（第一优先）
    const cov = coverage(beforeAll, afterAll)
    report.coverage = cov.detail
    if (cov.missing > 0) {
      // ★ 回退到 R0+R1：脱敏成果保住，只放弃去重
      return { summary: outSafe, report: { ...report, degraded: true, reason: 'coverage-lost:' + cov.missing } }
    }
    // 防御闸：变大（只判 R2 后版本——脱敏换占位符可能变长，安全优先于体积）
    // ★ redacted>0 时变大是预期的（占位符比短秘密长）：不回退（回退=吐明文，
    //   违反"脱敏成果永不丢"），只在 reason 里记录（2026-10-23 影子管道实测 2 条）。
    if (totalFinal > totalBefore) {
      if (report.redacted > 0) {
        return { summary: outFinal, report: { ...report, reason: 'grew-but-scrubbed(记录不回退)' } }
      }
      return { summary: outSafe, report: { ...report, degraded: true, reason: 'grew' } }
    }
    // 防御闸：掏空（R0+R1 版本同样太小说明原文本就小，返回脱敏版）
    if (totalFinal < minKeepChars) {
      return { summary: outSafe, report: { ...report, degraded: true, reason: 'too-small' } }
    }
    return { summary: outFinal, report }
  } catch (e) {
    // 铁律：任何异常→入参原件 + unscrubbed 标志（调用方据此不写原文）
    // ★ reason 只记错误类型名，绝不拼 e.message——message 可能含输入片段，
    //   调用方记录 reason 时会造成二次泄露面（2026-10-23 sol 独立审查项）。
    return { summary: summaryBlocks, report: { ...report, degraded: true, unscrubbed: true, reason: 'exception:' + (e && e.name ? e.name : 'unknown') } }
  }
}

/**
 * scanSecrets —— 最终秘密扫描（供影子管道写入前独立复核，sol 审查项）。
 * 复用 R0 规则但**不做替换**，只报命中数。purify 自身保证之外的第二道闸：
 * 管道写 shadow 前必过此关，命中>0 一律不写 purified。
 *
 * ★ 占位符豁免（2026-10-23 整改实测）：必须和内置 scrub 同款防护——
 *   值含 PLACEHOLDER 的不算命中，否则"已脱敏文本"会被误报成漏网秘密，
 *   把 8/33 条正确脱敏的记录全部误拦（首轮整改实测）。
 */
export function scanSecrets(text) {
  let hits = 0
  for (const [re] of R0_RULES) {
    text = text.replace(re, (...m) => {
      // replace 回调参数是 (match, p1..pn, offset, string)——最后捕获组在 m[m.length-3]
      const val = m.length > 3 ? m[m.length - 3] : m[0]
      if (typeof val === 'string' && val.includes(PLACEHOLDER)) return m[0]
      hits++
      return m[0]
    })
  }
  return hits
}

export default { purifySummary, scanSecrets }
