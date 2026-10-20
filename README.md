# ChatServer

A TypeScript bridge between chat apps and LLM models. It filters incoming messages,
generates short replies, and retains compact conversation memory. The built-in
WeChat adapter connects to agent-wechat using outbound REST requests; ChatServer
opens no listening ports.

## Quick start: WeChat

Requires Node.js **22.22.2+ (22.x) or 24.15.0+**, a Responses API compatible model
provider, and a running, logged-in [agent-wechat server](https://thisnick.github.io/agent-wechat/reference/api/)
with its bearer token. WeChat login and agent-wechat setup are managed separately.

1. Install and build from the repository root:

   ```bash
   npm install
   npm run build
   ```

2. Add a model using guided setup:

   ```bash
   npm run model:add -- --config_dir ./chatserver-config
   ```

   Choose or create a provider, enter its API base URL and key, then select or
   enter a model ID. For a local server, a URL might be
   `http://llm-host.local:1234/v1`. The command creates the config directory and
   prints a reference such as `local/your-model-id`.
   If your local server ignores API keys, enter a nonempty placeholder such as `local`.

3. Create `chatserver-config/config.json`:

   ```json
   {
     "chats": [
       {
         "messager": {
           "name": "wechat",
           "replyer": "local/your-model-id",
           "tools": [],
           "options": {
             "baseUrl": "http://127.0.0.1:6174",
             "chatIds": ["wxid_example"]
           }
         },
         "filters": []
       }
     ]
   }
   ```

   Replace `replyer` with the printed reference and `wxid_example` with a direct
   chat or group ID from agent-wechat's `/api/chats`. Set `baseUrl` to your
   agent-wechat server root, without `/api`. `tools: []` starts without function
   calling; omit it to enable the built-in tools.

4. Set the **agent-wechat bearer token** and start ChatServer.

   macOS / Linux:

   ```bash
   export AGENT_WECHAT_TOKEN='your-agent-wechat-token'
   npm start -- --config_dir ./chatserver-config
   ```

   Windows PowerShell:

   ```powershell
   $env:AGENT_WECHAT_TOKEN = 'your-agent-wechat-token'
   npm start -- --config_dir ./chatserver-config
   ```

5. Send a **new** text message to the bot in the configured conversation.
   Replies are processed sequentially with a random **1–3 minute** delay, including
   before the first reply. With no filters, the reply model decides whether to
   respond. Stop with Ctrl+C.

The WeChat bearer token and the model provider's API key are separate credentials.
For LAN model servers on Windows, use the full hostname such as `llm-host.local`
rather than a bare hostname.

## Configuration

Use the same config directory for the server and model commands. Select it with
`--config_dir <directory>` (`-c`) or `CHATSERVER_CONFIG_DIR`. An explicitly selected
directory must contain `config.json` before starting the server. Without an
explicit directory, the server creates a default `{ "chats": [] }` on first run.

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/chatserver` |
| Linux | `$XDG_CONFIG_HOME/chatserver` or `~/.config/chatserver` |
| Windows | `%APPDATA%\chatserver` |

The directory contains `config.json`, `models.json`, optional ignore/token files,
and automatically managed `conversations/` memory files. An empty `chats` array
runs no adapters.

Each `chats` entry has a `messager` and optional `filters`:

| Field | Meaning |
| --- | --- |
| `messager.name` | Adapter name; currently `wechat` |
| `messager.replyer` | `<provider>/<model id>` from `models.json`, using the actual ID, not its CLI alias |
| `messager.mainAccount` | Optional exact sender ID allowed to query `/status` in a direct chat |
| `messager.tools` | Tool names; omitted enables all built-ins, `[]` disables them |
| `messager.options` | Adapter settings below |
| `filters` | Ordered filters; omitted or `[]` skips filtering |

For editor completion and validation, add `$schema` pointing to
[schemas/config.schema.json](schemas/config.schema.json) or
[schemas/models.schema.json](schemas/models.schema.json) in the corresponding
file. For example: `"$schema": "file:///absolute/path/to/ChatServer/schemas/config.schema.json"`.
Encode spaces in file URLs as `%20`.

Inspect configuration without starting adapters:

```bash
npm start -- --config_dir ./chatserver-config --print-config
```

### WeChat options

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:6174` | Agent-wechat root URL, without `/api` |
| `tokenEnv` | `AGENT_WECHAT_TOKEN` | Environment variable containing the bearer token |
| `tokenFile` | unset | Token file used when the environment token is absent; relative to the config directory |
| `chatIds` | all chats | Exact conversation IDs to monitor; `[]` monitors none except `mainAccount`, if configured |
| `pollIntervalMs` | `30000` | Delay after each completed poll |
| `timeoutMs` | `30000` | Per-request API timeout |
| `bundleGapMs` | `20000` | Maximum gap between adjacent same-sender messages in a bundle; `0` disables bundling |

Tokens are read at startup. Group IDs typically end in `@chatroom`.
`mainAccount`, when set, is monitored even if omitted from `chatIds`. Its exact
`/status` command returns local queue, delivery, error, and polling information
without calling a model; it uses the normal reply delay. Other senders and group
status requests are ignored.

### Filters

For example, replace the quick start's empty `filters` with:

```json
[
  { "type": "ignore" },
  {
    "type": "model",
    "model": "local/your-model-id",
    "options": { "instructions": "Allow questions; deny advertisements; otherwise abstain." }
  }
]
```

`ignore` (alias `ignore-sender`) reads `wechat_ignore` in the config directory:
one sender ID per line or comma-separated, with `#` comments. Changes reload
without restarting. Use `options.file` for a different file or `options.senderIds`
for an inline list. Ignored messages are removed before models see them.

Model filters return `allowed`, `denied`, or `optional`. The first decisive result
wins; if all abstain, the replier decides. Errors fail closed. Filter models have
thinking disabled (`reasoning.effort: none`) and receive no tools; choose a provider
that supports that setting.

## Models

Provider URLs, model IDs/aliases, and provider-specific `timeoutMs` live in
`models.json`. Each provider requires an explicit `baseUrl`; requests default to a
**3-minute** timeout. API keys are stored separately under the provider name:
macOS Keychain, Linux Secret Service (`secret-tool`), or Windows Credential Manager
(requires the `CredentialManager` PowerShell module).

| Command | Purpose |
| --- | --- |
| `npm run model:add` | Guided provider/model setup; discovers advertised IDs or accepts manual input |
| `npm run model:update` | Guided provider/model editor; Enter keeps current values |
| `npm run model:list` | List configured providers and models; `--json` prints the configuration |
| `npm run model:test` | Send a test prompt to a configured model |
| `npm run model:remove` | Remove a model and its provider/key if no models remain |

Append `-- --config_dir ./chatserver-config` to select the quick start directory.
All commands support `--help`; add/update also support `--interactive` (`-i`).
Flags remain available for scripts:

```bash
npm run model:add -- --config_dir ./chatserver-config --provider local --base-url http://llm-host.local:1234/v1 --model your-model-id
npm run model:test -- --config_dir ./chatserver-config --provider local --name your-model-id
npm run model:update -- --config_dir ./chatserver-config --provider local --timeout 300000
```

`--name` selects a model's CLI alias (defaults to its ID). Update accepts `--model`
to change its API ID and `--new-name` to rename its alias. If the API ID changes,
update corresponding `config.json` references. Add requires overwrite confirmation
or `--force` for an existing alias. Commands without a terminal require flags.

Existing provider keys are reused. For missing keys, add reads `--api-key`, then
`OPENAI_API_KEY`, then a hidden prompt. Replace a saved key explicitly with
`--api-key`; `OPENAI_API_KEY` does not overwrite it. At runtime and in model tests,
`CHATSERVER_MODEL_API_KEY` overrides the saved key. Keys never go in `models.json`.

## Runtime behavior

- **Queue:** One FIFO entry per conversation. Each turn uses messages since the last
  successful reply, capped at the latest 30 source messages. New arrivals update
  pending context. Processing and sending are sequential, paced at 1–3 minutes.
- **History:** Messages from before startup, including those received while stopped,
  are skipped. Self messages provide context without triggering replies; manual
  replies arriving during generation invalidate the pending answer.
- **Media:** Text and images are supported; voice, video, stickers, and files are
  skipped. Up to four images per snapshot, each at most 5 MiB, are loaded lazily.
  Models receiving them must support image input. Pending media gets bounded
  retries; unavailable images are labeled rather than guessed.
- **Replies:** Text-only, with a 150-token target and 200-token hard cap. Oversized
  text is truncated locally. Malformed reply JSON or memory updates are logged in
  full and receive one formatting-only repair request without tools; a second
  invalid result stops delivery.
- **Memory:** Compact notes and confirmed replies persist per conversation for
  three days, capped at about 1,000 tokens. This is summarized context, not a raw
  message archive. Image bytes are not saved in memory.
- **Tools:** `web_search` (DuckDuckGo), `read_url`, `calculate`, and `current_time`
  are enabled by default. Models need Responses API function calling to use them.
  Page reading supports public HTTP(S) text/HTML/JSON, not PDFs or authenticated
  pages. Set `messager.tools` to select a subset or disable tools.
- **Failures:** Transient model errors retry the full generation up to three times,
  ten seconds apart. Polling backs off on API errors. Failed sends are never
  automatically retried because delivery may already have succeeded remotely.

Avoid overlapping pipelines for the same conversations, which can produce duplicate
replies. Reply pacing is per process and does not guarantee protection from account
bans.

## Development

```bash
npm run dev        # Auto-reload
npm run build      # Bundle server and model CLI into dist/
npm run typecheck
npm run lint
```

VS Code debug configurations and build tasks are in `.vscode/`. To use the built
executables directly, run `npm link`, then `chatserver` or `chatserver-models`.

Implementation entry points:
[server](src/server.ts), [config](src/config.ts),
[messagers](src/messagers/interface.ts), [filters](src/filters/interface.ts),
[repliers](src/repliers/interface.ts), and [tools](src/tools/interface.ts).
Register custom implementations in the corresponding registry before loading config.
