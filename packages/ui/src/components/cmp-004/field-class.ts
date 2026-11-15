/** Control surface shared by text input, textarea and (CMP-005) select; 40 px, 44 px on a phone. */
export const FIELD_CLASS =
  'w-full min-h-control max-md:min-h-control-touch bg-card text-foreground text-ui rounded-md border border-input px-3 ' +
  'placeholder:text-muted-foreground hover:border-foreground ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:border-foreground ' +
  'aria-invalid:border-destructive aria-invalid:border-l-4 ' +
  'disabled:bg-disabled disabled:text-disabled-foreground disabled:border-border disabled:cursor-not-allowed ' +
  'read-only:bg-muted read-only:border-dashed';
