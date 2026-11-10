# ChatServer

A TypeScript bridge between chat apps and LLM models. It filters incoming messages,
generates short replies, and retains compact conversation memory. The built-in
WeChat adapter connects to agent-wechat using outbound REST requests and its
v2.1 server-sent event stream; ChatServer opens no listening ports.

## Quick start: WeChat

Requires Node.js **24.15+**, a Responses API compatible model
provider, and a running, logged-in [agent-wechat server](https://github.com/thisnick/agent-wechat/tree/v2.1.0)
**v2.1.0 or newer** with a bearer token that grants the `read`, `send`, and `media`
scopes for its account. Incoming messages arrive over the daemon's authenticated
`/v1/accounts/{account}/events/stream` SSE endpoint; REST is used for sends, media,
and name lookups. WeChat login and agent-wechat setup are managed separately.

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
             "accountId": "your-account-id",
             "chatIds": ["wxid_example"]
           }
         },
         "filters": []
       }
     ]
   }
   ```

   Replace `replier` with the printed reference and `wxid_example` with a thread ID
   from `GET /v1/accounts/<account-id>/threads`: a contact username such as
   `wxid_example`, or a group ID ending in `@chatroom`. Set `baseUrl` to your
   agent-wechat server root; the adapter appends `/v1` itself, and a base URL that
   already ends in `/v1` is accepted. `GET /v1/accounts` lists the daemon account
   IDs with their `ownUsername` and `authenticated` flags; paste an ID into
   `accountId`, or omit it when exactly one authenticated account is visible to the
   token (more than one is rejected as ambiguous). `localTools: []` disables local
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

Create the agent-wechat token with the `read`, `send`, and `media` scopes for the
configured accounts; sending text needs `send`, lazy images and voice need `media`,
and the event stream needs `read`. The WeChat bearer token and the model provider's API key
are separate credentials.
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
memory and image-cache files. An empty `chats` array
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
| `messager.localTools` | Local tool names or `{ "type": "name" }` objects; omitted enables all five built-ins, `[]` disables local tools |
| `messager.apiTools` | Hosted tool type strings or definition objects; omitted or `[]` enables none |
| `messager.imageGeneration` | Optional boolean; omitted enables generation when `apiTools` includes `image_generation`; `true` adds that tool, `false` removes it |
| `messager.imageWidthLimit` | Maximum generated image width in pixels; defaults to `1024` |
| `messager.imageHeightLimit` | Maximum generated image height in pixels; defaults to `1024` |
| `messager.dailyImageGenLimit` | Daily image generation allowance shared across this messager's conversations; defaults to `10`; `0` disables it |
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
tools instead. Hosted tools must finish at the provider; text and generated image
results are supported. Client execution, approval exchanges, and other generated
artifacts are not implemented. Filters and formatting repairs receive no hosted
tools. Set both fields to `[]` and omit or disable `imageGeneration` to disable
all tool calling.

Each generation attempt allows up to eight local calls and eight hosted calls
across its model rounds, under the provider's existing timeout. Hosted requests
send `max_tool_calls` with the remaining hosted budget; providers must support
this Responses API parameter to enforce the cap during a response. All output
items, including hosted calls and reasoning, are replayed when local calls need
another round. Full-generation retries can repeat hosted calls and their charges;
completed image artifacts are preserved and reused across these retries.

Image generation uses the replier's provider-hosted
[`image_generation` Responses tool](https://developers.openai.com/api/docs/guides/tools-image-generation).
The selected provider/model must support this tool; there is no separate image
provider or fallback. Put these settings inside `messager`:

```json
{
  "imageGeneration": true,
  "imageWidthLimit": 1024,
  "imageHeightLimit": 1024,
  "dailyImageGenLimit": 10
}
```

Alternatively, include `"image_generation"` in `apiTools` and omit
`imageGeneration` to detect support from that selection. A definition object can
specify provider options such as `quality` or the hosted image `model`. Explicit
`imageGeneration: false` overrides that tool selection. The reply model generates
or edits images only for explicit requests. Model filters recognize these requests
when generation is enabled, and WeChat sends returned bytes as image messages,
with an optional caption. Image-only responses are supported.

`imageWidthLimit` and `imageHeightLimit` are independent integer pixel limits from
1 to 16384, each defaulting to 1024. ChatServer combines them into the provider's
`WIDTHxHEIGHT` size string; the provider must support the requested size. The tool
receives this size unless its configured concrete size fits within both limits.
`auto` and larger sizes are replaced by the combined limits. ChatServer requests PNG
and rejects returned images exceeding either dimension or the existing 5 MiB
image byte limit. Image bytes stay outside reply JSON and conversation memory;
confirmed memory records an image-delivery marker, any caption, and `imageIds`
linking the reply to its generated cache entries. These IDs count toward the
memory budget and allow `read_image` lookup after older labels leave `cachedImages`.

Generated images are saved in the conversation's existing image store as soon as
their provider output is validated, before later model rounds, formatting repair,
or delivery, including when `read_image` is disabled. If later model work fails,
the artifact remains cached; retries reuse the completed image without another
image generation call. They share the received-image
limits: three days from caching, at most 30 images, and 64 MiB of cache JSON per
conversation. Entries have their own generated-image IDs, assistant attribution,
`origin: "generated"`, and a `deliveryStatus` of `pending`, `sent`, or `failed`.
Only `sent` confirms delivery; failed or interrupted sends may remain unconfirmed.
Updating delivery status never extends retention. Cache write failures are logged
and do not block sending.

When `read_image` is enabled, generated image references appear in `cachedImages`
and their bytes can be inspected in later turns, including after a restart or
failed upload. Caching does not resend images, and no resend tool is provided.

Quota is kept only in memory for each configured messager pipeline, shared across
its conversations and generation retries. Usage resets on server restart and at
midnight in the server's local timezone. No quota files are read or written.
Before each image-capable provider request, ChatServer
reserves one slot and sets `max_tool_calls: 1` (also limiting other hosted calls
in that response). An unused slot is released when a response confirms no image
call occurred. Ambiguous provider failures retain their reservation; failed
delivery or rejected image bytes do not refund generation charges. Once an image
is generated, further local-tool rounds and model retries cannot generate another
for that reply. When quota is exhausted, image generation is removed from the
request and text replies remain available. WeChat image delivery stages the PNG with
`POST /v1/accounts/{account}/uploads`, then sends
`{ "kind": "image", "threadId": ..., "sourceId": ... }` to `POST /sends` with a
fresh `Idempotency-Key`, following the
[v2 media contract](https://github.com/thisnick/agent-wechat/blob/0f4ad16e4a245e3f8a57c0b8b800d304cb425c85/docs/src/content/docs/use/media.mdx).
The v2 API has no combined image/text send, so a caption is delivered as its own
text message after the images. Delivery is confirmed by the media job's `job.updated`
event over the adapter's existing event stream; an uncertain send is never
automatically retried.

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

Model inputs include a sender's WeChat display name when available, preferring a
group member's chatroom nickname, then the friend remark or contact name, then the
WeChat-wide nickname. Replies prefer that name when referring to a person. Stable
wxids still identify speakers and control `mainAccount`, ignore rules, and
delivery; names are never used for those checks. Names may change or be shared;
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
| `baseUrl` | `http://127.0.0.1:6174` | agent-wechat server root; a trailing `/v1` is also accepted |
| `accountId` | single authenticated account | Daemon account ID from `GET /v1/accounts` (not a WeChat username); omit only when exactly one authenticated account is visible |
| `tokenEnv` | `AGENT_WECHAT_TOKEN` | Environment variable containing the bearer token |
| `tokenFile` | unset | Token file used when the environment token is absent; relative to the config directory |
| `chatIds` | all chats | Exact conversation IDs to monitor; `[]` monitors none except `mainAccount`, if configured |
| `reconnectIntervalMs` | `1000` | Base delay before reconnecting the event stream; consecutive failures back off exponentially up to a bounded cap |
| `timeoutMs` | `30000` | Per-request API timeout, and the deadline for opening the event stream or waiting on its next chunk or heartbeat |

