import Medusa from "@medusajs/js-sdk";

/**
 * Shared JS SDK client for the admin Settings page. `sdk.client.fetch`
 * carries the admin session cookie automatically, so our custom
 * `/admin/fx-pricing/*` routes authenticate the same way any built-in
 * `sdk.admin.*` call does.
 */
export const sdk = new Medusa({
  auth: { type: "session" },
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
});
