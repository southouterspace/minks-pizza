/**
 * Bounds for the POS settings, in the units the settings form shows. The
 * form's inputs and saveSettings's schema both read these.
 */
export const POS_SETTING_LIMITS = {
  extraToppingMultiplier: { min: 1, max: 5, step: 0.25 },
  discountApprovalDollars: { min: 0, max: 1000, step: 0.01 },
  posLockSeconds: { min: 15, max: 3600, step: 1 },
  ovenCapacityPies: { min: 1, max: 50, step: 1 },
  makeMinutes: { min: 0, max: 60, step: 1 },
} as const;