Tokens are read at startup and need the `read`, `send`, and `media` scopes for the
selected account. Group IDs typically end in `@chatroom`.
`mainAccount`, when set, is monitored even if omitted from `chatIds`. Its exact
`/status` command returns local queue, delivery, event-stream, and error information
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
thinking disabled (`reasoning.effort: none`); choose a provider that supports that
setting. When `read_image` is enabled for the pipeline, model filters can use it
to inspect cached images, but receive no other local or hosted tools.

## Models

Provider URLs, model IDs/aliases, and provider-specific `timeoutMs` live in
`models.json`. Each provider requires an explicit `baseUrl`; requests default to a
**5-minute** timeout. API keys are stored separately under the provider name:
macOS Keychain, Linux Secret Service (`secret-tool`), or Windows Credential Manager
(requires the `CredentialManager` PowerShell module).

Each entry in a provider's `models` array can set `supportsImageToolResults`.
It defaults to `false`; enable it only when that model endpoint accepts native
image content arrays in `function_call_output`:

```json
{
  "id": "gpt-6.1-sol",
  "name": "sol",
  "supportsImageToolResults": true
}
```

When enabled, the initial chat input contains image IDs and source labels without
image bytes. The model can call `read_image` when visual inspection is needed;
the image is returned directly inside that function's result. Keep `read_image`
enabled in `messager.localTools` for this mode. If image lookup is unavailable,
filters and repliers fall back to direct attachments. Pending optional images do
not defer a text-only decision; `read_image` can retry their source media if the
model asks to inspect them. Existing cached bytes are reused before fetching
source media again. With the default `false`, up to
four new images attach directly and older tool-retrieved images attach as a
separate image message on the next model round. Filter and replier models each
use their own setting, even when they share a chat snapshot. Restart the server
after changing model settings.

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

