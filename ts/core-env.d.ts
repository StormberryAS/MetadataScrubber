// The globals the engine (ts/src/) uses beyond ES2022: TextDecoder, TextEncoder and
// DecompressionStream, which every browser the page supports and Node 24 have. Declared here, in
// the shape the engine uses and as the DOM library has them, only for tsconfig.core.json, which
// checks ts/src/ with no DOM at all, so that the engine cannot come to depend on a page. The
// programs that have the DOM library (tsconfig.json, tests/tsconfig.json, the bridge's) do not
// read this file. Types only, so tsc emits nothing for it; never served. Added on 1 November 2026
// with ts/src/core/bytes.ts, the first engine module in TypeScript (TS-STEP-1).

interface TextDecoder {
  decode(input?: Uint8Array): string;
}
declare var TextDecoder: {
  prototype: TextDecoder;
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};

interface TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}
declare var TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};

type CoreReadResult<T> = { done: false; value: T } | { done: true; value: undefined };

interface DecompressionStream {
  readonly writable: {
    getWriter(): {
      write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
      close(): Promise<void>;
    };
  };
  readonly readable: {
    getReader(): {
      read(): Promise<CoreReadResult<Uint8Array<ArrayBuffer>>>;
      cancel(reason?: unknown): Promise<void>;
    };
  };
}
declare var DecompressionStream: {
  prototype: DecompressionStream;
  new (format: 'deflate' | 'deflate-raw' | 'gzip'): DecompressionStream;
};
