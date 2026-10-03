import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireOperator } from "@/lib/auth";
import { getStoreBasics, getShiftReport } from "@/lib/orders-server";
import { UUID_RE, getShift } from "@/lib/reports-server";
import { formatStoreDateTime, storeDateOf } from "@/lib/store-time";
import { ReportDocument, type Paper } from "@/components/admin/report-document";
import { ReportToolbar } from "@/components/admin/report-toolbar";
import { formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Z report" };

export default async function ShiftReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const paper: Paper = (await searchParams).paper === "receipt" ? "receipt" : "letter";
  const [settings, row, report] = await Promise.all([getStoreBasics(), getShift(id), getShiftReport(id)]);
  if (!row || !report) notFound();
  const { shift, openedBy, closedBy } = row;
  const tz = settings.timezone;

  return (
    <div>
      <ReportToolbar
        backHref={`/admin/reports?date=${storeDateOf(shift.openedAt, tz)}`}
        pageHref={(p) => `/admin/reports/shift/${id}?paper=${p}`}
        paper={paper}
        csvQuery={`shift=${id}`}
      />
      <ReportDocument
        paper={paper}
        storeName={settings.name}
        title={shift.closedAt ? "Z report" : "X report (shift still open)"}
        tz={tz}
        details={[
          { label: "Opened", value: `${formatStoreDateTime(shift.openedAt, tz)} · ${openedBy}` },
          {
            label: "Closed",
            value: shift.closedAt ? `${formatStoreDateTime(shift.closedAt, tz)} · ${closedBy ?? "—"}` : "Still open",
          },
          { label: "Shift", value: shift.id.slice(0, 8) },
          { label: "Printed", value: formatStoreDateTime(new Date(), tz) },
          ...(shift.notes ? [{ label: "Closing note", value: shift.notes }] : []),
        ]}
        report={report}
        drawer={{ ...report, startingBankCents: shift.startingBankCents }}
      />
      <p className="mt-3 text-center text-xs text-muted-foreground print:hidden">
        Starting bank {formatCents(shift.startingBankCents)} · times in {tz}
      </p>
    </div>
  );
}
