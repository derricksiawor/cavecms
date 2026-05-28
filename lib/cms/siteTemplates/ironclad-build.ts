import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  ctaBanner,
  figure,
  hero,
  heroCover,
  imagePair,
  oneCol,
  statRow,
  threeColCards,
} from './_shared'

// Ironclad Build — boutique construction contractor.
// 5 pages: Home, Services, Projects, About, Quote.
// Voice: confident, builders' restraint. Specifics over adjectives.

export const ironcladBuildTemplate: SiteTemplate = {
  slug: 'ironclad-build',
  name: 'Ironclad Build',
  kind: 'Construction',
  tagline: 'Done. Properly.',
  description:
    'A confident contractor site. Services, project portfolio, the team, and a real quote-request form. Built for builders who finish what they start.',
  vibe: 'construction',
  themePalette: {
    bg: '#10141a',
    fg: '#eaefef',
    accent: '#d97a3c',
    muted: '#7a8090',
  },
  branding: {
    brandText: 'Ironclad Build',
    headerTheme: 'obsidian',
    primaryNav: [
      { label: 'Services', href: '/services' },
      { label: 'Projects', href: '/projects' },
      { label: 'About', href: '/about' },
      { label: 'Request a quote', href: '/quote' },
    ],
    primaryCta: { text: 'Request a quote', href: '/quote' },
    footerColumns: [
      {
        label: 'Work',
        links: [
          { text: 'Services', href: '/services' },
          { text: 'Projects', href: '/projects' },
        ],
      },
      {
        label: 'Firm',
        links: [
          { text: 'About us', href: '/about' },
          { text: 'Request a quote', href: '/quote' },
        ],
      },
    ],
    footerTagline: 'Done. Properly.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Ironclad Build',
      isHome: true,
      seoTitle: 'Ironclad Build — Done. Properly.',
      seoDescription:
        'A boutique general contractor. Whole-home renovations, additions, ground-up builds. Two crews, twenty-eight years.',
      sections: [
        heroCover({
          imageKey: 'home-hero-site',
          alt: 'Construction crew silhouettes against a warm dusk sky with steel scaffolding framing the worksite.',
          eyebrow: 'Ironclad Build',
          title: 'Done. Properly.',
          body: 'A boutique general contractor of two crews and a project manager who answers his phone. Whole-home renovations, additions, ground-up builds. Twenty-eight years in business, every job on the schedule we promised.',
          cta: { label: 'Request a quote', href: '/quote' },
          minHeight: 'xl',
        }),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'What we build',
          sectionBody:
            'Three shapes of work, all of them with the same crews, same standards, same insurance.',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'Whole-home renovations',
              title: 'Down to the studs',
              body: 'Strip, re-plumb, re-wire, re-frame as needed, finish. The kind of job that takes four to seven months and asks you to move out for two.',
              cta: { label: 'See the renovation projects', href: '/projects' },
            },
            {
              kicker: 'Additions',
              title: 'A new wing, a new floor',
              body: 'Tying old to new without it looking like an addition. Permits, structural, finishes — we run all of it.',
              cta: { label: 'See the addition projects', href: '/projects' },
            },
            {
              kicker: 'Ground-up builds',
              title: 'A house, from a lot',
              body: 'Two to three per year. Working with an architect of your choice, or we will recommend one. Eighteen months from groundbreak to handover, typically.',
              cta: { label: 'See the new-builds', href: '/projects' },
            },
          ],
        }),

        // Craftsmanship figure — hands at work, sets the tone of
        // who's actually doing the building.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'home-craftsmanship',
            alt: 'Close-up of a carpenter\'s weathered hands planing a piece of timber on a workbench.',
            ratio: '16:9',
            caption: 'Our crews are full-time and full-strength — no part-timers.',
            animation: 'fade-in',
          }),
        ),

        statRow({
          background: 'near-black',
          stats: [
            { value: 28, label: 'years in business' },
            { value: 240, label: 'projects completed' },
            { value: 100, suffix: '%', label: 'finished on schedule', decimals: 0 },
          ],
        }),

        closingQuote({
          background: 'cream',
          text: '"They told us the kitchen would be done by August fifteenth. The painter cleaned his brushes on August fourteenth."',
          attribution: 'R. & T. Bauer, whole-home renovation, 2023',
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Ready for a real quote?',
          body: 'Tell us about the project. A site visit follows within ten business days, free, no obligation.',
          cta: { label: 'Request a quote', href: '/quote' },
        }),
      ],
    },

    // ─── SERVICES ─────────────────────────────────────────────────
    {
      slug: 'services',
      title: 'Services',
      seoTitle: 'Services — Ironclad Build',
      seoDescription:
        'Whole-home renovations, additions, ground-up builds, kitchen and bath, and the small specialty work that holds the rest together.',
      sections: [
        heroCover({
          imageKey: 'services-commercial',
          alt: 'A completed modern commercial building exterior at dusk — clean lines of steel, glass, and concrete catching the last warm light.',
          eyebrow: 'Services',
          title: 'What the crews do.',
          body: 'Two crews, one of them led by Mateo Vega (twenty-two years with the firm), the other by Lara Bishop (eleven). Both are general contractors with the full insurance and bonds. Same shape of work, same standards.',
          minHeight: 'xl',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Whole-home',
              title: 'Full renovation',
              body: 'Strip-to-studs, re-plumb, re-wire, re-frame, re-insulate, finish. Four to seven months. We coordinate engineer, architect (yours or ours), permits, and finishes.',
            },
            {
              kicker: 'Additions',
              title: 'New square footage',
              body: 'Side, back, or up. Tying new structure to old without seams. Foundations, framing, MEP, exterior to match. Two to four months once permits are in hand.',
            },
            {
              kicker: 'Ground-up',
              title: 'A new house',
              body: 'A lot becomes a home. We run permits, demolition, foundation, framing, MEP, finishes. Eighteen months end-to-end on a typical 3,000 sq ft custom build.',
            },
            {
              kicker: 'Kitchen + bath',
              title: 'Targeted renovation',
              body: 'Two to six weeks. Cabinetry from our shop or yours. Tile, stone, plumbing fixtures, lighting — all sourced and installed by our crews.',
            },
            {
              kicker: 'Specialty',
              title: 'The small jobs that hold the rest',
              body: 'Heritage millwork. Cornice restoration. Slate roof repair. Custom built-ins. The work that needs hands that have done it before.',
            },
            {
              kicker: 'Consult',
              title: 'A second opinion',
              body: 'A walk-through and a written assessment for a fixed fee, often used before a sale, a purchase, or a major decision. No upsell, no follow-on pitch.',
            },
          ],
        }),

        // Pair: a residential staircase + a restored heritage beam.
        // Two of the visual moods of the services list, anchored to
        // the cards above.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'services-residential',
            leftAlt: 'A newly finished hardwood staircase beside a freshly framed window catching afternoon light.',
            rightImageKey: 'services-restoration',
            rightAlt: 'Detail of a refinished heritage timber beam meeting carefully repointed brick.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'Which crew, when?',
          body: 'Mateo’s crew is booking projects starting late spring. Lara’s crew has an opening this autumn. Tell us about the project.',
          cta: { label: 'Request a quote', href: '/quote' },
        }),
      ],
    },

    // ─── PROJECTS ─────────────────────────────────────────────────
    {
      slug: 'projects',
      title: 'Projects',
      seoTitle: 'Projects — Ironclad Build',
      seoDescription:
        'Selected projects from twenty-eight years of building. Whole-home renovations, additions, new builds.',
      sections: [
        heroCover({
          imageKey: 'projects-progress',
          alt: 'A work-in-progress build with exposed wood framing, partial roof structure and a crane silhouette in the background.',
          eyebrow: 'Selected projects',
          title: 'A few we are proud of.',
          body: 'Twenty-eight years of work, two hundred and forty projects. Six we keep coming back to.',
          minHeight: 'xl',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: '2023 · Bauer renovation',
              title: 'A 1912 row house, restored',
              body: 'Whole-home. Stripped to brick. Re-plumbed, re-wired, re-insulated. Original mouldings copied where they were missing. Twenty-two weeks.',
            },
            {
              kicker: '2022 · The Chapel addition',
              title: 'A side wing on a former chapel',
              body: 'A two-storey addition tying into a converted nineteenth-century chapel. Steel framing into the original stone. Twelve weeks.',
            },
            {
              kicker: '2022 · Linden ground-up',
              title: 'A new house on a tight lot',
              body: 'Three storeys, four bedrooms, on a thirty-foot-wide lot. Tucked between two older neighbours without overshadowing either. Sixty-eight weeks.',
            },
            {
              kicker: '2021 · Cooper kitchen',
              title: 'A working chef’s kitchen at home',
              body: 'A targeted kitchen renovation for a restaurant chef. Commercial-grade venting, two ovens, a cold prep island. Five weeks.',
            },
            {
              kicker: '2020 · The Hardy barn',
              title: 'A barn made a house',
              body: 'A 1880s barn turned into a four-bedroom home. We kept every original beam we could and replaced only the ones the engineer red-tagged. Eight months.',
            },
            {
              kicker: '2019 · The Westgate restoration',
              title: 'A Victorian, made habitable again',
              body: 'A 4,000 sq ft Victorian that had been empty for nine years. Roof, foundation, structure, finishes. Eleven months, on schedule.',
            },
          ],
        }),

        closingQuote({
          background: 'cream',
          text: '"They left the site cleaner than they found the kitchen. I asked the foreman who had cleaned the wall — he had."',
          attribution: 'L. Hardy, barn-to-house, 2020',
        }),
      ],
    },

    // ─── ABOUT ────────────────────────────────────────────────────
    {
      slug: 'about',
      title: 'About',
      seoTitle: 'About — Ironclad Build',
      seoDescription:
        'Twenty-eight years, two crews, one office. Full insurance, full bonds, and a project manager who picks up his phone.',
      sections: [
        oneCol(
          'cream',
          'sm',
          figure({
            imageKey: 'team-foreman',
            alt: 'Documentary-style portrait of a foreman in work jacket and hard hat, on site.',
            ratio: '21:9',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'About the firm',
          title: 'Two crews. One office. Twenty-eight years.',
          body: 'Founded in 1998 by Anders Iversen, now run as a partnership of three with Mateo Vega and Lara Bishop. Both crews are full-time. The office is small — a project manager, a bookkeeper, an apprentice.',
          tone: 'obsidian',
        }),

        // Pair: tool wall + the work truck. The everyday objects
        // behind the firm.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'team-tools',
            leftAlt: 'An organised craftsman\'s tool wall above a heavy workbench — hammers, chisels and hand planes in neat rows.',
            rightImageKey: 'about-fleet',
            rightAlt: 'A close-up of a clean work truck parked at a worksite at first light, ladders and material racks loaded on the back.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Materials yard — the raw stock the work begins with.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'about-materials',
            alt: 'A stack of fresh-cut dimensional lumber in a materials yard, end grain visible, soft morning light.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'The firm',
              title: 'Insurance, bonds, certifications',
              body: 'General contractor licence, current. $5M general liability. Performance bonds available on request. Lead-safe certified, asbestos-licensed for removal up to Class III.',
            },
            {
              kicker: 'The crews',
              title: 'Mateo’s and Lara’s',
              body: 'Six tradespeople per crew, full-time, year-round. No subcontracting of structural, plumbing, or electrical — we do those in-house. Tile, paint, and finishes are subbed to crews we have used for a decade.',
            },
            {
              kicker: 'The promise',
              title: 'Schedule, price, finish',
              body: 'A written schedule before the work begins. A fixed price (not "cost plus") wherever we can hold it. A finish you walk through with us, room by room, before the final invoice.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Ready to talk?',
          body: 'A site visit takes about an hour, costs nothing, and produces a written brief within ten business days.',
          cta: { label: 'Request a quote', href: '/quote' },
        }),
      ],
    },

    // ─── QUOTE ────────────────────────────────────────────────────
    {
      slug: 'quote',
      title: 'Request a quote',
      seoTitle: 'Request a quote — Ironclad Build',
      seoDescription:
        'Tell us about the project. We will visit within ten business days and send you a written brief.',
      sections: [
        heroCover({
          imageKey: 'contact-blueprint',
          alt: 'Architectural blueprints unrolled on a drafting table beside drafting tools.',
          eyebrow: 'Quote request',
          title: 'Tell us about the project.',
          body: 'Shape of the work, address, what you know about the budget, and any deadline. We will visit within ten business days, walk the site with you, and send a written brief within five days of the visit.',
          minHeight: 'xl',
        }),

        // Certifications inspection figure — the quality-control moment.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'certifications-inspection',
            alt: 'A spirit level and measuring tape laid across a freshly installed structural beam during a quality inspection.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'quote@ironcladbuild.example',
            href: 'mailto:quote@ironcladbuild.example',
            description: 'Reviewed by the project manager every morning.',
          },
          phone: {
            value: '+1 503 555 0118',
            href: 'tel:+15035550118',
            description: 'Direct line to the project manager.',
          },
          address: {
            value: '142 Foundry Lane, Portland',
            description: 'Office hours Monday to Friday, eight to four.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Send us the project',
            intro:
              'Two paragraphs is enough. We will come back with a schedule for the site visit.',
            submitLabel: 'Send quote request',
            successHeadline: 'Got it — we have the request.',
            successBody:
              'The project manager will reply by email within one business day to schedule the site visit.',
          }),
        ),
      ],
    },
  ],
}
