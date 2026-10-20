// The legacy Node resolver does not follow this package's subpath type exports.
declare module 'js-tiktoken/ranks/o200k_base' {
  import { TiktokenBPE } from 'js-tiktoken/lite';
  const ranks: TiktokenBPE;
  export default ranks;
}
