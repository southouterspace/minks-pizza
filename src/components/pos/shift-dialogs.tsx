"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { notify } from "./notify";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closeShift, drawerEvent, openShift, previewShift } from "@/app/pos/actions";
import type { DrawerEventKind, ShiftReport } from "@/lib/orders";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { failureText, usePos } from "./context";
import { parseCents } from "./tender-dialog";
import { Tap } from "./touch";

const field = "h-12 rounded-xl border bg-background px-3 text-lg text-foreground outline-none focus:ring-3 focus:ring-ring/40";

export function OpenShiftDialog({ onClose }: { onClose: () => void }) {
  const { act, refreshBoard } = usePos();
  const [bank, setBank] = useState("150.00");
  const [busy, setBusy] = useState(false);
  const cents = parseCents(bank);
  // One id per dialog, so a double tap or a retry opens one shift.
  const [shiftId] = useState(() => crypto.randomUUID());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(440px,calc(100vw-2rem))] gap-4 sm:max-w-none!" data-testid="open-shift">
        <DialogHeader>
          <DialogTitle className="text-lg">Open the shift</DialogTitle>
          <DialogDescription>Count the starting bank in the drawer. Payments can&apos;t be taken until a shift is open.</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          Starting bank
          <input inputMode="decimal" autoFocus value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Starting bank" className={field} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Tap variant="outline" onClick={onClose}>
            Not now
          </Tap>
          <Tap
            disabled={cents === null || busy}
            data-testid="open-shift-confirm"
            onClick={async () => {
              setBusy(true);
              const r = await act("Open shift", () => openShift({ shiftId, startingBankCents: cents }));
              setBusy(false);
              if (r) {
                notify.success(`Shift open with ${formatCents(cents!)}`);
                await refreshBoard();
                onClose();
              }
            }}
          >
            Open shift
          </Tap>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const DRAWER: Record<DrawerEventKind, { title: string; amount: boolean; reasons: string[] }> = {
  no_sale: { title: "Open drawer (no sale)", amount: false, reasons: ["Make change", "Fix a mistake", "Count"] },
  paid_in: { title: "Paid in", amount: true, reasons: ["Add change", "Owner float"] },
  paid_out: { title: "Paid out", amount: true, reasons: ["Supplies", "Driver payout", "Vendor"] },
};

export function DrawerDialog({ kind, onClose }: { kind: DrawerEventKind; onClose: () => void }) {
  const { act } = usePos();
  const spec = DRAWER[kind];
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [id] = useState(() => crypto.randomUUID());
  const cents = spec.amount ? parseCents(amount) : 0;
  const ok = reason.trim() && cents !== null && (!spec.amount || cents > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(440px,calc(100vw-2rem))] gap-4 sm:max-w-none!">
        <DialogHeader>
          <DialogTitle className="text-lg">{spec.title}</DialogTitle>
          <DialogDescription>{kind === "paid_in" ? "Recorded against this shift's drawer." : "Needs a manager. Recorded against this shift's drawer."}</DialogDescription>
        </DialogHeader>
        {spec.amount && <input inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" aria-label="Amount" className={field} />}
        <div className="flex flex-wrap gap-2">
          {spec.reasons.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn("h-11 rounded-xl border px-3 text-sm", reason === r ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
              {r}
            </button>
          ))}
        </div>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Reason" className={field} />
        <div className="grid grid-cols-2 gap-2">
          <Tap variant="outline" onClick={onClose}>
            Back
          </Tap>
          <Tap
            disabled={!ok}
            onClick={async () => {
              const r = await act(spec.title, (approval) => drawerEvent({ id, kind, cents: cents ?? 0, reason: reason.trim(), approval }));
              if (r) {
                notify.success(`${spec.title} recorded`);
                onClose();
              }
            }}
          >
            Record
          </Tap>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Money({ label, cents, tone }: { label: string; cents: number | null; tone?: "good" | "bad" }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("text-right tabular-nums", tone === "good" && "text-success", tone === "bad" && "font-semibold text-destructive")}>
        {cents === null ? "—" : formatCents(cents)}
      </dd>
    </>
  );
}

const overShortTone = (c: number | null) => (c === null || c === 0 ? undefined : c > 0 ? "good" : "bad");

