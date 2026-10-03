import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireOperator } from "@/lib/auth";
import { getStoreBasics } from "@/lib/settings-server";
import { getDayReport } from "@/lib/reports-server";
import { formatLongDay, localDateSchema } from "@/lib/zoned";
import { formatDateTime } from "@/components/admin/ui";
import { ReportDocument, type Paper } from "@/components/admin/report-document";
import { ReportToolbar } from "@/components/admin/report-toolbar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Day report" };

export default async function DayReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const parsed = localDateSchema.safeParse((await params).date);
  if (!parsed.success) notFound();
  const date = parsed.data;
  const paper: Paper = (await searchParams).paper === "receipt" ? "receipt" : "letter";
  const settings = await getStoreBasics();
  const tz = settings.timezone;
  const report = await getDayReport(date, tz);

  return (
    <div>
      <ReportToolbar
        backHref={`/admin/reports?date=${date}`}
        pageHref={(p) => `/admin/reports/day/${date}?paper=${p}`}
        paper={paper}
        csvQuery={`date=${date}`}
      />
      <ReportDocument
        paper={paper}
        storeName={settings.name}
        title="Day report"
        tz={tz}
        details={[
          { label: "Day", value: formatLongDay(date) },
          { label: "Timezone", value: tz },
          { label: "Printed", value: formatDateTime(new Date(), tz) },
        ]}
        report={report}
        drawer={null}
      />
    </div>
  );
}
