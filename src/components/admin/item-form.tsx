import Link from "next/link";
import { saveItem } from "@/app/admin/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { centsToDollars } from "@/lib/money";
import { ruleSummary } from "./ui";

export type ItemFormItem = {
  id: number;
  name: string;
  description: string | null;
  basePriceCents: number;
  categoryId: number;
  isAvailable: boolean;
  isFeatured: boolean;
  isAlcoholic: boolean;
};

export type ItemFormCategory = { id: number; name: string };

export const OPTION_STATES = { offered: "Offered", hidden: "Not offered", soldOut: "Sold out" } as const;
export type OptionState = keyof typeof OPTION_STATES;

/** An attached group's options and how this item offers each. */
export type ItemFormOptions = {
  groupId: number;
  groupName: string;
  modifiers: { id: number; name: string; state: OptionState }[];
};

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
  options = [],
}: {
  item?: ItemFormItem;
  allCategories: ItemFormCategory[];
  allGroups: ItemFormGroup[];
  selectedGroupIds: number[];
  options?: ItemFormOptions[];
}) {
  const selected = new Set(selectedGroupIds);

  return (
    <form action={saveItem} className="max-w-xl">
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="item-name">Name</FieldLabel>
          <Input
            id="item-name"
            name="name"
            type="text"
            required
            maxLength={200}
            defaultValue={item?.name ?? ""}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="item-description">
            Description{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </FieldLabel>
          <Textarea
            id="item-description"
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={item?.description ?? ""}
            className="resize-none"
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="item-price">Price ($)</FieldLabel>
            <Input
              id="item-price"
              name="price"
              type="number"
              step="0.01"
              min="0"
              required
              defaultValue={item ? centsToDollars(item.basePriceCents) : ""}
              className="tabular-nums"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="item-category">Category</FieldLabel>
            <NativeSelect
              id="item-category"
              name="categoryId"
              required
              defaultValue={item?.categoryId ?? allCategories[0]?.id ?? ""}
              className="w-full"
            >
              {allCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <div className="flex flex-wrap gap-6">
          <Field orientation="horizontal" className="w-auto">
            <Checkbox
              id="item-available"
              name="isAvailable"
              defaultChecked={item?.isAvailable ?? true}
            />
            <FieldLabel htmlFor="item-available" className="font-normal!">
              Available for ordering
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" className="w-auto">
            <Checkbox
              id="item-featured"
              name="isFeatured"
              defaultChecked={item?.isFeatured ?? false}
            />
            <FieldLabel htmlFor="item-featured" className="font-normal!">
              Featured (“Popular” badge)
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" className="w-auto">
            <Checkbox
              id="item-alcoholic"
              name="isAlcoholic"
              defaultChecked={item?.isAlcoholic ?? false}
            />
            <FieldLabel htmlFor="item-alcoholic" className="font-normal!">
              Contains alcohol (21+)
            </FieldLabel>
          </Field>
        </div>

        <FieldSet>
          <FieldLegend variant="label">Modifier groups</FieldLegend>
          <FieldDescription>
            Options customers pick when ordering this item.
          </FieldDescription>
          {allGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No modifier groups yet — create them under Modifiers.
            </p>
          ) : (
            <div className="space-y-1.5">
              {allGroups.map((group) => (
                <FieldLabel
                  key={group.id}
                  htmlFor={`group-${group.id}`}
                  className="w-full cursor-pointer rounded-lg border border-border px-3.5 py-2.5 font-normal! transition-colors hover:bg-muted"
                >
                  <span className="flex flex-1 items-center gap-3">
                    <Checkbox
                      id={`group-${group.id}`}
                      name="groupIds"
                      value={String(group.id)}
                      defaultChecked={selected.has(group.id)}
                    />
                    <span className="text-sm">{group.name}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ruleSummary(group.minSelect, group.maxSelect)} ·{" "}
                    {group.modifierCount}{" "}
                    {group.modifierCount === 1 ? "option" : "options"}
                  </span>
                </FieldLabel>
              ))}
            </div>
          )}
        </FieldSet>

        {options.length > 0 ? (
          <FieldSet>
            <FieldLegend variant="label">Options on this item</FieldLegend>
            <FieldDescription>
              Hide an option this item doesn&apos;t come in, or sell it out
              here only. Other items sharing the group keep it.
            </FieldDescription>
            <div className="space-y-2">
              {options.map((group) => (
                <details key={group.groupId} open={group.modifiers.some((m) => m.state !== "offered")}>
                  <summary className="cursor-pointer text-sm">{group.groupName}</summary>
                  <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
                    {group.modifiers.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-3 px-3.5 py-2">
                        <label htmlFor={`option-${m.id}`} className="text-sm">
                          {m.name}
                        </label>
                        <NativeSelect
                          id={`option-${m.id}`}
                          name={`option-${m.id}`}
                          size="sm"
                          defaultValue={m.state}
                        >
                          {Object.entries(OPTION_STATES).map(([value, label]) => (
                            <NativeSelectOption key={value} value={value}>
                              {label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </FieldSet>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit">{item ? "Save changes" : "Create item"}</Button>
          <Link
            href="/admin/menu"
            className={buttonVariants({ variant: "outline" })}
          >
            Cancel
          </Link>
        </div>
      </FieldGroup>
    </form>
  );
}
