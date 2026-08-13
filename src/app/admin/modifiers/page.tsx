import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { db, itemModifierGroups, menuItems, modifierGroups, modifiers } from "@/db";
import { requireOperator } from "@/lib/auth";
import {
  createModifier,
  createModifierGroup,
  deleteModifier,
  deleteModifierGroup,
  toggleModifierAvailability,
  toggleModifierDefault,
  updateModifier,
  updateModifierGroup,
} from "@/app/admin/actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import {
  centsToDollars,
  formatDelta,
  inputClass,
  labelClass,
  primaryButtonClass,
  ruleSummary,
  smallButtonClass,
  summaryButtonClass,
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Modifiers" };

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.7l-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3z" />
    </svg>
  );
}

function GroupFields({
  idPrefix,
  defaults,
}: {
  idPrefix: string;
  defaults?: { name: string; minSelect: number; maxSelect: number | null };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label htmlFor={`${idPrefix}-name`} className={labelClass}>
          Name
        </label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name ?? ""}
          placeholder="e.g. Size"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-min`} className={labelClass}>
          Min selections
        </label>
        <input
          id={`${idPrefix}-min`}
          name="minSelect"
          type="number"
          min="0"
          step="1"
          defaultValue={defaults?.minSelect ?? 0}
          className={`${inputClass} tabular-nums`}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-max`} className={labelClass}>
          Max selections{" "}
          <span className="font-normal text-faint">(blank = unlimited)</span>
        </label>
        <input
          id={`${idPrefix}-max`}
          name="maxSelect"
          type="number"
          min="1"
          step="1"
          defaultValue={defaults?.maxSelect ?? ""}
          className={`${inputClass} tabular-nums`}
        />
      </div>
    </div>
  );
}

