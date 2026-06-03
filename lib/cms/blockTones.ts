// Per-block tone enum registry. Single source of truth — every
// block-registry schema that has a `tone` field reads its enum
// values from here, and the editor's insert pipeline reads the same
// values to pick a contrasting tone when the destination section
// renders dark.
//
// Adding a new tone token to a block (or registering a new tone-aware
// block) is a ONE-place edit here. The schema picks it up via the
// imported tuple; the dynamic tone resolver in InlineEditContext picks
// it up via the same export. CI pin in tests/unit/blockSeeds.test.ts
// round-trips every block's SEED_DATA through its Zod schema so a
// drift between this registry and the schemas surfaces immediately.
//
// `as const satisfies` pins the literal-tuple type so each enum
// arrives at the schema layer with the exact `[token, ...tokens]`
// shape `colorTokenOrHex` and `z.enum` require — without `as const`
// the values would widen to `string[]` and break the Zod union types.
//
// NOT marked `server-only` — both block-registry (server) and the
// inline-edit insert pipeline (client) import this module.

export const BLOCK_TONE_ENUMS = {
  // Luxury primitives.
  lx_heading: ['obsidian', 'ivory', 'champagne'],
  lx_text: ['obsidian', 'ivory', 'warm-stone'],
  // lx_richtext — a full markdown post body. Same tone set as lx_text
  // (the body-copy register): dark default, light for dark sections,
  // warm-stone for a muted variant.
  lx_richtext: ['obsidian', 'ivory', 'warm-stone'],
  // lx_eyebrow defaults to champagne (gold) — neutral, reads on both
  // dark and light surfaces. Listed here so future dynamic adapters
  // can see its full enum, but the resolver below treats champagne as
  // neutral and skips the override for it.
  lx_eyebrow: ['champagne', 'obsidian', 'ivory', 'warm-stone'],

  // Luxury composites.
  lx_channel_card: ['obsidian', 'ivory'],
  lx_stat: ['obsidian', 'ivory', 'champagne'],
  lx_quote: ['obsidian', 'ivory'],

  // Luxury 2.0 — composites added in the legacy-overhaul release.
  // Each replaces a legacy widget with a premium feel:
  //   lx_testimonial → testimonial (portrait + pull-quote)
  //   lx_video       → video_embed (cinematic poster + lazy iframe)
  //   lx_accordion   → accordion   (FAQ with smooth open/close motion)
  //   lx_tabs        → tabs        (product-page tabbed sections)
  //   lx_icon_list   → icon_list   (vertical feature list, lucide icons)
  //   lx_icon_box    → icon_box    (icon + headline + body card)
  lx_testimonial: ['obsidian', 'ivory'],
  lx_video: ['obsidian', 'ivory'],
  lx_accordion: ['obsidian', 'ivory'],
  lx_tabs: ['obsidian', 'ivory'],
  lx_icon_list: ['obsidian', 'ivory', 'champagne'],
  lx_icon_box: ['obsidian', 'ivory'],

  // Final composites closing the legacy purge.
  lx_divider: ['champagne', 'warm-stone', 'copper', 'obsidian', 'ivory'],
  lx_social_icons: ['obsidian', 'ivory', 'warm-stone'],
  lx_cta_banner: ['obsidian', 'ivory'],
  lx_gallery: ['obsidian', 'ivory'],
  // lx_featured_projects has NO tone — its renderer auto-contrasts the
  // ancestor section surface, so there's no per-block colour token.

  // ─── Elementor-parity blocks ────────────────────────────────────
  lx_carousel: ['obsidian', 'ivory'],
  lx_testimonial_carousel: ['obsidian', 'ivory'],
  lx_pricing_table: ['obsidian', 'ivory'],
  lx_pricing_list: ['obsidian', 'ivory'],
  lx_reviews: ['obsidian', 'ivory'],
  lx_star_rating: ['champagne', 'obsidian', 'ivory'],
  lx_progress_tracker: ['obsidian', 'ivory'],
  lx_animated_headline: ['obsidian', 'ivory', 'champagne'],
  lx_countdown: ['obsidian', 'ivory'],
  lx_flip_box: ['obsidian', 'ivory'],
  lx_hotspot: ['obsidian', 'ivory'],
  lx_progress: ['obsidian', 'ivory'],
  lx_toc: ['obsidian', 'ivory'],
  lx_share: ['obsidian', 'ivory', 'warm-stone'],
  lx_marquee: ['obsidian', 'ivory'],
  lx_before_after: ['obsidian', 'ivory'],
  lx_comparison_table: ['obsidian', 'ivory'],
  lx_timeline: ['obsidian', 'ivory'],
} as const satisfies Record<string, readonly [string, ...string[]]>

export type ToneAwareBlockType = keyof typeof BLOCK_TONE_ENUMS
