import { toast as sonnerToast } from "sonner";
import type { ExternalToast } from "sonner";
import type { ActionResult } from "@/lib/actions";

export { sonnerToast as toast };
export type { ExternalToast };

export function toastActionError(result: ActionResult): void {
  if (result.success) return;
  if (result.fieldErrors) return;
  sonnerToast.error(result.error);
}
