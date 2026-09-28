import z from '@deepseek-ai/schemastery'

/**
 * dsh-llm-motomoto — the runtime half of the MotoMoto relay bundle.
 *
 * MotoMoto's public homepage advertises OpenAI Chat Completions and describes
 * availability as best-effort. The route itself — protocol, baseURL, credential
 * reference, models — belongs to the user settings layer (`llm-pi-ai:` in
 * ~/.dsh/settings.yaml); this bundle handles request compatibility that route
 * fields cannot express:
 *
 * 1. **The client identity.** Some observed relay paths require a Codex CLI
 *    User-Agent. DSH's pi-ai adapter strips profile headers that collide with
 *    its attribution before adding `user-agent: deepseek-harness/<version>`, so
 *    the configurable substitution happens below the adapter — at the
 *    `fetch` the provider SDK resolves from the global scope when it builds its
 *    client.
 *
 * 2. **The body shape.** For Responses-compatible paths, the relay has
 *    rejected `max_output_tokens`; the fence can delete configured fields from
 *    JSON request bodies addressed to the relay.
 *
 * 3. **The stream end.** Some relay paths leave the SSE connection open after
 *    the final frame. The fence closes after recognized Responses terminal
 *    events or the Chat Completions `data: [DONE]` sentinel, but never mistakes
 *    `response.done` or `response.cancelled` for pi-ai terminal events.
 *
 * The fence is deliberately narrow: it rewrites headers and the JSON body of
 * requests addressed to the relay host, closes that host's event streams at
 * their terminal events, and nothing else. Every other request goes to the
 * previous `fetch` untouched, and unloading the plugin restores the `fetch`
 * it replaced.
 *
 * This half also registers the `llm-motomoto` settings section: the
 * Settings - Plugins tab dispatches a card only for namespaces the Host
 * actually serves, so without this registration the browser half's status
 * card would never render.
 *
 * @module dsh-llm-motomoto
 */

/** Stable Cordis plugin name. */
const name = 'llm-motomoto'

/**
 * Settings namespace this plugin owns. It is also the key the browser half
 * registers its card under, so the two halves meet here without either
 * importing the other.
 */
const MOTOMOTO_SETTINGS_NAMESPACE = 'llm-motomoto'

/**
 * The marker cosmokit puts on a live configuration reference.
 *
 * A `Symbol.for` key is deliberate: the harness, the settings service and this
 * plugin may each hold their own copy of cosmokit, and a registered symbol is
 * the one identity all three agree on. Reading the key directly keeps this
 * plugin free of a runtime dependency on cosmokit.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Whether one resolved configuration field is a live reference rather than a
 * plain value.
 *
 * @param {unknown} value - a field of the resolved config.
 * @returns {boolean} true when the field must be read through `get()`.
 */
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Read the current value behind one resolved configuration field.
 *
 * A field the harness marks live (see {@link liveField}) is replaced in place
 * when the user edits it, so the reference is stable and only `get()` is
 * current. Every other field is a plain value.
 *
 * @param {unknown} value - a field of the resolved config.
 * @returns {unknown} the value in force right now.
 */
function currentValue(value) {
  return isLive(value) ? value.get() : value
}

/**
 * The resolved configuration with every live field read.
 *
 * Derived per use rather than cached: the whole point of a live field is that
 * it changes without the plugin being re-applied, so anything that keeps a
 * plain snapshot would keep serving the value the user just replaced.
 *
 * @param {Record<string, unknown>} config - the resolved entry configuration.
 * @returns {Record<string, unknown>} the same keys, no live references.
 */
function plain(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, currentValue(value)]))
}

/**
 * Mark one configuration field as live-editable.
 *
 * dsh 0.1.7 stopped offering an explicit settings-section API (`installSection`
 * is gone) and derives the Plugins page's form from this schema instead, serving
 * exactly the fields marked volatile. Marking them is therefore what keeps this
 * plugin's settings reachable at all on this generation.
 *
 * `volatile()` is used when the installed schemastery ships it, and the
 * equivalent `extra('volatile', true)` otherwise: the profile may resolve an
 * older schemastery than the harness bundles, and a missing method here would
 * fail the whole plugin at load, not just the form.
 *
 * @template T
 * @param {T} field - the schema field to mark.
 * @returns {T} the same field, marked live.
 */
function liveField(field) {
  if (typeof field.volatile === 'function') return field.volatile()
  return field.extra('volatile', true)
}

