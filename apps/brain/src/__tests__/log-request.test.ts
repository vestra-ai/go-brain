import { describe, expect, it } from 'vitest';
import { logRequest } from '../app.js';

describe('the logged request line', () => {
  it('blanks any token in the URL and keeps the rest', () => {
    const req = { method: 'GET', host: 'go.example', ip: '10.0.0.1' };
    expect(logRequest({ ...req, url: '/board?token=abc123&hours=2' })).toEqual({ method: 'GET', url: '/board?token=[hidden]&hours=2', host: 'go.example', remoteAddress: '10.0.0.1' });
    expect(logRequest({ ...req, url: '/admin?trip=t_goa&TOKEN=secret-value' }).url).toBe('/admin?trip=t_goa&TOKEN=[hidden]');
    expect(logRequest({ ...req, url: '/v1/health' }).url).toBe('/v1/health');
    expect(JSON.stringify(logRequest({ ...req, url: '/stats.json?hours=1&token=s3cr3t' }))).not.toContain('s3cr3t');
  });
});
