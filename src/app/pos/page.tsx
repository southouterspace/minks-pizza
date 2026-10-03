import type { Metadata, Viewport } from "next";
import { eq } from "drizzle-orm";
import { db, employees, storeSettings } from "@/db";
import { requireOperator } from "@/lib/auth";
import { getBoard, getPosMenu } from "@/lib/orders-server";
import { getStaff } from "@/lib/staff";
import { DEFAULT_TIMEZONE } from "@/lib/store-time";
import { POS_TOASTER } from "@/components/pos/notify";
import { PosTerminal } from "@/components/pos/terminal";
import { Toaster } from "@/components/ui/sonner";
import "./pos.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Counter" };

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false };

export default async function PosPage({ searchParams }: PageProps<"/pos">) {
  await requireOperator();
  const { order } = await searchParams;
  const [menu, board, staff, [settings], staffNames] = await Promise.all([
    getPosMenu(),
    getBoard(),
    getStaff(),
    db.select().from(storeSettings).where(eq(storeSettings.id, 1)),
    db.select({ id: employees.id, name: employees.name }).from(employees),
  ]);
  const address = settings
    ? [settings.addressLine1, settings.addressLine2, [settings.city, settings.state, settings.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : null;
  return (
    <>
      {/* Bottom left over the menu, raised above two wrapped rows of order actions. */}
      <Toaster id={POS_TOASTER} position="bottom-left" offset={{ left: 12, bottom: 128 }} />
      <PosTerminal
        initialMenu={menu}
        initialBoard={board}
        initialStaff={staff?.actor ?? null}
        store={{ name: settings?.name ?? "Mink's Pizza", phone: settings?.phone ?? null, address: address || null, timeZone: settings?.timezone ?? DEFAULT_TIMEZONE }}
        lockSeconds={settings?.posLockSeconds ?? 120}
        names={Object.fromEntries(staffNames.map((e) => [e.id, e.name]))}
        deepLinkOrderId={typeof order === "string" && /^[0-9a-f-]{36}$/i.test(order) ? order : null}
      />
    </>
  );
}
