/**
 * Live MotoMoto SSE dialect probe. Not part of the test suite.
 *
 * Usage: node test/live-probe.mjs raw|fenced
 *  - raw:    direct fetch with the Codex identity, observes the wire dialect
 *  - fenced: same request through the plugin's fence, exercises the wrapper
 */
import { readFileSync } from 'node:fs'
import { Config, apply } from '../lib/index.js'

const mode = process.argv[2] ?? 'raw'
const BASE = 'https://motomoto.lol/v1/responses'

function loadMotoMotoKey() {
  const text = readFileSync(process.env.USERPROFILE + '/.dsh/.credentials.yaml', 'utf8')
  const lines = text.split(/\r?\n/)
  let inRefs = false
  let refPath = null
  for (const line of lines) {
    if (/^refs:/.test(line)) { inRefs = true; continue }
    if (inRefs) {
      const m = line.match(/^\s+MOTOMOTO_API_KEY:\s*(\S+)\s*$/)
      if (m) { refPath = m[1]; break }
    }
  }
  if (!refPath) throw new Error('MOTOMOTO_API_KEY ref not found in credentials')
  if (/^(sk-|ak-|ey-)/.test(refPath)) return refPath
  const idx = lines.findIndex((l) => l.trim() === refPath + ':' && /^\s{2}\S/.test(l))
  if (idx < 0) return refPath
  let secret = null
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s{2}\S/.test(l)) break
    const m = l.match(/^\s+(?:secret|password|value):\s*(\S+)\s*$/)
    if (m) { secret = m[1]; break }
  }
  if (!secret) throw new Error('no secret found in record ' + refPath)
  return secret
}

function stubContext() {
  const disposers = []
  return {
    disposers,
    effect: (register) => { const d = register(); if (typeof d === 'function') disposers.push(d) },
    inject: (services, callback) => callback({ settings: { installSection: () => {} } }),
    logger: { info: () => {}, warn: () => {} },
  }
}

async function readWithTimeout(reader, ms) {
  return Promise.race([
    reader.read(),
    new Promise((resolve) => { const t = setTimeout(() => resolve({ done: true, timedOut: true }), ms); t.unref?.() }),
  ])
}

async function probe(label, fetchFn) {
  const t0 = Date.now()
  const t = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'
  let response
  try {
    response = await fetchFn()
  } catch (e) {
    console.log('[' + label + '] FETCH FAILED: ' + e.message)
    return { label, fetchFailed: true }
  }
  console.log('[' + label + '] ' + t() + ' status=' + response.status + ' content-type=' + response.headers.get('content-type'))
  if (!response.ok) {
    const text = await response.text().catch(() => '<unreadable>')
    console.log('[' + label + '] error body: ' + text.slice(0, 600))
    return { label, httpError: response.status }
  }
  if (response.body === null) {
    console.log('[' + label + '] response.body is null')
    return { label, nullBody: true }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = 0
  let terminal = null
  let terminalAt = null
  let closedByServer = false
  let timedOutAfterTerminal = false
  while (true) {
    const { done, value, timedOut } = await readWithTimeout(reader, terminal ? 8000 : 45000)
    if (timedOut) {
      if (terminal) timedOutAfterTerminal = true
      console.log('[' + label + '] ' + t() + ' READ TIMEOUT' + (terminal ? ' (8s after terminal, server never closed)' : ' (45s without any data)'))
      await reader.cancel('probe done').catch(() => {})
      break
    }
    if (done) {
      closedByServer = true
      console.log('[' + label + '] ' + t() + ' STREAM CLOSED BY SERVER')
      break
    }
    buffer += decoder.decode(value, { stream: true })
    while (true) {
      const sep = /\r?\n\r?\n/.exec(buffer)
      if (!sep) break
      const frame = buffer.slice(0, sep.index + sep[0].length)
      buffer = buffer.slice(sep.index + sep[0].length)
      frames++
      const evLine = frame.match(/^event:\s*(\S+)/m)?.[1] ?? null
      const typeField = frame.match(/"type"\s*:\s*"([^"]+)"/)?.[1] ?? null
      const isTerminal = /response\.(completed|done|failed|incomplete)/.test(frame)
      if (isTerminal && !terminal) { terminal = evLine ?? typeField ?? 'unknown'; terminalAt = t() }
      if (frames <= 5 || isTerminal) {
        console.log('[' + label + '] ' + t() + ' frame#' + frames + ' event=' + evLine + ' type=' + typeField + ' bytes=' + frame.length + (isTerminal ? ' <TERMINAL>' : ''))
      } else if (frames % 10 === 0) {
        console.log('[' + label + '] ' + t() + ' ...frame#' + frames + ' event=' + evLine)
      }
      if (isTerminal) {
        console.log('[' + label + '] ' + t() + ' terminal frame content: ' + frame.slice(0, 700).replace(/\s+/g, ' '))
      }
    }
  }
  console.log('[' + label + '] CONCLUSION: frames=' + frames + ' terminal=' + (terminal ?? 'NONE') + (terminal ? ' at ' + terminalAt : '') + ' closedByServer=' + closedByServer + (timedOutAfterTerminal ? ' NO_CLOSE_AFTER_TERMINAL' : ''))
  return { label, frames, terminal, closedByServer, timedOutAfterTerminal }
}

const key = loadMotoMotoKey()
console.log('[probe] key loaded (length ' + key.length + ', prefix ' + key.slice(0, 3) + '...)')
const body = JSON.stringify({
  model: 'gpt-5.5',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly the word OK and nothing else.' }] }],
  stream: true,
  store: false,
})

if (mode === 'fenced') {
  const ctx = stubContext()
  apply(ctx, Config({}))
  console.log('[probe] fence installed over globalThis.fetch')
  await probe('fenced', () => globalThis.fetch(BASE, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body,
  }))
  for (const d of ctx.disposers) d()
} else {
  await probe('raw', () => fetch(BASE, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'user-agent': Config({}).userAgent,
      originator: 'codex_cli_rs',
    },
    body,
  }))
}
