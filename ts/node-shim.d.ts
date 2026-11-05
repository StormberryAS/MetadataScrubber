// The little of Node that ts/src/core/bytes.ts uses when the engine runs under the tests.
// The browser never takes that branch. Declared here so the page's programs need no @types
// package (the tests have @types/node instead and do not read this file). Types only, so tsc
// emits nothing for it; never served.

declare var process: { versions?: { node?: string } } | undefined;

declare module 'node:zlib' {
  /** inflateSync with `info: true` returns the output and the engine that made it. */
  export function inflateSync(
    data: Uint8Array,
    options: { maxOutputLength?: number; info: true },
  ): { buffer: Uint8Array; engine: { bytesWritten: number } };
}
