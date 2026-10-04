import { describe, it, expect } from 'vitest';
import type { AskQuestionRequest } from '../interaction.js';

// Browser handoff (2026-09-02): AskQuestionRequest carries where the person
// acts. This is a compile-time pin: `satisfies` runs excess-property checks on
// the literal, so a field missing from the interface fails `tsc --noEmit`.
describe('AskQuestionRequest — browser handoff fields (compile-time check)', () => {
  it('accepts surface / url / frame / why beside intent and source', () => {
    const req = {
      id: 'int-1',
      taskId: 'task-1',
      createdAt: 1_700_000_000_000,
      kind: 'ask_question',
      questions: [{ question: 'Sign in to WhatsApp Web', header: 'Handoff', options: [], multiSelect: false }],
      intent: 'handoff',
      source: 'request_user_input',
      surface: 'browser',
      url: 'https://web.whatsapp.com/',
      frame: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      why: 'The QR code is on screen.',
    } satisfies AskQuestionRequest;
    const phone = { ...req, surface: 'phone' } satisfies AskQuestionRequest;
    expect(req.surface).toBe('browser');
    expect(phone.surface).toBe('phone');
  });

  it('accepts answer: file | text (file answers, 2026-09-24)', () => {
    const req = {
      id: 'int-1',
      taskId: 'task-1',
      createdAt: 1_700_000_000_000,
      kind: 'ask_question',
      questions: [{ question: 'Attach the video you want cut', header: 'Handoff', options: [], multiSelect: false }],
      intent: 'handoff',
      source: 'request_user_input',
      answer: 'file',
    } satisfies AskQuestionRequest;
    const typed = { ...req, answer: 'text' } satisfies AskQuestionRequest;
    expect(req.answer).toBe('file');
    expect(typed.answer).toBe('text');
  });
});
