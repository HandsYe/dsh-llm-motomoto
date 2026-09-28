/**
 * Behavioural tests for the Codex identity fence, run with `node --test`.
 *
 * The fence wraps `globalThis.fetch` and, for requests addressed to the relay
 * host only: rewrites the headers to the Codex identity, deletes the
 * request-body fields the Codex backend rejects, and ends event streams at
 * their terminal event (the relay holds the connection open otherwise).
 * Everything else — other hosts, other headers, bodies, signals — must pass
 * through untouched, and unloading the plugin must restore the fetch it
 * replaced.
 *
 * These tests stub the cordis context the plugin's `apply` needs and drive real
 * `fetch` plumbing (Headers, Request, duplex streaming) against a recording
 * native fetch, so the wrapper is exercised exactly the way a provider SDK
 * would exercise it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, apply, name, plain } from '../lib/index.js'

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

/**
 * Install the fence over a fetch that answers with the given stream, read the
 * fenced response body to completion (bounded, so a stream that wrongly never
 * ends fails the test instead of hanging it), restore.
 *
 * @param {ReadableStream} upstream - the body the native fetch answers with.
 * @param {string} contentType - the response content type.
 * @param {Promise<Response>} [drive] - how to fetch; defaults to a plain POST.
 * @returns {Promise<string>} the bytes the fenced response delivered.
 */
async function fencedStream(upstream, contentType, drive) {
  const previous = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(upstream, { status: 200, headers: { 'content-type': contentType } })
  const ctx = stubContext()
  apply(ctx, Config({}))
  try {
    const response = await (drive ?? (() => globalThis.fetch('https://motomoto.lol/v1/responses', { method: 'POST' })))()
    return await Promise.race([
      response.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the fenced stream did not end')), 250)),
    ])
  } finally {
    for (const dispose of ctx.disposers) dispose()
    globalThis.fetch = previous
  }
}

test('the plugin exports its stable name and resolves defaults', () => {
  assert.equal(name, 'llm-motomoto')
  // `plain` is the same read the fence performs: live fields resolve to the
  // value in force, not to the reference the harness keeps them behind.
  const config = plain(Config({}))
  assert.equal(config.host, 'motomoto.lol')
  assert.match(config.userAgent, /^codex_cli_rs\//, 'the default identity is the Codex CLI')
  assert.equal(config.originator, 'codex_cli_rs')
  assert.deepEqual(config.headers, {})
  assert.deepEqual(config.stripBodyParams, ['max_output_tokens'])
})

test('a relay request is rewritten to the Codex identity, body untouched', async () => {
  const { calls } = await fenced(Config({}), async (fencedFetch) => {
    await fencedFetch('https://motomoto.lol/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.2-rc.1' },
      body: '{"model":"gpt-5.5","stream":true}',
    })
  })
  assert.equal(calls.length, 1)
  const headers = calls[0].init.headers
  assert.equal(headers.get('user-agent'), plain(Config({})).userAgent)
  assert.equal(headers.get('originator'), 'codex_cli_rs')
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(calls[0].init.body, '{"model":"gpt-5.5","stream":true}')
  assert.equal(calls[0].init.method, 'POST')
})

test('a request to any other host passes through untouched', async () => {
  const { calls } = await fenced(Config({}), async (fencedFetch) => {
    await fencedFetch('https://api.example.com/v1/chat/completions', {
      headers: new Headers({ 'user-agent': 'deepseek-harness/0.1.2-rc.1' }),
    })
  })
  assert.equal(calls.length, 1)
  // The init object itself is preserved by reference: nothing is rebuilt.
  assert.equal(calls[0].init.headers.get('user-agent'), 'deepseek-harness/0.1.2-rc.1')
  assert.equal(calls[0].init.headers.get('originator'), null)
})

