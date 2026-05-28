import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  ctaBanner,
  eyebrow,
  figure,
  heading,
  heroCover,
  imagePair,
  oneCol,
  statRow,
  text,
  threeColCards,
} from './_shared'

// Maison Brûlée — neighborhood fine-dining restaurant.
// 5 pages: Home, Menu, Story, Reservations, Press.
// Voice: quiet, lived-in, restrained. No florid food-adjectives. Lyon
// bistro tempered by a Tokyo neighborhood izakaya's restraint.
//
// Identity contrast with Hôtel Solenne (the hotel template) — Solenne
// runs champagne + obsidian. Maison Brûlée leans WARMER: terracotta /
// copper / wood-ember accents (copper-tint background, warm-stone tone),
// near-black for evening service, then breaks to cream + bone for the
// daylight craft + ingredient editorial. Heroes rotate their overlay
// anchor across pages so no two openings feel alike.

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
    // Centered overlay on a candlelit dining-room photo. The reserve-
    // a-table CTA is the focal point of the first impression — the
    // whole page exists to land that one click. `overlay: 'darken'`
    // (not gradient-bottom) keeps candlelight and tabletop details
    // legible behind the centered copy.
    {
      slug: 'home',
      title: 'Maison Brûlée',
      isHome: true,
      seoTitle: 'Maison Brûlée — A table worth keeping',
      seoDescription:
        'A neighborhood restaurant. Thirty-six seats, one wood-fired oven, dinner Tuesday to Saturday.',
      sections: [
        heroCover({
          imageKey: 'home-hero-room',
          alt: 'The Maison Brûlée dining room at evening service — bare wood tables set with candles, an intimate near-empty room waiting for the first sitting.',
          background: 'obsidian',
          ratio: '16:9',
          minHeight: 'xl',
          overlay: 'darken',
          overlayAlignment: 'center',
          overlayTone: 'ivory',
          eyebrow: 'Since 2017',
          title: 'A table worth keeping.',
          body: 'Thirty-six seats around a single open kitchen. One wood-fired oven, lit at four. Dinner only, Tuesday to Saturday.',
          cta: { label: 'Book a table', href: '/reservations' },
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

        // The bar — wine list lives behind it. A breath of obsidian
        // between the cream cards and the warm copper closing quote.
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

        // copper-tint — warmer than champagne, distinct from Solenne.
        // The closing quote sits in the warmer half of the palette
        // before the obsidian CTA banner closes the page.
        closingQuote({
          background: 'copper-tint',
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
    // Cinematic 21:9 hero anchored bottom-center over the wine-pour
    // photo. The wine glass is the gravity well; copy sits beneath
    // it so the eye lands on the pour first, then reads the text.
    {
      slug: 'menu',
      title: 'Menu',
      seoTitle: 'Menu — Maison Brûlée',
      seoDescription:
        'This week’s menu. Six starters, eight mains, three desserts. Changes every Tuesday.',
      sections: [
        heroCover({
          imageKey: 'menu-wine',
          alt: 'A hand pouring red wine into a glass at a candlelit table — the slow moment that opens dinner.',
          background: 'near-black',
          ratio: '21:9',
          minHeight: 'lg',
          overlay: 'darken',
          overlayAlignment: 'bottom-center',
          overlayTone: 'ivory',
          eyebrow: 'This week',
          title: 'Six, eight, three.',
          body: 'Six starters, eight mains, three desserts. The menu refreshes every Tuesday — whatever the suppliers brought on Monday is what we cook.',
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

        // Pair: a starter and a dessert at the seam between courses.
        // Lift-right so the dessert visually drops onto the page like
        // a final plate set down.
        oneCol(
          'ivory',
          'lg',
          imagePair({
            leftImageKey: 'menu-starter',
            leftAlt: 'A crudo starter on a cream-rimmed plate with herbs and citrus — restrained, hand-finished.',
            rightImageKey: 'menu-dessert',
            rightAlt: 'A warm rustic tart with poached fruit and cream, photographed in soft natural light.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Mains break to bone so the white-on-white starter > mains
        // rhythm doesn't feel one-note.
        ...threeColCards({
          background: 'bone',
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

        // A single mains figure — handmade pasta — sits in bone so
        // the photo carries the section's warmth without a hard
        // background break.
        oneCol(
          'bone',
          'md',
          figure({
            imageKey: 'menu-main',
            alt: 'A hand-rolled pasta main twirled on a rustic plate with grated cheese and torn herbs.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        // Desserts on copper-tint — the warmest section of the menu,
        // reserved for the warmest course.
        ...threeColCards({
          background: 'copper-tint',
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
    // Editorial short hero — a 21:9 strip with `minHeight: md` and
    // copy lifted into the top-left corner so it reads like a
    // magazine column header sitting above the facade photo, not a
    // marketing banner. Long-form text follows.
    {
      slug: 'story',
      title: 'Story',
      seoTitle: 'Story — Maison Brûlée',
      seoDescription:
        'Esme Lacroix opened Maison Brûlée in 2017 with the wood oven she had cooked on since culinary school.',
      sections: [
        heroCover({
          imageKey: 'story-facade',
          alt: 'The Maison Brûlée facade at twilight — warm yellow window glow spilling onto wet pavement, a quiet street.',
          background: 'near-black',
          ratio: '21:9',
          minHeight: 'md',
          overlay: 'darken-strong',
          overlayAlignment: 'top-left',
          overlayTone: 'ivory',
          eyebrow: 'Since 2017',
          title: 'One chef, one fire.',
          body: 'Opened in May 2017. The wood oven was the first thing installed in the empty room.',
        }),

        // Long-form text section — the editorial body that the short
        // hero introduces. Generous vertical space, narrow column.
        oneCol(
          'ivory',
          'xl',
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
            { tone: 'obsidian', marginTop: 'md', size: 'body-lg' },
          ),
          text(
            'The room sat empty for fourteen months before she signed the lease. She walked past it every week from a flat two blocks over, looking in through the brown paper on the windows, sketching the kitchen on napkins. The lease was signed on a Tuesday in March. The oven arrived from Italy six weeks later.',
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

        // The wood oven — the centerpiece of the restaurant gets its
        // own full-width frame on near-black so the flame carries the
        // whole section.
        oneCol(
          'near-black',
          'lg',
          figure({
            imageKey: 'story-oven',
            alt: 'The wood-fired oven at the heart of the kitchen — flames inside the brick arch, embers banked to one side.',
            ratio: '21:9',
            caption: 'A Mugnaini, imported from Italy in spring 2017. Apple wood. Lit at four.',
            animation: 'fade-in',
          }),
        ),

        // Daylight break — fresh produce on butcher block, the craft
        // half of the editorial.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'story-ingredients',
            alt: 'Fresh market herbs and produce arranged on a wooden butcher block in soft afternoon daylight.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        // Honest details — keep on bone so it sits between the cream
        // ingredient strip and the warm copper closing quote.
        ...threeColCards({
          background: 'bone',
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
          background: 'copper-tint',
          text: '"There is one fire, and one Esme. That is the secret. There is no other secret."',
          attribution: 'A. Verma, food writer, in a 2023 review',
        }),
      ],
    },

    // ─── RESERVATIONS ─────────────────────────────────────────────
    // 4:3 mid-height hero with copy anchored center-right over the
    // intimate two-top table. The right-side overlay reads almost
    // like a place card on the empty seat at the table — the seat
    // that's waiting for you. gradient-bottom keeps the candle and
    // linen detail readable.
    {
      slug: 'reservations',
      title: 'Reservations',
      seoTitle: 'Reservations — Maison Brûlée',
      seoDescription:
        'Reservations open six weeks ahead. Dinner only, Tuesday to Saturday, from 6 PM.',
      sections: [
        heroCover({
          imageKey: 'reservations-table',
          alt: 'An intimate two-top set for the evening — linen, a lit candle, two water glasses, a single bud in a small bottle.',
          background: 'obsidian',
          ratio: '4:3',
          minHeight: 'lg',
          overlay: 'gradient-bottom',
          overlayAlignment: 'center-right',
          overlayTone: 'ivory',
          eyebrow: 'Reservations',
          title: 'Six weeks ahead.',
          body: 'Dinner only, Tuesday to Saturday. Last seating 9:30 PM; the bar takes walk-ins until 11.',
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

        // Form breaks to near-black so it sits visually distinct
        // from the channel cards above and doesn't read as one
        // long obsidian wall.
        oneCol(
          'near-black',
          'lg',
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
    // Short editorial masthead — sm minHeight, 21:9, bottom-left
    // copy. Classic press-section banner, modest in height so the
    // list of pieces gets the page's real estate.
    {
      slug: 'press',
      title: 'Press',
      seoTitle: 'Press — Maison Brûlée',
      seoDescription:
        'Selected press, reviews, and awards for Maison Brûlée since 2017.',
      sections: [
        heroCover({
          imageKey: 'press-night',
          alt: 'The Maison Brûlée block at night — the restaurant window glowing warm against a quiet, unlit street.',
          background: 'obsidian',
          ratio: '21:9',
          minHeight: 'sm',
          overlay: 'gradient-bottom',
          overlayAlignment: 'bottom-left',
          overlayTone: 'ivory',
          eyebrow: 'Press',
          title: 'What people have written.',
          body: 'Selected pieces from the past seven years. For press enquiries, press@maisonbrulee.example.',
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

        // CTA on near-black, not obsidian — keeps the page closing
        // tone consistent with the warm rooms above and prevents a
        // hard hero/CTA bookend.
        ctaBanner({
          background: 'near-black',
          title: 'Press enquiries',
          body: 'For interviews, photography, or a copy of the press kit, write to press@maisonbrulee.example. We reply within one business day.',
          cta: { label: 'Press contact', href: 'mailto:press@maisonbrulee.example' },
        }),
      ],
    },
  ],
}