export default async function ModifiersPage() {
  await requireOperator();

  const groups = await db
    .select()
    .from(modifierGroups)
    .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.id));
  const allModifiers = await db
    .select()
    .from(modifiers)
    .orderBy(asc(modifiers.sortOrder), asc(modifiers.id));
  const usage = await db
    .select({
      groupId: itemModifierGroups.groupId,
      itemName: menuItems.name,
    })
    .from(itemModifierGroups)
    .innerJoin(menuItems, eq(itemModifierGroups.itemId, menuItems.id));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          Modifier groups
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted">
        Reusable option sets — sizes, crusts, toppings — that you attach to
        menu items.
      </p>

      {/* New group */}
      <details className="mt-6 rounded-lg border border-border">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          + New group
        </summary>
        <form
          action={createModifierGroup}
          className="space-y-3 border-t border-border p-4"
        >
          <GroupFields idPrefix="new-group" />
          <button type="submit" className={primaryButtonClass}>
            Add group
          </button>
        </form>
      </details>

      {groups.length === 0 ? (
        <div className="mt-6 rounded-lg border border-border px-6 py-14 text-center">
          <p className="text-sm font-medium">No modifier groups yet</p>
          <p className="mt-1 text-sm text-muted">
            Create one above — for example “Size” with a required single pick.
          </p>
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        {groups.map((group) => {
          const groupModifiers = allModifiers.filter(
            (m) => m.groupId === group.id,
          );
          const usedBy = [
            ...new Set(
              usage.filter((u) => u.groupId === group.id).map((u) => u.itemName),
            ),
          ];
          return (
            <section key={group.id} className="rounded-lg border border-border">
              {/* Group header */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">{group.name}</h2>
                <span className="text-xs text-muted">
                  {ruleSummary(group.minSelect, group.maxSelect)}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <details className="relative">
                    <summary className={summaryButtonClass}>Edit</summary>
                    <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-border bg-background p-4 shadow-sm">
                      <form
                        action={updateModifierGroup}
                        className="space-y-3"
                      >
                        <input
                          type="hidden"
                          name="groupId"
                          value={group.id}
                        />
                        <GroupFields
                          idPrefix={`group-${group.id}`}
                          defaults={{
                            name: group.name,
                            minSelect: group.minSelect,
                            maxSelect: group.maxSelect,
                          }}
                        />
                        <button
                          type="submit"
                          className={`${primaryButtonClass} w-full`}
                        >
                          Save
                        </button>
                      </form>
                    </div>
                  </details>
                  <form action={deleteModifierGroup}>
                    <input type="hidden" name="groupId" value={group.id} />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete group + options?"
                      className={smallButtonClass}
                      confirmClassName="inline-flex h-7 items-center rounded-md border border-error px-2.5 text-xs font-medium text-error transition-opacity hover:opacity-85"
                    />
                  </form>
                </div>
              </div>

              {/* Modifiers */}
              {groupModifiers.length === 0 ? (
                <p className="px-4 py-4 text-sm text-faint">
                  No options yet — add one below.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {groupModifiers.map((modifier) => (
                    <li
                      key={modifier.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
                    >
                      <form action={toggleModifierDefault}>
                        <input
                          type="hidden"
                          name="modifierId"
                          value={modifier.id}
                        />
                        <button
                          type="submit"
                          aria-label={
                            modifier.isDefault
                              ? `Unset ${modifier.name} as default`
                              : `Set ${modifier.name} as default`
                          }
                          title={
                            modifier.isDefault ? "Default" : "Make default"
                          }
                          className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                            modifier.isDefault
                              ? "text-foreground"
                              : "text-faint hover:text-foreground"
                          }`}
                        >
                          <StarIcon filled={modifier.isDefault} />
                        </button>
                      </form>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {modifier.name}
                      </span>
                      <span className="text-sm tabular-nums text-muted">
                        {formatDelta(modifier.priceDeltaCents)}
                      </span>
                      <form action={toggleModifierAvailability}>
                        <input
                          type="hidden"
                          name="modifierId"
                          value={modifier.id}
                        />
                        <button
                          type="submit"
                          className={`inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-opacity hover:opacity-80 ${
                            modifier.isAvailable
                              ? "border-success/40 text-success"
                              : "border-error/40 text-error"
                          }`}
                        >
                          {modifier.isAvailable
                            ? "Available"
                            : "86’d — unavailable"}
                        </button>
                      </form>
                      <details className="relative">
                        <summary className={summaryButtonClass}>Edit</summary>
                        <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-border bg-background p-4 shadow-sm">
                          <form action={updateModifier} className="space-y-3">
                            <input
                              type="hidden"
                              name="modifierId"
                              value={modifier.id}
                            />
                            <div>
                              <label
                                htmlFor={`mod-name-${modifier.id}`}
                                className={labelClass}
                              >
                                Name
                              </label>
                              <input
                                id={`mod-name-${modifier.id}`}
                                name="name"
                                type="text"
                                required
                                maxLength={120}
                                defaultValue={modifier.name}
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label
                                htmlFor={`mod-price-${modifier.id}`}
                                className={labelClass}
                              >
                                Price delta ($)
                              </label>
                              <input
                                id={`mod-price-${modifier.id}`}
                                name="price"
                                type="number"
                                step="0.01"
                                min="0"
                                defaultValue={centsToDollars(
                                  modifier.priceDeltaCents,
                                )}
                                className={`${inputClass} tabular-nums`}
                              />
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                name="isDefault"
                                defaultChecked={modifier.isDefault}
                                className="h-4 w-4 accent-black"
                              />
                              Selected by default
                            </label>
                            <button
                              type="submit"
                              className={`${primaryButtonClass} w-full`}
                            >
                              Save
                            </button>
                          </form>
                        </div>
                      </details>
                      <form action={deleteModifier}>
                        <input
                          type="hidden"
                          name="modifierId"
                          value={modifier.id}
                        />
                        <ConfirmButton
                          label="Delete"
                          confirmLabel="Really delete?"
                          className={smallButtonClass}
                          confirmClassName="inline-flex h-7 items-center rounded-md border border-error px-2.5 text-xs font-medium text-error transition-opacity hover:opacity-85"
                        />
                      </form>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add modifier */}
              <details className="border-t border-border">
                <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  + Add option
                </summary>
                <form
                  action={createModifier}
                  className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-end"
                >
                  <input type="hidden" name="groupId" value={group.id} />
                  <div className="flex-1">
                    <label
                      htmlFor={`add-mod-name-${group.id}`}
                      className={labelClass}
                    >
                      Name
                    </label>
                    <input
                      id={`add-mod-name-${group.id}`}
                      name="name"
                      type="text"
                      required
                      maxLength={120}
                      placeholder="e.g. Large 14&#34;"
                      className={inputClass}
                    />
                  </div>
                  <div className="w-full sm:w-36">
                    <label
                      htmlFor={`add-mod-price-${group.id}`}
                      className={labelClass}
                    >
                      Price delta ($)
                    </label>
                    <input
                      id={`add-mod-price-${group.id}`}
                      name="price"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue="0.00"
                      className={`${inputClass} tabular-nums`}
                    />
                  </div>
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="isDefault"
                      className="h-4 w-4 accent-black"
                    />
                    Default
                  </label>
                  <button type="submit" className={primaryButtonClass}>
                    Add
                  </button>
                </form>
              </details>

              <p className="border-t border-border px-4 py-2.5 text-xs text-faint">
                {usedBy.length > 0
                  ? `Used by: ${usedBy.join(", ")}`
                  : "Not attached to any items yet."}
              </p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
