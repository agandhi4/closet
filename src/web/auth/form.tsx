import type { Child } from 'hono/jsx';

/**
 * Building blocks of the account forms (login, registration, email,
 * password, deletion). Every form posts natively (`hx-boost="false"`): a
 * refusal answers 4xx with the page re-rendered, which htmx would not swap,
 * and a real form submission is what makes browsers offer to save or update
 * the password. A boosted registration never did, which cost the owner an
 * account generated and forgotten by the browser.
 */

export interface FieldProps {
  /** Also the input's name: browsers and password managers key on both. */
  id: string;
  label: string;
  type: 'email' | 'password' | 'text';
  /** https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill */
  autocomplete: 'username' | 'current-password' | 'new-password';
  value?: string;
  errors?: string[];
  minlength?: number;
}

/** A labelled input with its messages underneath; the input turns red with them. */
export function Field(props: FieldProps) {
  const invalid = (props.errors?.length ?? 0) > 0;
  return (
    <>
      <label class="label" for={props.id}>
        {props.label}
      </label>
      <label class={invalid ? 'input input-error' : 'input'}>
        <input
          id={props.id}
          name={props.id}
          type={props.type}
          value={props.value}
          placeholder={props.label}
          autocomplete={props.autocomplete}
          minlength={props.minlength}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={`${props.id}-errors`}
          required
        />
      </label>
      <FieldMessages field={props.id} messages={props.errors} />
    </>
  );
}

/**
 * A field's messages, in a slot the inline check can refill: rendered
 * (empty) under every field, and answered by the validate routes with
 * `oob` set, so htmx swaps each slot by id and leaves the inputs and the
 * submit button alone. Replacing those instead raced the user: a check
 * answering between mousedown and click (the click blurs the last input,
 * which triggers it) swapped the button away and the form never submitted.
 */
export function FieldMessages(props: {
  field: string;
  messages?: string[];
  oob?: boolean;
}) {
  return (
    <div
      id={`${props.field}-errors`}
      aria-live="polite"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      {props.messages?.map((message) => (
        <p class="text-error">{message}</p>
      ))}
    </div>
  );
}

/**
 * The answer to an inline check: every field's message slot, out of band,
 * so a field that is fine again has its old messages cleared.
 */
export function InlineErrors<Field extends string>(props: {
  fields: readonly Field[];
  errors: Partial<Record<Field, string[]>>;
}) {
  return (
    <>
      {props.fields.map((field) => (
        <FieldMessages field={field} messages={props.errors[field]} oob />
      ))}
    </>
  );
}

/** The one message a refused submission shows above the form. */
export function ErrorAlert({ message }: { message: string }) {
  return (
    <div role="alert" class="alert alert-error mb-4 w-xs">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-6 w-6 shrink-0 stroke-current"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span>{message}</span>
    </div>
  );
}

/**
 * A native POST form (see above). `confirm` asks before submitting; the
 * text travels as a data attribute, so nothing is spliced into the script.
 */
export function PostForm(props: {
  action: string;
  confirm?: string;
  children: Child;
}) {
  return (
    <form
      method="post"
      action={props.action}
      hx-boost="false"
      data-confirm={props.confirm}
      _={
        props.confirm
          ? 'on submit if not confirm(@data-confirm) halt the event end'
          : undefined
      }
    >
      {props.children}
    </form>
  );
}

export interface FieldsetProps {
  legend: string;
  /**
   * Inline validation: on every change the fieldset posts the form here;
   * the answer is only FieldErrors slots, swapped out of band (the fieldset
   * itself swaps nothing).
   */
  validateUrl?: string;
  children: Child;
}

export function Fieldset(props: FieldsetProps) {
  return (
    <fieldset
      class="fieldset bg-base-200 border-base-300 rounded-box w-xs border p-4"
      hx-post={props.validateUrl}
      hx-trigger={props.validateUrl ? 'change' : undefined}
      hx-swap={props.validateUrl ? 'none' : undefined}
    >
      <legend class="fieldset-legend">{props.legend}</legend>
      {props.children}
    </fieldset>
  );
}

/**
 * Never disabled by the inline check: that check runs on `change`, so it
 * lags the last keystroke, and a button dimmed by a stale answer swallowed
 * the very click that would have re-run it. The server validates the
 * submission anyway.
 */
export function SubmitButton(props: {
  label: string;
  variant?: 'neutral' | 'error';
}) {
  const color = props.variant === 'error' ? 'btn-error' : 'btn-neutral';
  return (
    <button type="submit" class={`btn ${color} mt-4`}>
      {props.label}
    </button>
  );
}
