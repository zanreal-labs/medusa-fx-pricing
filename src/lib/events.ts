/**
 * Which store events can mean a variant's PLN price moved, and how to read the
 * ids out of one.
 *
 * Pure and container-free, for the same reason `decidePriceAction` and
 * `planCurrencyRecompute` are: deciding "is this event about a price this
 * plugin derives from" is the part that has to be right, and it is wrong in two
 * expensive directions. A false negative leaves a foreign-currency price stale
 * until 03:00 - the exact gap the subscriber exists to close. A false positive
 * on this plugin's OWN writes is an event loop.
 */

/**
 * The events this plugin subscribes to, and why each one is here.
 *
 * Read off the Medusa 2.18.0 packages this plugin pins, not guessed at - the
 * names are not greppable as string literals in most of the places they are
 * produced, so each is traced to where it is actually built:
 *
 * - `product.created` / `product.updated` - `ProductWorkflowEvents.CREATED` /
 *   `.UPDATED` in `@medusajs/utils/dist/core-flows/events.js`, emitted through
 *   `emitEventStep` by `createProductsWorkflow` and `updateProductsWorkflow`.
 *   Both are load-bearing and neither is redundant: `createProductsWorkflow`
 *   creates a product's variants and prices in one go and emits NO variant
 *   event, and `updateProductsWorkflow` runs `upsertVariantPricesWorkflow` as a
 *   step - it writes variant prices - while also emitting only the product
 *   event. A `PUT /admin/products/:id` carrying new prices is invisible without
 *   this line.
 * - `product-variant.created` / `product-variant.updated` -
 *   `ProductVariantWorkflowEvents` in the same file, emitted by
 *   `createProductVariantsWorkflow` and `updateProductVariantsWorkflow`. The
 *   second is what the admin's variant editor and the
 *   `POST /admin/products/:id/variants/batch` bulk price edit both end at
 *   (`batchProductVariantsWorkflow` runs them as steps).
 * - `pricing.price.created` / `pricing.price.updated` - NOT a string constant
 *   anywhere. `MedusaService`'s `interceptEntityMutationEvents`
 *   (`@medusajs/utils/dist/modules-sdk/medusa-service.js`) builds them at
 *   runtime from the ORM's `afterCreate`/`afterUpdate` on the `Price` model plus
 *   the pricing module's `serviceName`, which is why grepping for
 *   `"price.updated"` finds nothing and suggests - wrongly - that price events
 *   do not exist. They are here for the path no product event covers at all:
 *   `pricing.addPrices` / `pricing.updatePrices` / `pricing.updatePriceSets`
 *   called directly by a script or another plugin.
 *
 * Two names are deliberately absent.
 *
 * `pricing.price.deleted` carries the id of a row that no longer exists, so its
 * currency cannot be read - and the currency is this plugin's entire recursion
 * guard (see `listVariantIdsByPriceIds`). Acting on an unreadable price id would
 * mean either repricing on every price deletion in the catalogue or guessing.
 * What that leaves uncovered is the reclaim path - deleting a manually
 * overridden USD price to hand it back to this plugin - which the daily job
 * picks up, and which is not time-critical the way a wrong price is.
 *
 * `product-variant.deleted` / `product.deleted` name rows that are gone. There
 * is nothing to reprice.
 */
export const FX_PRICING_TRIGGER_EVENTS = [
  "product.created",
  "product.updated",
  "product-variant.created",
  "product-variant.updated",
  "pricing.price.created",
  "pricing.price.updated",
] as const;

export type FxPricingTriggerEvent = (typeof FX_PRICING_TRIGGER_EVENTS)[number];

/** What the ids carried by a parsed event identify. */
export type FxPricingEventSubject = "product" | "variant" | "price";

export interface ParsedFxPricingEvent {
  subject: FxPricingEventSubject;
  /** The ids named by the event, de-duplicated, in the order they appeared. */
  ids: string[];
}

/**
 * Every id shape this plugin can be handed for one event.
 *
 * There are three, and all three are real. `emitEventStep` fans an array out
 * into one message per entry, each carrying `{ id }`. `moduleEventBuilderFactory`
 * - the one behind `pricing.price.*` - collapses a multi-row mutation into a
 * SINGLE message whose `data.id` is an ARRAY. And `Event<TData>`'s own
 * documentation offers `{ ids: [...] }` as a third. Anything without a usable id
 * yields nothing rather than a guess: an unidentifiable event acted on would
 * mean repricing on every unrelated product save in the store.
 */
function readIds(data: unknown): string[] {
  const rows = Array.isArray(data) ? data : [data];
  const ids = new Set<string>();

  for (const row of rows) {
    const record = row as { id?: unknown; ids?: unknown } | null | undefined;
    for (const candidate of [record?.id, record?.ids]) {
      for (const value of Array.isArray(candidate) ? candidate : [candidate]) {
        if (typeof value === "string" && value.trim() !== "") {
          ids.add(value);
        }
      }
    }
  }

  return [...ids];
}

/**
 * Read an event off the bus into "these ids, of this kind" - or `null` for an
 * event this plugin has no business reacting to.
 *
 * Matched on the exact names in `FX_PRICING_TRIGGER_EVENTS` rather than on a
 * prefix. A prefix test would quietly widen the subscription every time Medusa
 * adds an entity under `pricing.` or `product-`, and the recursion guard depends
 * on knowing precisely which events can reach it.
 */
export function parseFxPricingEvent(name: string, data: unknown): ParsedFxPricingEvent | null {
  if (!(FX_PRICING_TRIGGER_EVENTS as readonly string[]).includes(name)) {
    return null;
  }

  const subject: FxPricingEventSubject = name.startsWith("pricing.price.")
    ? "price"
    : name.startsWith("product-variant.")
      ? "variant"
      : "product";

  const ids = readIds(data);
  return ids.length === 0 ? null : { ids, subject };
}