const Config = z.object({
  /**
   * The relay host whose requests carry the Codex identity. Requests to every
   * other host pass through untouched.
   */
  host: liveField(
    z
      .string()
      .default('motomoto.lol')
      .description('relay host whose requests are rewritten to the Codex identity'),
  ),
  /**
   * The exact User-Agent the relay accepts. It is the client's whole identity
   * (the API key authenticates the account), so it is configuration rather
   * than a constant: the relay may require a different value later.
   */
  userAgent: liveField(
    z
      .string()
      .default('codex_cli_rs/0.46.0 (Windows 10.0.26200; x86_64) WindowsTerminal')
      .description('User-Agent sent to the relay in place of the harness attribution'),
  ),
  /**
   * The `originator` header the Codex CLI sends alongside its User-Agent.
   * Empty string omits the header entirely.
   */
  originator: liveField(
    z
      .string()
      .default('codex_cli_rs')
      .description('originator header sent to the relay; empty string omits it'),
  ),
  /**
   * Any further headers the relay asks for, applied after the identity above
   * (so a name here wins over the defaults). An empty value removes the
   * header instead of setting it — the one way to silence a header a
   * provider SDK adds on its own.
   */
  headers: liveField(
    z
      .dict(z.string())
      .default({})
      .description('extra headers applied to relay requests; an empty value removes the header'),
  ),
  /**
   * Request-body fields the Codex backend rejects even though the harness
   * resolves them for every model. `max_output_tokens` is the confirmed one:
   * the official Codex client never sends it, and the backend answers a
   * request carrying it with `400 Unsupported parameter`. The fence deletes
   * these fields from JSON request bodies addressed to the relay.
   */
  stripBodyParams: liveField(
    z
      .array(z.string())
      .default(['max_output_tokens'])
      .description('request-body fields deleted from JSON bodies sent to the relay'),
  ),
  /** Report the installed fence once on activation. */
  announce: z.boolean().default(true),
})

/**
 * Resolve a `fetch` argument to its URL without consuming a request body.
 * @param {unknown} input - the first `fetch` argument.
 * @returns {URL | undefined} the parsed URL, or undefined when it is not one.
 */
function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof input === 'object' && input !== null && typeof input.url === 'string') return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Bring one JSON request body to the shape the Codex backend accepts: the
 * official client never sends the fields the backend names as unsupported, so
 * the fence deletes the configured ones. A body that is not JSON, or that
 * carries none of them, is returned unchanged — by identity, so callers can
 * tell rewrite from pass-through.
 *
 * @param {string | undefined} body - the serialized request body, when string.
 * @param {string[]} strip - the request-body fields to delete.
 * @returns {Promise<string | undefined>} the body to send.
 */
async function codexShapedBody(body, strip) {
  if (strip.length === 0 || typeof body !== 'string' || body.length === 0) return body
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (typeof parsed !== 'object' || parsed === null) return body
  let changed = false
  for (const field of strip) {
    if (Object.hasOwn(parsed, field)) {
      delete parsed[field]
      changed = true
    }
  }
  return changed ? JSON.stringify(parsed) : body
}

/**
 * Terminal frames supported by the relay's OpenAI-compatible protocols.
 * Responses parsers recognize `response.completed` / `incomplete` as final and
 * `response.failed` / `error` as fatal. Chat Completions uses the `data: [DONE]`
 * sentinel. Do NOT close on Responses `response.done` or `response.cancelled`:
 * pi-ai does not recognize either as terminal, and a relay may emit one before
 * the actual `response.completed` frame.
 */
const TERMINAL_EVENT_LINE = /(?:^|\n)event:\s*(?:response\.(?:completed|incomplete|failed)|error)(?:\r?\n|$)/
const TERMINAL_TYPE_FIELD = /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/
const CHAT_COMPLETIONS_DONE_FRAME = /(?:^|\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/

/**
 * End a relay SSE stream after its protocol's terminal frame, reader-side.
 *
 * The relay streams the whole response in a burst and then holds the
 * connection open. A pull-based wrapper reads a fresh upstream chunk on every
 * pull, which strands whole frames in its own buffer once the burst has
 * landed; a TransformStream instead receives each upstream chunk exactly once
 * and drains every complete frame from it. `terminate()` ends the readable
 * side right after the terminal frame is forwarded, and the pipe cancels the
 * upstream connection — the hold the relay never releases is released for it.
 *
 * Only `text/event-stream` responses from the relay are touched; everything
 * else (a JSON error body among them) is returned as the caller built it.
 *
 * @param {Response} response - the response the relay fetch resolved to.
 * @returns {Response} the same status and headers, with a body that ends at
 *   the terminal event when the relay holds the connection open.
 */
function closeTerminalSseStream(response) {
  if (!(response instanceof Response) || response.body === null) return response
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/event-stream')) return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let terminal = false

  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (terminal) return
      buffer += decoder.decode(chunk, { stream: true })
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer)
        if (separator === null) break
        const frameEnd = separator.index + separator[0].length
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd)
        controller.enqueue(encoder.encode(frame))
        if (TERMINAL_EVENT_LINE.test(frame) || TERMINAL_TYPE_FIELD.test(frame) || CHAT_COMPLETIONS_DONE_FRAME.test(frame)) {
          terminal = true
          controller.terminate()
          return
        }
      }
    },
    flush(controller) {
      // The upstream closed without a terminal event; forward the tail bytes
      // so ordinary pass-through behavior is preserved — the reader will see
      // the protocol error it would have seen without this fence.
      if (terminal) return
      const tail = buffer + decoder.decode()
      if (tail !== '') controller.enqueue(encoder.encode(tail))
    },
  }))

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Wrap one `fetch` so requests addressed to the relay host carry the Codex
 * client identity and the body shape the Codex backend accepts.
 *
 * The wrapper never invents a body: for the shape every provider SDK in this
 * harness uses (url plus an init object) it copies `init`, replaces only its
 * headers, and rewrites its JSON string body only when a configured field
 * was actually deleted. A bare `Request` is re-created with `duplex: 'half'`
 * so a streamed body survives the rebuild; its body is read through a clone,
 * never the original.
 *
 * @param {typeof fetch} native - the fetch this wrapper delegates to.
 * @param {() => ReturnType<typeof Config>} current - reads the live section.
 * @returns {typeof fetch} the wrapping fetch.
 */
