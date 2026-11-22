# Changelog

All notable changes to `@zanreal/medusa-fx-pricing` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

This plugin writes prices. Every entry says what a price on a variant would do differently
after the change.

## [Unreleased]

Nothing yet.

## [0.3.0] - 2026-11-22

### Changed

- **Built and tested against Medusa 2.23.0** (was 2.18.0 in 0.2.1): the `@medusajs/*` peers pin
  2.23.0 (`@medusajs/ui` 4.3.0), so install this release alongside Medusa 2.23.0 and stay on
  0.2.1 with older hosts. Medusa 2.23 requires Node.js 22.22 or newer, and so does this package.
- **React 19 admin toolchain.** The settings page is built with React 19, Vite 8 and
  `react-i18next` 18, the majors the 2.23.0 dashboard ships; the `react-i18next` peer is now
  `^18.0.1`. Admin extensions share the host's i18n instance, so it follows the dashboard.
- Dependency updates now come from Renovate, run weekly by the `zanek-ai` app from
  `.github/workflows/renovate.yml`, instead of Dependabot.

### Fixed

- The event parsing and burst-coalescing helpers moved from `src/subscribers/lib/` to
  `src/lib/`. Medusa loads a subscriber from every file under `subscribers/` at any depth, so
  the helpers were being picked up as (config-less) subscribers; the Medusa 2.23 lint rules
  flag exactly that. The one real subscriber is unchanged.

## [0.2.1] - 2026-09-08

### Fixed

- The install line no longer pins a version number. It named `0.1.0` explicitly,
  so it went stale the moment a release shipped and contradicted the version npm
  resolves. The `npm install` command below it was always version-less and correct.

## [0.2.0] - 2026-09-08

### Added

- **Recompute on price change.** A subscriber recomputes the derived USD and EUR prices
  when the PLN price moves, instead of leaving them stale until the next daily run.

### Fixed

- **Conversion starts from the net PLN amount, not the gross one.** A gross base ran VAT
  through the exchange rate and the margin, so every derived foreign price was wrong by
  the VAT factor. This is a correctness fix on the numbers customers were shown.
- A failing run preserves the real error rather than replacing it, which had been hiding a
  broken write path.

### Changed

- README states the package is on npm and how to install it from the registry. The
  previous text still told readers it was unpublished.

## [0.1.0] - 2026-08-26

First public release. MIT, published from CI with npm provenance.

### Added

- Derives USD and EUR variant prices from a native PLN selling price using the NBP
  (Narodowy Bank Polski) table A mid rate, on a daily schedule, with a configurable margin.
- **Manual overrides are preserved.** A price a human set is not overwritten by the run.
- Reporting counts variants that carry no PLN price at all, so a silent gap in the catalog
  is visible instead of being skipped.
- Admin UI in English and Polish, with the sidebar label resolved through i18n.

[Unreleased]: https://github.com/zanreal-labs/medusa-fx-pricing/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/zanreal-labs/medusa-fx-pricing/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.2.1
[0.2.0]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.2.0
[0.1.0]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.1.0
