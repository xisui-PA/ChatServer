import { IncomingMessage as HttpRequest, Server } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, MessageHandler, MessagerAdapter, OutgoingMessage } from './interface';

/**
 * Wire format used by the WebSocket transport.
 */
export interface ClientMessage {
  type: 'chat' | 'system';
  message: string;
}

export interface WebSocketMessagerOptions {
  /** HTTP server the WebSocket endpoint is attached to (standalone mode). */
  server: Server;
  /**
   * Shared hub used when several chats share one HTTP server.
   * When set, `server` is not used and the adapter registers itself with the hub.
   */
  hub?: WebSocketHub;
  /** URL path for this chat's endpoint. Defaults to `/`. */
  path?: string;
  /** Message sent to each client immediately after it connects. */
  welcomeMessage?: string;
}

/**
 * Extract the pathname from an upgrade request URL.
 */
function requestPath(url: string | undefined): string {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Routes WebSocket upgrades on a single HTTP server to several adapters by path.
 *
 * A single `WebSocketServer` owns the upgrade handling. This is required because
 * `ws` aborts upgrades it does not match, which corrupts the socket when multiple
 * `WebSocketServer` instances share one HTTP server.
 */
export class WebSocketHub {
  private readonly wss: WebSocketServer;
  private readonly routes = new Map<string, WebSocketMessagerAdapter>();

  public constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  /**
   * Registers an adapter for a path, failing on duplicate paths.
   */
  public register(path: string, adapter: WebSocketMessagerAdapter): void {
    if (this.routes.has(path)) {
      throw new Error(`Duplicate WebSocket path "${path}".`);
    }
    this.routes.set(path, adapter);
  }

  /**
   * Removes an adapter's path registration.
   */
  public unregister(path: string): void {
    this.routes.delete(path);
  }

  /**
   * Closes the shared WebSocket server.
   */
  public close(): void {
    this.routes.clear();
    this.wss.close();
  }

  private handleUpgrade(req: HttpRequest, socket: Duplex, head: Buffer): void {
    const path = requestPath(req.url);
    const adapter = this.routes.get(path);

    if (adapter === undefined) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      adapter.accept(ws, req);
    });
  }
}

/**
 * Default {@link MessagerAdapter} that relays messages over WebSockets.
 *
 * - Assigns each connection a stable `senderId`.
 * - Replies are broadcast to every other open client unless `direct` is set.
 */
export class WebSocketMessagerAdapter implements MessagerAdapter {
  public readonly name = 'websocket';

  private readonly options: WebSocketMessagerOptions;
  private readonly clients = new Map<string, WebSocket>();
  private nextClientId = 1;
  private wss?: WebSocketServer;
  private handler?: MessageHandler;
  private registeredPath?: string;

  public constructor(options: WebSocketMessagerOptions) {
    this.options = options;
  }

  public start(handler: MessageHandler): void {
    this.handler = handler;

    const endpoint = requestPath(this.options.path ?? '/');
    console.log(`[chat] websocket endpoint ready at ${endpoint}`);

    if (this.options.hub !== undefined) {
      this.registeredPath = endpoint;
      this.options.hub.register(endpoint, this);
      return;
    }

    const wss = new WebSocketServer({
      server: this.options.server,
      path: this.options.path
    });
    this.wss = wss;

    wss.on('connection', (socket: WebSocket, req) => {
      this.handleConnection(socket, req);
    });
  }

  /**
   * Accepts a connection routed by a {@link WebSocketHub}. Internal use.
   */
  public accept(socket: WebSocket, req: HttpRequest): void {
    this.handleConnection(socket, req);
  }

  /**
   * Wires up a newly accepted connection.
   */
  private handleConnection(socket: WebSocket, req: HttpRequest): void {
    const handler = this.handler;
    if (handler === undefined) {
      socket.close();
      return;
    }

    const senderId = `client-${this.nextClientId}`;
    this.nextClientId += 1;
    this.clients.set(senderId, socket);

    const ip = req.socket.remoteAddress;
    console.log(`[chat] ${senderId} connection opened from ${ip}`);

    const welcomeMessage = this.options.welcomeMessage ?? 'Connected to ChatServer';
    socket.send(
      JSON.stringify({ type: 'system', message: welcomeMessage } satisfies ClientMessage)
    );

    socket.on('message', (raw) => {
      handler({
        text: String(raw),
        senderId,
        metadata: { ip }
      });
    });

    socket.on('close', () => {
      this.clients.delete(senderId);
      console.log(`[chat] ${senderId} connection closed from ${ip}`);
    });
  }

  public reply(message: IncomingMessage, reply: OutgoingMessage): void {
    const payload = JSON.stringify({ type: 'chat', message: reply.text } satisfies ClientMessage);

    if (reply.direct) {
      const sender = this.clients.get(message.senderId);
      if (sender?.readyState === WebSocket.OPEN) {
        sender.send(payload);
      }
      return;
    }

    for (const [senderId, client] of this.clients) {
      if (senderId !== message.senderId && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public stop(): void {
    if (this.options.hub !== undefined && this.registeredPath !== undefined) {
      this.options.hub.unregister(this.registeredPath);
      this.registeredPath = undefined;
    }

    this.clients.clear();
    this.wss?.close();
    this.wss = undefined;
    this.handler = undefined;
  }
}
