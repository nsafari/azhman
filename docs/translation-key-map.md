# Translation Key Map

This document tracks user-facing content keys for the multilingual static site (`en`, `ar`, `fa`).

## Key Naming Convention

- Global/shared keys: `common.*`
- Per-page metadata: `meta.pages.<page>.title|description`
- Per-page content: `<page>.<section>.<field>`
- Accessibility labels: `common.a11y.*`

## Page Inventory

- `index.html`
  - header + language switchers + footer (`common.*`)
  - hero + highlight + features (`home.*`)
- `about.html`
  - header + language switchers + footer (`common.*`)
  - hero + values (`about.*`)
- `services.html`
  - header + language switchers + footer (`common.*`)
  - hero + service cards + CTA (`services.*`)
- `contact.html`
  - header + language switchers + footer (`common.*`)
  - hero + contact details + form labels/placeholders (`contact.*`)

## Shared Key Prefixes

- `common.siteName`
- `common.skipToContent`
- `common.nav.*`
- `common.language.*`
- `common.a11y.*`
- `common.footer.*`

## Metadata Key Prefixes

- `meta.pages.home.*`
- `meta.pages.about.*`
- `meta.pages.services.*`
- `meta.pages.contact.*`

## Page Content Key Prefixes

- `home.hero.*`, `home.highlight.*`, `home.features.*`
- `about.hero.*`, `about.values.*`
- `services.hero.*`, `services.items.*`, `services.cta.*`
- `contact.hero.*`, `contact.details.*`, `contact.form.*`

## Maintenance Rules

1. Do not hardcode user-facing strings in HTML/JS. Use `data-i18n*` attributes and locale keys.
2. Add new keys in `assets/locales/en.json` first, then mirror in `ar.json` and `fa.json`.
3. Keep key names stable once published to avoid breaking references.
4. For accessibility text (`aria-label`, similar), always use `data-i18n-aria-label`.
5. Before release, verify key parity across all locale files.
