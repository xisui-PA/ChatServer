import { createChatServer } from './server';
import { PORT, HOST } from './config';

const server = createChatServer();

server.listen(PORT, HOST, () => {
  console.log(`ChatServer listening on http://${HOST}:${PORT}`);
});

/**
 * Gracefully stop the server on Ctrl+C / SIGTERM.
 */
const shutdown = () => {
  console.log('\nShutting down ChatServer...');
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
