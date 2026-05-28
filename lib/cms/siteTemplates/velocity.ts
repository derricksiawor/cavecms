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

// Velocity — modern engineering-operations SaaS.
// 5 pages: Home, Features, Pricing, Changelog, Docs.
// Voice: confident, technical, builder-to-builder. Avoids buzzwords.
// Visual language: obsidian + near-black dominant, copper/champagne
// accent through the eyebrows + primary CTAs. Heroes vary in
// alignment, ratio, and overlay so no two pages feel the same.

export const velocityTemplate: SiteTemplate = {
  slug: 'velocity',
  name: 'Velocity',
  kind: 'Software',
  tagline: 'Faster than yesterday.',
  description:
    'A modern engineering-operations SaaS template. Plan, ship, measure. Built for software teams who want a site that reads like a real tool, not a 2018 startup landing page.',
  vibe: 'software',
  themePalette: {
    bg: '#06080d',
    fg: '#f4f6fb',
    accent: '#7da6ff',
    muted: '#7d8597',
  },
  branding: {
    brandText: 'Velocity',
    headerTheme: 'obsidian',
    primaryNav: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Docs', href: '/docs' },
    ],
    primaryCta: { text: 'Start free', href: '/pricing' },
    footerColumns: [
      {
        label: 'Product',
        links: [
          { text: 'Features', href: '/features' },
          { text: 'Pricing', href: '/pricing' },
          { text: 'Changelog', href: '/changelog' },
        ],
      },
      {
        label: 'Build',
        links: [
          { text: 'Documentation', href: '/docs' },
          { text: 'API reference', href: '/docs#api' },
        ],
      },
    ],
    footerTagline: 'Faster than yesterday.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    // Centered hero, screen-tall, on a near-black PCB macro. The
    // CTA sits dead-center so the very first impression reads as a
    // confident tool, not a brochure. Overlay is 'darken' (not
    // 'gradient-bottom') so the circuit texture stays legible
    // behind the type.
    {
      slug: 'home',
      title: 'Velocity',
      isHome: true,
      seoTitle: 'Velocity — Faster than yesterday',
      seoDescription:
        'A modern engineering-operations platform. Plan, ship, measure. Built for teams that want fewer meetings.',
      sections: [
        heroCover({
          imageKey: 'home-hero-abstract',
          alt: 'Macro photograph of a printed circuit board lit from behind, with green conductive pathways glowing against deep black negative space.',
          eyebrow: 'Engineering operations',
          title: 'Faster than yesterday.',
          body: 'Plan, ship, and measure work in one tool. Fifty-eight integrations, a real CLI, an API that returns within ninety milliseconds. Built for teams that want fewer meetings and more deploys.',
          cta: { label: 'Start free', href: '/pricing' },
          overlayAlignment: 'center',
          overlay: 'darken',
          minHeight: 'screen',
          ratio: '16:9',
        }),

        ...threeColCards({
          background: 'near-black',
          sectionTitle: 'What teams use Velocity for',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'Plan',
              title: 'Cycles, not sprints',
              body: 'Two-week cycles, with the carry-over made obvious. A roadmap that shows what is shipping next quarter, not which Jira epic is largest.',
              cta: { label: 'See Plan in detail', href: '/features' },
            },
            {
              kicker: 'Ship',
              title: 'Deploys you can trust',
              body: 'A deploy view tied to the issue tied to the PR. Rollbacks in two clicks. Audit trail of who shipped what, when, and with whose review.',
              cta: { label: 'See Ship in detail', href: '/features' },
            },
            {
              kicker: 'Measure',
              title: 'The numbers that matter',
              body: 'Lead time, change failure rate, mean time to restore, deployment frequency. Calculated honestly — no vanity metrics, no story-point inflation.',
              cta: { label: 'See Measure in detail', href: '/features' },
            },
          ],
        }),

        statRow({
          background: 'obsidian',
          stats: [
            { value: 58, label: 'integrations' },
            { value: 12000, label: 'teams shipping' },
            { value: 89, suffix: 'ms', label: 'API p50' },
          ],
        }),

        // Product surface — a real code editor close-up. Lands the
        // dev-tool DNA between the stat row and the customer quote.
        oneCol(
          'near-black',
          'lg',
          figure({
            imageKey: 'home-product-code',
            alt: 'Tight close-up of a dark code editor screen running a JavaScript file, syntax highlighted in the Dracula colour palette.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'obsidian',
          text: '"Standups dropped from forty minutes to four. Velocity told us what would have been in the standup anyway."',
          attribution: 'A. Chen, Director of Engineering, Sequoia Logistics',
        }),

        ctaBanner({
          background: 'near-black',
          title: 'Free for the first ten people.',
          body: 'No credit card. Full feature set. Upgrade only when you need more seats or SSO.',
          cta: { label: 'Start free', href: '/pricing' },
        }),
      ],
    },

    // ─── FEATURES ─────────────────────────────────────────────────
    // Flat editorial hero (no cover photo). The page itself carries
    // the visuals: a collaboration pair, then a black-and-white data
    // chart, then three feature matrices. Restraint = signal.
    {
      slug: 'features',
      title: 'Features',
      seoTitle: 'Features — Velocity',
      seoDescription:
        'A complete tour of what Velocity does — Plan, Ship, Measure, Integrations.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'The full feature set',
          title: 'What Velocity does.',
          body: 'Four product surfaces — Plan, Ship, Measure, Integrate — and a CLI that uses every one of them.',
        }),

        // Pair: engineers reviewing code + a mobile dark-mode UI in
        // the hand. Shifts the page from copy to product proof.
        oneCol(
          'near-black',
          'lg',
          imagePair({
            leftImageKey: 'features-collaboration',
            leftAlt:
              'Over-the-shoulder view of two engineers reviewing code together on a laptop in a quiet workspace.',
            rightImageKey: 'features-mobile',
            rightAlt:
              'First-person shot of a smartphone held in hand showing a dark-mode iOS interface.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // The Measure surface, visually — a black-and-white time
        // series. Restraint + density: the brand promise made literal.
        oneCol(
          'obsidian',
          'md',
          figure({
            imageKey: 'features-data-viz',
            alt: 'Black and white macro of a laptop screen rendering a tightly gridded time-series chart — pure data, no chrome.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'near-black',
          sectionTitle: 'Plan',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'Issues',
              title: 'Markdown-first, link-aware',
              body: 'Issues that link to PRs, deploys, design files, and other issues without ceremony. Backlinks render automatically.',
            },
            {
              kicker: 'Cycles',
              title: 'Two-week, with honest carry-over',
              body: 'Carry-over is shown as carry-over, not pretended-completed. Burndown reads what really happened.',
            },
            {
              kicker: 'Roadmap',
              title: 'Quarters, themes, projects',
              body: 'A roadmap that the company can read — themes by quarter, projects by team, with a confidence-interval shown alongside the date.',
            },
          ],
        }),

        ...threeColCards({
          background: 'obsidian',
          sectionTitle: 'Ship',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'Deploys',
              title: 'A deploy view tied to the issue',
              body: 'Every deploy shows the issues it shipped, the PRs that merged in, and the test results. Two-click rollback to any prior deploy.',
            },
            {
              kicker: 'Review',
              title: 'PR review without GitHub fatigue',
              body: 'Inline review, threaded discussions, suggested edits. Optional integration with the GitHub PR shows both sides in sync.',
            },
            {
              kicker: 'CI/CD',
              title: 'Native pipeline runner',
              body: 'A pipeline runner with declarative YAML. Local reproduction with the CLI. Speed-optimised: average pipeline finishes in 4m12s.',
            },
          ],
        }),

        ...threeColCards({
          background: 'near-black',
          sectionTitle: 'Measure',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'DORA',
              title: 'The four real ones',
              body: 'Lead time, deployment frequency, change failure rate, MTTR. Calculated from real events — no story-point inflation, no vanity dashboards.',
            },
            {
              kicker: 'Quality',
              title: 'Flake rates, p99s, error budgets',
              body: 'Test flake rate per file. p99 latency per endpoint. Error budget burn-down per service. The numbers your SRE actually wants to see.',
            },
            {
              kicker: 'Health',
              title: 'Team velocity, sustainably',
              body: 'WIP per engineer. Hours per week, with a flag when anyone is over forty for three weeks. Built to surface burnout before it becomes attrition.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Want a closer look?',
          body: 'A real product tour, with one of our engineers, takes about thirty minutes. We will record it for your team.',
          cta: { label: 'Book a demo', href: '/pricing' },
        }),
      ],
    },

    // ─── PRICING ──────────────────────────────────────────────────
    // Shorter, business-focused hero. Daylight minimalist office —
    // calm, considered, no surprises. Overlay flipped to 'obsidian'
    // tone so the dark text reads against the bright photo. Anchored
    // top-left for a tight, paper-quality editorial header.
    {
      slug: 'pricing',
      title: 'Pricing',
      seoTitle: 'Pricing — Velocity',
      seoDescription:
        'Three plans — Free, Team, and Enterprise. Most teams stay on Team for the first three years.',
      sections: [
        heroCover({
          imageKey: 'pricing-office',
          alt: 'Modern minimalist interior with restrained wooden benches and soft daylight — calm, considered, unhurried.',
          eyebrow: 'Pricing',
          title: 'Three plans, no surprises.',
          body: 'Per seat, per month, billed annually. No charge for storage, integrations, or API calls. No "contact us for pricing" tier — Enterprise is $48 a seat and we will tell you what is in it before you ask.',
          overlayAlignment: 'top-left',
          overlayTone: 'obsidian',
          overlay: 'none',
          minHeight: 'lg',
          ratio: '21:9',
        }),

        ...threeColCards({
          background: 'near-black',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: '$0 · forever',
              title: 'Free',
              body: 'Up to ten seats. All four surfaces. All fifty-eight integrations. Community support, email replies within 48 hours.',
              cta: { label: 'Start free', href: '/docs' },
            },
            {
              kicker: '$18 / seat / month',
              title: 'Team',
              body: 'Unlimited seats. SSO via Google and Microsoft. Priority email support, replies within four business hours. The plan most teams stay on.',
              cta: { label: 'Start Team', href: '/docs' },
            },
            {
              kicker: '$48 / seat / month',
              title: 'Enterprise',
              body: 'Custom SSO and SCIM. Audit log export. Dedicated CSM. SOC 2 Type II, HIPAA on request. SLA at 99.95%.',
              cta: { label: 'Talk to sales', href: '/docs' },
            },
          ],
        }),

        // Pair: a real engineer on infra, alongside a considered
        // workspace. Together they're "what Enterprise looks like in
        // practice" — production systems + the calm to think clearly.
        oneCol(
          'near-black',
          'lg',
          imagePair({
            leftImageKey: 'customers-engineer',
            leftAlt:
              'An engineer with a tablet in a server-room corridor, blue rack lights reflecting on the glass partition behind her.',
            rightImageKey: 'team-workspace',
            rightAlt:
              'A considered home-office workspace — leather chair, low-profile mechanical keyboard, soft daylight through closed blinds.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'obsidian',
          sectionTitle: 'A few honest notes on pricing',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'On API calls',
              title: 'Unlimited, no asterisk',
              body: 'We rate-limit at 1000 req/min/seat, which only enterprises ever hit. If you do, we raise it on a phone call.',
            },
            {
              kicker: 'On the Free tier',
              title: 'Not a trial',
              body: 'The Free tier is a real tier. We keep teams on it for years and we still keep the lights on. It exists because we use it ourselves on early-stage projects.',
            },
            {
              kicker: 'On switching',
              title: 'A real migration team',
              body: 'Moving from Jira, Linear, Asana, Shortcut, or Trello? Our migration team will do the work for you, in business hours, free.',
            },
          ],
        }),
      ],
    },

    // ─── CHANGELOG ────────────────────────────────────────────────
    // Zine-style. Kanban whiteboard, anchored bottom-left, with a
    // moderate 'darken' overlay so the sticky-note grid still reads
    // through. Shorter than home so the page can lead straight into
    // the entry list.
    {
      slug: 'changelog',
      title: 'Changelog',
      seoTitle: 'Changelog — Velocity',
      seoDescription:
        'Every change to Velocity, ordered by date. Written by the engineers who shipped them.',
      sections: [
        heroCover({
          imageKey: 'changelog-kanban',
          alt: 'A whiteboard covered in orange and blue sticky notes arranged into kanban columns — workflow-as-zine.',
          eyebrow: 'Changelog',
          title: 'Every ship, in plain words.',
          body: 'A weekly post, written by the engineers who shipped the work. Major versions get their own page; the highlights live here.',
          overlayAlignment: 'bottom-left',
          overlay: 'darken',
          minHeight: 'lg',
          ratio: '21:9',
        }),

        ...threeColCards({
          background: 'near-black',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'May 23 · v4.18',
              title: 'Linear migration tool, GA',
              body: 'The Linear → Velocity migration tool moves from beta to GA. Tested on imports of up to 84,000 issues. Read the writeup on the blog.',
            },
            {
              kicker: 'May 16 · v4.17',
              title: 'Native GitLab pipelines',
              body: 'GitLab CI pipelines now appear inline on the deploy view, the same as GitHub Actions. The 5,000-pipeline self-test runs in 3m48s.',
            },
            {
              kicker: 'May 9 · v4.16',
              title: 'Slack threads in issues',
              body: 'Paste a Slack thread URL into an issue and the thread renders inline with replies. Updates automatically until you archive the issue.',
            },
            {
              kicker: 'May 2 · v4.15',
              title: 'A real CLI',
              body: 'velocity-cli is out of beta. Authentication, issues, deploys, pipelines, audit log — all of it from the terminal.',
            },
            {
              kicker: 'Apr 25 · v4.14',
              title: 'API v3',
              body: 'GraphQL API v3 ships. REST v2 remains supported until Jan 2027. Migration guide on the docs site.',
            },
            {
              kicker: 'Apr 18 · v4.13',
              title: 'Smaller things',
              body: 'Faster search (p99 down 38%). New keyboard shortcuts. Forty bug fixes. The full list is on the blog.',
            },
          ],
        }),

        // A real infrastructure shot to close the page — patch panels
        // and fibre. Quietly underscores that the platform itself is
        // an engineered thing, not a marketing surface.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'trust-infrastructure',
            alt: 'A network rack viewed head-on — patch panels, neatly bundled fibre, indicator LEDs glowing amber and green in the dark.',
            ratio: '21:9',
            animation: 'fade-in',
          }),
        ),
      ],
    },

    // ─── DOCS ─────────────────────────────────────────────────────
    // The most editorial-flat hero of the set. Wide 21:9, full-width,
    // editorial-text anchored bottom-left over a dark VSCode shot. No
    // primary CTA in the overlay — the page IS the CTA. A secondary
    // "Get the CLI" lives inline in the body.
    {
      slug: 'docs',
      title: 'Docs',
      seoTitle: 'Documentation — Velocity',
      seoDescription:
        'How to get started with Velocity. Onboarding, integrations, API reference, CLI reference, migration guides.',
      sections: [
        heroCover({
          imageKey: 'docs-code',
          alt: 'Close-up of an SVG source file in a dark code editor, syntax highlighted in blue and magenta.',
          eyebrow: 'Documentation',
          title: 'How to use Velocity.',
          body: 'Six guides for new teams, fifty-eight integration recipes, the full API reference, and a CLI reference. Everything you need to bring a team in within a week.',
          cta: { label: 'Get the CLI', href: '/docs#cli' },
          overlayAlignment: 'bottom-left',
          overlay: 'darken',
          minHeight: 'lg',
          ratio: '21:9',
        }),

        ...threeColCards({
          background: 'near-black',
          sectionTone: 'ivory',
          cards: [
            {
              kicker: 'Start',
              title: 'Get the team on in a week',
              body: 'Six 5-minute walkthroughs. Add the team, import your issues, set up the first cycle, ship something. Designed for a tech lead to run.',
            },
            {
              kicker: 'Integrations',
              title: 'Recipes, one per integration',
              body: 'GitHub, GitLab, Slack, Microsoft Teams, Linear, Jira (import only), Sentry, PagerDuty, Datadog, and forty-nine more. Each one is a real recipe, not a marketing tile.',
            },
            {
              kicker: 'API',
              title: 'GraphQL with examples',
              body: 'A full reference of the v3 GraphQL API, with example queries you can copy. Webhooks documented separately. Postman collection updated weekly.',
            },
            {
              kicker: 'CLI',
              title: 'velocity-cli, full reference',
              body: 'Every command, every flag, every output shape. Including the shell-completion install. Tested on macOS, Linux, and WSL.',
            },
            {
              kicker: 'Migrate',
              title: 'From Jira, Linear, Asana',
              body: 'Step-by-step migration guides for the big three. Plus a "talk to us" path for anything else — we will write a custom migration if your team is over fifty.',
            },
            {
              kicker: 'Help',
              title: 'Send the support team a note',
              body: 'Email support@velocity.example. Free tier gets a 48-hour reply, Team gets 4 business hours, Enterprise gets a Slack channel.',
            },
          ],
        }),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'support@velocity.example',
            href: 'mailto:support@velocity.example',
            description: 'Reply within 4 business hours on Team plans.',
          },
          phone: {
            value: '+1 415 555 0192',
            href: 'tel:+14155550192',
            description: 'Enterprise plans only.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Have a question?',
            intro:
              'A short message about what you’re building. We will reply by email — within four business hours on Team, faster on Enterprise.',
            submitLabel: 'Send question',
            successHeadline: 'Got it — we have your question.',
            successBody:
              'A real engineer will reply by email. Free tier gets a 48-hour reply window; Team and Enterprise are faster.',
          }),
        ),
      ],
    },
  ],
}
