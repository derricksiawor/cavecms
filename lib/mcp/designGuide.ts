import 'server-only'

// Shown to every MCP client in the `initialize` result (the agent reads it on
// connect). Short, blunt, mandatory. The full standard is the `design_guide`
// tool; the content-mutating tools are HARD-GATED on it (see server.ts).
//
// This guide is BRAND-AGNOSTIC on purpose — thousands of operators use this
// server for thousands of different brands. It encodes how to make ANY brand's
// page feel ultra-premium; it never prescribes specific colors, fonts, or a
// house palette. The only palette instruction is "set it to the BRAND'S real
// colors".
export const SERVER_INSTRUCTIONS = `CaveCMS MCP — ultra-premium content authoring.

MANDATORY before you create or edit ANY page / post / block:
  1. Call the \`design_guide\` tool and follow it. The content-mutating tools
     (create_*/update_*/edit_page/delete_*/upload_media/update_settings/update_nav)
     are DISABLED until you call \`design_guide\` in this session.
  2. Call \`get_theme\` to read the live palette, fonts, and logo.

Call \`capabilities\` any time for the full map of what CaveCMS + this server can do
(every feature, the content model, branding/theme controls, batch ops, limits,
error codes, and the complete tool list). Call \`describe_block_types\` for exact
block data shapes.

Every CaveCMS page must feel ULTRA-PREMIUM and BRAND-MATCHED — maximum elegance,
never generic, never minimal-by-laziness. If you are building for a specific
brand, fetch its OFFICIAL logo + real colors from its own site and set them via
upload_media + update_settings('theme_palette','site_header','footer') BEFORE you
compose a single section. Building blind — random stock imagery, the default
palette left on a real brand, walls of flat same-size text — produces ugly pages
and is treated as a defect.`

