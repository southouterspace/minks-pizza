import type { ReactNode } from "react";
import { Download } from "lucide-react";
import type { DateRange } from "@/lib/inventory-reports";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ExportLink({ href }: { href: string }) {
  return (
    <a href={href} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="export-csv">
      <Download data-icon="inline-start" />
      Export CSV
    </a>
  );
}

export function RangeForm({ range, csv }: { range: DateRange; csv: string }) {
  return (
    <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="r-from">From</Label>
          <Input id="r-from" name="from" type="date" defaultValue={range.from} className="w-40" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="r-to">To</Label>
          <Input id="r-to" name="to" type="date" defaultValue={range.to} className="w-40" />
        </div>
        <Button type="submit">Apply</Button>
      </form>
      <ExportLink href={csv} />
    </div>
  );
}

export function Kpis({ items }: { items: { label: string; value: string; hint?: string; tone?: string }[] }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="kpi-strip">
      {items.map((k) => (
        <div key={k.label} className="rounded-xl px-3 py-2.5 ring-1 ring-foreground/10">
          <dt className="text-xs text-muted-foreground">{k.label}</dt>
          <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", k.tone)}>{k.value}</dd>
          {k.hint ? <dd className="text-xs text-muted-foreground">{k.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mt-4 overflow-hidden rounded-xl ring-1 ring-foreground/10", className)}>{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm text-muted-foreground">{children}</p>;
}
