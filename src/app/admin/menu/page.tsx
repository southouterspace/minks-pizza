import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { categories, db, menuItems } from "@/db";
import { requireOperator } from "@/lib/auth";
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
import {
  inputClass,
  labelClass,
  primaryButtonClass,
  smallButtonClass,
  summaryButtonClass,
} from "@/components/admin/ui";

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
        <button
          type="submit"
          disabled={isFirst}
          aria-label="Move up"
          className={`${smallButtonClass} w-7 justify-center px-0 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          ↑
        </button>
      </form>
      <form action={action}>
        <input type="hidden" name={idName} value={id} />
        <input type="hidden" name="direction" value="down" />
        <button
          type="submit"
          disabled={isLast}
          aria-label="Move down"
          className={`${smallButtonClass} w-7 justify-center px-0 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          ↓
        </button>
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
        <Link href="/admin/menu/items/new" className={primaryButtonClass}>
          New item
        </Link>
      </div>

      {/* New category */}
      <details className="mt-6 rounded-lg border border-border">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          + New category
        </summary>
        <form
          action={createCategory}
          className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-end"
        >
          <div className="flex-1">
            <label htmlFor="new-cat-name" className={labelClass}>
              Name
            </label>
            <input
              id="new-cat-name"
              name="name"
              type="text"
              required
              maxLength={120}
              className={inputClass}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="new-cat-description" className={labelClass}>
              Description{" "}
              <span className="font-normal text-faint">(optional)</span>
            </label>
            <input
              id="new-cat-description"
              name="description"
              type="text"
              maxLength={500}
              className={inputClass}
            />
          </div>
          <button type="submit" className={primaryButtonClass}>
            Add category
          </button>
        </form>
      </details>

      {allCategories.length === 0 ? (
        <div className="mt-6 rounded-lg border border-border px-6 py-14 text-center">
          <p className="text-sm font-medium">No categories yet</p>
          <p className="mt-1 text-sm text-muted">
            Create a category above, then add items to it.
          </p>
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        {allCategories.map((category, catIndex) => {
          const items = allItems.filter((i) => i.categoryId === category.id);
          return (
            <section
              key={category.id}
              className="rounded-lg border border-border"
            >
              {/* Category header */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">{category.name}</h2>
                <span className="text-xs text-faint">
                  {items.length} {items.length === 1 ? "item" : "items"}
                </span>
                {!category.isActive ? (
                  <span className="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                    Hidden from store
                  </span>
                ) : null}
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
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
                    <button type="submit" className={smallButtonClass}>
                      {category.isActive ? "Hide" : "Show"}
                    </button>
                  </form>
                  <details className="relative">
                    <summary className={summaryButtonClass}>Edit</summary>
                    <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-border bg-background p-4 shadow-sm">
                      <form action={updateCategory} className="space-y-3">
                        <input
                          type="hidden"
                          name="categoryId"
                          value={category.id}
                        />
                        <div>
                          <label
                            htmlFor={`cat-name-${category.id}`}
                            className={labelClass}
                          >
                            Name
                          </label>
                          <input
                            id={`cat-name-${category.id}`}
                            name="name"
                            type="text"
                            required
                            maxLength={120}
                            defaultValue={category.name}
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`cat-desc-${category.id}`}
                            className={labelClass}
                          >
                            Description
                          </label>
                          <input
                            id={`cat-desc-${category.id}`}
                            name="description"
                            type="text"
                            maxLength={500}
                            defaultValue={category.description ?? ""}
                            className={inputClass}
                          />
                        </div>
                        <button
                          type="submit"
                          className={`${primaryButtonClass} w-full`}
                        >
                          Save
                        </button>
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
                      className={smallButtonClass}
                      confirmClassName="inline-flex h-7 items-center rounded-md border border-error px-2.5 text-xs font-medium text-error transition-opacity hover:opacity-85"
                    />
                  </form>
                </div>
              </div>
              {category.description ? (
                <p className="border-b border-border px-4 py-2 text-xs text-muted">
                  {category.description}
                </p>
              ) : null}

              {/* Items */}
              {items.length === 0 ? (
                <p className="px-4 py-4 text-sm text-faint">
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
                            <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
                              Featured
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="text-sm tabular-nums">
                        {formatCents(item.basePriceCents)}
                      </span>
                      <form action={toggleItemAvailability}>
                        <input type="hidden" name="itemId" value={item.id} />
                        <button
                          type="submit"
                          className={`inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-opacity hover:opacity-80 ${
                            item.isAvailable
                              ? "border-success/40 text-success"
                              : "border-error/40 text-error"
                          }`}
                        >
                          {item.isAvailable
                            ? "Available"
                            : "86’d — unavailable"}
                        </button>
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
                        className={smallButtonClass}
                      >
                        Edit
                      </Link>
                      <form action={deleteItem}>
                        <input type="hidden" name="itemId" value={item.id} />
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
