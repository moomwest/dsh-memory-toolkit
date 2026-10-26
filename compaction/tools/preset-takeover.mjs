// Generate a complete profile patch, offline. CLI prints it; never writes profile.
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

const START = '# BEGIN compaction-preset-takeover 20261025'
const END = '# END compaction-preset-takeover 20261025'
const STANDARD = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const BOOT = 'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'

export function readAsar(path, member) {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(16)
    if (readSync(fd, header, 0, 16, 0) !== 16) throw new Error('short ASAR header')
    const bytes = header.readUInt32LE(12)
    if (bytes > 32 * 1024 * 1024) throw new Error('unexpected ASAR header size')
    const json = Buffer.alloc(bytes)
    if (readSync(fd, json, 0, bytes, 16) !== bytes) throw new Error('short ASAR index')
    let entry = JSON.parse(json.toString('utf8'))
    for (const part of member.split('/')) entry = entry?.files?.[part]
    const offset = Number(entry?.offset)
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(entry?.size) || entry.size < 0 || entry.unpacked) {
      throw new Error(`not a packed file: ${member}`)
    }
    const result = Buffer.alloc(entry.size)
    const position = 8 + header.readUInt32LE(4) + offset
    if (readSync(fd, result, 0, result.length, position) !== result.length) {
      throw new Error(`short ASAR member: ${member}`)
    }
    return result.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function yamlReader(asar) {
  // Bundled standalone parser; expressions are data, never eval'ed.
  const box = {}
  runInNewContext(readAsar(asar, 'dsh/node_modules/js-yaml/dist/js-yaml.js'), box,
    { timeout: 5000 })
  const yaml = box.jsyaml
  const schema = yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: text => ({ __dshJs: text }),
    }),
  ])
  return text => JSON.parse(JSON.stringify(yaml.load(text, { schema })))
}

export function planTakeover(asar, profileText) {
  const version = JSON.parse(readAsar(asar, 'package.json')).version
  if (version !== '0.1.7-rc.1') throw new Error(`unreviewed host version: ${version}`)
  const parse = yamlReader(asar)
  const source = readAsar(asar, STANDARD)
  const original = parse(source)?.[0]?.insert?.[0]
  if (original?.id !== 'preset-standard' || original.config?.id !== 'standard') {
    throw new Error('unexpected standard definition')
  }

  // Preserve the full original YAML, including !!js tags and multiline prompts.
  const lines = source.split(/\r?\n/)
  const begin = lines.findIndex(line => line === '    - id: preset-standard')
  if (begin < 0 || lines.slice(begin).some(line => line.trim() && !line.startsWith('    '))) {
    throw new Error('unexpected standard YAML layout')
  }
  let full = lines.slice(begin).map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n')
  const old = "            name: '@deepseek-ai/dsh-compaction-basic'"
  if (full.split(old).length !== 2) throw new Error('compactor name is not unique')
  full = full.replace(old, [
    "            name: 'dsh-agent-compaction'",
    '            config:',
    '              thresholdRatio: 0.7',
    '              retainRatio: 0.16',
    '              auto: true',
  ].join('\n'))
  const candidate = parse(full)[0]
  const expected = structuredClone(original)
  const group = expected.config.plugins.find(row => row.id === 'compaction')
  if (!group?.isolate?.compaction) throw new Error('missing compaction realm')
  const backend = group.config.find(row => row.id === 'compaction-basic')
  backend.name = 'dsh-agent-compaction'
  backend.config = { ...backend.config, thresholdRatio: 0.7, retainRatio: 0.16, auto: true }
  if (!isDeepStrictEqual(candidate, expected)) throw new Error('unintended preset change')

  const hash = createHash('sha256').update(source).digest('hex')
  const block = `${START}\n# Host ${version}; complete standard definition, not a partial config.\n` +
    `# Source SHA256: ${hash}\n# Keep standard ID; replace before its single registration.\n` +
    full.trimEnd() + `\n${END}`
  const normalized = profileText.replace(/\r\n/g, '\n')
  let rest = normalized
  if (rest.includes(START) || rest.includes(END)) {
    const a = rest.indexOf(START), b = rest.indexOf(END)
    if (a < 0 || b < a ||
        rest.indexOf(START, a + START.length) >= 0 ||
        rest.indexOf(END, b + END.length) >= 0) throw new Error('invalid managed block')
    if (rest.slice(a, b + END.length) !== block) throw new Error('modified managed block')
    rest = rest.slice(0, a) + rest.slice(b + END.length)
  }
  if (!Array.isArray(parse(rest))) throw new Error('profile must be a patch list')
  if (parse(rest).some(row => row.id === 'preset-standard' ||
      row.insert?.some?.(entry => entry.id === 'preset-standard'))) {
    throw new Error('existing preset-standard customization requires manual merge')
  }

  const code = readAsar(asar, BOOT)
  const match = code.match(/function applyEntryPatches\([\s\S]*?\n}/)
  if (!match) throw new Error('host patch function not found')
  const apply = new Function(`${match[0]}; return applyEntryPatches`)()
  const warnings = []
  const composed = apply([original], parse(full), (...args) => warnings.push(args))
  if (warnings.length || !isDeepStrictEqual(composed, [candidate])) {
    throw new Error('actual host patch engine rejected candidate')
  }
  return {
    version, sourceHash: hash, original, candidate, composed, parse,
    beforeWithoutManaged: rest,
    afterWithoutManaged: rest,
    text: rest.trimEnd() + '\n\n' + block + '\n',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , asar, profile] = process.argv
  if (!asar || !profile) throw new Error('Usage: node preset-takeover.mjs <app.asar> <profile-patch>')
  process.stdout.write(planTakeover(asar, readFileSync(profile, 'utf8')).text)
}