test('a relay URL object and a Request both carry the identity', async () => {
  const { calls } = await fenced(Config({}), async (fencedFetch) => {
    await fencedFetch(new URL('https://motomoto.lol/v1/responses'), { method: 'POST' })
    const request = new Request('https://motomoto.lol/v1/responses', {
      method: 'POST',
      headers: { 'user-agent': 'pi (test)' },
      body: 'x',
    })
    await fencedFetch(request)
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.get('user-agent'), plain(Config({})).userAgent)
  const request = calls[1].input
  assert.ok(request instanceof Request, 'the Request is re-created so its headers change')
  assert.equal(request.headers.get('user-agent'), plain(Config({})).userAgent)
  assert.equal(request.headers.get('originator'), 'codex_cli_rs')
  assert.equal(request.method, 'POST')
})

test('an empty originator omits the header; extra headers set and clear; the host is configuration', async () => {
  const config = plain(
    Config({
      originator: '',
      host: 'relay.example.net',
      headers: { version: '0.118.0', session_id: 'abc', 'x-stainless-lang': '' },
    }),
  )
  const { calls } = await fenced(config, async (fencedFetch) => {
    await fencedFetch('https://relay.example.net/v1/responses', {
      headers: { originator: 'stale', 'x-stainless-lang': 'js', session_id: 'stale' },
    })
    await fencedFetch('https://motomoto.lol/v1/responses')
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.get('originator'), null, 'an empty originator removes the header')
  assert.equal(calls[0].init.headers.get('user-agent'), config.userAgent)
  assert.equal(calls[0].init.headers.get('version'), '0.118.0', 'an extra header is applied')
  assert.equal(calls[0].init.headers.get('session_id'), 'abc', 'an extra header overrides the caller')
  assert.equal(calls[0].init.headers.get('x-stainless-lang'), null, 'an empty value removes the header')
  assert.equal(calls[1].init, undefined, 'the unconfigured host passes through untouched')
})

test('a relay JSON body is stripped of the fields the Codex backend rejects', async () => {
  const { calls } = await fenced(Config({}), async (fencedFetch) => {
    await fencedFetch('https://motomoto.lol/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [],
        stream: true,
        max_output_tokens: 32768,
      }),
    })
  })
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal('max_output_tokens' in sent, false, 'the rejected field must not reach the wire')
  assert.equal(sent.model, 'gpt-5.5')
  assert.equal(sent.stream, true)
})

test('a non-JSON body and an emptied strip list leave the body untouched', async () => {
  const plain = 'not json at all'
  const first = await fenced(Config({}), async (fencedFetch) => {
    await fencedFetch('https://motomoto.lol/v1/responses', { method: 'POST', body: plain })
  })
  assert.equal(first.calls[0].init.body, plain, 'a non-JSON body passes by identity')

  const second = await fenced(Config({ stripBodyParams: [] }), async (fencedFetch) => {
    await fencedFetch('https://motomoto.lol/v1/responses', {
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
  const { calls } = await fenced(Config({}), async (fencedFetch) => {
    const request = new Request('https://motomoto.lol/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', max_output_tokens: 32768 }),
    })
    await fencedFetch(request)
  })
  assert.equal(calls.length, 1)
  const sent = JSON.parse(await calls[0].input.clone().text())
  assert.equal('max_output_tokens' in sent, false)
  assert.equal(sent.model, 'gpt-5.5')
  assert.equal(calls[0].input.headers.get('user-agent'), plain(Config({})).userAgent)
})

test('an SSE response closes locally after a CRLF terminal event', async () => {
  const terminal = 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n'
  const hanging = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(terminal))
    },
  })
  const text = await fencedStream(hanging, 'text/event-stream')
  assert.equal(text, terminal, 'the terminal frame is forwarded, then the stream ends')
})

test('a Chat Completions SSE stream closes after the [DONE] sentinel', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"connected"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const hanging = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
    },
  })
  const text = await fencedStream(hanging, 'text/event-stream')
  assert.equal(text, frames, 'the OpenAI sentinel is forwarded before local stream termination')
})

test('an SSE response closes after a failed event; earlier frames are forwarded first', async () => {
  const frames = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'event: response.failed\ndata: {"type":"response.failed"}\n\n',
  ].join('')
  const hanging = new ReadableStream({
    start(controller) {
      // One burst carrying every frame: the transform must drain them all.
      controller.enqueue(new TextEncoder().encode(frames))
    },
  })
  const text = await fencedStream(hanging, 'text/event-stream')
  assert.equal(text, frames, 'every frame up to and including the terminal one is forwarded')
})

test('a bare SSE error event closes the stream', async () => {
  const frames = 'event: error\ndata: {"type":"error","message":"upstream gone"}\n\n'
  const hanging = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
    },
  })
  const text = await fencedStream(hanging, 'text/event-stream')
  assert.equal(text, frames)
})

