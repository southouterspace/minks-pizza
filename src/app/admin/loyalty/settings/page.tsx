import { requireOperator } from "@/lib/auth";
import { getLoyaltySettings } from "@/lib/loyalty-server";
import { ProgramSettingsForm } from "@/components/admin/program-settings-form";

export const dynamic = "force-dynamic";

export default async function LoyaltySettingsPage() {
  await requireOperator();
  return <ProgramSettingsForm settings={await getLoyaltySettings()} />;
}
