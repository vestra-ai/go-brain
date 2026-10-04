import { describe, it, expect } from 'vitest';
import {
  INPUT_RENDERERS,
  FORM_FIELD_RENDERERS,
  validateRequestUserInputSpec,
} from '../interaction.js';

// Renderer-contract guard (staging incident 2026-07-16): the agent authored a
// form field as { type: 'textarea' } — a schema the FE has never spoken — and
// the user got a dead-end "Update required" card. These tests pin the mint-site
// validator that bounces such specs back to the model instead.
describe('validateRequestUserInputSpec', () => {
  it('accepts every simple renderer with an arbitrary config', () => {
    for (const renderer of INPUT_RENDERERS.filter((r) => r !== 'form')) {
      expect(validateRequestUserInputSpec({ renderer, config: {} })).toBeNull();
    }
  });

  it('accepts a form whose fields use contract renderers', () => {
    const spec = {
      renderer: 'form',
      config: {
        fields: [
          { name: 'task', label: 'Task', renderer: 'text', config: { multiline: true } },
          { name: 'shot', label: 'Screenshot', renderer: 'image-upload', required: false, config: {} },
        ],
      },
    };
    expect(validateRequestUserInputSpec(spec)).toBeNull();
  });

  it('rejects an unknown top-level renderer with the contract in the message', () => {
    const msg = validateRequestUserInputSpec({ renderer: 'textarea', config: {} });
    expect(msg).toContain("unknown renderer 'textarea'");
    expect(msg).toContain(`Valid renderers: ${INPUT_RENDERERS.join(', ')}`);
  });

  it('rejects a missing renderer / non-object input', () => {
    expect(validateRequestUserInputSpec({})).toContain('unknown renderer');
    expect(validateRequestUserInputSpec(undefined)).toContain('unknown renderer');
    expect(validateRequestUserInputSpec('form')).toContain('unknown renderer');
  });

  it('rejects a form with missing or empty fields', () => {
    expect(validateRequestUserInputSpec({ renderer: 'form', config: {} }))
      .toContain('non-empty config.fields');
    expect(validateRequestUserInputSpec({ renderer: 'form', config: { fields: [] } }))
      .toContain('non-empty config.fields');
  });

  it("rejects the incident shape — a field authored with 'type' instead of 'renderer'", () => {
    const msg = validateRequestUserInputSpec({
      renderer: 'form',
      config: {
        fields: [{ name: 'task', label: 'Task for the agent', type: 'textarea', required: true }],
      },
    });
    expect(msg).toContain("form field 'task' has invalid renderer");
    expect(msg).toContain("NOT 'type'");
  });

  it('rejects nested form and secret as field renderers', () => {
    for (const renderer of ['form', 'secret']) {
      const msg = validateRequestUserInputSpec({
        renderer: 'form',
        config: { fields: [{ name: 'f', label: 'F', renderer, config: {} }] },
      });
      expect(msg).toContain("invalid renderer");
    }
    expect(FORM_FIELD_RENDERERS).not.toContain('form');
    expect(FORM_FIELD_RENDERERS).not.toContain('secret');
  });

  it('rejects a field without a string name/label', () => {
    const msg = validateRequestUserInputSpec({
      renderer: 'form',
      config: { fields: [{ renderer: 'text', config: {} }] },
    });
    expect(msg).toContain("string 'name' and 'label'");
  });
});
