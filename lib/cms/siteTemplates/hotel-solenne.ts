import type { SiteTemplate } from './types'
import {
  action,
  closingQuote,
  contactChannels,
  contactForm,
  ctaBanner,
  eyebrow,
  heading,
  hero,
  oneCol,
  statRow,
  text,
  threeColCards,
  threeCols,
} from './_shared'

// Hôtel Solenne — boutique hotel template.
// 5 pages: Home, Rooms, Dining, Story, Reservations.
//
// Voice: hospitality, quiet confidence. Sentences land softly. Numbers
// are restrained (no "luxury 5-star award-winning"). The hotel knows
// it's special and doesn't have to shout.

export const hotelSolenneTemplate: SiteTemplate = {
  slug: 'hotel-solenne',
  name: 'Hôtel Solenne',
  kind: 'Boutique hotel',
  tagline: 'A quieter way to stay.',
  description:
    'A grand-yet-quiet boutique hotel. Rooms, dining, story, reservations. Generous space, soft confidence, easy to make your own.',
  vibe: 'hospitality',
  themePalette: {
    bg: '#0a0a0c',
    fg: '#f5f1ea',
    accent: '#c9a961',
    muted: '#6e665a',
  },
  branding: {
    brandText: 'Hôtel Solenne',
    headerTheme: 'obsidian',
    primaryNav: [
      { label: 'Rooms', href: '/rooms' },
      { label: 'Dining', href: '/dining' },
      { label: 'Story', href: '/story' },
      { label: 'Reservations', href: '/reservations' },
    ],
    primaryCta: { text: 'Book a room', href: '/reservations' },
    footerColumns: [
      {
        label: 'Stay',
        links: [
          { text: 'Rooms & suites', href: '/rooms' },
          { text: 'Reservations', href: '/reservations' },
        ],
      },
      {
        label: 'Dine',
        links: [
          { text: 'Restaurant', href: '/dining' },
          { text: 'Bar', href: '/dining#bar' },
        ],
      },
      {
        label: 'About',
        links: [
          { text: 'Our story', href: '/story' },
          { text: 'Press', href: '/story#press' },
        ],
      },
    ],
    footerTagline: 'A quieter way to stay.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Hôtel Solenne',
      isHome: true,
      seoTitle: 'Hôtel Solenne — A quieter way to stay',
      seoDescription:
        'A grand-yet-quiet boutique hotel. Forty rooms, one restaurant, a bar that closes when the last guest is ready to leave.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'Hôtel Solenne',
          title: 'A quieter way to stay.',
          body: 'Forty rooms above a small garden courtyard. Linen sheets, low lamps, and a kitchen that opens for breakfast at six and supper at six again. Built for the kind of trip that does not need announcing.',
          cta: { label: 'Reserve a room', href: '/reservations' },
          secondaryCta: { label: 'See the rooms', href: '/rooms' },
        }),

        // The hotel, briefly — 3 cards
        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'Forty rooms. One restaurant. A garden.',
          sectionBody:
            'Each room faces either the courtyard or the lane. Both are quiet. The restaurant is small enough that the chef cooks every plate himself, and the bar closes when the last guest is ready to leave.',
          cards: [
            {
              kicker: 'The rooms',
              title: 'Eight quiet shapes',
              body: 'Standards, deluxes, junior suites, and a top-floor garret with a private terrace. All face the garden or the lane. None face a road.',
              cta: { label: 'See the rooms', href: '/rooms' },
            },
            {
              kicker: 'The kitchen',
              title: 'Two services a day',
              body: 'Breakfast from six. Supper from six again. A short menu, a longer wine list, and a chef who answers the dining room himself.',
              cta: { label: 'See the kitchen', href: '/dining' },
            },
            {
              kicker: 'The story',
              title: 'Built to be lived in',
              body: 'A nineteenth-century townhouse, restored slowly. Original tiles. Gas lamps in the courtyard. The same family ran it for sixty years; we are the seventh.',
              cta: { label: 'Read the story', href: '/story' },
            },
          ],
        }),

        // By the numbers — a quiet restraint
        statRow({
          background: 'near-black',
          stats: [
            { value: 40, label: 'rooms' },
            { value: 1882, label: 'built' },
            { value: 24, label: 'staff' },
          ],
        }),

        // A guest letter
        oneCol(
          'cream',
          'lg',
          eyebrow('From a guest', { tone: 'champagne' }),
          heading(
            '"We came for two nights. We stayed for five."',
            {
              level: 'h2',
              size: 'display-md',
              tone: 'obsidian',
              italic: true,
              marginTop: 'sm',
            },
          ),
          text(
            '<p>"The room had a clock that did not click. The bed had four pillows of different softnesses, neatly labelled. The waiter at breakfast remembered that my husband does not take milk."</p><p>"There is a kind of attention here that you cannot ask for. It is given."</p>',
            { tone: 'obsidian', marginTop: 'md', maxWidth: 'medium' },
          ),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'When would you like to stay?',
          body: 'Reservations open twelve months ahead. The garret often books out by April.',
          cta: { label: 'Check availability', href: '/reservations' },
        }),
      ],
    },

    // ─── ROOMS ────────────────────────────────────────────────────
    {
      slug: 'rooms',
      title: 'Rooms',
      seoTitle: 'Rooms — Hôtel Solenne',
      seoDescription:
        'Forty rooms across eight shapes. Standards, deluxes, junior suites, and a top-floor garret. All face the garden or the quiet lane.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'The rooms',
          title: 'Eight quiet shapes.',
          body: 'Every room faces either the courtyard garden or the lane behind it. Linen sheets, blackout curtains, a deep bath in the suites, a writing desk by every window.',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'From €240',
              title: 'Petit',
              body: 'Eighteen square metres. One double bed. A reading chair, a small writing desk, a deep tub in the bathroom. Garden side.',
            },
            {
              kicker: 'From €310',
              title: 'Classique',
              body: 'Twenty-four square metres. One king bed. A sitting nook by the window, a marble basin, a separate shower and bath. Garden or lane.',
            },
            {
              kicker: 'From €420',
              title: 'Deluxe',
              body: 'Thirty-two square metres. One king or two singles. A separate dressing room, a walk-in shower, a bath that fits two. All face the garden.',
            },
            {
              kicker: 'From €560',
              title: 'Junior suite',
              body: 'Forty-eight square metres in two rooms — bedroom and sitting room. A working fireplace, a writing table, a bath beside the window.',
            },
            {
              kicker: 'From €720',
              title: 'Suite Solenne',
              body: 'Sixty-six square metres. Two bathrooms. A private breakfast room. The signature suite, named for the daughter of the original family.',
            },
            {
              kicker: 'From €950',
              title: 'Le Grenier',
              body: 'The top-floor garret. Sloped ceilings, a private rooftop terrace, a freestanding tub. One bedroom, one only. Often booked twelve months out.',
            },
          ],
        }),

        // What is in every room
        oneCol(
          'champagne',
          'md',
          eyebrow('In every room', { tone: 'obsidian' }),
          heading('What does not change', {
            level: 'h2',
            size: 'display-md',
            tone: 'obsidian',
            marginTop: 'sm',
          }),
        ),
        threeCols(
          'champagne',
          'md',
          [
            heading('Linen', {
              level: 'h3',
              size: 'display-sm',
              tone: 'obsidian',
              animation: 'fade-in',
            }),
            text(
              'White cotton percale, ironed in-house. A fresh set every night for stays longer than three.',
              { tone: 'obsidian', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
          [
            heading('Quiet', {
              level: 'h3',
              size: 'display-sm',
              tone: 'obsidian',
              animation: 'fade-in',
            }),
            text(
              'Triple-glazed windows. No televisions in the bedrooms — the sitting rooms in the suites have one, behind a panel.',
              { tone: 'obsidian', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
          [
            heading('Care', {
              level: 'h3',
              size: 'display-sm',
              tone: 'obsidian',
              animation: 'fade-in',
            }),
            text(
              'Pressing on the same day. A laundry pickup at eight; back, sealed, by six. Shoes shined at the desk on request.',
              { tone: 'obsidian', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'See a room before you book?',
          body: 'Tours of the rooms run on weekdays at ten. Tell us when you would like to come.',
          cta: { label: 'Arrange a viewing', href: '/reservations' },
        }),
      ],
    },

    // ─── DINING ───────────────────────────────────────────────────
    {
      slug: 'dining',
      title: 'Dining',
      seoTitle: 'Dining — Hôtel Solenne',
      seoDescription:
        'Two services a day, six to ten and six to ten. A short menu, a longer wine list, a bar that closes when the last guest is ready to leave.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'The kitchen',
          title: 'Two services a day.',
          body: 'Breakfast from six until ten. Supper from six until ten. The bar between is open for tea, for an early drink, and for the kind of conversation that the dining room is too bright for.',
        }),

        // The restaurant
        oneCol(
          'ivory',
          'lg',
          eyebrow('The restaurant', { tone: 'champagne' }),
          heading('A short menu, cooked plate by plate', {
            level: 'h2',
            size: 'display-md',
            tone: 'obsidian',
            marginTop: 'sm',
          }),
          text(
            'Six starters, eight mains, three desserts. The menu changes every Friday. The kitchen seats twenty-eight and the chef cooks every plate himself, which is why we ask you to choose a time when you book.',
            { tone: 'obsidian', maxWidth: 'medium', marginTop: 'md' },
          ),
          action('See this week’s menu', '/dining#menu', {
            variant: 'link-arrow',
            marginTop: 'md',
          }),
        ),

        // This week's menu — sample dishes
        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'This week, plate by plate',
          sectionBody:
            'A reduced sketch of the current menu. The full card is at the table.',
          cards: [
            {
              kicker: 'To start',
              title: 'Cured trout, fennel, lemon oil',
              body: 'Trout from the river that runs behind the garden, cured for thirty-six hours in salt and bay. Shaved fennel from the courtyard pots.',
            },
            {
              kicker: 'To start',
              title: 'Onion velouté, brown butter',
              body: 'Sweet onions cooked slowly in butter for three hours. Finished at the table with brown butter and a thin slice of toasted brioche.',
            },
            {
              kicker: 'To start',
              title: 'Heritage tomatoes, sheep curd',
              body: 'Tomatoes from a single farm at the edge of the city. A spoon of fresh sheep curd, basil oil, sea salt.',
            },
            {
              kicker: 'A main',
              title: 'Roast pigeon, salsify, blackcurrant',
              body: 'Pigeon from the same farm as the tomatoes. Blackcurrants from the kitchen garden, reduced with red wine and finished with a knob of cold butter.',
            },
            {
              kicker: 'A main',
              title: 'Hake, brown crab, fennel',
              body: 'Line-caught hake from the coast, pan-fried in butter. A small bowl of brown-crab broth alongside, and a fennel salad on the plate.',
            },
            {
              kicker: 'To finish',
              title: 'Tarte fine aux pommes',
              body: 'A thin apple tart, served warm with crème fraîche. The same recipe the previous family used since the seventies — we did not change it.',
            },
          ],
        }),

        // The bar
        oneCol(
          'near-black',
          'md',
          eyebrow('The bar', { tone: 'champagne' }),
          heading('Open to the lane, open to the room', {
            level: 'h2',
            size: 'display-md',
            tone: 'ivory',
            marginTop: 'sm',
          }),
          text(
            'A small bar off the lobby. A dozen seats. A cellar of three hundred bottles, half of them from one hour from the hotel. Tea served until eleven, drinks until everyone is ready to leave.',
            { tone: 'ivory', maxWidth: 'medium', marginTop: 'md' },
          ),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'Reserve a table',
          body: 'Hotel guests have an automatic table. For non-guests, we keep a small number aside each night.',
          cta: { label: 'Reserve a table', href: '/reservations' },
        }),
      ],
    },

    // ─── STORY ────────────────────────────────────────────────────
    {
      slug: 'story',
      title: 'Story',
      seoTitle: 'Story — Hôtel Solenne',
      seoDescription:
        'An 1882 townhouse, run for sixty years by one family and the next twenty by another. The seventh chapter is now ours.',
      sections: [
        hero({
          background: 'cream',
          eyebrow: 'Since 1882',
          title: 'Seven chapters, one house.',
          body: 'The building was a townhouse first, then a boarding house, then a hotel from 1924. Six families have owned it. We are the seventh, and we restored it slowly between 2019 and 2023.',
          tone: 'obsidian',
        }),

        // Story sections
        oneCol(
          'ivory',
          'lg',
          eyebrow('Chapter one', { tone: 'champagne' }),
          heading('A townhouse, briefly', {
            level: 'h2',
            size: 'display-md',
            tone: 'obsidian',
            marginTop: 'sm',
          }),
          text(
            '<p>Built in 1882 by a notary for his family of seven. The original tiles in the lobby are his. The gas lamps in the courtyard are also his — converted to mains gas in 1934, kept lit ever since.</p><p>Sold in 1907 to a textile merchant, then in 1923 to the family that would run it as a hotel for the next sixty years.</p>',
            { tone: 'obsidian', marginTop: 'md' },
          ),
        ),

        oneCol(
          'champagne',
          'lg',
          eyebrow('Chapter five', { tone: 'obsidian' }),
          heading('Sixty years under the Solenne name', {
            level: 'h2',
            size: 'display-md',
            tone: 'obsidian',
            marginTop: 'sm',
          }),
          text(
            '<p>The Solenne family ran the hotel from 1923 until 1985. Three generations, two world wars, the same breakfast menu for forty of those years. The current dining-room clock is the family’s. The recipe for the apple tart is the family’s.</p><p>The name is the family’s daughter, born in 1924, who lived in what is now the Suite Solenne until she went to university in 1942.</p>',
            { tone: 'obsidian', marginTop: 'md' },
          ),
        ),

        oneCol(
          'ivory',
          'lg',
          eyebrow('Chapter seven', { tone: 'champagne' }),
          heading('What we kept, what we changed', {
            level: 'h2',
            size: 'display-md',
            tone: 'obsidian',
            marginTop: 'sm',
          }),
          text(
            '<p>We kept the floorplans. The original tiles. The clock. The recipe for the tart. The gas lamps. The name.</p><p>We changed the bathrooms (entirely), the windows (triple-glazed for quiet), the linen (heavier, plainer), the kitchen (rebuilt around a single chef), and the bar (which used to be a tea room and is now both).</p>',
            { tone: 'obsidian', marginTop: 'md' },
          ),
        ),

        closingQuote({
          background: 'cream',
          text: 'A hotel is a long conversation between the rooms and the people who pass through them. We are listening.',
          attribution: 'A note in the front desk drawer, undated',
        }),
      ],
    },

    // ─── RESERVATIONS ─────────────────────────────────────────────
    {
      slug: 'reservations',
      title: 'Reservations',
      seoTitle: 'Reservations — Hôtel Solenne',
      seoDescription:
        'Reservations open twelve months ahead. Forty rooms across eight shapes. We answer every enquiry within one business day.',
      sections: [
        hero({
          background: 'obsidian',
          eyebrow: 'Reservations',
          title: 'When would you like to stay?',
          body: 'Reservations open twelve months ahead. Tell us your dates, the kind of room you would like, and any small thing we should know — a quiet floor, a late arrival, a cake at the table.',
        }),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'reservations@solenne-hotel.example',
            href: 'mailto:reservations@solenne-hotel.example',
            description: 'Answered within one business day.',
          },
          phone: {
            value: '+33 1 42 00 00 00',
            href: 'tel:+33142000000',
            description: 'Reception, every day, six to ten.',
          },
          address: {
            value: 'Rue Solenne 12, Paris',
            description: 'Off the lane behind the garden.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Send us your dates',
            intro:
              'Names, dates, number of guests, and the kind of room. We will come back within one business day.',
            submitLabel: 'Send enquiry',
            successHeadline: 'Thank you — your enquiry is with us.',
            successBody:
              'Reception will reply by email within one business day. If your arrival is sooner than that, call us.',
          }),
        ),
      ],
    },
  ],
}

