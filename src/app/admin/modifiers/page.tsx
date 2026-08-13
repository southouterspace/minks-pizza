import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { SlidersHorizontal, Star } from "lucide-react";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  centsToDollars,
  formatDelta,
  ruleSummary,
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Modifiers" };

function GroupFields({
  idPrefix,
  defaults,
}: {
  idPrefix: string;
  defaults?: { name: string; minSelect: number; maxSelect: number | null };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name ?? ""}
          placeholder="e.g. Size"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-min`}>Min selections</FieldLabel>
        <Input
          id={`${idPrefix}-min`}
          name="minSelect"
          type="number"
          min="0"
          step="1"
          defaultValue={defaults?.minSelect ?? 0}
          className="tabular-nums"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-max`}>
          Max selections{" "}
          <span className="font-normal text-muted-foreground">
            (blank = unlimited)
          </span>
        </FieldLabel>
        <Input
          id={`${idPrefix}-max`}
          name="maxSelect"
          type="number"
          min="1"
          step="1"
          defaultValue={defaults?.maxSelect ?? ""}
          className="tabular-nums"
        />
      </Field>
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
      <p className="mt-1 text-sm text-muted-foreground">
        Reusable option sets — sizes, crusts, toppings — that you attach to
        menu items.
      </p>

      {/* New group */}
      <Card className="mt-6 gap-0! py-0!">
        <details>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            + New group
          </summary>
          <form
            action={createModifierGroup}
            className="space-y-3 border-t border-border p-4"
          >
            <GroupFields idPrefix="new-group" />
            <Button type="submit">Add group</Button>
          </form>
        </details>
      </Card>

      {groups.length === 0 ? (
        <Empty className="mt-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SlidersHorizontal />
            </EmptyMedia>
            <EmptyTitle>No modifier groups yet</EmptyTitle>
            <EmptyDescription>
              Create one above — for example “Size” with a required single
              pick.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
            <Card key={group.id} className="gap-0! py-0!">
              {/* Group header */}
              <CardHeader className="border-b pt-3 pb-3!">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{group.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {ruleSummary(group.minSelect, group.maxSelect)}
                  </span>
                </CardTitle>
                <CardAction className="flex flex-wrap items-center gap-1.5">
                  <details className="relative">
                    <summary
                      className={`${buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
                    >
                      Edit
                    </summary>
                    <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-border bg-popover p-4 text-left shadow-md">
                      <form action={updateModifierGroup} className="space-y-3">
                        <input type="hidden" name="groupId" value={group.id} />
                        <GroupFields
                          idPrefix={`group-${group.id}`}
                          defaults={{
                            name: group.name,
                            minSelect: group.minSelect,
                            maxSelect: group.maxSelect,
                          }}
                        />
                        <Button type="submit" className="w-full">
                          Save
                        </Button>
                      </form>
                    </div>
                  </details>
                  <form action={deleteModifierGroup}>
                    <input type="hidden" name="groupId" value={group.id} />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete group + options?"
                    />
                  </form>
                </CardAction>
              </CardHeader>

              {/* Modifiers */}
              {groupModifiers.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">
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
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            modifier.isDefault
                              ? `Unset ${modifier.name} as default`
                              : `Set ${modifier.name} as default`
                          }
                          title={
                            modifier.isDefault ? "Default" : "Make default"
                          }
                          className={
                            modifier.isDefault
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          <Star
                            fill={modifier.isDefault ? "currentColor" : "none"}
                          />
                        </Button>
                      </form>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {modifier.name}
                      </span>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {formatDelta(modifier.priceDeltaCents)}
                      </span>
                      <form action={toggleModifierAvailability}>
                        <input
                          type="hidden"
                          name="modifierId"
                          value={modifier.id}
                        />
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                          className={
                            modifier.isAvailable
                              ? "border-success/40! text-success!"
                              : "border-destructive/40! text-destructive!"
                          }
                        >
                          {modifier.isAvailable
                            ? "Available"
                            : "86’d — unavailable"}
                        </Button>
                      </form>
                      <details className="relative">
                        <summary
                          className={`${buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
                        >
                          Edit
                        </summary>
                        <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-border bg-popover p-4 text-left shadow-md">
                          <form action={updateModifier}>
                            <input
                              type="hidden"
                              name="modifierId"
                              value={modifier.id}
                            />
                            <FieldGroup>
                              <Field>
                                <FieldLabel htmlFor={`mod-name-${modifier.id}`}>
                                  Name
                                </FieldLabel>
                                <Input
                                  id={`mod-name-${modifier.id}`}
                                  name="name"
                                  type="text"
                                  required
                                  maxLength={120}
                                  defaultValue={modifier.name}
                                />
                              </Field>
                              <Field>
                                <FieldLabel
                                  htmlFor={`mod-price-${modifier.id}`}
                                >
                                  Price delta ($)
                                </FieldLabel>
                                <Input
                                  id={`mod-price-${modifier.id}`}
                                  name="price"
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  defaultValue={centsToDollars(
                                    modifier.priceDeltaCents,
                                  )}
                                  className="tabular-nums"
                                />
                              </Field>
                              <Field orientation="horizontal">
                                <Checkbox
                                  id={`mod-default-${modifier.id}`}
                                  name="isDefault"
                                  defaultChecked={modifier.isDefault}
                                />
                                <FieldLabel
                                  htmlFor={`mod-default-${modifier.id}`}
                                  className="font-normal!"
                                >
                                  Selected by default
                                </FieldLabel>
                              </Field>
                              <Button type="submit" className="w-full">
                                Save
                              </Button>
                            </FieldGroup>
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
                        />
                      </form>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add modifier */}
              <details className="border-t border-border">
                <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  + Add option
                </summary>
                <form
                  action={createModifier}
                  className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-end"
                >
                  <input type="hidden" name="groupId" value={group.id} />
                  <Field className="flex-1">
                    <FieldLabel htmlFor={`add-mod-name-${group.id}`}>
                      Name
                    </FieldLabel>
                    <Input
                      id={`add-mod-name-${group.id}`}
                      name="name"
                      type="text"
                      required
                      maxLength={120}
                      placeholder="e.g. Large 14&#34;"
                    />
                  </Field>
                  <Field className="w-full sm:w-36">
                    <FieldLabel htmlFor={`add-mod-price-${group.id}`}>
                      Price delta ($)
                    </FieldLabel>
                    <Input
                      id={`add-mod-price-${group.id}`}
                      name="price"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue="0.00"
                      className="tabular-nums"
                    />
                  </Field>
                  <Field
                    orientation="horizontal"
                    className="h-8 w-auto shrink-0"
                  >
                    <Checkbox
                      id={`add-mod-default-${group.id}`}
                      name="isDefault"
                    />
                    <FieldLabel
                      htmlFor={`add-mod-default-${group.id}`}
                      className="font-normal!"
                    >
                      Default
                    </FieldLabel>
                  </Field>
                  <Button type="submit" className="shrink-0">
                    Add
                  </Button>
                </form>
              </details>

              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                {usedBy.length > 0
                  ? `Used by: ${usedBy.join(", ")}`
                  : "Not attached to any items yet."}
              </p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
