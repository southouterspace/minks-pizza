import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowDown, ArrowUp, Plus, UtensilsCrossed } from "lucide-react";
import { categories, db, menuItems } from "@/db";
import { requireOperator } from "@/lib/auth";
import {
  KITCHEN_STATIONS,
  STATION_LABEL,
  type KitchenStation,
} from "@/lib/kds";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { formatCents } from "@/lib/money";
import {
  createCategory,
  deleteCategory,
  deleteItem,
  moveCategory,
  moveItem,
  toggleCategoryActive,
  toggleItemAvailability,
  updateCategory,
} from "@/app/admin/actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Menu" };

function ReorderButtons({
  action,
  idName,
  id,
  isFirst,
  isLast,
}: {
  action: (formData: FormData) => Promise<void>;
  idName: string;
  id: number;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <form action={action}>
        <input type="hidden" name={idName} value={id} />
        <input type="hidden" name="direction" value="up" />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          disabled={isFirst}
          aria-label="Move up"
          className="text-muted-foreground"
        >
          <ArrowUp />
        </Button>
      </form>
      <form action={action}>
        <input type="hidden" name={idName} value={id} />
        <input type="hidden" name="direction" value="down" />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          disabled={isLast}
          aria-label="Move down"
          className="text-muted-foreground"
        >
          <ArrowDown />
        </Button>
      </form>
    </div>
  );
}

export default async function MenuPage() {
  await requireOperator();

  const allCategories = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.id));
  const allItems = await db
    .select()
    .from(menuItems)
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.id));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Menu</h1>
        <Link
          href="/admin/menu/items/new"
          className={buttonVariants({ variant: "default", size: "default" })}
        >
          <Plus aria-hidden="true" />
          New item
        </Link>
      </div>

      {/* New category */}
      <Card className="mt-6 gap-0! py-0!">
        <details>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            + New category
          </summary>
          <form
            action={createCategory}
            className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-end"
          >
            <Field className="flex-1">
              <FieldLabel htmlFor="new-cat-name">Name</FieldLabel>
              <Input
                id="new-cat-name"
                name="name"
                type="text"
                required
                maxLength={120}
              />
            </Field>
            <Field className="flex-1">
              <FieldLabel htmlFor="new-cat-description">
                Description{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </FieldLabel>
              <Input
                id="new-cat-description"
                name="description"
                type="text"
                maxLength={500}
              />
            </Field>
            <Field className="sm:w-44">
              <FieldLabel htmlFor="new-cat-station">Kitchen station</FieldLabel>
              <StationSelect id="new-cat-station" defaultValue="kitchen" />
            </Field>
            <Button type="submit" className="shrink-0">
              Add category
            </Button>
          </form>
        </details>
      </Card>

      {allCategories.length === 0 ? (
        <Empty className="mt-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UtensilsCrossed />
            </EmptyMedia>
            <EmptyTitle>No categories yet</EmptyTitle>
            <EmptyDescription>
              Create a category above, then add items to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <div className="mt-6 space-y-6">
        {allCategories.map((category, catIndex) => {
          const items = allItems.filter((i) => i.categoryId === category.id);
          return (
            <Card key={category.id} className="gap-0! py-0!">
              {/* Category header */}
              <CardHeader className="border-b pt-3 pb-3!">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{category.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {STATION_LABEL[category.station]}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {items.length} {items.length === 1 ? "item" : "items"}
                  </span>
                  {!category.isActive ? (
                    <Badge variant="secondary" className="text-muted-foreground!">
                      Hidden from store
                    </Badge>
                  ) : null}
                </CardTitle>
                <CardAction className="flex flex-wrap items-center gap-1.5">
                  <ReorderButtons
                    action={moveCategory}
                    idName="categoryId"
                    id={category.id}
                    isFirst={catIndex === 0}
                    isLast={catIndex === allCategories.length - 1}
                  />
                  <form action={toggleCategoryActive}>
                    <input
                      type="hidden"
                      name="categoryId"
                      value={category.id}
                    />
                    <Button type="submit" variant="outline" size="sm">
                      {category.isActive ? "Hide" : "Show"}
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
                      <form action={updateCategory}>
                        <input
                          type="hidden"
                          name="categoryId"
                          value={category.id}
                        />
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor={`cat-name-${category.id}`}>
                              Name
                            </FieldLabel>
                            <Input
                              id={`cat-name-${category.id}`}
                              name="name"
                              type="text"
                              required
                              maxLength={120}
                              defaultValue={category.name}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`cat-desc-${category.id}`}>
                              Description
                            </FieldLabel>
                            <Input
                              id={`cat-desc-${category.id}`}
                              name="description"
                              type="text"
                              maxLength={500}
                              defaultValue={category.description ?? ""}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`cat-station-${category.id}`}>
                              Kitchen station
                            </FieldLabel>
                            <StationSelect
                              id={`cat-station-${category.id}`}
                              defaultValue={category.station}
                            />
                          </Field>
                          <Button type="submit" className="w-full">
                            Save
                          </Button>
                        </FieldGroup>
                      </form>
                    </div>
                  </details>
                  <form action={deleteCategory}>
                    <input
                      type="hidden"
                      name="categoryId"
                      value={category.id}
                    />
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete category + items?"
                    />
                  </form>
                </CardAction>
              </CardHeader>
              {category.description ? (
                <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  {category.description}
                </p>
              ) : null}

              {/* Items */}
              {items.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">
                  No items in this category yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item, itemIndex) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {item.name}
                          </span>
                          {item.isFeatured ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground!"
                            >
                              Featured
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <span className="text-sm tabular-nums">
                        {formatCents(item.basePriceCents)}
                      </span>
                      <form action={toggleItemAvailability}>
                        <input type="hidden" name="itemId" value={item.id} />
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                          className={
                            item.isAvailable
                              ? "border-success/40! text-success!"
                              : "border-destructive/40! text-destructive!"
                          }
                        >
                          {item.isAvailable
                            ? "Available"
                            : "86’d — unavailable"}
                        </Button>
                      </form>
                      <ReorderButtons
                        action={moveItem}
                        idName="itemId"
                        id={item.id}
                        isFirst={itemIndex === 0}
                        isLast={itemIndex === items.length - 1}
                      />
                      <Link
                        href={`/admin/menu/items/${item.id}`}
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        Edit
                      </Link>
                      <form action={deleteItem}>
                        <input type="hidden" name="itemId" value={item.id} />
                        <ConfirmButton
                          label="Delete"
                          confirmLabel="Really delete?"
                        />
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function StationSelect({
  id,
  defaultValue,
}: {
  id: string;
  defaultValue: KitchenStation;
}) {
  return (
    <NativeSelect id={id} name="station" defaultValue={defaultValue} className="w-full">
      {KITCHEN_STATIONS.map((s) => (
        <NativeSelectOption key={s} value={s}>
          {STATION_LABEL[s]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