/** The Z-report body: expected vs counted, card vs batch, who voided and comped what. */
export function ShiftSummary({ report, names }: { report: ShiftReport; names: Record<number, string> }) {
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="shift-report">
      <dl className="grid grid-cols-2 gap-y-1">
        <Money label="Expected cash" cents={report.expectedCashCents} />
        <Money label="Counted cash" cents={report.countedCashCents} />
        <Money label="Cash over / short" cents={report.cashOverShortCents} tone={overShortTone(report.cashOverShortCents)} />
        <Money label="Card total (incl. tips)" cents={report.cardTotalCents} />
        <Money label="Card batch" cents={report.cardBatchCents} />
        <Money label="Card over / short" cents={report.cardOverShortCents} tone={overShortTone(report.cardOverShortCents)} />
        <Money label="Card tips" cents={report.cardTipsCents} />
        <Money label="Declared cash tips" cents={report.declaredCashTipsCents} />
      </dl>
      {report.byEmployee.length > 0 && (
        <table className="w-full text-left">
          <thead className="text-xs text-muted-foreground uppercase">
            <tr>
              <th className="font-medium">Employee</th>
              <th className="text-right font-medium">Voids</th>
              <th className="text-right font-medium">Comps</th>
              <th className="text-right font-medium">Discounts</th>
              <th className="text-right font-medium">No-sales</th>
            </tr>
          </thead>
          <tbody>
            {report.byEmployee.map((e) => (
              <tr key={e.employeeId}>
                <td>{names[e.employeeId] ?? `#${e.employeeId}`}</td>
                <td className="text-right tabular-nums">{e.voids} · {formatCents(e.voidCents)}</td>
                <td className="text-right tabular-nums">{e.comps} · {formatCents(e.compCents)}</td>
                <td className="text-right tabular-nums">{formatCents(e.discountCents)}</td>
                <td className="text-right tabular-nums">{e.noSales}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.unpaidOrders.length > 0 && (
        <div>
          <p className="font-semibold text-warning">Unpaid orders ({report.unpaidOrders.length})</p>
          <p className="text-muted-foreground">{report.unpaidOrders.map((o) => `#${o.number} ${o.customerName} ${formatCents(o.dueCents)}`).join(" · ")}</p>
        </div>
      )}
      {report.needsRefund.length > 0 && (
        <p className="font-semibold text-destructive">Canceled but paid: {report.needsRefund.map((o) => `#${o.number} ${formatCents(o.netCents)}`).join(" · ")}</p>
      )}
    </div>
  );
}

export function CloseShiftDialog({ shiftId, names, onClose }: { shiftId: string; names: Record<number, string>; onClose: () => void }) {
  const { act, refreshBoard } = usePos();
  const [running, setRunning] = useState<ShiftReport | null>(null);
  const [counts, setCounts] = useState({ cash: "", batch: "", tips: "0", notes: "" });
  const [closed, setClosed] = useState<ShiftReport | null>(null);

  useEffect(() => {
    let live = true;
    previewShift(shiftId)
      .then((r) => {
        if (!live) return;
        if (r.ok) setRunning(r.report);
        else notify.error(failureText(r));
      })
      .catch(() => notify.error(failureText({ reason: "offline" })));
    return () => {
      live = false;
    };
  }, [shiftId]);

  const cash = parseCents(counts.cash);
  const batch = parseCents(counts.batch);
  const tips = parseCents(counts.tips);
  // The preview applies the counts locally; the server recomputes on close.
  const preview: ShiftReport | null = running && {
    ...running,
    countedCashCents: cash,
    cashOverShortCents: cash === null ? null : cash - running.expectedCashCents,
    cardBatchCents: batch,
    cardOverShortCents: batch === null ? null : batch - running.cardTotalCents,
    declaredCashTipsCents: tips,
  };
  const report = closed ?? preview;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(680px,calc(100vw-2rem))] gap-4 overflow-y-auto sm:max-w-none!" data-testid="close-shift">
        <DialogHeader>
          <DialogTitle className="text-lg">{closed ? "Shift closed" : "Close the shift"}</DialogTitle>
          <DialogDescription>{closed ? "Print the Z report for the bank bag." : "Count the drawer and read the batch total off the card terminal. Needs a manager."}</DialogDescription>
        </DialogHeader>
        {!closed && (
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Counted cash
              <input inputMode="decimal" autoFocus value={counts.cash} onChange={(e) => setCounts({ ...counts, cash: e.target.value })} aria-label="Counted cash" className={field} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Card batch total
              <input inputMode="decimal" value={counts.batch} onChange={(e) => setCounts({ ...counts, batch: e.target.value })} aria-label="Card batch total" className={field} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Cash tips declared
              <input inputMode="decimal" value={counts.tips} onChange={(e) => setCounts({ ...counts, tips: e.target.value })} aria-label="Cash tips declared" className={field} />
            </label>
          </div>
        )}
        {report ? <ShiftSummary report={report} names={names} /> : <p className="text-muted-foreground">Loading the shift…</p>}
        <div className="grid grid-cols-2 gap-2">
          {closed ? (
            <>
              <Link href={`/admin/reports/shift/${shiftId}`} target="_blank" className={cn(buttonVariants({ variant: "outline" }), "h-12! rounded-xl! text-base!")} data-testid="z-report">
                Print Z report
              </Link>
              <Tap onClick={onClose}>Done</Tap>
            </>
          ) : (
            <>
              <Tap variant="outline" onClick={onClose}>
                Back
              </Tap>
              <Tap
                disabled={cash === null || batch === null || tips === null}
                data-testid="close-shift-confirm"
                onClick={async () => {
                  const r = await act("Close shift", (approval) =>
                    closeShift({ shiftId, countedCashCents: cash, cardBatchCents: batch, declaredCashTipsCents: tips, notes: counts.notes || null, approval }),
                  );
                  if (r) {
                    setClosed(r.report);
                    await refreshBoard();
                  }
                }}
              >
                Close shift
              </Tap>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
