import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * A single message that can be sent over the socket.
 */
export interface ClientMessage {
  type: 'chat' | 'system';
  message: string;
}

/**
 * Optional behaviour for {@link createChatServer}.
 */
export interface ChatServerOptions {
  /** Message sent to a client right after it connects. */
  welcomeMessage?: string;
}

/**
 * Builds an HTTP server that also hosts a WebSocket chat endpoint on the same port.
 * - Plain HTTP requests (e.g. `GET /`) return a small JSON health payload.
 * - WebSocket connections broadcast every chat message to all other connected clients.
 */
export function createChatServer(options: ChatServerOptions = {}): Server {
  const welcomeMessage = options.welcomeMessage ?? 'Connected to ChatServer';

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ChatServer' }));
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[chat] connection opened from ${ip}`);

    socket.send(
      JSON.stringify({ type: 'system', message: welcomeMessage } satisfies ClientMessage)
    );

    socket.on('message', (raw) => {
      const message = String(raw);
      console.log(`[chat] received: ${message}`);

      // Relay the message to every other open client.
      for (const client of wss.clients) {
        if (client !== socket && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'chat', message } satisfies ClientMessage));
        }
      }
    });

    socket.on('close', () => {
      console.log(`[chat] connection closed from ${ip}`);
    });
  });

  return httpServer;
}