function fenceFetch(native, current) {
  return async function motomotoFetch(input, init) {
    const url = urlOf(input)
    if (url === undefined) return native(input, init)

    const config = current()
    if (url.host.toLowerCase() !== config.host.trim().toLowerCase()) return native(input, init)

    const isRequest = typeof Request === 'function' && input instanceof Request
    const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined))
    headers.set('user-agent', config.userAgent)
    if (config.originator === '') headers.delete('originator')
    else headers.set('originator', config.originator)
    for (const [headerName, value] of Object.entries(config.headers ?? {})) {
      if (value === '') headers.delete(headerName)
      else headers.set(headerName, value)
    }

    // Same URL, so the caller's own URL object or Request identity can stay:
    // only the headers and — when a strip applied — the body change. The
    // relay sometimes leaves its SSE connection open after the terminal
    // frame, so close only after the protocol's recognized end marker.
    if (!isRequest) {
      const body = await codexShapedBody(init?.body, config.stripBodyParams)
      const response = await native(input, { ...init, headers, ...(init?.body === body ? {} : { body }) })
      return closeTerminalSseStream(response)
    }

    let body
    if (config.stripBodyParams.length > 0 && input.body !== null) {
      // Reading the clone leaves the original's body intact for the rebuild.
      body = await codexShapedBody(await input.clone().text(), config.stripBodyParams)
    }
    const response = await native(
      new Request(input, {
        ...init,
        headers,
        ...(body === undefined ? {} : { body }),
        duplex: 'half',
      }),
    )
    return closeTerminalSseStream(response)
  }
}

/**
 * Install the Codex identity fence, register the settings section the plugins
 * tab keys its card by, and expose the fence's choices as a settings section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {ReturnType<typeof Config>} config - resolved entry configuration.
 */
function apply(ctx, config) {
  // Every live field is read through `plain()` on each use, so a settings edit
  // takes effect on the next request with no reload: dsh 0.1.7 replaces the
  // value inside the reference it handed `apply`, it does not re-apply the
  // plugin. The composed entry remains the fallback, so the fence works
  // identically headless.
  let current = () => plain(config)
  ctx.inject(['settings'], (settingsCtx) => {
    // dsh >= 0.1.7 dropped installSection: the Loader derives this plugin's
    // settings section from the exported Config schema — the `liveField` marks
    // above — and commits edits into the running references. Older hosts keep
    // the explicit section install, whose source is read live the same way.
    if (typeof settingsCtx.settings?.installSection !== 'function') return
    settingsCtx.settings.installSection(ctx, MOTOMOTO_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = () => plain(source())
      },
      onChange: () => {},
    })
  })

  ctx.effect(() => {
    const previous = globalThis.fetch
    if (typeof previous !== 'function') {
      ctx.logger.warn('llm-motomoto: no global fetch to fence; relay requests will be rejected by the relay')
      return () => {}
    }
    const fenced = fenceFetch(previous, () => current())
    globalThis.fetch = fenced
    return () => {
      // Restore only what this plugin installed: a later wrapper layered on top
      // owns the global now, and clobbering it would drop that one's rewrite.
      if (globalThis.fetch === fenced) globalThis.fetch = previous
    }
  })

  const resolved = plain(config)
  if (resolved.announce) {
    ctx.logger.info('llm-motomoto: Codex identity fence installed for %s', resolved.host)
  }
}

export { MOTOMOTO_SETTINGS_NAMESPACE, Config, apply, name, plain }
