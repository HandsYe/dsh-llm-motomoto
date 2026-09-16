/**
 * Tests over the bundle patch and package manifest, run with `node --test`.
 *
 * The patch is data, so what can rot is its agreement with the code beside it:
 * the provider route the adapter serves, the plugin row that loads the runtime
 * half, and the client metadata that gets the browser half injected.
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

test('package is a DSH bundle with the provider patch and a web client', () => {
  assert.equal(pkg.name, 'dsh-llm-motomoto')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('patch declares the expected Codex Responses route', () => {
  assert.match(patch, /^- id: llm-pi-ai$/m)
  assert.match(patch, /^      motomoto:$/m)
  // The relay serves the OpenAI Responses API only; chat/completions hangs.
  assert.match(patch, /^        api: openai-responses$/m)
  assert.match(patch, /^        baseURL: https:\/\/motomoto\.lol\/v1$/m)
  assert.match(patch, /^        apiKeyEnv: MOTOMOTO_API_KEY$/m)
})

test('patch declares only gpt-5.6-terra and does not embed authorization', () => {
  assert.match(patch, /^          - id: gpt-5\.6-terra$/m)
  assert.doesNotMatch(patch, /^\s+(?:authorization|apiKey):/mi)
  assert.doesNotMatch(patch, /Bearer\s+/i)
})

test('patch inserts the plugin row so the settings section actually loads', () => {
  // The plugins tab dispatches a card only for namespaces the Host serves, and
  // the Host serves llm-motomoto only when this row loads the runtime half.
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^    - id: llm-motomoto$/m)
  assert.match(patch, /^      name: dsh-llm-motomoto$/m)
})

test('repository contains no secret-shaped literal', () => {
  for (const path of files(fileURLToPath(new URL('..', import.meta.url)))) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{20,}/, `${path} contains a secret-shaped value`)
  }
})
