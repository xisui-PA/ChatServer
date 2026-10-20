/** Splits provider/model-id at the first slash, preserving slashes in model IDs. */
export function parseModelReference(reference: string): { provider: string; modelId: string } {
  const separator = reference.indexOf('/');
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  if (separator < 1 || !modelId || provider.trim() !== provider || modelId.trim() !== modelId) {
    throw new Error(`Invalid model reference "${reference}"; expected <provider>/<model id>.`);
  }
  return { provider, modelId };
}
