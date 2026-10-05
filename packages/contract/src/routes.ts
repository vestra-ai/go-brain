import type { z } from 'zod';
import { Health } from './to-brain.js';
import { SOCKET_PATH } from './socket.js';

/**
 * go-brain's HTTP routes. Almost everything travels on the socket (socket.ts); HTTP is left for the
 * health check and for opening the socket itself. go-brain's pages (the vault, watching Go work) are
 * web pages the app opens from short-lived links, not API routes.
 */
export interface HttpRoute {
  id: string;
  method: 'GET';
  path: string;
  summary: string;
  signed: boolean;
  response: z.ZodType | null;
}

export const HTTP_ROUTES: readonly HttpRoute[] = [
  { id: 'openSocket', method: 'GET', path: SOCKET_PATH, signed: true, response: null,
    summary: 'Open the socket. A WebSocket upgrade, signed with x-go-signature (method GET, this path, empty body). The server keeps it open.' },
  { id: 'health', method: 'GET', path: '/v1/health', signed: false, response: Health,
    summary: 'Up, and which contract version it speaks. Not signed.' },
];
