import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PrintButton } from "./print-button";
import type { Paper } from "./report-document";

const PAPERS: { value: Paper; label: string }[] = [
  { value: "letter", label: "Letter" },
  { value: "receipt", label: "80mm receipt" },
];

/** Screen-only controls above a printable report, plus its @page size. */
export function ReportToolbar({
  backHref,
  pageHref,
  paper,
  csvQuery,
}: {
  backHref: string;
  /** This page with ?paper= set. */
  pageHref: (paper: Paper) => string;
  paper: Paper;
  /** "shift=<id>" or "date=YYYY-MM-DD". */
  csvQuery: string;
}) {
  return (
    <>
      <style>
        {paper === "receipt" ? "@page { size: 80mm auto; margin: 0; }" : "@page { size: letter; margin: 0.5in; }"}
      </style>
      <div className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Link href={backHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden="true" />
          Reports
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Paper" className="flex rounded-lg border border-border p-0.5">
            {PAPERS.map((p) => (
              <Link
                key={p.value}
                href={pageHref(p.value)}
                aria-current={p.value === paper ? "true" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  p.value === paper ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </Link>
            ))}
          </div>
          <a href={`/api/admin/reports/lines?${csvQuery}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" />
            Order lines CSV
          </a>
          <a href={`/api/admin/reports/tenders?${csvQuery}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" />
            Tenders CSV
          </a>
          <PrintButton />
        </div>
      </div>
    </>
  );
}
