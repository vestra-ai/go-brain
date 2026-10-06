import { describe, expect, it } from 'vitest';
import { parseSseFrames } from '../sse.js';

describe('parseSseFrames', () => {
  it('reads whole frames, keeps the unfinished rest, and reads the data as the whole event object', () => {
    const buf = 'id: 3\nevent: task.started\ndata: {"seq":3,"type":"task.started","data":{"task_id":"task_1"}}\n\n: comment\n\nevent: ping\ndata: {"type":"ping"}\n\nid: 4\nevent: task.pro';
    const { frames, rest } = parseSseFrames(buf);
    expect(frames).toEqual([
      { id: 3, event: 'task.started', data: { seq: 3, type: 'task.started', data: { task_id: 'task_1' } } },
      { id: null, event: 'ping', data: { type: 'ping' } },
    ]);
    expect(rest).toBe('id: 4\nevent: task.pro');
  });

  it('reads CRLF line ends and data spread over lines', () => {
    const { frames } = parseSseFrames('id: 9\r\nevent: x\r\ndata: {"a":\r\ndata: 1}\r\n\r\n');
    expect(frames).toEqual([{ id: 9, event: 'x', data: { a: 1 } }]);
  });
});
