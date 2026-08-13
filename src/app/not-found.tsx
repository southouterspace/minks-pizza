import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-32 text-center">
      <p className="font-mono text-sm text-faint">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">
        Page not found
      </h1>
      <p className="mt-2 text-sm text-muted">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
      >
        Back to the menu
      </Link>
    </div>
  );
}
