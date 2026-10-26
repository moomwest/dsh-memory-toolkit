/**
 * S0 探针：回答 compaction 净化层 2a 的三个问题
 *   ① YanqingCompaction 实例的 this.config 由谁注入、有哪些 keys
 *   ② 这些 keys 与宿主 BasicCompactionConfig 文档（11 键）是否一致
 *   ③ this.config 里有没有 purify 自有键的容身之处（预期：没有，且 unknown keys fail-fast）
 *
 * 纪律（任务书）：
 *   · 无 dsh.client 声明（echo duplicate 事故教训）
 *   · 只读，零副作用；日志写 %TEMP%/dsh-s0-config-probe.log
 *   · inject: ['compaction'] —— 服务不存在时本探针不加载（日志空白=服务空窗，本身就是信号）
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LOG = join(tmpdir(), 'dsh-s0-config-probe.log')

function log(obj) {
  try {
    mkdirSync(tmpdir(), { recursive: true })
    appendFileSync(LOG, new Date().toISOString() + ' ' + JSON.stringify(obj) + '\r\n', 'utf8')
  } catch { /* 沉默 */ }
}

/** 文档实证的 BasicCompactionConfig 11 键（asar 内嵌文档 @40384577） */
const DOC_KEYS = [
  'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto'
]

export const name = 'dsh-s0-config-probe'

export function apply(ctx) {
  log({ phase: 'apply', note: 's0-config-probe applied' })
  // 延后到下一个 macrotask，确保 compaction 服务已注册
  setTimeout(() => {
    try {
      const svc = ctx.get('compaction')
      if (!svc) {
        log({ phase: 'result', has: false, note: 'compaction 服务不存在——探针不加载本身就是信号（服务空窗）' })
        return
      }
      const cfg = svc.config
      const keys = cfg && typeof cfg === 'object' ? Object.keys(cfg) : []
      const own = Object.keys(svc)
      log({
        phase: 'result',
        has: true,
        ctor: svc.constructor && svc.constructor.name,
        ownKeys: own,
        configKeys: keys,
        configValues: cfg && typeof cfg === 'object'
          ? Object.fromEntries(DOC_KEYS.filter((k) => k in cfg).map((k) => [k, cfg[k]]))
          : null,
        docKeysMissing: DOC_KEYS.filter((k) => !keys.includes(k)),
        unknownKeys: keys.filter((k) => !DOC_KEYS.includes(k)),
        // ③ purify 自有键预检：预期 config.minKeepChars === undefined
        purifyKeyPresent: !!(cfg && cfg.minKeepChars !== undefined)
      })
    } catch (e) {
      log({ phase: 'error', message: e && e.message })
    }
  }, 0)
}

export default { name, apply }
