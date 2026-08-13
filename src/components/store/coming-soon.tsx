import { StoreMark } from "@/components/store-mark";

export function ComingSoon({
  name,
  phone,
  logoUrl = null,
  logoUploadedAt = null,
}: {
  name: string;
  phone: string | null;
  logoUrl?: string | null;
  logoUploadedAt?: Date | null;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-32">
      <div className="text-center">
        <StoreMark
          name={name}
          logoUrl={logoUrl}
          logoUploadedAt={logoUploadedAt}
          className="mx-auto max-h-28 w-auto max-w-64"
          textClassName="size-20 text-xl"
        />
        <h1 className="mt-6 text-3xl font-bold tracking-tight">{name}</h1>
        <p className="mt-3 text-muted-foreground">
          Online ordering is coming soon.
          {phone ? ` In the meantime, call us at ${phone}.` : ""}
        </p>
      </div>
    </div>
  );
}
