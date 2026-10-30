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
           "replier": "local/your-model-id",
           "localTools": [],
           "apiTools": [],
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

   Replace `replier` with the printed reference and `wxid_example` with a direct
   chat or group ID from agent-wechat's `/api/chats`. Set `baseUrl` to your
   agent-wechat server root, without `/api`. `localTools: []` disables local
   functions; omit it to enable the built-ins. `apiTools` defaults to `[]`.

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
optional `<messager_name>_context` files, and automatically managed `conversations/`
memory files. An empty `chats` array
runs no adapters.

Set `messager.memoryTokenLimit` to change the token budget for each conversation
file belonging to that pipeline, for example `"memoryTokenLimit": 4000`. The
default is 1,000; valid limits are 100–16,000 tokens.
Notes and confirmed replies share this budget, including their compact JSON
metadata. Memory has a separate input allowance from the message snapshot.
Restart after changing the limit; lowering it removes the oldest entries on
the next turn for each conversation. Three-day expiry still applies. JSON
indentation and the file version field are not counted.

Each `chats` entry has a `messager` and optional `filters`:

| Field | Meaning |
| --- | --- |
| `messager.name` | Adapter name; currently `wechat` |
| `messager.replier` | `<provider>/<model id>` from `models.json`, using the actual ID, not its CLI alias |
| `messager.memoryTokenLimit` | Tokens per conversation for notes and confirmed replies; defaults to 1,000 |
| `messager.persona` | Optional replier identity, tone, and conversational style |
| `messager.mainAccount` | Optional exact sender ID allowed to query `/status` in a direct chat |
| `messager.localTools` | Local tool names or `{ "type": "name" }` objects; omitted enables all four built-ins, `[]` disables local tools |
| `messager.apiTools` | Hosted tool type strings or definition objects; omitted or `[]` enables none |
| `messager.options` | Adapter settings below |
| `filters` | Ordered filters; omitted or `[]` skips filtering |
| `stt` | Optional object with `type: "model"`, required `model`, and optional `audioConversionCmd`; omitted disables voice input |
| `tts` | Optional `{ "type": "model", "model": "provider/model-id", "options": { ... } }` for explicitly requested voice replies |

The former `messager.tools` field has been replaced by `messager.localTools`;
rename it in existing configurations. The old field is rejected with a migration
error so that a previous `tools: []` cannot silently enable the default tools.

Local and provider-hosted tools can be used together. For example, this enables
local arithmetic and time plus the provider's hosted web search:

```json
{
  "localTools": ["calculate", { "type": "current_time" }],
  "apiTools": [
    { "type": "web_search", "search_context_size": "low" }
  ]
}
```

Put these fields inside `messager`. Both arrays accept strings, objects, or a mix.
For example, `"apiTools": ["web_search"]` is equivalent to
`"apiTools": [{ "type": "web_search" }]`. Local objects contain only `type`,
which must name a registered local tool; duplicate names are deduplicated across
both forms. Hosted strings expand to `{ "type": "..." }`; hosted objects require
a nonempty `type` and preserve their provider-specific options. The resulting
objects are sent in the Responses API `tools` array alongside local function
declarations. Use the selected provider/model's
documented tool configuration; hosted tools are not discovered automatically.
The provider validates support and tool-specific options, and unsupported requests
fail rather than silently falling back to local tools. `function` and `custom`
definitions are rejected here: register application-executed functions as local
tools instead. Only hosted tools that finish at the provider and return text are
supported; client execution, approval exchanges, and generated artifact delivery
are not implemented. Filters and formatting repairs receive neither tool set.
Set both fields to `[]` to disable all tool calling.

Each generation attempt allows up to eight local calls and eight hosted calls
across its model rounds, under the provider's existing timeout. Hosted requests
send `max_tool_calls` with the remaining hosted budget; providers must support
this Responses API parameter to enforce the cap during a response. All output
items, including hosted calls and reasoning, are replayed when local calls need
another round. Full-generation retries can repeat hosted calls and their charges.

