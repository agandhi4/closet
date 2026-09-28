import { Socket } from 'node:net';
import { Client } from 'pg';
import { connectionOptions, type DbConfig } from '../db/client';
import type { Logger } from '../logger';
import { settlesWithin } from './deadline';
import { CUTOUT_QUEUED_CHANNEL } from './queries';

/**
 * How the connection shows in pg_stat_activity: an operator can tell it from
 * the pool's, and the specs find (and terminate) it by this name.
 */
export const LISTENER_APPLICATION_NAME = 'closet-cutout-listener';

// Reconnect backoff: doubling from the first to the cap, reset once
// listening again. The cap keeps a long database outage to a line a minute.
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
// A host that does not answer fails the attempt instead of hanging on the
// OS's TCP timeout.
const CONNECT_TIMEOUT_MS = 10_000;
// TCP keepalive: a connection that silently died (a NAS reboot, a dropped
// route) is eventually noticed and replaced. Until then the idle poll covers.
const KEEPALIVE_DELAY_MS = 60_000;
// How long close() waits for pg's orderly end (Terminate, then the server
// closing the socket) before destroying the socket itself. Milliseconds on a
// live connection; a peer that went silent would otherwise hold shutdown
// until TCP keepalive gave up on it, many minutes later.
const CLOSE_TIMEOUT_MS = 5_000;

export interface CutoutListenerDeps {
  /** Where the pool connects (dbConfig): the listener uses the same settings. */
  database: DbConfig;
  logger: Logger;
  /**
   * Called on every notification, and after every (re)connect: whatever was
   * notified while the connection was down is lost, so a new connection is
   * always followed by a look at the queue.
   */
  wake: () => void;
}

/**
 * The cutout queue's one dedicated LISTEN connection (CutoutQueue owns it
 * while started): outside the pool, because a pooled client is handed to
 * other queries and LISTEN belongs to one session. Writes in any process
 * notify CUTOUT_QUEUED_CHANNEL on commit (CUTOUT_QUEUED_NOTIFY). A dropped
 * connection is reopened with backoff; close() ends it for good.
 */
/**
 * A connection attempt: the pg client and the socket under it. The listener
 * creates the socket and hands it to pg (ClientConfig.stream), so close()
 * can always destroy it; pg itself has no way to.
 */
interface Connection {
  client: Client;
  socket: Socket;
}

export class CutoutListener {
  // The connection being opened or listening; undefined between attempts
  // and after close(). Callbacks from a connection that is no longer this
  // one are stale and ignored.
  private connection: Connection | undefined;
  private listening = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private closed = false;

  constructor(private readonly deps: CutoutListenerDeps) {}

  start(): void {
    void this.connect();
  }

  /**
   * Ends the connection and any pending reconnect; resolves once the socket
   * is closed, within CLOSE_TIMEOUT_MS: past it the socket is destroyed.
   * An attempt still connecting is ended too, and its connect() is not
   * awaited: pg never settles connect() on a client ended mid-connect.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await this.end(connection);
    this.deps.logger.info('Cutout listener closed');
  }

  private async end({ client, socket }: Connection): Promise<void> {
    // pg's end() never rejects.
    if (await settlesWithin(client.end(), CLOSE_TIMEOUT_MS)) return;
    this.deps.logger.warn(
      `Cutout listener connection did not close within ${CLOSE_TIMEOUT_MS / 1000} s; destroying its socket`,
    );
    socket.destroy();
  }

  // Never rejects: every failure goes through lost().
  private async connect(): Promise<void> {
    const { database, logger } = this.deps;
    const socket = new Socket();
    const client = new Client({
      ...connectionOptions(database),
      application_name: LISTENER_APPLICATION_NAME,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
      stream: () => socket,
    });
    const connection = { client, socket };
    this.connection = connection;
    this.listening = false;
    // Without an 'error' listener a dropped connection would kill the
    // process. 'end' follows every drop; lost() runs once per connection.
    client.on('error', (error) => this.lost(connection, error));
    client.on('end', () => this.lost(connection));
    client.on('notification', ({ channel }) => {
      if (channel !== CUTOUT_QUEUED_CHANNEL) return;
      logger.debug('Cutout listener notified: a cutout was queued');
      this.deps.wake();
    });
    try {
      await client.connect();
      await client.query(
        `LISTEN ${client.escapeIdentifier(CUTOUT_QUEUED_CHANNEL)}`,
      );
    } catch (error) {
      this.lost(connection, error);
      return;
    }
    // close() ran meanwhile and ended this connection.
    if (this.connection !== connection) return;
    this.listening = true;
    this.failures = 0;
    logger.info(
      `Cutout listener connected to ${database.database} on ${database.host}:${database.port}; listening on ${CUTOUT_QUEUED_CHANNEL}`,
    );
    this.deps.wake();
  }

  private lost(connection: Connection, error?: unknown): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    // Already broken: ending it only releases the socket.
    void this.end(connection);
    if (this.closed) return;
    const delay = Math.min(
      RECONNECT_FIRST_MS * 2 ** this.failures,
      RECONNECT_MAX_MS,
    );
    this.failures += 1;
    const reason = error instanceof Error ? error.message : 'connection ended';
    const retry = `reconnecting in ${delay / 1000} s`;
    this.deps.logger.warn(
      this.listening
        ? `Cutout listener lost its connection (${reason}); ${retry}`
        : `Cutout listener could not connect (attempt ${this.failures}: ${reason}); ${retry}`,
    );
    this.listening = false;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
