export const LOCATIONS = ["fridge", "freezer", "cupboard"] as const;
export type Location = (typeof LOCATIONS)[number];

export function isLocation(value: string): value is Location {
  return (LOCATIONS as readonly string[]).includes(value);
}

// Phase 1 default list — becomes per-household in Phase 2.
export const COMMON_ITEMS = [
  "Milk",
  "Eggs",
  "Bread",
  "Butter",
  "Cheese",
  "Chicken",
  "Rice",
  "Toilet roll",
] as const;

export const TAP_STATUSES = [
  { value: "low", label: "Low" },
  { value: "out", label: "Out" },
  { value: "used_some", label: "Used some" },
] as const;

export type TapStatus = (typeof TAP_STATUSES)[number]["value"];
