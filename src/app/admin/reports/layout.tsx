import { REPORTS } from "@/lib/inventory-reports";
import { ReportTabs } from "./report-tabs";

const TABS = [{ slug: "", title: "Sales" }, ...REPORTS.map(({ slug, title }) => ({ slug, title }))];

export default function ReportsLayout({ children }: LayoutProps<"/admin/reports">) {
  return (
    <div data-wide>
      <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
      <ReportTabs tabs={TABS} />
      {children}
    </div>
  );
}
