import type { ReactNode } from "react";
import { formatCents } from "@/lib/money";
import {
  AUDIT_SECTIONS,
  SALES_CHANNEL_LABEL,
  TENDER_METHOD_LABEL,
  type AuditEntry,
  type AuditKind,
  type DrawerReconciliation,
  type SalesReport,
} from "@/lib/orders";
import { formatStoreTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { STATUS_META } from "./order-card";

export type Paper = "letter" | "receipt";

/** "Over $1.00", "Short $6.00", "Even", or "Not counted". */
export function overShortLabel(cents: number | null): string {
  if (cents === null) return "Not counted";
  if (cents === 0) return "Even";
  return cents > 0 ? `Over ${formatCents(cents)}` : `Short ${formatCents(-cents)}`;
}

export function overShortTone(cents: number | null): string {
  if (cents === null) return "text-muted-foreground";
  return cents === 0 ? "text-success" : "text-destructive";
}

/**
 * The printable report: a shift's Z report when `drawer` is given, else a
 * day report. Rows are label/value pairs so the same markup reads on an
 * 80mm receipt and on a letter page.
 */
export function ReportDocument({
  paper,
  storeName,
  title,
  details,
  report,
  drawer,
  tz,
}: {
  paper: Paper;
  storeName: string;
  title: string;
  details: { label: string; value: string }[];
  report: SalesReport;
  drawer: (DrawerReconciliation & { startingBankCents: number }) | null;
  tz: string;
}) {
  const name = (id: number | null) => (id === null ? "—" : (report.staff[id] ?? `#${id}`));
  const byKind = (kind: AuditKind) => report.audit.filter((a) => a.kind === kind);
  const sum = (entries: AuditEntry[]) => entries.reduce((n, a) => n + a.cents, 0);
  const cash = report.byMethod.find((m) => m.method === "cash")!;

  return (
    <article
      data-testid="report-document"
      data-paper={paper}
      className={cn(
        "mx-auto rounded-lg border border-border bg-background text-foreground shadow-sm print:mx-0 print:border-0 print:shadow-none",
        // The receipt keeps its padding on paper: @page has no margin there
        // and thermal heads can't print to the edge.
        paper === "receipt"
          ? "max-w-[80mm] p-[4mm] font-mono text-[11px] leading-snug"
          : "max-w-[8.5in] p-8 text-sm print:p-0",
      )}
    >
      <header className="text-center">
        <p className={paper === "receipt" ? "text-sm font-bold" : "text-lg font-semibold"}>{storeName}</p>
        <h1 className={paper === "receipt" ? "font-bold uppercase" : "text-base font-semibold"}>{title}</h1>
      </header>
      <div className="mt-3 space-y-0.5">
        {details.map((d) => (
          <Row key={d.label} label={d.label} value={d.value} />
        ))}
      </div>

      <Section title="Sales by channel" paper={paper}>
        {report.byChannel.map((c) => (
          <Row
            key={c.channel}
            label={`${SALES_CHANNEL_LABEL[c.channel]} (${c.orders})`}
            value={formatCents(c.netCents)}
            muted={c.orders === 0}
          />
        ))}
        <Rule />
        <Row label="Gross sales" value={formatCents(report.sales.grossCents)} />
        <Row label="Discounts and comps" value={minus(report.sales.discountCents)} />
        <Row label={`Net sales (${report.sales.orders} orders)`} value={formatCents(report.sales.netCents)} strong />
        <Row label="Tax" value={formatCents(report.sales.taxCents)} />
        <Row label="Delivery fees" value={formatCents(report.sales.deliveryFeeCents)} />
        {report.sales.tipCents > 0 ? <Row label="Online tips" value={formatCents(report.sales.tipCents)} /> : null}
        <Row label="Order totals" value={formatCents(report.sales.totalCents)} strong />
      </Section>

      <Section title="Tenders" paper={paper}>
        {report.byMethod.map((m, i) => (
          <div key={m.method} className={i > 0 ? "mt-2" : undefined}>
            <p className="font-medium">{TENDER_METHOD_LABEL[m.method]}</p>
            <Row label={`Payments (${m.payments})`} value={formatCents(m.paymentCents)} indent />
            {m.method === "card_external" ? <Row label="Tips" value={formatCents(m.tipCents)} indent /> : null}
            <Row label="Refunds" value={minus(m.refundCents)} indent />
            <Row label={m.method === "cash" ? "Net cash" : "Net card incl. tips"} value={formatCents(m.netCents)} indent strong />
          </div>
        ))}
      </Section>

      {drawer ? (
        <Section title="Drawer" paper={paper}>
          <Row label="Starting bank" value={formatCents(drawer.startingBankCents)} />
          <Row label="Cash payments" value={formatCents(cash.paymentCents)} />
          <Row label="Cash refunds" value={minus(cash.refundCents)} />
          <Row label="Paid in" value={formatCents(sum(byKind("paid_in")))} />
          <Row label="Paid out" value={minus(sum(byKind("paid_out")))} />
          <Row label="Expected cash" value={formatCents(drawer.expectedCashCents)} strong />
          <Row label="Counted cash" value={drawer.countedCashCents === null ? "—" : formatCents(drawer.countedCashCents)} />
          <Row
            label="Cash over/short"
            value={overShortLabel(drawer.cashOverShortCents)}
            valueClassName={overShortTone(drawer.cashOverShortCents)}
            strong
            testId="cash-over-short"
          />
          <Rule />
          <Row label="Card total incl. tips" value={formatCents(drawer.cardTotalCents)} />
          <Row label="Terminal batch entered" value={drawer.cardBatchCents === null ? "—" : formatCents(drawer.cardBatchCents)} />
          <Row
            label="Card over/short"
            value={overShortLabel(drawer.cardOverShortCents)}
            valueClassName={overShortTone(drawer.cardOverShortCents)}
            strong
            testId="card-over-short"
          />
          <Rule />
          <Row
            label="Cash tips declared"
            value={drawer.declaredCashTipsCents === null ? "—" : formatCents(drawer.declaredCashTipsCents)}
          />
        </Section>
      ) : null}

      <Section title="Voids, comps, discounts and drawer" paper={paper}>
        {report.audit.length === 0 ? <p className="text-muted-foreground">None.</p> : null}
        {AUDIT_SECTIONS.map(({ kind, label }) => {
          const entries = byKind(kind);
          if (entries.length === 0) return null;
          return (
            <div key={kind} data-testid={`audit-${kind}`} className="mt-2 first:mt-0">
              <Row label={`${label} (${entries.length})`} value={kind === "no_sale" ? "" : formatCents(sum(entries))} strong />
              <ul className="mt-0.5 space-y-1.5">
                {entries.map((a, i) => (
                  <li key={i} className="pl-3">
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0">
                        {a.order ? `#${a.order.number}` : formatStoreTime(a.at, tz)}
                        {a.item ? ` ${a.item}` : ""}
                      </span>
                      {kind === "no_sale" ? null : <span className="shrink-0 tabular-nums">{formatCents(a.cents)}</span>}
                    </div>
                    <p className="text-muted-foreground">
                      {name(a.employeeId)}
                      {a.approvedBy !== null && a.approvedBy !== a.employeeId ? `, approved by ${name(a.approvedBy)}` : ""}
                      {a.order ? ` · ${formatStoreTime(a.at, tz)}` : ""}
                    </p>
                    {a.reason ? <p className="text-muted-foreground">“{a.reason}”</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Section>

      <Section title={`Unpaid orders (${report.unpaidOrders.length})`} paper={paper}>
        {report.unpaidOrders.length === 0 ? <p className="text-muted-foreground">None.</p> : null}
        {report.unpaidOrders.map((o) => (
          <Row
            key={o.id}
            label={`#${o.number} ${o.customerName} · ${STATUS_META[o.status].label}`}
            value={`${formatCents(o.dueCents)} due`}
          />
        ))}
      </Section>

      {report.needsRefund.length > 0 ? (
        <Section title={`Canceled with money kept (${report.needsRefund.length})`} paper={paper}>
          {report.needsRefund.map((o) => (
            <Row key={o.id} label={`#${o.number} needs a refund`} value={formatCents(o.netCents)} valueClassName="text-destructive" />
          ))}
        </Section>
      ) : null}
    </article>
  );
}

function minus(cents: number): string {
  return cents === 0 ? formatCents(0) : `−${formatCents(cents)}`;
}

function Section({ title, paper, children }: { title: string; paper: Paper; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-dashed border-border pt-3 break-inside-avoid-page">
      <h2 className={cn("mb-1.5 font-semibold", paper === "receipt" ? "uppercase" : "text-xs tracking-wide text-muted-foreground uppercase")}>
        {title}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Rule() {
  return <div className="my-1 border-t border-border" aria-hidden="true" />;
}

function Row({
  label,
  value,
  strong = false,
  indent = false,
  muted = false,
  valueClassName,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  indent?: boolean;
  muted?: boolean;
  valueClassName?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("flex justify-between gap-3", strong && "font-semibold", indent && "pl-3", muted && "text-muted-foreground")}
    >
      <span className="min-w-0">{label}</span>
      <span className={cn("shrink-0 text-right tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}
