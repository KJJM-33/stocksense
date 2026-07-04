import { supabase } from "./client";
import type { Location, TapStatus } from "../constants";

export async function recordTap(params: {
  itemName: string;
  status: TapStatus;
  location?: Location;
}) {
  const householdId = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID;
  if (!householdId) {
    throw new Error("NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID is not set");
  }

  const { error } = await supabase.rpc("record_tap", {
    p_household_id: householdId,
    p_item_name: params.itemName,
    p_location: params.location ?? null,
    p_status: params.status,
  });

  if (error) throw error;
}
