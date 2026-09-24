# dsh-llm-motomoto

A DeepSeek Harness bundle for the **MotoMoto** relay: everything a request must do that the provider route cannot say, plus a status card in **Settings - Plugins**.

## What belongs to whom

This bundle deliberately ships **no provider route**. The route — protocol, baseURL, credential reference, models — is the user settings layer's to own: the `llm-pi-ai:` section of `~/.dsh/settings.yaml`. `dsh-settings` resolves that section from the user layer alone when a bundle ships no base, so the MotoMoto group in your model picker is exactly what you configured, and this bundle never fights your edits.

What the bundle contributes is the relay's wire contract, which no route field can express:

| Fact (verified live) | What the bundle does |
| --- | --- |
| The relay is Codex-only: `POST /v1/responses` streams; `/v1/chat/completions` is not wired | Nothing — set `api: openai-responses` on your route and this is pure configuration |
| A request is admitted by its `User-Agent`: a Codex CLI value streams, the harness attribution is rejected with `bad_response_status_code` / `openai_error` | The runtime half fences `globalThis.fetch` and rewrites `user-agent` to the Codex CLI value, adds `originator: codex_cli_rs`, and applies any configured extra headers. The pi-ai adapter strips configured headers colliding with its own attribution, so the fence is the only seam that works |
| The backend answers `400 Unsupported parameter` for `max_output_tokens`, which the harness resolves for every model | The fence deletes the configured fields (`stripBodyParams`) from JSON bodies addressed to the relay |
| The relay streams the whole response, then **holds the SSE connection open** — it does not close after the terminal event | The fence terminates the returned stream right after the terminal event (`response.completed` / `incomplete` / `failed` / `cancelled`, the stream-fatal `error` event, or `done`) is forwarded, releasing the connection for the relay |

Everything is scoped to the relay host (`motomoto.lol` by default): requests to any other host pass through the fence untouched, and unloading the plugin restores the `fetch` it replaced.

Relay behaviour worth knowing, but not the bundle's to fix: the upstream appends its own Codex persona after your system prompt (the terminal `response.completed` echoes the concatenation), and an overloaded pool answers `server_is_overloaded` / `502` — retry.

## The settings section

The fence's choices live under the `llm-motomoto:` key of `~/.dsh/settings.yaml` (registered by the runtime half; the card in Settings - Plugins appears once it loads):

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

Every knob is live: a settings change reaches the next request without a restart.

## The route to configure beside it

The bundle expects the `motomoto` provider in your user layer, e.g.:

```yaml
llm-pi-ai:
  providers:
    motomoto:
      displayName: MotoMoto
      apiKeyEnv: MOTOMOTO_API_KEY
      api: openai-responses        # the relay serves the Responses API only
      baseURL: https://motomoto.lol/v1
      models:
        - id: gpt-5.5
          ...
```

Route notes: the Responses protocol takes only the compat switches it declares (`supportsDeveloperRole`, `supportsStrictMode`, `supportsLongCacheRetention`, `supportsMaxOutputTokens`) — a completions-only key on a model entry makes the whole adapter refuse the route. A `chatTemplateKwargs: {}` left by the settings page is an empty object and is ignored.

## Where to look after installing

1. **Model picker** — the `MotoMoto` group, from your route.
2. **Settings - Plugins** — the "MotoMoto" status card, reporting the live route (group, endpoint, credential reference, models).

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

23 offline checks: the patch's shape (it loads the runtime half and declares no route), the manifest and secret scan, the client bundle's registration and rendering, and the fence's identity rewrite, header extras, body strip, stream close at each terminal event, error-body pass-through, and unload behavior.

`test/live-probe.mjs` (not part of the suite) sends one request shaped exactly like a real agent turn, directly and through the fence:

```powershell
node test/live-probe.mjs fenced gpt-5.5 high
node test/live-probe.mjs raw gpt-5.5 high
```

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-llm-motomoto
```