test('non-terminal done/cancelled events do not hide the parser terminal event', async () => {
  const frames = [
    'event: response.done\ndata: {"type":"response.done"}\n\n',
    'event: response.cancelled\ndata: {"type":"response.cancelled"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  ].join('')
  const hanging = new ReadableStream({
    start(controller) {
      // A single burst makes sure the transform drains past the non-terminal
      // frames and only closes after pi-ai's recognized terminal event.
      controller.enqueue(new TextEncoder().encode(frames))
    },
  })
  const text = await fencedStream(hanging, 'text/event-stream')
  assert.equal(text, frames, 'the parser terminal frame must not be truncated')
})

test('a non-SSE response passes through as the same object', async () => {
  let answered
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    answered = new Response('{"error":{"message":"维护期间服务不可用"}}', {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    return answered
  }
  const ctx = stubContext()
  apply(ctx, Config({}))
  try {
    const response = await globalThis.fetch('https://motomoto.lol/v1/responses', { method: 'POST' })
    assert.equal(response, answered, 'a JSON error body is not rebuilt')
    assert.equal(await response.text(), '{"error":{"message":"维护期间服务不可用"}}')
  } finally {
    for (const dispose of ctx.disposers) dispose()
    globalThis.fetch = previous
  }
})

test('an upstream close without a terminal event forwards the tail bytes', async () => {
  const complete = 'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n'
  const partial = 'data: {"type":"response.in_progress"' // no trailing blank line
  const closing = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(complete))
      controller.enqueue(new TextEncoder().encode(partial))
      controller.close()
    },
  })
  const text = await fencedStream(closing, 'text/event-stream')
  assert.equal(text, complete + partial, 'a clean upstream close keeps ordinary pass-through behavior')
})

test('a live field edit takes effect with no installSection and no re-apply', async () => {
  // The dsh >= 0.1.7 posture: the settings service has no `installSection`, so
  // an edit reaches the running plugin only through the live reference the
  // Loader handed `apply`. Every knob the fence reads must therefore be marked
  // live AND read through the reference on each use.
  const { calls, native } = recordingFetch()
  const previous = globalThis.fetch
  globalThis.fetch = native
  const raw = { host: 'motomoto.lol', announce: false }
  const entry = Config(raw)
  const disposers = []
  const ctx = {
    disposers,
    effect: (register) => {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (_services, callback) => callback({ settings: {}, effect: (fn) => disposers.push(fn() ?? (() => {})) }),
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, entry)
  try {
    await globalThis.fetch('https://motomoto.lol/v1/responses', { headers: { 'user-agent': 'deepseek-harness/0.1.2-rc.1' } })
    assert.equal(calls.at(-1).init.headers.get('originator'), 'codex_cli_rs')

    // Commit an edit the way the Loader does: write into the live reference.
    raw.host = 'relay.example.net'
    const next = Config(raw)
    for (const [key, value] of Object.entries(next)) {
      if (typeof entry[key]?.get === 'function' && typeof value?.get === 'function') {
        entry[key][Symbol.for('cosmokit.volatile.write')](value.get())
      }
    }

    await globalThis.fetch('https://relay.example.net/v1/responses', { headers: { 'user-agent': 'deepseek-harness/0.1.2-rc.1' } })
    assert.equal(
      calls.at(-1).init.headers.get('originator'),
      'codex_cli_rs',
      'the fence follows the host the user just switched to',
    )
    await globalThis.fetch('https://motomoto.lol/v1/responses')
    assert.equal(calls.at(-1).init, undefined, 'the former host now passes through untouched')
  } finally {
    for (const dispose of disposers) dispose()
    globalThis.fetch = previous
  }
})

test('every user-facing preference field is marked live so the Plugins page can serve it', () => {
  // dsh 0.1.7 dropped `installSection` and derives the form from this schema;
  // a field without the mark is not merely read-only there, it is absent.
  const json = Config.toJSON()
  const nodeOf = (node) => (typeof node === 'number' ? json.refs[node] : node)
  const root = nodeOf(json.uid)
  const marked = Object.entries(root.dict ?? {})
    .filter(([, ref]) => nodeOf(ref)?.meta?.volatile === true)
    .map(([key]) => key)
  assert.deepEqual(
    marked.sort(),
    ['headers', 'host', 'originator', 'stripBodyParams', 'userAgent'],
    'the identity knobs must all be reachable',
  )
})
