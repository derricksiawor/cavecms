import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'

// Elementor-parity Social Icons widget. Canonical fields per
// `includes/widgets/social-icons.php`:
//   - icon list (repeater of {social_icon, link, color overrides})
//   - shape (rounded | square | circle)
//   - alignment (left | center | right | justified)
//   - icon_size, icon_padding, icon_spacing
//   - hover_animation
//
// BWC ships a CURATED platform allowlist (7 entries) matching the
// brand-mark SVGs we host under public/icons/social/ — never a
// freeform icon picker. project standards #0.57 forbids hand-rolled brand
// marks; sourcing icons from a controlled allowlist guarantees every
// rendered glyph is the official simple-icons SVG.
//
// Luxury real-estate visual default per researcher: monochrome
// (copper-on-near-black) hollow circles, generous gap, 200ms hover
// ease, NEVER the full official brand colours (those clash with a
// premium dark/cream palette). The SVGs we ship are monochrome from
// simple-icons; the visible accent comes from the surrounding ring
// + brand-name aria-label, not the glyph fill.
//
// Reference URLs:
//   - https://elementor.com/help/social-icons-widget/
//   - https://simpleicons.org/  (the source-of-truth brand-mark library)

type SocialIconsData = BlockData<'social_icons'>
type Platform = SocialIconsData['items'][number]['platform']

// Operator-facing brand names. Used for aria-label and as alt text
// fallback. Kept here (not in a shared util) because the aria-label
// IS the social-icons surface contract — a future platform addition
// MUST update both this map and the Zod enum to keep both ends honest.
const PLATFORM_NAME: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  whatsapp: 'WhatsApp',
}

const SIZE_CLASS: Record<SocialIconsData['size'], { wrap: string; glyph: string }> = {
  sm: { wrap: 'h-8 w-8', glyph: 'h-3.5 w-3.5' },
  md: { wrap: 'h-10 w-10', glyph: 'h-4 w-4' },
  lg: { wrap: 'h-12 w-12', glyph: 'h-5 w-5' },
}

// Border + ring colour inherits from the section's foreground via
// `border-current` so the same widget reads correctly on obsidian
// (ivory text → ivory ring) and on ivory (obsidian text → obsidian
// ring). Opacity steps give the resting/hover delta without locking
// the widget to copper.
const SHAPE_CLASS: Record<SocialIconsData['shape'], string> = {
  circle: 'rounded-full border border-current/30 hover:border-current/70',
  square: 'rounded-md border border-current/30 hover:border-current/70',
  naked: 'rounded-none',
}

const ALIGN_CLASS: Record<SocialIconsData['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

export function SocialIcons({
  data,
  outerClass,
}: {
  data: SocialIconsData
  outerClass?: string
}) {
  if (data.items.length === 0) return null
  const sizeClasses = SIZE_CLASS[data.size]
  const shapeClass = SHAPE_CLASS[data.shape]
  const alignClass = ALIGN_CLASS[data.alignment]

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      <ul
        className={clsx(
          'flex flex-wrap items-center gap-4 sm:gap-5',
          alignClass,
        )}
      >
        {data.items.map((item, i) => {
          const name = PLATFORM_NAME[item.platform]
          return (
            // Key combines index + url so two same-platform entries
            // (rare but legal — e.g. operator with two IG handles)
            // don't share a React key.
            <li key={`${i}-${item.url}`}>
              <a
                href={item.url}
                // new_window defaults to true at the Zod boundary,
                // so legacy rows without the field still open in a
                // new tab. Same-tab links drop the security rel
                // hints (they only apply to noopener-relevant
                // window.opener contexts).
                target={item.new_window ? '_blank' : undefined}
                rel={item.new_window ? 'noopener noreferrer nofollow' : 'nofollow'}
                aria-label={name}
                title={name}
                className={clsx(
                  'inline-flex items-center justify-center text-current opacity-80 transition-colors duration-standard ease-standard hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40 motion-reduce:transition-none',
                  sizeClasses.wrap,
                  shapeClass,
                )}
              >
                {/* Glyph is rendered as a CSS mask layer, NOT an <img>.
                    Reason: simple-icons SVGs ship without an explicit
                    fill attribute (defaults to black), and <img> elements
                    treat the SVG as opaque image bytes — CSS `fill` /
                    `color` can't reach into them. Mask-image + bg-current
                    paints the silhouette with the element's currentColor
                    instead, so the icon inherits the section's foreground
                    (ivory on obsidian, obsidian on ivory) automatically.
                    The same SVG files we ship under /icons/social/ work
                    as masks unchanged. */}
                <span
                  aria-hidden="true"
                  className={clsx(sizeClasses.glyph, 'bg-current')}
                  style={{
                    WebkitMaskImage: `url(/icons/social/${item.platform}.svg)`,
                    maskImage: `url(/icons/social/${item.platform}.svg)`,
                    WebkitMaskRepeat: 'no-repeat',
                    maskRepeat: 'no-repeat',
                    WebkitMaskPosition: 'center',
                    maskPosition: 'center',
                    WebkitMaskSize: 'contain',
                    maskSize: 'contain',
                  }}
                />
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
