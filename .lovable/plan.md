## Add Schema.org structured data for Splat

Inject two JSON-LD blocks into `index.html` `<head>` so search engines can produce richer results (sitelinks, app cards, knowledge panels) for Splat.

### What gets added

**1. Organization schema** — identifies Splat as the publishing entity.

Fields: `@type: Organization`, `name: "Splat"`, `url`, `logo` (favicon URL), `description`, `sameAs` (empty array, ready for socials later).

**2. SoftwareApplication schema** — describes the product itself, eligible for app rich results.

Fields: `@type: SoftwareApplication`, `name: "Splat"`, `applicationCategory: "DeveloperApplication"`, `operatingSystem: "Web"`, `description: "The bug tracker for indie devs and small studios. Crush bugs faster. Ship more."`, `url`, `image` (existing OG image), `offers` ($0 free tier), `publisher` (referencing the Organization).

### Where it goes

Two `<script type="application/ld+json">` blocks placed inside `<head>` in `index.html`, just below the existing Twitter meta tags and above the favicon link. Static markup — no runtime JS, no React changes — so crawlers see it immediately on the initial HTML response.

### Notes / trade-offs

- URL will use the production/preview origin as a placeholder (`https://splat.app` style placeholder is risky — instead I'll use the current preview URL `https://id-preview--19ed109f-6927-46f7-b4a6-1ffdd2b10c0b.lovable.app` so it's valid until you publish on a custom domain. Easy one-line update later.)
- No `aggregateRating` / `review` included — adding fake ratings violates Google's structured data policy.
- `sameAs` left as empty array; populate when social profiles exist.
- No new files, no dependencies, no DB changes.

### Validation

After the change, the markup can be validated via Google's Rich Results Test by pasting the rendered HTML.
