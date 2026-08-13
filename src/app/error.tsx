"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-32 text-center">
      <h1 className="text-2xl font-bold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-2 text-sm text-muted">
        Sorry about that — please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
      >
        Try again
      </button>
    </div>
  );
}
