/**
 * Behavioural tests for the Codex identity fence, run with `node --test`.
 *
 * The fence wraps `globalThis.fetch` and rewrites exactly two headers for
 * requests addressed to the relay host: `user-agent` (the relay admits a
 * request by it — a harness-attributed UA is rejected outright) and
 * `originator`. Everything else — other hosts, other headers, bodies, signals —
 * must pass through untouched, and unloading the plugin must restore the fetch
 * it replaced.
 *
 * These tests stub the cordis context the plugin's `apply` needs and drive real
 * `fetch` plumbing (Headers, Request, duplex streaming) against a recording
 * native fetch, so the wrapper is exercised exactly the way a provider SDK
 * would exercise it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, apply, name } from '../lib/index.js'

/** A recording stand-in for the fetch the fence wraps. */
function recordingFetch() {
  const calls = []
  const native = async (input, init) => {
    calls.push({ input, init })
    return { ok: true }
  }
  return { calls, native }
}

/**
 * A minimal cordis context: `effect` collects disposers, `inject` answers
 * immediately, and the logger stays quiet.
 * @returns {object} the context plus the disposers it collected.
 */
function stubContext() {
  const disposers = []
  return {
    disposers,
    effect: (register) => {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (services, callback) => {
      assert.deepEqual(services, ['settings'])
      callback({ settings: { installSection: () => {} } })
    },
    logger: { info: () => {}, warn: () => {} },
  }
}

/**
 * Install the fence over a recording fetch, run one fenced call, restore.
 * @param {object} config - the plugin configuration to install with.
 * @param {(fenced: typeof fetch) => Promise<void>} drive - exercises the fence.
 * @returns {Promise<{calls: object[]}>} what the native fetch recorded.
 */
async function fenced(config, drive) {
  const { calls, native } = recordingFetch()
  const previous = globalThis.fetch
  globalThis.fetch = native
  const ctx = stubContext()
  apply(ctx, config)
  assert.equal(globalThis.fetch === native, false, 'the fence must replace global fetch')
  try {
    await drive(globalThis.fetch)
  } finally {
    for (const dispose of ctx.disposers) dispose()
    assert.equal(globalThis.fetch, native, 'unloading restores the replaced fetch')
    globalThis.fetch = previous
  }
  return { calls }
}

test('the plugin exports its stable name and resolves defaults', () => {
  assert.equal(name, 'llm-motomoto')
  const config = Config({})
  assert.equal(config.host, 'motomoto.lol')
  assert.match(config.userAgent, /^codex_cli_rs\//, 'the default identity is the Codex CLI')
  assert.equal(config.originator, 'codex_cli_rs')
})

test('a relay request is rewritten to the Codex identity, body untouched', async () => {
  const { calls } = await fenced(Config({}), async (fenced) => {
    await fenced('https://motomoto.lol/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.2-rc.1' },
      body: '{"model":"gpt-5.6-terra","stream":true}',
    })
  })
  assert.equal(calls.length, 1)
  const headers = calls[0].init.headers
  assert.equal(headers.get('user-agent'), Config({}).userAgent)
  assert.equal(headers.get('originator'), 'codex_cli_rs')
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(calls[0].init.body, '{"model":"gpt-5.6-terra","stream":true}')
  assert.equal(calls[0].init.method, 'POST')
})

test('a request to any other host passes through untouched', async () => {
  const { calls } = await fenced(Config({}), async (fenced) => {
    await fenced('https://api.example.com/v1/chat/completions', {
      headers: new Headers({ 'user-agent': 'deepseek-harness/0.1.2-rc.1' }),
    })
  })
  assert.equal(calls.length, 1)
  // The init object itself is preserved by reference: nothing is rebuilt.
  assert.equal(calls[0].init.headers.get('user-agent'), 'deepseek-harness/0.1.2-rc.1')
  assert.equal(calls[0].init.headers.get('originator'), null)
})

test('a relay URL object and a Request both carry the identity', async () => {
  const { calls } = await fenced(Config({}), async (fenced) => {
    await fenced(new URL('https://motomoto.lol/v1/responses'), { method: 'POST' })
    const request = new Request('https://motomoto.lol/v1/responses', {
      method: 'POST',
      headers: { 'user-agent': 'pi (test)' },
      body: 'x',
    })
    await fenced(request)
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.get('user-agent'), Config({}).userAgent)
  const request = calls[1].input
  assert.ok(request instanceof Request, 'the Request is re-created so its headers change')
  assert.equal(request.headers.get('user-agent'), Config({}).userAgent)
  assert.equal(request.headers.get('originator'), 'codex_cli_rs')
  assert.equal(request.method, 'POST')
})

test('an empty originator omits the header; the host is configuration', async () => {
  const config = Config({ originator: '', host: 'relay.example.net' })
  const { calls } = await fenced(config, async (fenced) => {
    await fenced('https://relay.example.net/v1/responses', { headers: { originator: 'stale' } })
    await fenced('https://motomoto.lol/v1/responses')
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.get('originator'), null, 'an empty originator removes the header')
  assert.equal(calls[0].init.headers.get('user-agent'), config.userAgent)
  assert.equal(calls[1].init, undefined, 'the unconfigured host passes through untouched')
})

test('a relay JSON body is stripped of the fields the Codex backend rejects', async () => {
  const { calls } = await fenced(Config({}), async (fenced) => {
    await fenced('https://motomoto.lol/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        input: [],
        stream: true,
        max_output_tokens: 32768,
      }),
    })
  })
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal('max_output_tokens' in sent, false, 'the rejected field must not reach the wire')
  assert.equal(sent.model, 'gpt-5.6-terra')
  assert.equal(sent.stream, true)
})

test('a non-JSON body and an emptied strip list leave the body untouched', async () => {
  const plain = 'not json at all'
  const first = await fenced(Config({}), async (fenced) => {
    await fenced('https://motomoto.lol/v1/responses', { method: 'POST', body: plain })
  })
  assert.equal(first.calls[0].init.body, plain, 'a non-JSON body passes by identity')

  const second = await fenced(Config({ stripBodyParams: [] }), async (fenced) => {
    await fenced('https://motomoto.lol/v1/responses', {
      method: 'POST',
      body: '{"max_output_tokens":4096}',
    })
  })
  assert.equal(
    second.calls[0].init.body,
    '{"max_output_tokens":4096}',
    'an emptied strip list changes nothing',
  )
})

test('a Request body carrying a rejected field is rebuilt without it', async () => {
  const { calls } = await fenced(Config({}), async (fenced) => {
    const request = new Request('https://motomoto.lol/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-terra', max_output_tokens: 32768 }),
    })
    await fenced(request)
  })
  assert.equal(calls.length, 1)
  const sent = JSON.parse(await calls[0].input.clone().text())
  assert.equal('max_output_tokens' in sent, false)
  assert.equal(sent.model, 'gpt-5.6-terra')
  assert.equal(calls[0].input.headers.get('user-agent'), Config({}).userAgent)
})

test('an SSE response closes locally after a CRLF terminal event', async () => {
  const terminal = 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n'
  const hanging = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(terminal))
    },
  })
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(hanging, {
    headers: { 'content-type': 'text/event-stream' },
  })
  const ctx = stubContext()
  apply(ctx, Config({}))
  try {
    const response = await globalThis.fetch('https://motomoto.lol/v1/responses', { method: 'POST' })
    const text = await Promise.race([
      response.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('terminal stream did not close')), 250)),
    ])
    assert.equal(text, terminal)
  } finally {
    for (const dispose of ctx.disposers) dispose()
    globalThis.fetch = previous
  }
})
