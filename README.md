# dsh-llm-motomoto

A DeepSeek Harness bundle that adds **MotoMoto** to the model selector through the built-in `llm-pi-ai` adapter, plus a status card in **Settings - Plugins** modelled on the AgentRouter bundle.

## The relay is Codex-only

Probing settled three facts, and the bundle is built around them:

| Probe | Result |
| --- | --- |
| `POST /v1/chat/completions` (any User-Agent) | Hangs — the path is not wired |
| `POST /v1/responses` + harness User-Agent | Rejected: `bad_response_status_code` / `openai_error` |
| `POST /v1/responses` + Codex CLI User-Agent | Streams: `response.created` ... |

So the route speaks `api: openai-responses`, and the runtime half fences `globalThis.fetch` to give relay requests the Codex client identity:

- `User-Agent` is rewritten to the Codex CLI value (default `codex_cli_rs/0.46.0 (Windows 10.0.26200; x86_64) WindowsTerminal`) — the harness's own attribution header cannot be suppressed any other way: the pi-ai adapter strips configured headers colliding with it before appending its own.
- `originator: codex_cli_rs` is added, matching the official client.
- Request-body fields the Codex backend rejects are deleted from JSON bodies (default strip list: `max_output_tokens` — the official client never sends it, and the backend answers `400 Unsupported parameter` otherwise). The list is the `stripBodyParams` setting: the next upstream complaint is a settings edit, not a release.
- Requests to every other host pass through untouched; unloading the plugin restores the replaced `fetch`.

An upstream `server_is_overloaded` / `502 Upstream service temporarily unavailable` is the relay's OpenAI pool being briefly busy — retry.

## How the layers compose

`dsh-settings` resolves the `llm-pi-ai` section as `mergeLayers(base, user)`: this bundle's patch is the **base**, the `llm-pi-ai:` section of `~/.dsh/settings.yaml` merges over it — objects merge per key, arrays replace wholesale. A route you edit in the models settings page therefore wins field by field, while a fresh install still serves the default route before any user configuration exists.

The default route:

- Base URL: `https://motomoto.lol/v1` (OpenAI Responses API)
- Model: `gpt-5.6-terra` (text input; low/medium/high reasoning efforts)
- Credential reference: `MOTOMOTO_API_KEY`
- Context window: 262,144

Route compat notes: the Responses protocol takes only `supportsDeveloperRole`, `supportsStrictMode`, `supportsLongCacheRetention` — completions-only keys (`thinkingFormat`, `supportsReasoningEffort`, `chatTemplateKwargs`, ...) on the same route crash the whole adapter at load.

## Where to look after installing

1. **Model picker** — the `MotoMoto` group.
2. **Settings - Plugins** — the "MotoMoto" status card, reporting the live route (group, endpoint, credential reference, models).

## Security notice

The API key is never stored in this package. Provide it as the `MOTOMOTO_API_KEY` credential. Because a key was shared in chat while this plugin was being requested, rotate it before regular use.

## Install from this source directory

```powershell
dsh plugin --profile desktop add "file:D:\开发项目\碎碎念\dsh-llm-motomoto"
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

18 offline checks: patch shape, manifest, secret scan, the client bundle's registration and rendering, and the fence's identity rewrite, body strip, and unload behavior.

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-llm-motomoto
```
