export function ComingSoon({
  name,
  phone,
}: {
  name: string;
  phone: string | null;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-32">
      <div className="text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent text-xl font-bold text-accent-foreground">
          {name.charAt(0)}
        </span>
        <h1 className="mt-6 text-3xl font-bold tracking-tight">{name}</h1>
        <p className="mt-3 text-muted">
          Online ordering is coming soon.
          {phone ? ` In the meantime, call us at ${phone}.` : ""}
        </p>
      </div>
    </div>
  );
}
