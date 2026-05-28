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
  statRow,
  threeColCards,
} from './_shared'

// Velocity — modern SaaS landing.
// 5 pages: Home, Features, Pricing, Changelog, Docs.
// Voice: confident, technical, builder-to-builder. Avoids buzzwords.

export const velocityTemplate: SiteTemplate = {
  slug: 'velocity',
  name: 'Velocity',
  kind: 'Software',
  tagline: 'Faster than yesterday.',
  description:
    'A modern SaaS landing template. Hero, feature matrix, pricing, changelog, docs. Built for software teams that want a website that does not look like every other software site.',
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
    {
      slug: 'home',
      title: 'Velocity',
      isHome: true,
      seoTitle: 'Velocity — Faster than yesterday',
      seoDescription:
        'A modern engineering operations platform. Plan, ship, measure. Built for teams that want fewer meetings.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'home-hero-abstract',
            alt: 'An abstract dark blue circuit board macro with glowing nodes and fibre-optic light trails.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken-strong',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Engineering operations',
          title: 'Faster than yesterday.',
          body: 'Plan, ship, and measure work in one tool. Fifty-eight integrations, a real CLI, an API that returns within ninety milliseconds. Built for teams that want fewer meetings and more deploys.',
          cta: { label: 'Start free', href: '/pricing' },
          secondaryCta: { label: 'Read the docs', href: '/docs' },
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

        // Product surface — laptop with a blurred dashboard.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'home-product-laptop',
            alt: 'An open laptop on a dark desk displaying a blurred abstract dashboard interface.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        // Founder portrait — grounds the customer quote below.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'team-founder',
            alt: 'A considered editorial portrait of one of the Velocity founders in soft natural light.',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'cream',
          text: '"Standups dropped from forty minutes to four. Velocity told us what would have been in the standup anyway."',
          attribution: 'A. Chen, Director of Engineering, Sequoia Logistics',
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Free for the first ten people.',
          body: 'No credit card. Full feature set. Upgrade only when you need more seats or SSO.',
          cta: { label: 'Start free', href: '/pricing' },
        }),
      ],
    },

    // ─── FEATURES ─────────────────────────────────────────────────
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

        // Pair: engineers reviewing code + a mobile UI close-up.
        oneCol(
          'near-black',
          'lg',
          imagePair({
            leftImageKey: 'features-collaboration',
            leftAlt: 'Over-the-shoulder view of two engineers reviewing code together on a laptop.',
            rightImageKey: 'features-mobile',
            rightAlt: 'Close-up of a smartphone showing a minimal dark-mode app interface.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Data viz — the Measure surface, visually.
        oneCol(
          'obsidian',
          'md',
          figure({
            imageKey: 'features-data-viz',
            alt: 'An abstract data visualization of glowing connected nodes and lines on a deep blue background.',
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
    {
      slug: 'pricing',
      title: 'Pricing',
      seoTitle: 'Pricing — Velocity',
      seoDescription:
        'Three plans — Free, Team, and Enterprise. Most teams stay on Team for the first three years.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'pricing-office',
            alt: 'A modern minimalist office workspace with wooden furniture and soft daylight — the kind of team Velocity is built for.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Pricing',
          title: 'Three plans, no surprises.',
          body: 'Pricing is per seat, per month, billed annually. We do not charge for storage, integrations, or API calls. There is no "contact us for pricing" tier — Enterprise is listed at $48 a seat and we will tell you what is in it before you ask.',
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

        // Pair: customers' meeting + office interior — what Enterprise
        // looks like in practice.
        oneCol(
          'near-black',
          'lg',
          imagePair({
            leftImageKey: 'customers-meeting',
            leftAlt: 'A wide shot of a boardroom meeting with silhouetted figures backlit by window light.',
            rightImageKey: 'team-office',
            rightAlt: 'An industrial-loft office interior at dusk with exposed brick and warm pendant lighting.',
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
    {
      slug: 'changelog',
      title: 'Changelog',
      seoTitle: 'Changelog — Velocity',
      seoDescription:
        'Every change to Velocity, ordered by date. Written by the engineers who shipped them.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'changelog-kanban',
            alt: 'A whiteboard covered in coloured sticky notes arranged into columns — kanban-style task tracking.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Changelog',
          title: 'Every ship, in plain words.',
          body: 'A weekly post, written by the engineers who shipped the work. Major versions get their own page; the highlights live here.',
        }),

        // Trust-security figure — between the changelog cards and the
        // end of page. Hints at the security-conscious posture.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'trust-security',
            alt: 'An abstract security visualization with a glowing padlock motif over a dark grid of binary code.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

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
      ],
    },

    // ─── DOCS ─────────────────────────────────────────────────────
    {
      slug: 'docs',
      title: 'Docs',
      seoTitle: 'Documentation — Velocity',
      seoDescription:
        'How to get started with Velocity. Onboarding, integrations, API reference, CLI reference, migration guides.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'docs-code',
            alt: 'Close-up of a code editor screen with syntax-highlighted source code on a dark background.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Documentation',
          title: 'How to use Velocity.',
          body: 'Six guides for new teams, fifty-eight integration recipes, the full API reference, and a CLI reference. Everything you need to bring a team in within a week.',
          cta: { label: 'Get the CLI', href: '/docs#cli' },
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
