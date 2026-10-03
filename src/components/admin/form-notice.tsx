/** The ?saved / ?error banner that admin forms redirect back with. */
export function FormNotice({ saved, error }: { saved?: string | null; error?: string | null }) {
  if (error) {
    return (
      <p role="alert" data-testid="form-error" className="mt-4 text-sm font-medium text-destructive">
        {error}
      </p>
    );
  }
  if (saved) {
    return (
      <p role="status" className="mt-4 text-sm font-medium text-success">
        {saved}
      </p>
    );
  }
  return null;
}
