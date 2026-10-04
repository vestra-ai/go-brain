/**
 * A COMPOSIO_MANAGE_CONNECTIONS that could mint no connect flow for a toolkit
 * (Spotify, 2026-09-21: Composio manages no auth for it and we have no auth
 * config of our own) must not end in a silent drop to the browser. The verdict
 * reads the result's STRUCTURED per-toolkit status, never its prose.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyComposioConnectUnavailable,
  connectUnavailableTrailer,
} from './composio-result.js';

const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS';
const LINK = 'https://connect.composio.dev/link/lk_F8J7EAwj8JHs';

/** The staging task's result, shape for shape (messages row, 2026-09-21). */
const SPOTIFY_FAILED = {
  data: {
    message: 'All connection attempts failed',
    results: {
      spotify: { toolkit: 'spotify', status: 'failed', error_message: 'auth is not managed for this toolkit' },
    },
    summary: { total_toolkits: 1, active_connections: 0, initiated_connections: 0, failed_connections: 1 },
  },
  error: null,
  successful: true,
};

const mcp = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

describe('classifyComposioConnectUnavailable', () => {
  it('a failed toolkit with no connect link is unavailable (the raw MCP result, as the native arm sees it)', () => {
    expect(classifyComposioConnectUnavailable(MANAGE, mcp(SPOTIFY_FAILED))).toEqual({
      kind: 'connect_unavailable',
      toolkits: ['spotify'],
    });
  });

  it('reads the same result as a content-block array or a JSON string (the Claude hook shapes)', () => {
    expect(classifyComposioConnectUnavailable(MANAGE, mcp(SPOTIFY_FAILED).content)?.toolkits).toEqual(['spotify']);
    expect(classifyComposioConnectUnavailable(MANAGE, JSON.stringify(SPOTIFY_FAILED))?.toolkits).toEqual(['spotify']);
  });

  it('an initiated connection is not unavailable (the connect card handles it)', () => {
    const initiated = {
      data: { results: { gmail: { toolkit: 'gmail', status: 'initiated', redirect_url: LINK } } },
      successful: true,
    };
    expect(classifyComposioConnectUnavailable(MANAGE, mcp(initiated))).toBeNull();
  });

  it('an active connection is not unavailable', () => {
    const active = { data: { results: { slack: { toolkit: 'slack', status: 'active' } } }, successful: true };
    expect(classifyComposioConnectUnavailable(MANAGE, mcp(active))).toBeNull();
  });

  it('names only the toolkits that failed in a mixed batch', () => {
    const mixed = {
      data: {
        results: {
          gmail: { toolkit: 'gmail', status: 'initiated', redirect_url: LINK },
          spotify: { toolkit: 'spotify', status: 'failed' },
          xero: { status: 'failed' },
        },
      },
    };
    expect(classifyComposioConnectUnavailable(MANAGE, mcp(mixed))?.toolkits).toEqual(['spotify', 'xero']);
  });

  it('prose alone is never read: a failure sentence without the structured status is null', () => {
    expect(classifyComposioConnectUnavailable(MANAGE, 'All connection attempts failed for spotify')).toBeNull();
  });

  it('only MANAGE_CONNECTIONS is read', () => {
    expect(classifyComposioConnectUnavailable('mcp__composio__SPOTIFY_CREATE_PLAYLIST', mcp(SPOTIFY_FAILED))).toBeNull();
    expect(classifyComposioConnectUnavailable('Bash', mcp(SPOTIFY_FAILED))).toBeNull();
  });
});

describe('connectUnavailableTrailer', () => {
  it('names the app, stays cause-neutral, and asks before the browser', () => {
    const line = connectUnavailableTrailer(['spotify']);
    expect(line).toContain('Spotify could not be connected here right now');
    expect(line).not.toMatch(/team|our side|sign-in/i);
    expect(line).toMatch(/ask/i);
    expect(line).toMatch(/browser/);
  });

  it('carries no em dash, no "cannot", no "Claude"', () => {
    const line = connectUnavailableTrailer(['spotify', 'xero']);
    expect(line).not.toMatch(/—|cannot|claude/i);
    expect(line).toContain('Spotify and Xero');
  });
});
