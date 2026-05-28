import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  coverImage,
  ctaBanner,
  eyebrow,
  figure,
  heading,
  hero,
  imagePair,
  oneCol,
  statRow,
  text,
  threeColCards,
} from './_shared'

// Maison Brûlée — neighborhood restaurant.
// 5 pages: Home, Menu, Story, Reservations, Press.
// Voice: confident, lived-in. Food without florid adjectives.

export const maisonBruleeTemplate: SiteTemplate = {
  slug: 'maison-brulee',
  name: 'Maison Brûlée',
  kind: 'Restaurant',
  tagline: 'A table worth keeping.',
  description:
    'A neighborhood restaurant template. Menu, story, reservations, press. Built for chefs and restaurateurs who keep coming back to the same fire.',
  vibe: 'restaurant',
  themePalette: {
    bg: '#1a0e0a',
    fg: '#f5e6d3',
    accent: '#c97a3a',
    muted: '#7a6a5a',
  },
  branding: {
    brandText: 'Maison Brûlée',
    headerTheme: 'obsidian',
    primaryNav: [
      { label: 'Menu', href: '/menu' },
      { label: 'Story', href: '/story' },
      { label: 'Reservations', href: '/reservations' },
      { label: 'Press', href: '/press' },
    ],
    primaryCta: { text: 'Book a table', href: '/reservations' },
    footerColumns: [
      {
        label: 'Eat',
        links: [
          { text: 'Menu', href: '/menu' },
          { text: 'Reservations', href: '/reservations' },
        ],
      },
      {
        label: 'About',
        links: [
          { text: 'Our story', href: '/story' },
          { text: 'Press', href: '/press' },
        ],
      },
    ],
    footerTagline: 'A table worth keeping.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Maison Brûlée',
      isHome: true,
      seoTitle: 'Maison Brûlée — A table worth keeping',
      seoDescription:
        'A neighborhood restaurant. Thirty-six seats, one wood-fired oven, dinner Tuesday to Saturday.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'home-hero-room',
            alt: 'The Maison Brûlée dining room — warmly lit at evening service, set tables, intimate seating.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Since 2017',
          title: 'A table worth keeping.',
          body: 'A small dining room — thirty-six seats around a single open kitchen with a wood-fired oven at the heart of it. Dinner only, Tuesday to Saturday, six until late. The menu changes weekly, the wine list every season.',
          cta: { label: 'Book a table', href: '/reservations' },
          secondaryCta: { label: 'See the menu', href: '/menu' },
        }),

        ...threeColCards({
          background: 'cream',
          sectionTitle: 'The shape of the place',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'The dining room',
              title: 'Thirty-six seats',
              body: 'Bare wood tables, candles in old wine bottles, a long bar that overlooks the kitchen. Reservations recommended on Friday and Saturday.',
            },
            {
              kicker: 'The kitchen',
              title: 'One open fire',
              body: 'A single wood-fired oven, lit at four every afternoon. Chef Esme Lacroix cooks at it herself. About half the menu touches the fire.',
            },
            {
              kicker: 'The cellar',
              title: 'About eighty wines',
              body: 'Mostly French, with a small Italian and Iberian section. Five wines by the glass each evening. The list rotates by season.',
            },
          ],
        }),

        statRow({
          background: 'near-black',
          stats: [
            { value: 36, label: 'seats' },
            { value: 7, label: 'years open' },
            { value: 80, label: 'wines on the list' },
          ],
        }),

        // The bar — wine list lives behind it.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'home-bar',
            alt: 'The Maison Brûlée wine bar — backlit shelves of bottles and glassware in warm amber light.',
            ratio: '16:9',
            caption: 'About eighty wines on the list, rotating by season.',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'cream',
          text: '"The trout came on a plate so hot the salt sizzled. The waiter said her name and the name of the river. We have come back fourteen times since."',
          attribution: 'M. & J. Iversen, regulars since 2018',
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'When would you like to eat?',
          body: 'Reservations open six weeks ahead. Friday and Saturday nights book out by Wednesday — early in the week is best for a quiet supper.',
          cta: { label: 'Book a table', href: '/reservations' },
        }),
      ],
    },

    // ─── MENU ─────────────────────────────────────────────────────
    {
      slug: 'menu',
      title: 'Menu',
      seoTitle: 'Menu — Maison Brûlée',
      seoDescription:
        'This week’s menu. Six starters, eight mains, three desserts. Changes every Tuesday.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'menu-wine',
            alt: 'A hand pouring red wine into a glass at a candlelit table — the kind of moment the menu builds toward.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'This week’s menu',
          title: 'Six, eight, three.',
          body: 'Six starters, eight mains, three desserts. The menu refreshes every Tuesday — whatever the suppliers brought on Monday is what we cook. About half of every dish touches the fire.',
        }),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'To start',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '$14',
              title: 'Burrata, fire-roasted peppers, basil',
              body: 'Hand-pulled burrata. Romanos and rosso peppers blackened on the wood-fire grill, peeled, dressed in basil oil.',
            },
            {
              kicker: '$16',
              title: 'Smoked trout, fennel, lemon',
              body: 'Trout smoked over apple wood. Shaved fennel from the kitchen garden, lemon oil, a slice of grilled sourdough.',
            },
            {
              kicker: '$12',
              title: 'Cep soup, brown butter',
              body: 'A bowl of cep mushroom soup, finished at the table with brown butter and a wisp of truffle.',
            },
            {
              kicker: '$15',
              title: 'Beef tartare, smoked egg, cornichons',
              body: 'Hand-cut beef from the front quarter. A smoked yolk, capers, cornichons, mustard, on toasted brioche.',
            },
            {
              kicker: '$11',
              title: 'Heritage tomatoes, sheep curd',
              body: 'Three varieties of tomato from one farm an hour from the kitchen. Sheep curd, basil oil, sea salt, black pepper.',
            },
            {
              kicker: '$13',
              title: 'Anchovies, butter, bread',
              body: 'Cantabrian anchovies, on bread baked at the back of the wood fire, cold cultured butter.',
            },
          ],
        }),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'A main',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '$36',
              title: 'Whole turbot, brown butter, capers',
              body: 'Cooked whole on the wood fire, served on the bone. Brown butter, capers, a wedge of lemon. Enough for two.',
            },
            {
              kicker: '$28',
              title: 'Pigeon, blackcurrant, salsify',
              body: 'A pigeon from a farm one hour east. Roasted at the front of the wood oven. Blackcurrant reduction, salsify cooked in butter.',
            },
            {
              kicker: '$34',
              title: 'Lamb shoulder, harissa, yoghurt',
              body: 'Lamb cooked in the embers for eight hours. House harissa, sheep’s yoghurt, soft flatbread baked to order.',
            },
            {
              kicker: '$32',
              title: 'Hake, brown crab, fennel',
              body: 'Line-caught hake. Brown crab broth, fennel salad, a single slice of grilled sourdough beside.',
            },
            {
              kicker: '$22',
              title: 'Wild mushroom risotto',
              body: 'A handful of foraged mushrooms, carnaroli rice, mascarpone, finished with a knob of brown butter at the table.',
            },
            {
              kicker: '$26',
              title: 'Bavette, bone marrow, watercress',
              body: 'Bavette steak from the front quarter, grilled over the wood fire. Roast bone marrow on toast, watercress, malt vinegar.',
            },
          ],
        }),

        // The "main" hero figure — handmade pasta or a roast.
        oneCol(
          'ivory',
          'md',
          figure({
            imageKey: 'menu-main',
            alt: 'A handmade pasta main course twirled on a rustic plate with grated cheese and herbs.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        // Pair: a starter and a dessert from the current week.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'menu-starter',
            leftAlt: 'A delicate crudo starter plated on a cream-rimmed ceramic dish with herbs and citrus.',
            rightImageKey: 'menu-dessert',
            rightAlt: 'A warm rustic tart with poached fruit and cream, photographed in soft natural light.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'champagne',
          sectionTitle: 'To finish',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '$11',
              title: 'Tarte fine aux pommes',
              body: 'A thin apple tart, baked to order in the wood oven. Crème fraîche, a pinch of sea salt.',
            },
            {
              kicker: '$12',
              title: 'Burnt-honey ice cream, oats',
              body: 'Honey burnt until smoky, then folded into custard and churned. Toasted oats, a thin pour of double cream.',
            },
            {
              kicker: '$10',
              title: 'A wedge of cheese',
              body: 'Three rotating cheeses from one cheesemonger. A small pile of seasonal fruit, walnut bread.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Tasting menu, Tuesdays and Wednesdays',
          body: 'A seven-course chef’s tasting at $95 per head, available the first two nights of the week. Wine pairing $60.',
          cta: { label: 'Book the tasting menu', href: '/reservations' },
        }),
      ],
    },

    // ─── STORY ────────────────────────────────────────────────────
    {
      slug: 'story',
      title: 'Story',
      seoTitle: 'Story — Maison Brûlée',
      seoDescription:
        'Esme Lacroix opened Maison Brûlée in 2017 with the wood oven she had cooked on since culinary school.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'story-facade',
            alt: 'The Maison Brûlée exterior at twilight, warm yellow window glow spilling onto the street.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Since 2017',
          title: 'One chef, one fire.',
          body: 'Maison Brûlée opened in May 2017. The wood oven was the first thing installed in the empty room — Esme had cooked on the same model in Lyon and brought one over before the floor was tiled.',
          tone: 'obsidian',
        }),

        oneCol(
          'ivory',
          'lg',
          eyebrow('Esme', { tone: 'champagne' }),
          heading(
            'Trained in Lyon, cooked in Copenhagen, came home to open this',
            {
              level: 'h2',
              size: 'display-md',
              tone: 'obsidian',
              marginTop: 'sm',
            },
          ),
          text(
            'Esme Lacroix grew up half a mile from the restaurant. She trained at the Institut Paul Bocuse, cooked at three Michelin-starred kitchens in Copenhagen for six years, and came back at thirty-one to open her own room. Maison Brûlée is named for the burnt-edge cooking she does on the wood oven — and for the small kitchen fire she had on the morning of opening, which the staff still talk about.',
            { tone: 'obsidian', marginTop: 'md' },
          ),
        ),

        // Chef pair: portrait + kitchen pass — the human story.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'chef-portrait',
            leftAlt: 'A candid portrait of chef Esme Lacroix in a white jacket in the kitchen under warm overhead light.',
            rightImageKey: 'chef-kitchen',
            rightAlt: 'A line cook\'s hands plating at the kitchen pass with steam rising under warm service lights.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Ingredients close-up — the produce, the kitchen garden.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'story-ingredients',
            alt: 'Close-up of fresh market herbs and produce on a wooden surface in soft daylight.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'champagne',
          sectionTitle: 'A few honest details',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'The room',
              title: 'A former butcher’s shop',
              body: 'The space was a butcher’s shop from 1932 to 2014. The original tiles in the bar are theirs. The hooks in the kitchen ceiling are theirs.',
            },
            {
              kicker: 'The kitchen garden',
              title: 'Two beds and three pots',
              body: 'A small courtyard at the back. Fennel, basil, thyme, sorrel, mint. About one in four dishes uses something from it in summer.',
            },
            {
              kicker: 'The wood oven',
              title: 'Lit at four, in by six',
              body: 'A Mugnaini imported in 2017. Apple wood from the same orchard as the smoking trout. Lit at four every afternoon by Esme herself.',
            },
          ],
        }),

        closingQuote({
          background: 'ivory',
          text: '"There is one fire, and one Esme. That is the secret. There is no other secret."',
          attribution: 'A. Verma, food writer, in a 2023 review',
        }),
      ],
    },

    // ─── RESERVATIONS ─────────────────────────────────────────────
    {
      slug: 'reservations',
      title: 'Reservations',
      seoTitle: 'Reservations — Maison Brûlée',
      seoDescription:
        'Reservations open six weeks ahead. Dinner only, Tuesday to Saturday, from 6 PM.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'reservations-table',
            alt: 'An intimate table for two set with linen, lit candle, water glasses — the seat that waits for you.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'obsidian',
          eyebrow: 'Reservations',
          title: 'Six weeks ahead.',
          body: 'Reservations open six weeks before the date. Dinner only, Tuesday to Saturday. Last seating is at 9:30 PM; the bar takes walk-ins until 11.',
        }),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'reservations@maisonbrulee.example',
            href: 'mailto:reservations@maisonbrulee.example',
            description: 'Read by Felix every morning.',
          },
          phone: {
            value: '+1 212 555 0148',
            href: 'tel:+12125550148',
            description: 'Tuesday to Saturday, three to six.',
          },
          address: {
            value: '212 Cornelia Street',
            description: 'Between Bleecker and West Fourth. Subway: West Fourth.',
          },
          hours: {
            value: 'Tuesday to Saturday, 6 PM — late',
            description: 'Closed Sunday and Monday.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Request a table',
            intro:
              'Date, party size, any dietary notes. We will reply within twenty-four hours to confirm or suggest alternatives.',
            submitLabel: 'Send request',
            successHeadline: 'We have your request.',
            successBody:
              'Felix will reply by email within twenty-four hours. If your date is sooner than that, call us.',
          }),
        ),
      ],
    },

    // ─── PRESS ────────────────────────────────────────────────────
    {
      slug: 'press',
      title: 'Press',
      seoTitle: 'Press — Maison Brûlée',
      seoDescription:
        'Selected press, reviews, and awards for Maison Brûlée since 2017.',
      sections: [
        oneCol(
          'obsidian',
          'sm',
          coverImage({
            imageKey: 'press-night',
            alt: 'The Maison Brûlée exterior glowing warmly at night with a quiet street view.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'darken',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Press',
          title: 'What people have written.',
          body: 'Selected pieces from the past seven years. For press enquiries, please write to press@maisonbrulee.example.',
          tone: 'obsidian',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: '2024 · The Times',
              title: '"The kitchen at the end of a long block"',
              body: 'A full-page feature on Esme’s return from Copenhagen and the seven-year arc of the restaurant. By J. Mancini.',
              cta: { label: 'Read the piece', href: '/press' },
            },
            {
              kicker: '2023 · A. Verma',
              title: '"One fire, one Esme"',
              body: 'A four-star review by the city’s most-read food writer. Subscriber link on request.',
              cta: { label: 'Read the review', href: '/press' },
            },
            {
              kicker: '2023 · The Guide',
              title: 'Best new restaurants',
              body: 'Listed at number 3 in the city’s best-new-restaurants guide. Six years after opening, the listing called us out for "quiet endurance over hype."',
            },
            {
              kicker: '2022 · Wine & Spirits',
              title: 'Wine list of the year, finalist',
              body: 'One of five finalists in the wine list of the year category. Sommelier Marta Quinones noted in the citation.',
            },
            {
              kicker: '2021 · Bon Goût',
              title: '"A neighborhood restaurant"',
              body: 'A long-form piece on the difference between destination dining and the actual neighborhood restaurant. Maison Brûlée is the central example.',
            },
            {
              kicker: '2019 · The Standard',
              title: 'Chef of the year, shortlisted',
              body: 'Esme Lacroix shortlisted for the city’s chef of the year. The piece ran with a photo of the wood oven, not of the chef — which she preferred.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Press enquiries',
          body: 'For interviews, photography, or a copy of the press kit, write to press@maisonbrulee.example. We reply within one business day.',
          cta: { label: 'Press contact', href: 'mailto:press@maisonbrulee.example' },
        }),
      ],
    },
  ],
}
