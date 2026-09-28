/**
 * Live MotoMoto Chat Completions probe. Not part of the test suite.
 *
 * Sends a small streaming chat turn to the endpoint currently advertised by
 * MotoMoto. It can run raw or through this bundle's fetch fence, and reports
 * status, SSE termination, and returned text without printing credentials.
 *
 * Usage: node test/live-probe.mjs [raw|fenced] [model] [effort]
 */
import { readFileSync } from 'node:fs'
import { Config, apply, plain } from '../lib/index.js'

const mode = process.argv[2] ?? 'fenced'
const model = process.argv[3] ?? 'gpt-5.6-sol'
const effort = process.argv[4] ?? 'high'
const BASE = 'https://motomoto.lol/v1/chat/completions'

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

/** Build a minimal OpenAI Chat Completions streaming request. */
function fullSizeBody() {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a coding agent running inside DeepSeek Harness. Be terse.' },
      { role: 'user', content: 'Reply with exactly: connected' },
    ],
    max_tokens: 64,
    reasoning_effort: effort,
    stream: true,
    stream_options: { include_usage: true },
  })
}

async function probe(label, fetchFn, body) {
  const t0 = Date.now()
  const t = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'
  let response
  try {
    response = await fetchFn(body)
  } catch (e) {
    console.log(`[${label}] FETCH FAILED: ${e.message}`)
    return
  }
  console.log(`[${label}] ${t()} status=${response.status} content-type=${response.headers.get('content-type')}`)
  if (!response.ok) {
    console.log(`[${label}] error body: ${(await response.text().catch(() => '<unreadable>')).slice(0, 400)}`)
    return
  }
  const ct = response.headers.get('content-type') ?? ''
  if (!ct.includes('event-stream')) {
    console.log(`[${label}] non-SSE body: ${(await response.text()).slice(0, 300)}`)
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = 0
  let terminal = null
  let lastDelta = ''
  let closedByServer = false
  while (true) {
    const { done, value, timedOut } = await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ done: true, timedOut: true }), terminal ? 8000 : 60000)
        timer.unref?.()
      }),
    ])
    if (timedOut) {
      console.log(`[${label}] ${t()} READ TIMEOUT ${terminal ? '(8s after terminal: the relay held the connection — the fence is required)' : '(60s without any data)'}`)
      await reader.cancel('probe done').catch(() => {})
      break
    }
    if (done) {
      closedByServer = true
      break
    }
    buffer += decoder.decode(value, { stream: true })
    while (true) {
      const sep = /\r?\n\r?\n/.exec(buffer)
      if (sep === null) break
      const frame = buffer.slice(0, sep.index + sep[0].length)
      buffer = buffer.slice(sep.index + sep[0].length)
      frames++
      const ev = frame.match(/^event:\s*(\S+)/m)?.[1] ?? null
      const payload = frame.match(/^data:\s*(.+)$/m)?.[1]
      if (payload === '[DONE]') {
        if (terminal === null) terminal = '[DONE]'
      } else if (payload !== undefined) {
        try {
          const data = JSON.parse(payload)
          const delta = data.choices?.[0]?.delta?.content
          if (typeof delta === 'string') lastDelta += delta
        } catch {
          // A malformed frame is left visible in the event count, not fatal to the probe.
        }
      }
      if (ev && /^(?:response\.(?:completed|incomplete|failed)|error)$/.test(ev) && terminal === null) terminal = ev
      if (frames <= 4 || (terminal !== null && frames % 20 === 0)) {
        console.log(`[${label}] ${t()} frame#${frames} event=${ev ?? (payload === '[DONE]' ? '[DONE]' : null)}`)
      }
    }
  }
  console.log(`[${label}] CONCLUSION: frames=${frames} terminal=${terminal ?? 'NONE'} serverClosed=${closedByServer} text=${JSON.stringify(lastDelta)}`)
}

const key = loadMotoMotoKey()
console.log(`[probe] mode=${mode} model=${model} effort=${effort} key loaded (length ${key.length})`)

if (mode === 'fenced') {
  const ctx = stubContext()
  apply(ctx, Config({}))
  console.log('[probe] fence installed over globalThis.fetch')
  await probe('fenced', (body) => globalThis.fetch(BASE, {
    method: 'POST',
    // The headers the pi-ai adapter would send, attribution included: the
    // fence is what must replace the attribution with the Codex identity.
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'deepseek-harness/0.1.5-rc.2',
    },
    body,
  }), fullSizeBody())
  for (const d of ctx.disposers) d()
} else {
  await probe('raw', (body) => fetch(BASE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': plain(Config({})).userAgent,
      originator: 'codex_cli_rs',
    },
    body,
  }), fullSizeBody())
}
