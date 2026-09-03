# @zanreal/medusa-fx-pricing

A [Medusa v2](https://medusajs.com) plugin that derives USD and EUR variant prices from a store's
native PLN selling price, using the NBP (Narodowy Bank Polski, the Polish central bank) table A
mid rate plus a configurable margin. Reprices within seconds of a PLN price changing, with a daily
job as the backstop; a manual price edit is never overwritten.

Full documentation, in English and Polish, is published at
<https://zanreal.com/docs/oss/medusa-fx-pricing> and authored in [`docs/`](./docs).

There is no FX-pricing plugin in the Medusa ecosystem today. A store that sells in PLN and wants
USD/EUR listed too either prices them by hand (and lets them drift out of date as the rate moves)
or wires up a bespoke script. This plugin is that script, packaged: a small, standalone module that
computes `foreign_amount = pln_amount / nbp_rate * margin_multiplier` for every variant with a PLN
price - as soon as that PLN price changes, and again every night as the rate moves - and gets out of
the way of anything a human has already priced by hand.

## What it does

- Fetches the latest published NBP table A mid rate for USD and EUR (`GET
  /api/exchangerates/rates/a/usd/` and `.../eur/` - no date suffix, so it always answers with the
  most recently published table, which is how weekends and Polish public holidays - days NBP does
  not publish a new table - are handled without any special-casing).
- Computes `foreign_amount = pln_amount / nbp_rate * margin_multiplier` for every product variant
  that has a default (no price-list, no price-rule) PLN price, and writes it as that variant's
  default USD/EUR price.
- Recomputes the affected variants **as soon as their PLN price changes**, via a subscriber on the
  product, variant and price events - so a new product, or a corrected price, has its USD/EUR
  prices within seconds rather than at 03:00 tomorrow. See "Reacting to a price change" below.
- Runs a **full pass once a day** as the backstop for everything an event cannot say (the rate
  moved, a price was written outside the workflows, an event was dropped), and on demand via a
  "Recompute now" admin action.
- **Never touches a price a human has set.** The moment a USD/EUR price is created or edited by
  anything other than this plugin, it is permanently left alone - see "How manual overrides stay
  sacred" below for the exact mechanism.
- **Leaves a quantity ladder alone.** A variant whose prices carry `min_quantity`/`max_quantity`
  bounds has no single default price to derive from or write to, so it is skipped and reported
  under its own counter - see "Quantity ladders" below.
- Skips a currency gracefully (logs why, does not crash) when it is not yet enabled in the store's
  `supported_currencies`, when the NBP rate cannot be fetched, or when the latest published rate is
  older than a configurable staleness tolerance.

It ships an admin **Settings > FX pricing** page: the enabled toggle, the editable margin
multiplier and staleness tolerance, the live NBP rates, the last run's summary, and the manual
recompute action. See "Admin UI" below.

## How manual overrides stay sacred

Medusa v2's `Price` (money amount) row has **no `metadata` column** - unlike `PriceList`, `Price`
itself carries no free-form JSON a plugin could stamp an ownership marker into. Its `price_rules`
exist to scope a price to a pricing **context** (a region, a customer group, a quantity break);
attaching a marker rule such as `{ fx_pricing_managed: "true" }` would make that price only match a
checkout context that happens to supply the same attribute, which would make the price invisible at
checkout instead of marking it. Neither mechanism can safely carry an ownership flag.

So this plugin tracks ownership itself, in its own table (`FxManagedPrice`, one row per
variant+currency this plugin has ever priced): the exact `price_id` and `amount` it last wrote.
That is an **optimistic-concurrency stamp**, not a flag stored on the price. On every run, for a
variant+currency this plugin might touch:

- **No price exists yet** in that currency -> create one, and record the stamp. This is also the
  **reclaim path**: deleting a price (manual or plugin-written) makes the plugin free to create a
  fresh one next run.
- **A price exists, but this plugin never recorded writing one for it** -> a human (or something
  else) set it, at any point, including before this plugin was installed. Skipped, permanently,
  until it is deleted.
- **A price exists, the plugin's stamp points at that exact price id, and the amount still matches
  what was stamped** -> still exactly what this plugin left it as. Safe to update again if the
  target has moved (a no-op if it has not).
- **A price exists, the plugin has a stamp for it, but the price id differs, or the id matches and
  the amount does not** -> someone edited it since the stamp was written (an in-place admin price
  edit changes the amount, not the id). Skipped, permanently, from that point on.

This decision is a pure function - see `decidePriceAction` in
`src/modules/fx-pricing/lib/decision.ts` - and is exhaustively unit tested in
`src/modules/fx-pricing/lib/__tests__/decision.test.ts`.

Only the variant's **default** price in a currency (no price-list, no price-rule scoping it - the
same one the admin product edit page's basic price grid shows) is ever read or written. A
region-specific, customer-group, or price-list price is a different, deliberately-configured price
this plugin has no business touching.

The stamp is written **after** the price, from a re-read of what the database actually holds, and
the run summary's `created`/`updated` only count a price once both halves have landed. A price
written whose stamp could not be recorded is counted as `stampFailed`, logged as a warning, and
surfaced in the admin - it is the one outcome that silently costs you a variant, because the next
run sees a price it has no record of writing and skips it forever. Deleting such a price hands it
back.

### Quantity ladders

Medusa stores a quantity break as `min_quantity`/`max_quantity` **columns on the price row**, not
as `price_rules` - so `rules_count` is `0` on every step of a ladder, and a `!rules_count` test on
its own would pick the first tier and treat it as the base price. The default-price test is
therefore `!rules_count && min_quantity == null && max_quantity == null`. A variant priced as a
ladder has no unbounded price to convert from or write to, so it is skipped and counted under
`skippedQuantityTiered` rather than being folded into `skippedManualOverride`: the reason and the
remedy are different, and "manual override" would send an operator looking for an edit nobody made.

## How a price is actually written

Two pricing-module primitives, and deliberately not `upsertVariantPricesWorkflow`:

- **`addPrices({ priceSetId, prices })`** appends one price to the variant's existing price set.
- **`updatePrices([{ id, amount }])`** moves one existing price row's amount by id.

Both are generated onto the pricing module service from its `Price` model, so they exist on the
instance without being declared on `IPricingModuleService`; the plugin asserts both are present at
the start of a run and refuses the run naming the problem if they are not, rather than discovering
it halfway through a currency.

Core's `upsertVariantPricesWorkflow` looks like the obvious call and is the wrong one in both of
its branches. It splits its input on `previousVariantIds`: a variant *not* in that list gets a
**brand-new `PriceSet`** created and linked to it - but neither side of the
`ProductVariantPriceSet` link is declared `hasMany`, so `RemoteLink.create` rejects the second link
for a variant that already has a price set with `Cannot create multiple links between
'productService' and 'pricingService'`. A variant *in* the list goes to `updatePriceSets`, which
**replaces** the price set's price list: it deletes every existing default price whose id is not in
the incoming array, so handing it one USD price would delete the variant's PLN price. The sibling
`srp-store-price` script in `zanreal-labs/medusa` reached the same two primitives for the same
reason; see `src/workflows/lib/price-writes.ts` for the full write-up.

## Reacting to a price change

`src/subscribers/fx-pricing-price-change-recompute.ts` recomputes the affected variants - and only
those - as soon as their PLN price moves. The daily job is the backstop, not the mechanism.

### The events, and why each one

Measured against the Medusa 2.18.0 packages this plugin pins, because the answer is not visible by
grepping for a string:

| Event | Where it comes from | Why it is needed |
| --- | --- | --- |
| `product.created` | `emitEventStep` in `createProductsWorkflow` | A product is created with its variants and prices in one call, and **no variant event is emitted at all**. Without this line, a new product has no USD/EUR price until the next daily run - the exact gap this subscriber exists to close. |
| `product.updated` | `emitEventStep` in `updateProductsWorkflow` | That workflow runs `upsertVariantPricesWorkflow` as a step - it *writes variant prices* - while emitting only the product event. A `PUT /admin/products/:id` carrying new prices is invisible without this line. |
| `product-variant.created` | `createProductVariantsWorkflow` | A variant added to an existing product. |
| `product-variant.updated` | `updateProductVariantsWorkflow` | The admin's variant editor and the `POST /admin/products/:id/variants/batch` bulk price edit both end here (`batchProductVariantsWorkflow` runs those workflows as steps). |
| `pricing.price.created` / `pricing.price.updated` | Not a constant anywhere: `MedusaService`'s `interceptEntityMutationEvents` builds the name at runtime from the ORM's `afterCreate`/`afterUpdate` on the `Price` model plus the pricing module's service name | The path no product event covers: `pricing.addPrices` / `updatePrices` / `updatePriceSets` called directly by a script, a backfill or another plugin. |

`pricing.price.deleted` is deliberately **not** subscribed to. It carries the id of a row that no
longer exists, so its currency cannot be read - and the currency is the whole recursion guard (see
below). What that leaves uncovered is the reclaim path: deleting a manually-overridden USD price to
hand it back to this plugin is picked up by the daily job rather than immediately. `product.deleted`
and `product-variant.deleted` are absent for the plain reason that there is nothing left to reprice.

### Why this does not loop

A recompute writes USD and EUR prices through `addPrices`/`updatePrices`, and both of those are
`@EmitEvents()`-decorated - so every write this plugin makes emits a `pricing.price.*` event that
this same subscriber is listening for. Two independent things stop that becoming an event loop, and
the first is the one relied on:

1. **A price event is resolved through its currency.** `listVariantIdsByPriceIds` reads each price
   id back and keeps only the rows whose `currency_code` is `pln`. This plugin only ever writes USD
   and EUR, so its own output resolves to zero variants and the handler returns before anything is
   queued. The `product.*` and `product-variant.*` events need no such guard: those are emitted by
   core's product workflows, and this plugin never calls one - it writes through the pricing module
   directly, for the reasons in "How a price is actually written".
2. **A second pass would have nothing to write anyway.** Even if a loop did start, the second lap
   over the same variant finds the price already at the target amount and still carrying this
   plugin's stamp, so `decidePriceAction` answers `noop`, nothing is written, and no further event
   is emitted. The loop is convergent, not merely guarded.

### Bursts

Saving a nine-variant product emits nine variant events plus a product event plus a price event per
row, and a CSV import emits thousands - each of which, handled alone, would fetch the NBP rate for
USD and again for EUR. So ids are collected into an in-process queue and the recompute runs once per
burst: 2s after the last event, or 30s after the first, whichever comes sooner. Firing after the
*last* write also means the recompute reads the finished state of a multi-step save rather than a
half-written one.

The queue is in-process rather than lock-and-cache coordinated across workers, because the work is
already partitioned by variant id: two workers each holding half a burst produce two runs over
disjoint variant sets, which is the correct answer reached in two passes. The cost is that ids held
in the queue are lost if the process exits before the flush - which is one more thing the daily job
is the backstop for. See `src/subscribers/lib/recompute-queue.ts`.

### What it does not do

- **It does not persist a run summary.** `last_run_summary` is a single column that Settings > FX
  pricing renders as "the last run"; letting a two-variant event-driven run overwrite it would
  replace the catalog-wide picture with counters that are true of two variants and nothing else,
  dozens of times a day. Only the full pass persists. An event-driven run reports itself in the log
  instead: `recomputed N variant(s) after a PLN price change: M price(s) written`.
- **It does not run while the plugin is off.** The toggle is checked before any query, so a store
  that has never armed the plugin pays one indexed single-row read per product save and stops.
- **It does not change any rule.** Narrowing a run changes only *which* variants are read. The
  margin refusal, the per-currency skips, the manual-override decision and the stamping are the same
  code, because there is exactly one implementation of them - `runFxPricingRecompute`, called with
  `{ variantIds }`.

## Install

This package is not on npm yet. It installs as a git dependency, pinned to a commit:

```jsonc
// package.json
{
  "dependencies": {
    "@zanreal/medusa-fx-pricing": "github:zanreal-labs/medusa-fx-pricing#5f00ff7801972c1fb757d58e3da98733f5bd3b7d"
  }
}
```

Pin to the commit you tested against. There is no published tag yet, so `#main` would move under
you on the next push to the repository; a pinned commit is the one spec that means the same thing
tomorrow that it means today.

The package compiles itself on install - `prepare` runs `medusa plugin:build`, which turns the
checked-out source into the `.medusa/server` output its `exports` point at. pnpm 10 and newer
refuse to run that script for a dependency they do not already trust, so a fresh install needs it
allowed once, in your project's `pnpm-workspace.yaml`:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  "@zanreal/medusa-fx-pricing@https://codeload.github.com/zanreal-labs/medusa-fx-pricing/tar.gz/5f00ff7801972c1fb757d58e3da98733f5bd3b7d": true
```

The key is the exact tarball URL pnpm resolves the pinned commit to, which is why it carries the
same SHA as the dependency line above - update both together when you move the pin.

Register it as a plugin in your Medusa app's `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils";

export default defineConfig({
  // ...
  plugins: [
    {
      resolve: "@zanreal/medusa-fx-pricing",
      options: {
        enabled: false,
        // No margin is shipped as a default. Set yours here, or leave it out
        // and set it in Settings > FX pricing instead. 1 means no markup.
        marginMultiplier: 1,
        stalenessToleranceHours: 120,
      },
    },
  ],
});
```

Then sync the module's migrations into your app's database:

```bash
npx medusa db:migrate
```

## Options

| Option                    | Type      | Default | Description                                                                    |
| -------------------------- | --------- | ------- | -------------------------------------------------------------------------------- |
| `enabled`                  | `boolean` | `false` | Seeds the persisted toggle on first install. See "Persisted settings" below.     |
| `marginMultiplier`         | `number`  | none    | Fallback margin multiplier when no override is saved. `1` = no markup, `1.25` = 25% over the raw NBP mid rate. **No default is shipped** - see "No default margin" below. |
| `stalenessToleranceHours`  | `number`  | `120`   | Fallback staleness tolerance (in hours) when no override is saved.               |

**These are starting points, not the final word.** An operator can override any of the three from
**Settings > FX pricing** in the admin, without editing any file or restarting the
backend - see "Persisted settings" below.

### No default margin

`marginMultiplier` deliberately has no default. A margin decides what a customer is charged, so a
shipped one would be some other store's commercial preference applied to your prices without you
choosing it. Until a margin is set - here, or in **Settings > FX pricing** - a recompute run
refuses and writes nothing, and the Settings page says so. Set `1` if you genuinely want the raw
NBP mid rate with no markup; that is a choice, and it is recorded as one. `enabled` defaults to `false` regardless of what a store
sets here at the moment of a fresh install seed - the option only changes what the very first
persisted row starts as; after that, Settings > FX pricing is where it is changed.

### Hard-disabling from the environment

`FX_PRICING_DISABLED` (any non-empty value other than `0`/`false`) forces the plugin off at
runtime, regardless of the persisted toggle. It can only ever force the plugin **off**, never on -
an operator can still flip the persisted toggle while the env var is set, and it takes effect the
moment the env var is cleared. Use this for an environment (staging, a broken deploy) where the
job/manual action must not run no matter what is saved in the database.

## The margin math

```
foreign_amount = pln_amount / nbp_rate * margin_multiplier
```

`nbp_rate` is PLN per 1 unit of the foreign currency (NBP's own convention), so dividing converts to
the foreign currency at the raw market mid rate, and `margin_multiplier` grosses that up. Rounded
half-up to 2 decimal places. See `computeForeignAmount` in `src/modules/fx-pricing/lib/compute.ts`
and its tests for the exact edge cases (a non-positive PLN amount, rate, or margin all resolve to
`undefined` rather than a guessed price - the "no silent defaults" rule the rest of this plugin
follows too).

## Persisted settings

`FxPricingSettings` (`src/modules/fx-pricing/models/fx-pricing-settings.ts`) is a one-row
singleton, read and written through `GET`/`POST /admin/fx-pricing/config` (see "Admin API" below).

- **`enabled`** is a real persisted boolean, not a nullable override. It is seeded once, from
  `moduleOptions.enabled` (itself defaulting to `false`), the moment the settings row is first
  created - after that, Settings > FX pricing is the only way to change it. This mirrors the
  sibling `medusa-allegro` plugin's runtime-toggle pattern rather than `medusa-product-costs`'s
  nullable-override pattern: a kill switch has no meaningful "fall back to the config default on
  every read" - an operator flips it, and that is the answer until they flip it again.
- **`margin_multiplier`** and **`staleness_tolerance_hours`** follow the `medusa-product-costs`
  pattern instead: nullable, `null` meaning "not overridden here", resolved against
  `moduleOptions.marginMultiplier` / `moduleOptions.stalenessToleranceHours` on every read. When
  `margin_multiplier` is null AND no `marginMultiplier` option was configured, there is no margin
  at all: a run refuses rather than falling back to a guessed one.

Every runtime path - the scheduled job, the manual "Recompute now" action, the admin config route -
resolves all three through `FxPricingModuleService.getResolvedRuntimeOptions()`, never from a value
captured at boot. A change saved from Settings > FX pricing takes effect on the very next run, no
backend restart.

## Admin UI

**Settings > FX pricing** is the plugin's only admin surface - there is no per-product widget,
because this plugin has nothing per-product to show that is not already the variant's own price
(visible on the product's own price editor).

- **Enabled** - the persisted toggle, saved immediately on flip (no separate Save button - this is
  a kill switch, not a form field). Shows a badge when `FX_PRICING_DISABLED` is forcing it off.
- **Configuration** - the margin multiplier and staleness tolerance, with a Save button and a
  "Reset to plugin default" action that appears once either is overridden.
- **Current NBP rates** - fetched live on every page load, so an operator can sanity-check what the
  next run would compute before running it.
- **Last run** - the most recent run's timestamp and per-currency summary (created/updated/
  unchanged/skipped counts, or why a currency was skipped entirely), plus a **Recompute now**
  button that runs the same logic as the scheduled job and shows its result inline.

### What the run summary promises

- **Every target currency is always present.** A currency the run never got to carries
  `reached: false`; a currency whose own pass threw carries `failed: true` and its `error`, and the
  next currency is still attempted. A currency is never simply missing from the report.
- **`created`/`updated` count prices that landed AND were stamped.** What the run intended is kept
  separately as `plannedCreates`/`plannedUpdates`, so the two can be compared instead of confused.
- **An error is preserved, not stringified.** A Medusa workflow throws the orchestrator's
  *serialized* error - a plain object, not an `Error` instance - so `String(err)` renders it as
  `"[object Object]"`. `describeError` reads the message, name and stack off whatever was actually
  thrown, including nested `{ action, error }` wrappers, and falls back to JSON rather than to
  nothing.
- **A run that writes nothing says so.** `pricesWritten` is the total across every currency, and a
  completed *full* run that leaves it at `0` logs a warning with the counts that explain why and
  shows a line in the admin. A plugin that decides to touch nothing and reports nothing is
  indistinguishable from one that works. (A narrowed, event-driven run that writes nothing is the
  ordinary outcome of saving a product whose PLN price did not move, so that one logs at `debug` -
  warning on each of those would train an operator to ignore the warning that matters.)
- **A run says what set it going, and how wide it was.** `trigger` is one of `scheduled`, `manual`,
  `event` or `workflow`, and `scopedVariantCount` is the number of variants the run was narrowed to
  or `null` for a full pass. Without those two, `skippedNoPlnPrice: 0` reads as a statement about
  the catalogue when it may be a statement about two variants.

## Admin API

All routes are under `/admin/fx-pricing` and use Medusa's standard admin authentication.

### `GET /admin/fx-pricing/config`

The resolved runtime configuration, the live NBP rates, and the last run's summary.

```json
{
  "effectiveEnabled": true,
  "forceDisabled": false,
  "persistedEnabled": true,
  "marginMultiplier": 1.25,
  "marginMultiplierOverridden": false,
  "stalenessToleranceHours": 120,
  "stalenessToleranceHoursOverridden": false,
  "lastRunAt": "2026-08-13T03:00:00.000Z",
  "lastRunSummary": {
    "ranAt": "2026-08-13T03:00:00.000Z",
    "ran": true,
    "pricesWritten": 15,
    "currencies": {
      "usd": {
        "reached": true,
        "currencyDisabled": false,
        "rateUnavailable": false,
        "rateStale": false,
        "failed": false,
        "plannedCreates": 3,
        "plannedUpdates": 12,
        "created": 3,
        "updated": 12,
        "unchanged": 140,
        "skippedManualOverride": 5,
        "skippedNoPlnPrice": 2,
        "skippedQuantityTiered": 0,
        "stampFailed": 0,
        "rate": 3.9123,
        "rateEffectiveDate": "2026-08-12"
      },
      "eur": { "...": "..." }
    }
  },
  "liveRates": {
    "usd": { "mid": 3.9123, "effectiveDate": "2026-08-13", "tableNo": "154/A/NBP/2026" },
    "eur": { "mid": 4.2567, "effectiveDate": "2026-08-13", "tableNo": "154/A/NBP/2026" }
  }
}
```

### `POST /admin/fx-pricing/config`

Persists an override: `{ enabled?, margin_multiplier?, staleness_tolerance_hours? }`. Only the keys
present are written. `margin_multiplier`/`staleness_tolerance_hours` accept `null` to clear the
override back to the `medusa-config.ts` default; `enabled` does not accept `null` (see "Persisted
settings" above). Returns the same shape as the `GET` above, reflecting the just-saved state.

`margin_multiplier` must be a positive number up to `10`. `staleness_tolerance_hours` must be a
positive integer up to `720` (30 days). An unknown key, a wrongly-typed value, or a body with no
writable key at all is rejected with `400`.

### `POST /admin/fx-pricing/recompute`

Runs the same recompute the scheduled job runs, immediately. Gated by the same toggle check the job
uses - when the plugin is disabled, this returns `{ "summary": { "ran": false, ... } }` without
writing anything, rather than duplicating (and risking disagreeing with) the job's own gate.

```json
{ "summary": { "ranAt": "...", "ran": true, "trigger": "manual", "scopedVariantCount": null, "currencies": { "usd": { "...": "..." }, "eur": { "...": "..." } } } }
```

## The scheduled job (the backstop)

`fx-pricing-daily-recompute` (`src/jobs/fx-pricing-daily-recompute.ts`) runs a full catalog pass
once a day at 03:00 server time by default - after the NBP table A publication window has closed for
the previous day and before most stores' business hours, so a price change is never visible
mid-shopping-session. Override the schedule with `FX_PRICING_CRON` (a standard cron expression) -
Medusa evaluates a scheduled job's `config.schedule` at plugin-load time, before the DI container
(and this plugin's resolved options) exists, so the schedule has to be read from the environment
rather than from a plugin option or the persisted settings.

Since the subscriber handles a PLN price changing, this job exists for everything an event cannot
say, and the list is real:

- **The rate moved, not the price.** NBP publishes a new table A every business day and no store
  event accompanies it. Nothing but a schedule notices that yesterday's USD price is now a day of
  currency drift out of date - which is the entire point of this plugin.
- **A price written outside a workflow.** Raw SQL or a migration changes what customers are quoted
  and emits nothing at all.
- **An event that was dropped.** A restart mid-burst, an event bus that lost a message, a handler
  that threw. Every event-driven system needs a pass that assumes it missed something.
- **A price handed back.** Deleting a manually-overridden USD price makes the variant eligible
  again, but the deletion itself is not a trigger this plugin acts on - see "Reacting to a price
  change".

It is also the only caller that scans the whole catalog and the only one whose summary is persisted
as `last_run_summary`.

When the plugin is disabled (the common case for a fresh install - `enabled` defaults to `false`),
the job logs `skipped (disabled...)` and returns immediately, writing nothing - and so does the
subscriber.

## Handling a currency that is not enabled yet

Not every store has USD and EUR turned on in **Settings > Store > Currencies** the moment this
plugin is installed. A target currency that is not in the store's `supported_currencies` is skipped
for the **entire run** (not per-variant) - logged once, reported in the run summary as
`currencyDisabled: true` - rather than attempting writes Medusa would reject, or crashing the job.
Turning the currency on in the store's settings makes it eligible again on the very next run.

## Development

Requires Node.js >= 22.13 (pnpm 11, pinned via `packageManager` in `package.json`, needs it).

```bash
pnpm install
pnpm test            # vitest - rate parsing, margin math, and the manual-override decision, all unit tested
pnpm exec medusa lint src
pnpm exec tsc --noEmit -p tsconfig.json          # backend
pnpm exec tsc --noEmit -p src/admin/tsconfig.json # admin UI
pnpm build            # medusa plugin:build
```

Generating a fresh migration after changing a model requires a scratch Postgres database:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/scratch_db npx medusa plugin:db:generate
```

### What is unit tested, and what is not

The pure business logic has exhaustive unit tests and no framework dependency:

- `src/modules/fx-pricing/lib/nbp.ts` - parsing an NBP table A response (`parseNbpRatesResponse`),
  the fetch wrapper with an injectable `fetch` (`fetchNbpRate`), and the staleness check
  (`isRateStale`).
- `src/modules/fx-pricing/lib/compute.ts` - the margin math (`computeForeignAmount`).
- `src/modules/fx-pricing/lib/decision.ts` - the manual-override decision (`decidePriceAction`).
- `src/modules/fx-pricing/lib/errors.ts` - reducing any thrown value to a real message
  (`describeError`), including Medusa's serialized non-`Error` workflow throws.
- `src/workflows/lib/plan.ts` - `planCurrencyRecompute`, which runs `decidePriceAction` across a
  whole batch of variants and tallies the result, still with no I/O.
- `src/workflows/lib/variant-prices.ts` - reading a variant's default price out of its raw price
  list (`findDefaultPrice`, `hasQuantityTieredPrice`).
- `src/subscribers/lib/events.ts` - which events are subscribed to and how the ids are read out of
  one (`parseFxPricingEvent`), including that the match is exact rather than by prefix and that the
  three payload shapes Medusa can hand a subscriber are all accepted.
- `src/subscribers/lib/recompute-queue.ts` - the burst coalescing
  (`createRecomputeQueue`): one flush per burst with the union of its ids, the quiet period, the
  deadline that stops a long import holding the first price hostage, and that two recomputes never
  overlap. The clock is injected, so the timing is asserted rather than waited for.

`src/workflows/recompute-fx-prices.ts` (the orchestration: fetching rates, querying the catalog,
writing prices, re-reading and stamping the result), the subscriber handler itself, the scheduled
job, and the admin API routes are deliberately thin glue around the tested functions above and are
not unit tested - the same split `medusa-product-costs` and `medusa-allegro` use, since exercising
them for real needs a live Medusa container and a live Postgres, which CI does not have (see the
reference plugin's own README for the same reasoning, under "Known gap").

## Roadmap

**Other target currencies.** Only USD and EUR are supported (`FxSourceCurrency` in
`src/modules/fx-pricing/lib/nbp.ts`) - NBP table A carries dozens of currencies, so adding a third
is a matter of extending that type and the `TARGET_CURRENCIES` list, not a redesign.

**Reclaim without deleting.** Today the only way to let this plugin manage a variant+currency again
after a manual edit is to delete the price entirely. An explicit "reclaim" admin action (per
variant, or per SKU) that clears the stale `FxManagedPrice` stamp without requiring a delete-then-
recreate round trip is a natural follow-up once there is a per-product surface to put it on.

**Per-product visibility.** There is currently no per-product widget showing whether a given
variant's USD/EUR price is plugin-managed or a manual override - an operator has to infer it from
the price editor plus the last run's summary. A widget on the product detail page (mirroring
`medusa-product-costs`'s own widget) is the natural place for this.

## Releasing

Publishing happens only from
[`.github/workflows/release.yml`](./.github/workflows/release.yml), and there is
no second path. npm **provenance** is a signed statement about where a tarball
was built and from which commit, and only a cloud CI run holding an OIDC
identity can produce one. An `npm publish` from a laptop would put a version on
npm carrying no provenance, and a published version cannot be replaced
afterwards, only deprecated. `publishConfig.provenance` in `package.json` makes
that local publish fail rather than quietly succeed without it.

Nothing has been published yet. `@zanreal/medusa-fx-pricing` is not on the
registry, so the pinned git dependency in [Install](#install) is still the only
way to consume it; the first GitHub Release is what changes that.

To cut a release:

1. Bump `version` in `package.json` on `main`.
2. Publish a GitHub Release whose tag is `v<version>`, exactly.

The workflow refuses to publish when the tag disagrees with `package.json`, or
when that version is already on the registry. A release marked as a prerelease
on GitHub publishes under the `next` dist-tag, so `npm install
@zanreal/medusa-fx-pricing` never resolves to a release candidate.

Authentication is an `NPM_TOKEN` repository secret: a granular access token with
write permission on this package. npm's trusted publishing (OIDC, with nothing
stored in GitHub) cannot cover the *first* publish, because npmjs.com only
offers the trusted publisher form on a package that already exists. Once the
first version is up, add one under the package's settings on npmjs.com - GitHub
Actions, owner `zanreal-labs`, repository `medusa-fx-pricing`, workflow
`release.yml`, environment `npm` - and then delete the `NPM_TOKEN` secret. The
workflow needs no edit for that: npm attempts the OIDC exchange first and falls
back to the token only when the exchange fails.

## License

MIT
