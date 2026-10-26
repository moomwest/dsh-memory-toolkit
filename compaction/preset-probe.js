// Read-only acceptance. No compression, service replacement or session rebinding.
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'compaction-preset-probe'
export const inject = ['compaction', 'agentPresets']

export function snapshot(ctx, agent) {
  const scoped = ctx.agentPresets.serviceFor(agent, 'compaction')
  const preset = ctx.agentPresets.composedPreset(agent.ctx)
  const host = ctx.compaction
  const groupCtor = scoped?.constructor?.name ?? null
  const groupAuto = scoped?.config?.auto ?? null
  const thresholdRatio = scoped?.config?.thresholdRatio ?? null
  const retainRatio = scoped?.config?.retainRatio ?? null
  const hostAuto = host?.config?.auto ?? null
  // ★ 判据只认两件事：组内解析到的是我们的实现、且它的 auto 开着。
  //   不绑 preset 名（standard / ptc / minimal 都可能被覆盖）、不绑具体阈值
  //   （阈值是可调参数，写死会让"改了阈值"看起来像"接管失效"）。
  const groupReady = groupCtor === 'YanqingCompaction' && groupAuto === true
  return {
    agentId: String(agent.id ?? ''),
    sessionId: String(agent.session?.id ?? ''),
    preset: preset ?? null, groupCtor, groupAuto, thresholdRatio, retainRatio,
    hostCtor: host?.constructor?.name ?? null, hostAuto, groupReady,
    verdict: !groupReady ? 'not-ready' :
      hostAuto === false ? 'ready' :
      hostAuto === true ? 'group-ready-host-auto-still-on' : 'host-auto-unknown',
  }
}

export function apply(ctx, _config, emitForTest) {
  const file = process.env.SOUL_PRESET_PROBE_LOG ||
    join(tmpdir(), 'dsh-compaction-preset-acceptance.jsonl')
  let warned = false
  const emit = emitForTest || (row => {
    try {
      appendFileSync(file, JSON.stringify({
        time: new Date().toISOString(), pid: process.pid, ...row,
      }) + '\n', 'utf8')
    } catch {
      if (!warned) {
        warned = true
        ctx.logger.warn('compaction preset probe could not write its acceptance log')
      }
    }
  })
  const seen = new WeakMap()
  emit({ kind: 'waiting-for-real-agent' })
  ctx.on('agent/status', ({ agent }) => {
    try {
      const row = snapshot(ctx, agent)
      const signature = JSON.stringify(row)
      if (seen.get(agent) === signature) return
      seen.set(agent, signature)
      emit({ kind: 'agent-check', ...row })
    } catch {
      // No message contents, credentials, exception text or stack in this log.
      emit({ kind: 'probe-error', code: 'agent-service-inspection-failed' })
    }
  })
}
