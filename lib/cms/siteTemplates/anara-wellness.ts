import type { SiteTemplate } from './types'
import {
  closingQuote,
  contactChannels,
  contactForm,
  ctaBanner,
  figure,
  heroCover,
  imagePair,
  oneCol,
  threeColCards,
} from './_shared'

// Anara Wellness — serene spa.
// 5 pages: Home, Treatments, Practitioners, Journal, Booking.
// Voice: quiet, careful, restorative. Avoids wellness clichés
// ("self-care journey", "wellness experience"). Specifics, not adjectives.
//
// Visual rhythm: home hero is the only "screen" hero — centred,
// arresting. Every sub-page hero is shorter (md/lg) and uses a
// different overlay alignment so the pages feel sequenced, not
// duplicated. Overlay tone is chosen per-photo: dark text on the
// cream still life and historic exterior; ivory text on the moody
// water and the sunlit practitioner room.

export const anaraWellnessTemplate: SiteTemplate = {
  slug: 'anara-wellness',
  name: 'Anara Wellness',
  kind: 'Spa & wellness',
  tagline: 'Quiet, restored.',
  description:
    'A serene spa template. Treatments, practitioners, journal, booking, gift cards. Built for spas that want a website that feels like the lobby does.',
  vibe: 'wellness',
  themePalette: {
    bg: '#f4ede2',
    fg: '#1f1c18',
    accent: '#b88f6a',
    muted: '#7c7468',
  },
  branding: {
    brandText: 'Anara Wellness',
    headerTheme: 'cream',
    primaryNav: [
      { label: 'Treatments', href: '/treatments' },
      { label: 'Practitioners', href: '/practitioners' },
      { label: 'Journal', href: '/journal' },
      { label: 'Booking', href: '/booking' },
    ],
    primaryCta: { text: 'Book a treatment', href: '/booking' },
    footerColumns: [
      {
        label: 'Visit',
        links: [
          { text: 'Treatments', href: '/treatments' },
          { text: 'Booking', href: '/booking' },
        ],
      },
      {
        label: 'About',
        links: [
          { text: 'Practitioners', href: '/practitioners' },
          { text: 'Journal', href: '/journal' },
        ],
      },
    ],
    footerTagline: 'Quiet, restored.',
  },
  pages: [
    // ─── HOME ─────────────────────────────────────────────────────
    {
      slug: 'home',
      title: 'Anara Wellness',
      isHome: true,
      seoTitle: 'Anara Wellness — Quiet, restored',
      seoDescription:
        'A small wellness centre. Seven practitioners, twenty-two treatments, an unhurried hour and a half from arrival to leaving.',
      sections: [
        // Splash hero — centred title on a soft amber-on-linen still
        // life. The photo is bright cream, so the overlay reads in
        // obsidian and a gentle 'darken' keeps body copy legible
        // without flattening the light. Only the home page uses
        // 'screen' minHeight — sub-pages are shorter so the rhythm
        // builds toward the splash, not away from it.
        heroCover({
          imageKey: 'home-hero-still-life',
          alt: 'Anara Wellness — a single amber dropper bottle resting on raw linen, soft morning light.',
          eyebrow: 'Anara Wellness',
          title: 'Quiet, restored.',
          body: 'A small wellness centre in a converted nineteenth-century carriage house. Seven practitioners, twenty-two treatments, one entrance, no piped music.',
          cta: { label: 'Book a treatment', href: '/booking' },
          minHeight: 'screen',
          ratio: '4:3',
          overlay: 'darken',
          overlayAlignment: 'center',
          overlayTone: 'ivory',
          animation: 'parallax',
        }),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'What we offer, briefly',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: 'On the table',
              title: 'Massage, bodywork, facials',
              body: 'Swedish, deep tissue, lymphatic, Thai, prenatal. Three styles of facial. Sixty- and ninety-minute formats; some treatments at thirty minutes.',
              cta: { label: 'See treatments', href: '/treatments' },
            },
            {
              kicker: 'In the body',
              title: 'Acupuncture, cupping, herbal',
              body: 'A licensed traditional Chinese medicine practitioner sees patients three days a week. By referral or by direct booking.',
              cta: { label: 'About TCM', href: '/practitioners' },
            },
            {
              kicker: 'In the room',
              title: 'Steam, sauna, plunge',
              body: 'A small thermal suite — steam room, dry sauna, cold plunge — open to treatment guests for forty minutes before or after their appointment.',
              cta: { label: 'Visiting Anara', href: '/booking' },
            },
          ],
        }),

        // Editorial pair: the historic exterior beside the
        // sunlit courtyard — physical context for the centre.
        oneCol(
          'cream',
          'lg',
          imagePair({
            leftImageKey: 'villa-exterior',
            leftAlt: 'The Anara Wellness building — a nineteenth-century ivy-covered house behind a low white stone wall.',
            rightImageKey: 'courtyard',
            rightAlt: 'The Anara courtyard — sunlit, plant-filled, open-air calm.',
            layout: 'lift-left',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        closingQuote({
          background: 'bone',
          text: '"I have been three times. I have not yet seen the second floor. There is no rush to."',
          attribution: 'A member, since 2022',
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'When would you like to come?',
          body: 'Booking is online or by phone. Weekends are busier; if you can come on a weekday morning, the steam room is yours.',
          cta: { label: 'Book a treatment', href: '/booking' },
        }),
      ],
    },

    // ─── TREATMENTS ───────────────────────────────────────────────
    {
      slug: 'treatments',
      title: 'Treatments',
      seoTitle: 'Treatments — Anara Wellness',
      seoDescription:
        'Twenty-two treatments. Massage, bodywork, facials, acupuncture, cupping. Booked online or by phone.',
      sections: [
        // Treatments hero — atmospheric ritual still life (pampas
        // grass in amber bottle on linen pillows). Warm soft tones
        // dominate, so ivory text reads beautifully off a
        // gradient-bottom overlay anchored to bottom-left. Shorter
        // than the home hero so the page progresses.
        heroCover({
          imageKey: 'treatment-room',
          alt: 'A quiet treatment-room corner — pampas grass in an amber jar beside linen pillows.',
          eyebrow: 'Treatments',
          title: 'Twenty-two, written down.',
          body: 'Each treatment is described plainly. No "energy clearing," no claims our practitioners would not make to your face. If you do not know which to book, the booking page has a short questionnaire.',
          minHeight: 'lg',
          ratio: '16:9',
          overlay: 'gradient-bottom',
          overlayAlignment: 'bottom-left',
          overlayTone: 'ivory',
        }),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'Massage & bodywork',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '60 / 90 min · from $140',
              title: 'Swedish massage',
              body: 'Full-body classical Swedish technique. Long strokes, moderate pressure, focused on circulation and the release of held tension. With Marta, Daniel, or Yuki.',
            },
            {
              kicker: '60 / 90 min · from $160',
              title: 'Deep-tissue massage',
              body: 'Slower work into deeper layers of muscle. Indicated for chronic tension and post-training recovery, not for first-timers. With Daniel or Marta.',
            },
            {
              kicker: '60 / 90 min · from $150',
              title: 'Lymphatic drainage',
              body: 'A very light-pressure technique that follows the lymph system. Calming, often used post-surgery or for chronic inflammation. With Yuki.',
            },
            {
              kicker: '75 min · $170',
              title: 'Thai bodywork',
              body: 'Floor-based, fully clothed, more like assisted stretching than massage. Worth trying once. With Anu, twice a week.',
            },
            {
              kicker: '60 min · $150',
              title: 'Prenatal massage',
              body: 'Side-lying, full-body massage adapted for pregnancy. Cleared by your OB if you’re past twelve weeks. With Marta or Yuki.',
            },
            {
              kicker: '30 min · $80',
              title: 'Targeted neck-and-shoulder',
              body: 'A focused thirty-minute table session for the neck, shoulders, and upper back. Good for a lunch break. With any practitioner.',
            },
          ],
        }),

        ...threeColCards({
          background: 'cream',
          sectionTitle: 'Facials',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '60 min · $145',
              title: 'Classic facial',
              body: 'Cleanse, exfoliation, mask, massage, light extraction. Suitable for all skin types. With Lia or Sara.',
            },
            {
              kicker: '90 min · $200',
              title: 'Deep-clean facial',
              body: 'A more thorough extraction-led treatment with steam and a clay mask. Indicated for congested skin. With Lia.',
            },
            {
              kicker: '75 min · $185',
              title: 'Calming facial',
              body: 'A gentler treatment for sensitive or reactive skin. No essential oils, no extractions, no peels. With Sara.',
            },
          ],
        }),

        // Editorial pair between facials and acupuncture sections:
        // the dry sauna + the moment of touch (oiled-back massage).
        oneCol(
          'cream',
          'lg',
          imagePair({
            leftImageKey: 'treatment-sauna',
            leftAlt: 'The Anara dry sauna — wood-lined with sauna stones beside a small window.',
            rightImageKey: 'ritual-hands',
            rightAlt: 'A therapist working along an oiled back during a Swedish massage.',
            layout: 'lift-right',
            overlap: 'md',
            ratio: '4:5',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          sectionTitle: 'Acupuncture & TCM',
          sectionTone: 'obsidian',
          cards: [
            {
              kicker: '60 min · $135',
              title: 'Acupuncture, follow-up',
              body: 'Standard return session. About thirty minutes of needles, the rest taking history and on the after-care.',
            },
            {
              kicker: '90 min · $185',
              title: 'Acupuncture, first session',
              body: 'A first appointment includes a full intake — current symptoms, history, pulse and tongue diagnosis — before any needles.',
            },
            {
              kicker: '45 min · $110',
              title: 'Cupping',
              body: 'Stationary or sliding glass cupping for tension and circulation. Often combined with a brief massage. With Dr. Wen.',
            },
            {
              kicker: '30 min · $65',
              title: 'Herbal consult',
              body: 'A consultation with the TCM practitioner about a herbal formula, without acupuncture. Formula priced separately.',
            },
          ],
        }),

        ctaBanner({
          background: 'obsidian',
          title: 'Not sure which to book?',
          body: 'The booking page has a five-question intake that suggests two or three treatments. You can also call us — Felix at the front desk takes the time.',
          cta: { label: 'Start booking', href: '/booking' },
        }),
      ],
    },

    // ─── PRACTITIONERS ────────────────────────────────────────────
    {
      slug: 'practitioners',
      title: 'Practitioners',
      seoTitle: 'Practitioners — Anara Wellness',
      seoDescription:
        'Seven practitioners. Each one’s training, focus, and what they take seriously is written down here.',
      sections: [
        // Practitioners hero — a single editorial figure of quiet
        // practice (woman seated in a sun-filled room with incense).
        // Top-left overlay keeps the eye on the figure but sets the
        // tone immediately. The room is moody, so ivory text on a
        // soft 'darken' overlay reads cleanly.
        heroCover({
          imageKey: 'practitioner',
          alt: 'A practitioner at quiet practice — seated in a sun-filled room with the trail of an incense stick.',
          eyebrow: 'The practitioners',
          title: 'Seven people, full-time.',
          body: 'Each practitioner at Anara is full-time and at one centre only — ours. Training, focus, and the kind of client they are best with is written on each card below.',
          minHeight: 'md',
          ratio: '21:9',
          overlay: 'darken',
          overlayAlignment: 'top-left',
          overlayTone: 'ivory',
        }),

        // Editorial figure: the apothecary — gestures at the TCM
        // and herbal arm of the practice before the bios.
        oneCol(
          'ivory',
          'md',
          figure({
            imageKey: 'apothecary',
            alt: 'The Anara apothecary — an antique wooden cabinet lined with jars of herbs and tinctures.',
            ratio: '16:9',
            caption: 'The apothecary — used by Dr. Wen and the TCM practice.',
            animation: 'fade-in',
          }),
        ),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Marta Sevcik · since 2019',
              title: 'Massage therapist',
              body: 'Twelve years on the table. Trained in Prague, certified locally in 2017. Best with chronic tension, post-injury recovery, and people who say "I’ve never had a massage."',
            },
            {
              kicker: 'Daniel Reyes · since 2018',
              title: 'Massage therapist',
              body: 'Eight years on the table. A former physical therapist, now bodywork only. Best with athletes and runners — most of our half-marathon clients see Daniel.',
            },
            {
              kicker: 'Yuki Tanaka · since 2021',
              title: 'Massage therapist',
              body: 'Six years on the table. Certified in lymphatic drainage and prenatal. Best with very sensitive clients and post-surgery recovery.',
            },
            {
              kicker: 'Lia Coelho · since 2017',
              title: 'Aesthetician',
              body: 'Fifteen years of facials. Trained in Brazil, licensed locally. Best with combination and congested skin types — Lia’s extraction technique is the kindest in the city.',
            },
            {
              kicker: 'Sara Mansour · since 2020',
              title: 'Aesthetician',
              body: 'Nine years of facials. Specialises in sensitive and rosacea-prone skin. The gentlest aesthetician on the team.',
            },
            {
              kicker: 'Dr. Wen Cho · since 2019',
              title: 'Acupuncturist (L.Ac., Dipl.O.M.)',
              body: 'Twenty-two years in practice. NCCAOM-certified, doctorate in oriental medicine. Tuesday, Thursday, Saturday. By direct booking or by referral.',
            },
            {
              kicker: 'Anu Mehta · since 2022',
              title: 'Thai bodyworker',
              body: 'Trained in Chiang Mai. Eight years of practice. Two days a week, by appointment. Thai is mat-based and fully clothed — wear something you can stretch in.',
            },
          ],
        }),

        // A small closing material moment — the botanical close-up
        // as a quiet sign-off before the footer.
        oneCol(
          'cream',
          'lg',
          figure({
            imageKey: 'botanical-eucalyptus',
            alt: 'Dried eucalyptus seed pods arranged beside a wooden spool — a botanical close-up.',
            ratio: '21:9',
            corners: 'sharp',
            animation: 'fade-in',
          }),
        ),
      ],
    },

    // ─── JOURNAL ──────────────────────────────────────────────────
    {
      slug: 'journal',
      title: 'Journal',
      seoTitle: 'Journal — Anara Wellness',
      seoDescription:
        'Short essays from the Anara practitioners. About once a fortnight.',
      sections: [
        // Journal hero — sunlit white wall, a contemplative image
        // that already carries the right mood. Centre-left overlay
        // sits in the soft shadow; obsidian text reads against the
        // bright wall without needing a heavy overlay, so we leave
        // it as 'none' and let the light do the work.
        heroCover({
          imageKey: 'meditation-room',
          alt: 'Sunlight streaming onto a quiet white wall — the contemplative quality the journal essays carry.',
          eyebrow: 'Journal',
          title: 'Short essays, once a fortnight.',
          body: 'Notes from the practitioners on what they see most often — chronic tension, screen-time pain, why sleep is upstream of most of it. No supplements to sell.',
          minHeight: 'lg',
          ratio: '21:9',
          overlay: 'darken',
          overlayAlignment: 'center-left',
          overlayTone: 'ivory',
        }),

        ...threeColCards({
          background: 'ivory',
          cards: [
            {
              kicker: 'Marta · 12 May',
              title: 'The shoulder you have been holding',
              body: 'A short essay on the trapezius — the muscle that everyone over thirty seems to wear like a coat. Causes, undoing it, what to do at home.',
              cta: { label: 'Read it', href: '/journal' },
            },
            {
              kicker: 'Dr. Wen · 28 Apr',
              title: 'On sleep, and pulse',
              body: 'A reflection on what acupuncture practice teaches us about sleep — and how it usually shows up in the pulse three days before the patient mentions it.',
              cta: { label: 'Read it', href: '/journal' },
            },
            {
              kicker: 'Lia · 14 Apr',
              title: 'Skin in the spring',
              body: 'What changes for the skin as the seasons turn, and the three quiet things you can do this week to ease the transition.',
              cta: { label: 'Read it', href: '/journal' },
            },
            {
              kicker: 'Daniel · 31 Mar',
              title: 'Half-marathon week',
              body: 'A short note on what to do — and what not to do — in the week before a half-marathon. Includes the two stretches Daniel will not do in a session.',
              cta: { label: 'Read it', href: '/journal' },
            },
            {
              kicker: 'Yuki · 17 Mar',
              title: 'After surgery',
              body: 'What lymphatic drainage actually does after surgery, and the four-to-six-week window in which it is most useful.',
              cta: { label: 'Read it', href: '/journal' },
            },
            {
              kicker: 'Sara · 3 Mar',
              title: 'A facial is not magic',
              body: 'An honest piece about what a single facial can and cannot do, and the daily routine that does the rest.',
              cta: { label: 'Read it', href: '/journal' },
            },
          ],
        }),
      ],
    },

    // ─── BOOKING ──────────────────────────────────────────────────
    {
      slug: 'booking',
      title: 'Booking',
      seoTitle: 'Booking — Anara Wellness',
      seoDescription:
        'Book a treatment online, by phone, or by email. We reply within one business day.',
      sections: [
        // Booking hero — concentric ripples on a still grey water
        // surface. The whole tone is "settle". 4:3 ratio gives the
        // photo presence without dominating the page; centred
        // overlay puts the booking question literally in the middle
        // of the calm. Ivory text on a 'darken' overlay because the
        // photo is mid-toned.
        heroCover({
          imageKey: 'zen-stones-water',
          alt: 'Concentric ripples spreading across a still water surface — a moment to settle.',
          eyebrow: 'Booking',
          title: 'When would you like to come?',
          body: 'Booking online is the fastest path. The intake takes about three minutes. If you would prefer to talk to a person, Felix at the front desk takes calls weekdays nine to six.',
          minHeight: 'lg',
          ratio: '4:3',
          overlay: 'darken',
          overlayAlignment: 'center',
          overlayTone: 'ivory',
        }),

        // Editorial figure: dried pampas grass against a soft beige
        // background. A small botanical pause between the hero and
        // the contact channels — establishes the wellness palette
        // before we get to the form.
        oneCol(
          'cream',
          'md',
          figure({
            imageKey: 'stone-wall-texture',
            alt: 'Soft plumes of dried pampas grass against a warm beige background — a tactile botanical study.',
            ratio: '21:9',
            animation: 'fade-in',
          }),
        ),

        contactChannels({
          background: 'ivory',
          email: {
            value: 'booking@anara.example',
            href: 'mailto:booking@anara.example',
            description: 'Read within one business day.',
          },
          phone: {
            value: '+1 415 555 0136',
            href: 'tel:+14155550136',
            description: 'Weekdays nine to six. Felix at the front desk.',
          },
          address: {
            value: '14 Lantern Lane, Mission District',
            description: 'Off Valencia Street. Subway: 16th & Mission.',
          },
          hours: {
            value: 'Monday to Saturday, 9 AM — 7 PM',
            description: 'Sunday closed.',
          },
        }),

        oneCol(
          'cream',
          'md',
          contactForm({
            heading: 'Request an appointment',
            intro:
              'Date, treatment, practitioner if you have a preference, and any notes (pregnancy, recent injury, allergy to specific oils, etc). We will confirm within one business day.',
            submitLabel: 'Request appointment',
            successHeadline: 'Thank you — your request is with us.',
            successBody:
              'Felix will reply within one business day with available times. If you asked for a specific practitioner, your request goes to them first.',
          }),
        ),
      ],
    },
  ],
}
