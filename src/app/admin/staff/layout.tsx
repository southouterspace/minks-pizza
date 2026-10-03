import { ExternalLink } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { StaffTabs } from "@/components/staff/staff-tabs";

export default async function StaffLayout({ children }: LayoutProps<"/admin/staff">) {
  await requireOperator();
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <StaffTabs />
        <a
          href="/timeclock"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          Open time clock
        </a>
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}
