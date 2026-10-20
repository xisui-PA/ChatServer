// Keep matching config schema defaults and bounds in sync when changing them here.

// Model input and conversation snapshots.
/**
 * Budget calculations with the current values:
 * - Recent-message JSON: CONVERSATION_TEXT_TOKENS - CONVERSATION_METADATA_TOKENS
 *   = 8,000 - 1,500 = 6,500 tokens; the snapshot including metadata gets 8,000.
 * - Combined text allowance: CONVERSATION_TEXT_TOKENS + MESSAGER_CONTEXT_TOKENS
 *   + MAX_MEMORY_TOKEN_LIMIT = 8,000 + 2,000 + 16,000 = 26,000 tokens.
 *   With the default memory limit: 8,000 + 2,000 + 1,000 = 11,000 tokens.
 * Metadata is already included in CONVERSATION_TEXT_TOKENS; do not add it again.
 * Actual memory uses messager.memoryTokenLimit; context and memory may be absent.
 * These sums exclude instructions, tool definitions/results, image estimates, and
 * wrapping serialization overhead. The complete input must fit MODEL_INPUT_TOKENS
 * (64,000 tokens), checked separately for each model request.
 */
/** Text budget for the recent-message snapshot and its metadata. */
export const CONVERSATION_TEXT_TOKENS = 8_000;
/** Snapshot tokens reserved for metadata rather than message text. */
export const CONVERSATION_METADATA_TOKENS = 1_500;
/** Maximum recent source messages retained per conversation. */
export const MAX_MESSAGES_PER_SNAPSHOT = 30;
/** Maximum text tokens retained from one source message. */
export const MESSAGE_TEXT_TOKENS = 2_000;
/** Fallback text budget when the last snapshot message is still too large. */
export const MIN_MESSAGE_TEXT_TOKENS = 500;
/** Maximum tokens for a sender or channel identifier in model input. */
export const CONVERSATION_ID_TOKENS = 100;
/** Maximum tokens for one sender display name in conversational context. */
export const SENDER_NAME_TOKENS = 100;
/** Separate token budget for the optional messager context file. */
export const MESSAGER_CONTEXT_TOKENS = 2_000;
/** Total application input budget, including instructions, tools, and images. */
export const MODEL_INPUT_TOKENS = 64_000;
/** Maximum retained tokens from one tool result. */
export const TOOL_RESULT_TOKENS = 8_000;
/** Estimated input tokens reserved per image, independent of provider billing. */
export const IMAGE_TOKEN_RESERVE = 2_048;
/** Tokens reserved for the truncation marker when bounding text. */
export const TRUNCATION_MARKER_TOKENS = 8;

// Public replies and persistent conversation memory.
/** Prompt target for a complete, concise public reply. */
export const SOFT_REPLY_TOKEN_LIMIT = 150;
/** Hard token cap applied to outgoing reply text. */
export const HARD_REPLY_TOKEN_LIMIT = 200;
/** Default per-conversation budget for memory notes and confirmed replies. */
export const DEFAULT_MEMORY_TOKEN_LIMIT = 1_000;
/** Smallest configurable memory budget, allowing room for entry metadata. */
export const MIN_MEMORY_TOKEN_LIMIT = 100;
/** Largest configurable memory budget and memory input allowance. */
export const MAX_MEMORY_TOKEN_LIMIT = 16_000;
/** Memory lifetime measured from the earliest original source. */
export const MEMORY_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
/** Interval between cleanup passes over inactive memory files. */
export const MEMORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
/** Maximum memory file size accepted from disk. */
export const MAX_MEMORY_FILE_BYTES = 256 * 1_024;
/** Maximum retained text tokens in a single memory note. */
export const MEMORY_NOTE_TOKENS = 300;
/** Maximum characters accepted in a model-proposed memory note. */
export const MAX_MEMORY_NOTE_CHARS = 4_000;
/** Maximum new or replacement memory notes proposed per turn. */
export const MAX_MEMORY_NOTES_PER_UPDATE = 20;
/** Maximum existing note IDs the model may forget per turn. */
export const MAX_MEMORY_FORGET_IDS = 50;
/** Maximum supporting source IDs per proposed memory note. */
export const MAX_MEMORY_SOURCE_IDS = 64;
/** Maximum characters in a stored memory ID or cited source ID. */
export const MAX_MEMORY_ID_CHARS = 128;

// Images, voice input, and local audio conversion.
/** Maximum decoded bytes in one received image. */
export const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024;
/** Maximum base64 characters encoding an allowed image. */
export const MAX_ENCODED_IMAGE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
/** Maximum decoded bytes in one voice recording or converted audio file. */
export const MAX_AUDIO_BYTES = 20 * 1_024 * 1_024;
/** Maximum base64 characters encoding an allowed voice recording. */
export const MAX_ENCODED_AUDIO_BYTES = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
/** Maximum images attached to a single model snapshot. */
export const MAX_IMAGES_PER_SNAPSHOT = 4;
/** Maximum download attempts per image or voice source. */
export const MAX_MEDIA_ATTEMPTS = 3;
/** Extra JSON response bytes allowed around base64 media. */
export const MEDIA_RESPONSE_OVERHEAD_BYTES = 64 * 1_024;
/** Maximum characters accepted from a speech-to-text model. */
export const MAX_TRANSCRIPT_CHARS = 32_000;
/** Default deadline for a local audio conversion command. */
export const AUDIO_CONVERSION_TIMEOUT_MS = 30_000;
/** Maximum stderr characters retained from an audio converter. */
export const AUDIO_CONVERSION_STDERR_CHARS = 8_192;
/** Maximum retries when deleting audio conversion temporary files. */
export const AUDIO_CLEANUP_RETRIES = 3;
/** Delay between retries deleting conversion temporary files. */
export const AUDIO_CLEANUP_RETRY_DELAY_MS = 100;

