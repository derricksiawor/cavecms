import {
  HOME_SECTIONS,
  ABOUT_SECTIONS,
  SERVICES_SECTIONS,
  CONTACT_SECTIONS,
  PROJECTS_SECTIONS,
} from '@/db/seeds/systemPageBlocks'
import type { SiteTemplate } from './types'

// The CaveCMS welcome one-pager (plus the four supporting system pages
// that ship with every fresh install: About / Services / Contact /
// Projects). This is the EXACT same content the install-migrate seed
// step writes via `db/seeds/systemPageBlocks.ts` — re-exporting the
// SectionSpec arrays so picking "I'll pick later" reproduces the
// install-migrate-equivalent state byte-for-byte. If the operator
// previously picked an industry template and changes their mind to
// "I'll pick later", the wipe + re-seed restores the canonical
// welcome state.
//
// Privacy + Terms pages are preserved by the wipe (they're seeded by
// migration 0015 and live as legal pages every template inherits),
// and the thank-you-{enquiry,tour,brochure} utility pages also
// survive — see app/api/install/template/route.ts wipe logic.
//
// Single source of truth: when systemPageBlocks.ts changes, this
// template tracks automatically because the SECTIONS arrays are
// imported, not duplicated.

export const defaultWelcomeTemplate: SiteTemplate = {
  slug: 'default-welcome',
  name: "I'll pick later",
  kind: 'CaveCMS welcome',
  tagline: 'A clean slate to build from.',
  description:
    'The default CaveCMS welcome pages — Home, About, Services, Contact, Projects. Pick this if you want to start from the canonical layout and edit page-by-page.',
  vibe: 'generic',
  themePalette: {
    bg: '#0a0a0c',
    fg: '#f5f1ea',
    accent: '#b88f6a',
    muted: '#6e665a',
  },
  branding: {
    brandText: 'Your Site',
    headerTheme: 'cream',
    primaryNav: [],
    primaryCta: null,
    footerColumns: [],
    footerTagline: '',
  },
  pages: [
    {
      slug: 'home',
      title: 'Home',
      isHome: true,
      sections: HOME_SECTIONS,
    },
    {
      slug: 'about',
      title: 'About',
      sections: ABOUT_SECTIONS,
    },
    {
      slug: 'services',
      title: 'Services',
      sections: SERVICES_SECTIONS,
    },
    {
      slug: 'contact',
      title: 'Contact',
      sections: CONTACT_SECTIONS,
    },
    {
      slug: 'projects',
      title: 'Projects',
      sections: PROJECTS_SECTIONS,
    },
  ],
}
