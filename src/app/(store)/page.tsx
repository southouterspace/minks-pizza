import { getPublicMenu } from "@/lib/menu";
import { getSettings } from "@/lib/orders";
import { MenuBrowser } from "@/components/store/menu-browser";
import { ComingSoon } from "@/components/store/coming-soon";
import { StoreStatusBanner } from "@/components/store/status-banner";
import { RecentOrderLink } from "@/components/store/recent-order-link";
import { formatTime, DAY_NAMES } from "@/lib/hours";

export const dynamic = "force-dynamic";

export default async function StorePage() {
  const settings = await getSettings();

  if (!settings.isPublished) {
    return (
      <ComingSoon
        name={settings.name}
        phone={settings.phone}
        logoUrl={settings.logoUrl}
        logoUploadedAt={settings.logoUploadedAt}
      />
    );
  }

  const menu = await getPublicMenu();
  const todayHours = settings.hours?.find(
    (h) => h.day === new Date().getDay(),
  );

  return (
    <div>
      <section className="border-b border-border bg-muted">
        <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
            {settings.name}
          </h1>
          {settings.tagline ? (
            <p className="mt-3 max-w-xl text-lg text-muted-foreground">
              {settings.tagline}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <StoreStatusBanner
              hours={settings.hours ?? null}
              acceptingOrders={settings.isAcceptingOrders}
            />
            {settings.pickupEnabled ? (
              <span>Pickup · ~{settings.pickupPrepMinutes} min</span>
            ) : null}
            {settings.deliveryEnabled ? (
              <span>Delivery · ~{settings.deliveryPrepMinutes} min</span>
            ) : null}
          </div>
          <div className="mt-3">
            <RecentOrderLink />
          </div>
        </div>
      </section>

      {settings.isAcceptingOrders ? null : (
        <div className="border-b border-border bg-muted">
          <div className="mx-auto max-w-5xl px-4 py-3 text-sm font-medium text-warning sm:px-6">
            Online ordering is temporarily paused. Please call
            {settings.phone ? ` ${settings.phone}` : " the store"} to order.
          </div>
        </div>
      )}

      {menu.length === 0 ? (
        <div className="mx-auto max-w-5xl px-4 py-24 text-center sm:px-6">
          <p className="text-lg font-medium">Menu coming soon</p>
          <p className="mt-2 text-sm text-muted-foreground">
            We&apos;re still putting our menu together. Check back shortly.
          </p>
        </div>
      ) : (
        <MenuBrowser
          menu={menu}
          orderingEnabled={settings.isAcceptingOrders}
        />
      )}

      {settings.hours && settings.hours.length > 0 ? (
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
            <h2 className="text-lg font-semibold tracking-tight">Hours</h2>
            <dl className="mt-4 grid max-w-md gap-1.5 text-sm">
              {settings.hours
                .slice()
                .sort((a, b) => a.day - b.day)
                .map((h) => (
                  <div key={h.day} className="flex justify-between gap-8">
                    <dt className="text-muted-foreground">{DAY_NAMES[h.day]}</dt>
                    <dd className="font-medium tabular-nums">
                      {h.closed
                        ? "Closed"
                        : `${formatTime(h.open)} – ${formatTime(h.close)}`}
                    </dd>
                  </div>
                ))}
            </dl>
            {todayHours ? null : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