// Model requests, pacing, and transport defaults.
/** Largest duration supported by Node timers; a platform bound. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Default provider deadline for generation and transcription requests. */
export const DEFAULT_MODEL_TIMEOUT_MS = 180_000;
/** Retries after the initial attempt of a complete model generation. */
export const MAX_MODEL_RETRIES = 3;
/** Delay between complete model-generation retries. */
export const MODEL_RETRY_DELAY_MS = 10_000;
/** Maximum executed tool calls and tool-producing rounds per generation. */
export const MAX_MODEL_TOOL_CALLS = 8;
/** Maximum wait for model discovery in guided setup. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
/** Maximum choices printed when guided setup also accepts a custom value. */
export const MAX_SETUP_CHOICES = 30;
/** Minimum random delay before a reply slot becomes available. */
export const MIN_REPLY_DELAY_MS = 60_000;
/** Inclusive maximum random delay before a reply slot becomes available. */
export const MAX_REPLY_DELAY_MS = 180_000;
/** Maximum deferred conversation retries for pending media. */
export const MAX_PENDING_MEDIA_RETRIES = 2;
/** Initial delay for pending-media retries; doubles on each retry. */
export const PENDING_MEDIA_RETRY_DELAY_MS = 30_000;
/** Default delay after a completed WeChat poll. */
export const WECHAT_POLL_INTERVAL_MS = 30_000;
/** Default deadline for each WeChat REST request. */
export const WECHAT_REQUEST_TIMEOUT_MS = 30_000;
/** Default maximum timestamp gap for adjacent same-sender bundles. */
export const WECHAT_BUNDLE_GAP_MS = 20_000;
/** Maximum exponent used by WeChat polling failure backoff. */
export const WECHAT_MAX_BACKOFF_EXPONENT = 6;
/** Chat rows requested per WeChat API page. */
export const WECHAT_CHAT_PAGE_SIZE = 100;
/** Message rows requested per WeChat API page. */
export const WECHAT_MESSAGE_PAGE_SIZE = 50;
/** Default interval between ignore-file reload checks; zero disables caching. */
export const IGNORE_FILE_RELOAD_INTERVAL_MS = 1_000;

// Tool execution and web content.
/** Maximum characters in one serialized tool argument object. */
export const MAX_TOOL_ARGUMENT_CHARS = 16_384;
/** Maximum characters in one serialized tool execution result. */
export const MAX_TOOL_OUTPUT_CHARS = 32_768;
/** Maximum transferred bytes in a downloaded web page. */
export const MAX_WEB_DOWNLOAD_BYTES = 1_048_576;
/** Maximum decoded bytes in a web page after decompression. */
export const MAX_WEB_DECODED_BYTES = 1_048_576;
/** Shared deadline for a web download and all its redirects. */
export const WEB_REQUEST_TIMEOUT_MS = 15_000;
/** Maximum redirects followed while reading a public web page. */
export const MAX_WEB_REDIRECTS = 5;
/** Maximum characters in a URL accepted by read_url. */
export const MAX_READ_URL_CHARS = 2_048;
/** Maximum readable characters extracted from one web page. */
export const MAX_WEB_TEXT_CHARS = 20_000;
/** Text-length threshold for marking a page as possibly truncated. */
export const WEB_TRUNCATION_THRESHOLD_CHARS = MAX_WEB_TEXT_CHARS - 100;
/** Maximum HTML nodes visited during traversal or text extraction. */
export const MAX_HTML_NODES = 100_000;
/** Maximum characters retained in a web page title. */
export const MAX_WEB_TITLE_CHARS = 500;
/** Maximum results returned by the built-in web search provider. */
export const MAX_SEARCH_RESULTS = 5;
/** Maximum characters accepted in a web search query. */
export const MAX_SEARCH_QUERY_CHARS = 500;
/** Maximum characters retained in one search-result snippet. */
export const MAX_SEARCH_SNIPPET_CHARS = 1_000;
/** Maximum characters retained in one search-result title. */
export const MAX_SEARCH_TITLE_CHARS = 300;
/** Maximum characters accepted in a calculator expression. */
export const MAX_CALCULATE_EXPRESSION_CHARS = 1_000;
/** Maximum arithmetic grammar tokens accepted by the calculator. */
export const MAX_CALCULATE_TOKENS = 256;
/** Maximum arguments accepted by the calculator's min/max functions. */
export const MAX_CALCULATE_ARGUMENTS = 16;
/** Maximum characters accepted in a current_time timezone name. */
export const MAX_TIMEZONE_CHARS = 100;
