/**
 * Behavioural tests for the browser half, run with `node --test`.
 *
 * The bundle is hand-written in the loader's lazy-CJS factory format (the
 * `clientBundle` tsdown preset that normally emits it is not published), so the
 * things that could silently break are exactly the ones a build would have
 * caught: the registration protocol, the module specifiers it requires, the
 * namespace it keys its card by, and whether the card renders the route it
 * claims to report.
 *
 * The bundle is executed against a stub loader and stub services, then rendered
 * with `react-test-renderer` — no browser, no DSH shell. The card subscribes to
 * the llm-pi-ai section through `useSyncExternalStore`, so it is rendered as a
 * component rather than called as a function.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'

const require_ = createRequire(import.meta.url)

/**
 * Execute the bundle the way the client module loader does and return what it
 * registered plus the exports its factory produced.
 *
 * @returns {{registered: object, exports: object}} the load call and its module.
 */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  const sandbox = {
    __ModuleLoader__: {
      load: (row) => {
        registered = row
      },
    },
    document: undefined,
  }
  // The bundle is a classic script whose only free variables are the loader
  // facade and `document`; a Function wrapper is the smallest honest stand-in.
  new Function('window', 'document', source)(sandbox, undefined)
  assert.ok(registered !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  const resolved = new Map([
    ['react', require_('react')],
    ['react/jsx-runtime', require_('react/jsx-runtime')],
  ])
  const exports_ = registered.factory((specifier) => {
    const module = resolved.get(specifier)
    assert.ok(module !== undefined, `the bundle required an unavailable module: ${specifier}`)
    return module
  })
  return { registered, exports: exports_ }
}

/**
 * A settings scope stub with the contract's snapshot shape, carrying a
 * resolved llm-pi-ai section that serves one motomoto route.
 * @param {object} overrides - snapshot fields overriding the ready defaults.
 * @returns {object} the scope stub.
 */
function stubScope(overrides = {}) {
  const snapshot = {
    status: 'ready',
    value: {
      providers: {
        motomoto: {
          displayName: 'MotoMoto',
          apiKeyEnv: 'MOTOMOTO_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://motomoto.lol/v1',
          models: [
            { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' },
            { id: 'gpt-5.5' },
          ],
        },
      },
    },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: () => {
      throw new Error('the status card must not write the llm-pi-ai section')
    },
  }
}

/**
 * Render the card and return its tree.
 * @param {object} exports_ - the bundle's exports.
 * @param {object} scope - the settings scope stub it reads.
 * @returns {Promise<object>} the react-test-renderer tree.
 */
async function renderCard(exports_, scope) {
  let tree
  await act(async () => {
    tree = create(createElement(exports_.MotoMotoCard, { scope, t: (key) => key }))
  })
  return tree
}

test('the bundle registers under its package id and declares the services it uses', () => {
  const { registered, exports } = loadBundle()
  assert.equal(registered.id, 'dsh-llm-motomoto', 'the id must match the package name the Host scans')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'settingsScope'])
  assert.equal(
    exports.SETTINGS_NS,
    'llm-motomoto',
    'the tab dispatches cards by settings namespace the Host half registers',
  )
  assert.equal(exports.ROUTE_NS, 'llm-pi-ai', 'the card reports the route where the adapter serves it')
})

test('apply registers one card keyed on the settings namespace, bound to the route namespace', () => {
  const { exports } = loadBundle()
  const registrations = []
  const injections = []
  const bound = []
  exports.apply({
    effect: (fn) => fn(),
    locale: {
      register: (ns, dictionaries) => {
        bound.push({ ns, locales: Object.keys(dictionaries) })
        return () => {}
      },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    settingsScope: { bind: (spec) => bound.push(spec) },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        callback()
      },
      register: (options) => {
        registrations.push(options)
        return () => {}
      },
    },
  })
  assert.deepEqual(injections, ['settings.plugin.item'], 'the card joins the plugin configuration tab')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].key, 'llm-motomoto', 'the tab dispatches cards by settings namespace')
  const scopeBind = bound.find((entry) => entry.locales === undefined)
  assert.equal(scopeBind.namespace, 'llm-pi-ai', 'the card reads the live route from the adapter section')
  assert.deepEqual(
    bound.find((entry) => entry.locales !== undefined).locales.sort(),
    ['en', 'zh'],
    'both dictionaries ship with the card',
  )
})

test('the two dictionaries cover the same keys', () => {
  // A missing key renders as the key itself in one language only, which no test
  // of the rendered card would notice.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const keysOf = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    const body = source.slice(start)
    return [...body.slice(0, body.indexOf('};')).matchAll(/^\s+(\w+):/gm)].map((match) => match[1]).sort()
  }
  assert.deepEqual(keysOf('en'), keysOf('zh'))
})

test('the card renders the live route read-only', async () => {
  const { exports } = loadBundle()
  const tree = await renderCard(exports, stubScope())
  const codes = tree.root
    .findAll((node) => node.type === 'span' && /dshMm_code/.test(node.props.className ?? ''))
    .map((node) => node.props.children)
  assert.ok(codes.includes('https://motomoto.lol/v1'), 'the endpoint is reported')
  assert.ok(codes.includes('MOTOMOTO_API_KEY'), 'the credential reference is reported')
  const labels = tree.root
    .findAll((node) => node.type === 'span' && node.props.className === 'dshMm_label')
    .map((node) => node.props.children)
  for (const key of ['group', 'endpoint', 'credential', 'models']) {
    assert.ok(labels.includes(key), `the ${key} row is labelled`)
  }
  const ids = tree.root.findAll((node) => node.type === 'code').map((node) => node.props.children)
  assert.ok(ids.includes('gpt-5.6-terra'), 'the model ids are listed')
  assert.ok(ids.includes('gpt-5.5'))
  assert.equal(
    tree.root.findAll((node) => node.type === 'input').length,
    0,
    'the card offers no controls: the models page owns the route',
  )
  const status = tree.root.findAll((node) => node.type === 'p' && node.props.className === 'dshMm_status')
  assert.equal(status.length, 1)
  assert.equal(status[0].props.children, '', 'a ready section with a route needs no status text')
})

test('a missing route or an unreadable section shows a status, never a crash', async () => {
  const { exports } = loadBundle()
  const cases = [
    { overrides: { status: 'loading', value: undefined }, kind: 'info', text: 'loading' },
    { overrides: { status: 'unavailable' }, kind: 'error', text: 'unavailable' },
    { overrides: { status: 'ready', value: { providers: {} } }, kind: 'error', text: 'missing' },
    { overrides: { status: 'ready', value: {} }, kind: 'error', text: 'missing' },
  ]
  for (const { overrides, kind, text } of cases) {
    const tree = await renderCard(exports, stubScope(overrides))
    const status = tree.root.findAll((node) => node.type === 'p' && node.props.className === 'dshMm_status')
    assert.equal(status.length, 1, 'exactly one status line')
    assert.equal(status[0].props['data-kind'], kind, `${text} has kind ${kind}`)
    assert.equal(status[0].props.children, text, `${text} names itself`)
    assert.equal(
      tree.root.findAll((node) => node.type === 'code').length,
      0,
      `${text} renders no route rows`,
    )
  }
})
