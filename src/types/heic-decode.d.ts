// heic-decode 2.x ships no types; this is the part of its API Photos uses
// (src/web/files/heic.ts). The container is parsed by all(); pixels are only
// allocated by decode(), so dimensions can be checked in between.
declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel. */
    data: Uint8ClampedArray;
  }

  interface HeicImage {
    width: number;
    height: number;
    decode(): Promise<DecodedImage>;
  }

  /** Must be disposed: libheif's WASM memory is not garbage collected. */
  interface HeicImages extends Array<HeicImage> {
    dispose(): void;
  }

  interface DecodeOptions {
    buffer: Uint8Array;
  }

  /** Decodes the primary image (the first). Rejects with a TypeError for bytes that are not HEIC. */
  function decode(options: DecodeOptions): Promise<DecodedImage>;
  namespace decode {
    function all(options: DecodeOptions): Promise<HeicImages>;
  }

  export = decode;
}
