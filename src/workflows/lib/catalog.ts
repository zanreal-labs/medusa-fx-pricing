import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { RawPrice } from "./variant-prices";

const PAGE_SIZE = 200;

/**
 * The variant + price columns every read in this file selects, named once so
 * the catalog scan and the post-write re-read cannot drift apart.
 *
 * `min_quantity`/`max_quantity` are load-bearing, not decoration: Medusa stores
 * a quantity ladder as columns on `price` rather than as `price_rules`, so
 * without them a tiered row is indistinguishable from a base price and
 * `isDefaultPrice` would wave one through - see `variant-prices.ts`.
 */
const VARIANT_PRICE_FIELDS = [
  "id",
  "product_id",
  "prices.id",
  "prices.amount",
  "prices.currency_code",
  "prices.rules_count",
  "prices.min_quantity",
  "prices.max_quantity",
];

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: { skip: number; take: number };
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

export interface CatalogVariant {
  id: string;
  productId: string;
  prices: RawPrice[];
}

function toPrices(raw: unknown): RawPrice[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as Record<string, unknown>[])
    .filter((price) => typeof price.currency_code === "string" && typeof price.id === "string")
    .map((price) => ({
      amount: Number(price.amount),
      currency_code: price.currency_code as string,
      id: price.id as string,
      max_quantity: typeof price.max_quantity === "number" ? price.max_quantity : null,
      min_quantity: typeof price.min_quantity === "number" ? price.min_quantity : null,
      rules_count: typeof price.rules_count === "number" ? price.rules_count : 0,
    }));
}

/**
 * One page of `product_variant` rows, as `CatalogVariant`s. A row with no
 * `product_id` is dropped rather than defaulted: the planner keys its writes by
 * product as well as variant, and a variant that cannot say which product it
 * belongs to is not something to guess about.
 */
function toCatalogVariants(rows: readonly Record<string, unknown>[]): CatalogVariant[] {
  const variants: CatalogVariant[] = [];
  for (const row of rows) {
    const productId = row.product_id as string | null;
    if (!productId) {
      continue;
    }
    variants.push({
      id: row.id as string,
      prices: toPrices(row.prices),
      productId,
    });
  }
  return variants;
}

/**
 * Every product variant in the store, with its full price list.
 *
 * A full-catalog scan, same as the sibling `medusa-allegro` plugin's own
 * hourly pass (`listEligibleVariants`) - acceptable for the daily backstop
 * job. `query.graph` on `product_variant` resolves `prices.*` through
 * Medusa's built-in Product<->Pricing link, the same link the admin product
 * edit page's price grid reads.
 */
export async function listCatalogVariants(container: MedusaContainer): Promise<CatalogVariant[]> {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const variants: CatalogVariant[] = [];

  for (let page = 0; ; page += 1) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: VARIANT_PRICE_FIELDS,
      pagination: { skip: page * PAGE_SIZE, take: PAGE_SIZE },
    });

    variants.push(...toCatalogVariants(data));

    if (data.length < PAGE_SIZE) {
      break;
    }
  }

  return variants;
}

/**
 * The same read as `listCatalogVariants`, narrowed to specific variant ids -
 * what the event-driven recompute passes through, so one product save costs a
 * filtered query instead of a scan of the whole catalog.
 *
 * An id that no longer resolves (a variant deleted between the event being
 * emitted and this read) is simply absent from the result rather than an
 * error. An event says what changed; it does not promise the row is still
 * there when the handler gets to it.
 */
export async function listCatalogVariantsByIds(
  container: MedusaContainer,
  variantIds: readonly string[],
): Promise<CatalogVariant[]> {
  const variants: CatalogVariant[] = [];
  if (variantIds.length === 0) {
    return variants;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);

  for (let offset = 0; offset < variantIds.length; offset += PAGE_SIZE) {
    const chunk = variantIds.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "product_variant",
      fields: VARIANT_PRICE_FIELDS,
      filters: { id: chunk },
    });
    variants.push(...toCatalogVariants(data));
  }

  return variants;
}

/**
 * Every variant id belonging to the given products.
 *
 * Needed because `product.created` and `product.updated` name a PRODUCT, and
 * that is all they name. `createProductsWorkflow` emits `product.created` and
 * no per-variant event at all, and `updateProductsWorkflow` writes variant
 * prices (it runs `upsertVariantPricesWorkflow` as a step) while emitting only
 * `product.updated` - so without expanding the product id here, a product
 * created with its prices, and a `PUT /admin/products/:id` that changes them,
 * would both go unnoticed until the next daily run.
 */
export async function listVariantIdsByProductIds(
  container: MedusaContainer,
  productIds: readonly string[],
): Promise<string[]> {
  const variantIds = new Set<string>();
  if (productIds.length === 0) {
    return [];
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);

  for (let offset = 0; offset < productIds.length; offset += PAGE_SIZE) {
    const chunk = productIds.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id"],
      filters: { product_id: chunk },
    });
    for (const row of data) {
      const id = row.id as string | null;
      if (id) {
        variantIds.add(id);
      }
    }
  }

  return [...variantIds];
}

