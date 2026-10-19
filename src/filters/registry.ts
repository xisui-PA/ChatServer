import path from 'node:path';
import { IgnoreFile } from './ignore-file';
import { IgnoreSenderFilter } from './ignore-sender';
import { FilterAdapter } from './interface';
import { ModelFilter } from './model';
import { TextModel } from '../models/runtime';

/**
 * Context passed to filter factories when a chat is created.
 */
export interface FilterFactoryContext {
  /** Name of the chat the filter belongs to, used in error messages. */
  chatName: string;
  /** Directory of the config file; relative data files resolve against it. */
  configDir: string;
  /** Messager type used by the chat, e.g. `wechat`. */
  messagerType: string;
  /** Bound model supplied for model filters. */
  model?: TextModel;
  /** Configured provider/model reference, used to identify model filters in logs. */
  modelReference?: string;
  /** Server shutdown cancellation for model requests. */
  signal?: AbortSignal;
}

/**
 * Builds a filter from config-file options.
 */
export type FilterFactory = (
  options: Readonly<Record<string, unknown>>,
  context: FilterFactoryContext
) => FilterAdapter;

const factories = new Map<string, FilterFactory>();

/**
 * Registers a filter implementation under a config-file name.
 */
export function registerFilter(name: string, factory: FilterFactory): void {
  factories.set(name, factory);
}

/**
 * Returns true when a filter with this name is registered.
 */
export function hasFilter(name: string): boolean {
  return factories.has(name);
}

/**
 * Lists the names of all registered filters, sorted for stable messages.
 */
export function listFilters(): string[] {
  return [...factories.keys()].sort();
}

/**
 * Creates a filter by name, applying its config-file options.
 */
export function createFilter(
  name: string,
  options: Readonly<Record<string, unknown>>,
  context: FilterFactoryContext
): FilterAdapter {
  const factory = factories.get(name);
  if (factory === undefined) {
    throw new Error(`Unknown filter "${name}". Available filters: ${listFilters().join(', ')}.`);
  }
  return factory(options, context);
}

/**
 * Reads an optional array-of-strings option.
 */
function stringArrayOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): string[] | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label}: option "${key}" must be an array of strings.`);
  }
  return value;
}

/**
 * Reads an optional string option.
 */
function stringOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): string | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label}: option "${key}" must be a string.`);
  }
  return value;
}

const createIgnoreFilter: FilterFactory = (options, context) => {
  const label = `filter "ignore-sender" (chat "${context.chatName}")`;

  // Optional inline list, kept for quick overrides and backwards compatibility.
  const inlineIds = stringArrayOption(options, 'senderIds', label) ?? [];

  // Default to `<messager>_ignore` next to the config file.
  const fileOption = stringOption(options, 'file', label);
  const filePath = path.resolve(context.configDir, fileOption ?? `${context.messagerType}_ignore`);

  console.log(`[chat:${context.chatName}] filter "ignore-sender" using ${filePath}`);
  const ignoreFile = new IgnoreFile(filePath);
  // Load in the background so startup reports what was picked up.
  void ignoreFile.load();

  if (inlineIds.length === 0) {
    return new IgnoreSenderFilter(ignoreFile);
  }

  const inlineSource = { getSenderIds: () => new Set(inlineIds) };
  return new IgnoreSenderFilter({
    getSenderIds: async () => new Set([...(await ignoreFile.getSenderIds()), ...inlineSource.getSenderIds()])
  });
};

registerFilter('ignore', createIgnoreFilter);
registerFilter('ignore-sender', createIgnoreFilter);

registerFilter('model', (options, context) => {
  if (context.model === undefined) {
    throw new Error(`Model filter in chat "${context.chatName}" requires a bound model.`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'instructions') {
      throw new Error(`Model filter: unknown option "${key}".`);
    }
  }
  const instructions = stringOption(options, 'instructions', 'model filter');
  return new ModelFilter(context.model, instructions, context.signal, context.modelReference);
});
