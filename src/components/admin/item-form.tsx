import Link from "next/link";
import { saveItem } from "@/app/admin/actions";
import {
  centsToDollars,
  inputClass,
  labelClass,
  primaryButtonClass,
  ruleSummary,
  secondaryButtonClass,
} from "./ui";

export type ItemFormItem = {
  id: number;
  name: string;
  description: string | null;
  basePriceCents: number;
  categoryId: number;
  isAvailable: boolean;
  isFeatured: boolean;
};

export type ItemFormCategory = { id: number; name: string };

export type ItemFormGroup = {
  id: number;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  modifierCount: number;
};

export function ItemForm({
  item,
  allCategories,
  allGroups,
  selectedGroupIds,
}: {
  item?: ItemFormItem;
  allCategories: ItemFormCategory[];
  allGroups: ItemFormGroup[];
  selectedGroupIds: number[];
}) {
  const selected = new Set(selectedGroupIds);

  return (
    <form action={saveItem} className="max-w-xl space-y-5">
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}

      <div>
        <label htmlFor="item-name" className={labelClass}>
          Name
        </label>
        <input
          id="item-name"
          name="name"
          type="text"
          required
          maxLength={200}
          defaultValue={item?.name ?? ""}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="item-description" className={labelClass}>
          Description <span className="font-normal text-faint">(optional)</span>
        </label>
        <textarea
          id="item-description"
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={item?.description ?? ""}
          className={`${inputClass} resize-none`}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="item-price" className={labelClass}>
            Price ($)
          </label>
          <input
            id="item-price"
            name="price"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={item ? centsToDollars(item.basePriceCents) : ""}
            className={`${inputClass} tabular-nums`}
          />
        </div>
        <div>
          <label htmlFor="item-category" className={labelClass}>
            Category
          </label>
          <select
            id="item-category"
            name="categoryId"
            required
            defaultValue={item?.categoryId ?? allCategories[0]?.id ?? ""}
            className={inputClass}
          >
            {allCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isAvailable"
            defaultChecked={item?.isAvailable ?? true}
            className="h-4 w-4 accent-black"
          />
          Available for ordering
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isFeatured"
            defaultChecked={item?.isFeatured ?? false}
            className="h-4 w-4 accent-black"
          />
          Featured (“Popular” badge)
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Modifier groups</legend>
        <p className="mt-1 text-xs text-muted">
          Options customers pick when ordering this item.
        </p>
        {allGroups.length === 0 ? (
          <p className="mt-3 text-sm text-faint">
            No modifier groups yet — create them under Modifiers.
          </p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {allGroups.map((group) => (
              <label
                key={group.id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3.5 py-2.5 text-sm transition-colors hover:border-foreground/30"
              >
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    name="groupIds"
                    value={group.id}
                    defaultChecked={selected.has(group.id)}
                    className="h-4 w-4 accent-black"
                  />
                  {group.name}
                </span>
                <span className="text-xs text-faint">
                  {ruleSummary(group.minSelect, group.maxSelect)} ·{" "}
                  {group.modifierCount}{" "}
                  {group.modifierCount === 1 ? "option" : "options"}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-3 border-t border-border pt-5">
        <button type="submit" className={primaryButtonClass}>
          {item ? "Save changes" : "Create item"}
        </button>
        <Link href="/admin/menu" className={secondaryButtonClass}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
