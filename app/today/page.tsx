import { redirect } from "next/navigation";

/** /today moved to /style; keep old links working. */
export default function TodayRedirect() {
  redirect("/style");
}
