import type { SiteTemplate } from './types'
import {
  contactChannels,
  contactForm,
  coverImage,
  ctaBanner,
  figure,
  hero,
  imagePair,
  oneCol,
  quote,
  statRow,
  threeColCards,
} from './_shared'

// Grace Hill — warm community church.
// 5 pages: Home, Sermons, Service Times, Ministries, Giving.
// Voice: warm, plain, no church-marketing clichés. Real names, real
// places, real times.

export const graceHillTemplate: SiteTemplate = {
  slug: 'grace-hill',
  name: 'Grace Hill',
  kind: 'Church',
  tagline: 'Come as you are.',
  description:
    'A warm community church template. Service times, sermons, ministries, giving, prayer requests. Built for churches that want a website that does not feel like a church website.',
  vibe: 'church',
  themePalette: {
    bg: '#faf6ee',
    fg: '#1c1814',
    accent: '#8a6a4c',
    muted: '#867e72',
  },
  branding: {
    brandText: 'Grace Hill',
    headerTheme: 'cream',
    primaryNav: [
      { label: 'Sermons', href: '/sermons' },
      { label: 'Service times', href: '/service-times' },
      { label: 'Ministries', href: '/ministries' },
      { label: 'Giving', href: '/giving' },
    ],
    primaryCta: { text: "I'm new — plan a visit", href: '/service-times' },
    footerColumns: [
      {
        label: 'Sundays',
        links: [
          { text: 'Service times', href: '/service-times' },
          { text: 'Sermons', href: '/sermons' },
        ],
      },
      {
        label: 'Week',
        links: [
          { text: 'Ministries', href: '/ministries' },
          { text: 'Giving', href: '/giving' },
        ],
      },
    ],
    footerTagline: 'Come as you are.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Grace Hill',
      isHome: true,
      seoTitle: 'Grace Hill — Come as you are',
      seoDescription:
        'A community church. Two Sunday services, ministries through the week, and a building that is open most weekdays.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'home-hero-sanctuary',
            alt: 'Grace Hill sanctuary — empty wooden pews with soft daylight through the tall windows.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Welcome',
          title: 'Come as you are.',
          body: 'Grace Hill is a small church on a hill above the river. We meet on Sunday mornings at nine and eleven. We sing, we read, we pray together, and afterwards there is coffee for whoever wants to stay.',
          cta: { label: 'Plan a visit', href: '/service-times' },
          secondaryCta: { label: 'Listen to a sermon', href: '/sermons' },
          tone: 'obsidian',
        }),

        ...threeColCards({
          background: 'bone',
          sectionTitle: 'A short answer to "what is it like?"',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'Sunday morning',
              title: 'Songs, scripture, a short sermon',
              body: 'About seventy minutes. Five or six songs, a reading from the Old and New Testaments, a sermon of about twenty-five minutes. Children stay in for the songs, then leave for their own time.',
            },
            {
              kicker: 'Through the week',
              title: 'Ministries you can come or skip',
              body: 'A men’s breakfast on Wednesdays, a women’s study on Tuesdays, a youth group on Friday evenings. None of them feel like homework.',
            },
            {
              kicker: 'When you visit',
              title: 'What to wear, where to park',
              body: 'Wear what you would on a Saturday morning. Park behind the building or in the school lot across the road. The first ten minutes of every service are unscripted.',
            },
          ],
        }),

        statRow({
          background: 'champagne',
          stats: [
            { value: 1973, label: 'planted', tone: 'obsidian' },
            { value: 320, label: 'in the family', tone: 'obsidian' },
            { value: 12, label: 'ministries', tone: 'obsidian' },
          ],
        }),

        // Pair: the congregation from inside, the church from outside.
        oneCol(
          'cream',
          'lg',
          imagePair({
            leftImageKey: 'home-community',
            leftAlt: 'A small congregation seated in wooden pews during a Sunday service.',
            rightImageKey: 'visit-welcome',
            rightAlt: 'The Grace Hill church building framed by autumn trees on a clear day.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        oneCol(
          'cream',
          'lg',
          quote(
            '"I came on a Sunday because a friend invited me. I stayed because nobody pretended I was already a Christian."',
            'Member, joined 2022',
            { tone: 'obsidian', alignment: 'center' },
          ),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'New here?',
          body: 'Send us a note before Sunday and someone will meet you at the door. No follow-up calls, no mailing list, just a friendly face.',
          cta: { label: 'Plan a visit', href: '/service-times' },
        }),
      ],
    },

    // ─── SERMONS ──────────────────────────────────────────────────
    {
      slug: 'sermons',
      title: 'Sermons',
      seoTitle: 'Sermons — Grace Hill',
      seoDescription:
        'Recent sermons from Grace Hill. Each one is about twenty-five minutes, with the audio posted by Sunday evening.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'sermons-pulpit',
            alt: 'An open Bible resting on a simple wooden pulpit, warm light.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Recent sermons',
          title: 'Twenty-five minutes, give or take.',
          body: 'Our pastor records each Sunday morning and the audio is posted by the evening. The current series is on the Sermon on the Mount; the next series, beginning in autumn, will be on the book of Ruth.',
          tone: 'obsidian',
        }),

        // Pastor intro figure — grounds the sermons in a real person.
        oneCol(
          'ivory',
          'md',
          figure({
            imageKey: 'about-pastor',
            alt: 'Pastor John — a warm portrait in soft natural light.',
            ratio: '4:5',
            caption: 'Pastor John records each Sunday morning.',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'May 18 · Matthew 7',
              title: 'Two houses, two foundations',
              body: 'The closing image of the Sermon on the Mount. Pastor John on what builds a life that does not collapse when the rain comes.',
              cta: { label: 'Listen', href: '/sermons' },
            },
            {
              kicker: 'May 11 · Matthew 6',
              title: 'On worry',
              body: 'A reading and an honest sermon on anxiety, money, and the practice of not borrowing tomorrow’s trouble.',
              cta: { label: 'Listen', href: '/sermons' },
            },
            {
              kicker: 'May 4 · Matthew 6',
              title: 'A way to pray',
              body: 'The Lord’s Prayer line by line. Not a magic formula — a shape for the kind of prayer Jesus thought we should learn.',
              cta: { label: 'Listen', href: '/sermons' },
            },
            {
              kicker: 'Apr 27 · Matthew 5',
              title: 'Salt and light',
              body: 'On the small, everyday witness of a life that has been changed.',
              cta: { label: 'Listen', href: '/sermons' },
            },
            {
              kicker: 'Apr 20 · Easter',
              title: 'He is risen',
              body: 'The Easter morning sermon. Pastor John on the difference Sunday makes.',
              cta: { label: 'Listen', href: '/sermons' },
            },
            {
              kicker: 'Apr 13 · Palm Sunday',
              title: 'The donkey and the king',
              body: 'A short sermon on the upside-down kingdom that arrived on a borrowed donkey.',
              cta: { label: 'Listen', href: '/sermons' },
            },
          ],
        }),

        // Quiet figure between the sermons grid and the closing CTA.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'sermons-listening',
            alt: 'A hymnal at rest on an empty wooden church pew.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        ctaBanner({
          background: 'obsidian',
          title: 'Looking for a specific sermon?',
          body: 'The full archive is searchable by book, theme, and date. Or write to us and we will send you a recording.',
          cta: { label: 'Ask for a sermon', href: '/giving#contact' },
        }),
      ],
    },

    // ─── SERVICE TIMES ────────────────────────────────────────────
    {
      slug: 'service-times',
      title: 'Service times',
      seoTitle: 'Service times — Grace Hill',
      seoDescription:
        'Two Sunday services at nine and eleven. The eleven o’clock has full children’s programmes.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'events-hall',
            alt: 'The Grace Hill fellowship hall — rows of tables and chairs set for a community gathering.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'When we meet',
          title: 'Sundays at nine and eleven.',
          body: 'Two services every Sunday, identical in content. The nine o’clock is smaller and quieter; the eleven o’clock has the full children’s programme and a longer coffee time afterwards.',
          tone: 'obsidian',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Sunday · 9:00 AM',
              title: 'Early service',
              body: 'About a hundred people. No children’s programme — families with young children typically come to the eleven. Out by 10:10.',
            },
            {
              kicker: 'Sunday · 11:00 AM',
              title: 'Late service',
              body: 'About two hundred people. Children up to twelve are dismissed after the songs for their own time. Coffee in the courtyard from 12:15.',
            },
            {
              kicker: 'When you arrive',
              title: 'What happens, where to go',
              body: 'A greeter at the door, a programme in your hand. Sit anywhere; the front rows are not reserved. The nursery is to the right of the lobby for under-threes.',
            },
            {
              kicker: 'On a Wednesday',
              title: 'Midweek prayer',
              body: 'A small gathering at 7:30 PM in the chapel. Quieter, more conversational. Open to anyone.',
            },
            {
              kicker: 'On a Friday',
              title: 'Youth night',
              body: 'For ages 11 to 17. From 7:00 to 9:00 PM in the youth room. Games, food, a short talk, prayer.',
            },
            {
              kicker: 'Special services',
              title: 'Easter, Christmas, Good Friday',
              body: 'The dates and times go up about a month ahead. The Christmas Eve service is at 5:00 PM and is always full — come early.',
            },
          ],
        }),

        ctaBanner({
          background: 'champagne',
          title: 'Coming on Sunday?',
          body: 'Tell us you’re coming and a member of the welcome team will meet you at the door, no follow-up calls.',
          cta: { label: 'Plan your visit', href: '/giving#contact' },
          tone: 'obsidian',
        }),
      ],
    },

    // ─── MINISTRIES ───────────────────────────────────────────────
    {
      slug: 'ministries',
      title: 'Ministries',
      seoTitle: 'Ministries — Grace Hill',
      seoDescription:
        'Twelve ministries through the week. Men, women, youth, children, music, prayer, mercy, and a few more.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'ministries-music',
            alt: 'Sheet music resting on a warm brown upright piano in the church hall.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Through the week',
          title: 'Twelve quiet rhythms.',
          body: 'Ministries at Grace Hill are small — most have between eight and twenty people, and most meet weekly. Each one has a name and a phone number on this page; ring them, do not just turn up cold.',
          tone: 'obsidian',
        }),

        // Pair: children's craft table beside the foodbank — two of the
        // ministries' visual moods, side by side.
        oneCol(
          'cream',
          'lg',
          imagePair({
            leftImageKey: 'ministries-children',
            leftAlt: "A children's craft table — paper, crayons, scissors arranged before a Sunday-school session.",
            rightImageKey: 'ministries-outreach',
            rightAlt: 'Hands packing labelled food parcels for the monthly community foodbank.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Tuesday morning · 10:00',
              title: 'Women’s study',
              body: 'About fifteen women, currently working through 1 Peter. Coffee, childcare for under-fives. Led by Sara Mansour.',
            },
            {
              kicker: 'Wednesday morning · 6:30',
              title: 'Men’s breakfast',
              body: 'About twenty men, in the church hall. Eggs, coffee, a fifteen-minute talk, conversation. Led by Tomás Reyes.',
            },
            {
              kicker: 'Wednesday evening · 7:30',
              title: 'Midweek prayer',
              body: 'In the chapel. Quieter, conversational, about thirty people. Newcomers welcome — you don’t need to pray out loud.',
            },
            {
              kicker: 'Friday evening · 7:00',
              title: 'Youth group',
              body: 'Ages 11–17. Games, food, a short talk. Led by Mira Acheampong and a team of four.',
            },
            {
              kicker: 'Sundays · childcare',
              title: 'Sunday school',
              body: 'During both services. Three groups by age. Background-checked volunteers, two adults per room minimum.',
            },
            {
              kicker: 'Music',
              title: 'Worship team',
              body: 'Six musicians on rotation. Rehearsal Thursday evenings. Anyone with an instrument who can read music is welcome to audition.',
            },
            {
              kicker: 'Tuesday afternoon · 2:00',
              title: 'Mercy team',
              body: 'A team that visits members in hospital or housebound. Coordinated by Mira Acheampong; on a roster, about an hour per week.',
            },
            {
              kicker: 'First Saturday',
              title: 'Foodbank',
              body: 'A monthly community foodbank, in partnership with two other churches. About twenty volunteers each time.',
            },
            {
              kicker: 'Asked often',
              title: 'A ministry that is not listed?',
              body: 'Send us a note and we will tell you what is starting up. Some of our best ministries began as a need someone wrote in.',
            },
          ],
        }),
      ],
    },

    // ─── GIVING ───────────────────────────────────────────────────
    {
      slug: 'giving',
      title: 'Giving',
      seoTitle: 'Giving & prayer — Grace Hill',
      seoDescription:
        'How to give to Grace Hill, and how to send us a prayer request. Both go to the same office and both are read.',
      sections: [
        oneCol(
          'cream',
          'sm',
          coverImage({
            imageKey: 'about-history',
            alt: 'A small historic white clapboard church with a slim steeple — the kind of building Grace Hill is.',
            ratio: '21:9',
            minHeight: 'lg',
            overlay: 'none',
            animation: 'fade-in',
          }),
        ),

        hero({
          background: 'cream',
          eyebrow: 'Giving & prayer',
          title: 'Two ways to be part of the work.',
          body: 'Grace Hill is supported by the people who come — there is no national headquarters, no central denomination, no other income. We also receive prayer requests through the same office, and both are read by a real person.',
          tone: 'obsidian',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'One-time gift',
              title: 'By card, by cheque, in the basket',
              body: 'A card form is on the church website. Cheques go to "Grace Hill Trust." There is also a basket at the back of the church on Sunday; nobody passes a plate.',
            },
            {
              kicker: 'Monthly',
              title: 'Standing order',
              body: 'Most regular giving is by standing order. The bank details are at the welcome desk and on the giving form. We never ask for credit-card data over the phone.',
            },
            {
              kicker: 'In kind',
              title: 'Food, time, things',
              body: 'The foodbank takes monthly grocery donations. The mercy team takes home-cooked meals on a roster. The music team takes second-hand instruments in working order.',
            },
          ],
        }),

        // Quiet figure between the giving cards and the contact details.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'give-stewardship',
            alt: 'A quiet detail of a brown wooden church pew — contemplative and still.',
            ratio: '16:9',
            animation: 'fade-in',
          }),
        ),

        contactChannels({
          background: 'obsidian',
          email: {
            value: 'office@gracehill.example',
            href: 'mailto:office@gracehill.example',
            description: 'Read by the church administrator every weekday.',
          },
          phone: {
            value: '+1 615 555 0193',
            href: 'tel:+16155550193',
            description: 'Tuesday to Friday, ten to four.',
          },
          address: {
            value: '212 Hill Road, Grace Hill',
            description: 'Open most weekdays — knock at the office door.',
          },
        }),

        oneCol(
          'obsidian',
          'md',
          contactForm({
            heading: 'Send a prayer request',
            intro:
              'Anything you would like prayed for. Your name and email are held in confidence — only the pastor and the prayer team see your request.',
            submitLabel: 'Send prayer request',
            successHeadline: 'We have your request — thank you.',
            successBody:
              'The prayer team will pray for you in the coming week. The pastor will reply by email if you asked us to.',
          }),
        ),
      ],
    },
  ],
}

