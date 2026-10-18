import { describe, expect, it } from 'vitest';
import { FormField, inputAttributes } from './form-field';
import { renderToString } from './render';

// The contract every post form's field now shares; before the owner, half
// the copies were red without aria-invalid and half never announced.

function field(messages?: string[]) {
  return renderToString(
    <FormField id="trip-name" label="Name" required messages={messages}>
      <input
        {...inputAttributes('trip-name', 'w-full', messages)}
        name="name"
      />
    </FormField>,
  );
}

describe('FormField', () => {
  it('marks a refused field red, invalid, and described by its announced messages', async () => {
    const html = await field(['Required.', 'Too long.']);
    expect(html).toContain('<label class="label" for="trip-name">');
    expect(html).toContain('Name *');
    expect(html).toContain(
      'id="trip-name" class="input input-bordered w-full input-error" aria-invalid="true" aria-describedby="trip-name-messages"',
    );
    expect(html).toContain('<div id="trip-name-messages">');
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });

  it('leaves a field without messages plain', async () => {
    for (const messages of [undefined, []]) {
      const html = await field(messages);
      expect(html).toContain('class="input input-bordered w-full"');
      expect(html).not.toMatch(
        /input-error|aria-invalid|aria-describedby|role="alert"/,
      );
    }
  });
});
