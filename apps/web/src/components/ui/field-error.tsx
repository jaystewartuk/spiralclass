// Per-field validation message, styled and wired for aria the same way as
// the rest of the form components. Pass its `id` to the input's
// aria-describedby so screen readers announce the message on focus.
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" aria-live="polite" className="text-destructive text-xs">
      {message}
    </p>
  );
}
