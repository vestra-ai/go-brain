import { describe, expect, it } from 'vitest';
import { ev, msg } from '../../__tests__/fixtures/goa.js';
import { screenEvent, screenMessage } from '../screen.js';

describe('screen: card numbers, CVVs, codes and passwords never get past the door', () => {
  it('hides them in the text, photo captions and file names, and changes nothing else', () => {
    const m = msg(5, 'p_meher', 'OTP hai 482913', {
      attachments: [
        { kind: 'photo', url: 'https://cdn.go.example/p.jpg', caption: 'my card 4111-1111-1111-1111' },
        { kind: 'file', url: 'https://cdn.go.example/f.pdf', name: 'password is goa@123.pdf', mime: 'application/pdf', size_bytes: 1_200 },
        { kind: 'photo', url: 'https://cdn.go.example/q.jpg' },
      ],
    });
    const s = screenMessage(m);
    expect(s.text).toBe('OTP hai [hidden]');
    expect(s.attachments[0]).toMatchObject({ caption: 'my card [card number hidden]' });
    expect(s.attachments[1]).toMatchObject({ name: 'password is [hidden]' });
    expect(s.attachments[2]).toEqual(m.attachments[2]);
    expect({ ...s, text: m.text, attachments: m.attachments }).toEqual(m);
    expect(m.text).toBe('OTP hai 482913');
  });

  it('a deleted message with no text and a plain message come back as they were', () => {
    const gone = msg(6, 'p_rahul', 'x', { deleted: true, text: null });
    expect(screenMessage(gone)).toEqual(gone);
    const plain = msg(7, 'p_priya', 'flight 6E 2134 at 18:40, ₹54,200 per head');
    expect(screenMessage(plain)).toEqual(plain);
  });

  it('screens message.created and message.edited, and passes every other event through', () => {
    const created = ev(8, 'message.created', { message: msg(8, 'p_kabir', 'cvv 123 hai') });
    expect((screenEvent(created) as typeof created).data.message.text).toBe('cvv [hidden] hai');
    const edited = ev(9, 'message.edited', { message: msg(8, 'p_kabir', 'pin is 4321', { updated_seq: 9 }) });
    expect((screenEvent(edited) as typeof edited).data.message.text).toBe('pin is [hidden]');
    const left = ev(10, 'person.left', { person_id: 'p_kabir' });
    expect(screenEvent(left)).toBe(left);
  });
});
