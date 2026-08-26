# @zanreal/medusa-fx-pricing

A [Medusa v2](https://medusajs.com) plugin that derives USD and EUR variant prices from a store's
native PLN selling price, using the NBP (Narodowy Bank Polski, the Polish central bank) table A
mid rate plus a configurable margin. Runs on a daily schedule; a manual price edit is never
overwritten.

Full documentation, in English and Polish, is published at
<https://zanreal.com/docs/oss/medusa-fx-pricing> and authored in [`docs/`](./docs).

There is no FX-pricing plugin in the Medusa ecosystem today. A store that sells in PLN and wants
USD/EUR listed too either prices them by hand (and lets them drift out of date as the rate moves)
or wires up a bespoke script. This plugin is that script, packaged: a small, standalone module that
computes `foreign_amount = pln_amount / nbp_rate * margin_multiplier` for every variant with a PLN
price, once a day, and gets out of the way of anything a human has already priced by hand.

## What it does

- Fetches the latest published NBP table A mid rate for USD and EUR (`GET
  /api/exchangerates/rates/a/usd/` and `.../eur/` - no date suffix, so it always answers with the
  most recently published table, which is how weekends and Polish public holidays - days NBP does
  not publish a new table - are handled without any special-casing).
- Computes `foreign_amount = pln_amount / nbp_rate * margin_multiplier` for every product variant
  that has a default (no price-list, no price-rule) PLN price, and writes it as that variant's
  default USD/EUR price.
- Runs once a day via a Medusa scheduled job, and on demand via a "Recompute now" admin action.
- **Never touches a price a human has set.** The moment a USD/EUR price is created or edited by
  anything other than this plugin, it is permanently left alone - see "How manual overrides stay
  sacred" below for the exact mechanism.
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
    "currencies": {
      "usd": {
        "currencyDisabled": false,
        "rateUnavailable": false,
        "rateStale": false,
        "created": 3,
        "updated": 12,
        "unchanged": 140,
        "skippedManualOverride": 5,
        "skippedNoPlnPrice": 2,
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
{ "summary": { "ranAt": "...", "ran": true, "currencies": { "usd": { "...": "..." }, "eur": { "...": "..." } } } }
```

## The scheduled job

`fx-pricing-daily-recompute` (`src/jobs/fx-pricing-daily-recompute.ts`) runs once a day at 03:00
server time by default - after the NBP table A publication window has closed for the previous day
and before most stores' business hours, so a price change is never visible mid-shopping-session.
Override the schedule with `FX_PRICING_CRON` (a standard cron expression) - Medusa evaluates a
scheduled job's `config.schedule` at plugin-load time, before the DI container (and this plugin's
resolved options) exists, so the schedule has to be read from the environment rather than from a
plugin option or the persisted settings.

When the plugin is disabled (the common case for a fresh install - `enabled` defaults to `false`),
the job logs `skipped (disabled...)` and returns immediately, writing nothing.

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
- `src/workflows/lib/plan.ts` - `planCurrencyRecompute`, which runs `decidePriceAction` across a
  whole batch of variants and tallies the result, still with no I/O.
- `src/workflows/lib/variant-prices.ts` - reading a variant's default price out of its raw price
  list (`findDefaultPrice`).

`src/workflows/recompute-fx-prices.ts` (the orchestration: fetching rates, querying the catalog,
calling `upsertVariantPricesWorkflow`, re-reading and stamping the result), the scheduled job, and
the admin API routes are deliberately thin glue around the tested functions above and are not unit
tested - the same split `medusa-product-costs` and `medusa-allegro` use, since exercising them for
real needs a live Medusa container and a live Postgres, which CI does not have (see the reference
plugin's own README for the same reasoning, under "Known gap").

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
