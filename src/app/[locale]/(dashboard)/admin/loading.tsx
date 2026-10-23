import { AdminFrame } from "./_components/admin-frame";
import { AdminSessionFieldsFallback } from "./_components/admin-session-fields";

/**
 * Renders the same frame as the prerendered shell and the same fallback as the
 * page's own boundary, so a soft navigation into `/admin` and a fresh request
 * for it show the same thing.
 */
export default function AdminLoading() {
  return <AdminFrame fields={<AdminSessionFieldsFallback />} />;
}
