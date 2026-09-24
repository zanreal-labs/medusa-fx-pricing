# Changelog

All notable changes to `@zanreal/medusa-fx-pricing` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

This plugin writes prices. Every entry says what a price on a variant would do differently
after the change.

## [Unreleased]

### Changed

- **Built and tested against Medusa 2.21.1** (was 2.18.0), with the admin toolchain Medusa 2.19
  requires: Vite 7 and, where used, React Router 7. `react-i18next` and `i18next` deliberately stay
  on the majors the Medusa dashboard itself ships (13 and 23): admin extensions share the host's
  i18n instance, and a second major would give them one of their own. Install alongside Medusa
  2.21.1; Node ^20.19 or ^22.12 is required from Medusa 2.19 on.

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

[Unreleased]: https://github.com/zanreal-labs/medusa-fx-pricing/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.2.1
[0.2.0]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.2.0
[0.1.0]: https://github.com/zanreal-labs/medusa-fx-pricing/releases/tag/v0.1.0
