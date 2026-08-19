# docs/

The published documentation for `@zanreal/medusa-fx-pricing`.

These pages are the source of what renders at
<https://zanreal.com/docs/oss/medusa-fx-pricing>. The marketing site clones this
repository at build time and copies this directory into its own content tree, so
a change merged here is what the site ships on its next deploy. Nothing is
maintained by hand on the other side.

## Layout

| File | Purpose |
| --- | --- |
| `index.en.mdx`, `index.pl.mdx` | Overview: what the plugin does, the formula, the shape of a run, how a host installs it. |
| `rates.en.mdx`, `rates.pl.mdx` | NBP table A, the endpoint with no date on it, the staleness tolerance, and the three ways a currency is skipped. |
| `overrides.en.mdx`, `overrides.pl.mdx` | The ownership stamp and the four branches that decide whether a price may be touched. |
| `settings.en.mdx`, `settings.pl.mdx` | Every option and where it resolves from, the environment variables, the admin page, and the admin API. |
| `meta.json`, `meta.pl.json` | Sidebar title, description and page order, per locale. |

This `README.md` is deliberately **not** copied by the sync. It explains the
directory to someone browsing GitHub; it is not a page on the site.

## Conventions

- **Every page exists in both locales**, suffixed `.en.mdx` and `.pl.mdx`.
- **Each locale is written from the code, not translated from the other.** The
  two versions make the same argument and are expected to differ in examples,
  ordering and emphasis.
- **Cross-links between pages are relative** and point at the file, for example
  `[Manual overrides](./overrides.en.mdx)`. That resolves when browsing this
  directory on GitHub, and the site's sync rewrites it to a site route on the way
  in. The locale is taken from the link target, so `./overrides.pl.mdx` lands on
  the Polish page.
- **No em or en dashes.** Use a spaced hyphen for a parenthetical.
- **Nothing is described without reading its implementation.** Options, defaults,
  response fields and behaviours come from the source, not from the top-level
  README, which is a summary and has drifted before.
