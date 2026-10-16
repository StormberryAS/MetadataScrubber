// The little of Node that src/core/bytes.js uses when the engine runs under the tests.
// The browser never takes that branch. Declared here so no @types package is needed.
// Type checking only, never served.

declare var process: { versions?: { node?: string } } | undefined;

declare module 'node:zlib' {
  /** inflateSync with `info: true` returns the output and the engine that made it. */
  export function inflateSync(
    data: Uint8Array,
    options: { maxOutputLength?: number; info: true },
  ): { buffer: Uint8Array; engine: { bytesWritten: number } };
}
