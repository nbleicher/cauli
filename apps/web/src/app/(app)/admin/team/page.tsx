import { redirect } from "next/navigation";

export default function LegacyTeamAdminPage() {
  redirect("/admin/workspace");
}