Provider URL citations are preserved as complete source links in outgoing text,
including after a formatting repair. Text is shortened to reserve room for links;
if the citations alone cannot fit the reply budget, delivery fails. Required hosted
citations are included even when the sender did not ask for sources, as required
by [OpenAI's hosted web search](https://developers.openai.com/api/docs/guides/tools-web-search).

The `messager.persona` setting accepts a nonempty string with one or more sentences.
For example: `"You are a warm, lightly humorous friend. Give practical photography advice. Keep your tone relaxed."`
Use `\n` within the JSON string to separate paragraphs; sentence breaks and newlines
are preserved in the prompt.
Omitting it keeps the default helpful assistant. It affects only the replier;
reply-length, citation, tool, JSON, and memory rules still apply. Restart the server
after changing this setting.

For editor completion and validation, add `$schema` pointing to
[schemas/config.schema.json](schemas/config.schema.json) or
[schemas/models.schema.json](schemas/models.schema.json) in the corresponding
file. For example: `"$schema": "file:///absolute/path/to/ChatServer/schemas/config.schema.json"`.
Encode spaces in file URLs as `%20`.

Inspect configuration without starting adapters:

```bash
npm start -- --config_dir ./chatserver-config --print-config
```

### Background context

Optionally create `<config_dir>/<messager_name>_context` yourself, for example
`chatserver-config/wechat_context`. Use plain UTF-8 text describing friends or
channels, with their IDs to identify which background applies:

```text
Friend wxid_alice: Alice is learning photography and prefers brief, practical tips.
Channel 123456@chatroom: A photography club discussing weekend outings.
```

Model inputs include the WeChat display name when available, and replies prefer
that name when referring to a person. Stable wxids still identify speakers and
control `mainAccount`, ignore rules, and delivery. Names may change or be shared;
use wxids in background entries to keep them unambiguous.

The background is included in model filter and replier inputs. It is shared by
pipelines with the same messager name and re-read for each processed turn, so
edits apply without restarting. Up to 2,000 tokens are included separately from
the message snapshot budget; longer context is marked truncated. Missing or empty
files add no context, and ChatServer never creates them. Read failures log a warning
and continue without background. Context is not sent to the STT model or saved as
conversation memory.

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
| `npm run model:test-stt` | Transcribe a local audio file with a configured STT model |
| `npm run model:test-tts` | Synthesize speech and save a WAV with the same padding as WeChat replies |
| `npm run model:remove` | Remove a model and its provider/key if no models remain |

Append `-- --config_dir ./chatserver-config` to select the quick start directory.
All commands support `--help`; add/update also support `--interactive` (`-i`).
Flags remain available for scripts:

```bash
npm run model:add -- --config_dir ./chatserver-config --provider local --base-url http://llm-host.local:1234/v1 --model your-model-id
npm run model:test -- --config_dir ./chatserver-config --provider local --name your-model-id
npm run model:update -- --config_dir ./chatserver-config --provider local --timeout 300000
```

Test speech models without sending any WeChat messages:

```bash
npm run model:test-stt -- --provider local --name your-stt-model --file ./voice.wav
npm run model:test-tts -- --provider local --name your-tts-model --voice your-provider-voice --text "Hello!" --output ./reply.wav
```

STT supports `--json` for a JSON transcript and `--audio-conversion-cmd` with
`{input}`/`{output}` for WAV-only engines, using the same conversion as chat input.
TTS accepts `--options` with a JSON object matching `tts.options`; `--voice` overrides
its voice setting. Output defaults to `tts-test.wav`; use `--force` to overwrite.
Both commands accept `--timeout`, `--config_dir`, and the same provider keys as
`model:test`. File paths resolve from the current directory.

`--name` selects a model's CLI alias (defaults to its ID). Update accepts `--model`
to change its API ID and `--new-name` to rename its alias. If the API ID changes,
update corresponding `config.json` references. Add requires overwrite confirmation
or `--force` for an existing alias. Commands without a terminal require flags.

Existing provider keys are reused. For missing keys, add reads `--api-key`, then
`OPENAI_API_KEY`, then a hidden prompt. Replace a saved key explicitly with
`--api-key`; `OPENAI_API_KEY` does not overwrite it. At runtime and in model tests,
`CHATSERVER_MODEL_API_KEY` overrides the saved key. Keys never go in `models.json`.

### Incoming voice

Add a speech-to-text model using `model:add`, then set `stt` alongside `messager`
and `filters` in the chat definition:

```json
{
  "messager": { "name": "wechat", "replier": "local/your-model-id" },
  "stt": {
    "type": "model",
    "model": "speech-provider/your-stt-model-id",
    "audioConversionCmd": "ffmpeg -nostdin -y -i {input} -ar 16000 -ac 1 -c:a pcm_s16le {output}"
  },
  "filters": []
}
```

The STT provider must implement the [OpenAI-compatible transcription endpoint](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
(`POST <baseUrl>/audio/transcriptions`, multipart `file`/`model`, JSON `text`). It
uses that provider's saved key, timeout, and normal model retries; it does not need
to support the Responses API. `model:test` sends chat prompts, not audio.

`type` is currently `"model"`. An explicit `model` is required and must support
transcription; it does not default to `messager.replier`. Replace
old string settings such as `"stt": "speech/model"` with the object above.

`audioConversionCmd` is optional. Set it for WAV-only engines such as speech.cpp;
omit it to upload the original audio. Install the converter (FFmpeg in this example)
on the **ChatServer machine**, available on PATH or specified by an absolute path.
The command runs in a temporary directory with `{input}` and `{output}` replaced
by generated filenames; it must write WAV to `{output}`. Quote executable paths
containing spaces using your operating system's shell syntax (escape double quotes
in JSON). Conversion has a 30-second deadline, supports shutdown cancellation, and
removes temporary files afterwards. Conversion errors stop the turn before any
STT request; cached successful transcripts do not repeat conversion.

Voice messages are transcribed sequentially after the reply delay and sender
exclusions, before model filters and the replier. Transcripts retain the original
sender, timestamp, and message ID and are reused across retained snapshots. Raw
audio is not saved in conversation memory. Configure `tts` separately for voice replies.

Agent-wechat normally [converts received voice to MP3](https://github.com/thisnick/agent-wechat/blob/main/packages/agent-server-rust/src/tools/wechat_media.rs).
Audio is limited to 20 MiB per message. Pending media gets bounded retries;
unsupported audio (including raw SILK when upstream conversion fails), unavailable
media, and recordings with no recognized speech are skipped with a log. STT
request failures stop the turn rather than generating a reply from missing audio.
Without `stt`, voice messages are ignored without downloads or model requests.

### Voice replies (TTS)

Add `tts` to the chat entry, alongside `messager`, `filters`, and optional `stt`:

```json
"tts": {
  "type": "model",
  "model": "local/your-tts-model-id",
  "options": { "voice": "your-provider-voice", "speed": 1 }
}
```

Register the TTS model in `models.json` using the model CLI. Its provider must
support an OpenAI-compatible `/audio/speech` endpoint returning uncompressed WAV.
`options` passes speech settings supported by that provider, such as `voice`,
`speed`, or `instructions`; it defaults to `{}`. ChatServer controls `model`,
`input`, `response_format` (`wav`), and `stream_format` (`audio`). Provider keys,
timeouts, and model-request retries work as for other models.

The replier selects voice only when the message being answered explicitly asks
for a voice reply. An incoming voice message alone does not select voice output.
The same short-reply limits apply to the spoken text. ChatServer adds independent
random **0.5–2 second** silences before and after the audio, without requiring
FFmpeg on the ChatServer machine.

Voice replies use the normal serial queue and 1–3 minute pacing. The adapter uploads
audio to agent-wechat's voice-job API and waits for confirmed completion, up to
three minutes; this requires an agent-wechat version with voice-job support.
Failure or uncertain delivery is logged without resending or sending an extra
text reply. Pending jobs receive best-effort cancellation on failure or shutdown.
Memory records the spoken text only after confirmed delivery; audio is not saved.
Omitting `tts` keeps replies in text. Restart after configuration changes.

## Runtime behavior

- **Queue:** One FIFO entry per conversation. Each turn uses messages since the last
  successful reply, capped at the latest 30 source messages. New arrivals update
  pending context. Processing and sending are sequential, paced at 1–3 minutes.
- **History:** Messages from before startup, including those received while stopped,
  are skipped. Self messages provide context without triggering replies; manual
  replies arriving during generation invalidate the pending answer.
- **Media:** Text, images, and optional STT voice input are supported; video,
  stickers, and files are skipped. Up to four images per snapshot, each at most 5 MiB, are loaded lazily.
  Models receiving them must support image input. Pending media gets bounded
  retries; unavailable images are labeled rather than guessed.
- **Replies:** Normally 1–2 short sentences, with a 150-token target and 200-token
  hard cap. Citations are included when explicitly requested or required by hosted tools. Oversized text
  is truncated locally. Malformed reply JSON or memory updates are logged in
  full and receive one formatting-only repair request without tools; a second
  invalid result stops delivery.
- **Memory:** Compact notes and confirmed replies persist per conversation for
  three days, capped at 1,000 tokens by default (`messager.memoryTokenLimit`). This is summarized context, not a raw
  message archive. Image bytes are not saved in memory.
- **Tools:** `web_search` (DuckDuckGo), `read_url`, `calculate`, and `current_time`
  are enabled by default. Models need Responses API function calling to use them.
  Page reading supports public HTTP(S) text/HTML/JSON, not PDFs or authenticated
  pages. Set `messager.localTools` to select a subset or disable local tools.
  `messager.apiTools` separately enables provider-hosted tools; its default is empty.
- **Failures:** Transient model errors retry the full generation up to three times,
  ten seconds apart. Polling backs off on API errors. Failed sends are never
  automatically retried because delivery may already have succeeded remotely.

Avoid overlapping pipelines for the same conversations, which can produce duplicate
replies. Reply pacing is per process and does not guarantee protection from account
bans.

## Development

Runtime limits and defaults are grouped and documented in [src/limit.ts](src/limit.ts).

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