// The full standard, returned by the `design_guide` tool. Calling it also unlocks
// the content-mutating tools for the session.
export const DESIGN_GUIDE = `# CaveCMS Design Guide — ultra-premium composition. Read before you build.

Every page built here must feel ULTRA-PREMIUM: maximum elegance, considered,
confident — never cheap, never "minimal because it was easy". This is the standard
for every page, every brand, every operator on this server. It is BRAND-AGNOSTIC:
it tells you HOW to make any brand feel luxurious — never which colors to use. The
write tools stayed locked until you called this.

## 0. PRIME DIRECTIVE — establish the brand FIRST, then compose
A premium page is BRAND-MATCHED, never generic. Before creating any block:
  1. \`get_theme\` → read the live palette, fonts, logo.
  2. If building for a specific company/brand:
     a. Get its REAL, OFFICIAL assets — logo, color palette (primary / accent /
        background / text), typeface — from the brand's own site or brand kit.
        Use the OFFICIAL logo; never hand-roll or approximate a brand mark.
     b. \`upload_media\` the logo → set it on \`site_header\` AND \`footer\`
        (\`update_settings\`).
     c. \`update_settings('theme_palette', { mode, primary, secondary, accent,
        surfaceDark, surfaceLight })\` to the brand's REAL colors. The entire site
        — header, footer, every section background, every button — derives from
        this. Setting it is what makes a page look like the brand; skipping it is
        the single biggest cause of a generic, ugly page.
     d. \`update_settings('typography', { heading, body })\` to the brand's real
        TYPEFACES (pick from the catalog in \`capabilities\`). Type carries as much
        brand identity as color — a SaaS in a serif, or a luxury house in a
        generic sans, reads wrong instantly.
     e. Set the header nav + footer to the brand's real navigation.
  3. ONLY THEN compose.

## 1. Premium, NOT minimal — maximum elegance
- A premium page is RICH and intentional, not a bare stack of two blocks. Compose
  a full, deliberate page (hero → proof → features → showcase → offer → close).
- Elegance = hierarchy + generous space + restraint, used together: a confident
  hero, breathing room, ONE accent for emphasis. Never crammed; never decorated
  for decoration's sake.

## 2. Typography — bold, large, hierarchical (never light, never flat)
- Headings are BOLD and LARGE. Hero headline: \`lx_heading\` level h1, size
  \`display-2xl\` — exactly one per page. Section headlines: h2, \`display-md\`.
  No light font weights, no walls of identical-size text.
- Lead each section headline with an \`lx_eyebrow\` (short uppercase kicker) for
  editorial structure. Body via \`lx_text\`, concise (1–3 sentences). Use eyebrows
  / badges for labels — never bracket-y "[LABEL]" text.
- TYPEFACE is brand identity. Set the brand's real fonts site-wide via
  update_settings('typography', { heading, body }) (catalog in \`capabilities\`).
  Pairing discipline: ONE or TWO families, never more. SaaS/product → a clean
  geometric/grotesk sans for both (poppins/inter/manrope/space-grotesk).
  Editorial/luxury → a display serif heading (fraunces/playfair-display) + a
  humanist sans body (inter/work-sans). Match the brand; don't default-guess.

## 3. Space & rhythm
- Generous spacing is the premium signal. Section padding: \`xl\` for hero +
  closing CTA, \`lg\` for content, \`md\` for tight visual sections. When unsure,
  more space.
- Background rhythm is DELIBERATE, not random: e.g. dark hero → a light body run →
  one dark punctuation section → light → a dark/accent close. ~2–3 intentional
  background changes per page. Flipping the background every section is noise.
- MOTION, used sparingly for premium feel: a hero with a single photo reads richer
  with a slow \`kenBurns\` drift ('zoom-out' is the safest, most cinematic). A hero
  that should showcase several images (properties, work, rooms) → set section
  \`meta.backgroundSlides\` (2+ { media_id, alt }) with \`slideTransition:'through-black'\`
  + \`slideIntervalMs:6000\` (ms — 4000 = 4s) + \`kenBurns:'zoom-out'\` — the photos cross-fade through black
  with a counter-zoom. Use it on the HERO (and maybe one closing CTA), not everywhere.
  All motion auto-respects reduced-motion. Standalone image widgets (lx_figure) also
  take a \`kenBurns\` value for the same ambient drift.

## 4. Color & depth
- One accent (the BRAND'S accent), used sparingly — CTAs, the single featured
  pricing card, small highlights. Never large accent fills, never two competing
  colors.
- Create depth with a strong dark hero, layered imagery, and primary-color
  highlights — not with clutter.
- BANNED, always: blue-pink gradients, decorative borders / hairlines, emojis as
  UI. They read as cheap and instantly break the premium feel.

## 5. Imagery — the rule that matters most
- Imagery must BELONG to the brand/subject: the company's own product shots or
  screenshots, its official logo, or photography unmistakably about its domain.
- NEVER random stock unrelated to the brand (a generic "team smiling at a laptop"
  on a developer-infrastructure product is exactly what makes a page look amateur).
- Consistent treatment (same mood + crop discipline); real \`alt\` text; upload via
  \`upload_media\`, reference by media_id. Full-bleed images are for the hero or a
  deliberate showcase only — never dumped bare between text sections.

## 6. Everything connects (a site is a graph, not a stack)
- Every CTA / button links to a REAL destination (/contact, /pricing, a real page)
  — never "#" and never a dead end.
- Header nav + footer must reflect the real brand and tie the site together.
- Each page offers the next step.

## 7. Canonical one-pager structure
hero (dark, xl: eyebrow + display-2xl headline + 1–2 line subhead + ONE primary CTA)
 → stats / proof (3-up \`lx_stat\`, big meaningful numbers)
 → features (\`lx_icon_list\` / icon boxes, 3–6 items, lucide icons)
 → showcase (\`lx_figure\` + \`lx_heading\`/\`lx_text\`, two columns)
 → pricing (\`lx_pricing_table\` ×3–4, exactly ONE featured:true → gets the accent)
 → testimonial / quote
 → closing CTA banner (xl, ONE button mirroring the hero CTA)

## 8. Per-block best practice
- Hero: ONE primary CTA (compact, never full-width); any second action is a quiet
  link, not a rival button.
- Stats: 3 across, round/meaningful numbers, short labels.
- Icon list: lucide icon names (shield-check, terminal, globe, lock, activity,
  layout-dashboard, sparkles…), tight headline + one-line body.
- Pricing: 3–4 plans, exactly one featured, consistent feature counts.
- Keep counts curated (galleries/lists ~3–8 items). Premium is edited, not a dump.

## 9. NEVER (the anti-patterns that produce an ugly page)
- Random stock images unrelated to the brand.
- A branded client page left on the DEFAULT palette (set theme_palette first).
- A hand-rolled / approximated brand logo (use the official asset).
- No logo in header/footer.
- Background flips every section; same-size text walls; 2+ competing primary CTAs.
- Blue-pink gradients, decorative borders/lines, emojis as UI.
- A bare full-bleed image dumped between two text sections with no purpose.
- A sparse, half-built page declared "done".

## 10. Completion checklist — NOT done until every box is checked
□ Official brand logo set in header (and footer).
□ theme_palette set to the brand's REAL colors (accent + surfaces), not the default.
□ Header nav + footer reflect the real brand and link the site.
□ Hero: one bold display-2xl headline + one primary CTA.
□ Imagery on-brand (zero random stock).
□ Deliberate background rhythm (~≤3 intentional changes).
□ Varied hierarchy (eyebrow → display-2xl → display-md → body); bold, not light.
□ Generous spacing (xl hero/CTA, lg content).
□ Pricing has exactly one featured plan.
□ Every CTA links to a real destination; nothing dead-ends.
□ The page is rich and intentional — ultra-premium, not minimal.

## 11. Layout, color & dark-section recipes (battle-tested — use these)
- EXACT brand colors: a section's background can be ANY hex via
  \`meta.backgroundColor\` (#RGB/#RRGGBB) — not just the 8 named tokens. Text
  colors (every \`tone\` field) and \`theme_palette\` also accept #hex. So match a
  brand's real palette precisely; don't settle for the nearest token.
- DARK SECTIONS — they now JUST WORK, PLATFORM-WIDE: EVERY text-on-section block
  (\`lx_heading\`, \`lx_text\`, \`lx_eyebrow\`, \`lx_stat\`, \`lx_quote\`, \`lx_cta_banner\`,
  \`lx_icon_list\`, \`lx_accordion\`, \`lx_comparison_table\`, \`lx_pricing_table\`,
  \`lx_progress_tracker\`, \`lx_tabs\`, \`lx_timeline\`, \`lx_toc\`, \`lx_countdown\`,
  \`lx_marquee\`, \`lx_progress\`, \`lx_channel_card\`, \`lx_testimonial\`,
  \`lx_testimonial_carousel\`, \`lx_animated_headline\`, \`lx_gallery\`, \`lx_carousel\`)
  AUTO-ADAPTS its text to light on any dark section (a dark token OR a dark hex
  \`backgroundColor\`) — you no longer need to set \`tone\` at all. Only set \`tone\` to
  deliberately OVERRIDE (e.g. force an accent color, or dark text on a light
  section). Hex tones are always respected as-is.
- HERO with inline buttons: use \`lx_cta_banner\` — it renders \`eyebrow\` + a large
  \`title\` (h2) + \`body\` + \`primaryCta\` + \`secondaryCta\` SIDE-BY-SIDE, centered
  when \`alignment:'center'\`. It is the canonical hero block. Put an \`lx_code\`
  terminal/install card right after it for a dev-tool hero.
- CENTERING: set \`alignment:'center'\` on heading/text/eyebrow/action/quote.
- ROWS / GRIDS: a row = a section with \`columns:N\` + N COLUMN children; column
  width via \`ColumnMeta.width\` (1–12); feature grids via \`lx_icon_list\`
  \`variant:'grid'\` + \`columns:1–3\`. For a HORIZONTAL row of widgets INSIDE a
  single column (button rows, badge strips, logo rows, stat clusters) set the
  column's \`childLayout:'row'\` (+ \`childJustify:'start'|'center'|'end'|'between'\`) —
  no need to split the section into multiple columns.
- CODE/terminal: \`lx_code\` has a one-click copy button (\`copyable\`, default on).
- GRADIENTS (use sparingly — ONE accent gradient per page, premium not gaudy):
  a section/column background (\`meta.backgroundGradient\`), gradient TEXT on a
  headline/body/eyebrow (\`data.textGradient\` — background-clip:text), or a button
  fill (\`lx_action.data.backgroundGradient\`). Shape:
  \`{ kind:'linear'|'radial', angle:0–360, stops:[{color:'#hex', position?:0–100}] }\`
  (2–6 hex stops). Keep stops on-brand (2 stops of the brand's accent family reads
  premium; 5 rainbow stops reads cheap). A gradient background auto-flips text to
  light when its stops are dark.
- EXACT TYPE (pixel-match a brand): \`lx_heading\`/\`lx_text\` take \`fontSize\`
  (length or responsive \`clamp()\`), \`lineHeight\` (unitless e.g. '1.1'), and
  \`letterSpacing\` (e.g. '-0.025em') overrides. Display headings already default to
  tight, premium leading — only override when matching a brand to the pixel.
- EXACT SPACING: section \`meta.paddingTop\`/\`paddingBottom\` accept a raw pixel
  number (not just a token) — e.g. \`paddingTop:144, paddingBottom:112\` — to match a
  brand's exact vertical rhythm. Per-side padding/margin also accept unit strings
  ("2rem", "5%", "10vw").
- FULL ELEMENTOR-PARITY CONTROL SET (call \`capabilities\` → decorationControls /
  widgetMeta / gradientsAndExactType for exact field names): borders + box-shadow,
  sticky, scroll motion (parallax/fade/zoom/tilt), card hover (lift/shadow/border),
  per-block custom CSS, SVG shape dividers between sections, background VIDEO,
  content max-width, responsive per-breakpoint type, a nested \`childLayout:'grid'\`
  card grid inside a column, a standalone \`lx_icon\`, a composable \`lx_form\`
  (incl. submit fill/text colour + full-width + radius), button hover + per-corner
  radius + fill colour + a flat \`elevation:'none'\` opt-out of the primary glow,
  two-tone headings (\`lx_heading.highlightText\`/\`highlightColor\`), a static
  (non-scrolling) \`lx_marquee\` logo row (\`speed:'static'\`), figure
  lightbox/hover-zoom, and operator-defined global brand swatches.
- CHROME OVERRIDES (header/footer without engine edits): \`site_header\` takes
  optional \`ctaFillColor\`/\`ctaTextColor\`/\`ctaHoverFillColor\`/\`ctaHoverTextColor\`/
  \`ctaRadius\` + \`navColor\`/\`navActiveColor\`; \`footer\` takes \`newsletterEnabled\`
  (false removes the newsletter column), \`accentColor\`, and the same \`cta*\`
  colour set for its Subscribe button. All #hex, all optional — unset keeps the
  theme defaults. Use them to match any brand to the pixel.`
