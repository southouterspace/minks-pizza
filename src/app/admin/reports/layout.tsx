import { REPORTS } from "@/lib/inventory-reports";
import { ReportTabs } from "./report-tabs";

export default function ReportsLayout({ children }: LayoutProps<"/admin/reports">) {
  return (
    <div data-wide>
      <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
      <ReportTabs tabs={REPORTS.map(({ slug, title }) => ({ slug, title }))} />
      {children}
    </div>
  );
}
