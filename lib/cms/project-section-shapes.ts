// Field-shape definitions per project section_key. Mirrors the Zod schemas
// in lib/cms/project-section-registry.ts — both must stay in sync, the Zod
// side is the trust boundary (server validates on save), this side is the
// UI builder (admin edits via real form fields, not raw JSON).
//
// New section: add the Zod schema in project-section-registry.ts AND the
// shape entry here.

import type { FieldShape } from '@/components/inline-edit/ZodForm'

export const SECTION_SHAPES: Record<string, FieldShape[]> = {
  hero: [
    {
      kind: 'string',
      key: 'status_label',
      label: 'Status badge',
      maxLength: 60,
      placeholder: 'e.g. Selling Now, Construction 80% Complete',
      help: 'Short tag that appears above the hero — overrides the project status pill when set.',
    },
    { kind: 'media', key: 'banner_image', label: 'Banner image' },
    {
      kind: 'richtext',
      key: 'summary_richtext',
      label: 'Summary',
      maxLength: 2000,
      help: 'A paragraph or two introducing the project. Use the toolbar for bold, italics, lists, and links.',
    },
  ],

  gallery: [
    {
      kind: 'object_array',
      key: 'categories',
      label: 'Gallery categories',
      itemNoun: 'category',
      addLabel: 'Add category',
      maxItems: 8,
      itemTitle: (item, i) => (item.name as string) || `Category ${i + 1}`,
      itemFields: [
        {
          kind: 'string',
          key: 'name',
          label: 'Category name',
          maxLength: 60,
          placeholder: 'e.g. Living areas, Bedrooms, Exteriors',
        },
        {
          kind: 'media_array',
          key: 'images',
          label: 'Images in this category',
        },
      ],
    },
  ],

  floor_plans: [
    {
      kind: 'object_array',
      key: 'unit_types',
      label: 'Unit types',
      itemNoun: 'unit type',
      addLabel: 'Add unit type',
      maxItems: 20,
      itemTitle: (item, i) => (item.name as string) || `Unit ${i + 1}`,
      itemFields: [
        { kind: 'string', key: 'name', label: 'Unit name', maxLength: 60, placeholder: 'e.g. 2-Bedroom Garden' },
        { kind: 'number', key: 'beds', label: 'Bedrooms', min: 0, step: 1 },
        { kind: 'number', key: 'baths', label: 'Bathrooms', min: 0, step: 0.5 },
        { kind: 'number', key: 'sqft', label: 'Square footage', min: 1, step: 1 },
        { kind: 'media', key: 'image', label: 'Floor plan image' },
        {
          kind: 'string',
          key: 'description',
          label: 'Description',
          maxLength: 800,
          multiline: true,
          help: 'Optional. Free-text notes that appear under the floor plan.',
        },
      ],
    },
  ],

  pricing: [
    {
      kind: 'select',
      key: 'display',
      label: 'How to show pricing',
      options: [
        { value: 'range', label: 'Show a price range' },
        { value: 'per_unit', label: 'Show per-unit prices' },
        { value: 'contact', label: 'Contact for pricing (hide numbers)' },
      ],
    },
    {
      kind: 'richtext',
      key: 'value_richtext',
      label: 'Pricing text',
      maxLength: 2000,
      help: 'Free-text description. Examples: "From $250,000", "Bespoke pricing — contact us".',
    },
    {
      kind: 'number',
      key: 'units_total',
      label: 'Total units (optional)',
      min: 1,
      step: 1,
    },
    {
      kind: 'number',
      key: 'units_remaining',
      label: 'Units remaining (optional)',
      min: 0,
      step: 1,
    },
    {
      kind: 'number',
      key: 'price_min',
      label: 'Starting price (optional)',
      min: 0,
      step: 1,
      help: 'Numeric value only — currency is set separately. Used by the public facts strip.',
    },
    {
      kind: 'number',
      key: 'price_max',
      label: 'Top-of-range price (optional)',
      min: 0,
      step: 1,
      help: 'Leave blank if pricing is a single starting figure.',
    },
    {
      kind: 'string',
      key: 'price_currency',
      label: 'Currency (3-letter ISO code)',
      maxLength: 3,
      placeholder: 'USD',
      help: 'Three uppercase letters — USD, GHS, EUR, GBP. Defaults to USD on the public page when left blank.',
    },
    {
      kind: 'string',
      key: 'handover_eta',
      label: 'Handover estimate',
      maxLength: 60,
      placeholder: 'e.g. Q3 2027, Late 2026, Phase 2: 2028',
      help: 'Free-text estimate shown in the facts strip. Use whatever phrasing best fits the project.',
    },
  ],

  amenities: [
    {
      kind: 'object_array',
      key: 'items',
      label: 'Amenity list',
      itemNoun: 'amenity',
      addLabel: 'Add amenity',
      maxItems: 60,
      itemTitle: (item, i) => (item.label as string) || `Amenity ${i + 1}`,
      itemFields: [
        {
          kind: 'string',
          key: 'icon',
          label: 'Icon name',
          maxLength: 60,
          placeholder: 'e.g. pool, gym, parking',
          help: 'Pick an icon to go with this amenity.',
        },
        { kind: 'string', key: 'label', label: 'Label', maxLength: 120, placeholder: 'e.g. Heated swimming pool' },
      ],
    },
  ],

  location: [
    {
      kind: 'string',
      key: 'map_embed_url',
      label: 'Google Maps embed link',
      maxLength: 500,
      placeholder: 'https://www.google.com/maps/embed?...',
      help: 'Open Google Maps, click Share, then Embed a map, then copy the link inside the iframe code. We use it to drop a pin on the project page.',
    },
    {
      kind: 'string',
      key: 'address',
      label: 'Address',
      maxLength: 280,
      placeholder: '12 Example Road, City, Region',
    },
    {
      kind: 'object_array',
      key: 'points_of_interest',
      label: 'Nearby points of interest',
      itemNoun: 'point of interest',
      addLabel: 'Add point of interest',
      maxItems: 20,
      itemTitle: (item, i) => (item.label as string) || `POI ${i + 1}`,
      itemFields: [
        { kind: 'string', key: 'label', label: 'Place name', maxLength: 120, placeholder: 'e.g. International Airport' },
        { kind: 'number', key: 'drive_time_min', label: 'Drive time (minutes)', min: 0, step: 1 },
      ],
    },
  ],

  brochure: [
    {
      kind: 'media',
      key: 'pdf',
      label: 'Brochure PDF',
      accept: 'pdf',
    },
    {
      kind: 'richtext',
      key: 'gate_message_richtext',
      label: 'Message above the form',
      maxLength: 2000,
      help: 'Shown above the brochure-request form. Use it to explain what visitors will get when they share their email.',
    },
  ],

  timeline: [
    {
      kind: 'object_array',
      key: 'entries',
      label: 'Timeline milestones',
      itemNoun: 'milestone',
      addLabel: 'Add milestone',
      maxItems: 40,
      itemTitle: (item, i) => (item.title as string) || (item.date as string) || `Milestone ${i + 1}`,
      itemFields: [
        {
          kind: 'date',
          key: 'date',
          label: 'Date',
          help: 'Pick a date — auto-formats correctly for the public timeline.',
        },
        { kind: 'string', key: 'title', label: 'Title', maxLength: 220, placeholder: 'e.g. Groundbreaking ceremony' },
        {
          kind: 'richtext',
          key: 'body_richtext',
          label: 'Body',
          maxLength: 2000,
          help: 'Optional. Use the toolbar for bold, italics, lists, or links.',
        },
        { kind: 'media', key: 'photo', label: 'Photo (optional)' },
      ],
    },
  ],

  testimonials: [
    {
      kind: 'object_array',
      key: 'entries',
      label: 'Testimonials',
      itemNoun: 'testimonial',
      addLabel: 'Add testimonial',
      maxItems: 20,
      itemTitle: (item, i) => (item.attribution as string) || `Testimonial ${i + 1}`,
      itemFields: [
        { kind: 'string', key: 'quote', label: 'Quote', maxLength: 800, multiline: true, placeholder: 'What the resident said…' },
        { kind: 'string', key: 'attribution', label: 'Attribution', maxLength: 120, placeholder: 'e.g. Jane Doe' },
        {
          kind: 'string',
          key: 'unit_type',
          label: 'Unit type (optional)',
          maxLength: 60,
          placeholder: 'e.g. 2-Bedroom Garden',
        },
      ],
    },
  ],

  inquiry: [
    {
      kind: 'string',
      key: 'heading',
      label: 'Form heading',
      maxLength: 220,
      placeholder: 'e.g. Schedule a private tour',
      help: 'Headline shown above the inquiry form on the public page.',
    },
    {
      kind: 'richtext',
      key: 'body_richtext',
      label: 'Intro text above the form',
      maxLength: 2000,
      help: 'A short, friendly note explaining what happens when someone gets in touch. The Name, Email, Phone, and Message fields are added automatically.',
    },
  ],
}

// Human-readable label for each section_key — appears in the editor
// accordion. Defined here so the labels stay in lockstep with the
// shapes; the Zod registry's identifier-style keys (snake_case) are
// not user-facing.
export const SECTION_LABELS: Record<string, string> = {
  hero: 'Hero',
  gallery: 'Gallery',
  floor_plans: 'Floor plans',
  pricing: 'Pricing',
  amenities: 'Amenities',
  location: 'Location',
  brochure: 'Brochure',
  timeline: 'Timeline',
  testimonials: 'Testimonials',
  inquiry: 'Inquiry form',
}