/**
 * The variants behind a set of `price` ids, keeping only the prices that are in
 * `currencyCode`.
 *
 * The currency filter is this plugin's recursion guard and the whole reason
 * this read exists. `pricing.price.created` / `pricing.price.updated` fire for
 * every price row the pricing module writes - including the USD and EUR rows
 * this plugin writes itself, through `addPrices`/`updatePrices`, both of which
 * are `@EmitEvents()`-decorated. A subscriber acting on those unfiltered would
 * re-enter the recompute it had just finished. Narrowing to the native PLN
 * price means the only price events that reach a recompute are changes to the
 * SOURCE it derives from; its own output is dropped one query in, before
 * anything is planned or written.
 *
 * A price is joined to its variant the same way `fetchPriceSetIdsByVariantIds`
 * joins them, through `product_variant_price_set` - just read in the other
 * direction.
 */
export async function listVariantIdsByPriceIds(
  container: MedusaContainer,
  priceIds: readonly string[],
  currencyCode: string,
): Promise<string[]> {
  if (priceIds.length === 0) {
    return [];
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const normalized = currencyCode.trim().toLowerCase();
  const priceSetIds = new Set<string>();

  for (let offset = 0; offset < priceIds.length; offset += PAGE_SIZE) {
    const chunk = priceIds.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "price",
      fields: ["id", "currency_code", "price_set_id"],
      filters: { id: chunk },
    });
    for (const row of data) {
      const rowCurrency = typeof row.currency_code === "string" ? row.currency_code : "";
      const priceSetId = row.price_set_id as string | null;
      if (priceSetId && rowCurrency.trim().toLowerCase() === normalized) {
        priceSetIds.add(priceSetId);
      }
    }
  }

  if (priceSetIds.size === 0) {
    return [];
  }

  const priceSetIdList = [...priceSetIds];
  const variantIds = new Set<string>();

  for (let offset = 0; offset < priceSetIdList.length; offset += PAGE_SIZE) {
    const chunk = priceSetIdList.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "product_variant_price_set",
      fields: ["variant_id", "price_set_id"],
      filters: { price_set_id: chunk },
    });
    for (const row of data) {
      const variantId = row.variant_id as string | null;
      if (variantId) {
        variantIds.add(variantId);
      }
    }
  }

  return [...variantIds];
}

/**
 * Re-read a specific set of variants' prices after a write, to learn the
 * authoritative price id/amount `upsertVariantPricesWorkflow` just produced
 * (its own return shape is not relied on - see
 * `src/workflows/recompute-fx-prices.ts`). Also used to build `VariantForPlanning`
 * for a single currency pass without re-fetching the whole catalog.
 */
export async function fetchVariantPricesByIds(
  container: MedusaContainer,
  variantIds: readonly string[],
): Promise<Map<string, RawPrice[]>> {
  const result = new Map<string, RawPrice[]>();
  if (variantIds.length === 0) {
    return result;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);

  for (let offset = 0; offset < variantIds.length; offset += PAGE_SIZE) {
    const chunk = variantIds.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "product_variant",
      fields: VARIANT_PRICE_FIELDS,
      filters: { id: chunk },
    });
    for (const row of data) {
      result.set(row.id as string, toPrices(row.prices));
    }
  }

  return result;
}

interface StoreQueryRow {
  id: string;
  supported_currencies?: { currency_code?: string }[] | null;
}

/**
 * The store's enabled currency codes, lower-cased. This is what the spec's
 * "store currencies USD/EUR may not be enabled yet" requirement is checked
 * against - a currency this plugin would otherwise price is skipped for the
 * whole run (not per-variant) when it is not in this set. Returns an empty
 * set (never throws) if the store cannot be read, so a transient read
 * failure here degrades to "skip every currency this run" rather than
 * crashing the job.
 */
export async function fetchStoreSupportedCurrencyCodes(
  container: MedusaContainer,
): Promise<Set<string>> {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "store",
    fields: ["id", "supported_currencies.currency_code"],
  });
  const store = data[0] as unknown as StoreQueryRow | undefined;
  const codes = (store?.supported_currencies ?? [])
    .map((currency) => currency.currency_code)
    .filter((code): code is string => typeof code === "string");
  return new Set(codes.map((code) => code.trim().toLowerCase()));
}

/**
 * The `PriceSet` linked to each of the given variants, keyed by variant id.
 *
 * Every variant that already has any price has exactly one price set, joined to
 * it through the `product_variant_price_set` link table - and the link module
 * enforces that "exactly one" (neither side of that link is declared
 * `hasMany`), which is why writing a price means adding it to the EXISTING
 * price set rather than creating a second one. Queried here the same way core's
 * own `upsertVariantPricesWorkflow` queries it, and the same way the sibling
 * `srp-store-price` script in `zanreal-labs/medusa` does.
 *
 * A variant with no row here has never been priced in any currency. It has no
 * price set to add to, so this plugin cannot create its first price on its own
 * - see `runFxPricingRecompute`, which reports those under
 * `skippedNoPlnPrice` (a variant with no price set has no PLN price either).
 */
export async function fetchPriceSetIdsByVariantIds(
  container: MedusaContainer,
  variantIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (variantIds.length === 0) {
    return result;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);

  for (let offset = 0; offset < variantIds.length; offset += PAGE_SIZE) {
    const chunk = variantIds.slice(offset, offset + PAGE_SIZE);
    const { data } = await query.graph({
      entity: "product_variant_price_set",
      fields: ["variant_id", "price_set_id"],
      filters: { variant_id: chunk },
    });
    for (const row of data) {
      const variantId = row.variant_id as string | null;
      const priceSetId = row.price_set_id as string | null;
      if (variantId && priceSetId) {
        result.set(variantId, priceSetId);
      }
    }
  }

  return result;
}