Voice media stays lazy: receiving events never downloads audio. When a turn needs the
recording, ChatServer lists `GET /v1/accounts/{account}/messages/{id}/media`, picks
the best copy, and asks for it with
`POST /messages/{id}/media-transfers` (`{ "messageId": ..., "assetId": ... }`). While
the download job runs the asset reports `pending`, and the existing bounded retries
defer the turn. Once an asset is `available`, its bytes are streamed from
`GET /v1/accounts/{account}/media/{assetId}/content`; the account-scoped route is
built locally rather than taken from the response. See the
[v2 incoming media contract](https://github.com/thisnick/agent-wechat/blob/0f4ad16e4a245e3f8a57c0b8b800d304cb425c85/docs/src/content/docs/use/quality.mdx).
The daemon's decoded voice copy is WAV, so STT models receive it directly; raw
`audio/silk` is rejected. Audio is limited to 20 MiB per message. Unavailable or
unsupported media and recordings with no recognized speech are skipped with a log.
STT request failures stop the turn rather than generating a reply from missing
audio. Without `stt`, voice messages are ignored without downloads or model
requests.

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

Voice replies use the normal serial queue and 1–3 minute pacing. The adapter stages
the padded WAV with `POST /uploads`, sends
`{ "kind": "voice", "threadId": ..., "sourceId": ... }` to `POST /sends` with a
fresh `Idempotency-Key`, and waits up to three minutes for the matching
`job.updated` event on the adapter's event stream; this requires agent-wechat
v2.1.0 or newer. Failure or uncertain delivery is logged without resending or
sending an extra text reply.
Unfinished jobs receive a best-effort `POST /jobs/{id}/cancel` on failure or
shutdown. Memory records the spoken text only after confirmed delivery; audio is
not saved.
Omitting `tts` keeps replies in text. Restart after configuration changes.

## Runtime behavior

- **Queue:** One FIFO entry per conversation. Each turn uses messages since the last
  successful reply or replier decision to stay silent, capped at the latest 30 source
  messages. Filter denials retain messages for later turns. New arrivals update
  pending context. Processing and sending are sequential, paced at 1–3 minutes.
- **Event stream:** `start` performs one
  `GET /v1/accounts/{account}/threads?limit=1` lookup and keeps only its
  `asOfEventCursor`; the returned threads are not paged and no message history is
  fetched. It then opens
  `GET /v1/accounts/{account}/events/stream?after=<cursor>` with a `read`-scoped
  bearer token. Event kinds are inside the JSON payload (`message.committed`,
  `account.updated`, `send.updated`, `job.updated`, ...);
  `message.committed` supplies `data.messageId` and `data.threadId`, and the full
  message is read with `GET /v1/accounts/{account}/messages/{id}`. Each decimal cursor
  is kept as a string (it may exceed JavaScript's safe integer range) and
  checkpointed after the message is read and dispatched, or after an intentional
  filter/skip decision. The daemon needs no consumer acknowledgement. Processing is
  sequential; a failed message read does not advance the checkpoint, so reconnecting
  replays that event. A committed event whose message row the daemon has already
  deleted (`GET` answers 404 or 410) is logged as an intentional skip and remembered
  by message ID, so the checkpoint advances and later events in the same stream are
  still handled; transient or authorization failures stay replayable. Heartbeat
  comments every 15 seconds keep the idle deadline open. Frames use the default SSE
  message event as the daemon sends them, with the kind inside the JSON payload:
  unknown payload kinds need no read and are checkpointed after safe handling. A named
  SSE event other than `message` is ignored without being checkpointed, except
  `event: error`, which is decoded for `event_cursor_expired` and otherwise fails the
  stream for a reconnect.
- **Live messages:** Only events after startup are delivered, and only that exact
  message route is read — never a message listing. A `message.committed` event is
  handed off as its own turn; the server queue then aggregates each conversation's
  buffered messages into one snapshot per turn, so a burst still arrives as bounded
  context even though every event was delivered individually. The cutoff is the
  message's saved `createdAt`: a message whose source time precedes startup, or that
  the daemon reports without a time, is skipped and remembered so a replay never
  delivers it. Equal source times are never merged or dropped. Self messages provide
  context without triggering replies; manual replies arriving during generation
  invalidate the pending answer. A replayed cursor at or below the checkpoint is
  compared as an integer string (never as a float) and skipped, so the checkpoint never
  regresses. Recently handled message IDs are kept in a bounded in-memory cache — the
  cursor checkpoint is the primary de-duplication — and the cache is cleared on stop,
  reset, or an identity switch.
  The daemon account ID and the signed-in `ownUsername` are captured around every
  awaited event and status read; an identity change stops that reader and
  tail-bootstraps the new login instead of checkpointing or delivering the previous
  login's events, and it settles that login's pending sends.
  If the daemon reports `event_cursor_expired` (HTTP before headers or an in-stream
  `event:error`), the adapter performs one more `threads?limit=1` lookup, rebases the
  checkpoint on that current tail and deliberately skips the missed window rather than
  backfilling history; it never resets to cursor zero. The capped reconnect backoff
  still applies, so repeated expiry against an unchanged tail cannot spin. A reconnect
  that is not an expiry resumes from the last processed cursor, so events the daemon
  still retains replay and are de-duplicated. Startup and expiry bootstrap the stream;
  ChatServer never pages `/threads/{thread}/messages` for history and never backfills.
- **Media:** Text, images, and optional STT voice input are supported; video,
  stickers, and files are skipped. The latest four new images per snapshot, each at most 5 MiB, are attached directly.
  Models receiving them must support image input. Pending media gets bounded
  retries; unavailable images are labeled rather than guessed.
  With `read_image` enabled, images in retained snapshot messages are also downloaded
  into `<conversation-hash>.images.json` beside the conversation memory file.
  Older images are represented by source labels in `cachedImages`; the tool attaches
  a requested image as native image input on the next model round. Models with
  `supportsImageToolResults: true` receive image IDs only in the initial input and
  receive requested images directly in tool results. Both repliers
  and model filters can use it. Lookups are restricted to the current account and
  conversation and work after restart. Images expire three days after the original
  source timestamp; lookup never refreshes expiry. Cleanup runs at startup and
  hourly, and expired entries cannot be retrieved between cleanups. Each conversation
  keeps at most 30 images and 64 MiB of cache JSON, evicting the oldest first.
  Recent cached-image labels have a 1,000-token prompt allowance; IDs retained in
  memory can still retrieve images omitted from that list. Without `read_image`,
  received images are attached directly without persistent image caching.
  Generated images are always cached before delivery; `read_image` is required
  for model inspection of these cached artifacts.
- **Replies:** Normally 1–2 short sentences, with a 150-token target and 200-token
  hard cap. Citations are included when explicitly requested or required by hosted tools. Oversized text
  is truncated locally. Malformed reply JSON or memory updates are logged in
  full and receive one formatting-only repair request without tools; a second
  invalid result stops delivery.
- **Memory:** Compact notes and confirmed replies persist per conversation for
  three days, capped at 1,000 tokens by default (`messager.memoryTokenLimit`). This is summarized context, not a raw
  message archive. Replier memory updates are saved even when it chooses not to reply;
  filter denials skip the replier and its memory updates. Image bytes live in the
  separate image cache and do not count toward the text memory budget.
- **Tools:** `web_search` (DuckDuckGo), `read_url`, `calculate`, `current_time`, and `read_image`
  are enabled by default. Models need Responses API function calling to use them.
  Page reading supports public HTTP(S) text/HTML/JSON, not PDFs or authenticated
  pages. Set `messager.localTools` to select a subset or disable local tools.
  `messager.apiTools` separately enables provider-hosted tools; its default is empty.
- **Identity:** The daemon account ID and the signed-in WeChat username are tracked
  separately. Every reply and lazy media load is fenced to both values captured when
  it originated, re-checked after each request, so a re-login on the same daemon
  profile cannot deliver someone else's queued reply or fetch their attachments.
  Conversation queues, memory files, and image caches are scoped by that same pair, so
  a cache written under an account-only identity is never adopted by a named login;
  this is a security fix with no migration of existing account-only caches.
- **Reconnect and status:** A closed, idle, or failed event stream reconnects with
  capped exponential backoff starting at `reconnectIntervalMs`. Heartbeat comments and
  received chunks reset the idle deadline; the backoff resets only after an event is
  handled, so a stream that connects but keeps failing to read a message backs off
  further. Every retry after the first re-reads the account and revalidates both the
  daemon account ID and `ownUsername`; a switch or re-login clears cursors, resets
  the startup cutoff, and re-bootstraps the stream from the new login's current tail.
  `/status` reports the last dispatched event, last stream activity, consecutive
  stream failures, and the last stream error. Transient model errors retry the full
  generation up to three times, ten seconds apart.
  Outbound confirmation arrives over the same event stream: a nonterminal
  `POST /sends` is settled by the matching `send.updated` (text) or `job.updated`
  (media) payload, with one `GET /sends/{id}` or `GET /jobs/{id}` read after
  registration and after each reconnect to reconcile a submission response or a
  confirmation that arrived while detached. There is no interval polling. A
  submission response that is already terminal is accepted or rejected immediately.
  IDs are opaque strings under `/v1/accounts/{account}/...`, text and media
  confirmations can never settle each other, and failed or uncertain sends are never
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
