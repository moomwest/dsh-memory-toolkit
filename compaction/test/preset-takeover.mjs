// Offline acceptance: real packaged YAML/patch algorithm; no host or LLM calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readAsar, planTakeover } from '../tools/preset-takeover.mjs'
import { snapshot, apply } from '../preset-probe.js'

// 这两个是「针对你本机 DSH 安装」的集成测试夹具（app.asar 与一份 profile 快照）。
// 没有提供时，依赖它们的测试会整体跳过（不会失败）。自行跑集成测试：
//   DSH_TEST_ASAR=".../resources/app.asar" DSH_TEST_PROFILE=".../cordis.patch.yml" node --test
const ASAR = process.env.DSH_TEST_ASAR || ''
const FIXTURE = process.env.DSH_TEST_PROFILE || ''
const RUN_INTEGRATION = Boolean(ASAR && FIXTURE)

let asar, profile, plan
if (RUN_INTEGRATION) {
  asar = ASAR
  profile = readFileSync(FIXTURE, 'utf8')
  plan = planTakeover(asar, profile)
}

test('full standard definition preserved except compactor name and config', { skip: !RUN_INTEGRATION }, () => {
  const expected = structuredClone(plan.original)
  const row = expected.config.plugins.find(p => p.id === 'compaction')
    .config.find(p => p.id === 'compaction-basic')
  row.name = 'dsh-agent-compaction'
  row.config = { ...row.config, thresholdRatio: 0.7, retainRatio: 0.16, auto: true }
  assert.deepEqual(plan.candidate, expected)
})

test('actual host patch keeps one standard registration and nested command/pruner', { skip: !RUN_INTEGRATION }, () => {
  assert.equal(plan.composed.filter(p => p.id === 'preset-standard').length, 1)
  const config = plan.composed.find(p => p.id === 'preset-standard').config
  assert.equal(config.id, 'standard')
  const oldGroup = plan.original.config.plugins.find(p => p.id === 'compaction')
  const newGroup = config.plugins.find(p => p.id === 'compaction')
  assert.deepEqual(newGroup.config.slice(1), oldGroup.config.slice(1))
  assert.deepEqual(newGroup.isolate, oldGroup.isolate)
})

test('root fallback and all unrelated profile entries are unchanged', { skip: !RUN_INTEGRATION }, () => {
  const unrelated = text => plan.parse(text).filter(row => row.id !== 'preset-standard')
  assert.deepEqual(unrelated(plan.text), unrelated(profile))
  assert.equal(plan.parse(plan.text).find(p => p.id === 'dsh-agent-compaction').config.auto, undefined)
})

test('generator is idempotent and refuses an independently customized standard', { skip: !RUN_INTEGRATION }, () => {
  assert.equal(planTakeover(asar, plan.text).text, plan.text)
  assert.throws(() => planTakeover(asar, profile +
    '\n- id: preset-standard\n  config:\n    id: standard\n    plugins: []\n'), /existing preset-standard/)
})

test('managed block edits are rejected, rather than silently overwritten', { skip: !RUN_INTEGRATION }, () => {
  assert.throws(() => planTakeover(asar,
    plan.text.replace('auto: true', 'auto: false')), /managed block/)
})

test('YAML expression tags are preserved without evaluation', { skip: !RUN_INTEGRATION }, () => {
  const shell = plan.candidate.config.plugins.find(p => p.id === 'tool-bash')
  assert.deepEqual(shell.disabled, { __dshJs: "process.platform === 'win32'" })
  assert.match(plan.text, /disabled: !!js process.platform === 'win32'/)
})

test('host register rejects duplicates; auto listener still registered by subclass constructor', { skip: !RUN_INTEGRATION }, () => {
  const registry = readAsar(asar, 'dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
  assert.match(registry, /definitions\.has\(definition\.id\).*Duplicate agent preset/)
  const basic = readAsar(asar, 'dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
  const constructor = basic.match(/\tconstructor\(ctx, config = \{\}\) \{[\s\S]*?\n\t\}/)[0]
  let registrations = 0
  const Base = new Function('Parent', 'resolveConfig',
    'return class Basic extends Parent {' + constructor +
    '\n_registerAutomaticCompaction() { this.record() }\n}')(
      class { record() { registrations++ } }, config => config)
  class YanqingCompaction extends Base {}
  new YanqingCompaction({}, { auto: true })
  assert.equal(registrations, 1)
  new YanqingCompaction({}, { auto: false })
  assert.equal(registrations, 1)
})

function fixture(preset = 'standard', ctor = 'YanqingCompaction') {
  const scoped = {
    constructor: { name: ctor },
    config: { auto: true, thresholdRatio: 0.7, retainRatio: 0.16 },
  }
  const agent = { id: 'actual-agent-id', session: { id: 'actual-session-id' }, ctx: {} }
  const ctx = {
    compaction: { constructor: { name: 'YanqingCompaction' }, config: { auto: true } },
    agentPresets: {
      composedPreset(value) { assert.equal(value, agent.ctx); return preset },
      serviceFor(value, name) {
        assert.equal(value, agent)
        assert.equal(name, 'compaction')
        return scoped
      },
    },
  }
  return { ctx, agent, scoped }
}

test('probe reads the real agent preset service, not the host service', () => {
  const { ctx, agent } = fixture('standard', 'BasicCompactionEngine')
  assert.equal(snapshot(ctx, agent).groupReady, false)
})

test('probe distinguishes group-ready from root-listener retirement', () => {
  const { ctx, agent } = fixture()
  assert.equal(snapshot(ctx, agent).verdict, 'group-ready-host-auto-still-on')
  ctx.compaction.config.auto = false
  assert.equal(snapshot(ctx, agent).verdict, 'ready')
})

test('missing service or auto=false cannot pass; preset name and thresholds do not affect readiness', () => {
  // ★ 2026-10-25 判据修改（旧版在这里断言的是"应失败"）：
  //   ① preset 名**不**参与判定 —— standard / ptc / minimal 都可能被覆盖，
  //      绑死 `preset === 'standard'` 会让 ptc 会话即使接管成功也永远 not-ready。
  //   ② 阈值**不**参与判定 —— 它是可调参数，绑死 0.7 会让"调了阈值"看起来像"接管失效"。
  //   这两条从"应失败"翻成"应通过"，是刻意改的，不是放宽。
  const { ctx, agent, scoped } = fixture('other')
  scoped.config.thresholdRatio = 0.8
  assert.equal(snapshot(ctx, agent).groupReady, true)

  // 服务缺失 ⇒ 一定不通过（这是真负判据，不能放宽）
  const miss = fixture('standard')
  miss.ctx.agentPresets.serviceFor = () => undefined
  assert.equal(snapshot(miss.ctx, miss.agent).groupReady, false)

  // auto 关掉 ⇒ 不通过
  const off = fixture('standard')
  off.scoped.config.auto = false
  assert.equal(snapshot(off.ctx, off.agent).groupReady, false)
})

test('probe startup is not acceptance; real-agent events are required and deduplicated', () => {
  const { ctx, agent } = fixture()
  const hooks = new Map()
  const output = []
  ctx.on = (name, cb) => hooks.set(name, cb)
  apply(ctx, undefined, row => output.push(row))
  assert.equal(output[0].kind, 'waiting-for-real-agent')
  hooks.get('agent/status')({ agent, status: 'idle' })
  hooks.get('agent/status')({ agent, status: 'idle' })
  assert.equal(output.filter(x => x.kind === 'agent-check').length, 1)
  assert.equal(output[1].sessionId, agent.session.id)
})
