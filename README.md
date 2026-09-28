# dsh-llm-motomoto

A DeepSeek Harness bundle for the **MotoMoto** relay: everything a request must do that the provider route cannot say, plus a status card in **Settings → MotoMoto relay** and the sidebar's **Plugins → dsh-llm-motomoto** detail page (dsh >= 0.1.7).

## What belongs to whom

This bundle deliberately ships **no provider route**. The route — protocol, baseURL, credential reference, models — is the user settings layer's to own: the `llm-pi-ai:` section of `~/.dsh/settings.yaml`. `dsh-settings` resolves that section from the user layer alone when a bundle ships no base, so the MotoMoto group in your model picker is exactly what you configured, and this bundle never fights your edits.

What the bundle contributes is the relay's wire contract, which no route field can express:

| Fact (verified live) | What the bundle does |
| --- | --- |
| MotoMoto's public homepage advertises the OpenAI Chat Completions endpoint (`POST /v1/chat/completions`) and describes availability as best-effort | Set `api: openai-completions` on your route. Models can be entered manually; `/v1/models` may not provide a JSON listing |
| The provider adapter supplies its own attribution headers; some relay deployments require a Codex CLI identity | The runtime fence rewrites `user-agent`, sets `originator: codex_cli_rs`, and applies configured extra headers on requests to the relay host |
| Some Responses-compatible upstreams reject `max_output_tokens` | The fence deletes configured fields (`stripBodyParams`) from JSON bodies addressed to the relay |
| Some SSE deployments keep the connection open after the final frame | The fence closes only after recognized Responses terminal events or the Chat Completions `data: [DONE]` sentinel. It does not mistake `response.done` or `response.cancelled` for a pi-ai terminal event |

Everything is scoped to the relay host (`motomoto.lol` by default): requests to any other host pass through the fence untouched, and unloading the plugin restores the `fetch` it replaced.

MotoMoto's public homepage describes the API as best-effort, with no availability guarantee. A valid Chat Completions request can still receive an upstream `502`; the plugin cannot repair an outage behind the relay. See [motomoto.lol](https://motomoto.lol/).

## The settings section

On dsh >= 0.1.7, open **Settings → MotoMoto relay** (Chinese: **设置 → MotoMoto 中转站**) for the route status card, or **Plugins → dsh-llm-motomoto** from the sidebar. The runtime's live configuration is served under the `llm-motomoto` entry. On older hosts, the fence's choices live under the `llm-motomoto:` key of `~/.dsh/settings.yaml`:

```yaml
llm-motomoto:
  host: motomoto.lol              # requests to this host carry the identity below
  userAgent: codex_cli_rs/0.46.0 (Windows 10.0.26200; x86_64) WindowsTerminal
  originator: codex_cli_rs        # empty string omits the header
  headers: {}                     # extra headers, applied last; an empty value removes the header
  stripBodyParams:                # request-body fields the backend rejects
    - max_output_tokens
  announce: true
```

Every knob except `announce` is live: a settings change reaches the next request without a restart. `announce` is read once at activation, so it stays out of the form.

On dsh >= 0.1.7 the Host derives this form from the exported `Config` schema and serves **only** the fields marked volatile, so `host`, `userAgent`, `originator`, `headers` and `stripBodyParams` carry that mark (`liveField` in `lib/index.js`); an unmarked field would be absent from the page, not read-only. The written value is committed into the running configuration reference and read again per request, which is what makes the change apply without a reload. `announce` is deliberately unmarked and lives in the composed bundle config.

The card itself has a seat per generation: dsh >= 0.1.7 binds the route once through `configForms.get('llm-pi-ai')` and shares it between `settings.section` (list id `llm-motomoto`, with the localized relay title) and `plugins.bundle.config`, keyed by the **package name** (`dsh-llm-motomoto`). Both slots are awaited independently, so either page can be absent or reload without removing the other. Older hosts use the `settingsScope` binder and `settings.plugin.item`, keyed by namespace. Both are reached through a dynamic `ctx.inject`, so the static `inject` list holds only `slots` and `locale` — declaring a service no provider supplies leaves the fiber inactive, which the Host reports as a renderer boot failure for the whole bundle.

## The route to configure beside it

The bundle expects the `motomoto` provider in your user layer, e.g.:

```yaml
llm-pi-ai:
  providers:
    motomoto:
      displayName: MotoMoto
      apiKeyEnv: MOTOMOTO_API_KEY
      api: openai-completions     # MotoMoto advertises /chat/completions
      baseURL: https://motomoto.lol/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: gpt-5.5
          ...
```

Route notes: set `maxTokensField: max_tokens` for Chat Completions relays that expect that field; the adapter may otherwise choose `max_completion_tokens` for newer OpenAI model IDs. A `chatTemplateKwargs: {}` left by the settings page is an empty object and is ignored.

## Where to look after installing

1. **Model picker** — the `MotoMoto` group, from your route.
2. **Settings → MotoMoto relay** (Chinese: **设置 → MotoMoto 中转站**) — a direct navigation entry for the live route status (group, endpoint, credential reference, models) on dsh >= 0.1.7.
3. **Sidebar Plugins → dsh-llm-motomoto** — the same card on the package detail page. Older hosts still show it under **Settings → Plugins**.

After editing the hand-written `lib/client.js` in a linked local install, refresh the current DSH page. Without a build watcher, do not expect automatic client updates.

## Security notice

The API key is never stored in this package. Provide it as the `MOTOMOTO_API_KEY` credential.

## Install from this source directory

```powershell
git clone https://github.com/HandsYe/dsh-llm-motomoto
dsh plugin --profile desktop add "file:<克隆下来的仓库路径>"
```

Then fully restart the desktop app. Verify the load:

```powershell
Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.log" -Pattern 'llm-motomoto' | Select-Object -Last 5
```

## Test

```powershell
npm install
npm test
```

28 offline checks: the patch's shape (it loads the runtime half and declares no route), the manifest and secret scan, the client bundle's registration and rendering (including that no static `inject` names a service this Host no longer provides), the live-field marks the Plugins page derives its form from, and the fence's identity rewrite, header extras, body strip, stream close at each terminal event, error-body pass-through, and unload behavior — plus one check that a live edit takes effect with no `installSection` and no re-apply, which is the dsh >= 0.1.7 posture.

`test/live-probe.mjs` (not part of the suite) sends one request shaped exactly like a real agent turn, directly and through the fence:

```powershell
node test/live-probe.mjs fenced gpt-5.5 high
node test/live-probe.mjs raw gpt-5.5 high
```

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-llm-motomoto
```
