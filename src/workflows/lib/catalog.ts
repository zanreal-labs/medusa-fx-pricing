import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { RawPrice } from "./variant-prices";

const PAGE_SIZE = 200;

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
      rules_count: typeof price.rules_count === "number" ? price.rules_count : 0,
    }));
}

/**
 * Every product variant in the store, with its full price list.
 *
 * A full-catalog scan, same as the sibling `medusa-allegro` plugin's own
 * hourly pass (`listEligibleVariants`) - acceptable for a job that runs once
 * a day. `query.graph` on `product_variant` resolves `prices.*` through
 * Medusa's built-in Product<->Pricing link, the same link the admin product
 * edit page's price grid reads.
 */
export async function listCatalogVariants(container: MedusaContainer): Promise<CatalogVariant[]> {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const variants: CatalogVariant[] = [];

  for (let page = 0; ; page += 1) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id", "product_id", "prices.id", "prices.amount", "prices.currency_code", "prices.rules_count"],
      pagination: { skip: page * PAGE_SIZE, take: PAGE_SIZE },
    });

    for (const row of data) {
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

    if (data.length < PAGE_SIZE) {
      break;
    }
  }

  return variants;
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
      fields: ["id", "prices.id", "prices.amount", "prices.currency_code", "prices.rules_count"],
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
