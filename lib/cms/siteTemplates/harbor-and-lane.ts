import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  ctaBanner,
  hero,
  heroCover,
  imagePair,
  oneCol,
  statRow,
  threeColCards,
} from './_shared'

// Harbor & Lane — modern boutique real-estate brokerage.
// 5 pages: Home, Listings, Agents, Neighborhoods, Contact.
//
// Voice: confident, careful, fluent. Avoids the broker clichés
// ("dream home", "unparalleled luxury"). Sentences are short. Numbers
// read like a quiet ledger.

export const harborAndLaneTemplate: SiteTemplate = {
  slug: 'harbor-and-lane',
  name: 'Harbor & Lane',
  kind: 'Real estate',
  tagline: 'Homes that hold a life.',
  description:
    'A modern boutique brokerage. Listings, agents, neighborhood guides, and a careful Contact page. Built for brokers who write their own copy.',
  vibe: 'realestate',
  themePalette: {
    bg: '#f5f1ea',
    fg: '#0e0e0c',
    accent: '#7a8a6a',
    muted: '#857e72',
  },
  branding: {
    brandText: 'Harbor & Lane',
    headerTheme: 'ivory',
    primaryNav: [
      { label: 'Listings', href: '/listings' },
      { label: 'Agents', href: '/agents' },
      { label: 'Neighborhoods', href: '/neighborhoods' },
      { label: 'Contact', href: '/contact' },
    ],
    primaryCta: { text: 'Talk with an agent', href: '/contact' },
    footerColumns: [
      {
        label: 'Find',
        links: [
          { text: 'Listings', href: '/listings' },
          { text: 'Neighborhoods', href: '/neighborhoods' },
        ],
      },
      {
        label: 'People',
        links: [
          { text: 'Our agents', href: '/agents' },
          { text: 'Contact us', href: '/contact' },
        ],
      },
    ],
    footerTagline: 'Homes that hold a life.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Harbor & Lane',
      isHome: true,
      seoTitle: 'Harbor & Lane — Homes that hold a life',
      seoDescription:
        'A modern boutique brokerage. Twelve agents, four neighborhoods, a hundred and forty closings a year.',
      sections: [
        heroCover({
          imageKey: 'home-hero-house',
          alt: 'A modern home with warm interior light glowing through floor-to-ceiling windows at golden hour.',
          eyebrow: 'Harbor & Lane',
          title: 'Homes that hold a life.',
          body: 'A boutique brokerage of twelve agents working four neighborhoods. We close about a hundred and forty homes a year, and we know each one of them by name.',
          cta: { label: 'See listings', href: '/listings' },
          minHeight: 'xl',
        }),

        ...threeColCards({
          background: 'cream',
          sectionTitle: 'What we do, in three sentences',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'For buyers',
              title: 'A short list, carefully made',
              body: 'We learn the shape of your life — work, school, weekends — and bring you four or five homes a week. Not forty. Five.',
              cta: { label: 'How we work with buyers', href: '/agents' },
            },
            {
              kicker: 'For sellers',
              title: 'A real price, set together',
              body: 'We walk the home with you, name a number we believe, and explain how we got there. Then we hold the line until the right offer arrives.',
              cta: { label: 'How we work with sellers', href: '/agents' },
            },
            {
              kicker: 'For both',
              title: 'A team that does this once',
              body: 'Twelve agents, full-time, all of them. No part-timers, no out-of-town franchisees, no leads sold off to call centres.',
              cta: { label: 'About the firm', href: '/agents' },
            },
          ],
        }),

        statRow({
          background: 'obsidian',
          stats: [
            { value: 142, label: 'closings last year' },
            { value: 12, label: 'agents' },
            { value: 4, label: 'neighborhoods' },
          ],
        }),

        // Sample listings
        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'A few of our current listings',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '$1,840,000 · Harbor Hill',
              title: '14 Linden Walk',
              body: 'Four bedrooms, three baths, a south-facing garden, original cornices restored. Open house Saturday from one until three.',
              cta: { label: 'View the listing', href: '/listings' },
            },
            {
              kicker: '$960,000 · The Lane',
              title: '212 Sycamore Street',
              body: 'A semi-detached on a leafy block. Three bedrooms, a garage, a basement that wants to become a studio. Co-listed with the seller.',
              cta: { label: 'View the listing', href: '/listings' },
            },
            {
              kicker: '$2,650,000 · Marina',
              title: 'The Cooperage, Unit 4',
              body: 'A loft conversion of a former cooperage. Two bedrooms, a kitchen island that seats six, original beams. Showings by appointment.',
              cta: { label: 'View the listing', href: '/listings' },
            },
          ],
        }),

        // Pair: street + pool — the lived-in neighborhood and the
        // outdoor magic, side by side.
        oneCol(
          'cream',
          'lg',
          imagePair({
            leftImageKey: 'home-neighborhood',
            leftAlt: 'A quiet tree-lined residential street with brick brownstones, sunlight filtering through the canopy.',
            rightImageKey: 'listings-outdoor',
            rightAlt: 'A wooden deck beside a still swimming pool at dusk, warm ambient lighting from the house behind.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'cream',
          text: '"They drove me past three homes in one afternoon and one of them was mine. We closed nine days later."',
          attribution: 'M. Reyes, bought at Harbor Hill, 2024',
        }),
      ],
    },

    // ─── LISTINGS ─────────────────────────────────────────────────
    {
      slug: 'listings',
      title: 'Listings',
      seoTitle: 'Listings — Harbor & Lane',
      seoDescription:
        'Our active listings across Harbor Hill, the Lane, the Marina, and the Old Town.',
      sections: [
        heroCover({
          imageKey: 'listings-hero',
          alt: 'A contemporary two-story home with clean lines and large glass panels — the kind we list at Harbor Hill.',
          eyebrow: 'Active listings',
          title: 'On the market now.',
          body: 'A short list, refreshed every Monday. Open houses on Saturdays from one until three unless otherwise noted.',
          minHeight: 'xl',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: '$1,840,000 · Harbor Hill',
              title: '14 Linden Walk',
              body: 'Four bedrooms, three baths, a south-facing garden, original cornices. 2,840 sq ft. Listed by Adaeze Okonkwo.',
            },
            {
              kicker: '$960,000 · The Lane',
              title: '212 Sycamore Street',
              body: 'Semi-detached, three bedrooms, garage, basement. 1,620 sq ft above grade. Listed by Henrik Vassallo.',
            },
            {
              kicker: '$2,650,000 · Marina',
              title: 'The Cooperage, Unit 4',
              body: 'Two bedrooms, loft conversion, original beams. 1,940 sq ft. Listed by June Park.',
            },
            {
              kicker: '$1,200,000 · Old Town',
              title: '8 Carrick Mews',
              body: 'Mews house, two bedrooms, two studies. A small garden with an old fig tree. 1,460 sq ft. Listed by Adaeze Okonkwo.',
            },
            {
              kicker: '$720,000 · The Lane',
              title: '47 Bramble Avenue',
              body: 'Top-floor flat, two bedrooms, a working fireplace, river-side views. 980 sq ft. Listed by Henrik Vassallo.',
            },
            {
              kicker: '$3,200,000 · Harbor Hill',
              title: '6 Westgate Place',
              body: 'A double-fronted Victorian, five bedrooms, a coach house at the back. 4,120 sq ft on a quarter-acre lot. Listed by June Park.',
            },
          ],
        }),

        // Pair: kitchen + bedroom — interior moments of two listings
        // side-by-side. Restrained palette common to both.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'listings-interior-1',
            leftAlt: 'An open-concept kitchen with a marble centre island and abundant natural daylight.',
            rightImageKey: 'listings-interior-2',
            rightAlt: 'A restrained primary bedroom with neutral linens facing a window onto a quiet city view.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'Looking for something specific?',
          body: 'Tell us the shape of what you want — neighborhood, budget, the things you cannot live without — and we will keep watch.',
          cta: { label: 'Send a brief', href: '/contact' },
        }),
      ],
    },

    // ─── AGENTS ───────────────────────────────────────────────────
    {
      slug: 'agents',
      title: 'Agents',
      seoTitle: 'Agents — Harbor & Lane',
      seoDescription:
        'Twelve agents, full-time, working four neighborhoods. Each one writes their own listings.',
      sections: [
        heroCover({
          imageKey: 'agents-office',
          alt: 'The Harbor & Lane office — a warm boutique interior with wooden desks and tall plants in afternoon light.',
          eyebrow: 'The agents',
          title: 'Twelve people, full-time.',
          body: 'Every agent at Harbor & Lane is full-time, by license, working out of one of our four neighborhood offices. No leads are sold off, no listings handed to junior staff.',
          minHeight: 'xl',
        }),

        // Pair: two agent portraits — establishes the team's presence
        // before the bio cards below.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'agents-portrait-1',
            leftAlt: 'Editorial portrait of one of the Harbor & Lane agents in soft natural light.',
            rightImageKey: 'agents-portrait-2',
            rightAlt: 'Editorial portrait of another Harbor & Lane agent in warm daylight.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Harbor Hill',
              title: 'Adaeze Okonkwo',
              body: 'Eleven years with us. Specialises in restorations — knew the cornice plasterers in three of the listings she closed this year.',
            },
            {
              kicker: 'The Lane',
              title: 'Henrik Vassallo',
              body: 'Eight years with us. Writes the neighborhood guide for the Lane and has lived there since 2011. Sells more semi-detacheds than anyone in the firm.',
            },
            {
              kicker: 'Marina',
              title: 'June Park',
              body: 'Six years with us. Came from the architecture side — knows which lofts have the bones to keep and which ones to walk away from.',
            },
            {
              kicker: 'Old Town',
              title: 'Mira Whitfield',
              body: 'Fourteen years with us. The Old Town specialist. Has placed three of the same family across two generations of homes.',
            },
            {
              kicker: 'Harbor Hill',
              title: 'Sam Iqbal',
              body: 'Five years with us. Quiet, careful, the agent we put on first-time buyers. Closed twenty-one homes last year for under a million.',
            },
            {
              kicker: 'Across the firm',
              title: 'And seven more.',
              body: 'The full list with photos, biographies, and licences is on each neighborhood page. Or call us and we will introduce you to whoever fits the brief.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Who should you talk to?',
          body: 'Tell us a little about what you are looking for, and we will route you to the right agent the same day.',
          cta: { label: 'Get an introduction', href: '/contact' },
        }),
      ],
    },

    // ─── NEIGHBORHOODS ────────────────────────────────────────────
    {
      slug: 'neighborhoods',
      title: 'Neighborhoods',
      seoTitle: 'Neighborhoods — Harbor & Lane',
      seoDescription:
        'Harbor Hill, the Lane, the Marina, the Old Town. Four small guides to the four places we work.',
      sections: [
        hero({
          background: 'ivory',
          eyebrow: 'Where we work',
          title: 'Four small places.',
          body: 'We work in four neighborhoods only. Each guide is written by the agent who lives there.',
          tone: 'obsidian',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Harbor Hill',
              title: 'Trees, terraces, and the school',
              body: 'The quiet hill above the harbor. Mostly Victorian terraces, a primary school at the top, a bakery on Linden Walk that opens at half past six.',
              cta: { label: 'Read the guide', href: '/neighborhoods#harbor-hill' },
            },
            {
              kicker: 'The Lane',
              title: 'Cafés, semi-detacheds, the river',
              body: 'A walkable mile of independent shops. Semi-detached homes on tree-lined blocks. The Friday market by the river bridge.',
              cta: { label: 'Read the guide', href: '/neighborhoods#the-lane' },
            },
            {
              kicker: 'Marina',
              title: 'Lofts, the water, the wind',
              body: 'A converted warehouse district. Loft apartments, two restaurants worth the trip, a long footpath along the working harbor.',
              cta: { label: 'Read the guide', href: '/neighborhoods#marina' },
            },
            {
              kicker: 'Old Town',
              title: 'Mews, courtyards, the cathedral',
              body: 'The original city. Cobbled streets, mews houses, courtyards that open onto courtyards. Quiet at night, busy by ten.',
              cta: { label: 'Read the guide', href: '/neighborhoods#old-town' },
            },
            {
              kicker: 'Coming soon',
              title: 'A fifth?',
              body: 'We are slow about adding neighborhoods. The next one is likely to be South Quay, but only when one of our agents has lived there a year.',
            },
            {
              kicker: 'On request',
              title: 'A custom area report',
              body: 'For families relocating, we will write a tailored guide on any area we know — schools, commute times, weekend patterns, the lot.',
            },
          ],
        }),

        // Pair: cafe + park — two everyday textures of the
        // neighborhoods we work, anchoring the abstract guides above.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'neighborhoods-cafe',
            leftAlt: 'A charming neighborhood cafe exterior with a wooden bench out front and a chalkboard sign on the sidewalk.',
            rightImageKey: 'neighborhoods-park',
            rightAlt: 'A grassy community park with mature trees and a curving walking path catching late afternoon light.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'cream',
          text: '"They knew which side of the street got the morning light. They knew which neighbour was the loud one. They knew it because they lived two doors down."',
          attribution: 'D. Anwar, bought on the Lane, 2023',
        }),
      ],
    },

    // ─── CONTACT ──────────────────────────────────────────────────
    {
      slug: 'contact',
      title: 'Contact',
      seoTitle: 'Contact — Harbor & Lane',
      seoDescription:
        'Talk with an agent. We answer every enquiry within one business day.',
      sections: [
        heroCover({
          imageKey: 'contact-reception',
          alt: 'The Harbor & Lane reception desk — marble and warm wood, soft overhead lighting.',
          eyebrow: 'Talk with an agent',
          title: 'Tell us what you are looking for.',
          body: 'Buying, selling, or somewhere in between. We will route you to the right agent the same day, by name, by neighborhood, by the shape of what you want.',
          minHeight: 'xl',
        }),

        contactChannels({
          background: 'ivory',
          email: {
            value: 'hello@harborandlane.example',
            href: 'mailto:hello@harborandlane.example',
            description: 'Answered within one business day.',
          },
          phone: {
            value: '+1 415 555 0140',
            href: 'tel:+14155550140',
            description: 'Monday to Friday, nine to six.',
          },
          address: {
            value: '88 Linden Walk, Harbor Hill',
            description: 'Or visit one of our four neighborhood offices.',
          },
        }),

        oneCol(
          'ivory',
          'md',
          contactForm({
            heading: 'Send us a brief.',
            intro:
              'Neighborhood, budget, the kind of home, and any deadline we should know about. The shorter the brief, the faster the reply.',
            submitLabel: 'Send brief',
            successHeadline: 'Thank you — we have your brief.',
            successBody:
              'An agent who matches the brief will reply by email within one business day.',
          }),
        ),
      ],
    },
  ],
}

