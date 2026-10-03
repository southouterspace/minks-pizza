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
import Link from "next/link";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { RecipeEditor } from "@/components/admin/recipe-editor";
import {
  modifierRecipeLines,
  recipeIngredients,
  sizeModifiers,
} from "@/lib/recipe-data";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { GROUP_ROLE_LABEL, GROUP_ROLES, isPlaceable, type GroupRole } from "@/lib/pricing";
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
import { formatDelta, ruleSummary } from "@/components/admin/ui";
import { centsToDollars } from "@/lib/money";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Modifiers" };

function GroupFields({
  idPrefix,
  defaults,
}: {
  idPrefix: string;
  defaults?: {
    name: string;
    role: GroupRole;
    minSelect: number;
    maxSelect: number | null;
  };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
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
        <FieldLabel htmlFor={`${idPrefix}-role`}>Role</FieldLabel>
        <NativeSelect
          id={`${idPrefix}-role`}
          name="role"
          defaultValue={defaults?.role ?? "option"}
          className="w-full"
        >
          {GROUP_ROLES.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {GROUP_ROLE_LABEL[k]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
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

function ExtraPriceField({ id, cents }: { id: string; cents: number | null }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        Extra price ($){" "}
        <span className="font-normal text-muted-foreground">(blank = no extra)</span>
      </FieldLabel>
      <Input
        id={id}
        name="extraPrice"
        type="number"
        step="0.01"
        min="0"
        defaultValue={cents === null ? "" : centsToDollars(cents)}
        className="tabular-nums"
      />
    </Field>
  );
}

function recipeSummary(lines: readonly { ingredientId: number; qtyMilli: number }[]): string {
  if (lines.length === 0) return "none";
  const ingredientCount = new Set(lines.map((l) => l.ingredientId)).size;
  const removes = lines.some((l) => l.qtyMilli < 0);
  return `${ingredientCount} ingredient${ingredientCount === 1 ? "" : "s"}${removes ? ", removes some" : ""}`;
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
  const [allIngredients, sizes, recipeRows] = await Promise.all([
    recipeIngredients(),
    sizeModifiers(),
    modifierRecipeLines(),
  ]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          Modifier groups
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Reusable option sets — sizes, crusts, toppings — that you attach to
        menu items. A Size group picks which recipe amounts apply; Toppings
        offer halves, light and extra. Recipes use{" "}
        <Link
          href="/admin/inventory/ingredients"
          className="underline underline-offset-2 hover:text-foreground"
        >
          ingredients
        </Link>
        .
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
          const isToppings = isPlaceable(group.role);
          const recipeSizes = group.role === "size" ? [] : sizes;
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
                  <span
                    className="rounded-md border border-border px-1.5 py-0.5 text-xs font-normal"
                    data-testid={`group-role-${group.id}`}
                  >
                    {GROUP_ROLE_LABEL[group.role]}
                  </span>
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
                            role: group.role,
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
                        {isToppings && modifier.extraPriceDeltaCents !== null
                          ? ` · extra ${formatDelta(modifier.extraPriceDeltaCents)}`
                          : null}
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
                              {isToppings ? (
                                <ExtraPriceField
                                  id={`mod-extra-${modifier.id}`}
                                  cents={modifier.extraPriceDeltaCents}
                                />
                              ) : null}
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
                      <details
                        className="w-full"
                        data-testid={`recipe-toggle-${modifier.id}`}
                      >
                        <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                          Recipe ·{" "}
                          {recipeSummary(
                            recipeRows.filter((r) => r.modifierId === modifier.id),
                          )}
                        </summary>
                        <div className="pt-3 pb-1">
                          <RecipeEditor
                            owner={{ kind: "modifier", id: modifier.id }}
                            sizes={recipeSizes.map((s) => ({ id: s.id, name: s.name }))}
                            ingredients={allIngredients}
                            lines={recipeRows.filter((r) => r.modifierId === modifier.id)}
                            allowRemoval
                          />
                        </div>
                      </details>
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
                  {isToppings ? (
                    <div className="w-full sm:w-36">
                      <ExtraPriceField id={`add-mod-extra-${group.id}`} cents={null} />
                    </div>
                  ) : null}
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
