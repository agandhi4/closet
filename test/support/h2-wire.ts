import type { AddressInfo } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import type { TestCertificate } from './tls-certificate';

/**
 * A hostile HTTP/2 server for outbound-fetch.spec.ts (#496b), speaking
 * frames by hand (RFC 9113) so it can send what Node's own server will not:
 * a header block past the client's limits, endless CONTINUATION frames, a
 * body cut by RST_STREAM or GOAWAY, a content-length that lies, floods of
 * SETTINGS and PING. It does the handshake (its SETTINGS, the ACK of the
 * client's) and hands each request's stream to the spec's `answer`.
 */

export const FRAME = {
  DATA: 0x0,
  HEADERS: 0x1,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PING: 0x6,
  GOAWAY: 0x7,
  CONTINUATION: 0x9,
} as const;
export const END_STREAM = 0x1;
export const END_HEADERS = 0x4;
const ACK = 0x1;
export const NO_ERROR = 0x0;
export const INTERNAL_ERROR = 0x2;

const PREFACE_LENGTH = 24; // "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
const FRAME_HEADER_LENGTH = 9;

export function frame(
  type: number,
  flags: number,
  streamId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LENGTH);
  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId, 5);
  return Buffer.concat([header, payload]);
}

/** `:status: 200`: HPACK's static table, index 8. */
export const STATUS_200 = Buffer.from([0x88]);

/** HPACK: a literal field, not indexed, with a new name (RFC 7541 6.2.2). */
export function field(name: string, value: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]),
    hpackString(name),
    hpackString(value),
  ]);
}

/** A string literal, no Huffman: its length as a 7-bit-prefix integer (5.1). */
function hpackString(text: string): Buffer {
  const bytes = Buffer.from(text, 'latin1');
  const length: number[] = [];
  if (bytes.length < 0x7f) {
    length.push(bytes.length);
  } else {
    length.push(0x7f);
    let rest = bytes.length - 0x7f;
    while (rest >= 0x80) {
      length.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    length.push(rest);
  }
  return Buffer.concat([Buffer.from(length), bytes]);
}

/** A response's HEADERS frame, its block complete. */
export function responseHeaders(
  streamId: number,
  headers: Record<string, string>,
  flags = 0,
): Buffer {
  const block = Buffer.concat([
    STATUS_200,
    ...Object.entries(headers).map(([name, value]) => field(name, value)),
  ]);
  return frame(FRAME.HEADERS, END_HEADERS | flags, streamId, block);
}

/** One request as the hostile server holds it. */
export interface H2Exchange {
  /** The client's stream. */
  streamId: number;
  socket: TLSSocket;
  /** Writes frames; false once the socket is gone or its buffer full. */
  send: (...frames: Buffer[]) => boolean;
}

export interface HostileH2Server {
  port: number;
  /** TLS connections accepted so far. */
  readonly connections: number;
  /** Connections still open. */
  readonly open: number;
  close(): Promise<void>;
}

export async function listenHostileH2(
  host: string,
  certificate: TestCertificate,
  answer: (exchange: H2Exchange) => void,
): Promise<HostileH2Server> {
  const sockets = new Set<TLSSocket>();
  let connections = 0;
  const server = createServer(
    { ...certificate, ALPNProtocols: ['h2'] },
    (socket) => {
      connections++;
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      const send = (...frames: Buffer[]) =>
        !socket.destroyed && socket.write(Buffer.concat(frames));
      send(frame(FRAME.SETTINGS, 0, 0));
      let pending = Buffer.alloc(0);
      let prefaceRead = false;
      socket.on('data', (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        if (!prefaceRead) {
          if (pending.length < PREFACE_LENGTH) return;
          pending = pending.subarray(PREFACE_LENGTH);
          prefaceRead = true;
        }
        while (pending.length >= FRAME_HEADER_LENGTH) {
          const length = pending.readUIntBE(0, 3);
          if (pending.length < FRAME_HEADER_LENGTH + length) return;
          const type = pending[3];
          const flags = pending[4];
          const streamId = pending.readUInt32BE(5) & 0x7fffffff;
          pending = pending.subarray(FRAME_HEADER_LENGTH + length);
          if (type === FRAME.SETTINGS && !(flags & ACK)) {
            send(frame(FRAME.SETTINGS, ACK, 0));
          } else if (type === FRAME.HEADERS && flags & END_HEADERS) {
            answer({ streamId, socket, send });
          }
        }
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
