import type { SiteTemplate } from './types'
import {
  action,
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
  threeCols,
} from './_shared'

// Hôtel Solenne — boutique hotel template.
// 5 pages: Home, Rooms, Dining, Story, Reservations.
//
// Voice: hospitality, quiet confidence. Sentences land softly. Numbers
// are restrained (no "luxury 5-star award-winning"). The hotel knows
// it's special and doesn't have to shout.
//
// Visual rhythm (cover heroes):
//   Home          chandelier in darkness — center, full splash, darken
//   Rooms         airy boutique bedroom — bottom-left, gradient, lg
//   Dining        dim restaurant interior — center-right, darken, lg
//   Story         overcast facade — bottom-center, gradient, lg
//   Reservations  brass bell close-up — bottom-left, darken, md
// No two pages open the same way; sub-pages stay shorter than the
// splash so the editorial sections below get visual share.

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
        // Splash hero — a single ornate chandelier suspended in deep
        // darkness, anchoring the brand mark and reservation CTA in
        // the center of the frame. Center overlay alignment is
        // reserved for this one page; every sub-page uses an
        // off-center anchor for editorial weight. Overlay 'darken' is
        // light (≈15%) so the chandelier's warm gold stays vivid
        // under the copy instead of being crushed to black by the
        // default gradient-bottom.
        heroCover({
          imageKey: 'home-hero-facade',
          alt: 'A single ornate chandelier suspended in deep darkness — the kind of small grandeur that opens the evening at Hôtel Solenne.',
          eyebrow: 'Hôtel Solenne',
          title: 'A quieter way to stay.',
          body: 'Forty rooms above a small garden courtyard. Linen sheets, low lamps, and a kitchen that opens for breakfast at six and supper at six again.',
          cta: { label: 'Reserve a room', href: '/reservations' },
          overlayAlignment: 'center',
          overlay: 'darken',
          minHeight: 'xl',
          ratio: '21:9',
        }),

        // The hotel, briefly — 3 cards on warm ivory, the editorial
        // counterpoint to the obsidian splash above.
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

        // Editorial photo: the small sitting room off the lobby —
        // striped wallpaper, deep couches, a single warm lamp pool.
        // The visual evidence of the "low lamps" mentioned in the
        // hero copy.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'home-lobby',
            alt: 'A dim sitting room off the lobby — striped wallpaper, deep couches, a single warm lamp pool of light.',
            ratio: '16:9',
            corners: 'sharp',
            animation: 'fade-in',
          }),
        ),

        // By the numbers — restraint. Sits on obsidian, separating
        // the cream sitting-room photo above from the cream guest
        // letter below.
        statRow({
          background: 'obsidian',
          stats: [
            { value: 40, label: 'rooms' },
            { value: 1882, label: 'built' },
            { value: 24, label: 'staff' },
          ],
        }),

        // A guest letter — champagne ground for warmth, sits between
        // two darker bands so it reads as the emotional peak.
        oneCol(
          'champagne',
          'lg',
          eyebrow('From a guest', { tone: 'obsidian' }),
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
          background: 'near-black',
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
        // Sub-page hero: airy classical boutique bedroom — tall
        // window, button-tufted headboard, white linen. The photo is
        // already bright, so default gradient-bottom + bottom-left
        // copy holds. minHeight: 'lg' (not xl) yields a shorter
        // hero so the eight-room grid below claims more visual share.
        heroCover({
          imageKey: 'rooms-hero',
          alt: 'A quiet boutique hotel room — tall window, ivory curtains, a button-tufted headboard, white linen, a brass table lamp.',
          eyebrow: 'The rooms',
          title: 'Eight quiet shapes.',
          body: 'Every room faces either the courtyard garden or the lane behind it. Linen sheets, blackout curtains, a deep bath in the suites, a writing desk by every window.',
          overlayAlignment: 'bottom-left',
          overlay: 'gradient-bottom',
          minHeight: 'lg',
          ratio: '21:9',
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

        // Editorial pair: marble bath beside the Suite Solenne
        // sitting room — the visual case for choosing the upper
        // tiers. Set on champagne (not ivory) so it reads as the
        // signature moment between the room grid and the rooftop
        // garret figure that follows on cream.
        oneCol(
          'champagne',
          'lg',
          imagePair({
            leftImageKey: 'rooms-deluxe-bath',
            leftAlt: 'The marble bath in a Deluxe room — freestanding tub, brass fittings.',
            rightImageKey: 'rooms-suite-solenne',
            rightAlt: 'The Suite Solenne sitting room — chesterfield sofas, a small crystal chandelier, a tufted headboard glimpsed through the doorway.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        // Le Grenier — the rooftop garret. Single figure, generous
        // space. Cream ground for breathing room before the dark
        // "what does not change" stripe that follows.
        oneCol(
          'cream',
          'lg',
          figure({
            imageKey: 'rooms-grenier',
            alt: 'Le Grenier — the private rooftop terrace at sunset, looking out over the city.',
            ratio: '21:9',
            caption: 'Le Grenier — the top-floor garret, with a private rooftop terrace.',
            animation: 'fade-in',
          }),
        ),

        // What is in every room — moved to obsidian for the
        // restrained-luxury voice, and so the three-column "Linen /
        // Quiet / Care" reads like a quiet manifest panel rather
        // than another champagne note.
        oneCol(
          'obsidian',
          'md',
          eyebrow('In every room', { tone: 'champagne' }),
          heading('What does not change', {
            level: 'h2',
            size: 'display-md',
            tone: 'ivory',
            marginTop: 'sm',
          }),
        ),
        threeCols(
          'obsidian',
          'md',
          [
            heading('Linen', {
              level: 'h3',
              size: 'display-sm',
              tone: 'ivory',
              animation: 'fade-in',
            }),
            text(
              'White cotton percale, ironed in-house. A fresh set every night for stays longer than three.',
              { tone: 'ivory', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
          [
            heading('Quiet', {
              level: 'h3',
              size: 'display-sm',
              tone: 'ivory',
              animation: 'fade-in',
            }),
            text(
              'Triple-glazed windows. No televisions in the bedrooms — the sitting rooms in the suites have one, behind a panel.',
              { tone: 'ivory', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
          [
            heading('Care', {
              level: 'h3',
              size: 'display-sm',
              tone: 'ivory',
              animation: 'fade-in',
            }),
            text(
              'Pressing on the same day. A laundry pickup at eight; back, sealed, by six. Shoes shined at the desk on request.',
              { tone: 'ivory', maxWidth: 'wide', marginTop: 'xs' },
            ),
          ],
        ),

        ctaBanner({
          background: 'champagne',
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
        // Sub-page hero: the dining room itself — already dim, warm
        // pendant lights, intimate. Overlay 'darken' (light) keeps
        // the warm glow visible; gradient-bottom would crush the
        // bottom half black. Copy lifts off the photo's right side
        // where the kitchen pass would be — center-right alignment
        // pulls the eye into the open room.
        heroCover({
          imageKey: 'dining-restaurant',
          alt: 'The Hôtel Solenne dining room — set tables, low light, the warm glow of pendant lamps over the pass.',
          eyebrow: 'The kitchen',
          title: 'Two services a day.',
          body: 'Breakfast from six until ten. Supper from six until ten. The bar between is open for tea, for an early drink, and for the kind of conversation that the dining room is too bright for.',
          overlayAlignment: 'center-right',
          overlay: 'darken',
          minHeight: 'lg',
          ratio: '16:9',
        }),

        // The restaurant — on bone (lighter than ivory) to read as
        // a fresh editorial column after the dim hero.
        oneCol(
          'bone',
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

        // Two signature dishes — trout opening, tart closing — on
        // champagne so the dishes read as the brand's gold thread
        // between the menu list and the bar passage.
        oneCol(
          'champagne',
          'lg',
          imagePair({
            leftImageKey: 'dining-dish-trout',
            leftAlt: 'Cured trout with fennel and lemon oil — the opening course.',
            rightImageKey: 'dining-dish-dessert',
            rightAlt: 'Tarte fine aux pommes — the kitchen’s closing course.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

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

        // The bar itself — the dim, bottle-lined shelves photo. Sits
        // flush against the near-black copy above so the photo reads
        // as a continuation of the same intimate room.
        oneCol(
          'near-black',
          'md',
          figure({
            imageKey: 'dining-bar',
            alt: 'The Hôtel Solenne bar — dimly lit, bottle-lined shelves, a dozen stools.',
            ratio: '16:9',
            caption: 'The bar off the lobby — twelve seats, three hundred bottles.',
            animation: 'fade-in',
          }),
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
        // Sub-page hero: 19th-century brick townhouses, the era the
        // hotel was built in. The sky is overcast (light), so default
        // gradient-bottom holds the title. Bottom-center alignment is
        // unique to this page — anchors the "Since 1882" beat under
        // the architecture and gives the heritage page its own grammar.
        heroCover({
          imageKey: 'story-townhouse',
          alt: 'A row of 19th-century brick townhouses with white trim — the era the hotel was built in.',
          eyebrow: 'Since 1882',
          title: 'Seven chapters, one house.',
          body: 'The building was a townhouse first, then a boarding house, then a hotel from 1924. Six families have owned it. We are the seventh, and we restored it slowly between 2019 and 2023.',
          overlayAlignment: 'bottom-center',
          overlay: 'gradient-bottom',
          minHeight: 'lg',
          ratio: '21:9',
        }),

        // Chapter one — on ivory, classical editorial column.
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

        // The building tonight — the ornate facade illuminated at
        // dusk. Sits between chapter one (the build) and the tile
        // hallway (the inside), giving the narrative a clean
        // outside → inside arc.
        oneCol(
          'near-black',
          'lg',
          figure({
            imageKey: 'home-facade-dusk',
            alt: 'The Hôtel Solenne facade illuminated at dusk — balconies aglow, ornate stonework against the evening sky.',
            ratio: '4:5',
            caption: 'The facade at dusk — 1882, restored 2019–2023.',
            animation: 'fade-in',
          }),
        ),

        // Original tiled floors — the interior detail that survived.
        oneCol(
          'ivory',
          'md',
          figure({
            imageKey: 'story-hallway-tile',
            alt: 'A period hallway with tiled walls and a hexagonal patterned floor — the kind of architectural detail kept through the restoration.',
            ratio: '16:9',
            caption: 'The original tiled floors, kept during the 2019–2023 restoration.',
            animation: 'fade-in',
          }),
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
          background: 'near-black',
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
        // Sub-page hero: brass service bell close-up — the smallest
        // and most intimate hero of the five. minHeight 'md' + ratio
        // 16:9 keeps it deliberately short — reservations is a
        // service page, the work happens in the form below, the hero
        // is a mood-setter not a marquee. overlay 'darken' deepens
        // the wood tones behind the bell so the ivory copy reads.
        heroCover({
          imageKey: 'reservations-hero',
          alt: 'A vintage brass service bell on a wooden reception desk — the front desk at Hôtel Solenne.',
          eyebrow: 'Reservations',
          title: 'When would you like to stay?',
          body: 'Reservations open twelve months ahead. Tell us your dates, the kind of room you would like, and any small thing we should know — a quiet floor, a late arrival, a cake at the table.',
          overlayAlignment: 'bottom-left',
          overlay: 'darken',
          minHeight: 'md',
          ratio: '16:9',
        }),

        contactChannels({
          background: 'near-black',
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
