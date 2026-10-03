/** POS permissions: who may unlock the terminal and who may approve there. Not a job. */
export const POS_ACCESS_LEVELS = ["none", "cashier", "manager"] as const;
export type PosAccess = (typeof POS_ACCESS_LEVELS)[number];

export const POS_ACCESS_LABEL: Record<PosAccess, string> = {
  none: "No POS access",
  cashier: "Cashier",
  manager: "Manager",
};

export type RequiredRole = "cashier" | "manager";

export function roleSatisfies(access: PosAccess, required: RequiredRole): boolean {
  return access === "manager" || (required === "cashier" && access === "cashier");
}
