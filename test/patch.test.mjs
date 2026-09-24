/**
 * Tests over the bundle patch and package manifest, run with `node --test`.
 *
 * The patch is data, so what can rot is its agreement with the code beside it:
 * this bundle deliberately ships NO provider route (the route is the user
 * settings layer's to own — the whole point of the rewrite), so the patch
 * must load the runtime half and nothing else.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === '.git' || name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

test('package is a DSH bundle with the patch and a web client', () => {
  assert.equal(pkg.name, 'dsh-llm-motomoto')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('the patch loads the runtime half and declares no provider route', () => {
  // The plugins tab dispatches a card only for namespaces the Host serves, and
  // the Host serves llm-motomoto only when this row loads the runtime half.
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^    - id: llm-motomoto$/m)
  assert.match(patch, /^      name: dsh-llm-motomoto$/m)
  // The provider route lives in the user settings layer, not in this bundle.
  assert.doesNotMatch(patch, /^- id: llm-pi-ai$/m, 'the patch must not declare an llm-pi-ai base')
  assert.doesNotMatch(patch, /baseURL:/, 'the patch must not name an endpoint')
  assert.doesNotMatch(patch, /^\s+motomoto:/m, 'the patch must not declare the motomoto route')
})

test('the patch embeds no authorization', () => {
  assert.doesNotMatch(patch, /^\s+(?:authorization|apiKey):/mi)
  assert.doesNotMatch(patch, /Bearer\s+/i)
})

test('repository contains no secret-shaped literal', () => {
  for (const path of files(fileURLToPath(new URL('..', import.meta.url)))) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{20,}/, `${path} contains a secret-shaped value`)
  }
})
