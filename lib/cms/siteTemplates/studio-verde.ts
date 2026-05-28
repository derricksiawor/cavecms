import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  coverImage,
  ctaBanner,
  figure,
  hero,
  imagePair,
  oneCol,
  threeColCards,
} from './_shared'

// Studio Verde — design studio portfolio.
// 5 pages: Home, Work, Process, About, Contact.
// Voice: confident, considered, plain. Avoids studio clichés
// ("award-winning", "passionate"). Talks about actual work.

export const studioVerdeTemplate: SiteTemplate = {
  slug: 'studio-verde',
  name: 'Studio Verde',
  kind: 'Design studio',
  tagline: 'Brands that move people.',
  description:
    'A creative studio portfolio template. Case studies, process, the team, contact. Built for studios that let the work do most of the talking.',
  vibe: 'freelance',
  themePalette: {
    bg: '#0d0e0d',
    fg: '#eef0ec',
    accent: '#a8c97a',
    muted: '#7f8278',
  },
  branding: {
    brandText: 'Studio Verde',
    headerTheme: 'obsidian',
    primaryNav: [
      { label: 'Work', href: '/work' },
      { label: 'Process', href: '/process' },
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
    ],
    primaryCta: { text: 'Start a project', href: '/contact' },
    footerColumns: [
      {
        label: 'Studio',
        links: [
          { text: 'Work', href: '/work' },
          { text: 'Process', href: '/process' },
        ],
      },
      {
        label: 'Talk',
        links: [
          { text: 'About', href: '/about' },
          { text: 'Contact', href: '/contact' },
        ],
      },
    ],
    footerTagline: 'Brands that move people.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Studio Verde',
      isHome: true,
      seoTitle: 'Studio Verde — Brands that move people',
      seoDescription:
        'A six-person design studio. Brand systems, websites, packaging. Eleven years, ninety-four clients.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'home-hero-workspace',
            alt: 'A sun-streaked Studio Verde workspace with design tools, sketches, and references spread across a wooden worktable.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Studio Verde',
          title: 'Brands that move people.',
          body: 'A six-person studio working in three rooms above a bookshop. We build brand systems, websites, and packaging — usually all three for the same client. Eleven years, ninety-four projects.',
          cta: { label: 'See our work', href: '/work' },
          secondaryCta: { label: 'How we work', href: '/process' },
        }),

        ...threeColCards({
          background: 'cream',
          sectionTitle: 'What we make',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'Brand systems',
              title: 'Identity, voice, the rules of use',
              body: 'Wordmarks, type systems, colour, photography, voice. A real book of rules at the end, not a five-slide deck.',
              cta: { label: 'Brand projects', href: '/work#brand' },
            },
            {
              kicker: 'Websites',
              title: 'Designed and built',
              body: 'We design the site and we build it. No throwing it over the wall to a dev shop. Most ship in six to ten weeks.',
              cta: { label: 'Website projects', href: '/work#websites' },
            },
            {
              kicker: 'Packaging',
              title: 'On press, in hand',
              body: 'Cartons, bottles, labels, boxes. We do the prepress, sign off the printer, and ride the first run.',
              cta: { label: 'Packaging projects', href: '/work#packaging' },
            },
          ],
        }),

        // Selected work
        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'A few projects from the last two years',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'Brand · 2024',
              title: 'Marshia Coffee',
              body: 'A specialty-coffee brand identity. Wordmark, type system, packaging across nine SKUs. Now in three cities.',
            },
            {
              kicker: 'Website · 2024',
              title: 'Northwind Architects',
              body: 'A practice website for a seventy-person architecture firm. Twelve projects per page, weighty editorial typography.',
            },
            {
              kicker: 'Packaging · 2023',
              title: 'Briar & Reed Skincare',
              body: 'Identity and packaging for a clean-skincare brand. Twenty-two SKUs at launch, retail in Whole Foods within four months.',
            },
            {
              kicker: 'Brand · 2023',
              title: 'Hill Family Wine',
              body: 'A second-generation winery’s rebrand. Wordmark, label system across four wines, three vintages.',
            },
            {
              kicker: 'Website · 2023',
              title: 'Lumen Schools',
              body: 'A network of charter schools. A 240-page site with custom CMS, parent portal, six languages.',
            },
            {
              kicker: 'Brand + web · 2022',
              title: 'Foxtrot Yacht Club',
              body: 'Identity, website, and a print magazine. A members-only sailing club founded in 1947, refreshing for the third time.',
            },
          ],
        }),

        // Team-at-work figure — the studio in motion.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'home-team-working',
            alt: 'Over-the-shoulder view of designers at their desks in a warm, naturally lit studio.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'cream',
          text: '"They asked us harder questions than we knew the answers to. By the end we had a brand because we had a clearer company."',
          attribution: 'D. Hill, founder, Hill Family Wine',
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Working on something this year?',
          body: 'We take on one new project per month. Send us a note about what you are building.',
          cta: { label: 'Start a project', href: '/contact' },
        }),
      ],
    },

    // ─── WORK ─────────────────────────────────────────────────────
    {
      slug: 'work',
      title: 'Work',
      seoTitle: 'Work — Studio Verde',
      seoDescription:
        'Selected work from Studio Verde — brand systems, websites, packaging.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'work-case-1',
            alt: 'A branding identity system spread on a worktable — stationery mockups, colour cards, and printed collateral.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Selected work',
          title: 'A small portfolio, carefully kept.',
          body: 'Twelve projects, of the ninety-four we have done. Picked because they show what we do at the studio’s best.',
        }),

        // Pair: packaging + editorial — two case-study textures.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'work-case-2',
            leftAlt: 'Minimalist packaging design in soft earth tones photographed on a neutral textured surface.',
            rightImageKey: 'work-case-3',
            rightAlt: 'An open editorial magazine spread showing considered typography and generous white space.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Digital interface mockup — the third leg of the studio's
        // three-discipline practice (brand / web / packaging).
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'work-case-4',
            alt: 'A digital interface mockup displayed on a screen with clean layouts and a muted colour palette.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Marshia Coffee · 2024',
              title: 'A specialty coffee brand',
              body: 'Wordmark, type system, packaging across nine SKUs, in-store signage. Marshia now operates three cafés across two cities.',
            },
            {
              kicker: 'Northwind Architects · 2024',
              title: 'A practice website',
              body: 'A 70-person architecture firm’s website. Editorial layout, twelve in-depth projects per page, four-week build.',
            },
            {
              kicker: 'Briar & Reed · 2023',
              title: 'A skincare line',
              body: 'Identity, packaging across 22 SKUs, packaging photography. Retail in Whole Foods within four months of launch.',
            },
            {
              kicker: 'Hill Family Wine · 2023',
              title: 'A winery rebrand',
              body: 'Second-generation rebrand of a family winery. Wordmark, label system, web presence, a print booklet for the wine club.',
            },
            {
              kicker: 'Lumen Schools · 2023',
              title: 'A schools network',
              body: 'A network of charter schools. 240-page website, six languages, parent portal, custom CMS, all designed and built in studio.',
            },
            {
              kicker: 'Foxtrot Yacht Club · 2022',
              title: 'A members-only club',
              body: 'Identity, website, and a quarterly magazine for a 1947 yacht club. Third rebrand in the club’s history, the first in twenty-six years.',
            },
            {
              kicker: 'Olea Olive Oil · 2022',
              title: 'A bottle and a label',
              body: 'A single-estate olive oil packaging project. Two label SKUs, one carton, one shelf-talker. Now sold in 280 stores.',
            },
            {
              kicker: 'Mercury Letters · 2021',
              title: 'A literary press',
              body: 'Identity and a new book-jacket system for a literary press. Twenty-four titles in the new system to date.',
            },
            {
              kicker: 'The Slow Loris · 2021',
              title: 'A children’s magazine',
              body: 'A quarterly children’s nature magazine. Logotype, page system, illustration commissioning, four issues in the new design.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Want to talk about your project?',
          body: 'A studio walkthrough takes about an hour. We will tell you whether we are the right fit.',
          cta: { label: 'Start a project', href: '/contact' },
        }),
      ],
    },

    // ─── PROCESS ──────────────────────────────────────────────────
    {
      slug: 'process',
      title: 'Process',
      seoTitle: 'Process — Studio Verde',
      seoDescription:
        'How a project moves through the studio. Five phases, written down.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'How we work',
          title: 'Five phases. Written down.',
          body: 'We have run versions of this process for eleven years. It is plain on purpose — clients should know what they have committed to before the first invoice.',
        }),

        // Process pair: sketching by hand + the collaboration wall.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'process-sketching',
            leftAlt: 'Close-up of hands sketching layout ideas on paper with markers and pencils scattered nearby.',
            rightImageKey: 'process-collaboration',
            rightAlt: 'A team collaboration wall with whiteboard sketches, sticky notes, and printed work pinned up.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Journal-detail figure between cards and closing quote —
        // a printed-page close-up, the considered output of process.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'journal-detail',
            alt: 'Close-up of an open art and design book showing tactile printed pages and considered typography.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Phase 1 · 1 week',
              title: 'Conversation',
              body: 'A free initial conversation. About the company, the work to be done, the brief, the budget, the deadline. We walk away if it is not a fit. Most of the time it is.',
            },
            {
              kicker: 'Phase 2 · 2 weeks',
              title: 'Research',
              body: 'Interviews — usually six to ten — with people inside and outside the company. A written summary, with quotes. The summary often surprises us, and sometimes it surprises the client.',
            },
            {
              kicker: 'Phase 3 · 4 weeks',
              title: 'Design',
              body: 'Two design directions, presented at the studio. The client picks one and we refine it. No more than three rounds of refinement, by design — more than that is a sign we did not listen well.',
            },
            {
              kicker: 'Phase 4 · 3–6 weeks',
              title: 'Build / produce',
              body: 'For brand projects, the book of rules and the asset kit. For websites, the build (in-studio). For packaging, the prepress and the press check.',
            },
            {
              kicker: 'Phase 5 · 2 weeks',
              title: 'Hand-over',
              body: 'A written handover document, a recorded walkthrough of the deliverables, and an invitation to come back for a quarterly refresh in nine months.',
            },
            {
              kicker: 'After phase 5',
              title: 'Quarterly refresh',
              body: 'A half-day check-in nine months out, included in the project price. We look at what is working, what is not, what to refresh.',
            },
          ],
        }),

        closingQuote({
          background: 'cream',
          text: '"They told us at the start that there would be three rounds and no more. The third round was the one we shipped. They were right."',
          attribution: 'A. Verma, founder, Marshia Coffee',
        }),
      ],
    },

    // ─── ABOUT ────────────────────────────────────────────────────
    {
      slug: 'about',
      title: 'About',
      seoTitle: 'About — Studio Verde',
      seoDescription:
        'Six people, three rooms above a bookshop, eleven years.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'team-founder',
            alt: 'A warm, considered portrait of a Studio Verde founder in soft natural light.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'About the studio',
          title: 'Six people. Three rooms. Eleven years.',
          body: 'Studio Verde was founded in 2014 by Esther Loomis and Tobias Greene. It has stayed deliberately small — there are six of us now, the same as in 2018. We work above a bookshop, and we keep one client meeting room with no screens.',
          tone: 'obsidian',
        }),

        // Studio detail figure — the considered objects in the room.
        oneCol(
          'ivory',
          'md',
          figure({
            imageKey: 'team-office-detail',
            alt: 'A moody studio interior detail with a leafy plant, framed prints, and a neat stack of design books.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Esther Loomis',
              title: 'Principal, brand',
              body: 'Founded the studio in 2014. Trained as a typographer, runs the brand-systems side. Teaches at the college on Mondays.',
            },
            {
              kicker: 'Tobias Greene',
              title: 'Principal, web',
              body: 'Founded the studio in 2014. Designs and codes. Built our internal tools, our website, and the Lumen Schools CMS.',
            },
            {
              kicker: 'Mira Acheampong',
              title: 'Senior designer',
              body: 'Joined in 2018. Brand systems and packaging. Led the Briar & Reed, Hill Family Wine, and Marshia projects.',
            },
            {
              kicker: 'Jorge Ramirez',
              title: 'Senior designer',
              body: 'Joined in 2019. Websites and editorial. Led the Northwind Architects and Lumen Schools projects.',
            },
            {
              kicker: 'Cara Whitfield',
              title: 'Designer',
              body: 'Joined in 2022. Generalist — brand, web, packaging. Came from a children’s book illustration background.',
            },
            {
              kicker: 'Felix Park',
              title: 'Studio manager',
              body: 'Joined in 2020. Runs the studio. Schedules, invoicing, the kitchen, the plants, the bookshop relationship downstairs.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Want to see the studio?',
          body: 'Walk-throughs are by appointment. We do them on Thursday mornings, when the studio is quietest.',
          cta: { label: 'Start a project', href: '/contact' },
        }),
      ],
    },

    // ─── CONTACT ──────────────────────────────────────────────────
    {
      slug: 'contact',
      title: 'Contact',
      seoTitle: 'Contact — Studio Verde',
      seoDescription:
        'Send us a note about your project. We take on one new project per month.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'contact-window',
            alt: 'Soft morning light streaming through a tall studio window with a city view in the distance.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Start a project',
          title: 'Tell us what you’re building.',
          body: 'We take on one new project per month. A note of two paragraphs is plenty — what the company does, what the project is, when you want to start, the budget if you have one. We answer every enquiry within one business day.',
        }),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'hello@studioverde.example',
            href: 'mailto:hello@studioverde.example',
            description: 'Answered within one business day.',
          },
          phone: {
            value: '+1 718 555 0124',
            href: 'tel:+17185550124',
            description: 'Felix at the studio, weekdays ten to five.',
          },
          address: {
            value: '14 Holloway Lane, Brooklyn',
            description: 'Above the Holloway Bookshop. Walk-throughs Thursday mornings.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Send us a brief.',
            intro:
              'Two paragraphs. Company, project, timing, budget. We will reply within one business day to say whether we are the right fit.',
            submitLabel: 'Send brief',
            successHeadline: 'Thank you — your brief is with us.',
            successBody:
              'Esther or Tobias will reply by email within one business day.',
          }),
        ),
      ],
    },
  ],
}
