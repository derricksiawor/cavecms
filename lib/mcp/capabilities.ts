import 'server-only'
import { MCP_TOOLS, type McpToolSpec } from './scope'
import { FONT_CATALOG, FONT_KEYS } from '@/lib/cms/fontCatalog'

// `capabilities` — the MCP server's full self-description: what CaveCMS is, the
// auth model, the content/block model, the section/column meta reference, the
// batch-op vocabulary, the branding/theme controls, rate limits + constraints,
// error codes, and the FULL tool list (generated live from the catalog so it can
// never drift). An agent calls this once to learn everything it can do.
//
// Brand-agnostic: documents SHAPES + controls, never specific colors. Block DATA
// shapes are intentionally delegated to `describe_block_types` (the live source
// of truth) — this map documents the structural facts around them.

function toolLine(t: McpToolSpec) {
  return {
    name: t.name,
    summary: t.summary,
    scope: t.resource ? `${t.resource}:${t.action}` : 'none',
    minRole: t.minRole,
    tier: t.tier,
    requiresDesignGuide: t.tier === 'write' || t.tier === 'destructive',
  }
}

export function getCapabilities() {
  const tools = Object.values(MCP_TOOLS).map(toolLine)
  return {
    product: {
      name: 'CaveCMS',
      summary:
        'A block-based, WordPress-shaped CMS. Public pages, blog posts, and portfolio projects are each a tree of content blocks. Site-wide branding, theme colors, navigation, SEO, and contact info are operator settings.',
      contentModel:
        'Every page/post/project body is a tree EXACTLY 3 levels deep: SECTION (full-width band — background token, padding, optional background image, 1–4 columns) → COLUMN (1–12 grid width) → WIDGET (one of ~47 block types). Build/modify with `edit_page` (one batched transaction with temp-id refs to wire parents) or per-block tools. Read with `get_page` (flat list of blocks with id, parent_id, position, kind, block_type, data, meta, version — rebuild the tree from parent_id).',
      optimisticLocking:
        'Blocks + pages carry a `version`. Single-block writes REQUIRE the expected version; edit_page accepts an optional pageVersion (omit = last-write-wins) + optional per-op expectedVersion. Settings writes REQUIRE {key, value, version}. A mismatch → 409 stale. Read the current version first (get_page / get_settings).',
    },

    auth: {
      tokenFormat: 'Authorization: Bearer cave_<secret>',
      roles: {
        viewer: 'read-only (GET-equivalent tools only)',
        editor: 'read + create/edit/delete content + branding',
        admin: 'editor + content/branding settings',
      },
      notes: [
        'Token role is clamped to the creator’s CURRENT role; revocation takes effect on the next call.',
        'Tokens reach only content (/api/cms/*) + the writable branding settings keys — never user management, security/auth settings, secret rotation, or the updater.',
        'Per-resource scopes (resource:action, read<write<delete) narrow a token further. The tools you SEE depend on your role + scopes (progressive disclosure).',
        'No CSRF needed — a bearer token is not browser-auto-sent.',
      ],
    },

    // Feature → the tools that operate it.
    features: [
      { feature: 'Pages', detail: 'Create/edit/trash/restore public pages; set homepage; SEO/OG; preview tokens; full block-tree editing.', tools: ['list_pages', 'get_page', 'create_page', 'update_page', 'delete_page', 'restore_page', 'page_preview_token', 'edit_page'] },
      { feature: 'Blocks (page content)', detail: 'The section→column→widget tree. Batch via edit_page, or per-block create/patch/delete/duplicate/restore/reorder.', tools: ['edit_page', 'update_block', 'update_block_meta', 'create_block', 'delete_block', 'duplicate_block', 'restore_block', 'reorder_blocks'] },
      { feature: 'Blog posts', detail: 'Posts share the same block-tree body engine (+ a markdown body_md, admin-only to edit).', tools: ['list_posts', 'get_post', 'create_post', 'update_post', 'delete_post', 'restore_post'] },
      { feature: 'Projects (portfolio)', detail: 'Portfolio entries: metadata (tagline, location, SEO, hero) + a block body + featured ordering.', tools: ['list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'restore_project', 'reorder_projects', 'update_project_section', 'project_preview_token'] },
      { feature: 'Media library', detail: 'Upload images (≤10MB, auto-variants) or PDFs (≤25MB); list (cursor); inspect; delete (blocked while referenced). Reference by media_id in image blocks, logos, and section backgrounds.', tools: ['list_media', 'get_media', 'upload_media', 'delete_media'] },
      { feature: 'Themes & branding', detail: 'Site-wide colors, logo, header, footer, social, contact, SEO — every page/section/button derives from these. See `branding`.', tools: ['get_theme', 'get_settings', 'update_settings'] },
      { feature: 'Navigation', detail: 'Header nav lives on the site_header setting (navItems, max 6, one level of submenu); footer links on the footer setting; the nav-menus API is also available.', tools: ['get_nav', 'update_nav', 'get_settings', 'update_settings'] },
      { feature: 'Forms & leads', detail: 'Form blocks (contact_form, lx_inquiry_form, lx_brochure_form, lx_channel_card) drop into a page and POST to the lead pipeline. Place them as widgets; no separate API call.', tools: ['edit_page'] },
      { feature: 'Saved blocks (reusable library)', detail: 'Save a widget to a library and paste it into any page.', tools: ['list_saved_blocks', 'get_saved_block', 'create_saved_block', 'delete_saved_block', 'instantiate_saved_block'] },
      { feature: 'Section templates', detail: 'Instantiate a pre-built section template (hero, pricing, FAQ, team, …) into a page.', tools: ['instantiate_template'] },
      { feature: 'Design + discovery', detail: 'The mandatory design standard, the block catalog + data shapes, the live theme, and this capability map.', tools: ['design_guide', 'describe_block_types', 'get_theme', 'capabilities', 'whoami'] },
    ],

    blockModel: {
      kinds: ['section (container, 1–4 columns)', 'column (1–12 grid width)', 'widget (content)'],
      fields: {
        data: 'JSON content — widgets only (heading text, image ref, …); containers are {}',
        meta: 'JSON presentation — all kinds (section bg/padding/columns/bgImage, column width/align, widget spacing, htmlId)',
        version: 'optimistic-lock number',
        parent_id: 'tree parent (rebuild the tree from the flat get_page list)',
        kind: 'section | column | widget',
        block_type: 'widget type, e.g. lx_heading',
        position: 'order within parent',
      },
      blockTypeFamilies: {
        textHeadings: ['lx_eyebrow', 'lx_heading', 'lx_text', 'lx_quote', 'lx_animated_headline'],
        actionsNav: ['lx_action', 'lx_cta_banner', 'lx_menu_anchor', 'lx_toc', 'lx_share', 'lx_social_icons'],
        media: ['lx_icon', 'lx_figure', 'lx_gallery', 'lx_image_pair', 'lx_cover_image', 'lx_video', 'lx_carousel', 'lx_before_after', 'lx_hotspot', 'lx_marquee'],
        layout: ['lx_divider', 'lx_space'],
        dataFeatures: ['lx_stat', 'lx_icon_list', 'lx_icon_box', 'lx_pricing_table', 'lx_pricing_list', 'lx_comparison_table', 'lx_progress', 'lx_progress_tracker', 'lx_timeline', 'lx_countdown', 'lx_flip_box', 'lx_tabs', 'lx_accordion'],
        socialProof: ['lx_testimonial', 'lx_testimonial_carousel', 'lx_reviews', 'lx_star_rating'],
        formsCrm: ['lx_form', 'contact_form', 'lx_inquiry_form', 'lx_brochure_form', 'lx_channel_card'],
        dynamicEmbed: ['lx_posts', 'lx_featured_projects', 'lx_embed', 'lx_code', 'lx_map'],
      },
      dataShapes: 'Call `describe_block_types` for each type’s exact data fields + a worked example. That is the live source of truth — never guess a block’s data shape.',
    },

    sectionAndColumnMeta: {
      section: {
        columns: '1–4 (set meta.columns AND create that many COLUMN children)',
        background: ['cream', 'near-black', 'copper-tint', 'obsidian', 'ivory', 'champagne', 'bone', 'charcoal'],
        backgroundColor: 'ANY exact hex (#RGB or #RRGGBB) — overrides the named token so you can match a brand background precisely. Dark hex backgrounds auto-flip text to light (see autoTone).',
        backgroundGradient: "Structured gradient that OVERRIDES the token + hex bg: { kind:'linear'|'radial', angle:0–360 (linear), stops:[{ color:'#hex', position?:0–100 }] } (2–6 stops). Safe (hex stops + bounded angle, never raw CSS). Rendered as background-image.",
        padding: ['none', 'sm', 'md', 'lg', 'xl', '2xl'],
        'paddingTop / paddingBottom': 'EXACT per-side override — a spacing tier OR a raw pixel number (0–512). Use a number to match a brand rhythm precisely (e.g. paddingTop:144, paddingBottom:112). Overrides the `padding` token for that side.',
        backgroundImage: '{ media_id, alt } — full-bleed section image',
        backgroundSlides: "[{ media_id, alt }, …] (max 8) — an ANIMATED background slideshow. 2+ slides cross-fade automatically; OVERRIDES backgroundImage. Pair with slideTransition + slideIntervalMs + kenBurns. Only the first slide loads upfront (rest lazy); the loop pauses off-screen + respects reduced-motion. Perfect for a hero that cycles property/portfolio photos.",
        kenBurns: "['none','zoom-in','zoom-out','pan-left','pan-right','zoom-pan'] — slow continuous camera drift on the background photo / each slide. Reduced-motion safe.",
        slideTransition: "['through-black'(default, cinematic: outgoing fades out zooming IN while incoming fades in zooming OUT, dipping through black),'crossfade'(counter-zoom, no black dip),'fade'(plain opacity)] — slideshow only.",
        slideIntervalMs: '1000–30000 — MILLISECONDS each slide shows before advancing, Elementor-style (4000 = 4 seconds). Slideshow only. Default 6000.',
        backgroundOverlay: ['none', 'darken', 'darken-strong', 'gradient-bottom', 'champagne'],
        backgroundFit: ['cover', 'contain', 'fill', 'none', 'scale-down'],
        backgroundPosition: "object-position for the cover image/video: 'center'|'top'|'bottom'|'left'|'right'|'top left'|… (which part stays in frame when cropped).",
        backgroundVideoUrl: 'A looping muted autoplay background VIDEO (https .mp4/.webm), rendered behind content like the cover image. backgroundVideoPoster:{media_id,alt} shows before it loads.',
        contentMaxWidth: "['sm'(768),'md'(1024),'lg'(1152),'xl'(1280, default),'full'] — max width of the inner content container.",
        shapeDividers: "Top/bottom SVG separators: shapeTop/shapeBottom ['wave'|'tilt'|'curve'|'triangle'|'mountains'|'split'] + shapeTop/BottomColor (#hex) + shapeTop/BottomHeight (px) + shapeTop/BottomFlip (bool).",
        minHeight: ['none', 'sm', 'md', 'lg', 'xl', 'screen'],
        htmlId: 'optional anchor id (unique per page)',
        '+ shared decoration': 'see decorationControls below (border, box-shadow, sticky, scroll motion, hover, custom CSS) — applies to BOTH sections and columns.',
      },
      column: {
        width: '1–12 grid units',
        verticalAlign: ['start', 'center', 'end'],
        childLayout: "['stack', 'row', 'grid'] — 'row' = horizontal flex-wrap; 'grid' = a WRAPPING grid of `childColumns` (1–4) columns INSIDE this column (a nested container for an arbitrary card grid without splitting the section); 'stack' = vertical (default).",
        childJustify: "['start', 'center', 'end', 'between'] — horizontal distribution when childLayout is 'row'.",
        childColumns: '1–4 — grid columns for childLayout:grid.',
        childGap: 'gap between children (px) for row/grid mode.',
        backgroundColor: 'ANY exact hex — per-column background override. A solid bg (or gradient) makes the column render as a rounded, PADDED CARD — the native primitive for icon-less feature cards. No icon required (unlike lx_icon_box).',
        backgroundGradient: 'Structured gradient background for the column — same shape as the section gradient.',
        cardLink: '{ href } — makes the whole column a clickable card',
        cardLinkLabel: 'accessible label for the card link',
        '+ shared decoration': 'see decorationControls below.',
      },
      // Elementor-parity controls shared by sections + columns (and, where
      // noted, widgets) — all set on `meta`.
      decorationControls: {
        border: 'borderWidth (px) + borderStyle [solid|dashed|dotted|double] + borderColor (#hex) + borderRadius (px).',
        boxShadow: "boxShadow ['none'|'sm'|'md'|'lg'|'xl'|'2xl'] + optional boxShadowColor (#hex tint). Soft premium elevation.",
        sticky: "sticky ['none'|'top'|'bottom'] + stickyOffset (px) — pins the element while scrolling.",
        scrollMotion: "motionEffect ['parallax'|'fade-scroll'|'zoom-scroll'|'tilt'] + motionIntensity (1–100). Scroll/mouse motion, reduced-motion safe.",
        hover: 'hoverLift (px translate up) + hoverShadow (preset) + hoverBorderColor (#hex) — card hover elevation. (Buttons have their own hover fill/text/scale.)',
        customCss: 'customCss + customCssHover — CSS DECLARATIONS (no selectors/braces) scoped + sanitised to this block. Escape hatch for one-off styling.',
        exactSpacing: 'paddingTop/Right/Bottom/Left + marginTop/Right/Bottom/Left accept a tier, a px number, OR a CSS-length string with units (e.g. "2rem", "5%", "10vw").',
      },
      widgetMeta: {
        animationDuration: 'ms — entrance animation speed for any block (applied to its on-scroll reveal).',
        animationDelay: 'ms — stagger the entrance (e.g. 100ms per card).',
        customCss: 'customCss + customCssHover — scoped declarations on the widget wrapper.',
      },
      editorialPrimitives: {
        plainEyebrow: "lx_eyebrow `variant: 'plain'` renders a quiet inline label (no pill, as-typed case, tone-coloured) — for muted left-aligned section kickers like a grey \"Dashboard\" / \"The problem\". `variant: 'badge'` (default) is the tinted uppercase chip.",
        checklist: "lx_icon_list `variant: 'checklist'` + `iconColor` (token or #hex) renders a compact ✓-style feature list — small tinted icons (e.g. green #00e68a checks) beside light text, no glow. Set each item's icon to 'check'. iconColor on ANY icon_list variant tints the icons + drops the champagne glow.",
        cards: 'Icon-less feature cards = a columns:N section where each COLUMN has a backgroundColor (→ rounded padded card) containing a left-aligned lx_heading + lx_text. Left-align editorial sections; centre only heroes.',
      },
      gradientsAndExactType: {
        gradient: "A structured, safe gradient value used in THREE places: section/column `meta.backgroundGradient` (fill), text blocks `data.textGradient` (gradient TEXT via background-clip — lx_heading/lx_text/lx_eyebrow), and lx_action `data.backgroundGradient` (button fill) / `data.textGradient` (button label). Shape: { kind:'linear'|'radial', angle:0–360, stops:[{color:'#hex',position?:0–100}] }, 2–6 stops.",
        exactTypography: "lx_heading + lx_text accept EXACT overrides — `fontSize` (a length like '56px'/'3.5rem' OR a responsive clamp() like 'clamp(2.25rem,5vw,3.5rem)'), `lineHeight` (a unitless number like '1.1' or a length), `letterSpacing` (e.g. '-0.025em'). These pixel-match a brand's type ramp; they override the size-enum + leading baseline. Display headings already default to tight premium leading (~1.05–1.1).",
        responsiveTypography: "lx_heading + lx_text accept PER-BREAKPOINT overrides — fontSizeTablet/fontSizeMobile + lineHeightTablet/lineHeightMobile (tablet ≤1024px, mobile ≤640px), emitted as a scoped media-query <style>. Columns already stack to 1 on mobile and padding tiers are already responsive; this adds responsive exact type.",
        newBlocks: "lx_icon = a standalone icon (name/size/color/rotate/alignment, optional chip shape + link). lx_form = a COMPOSABLE form: operator-defined fields (text/email/tel/textarea/select/checkbox, required, role→lead name/email/phone) that POST to the lead pipeline (/api/leads/form) with CSRF + honeypot + reCAPTCHA + email notify.",
        buttonControls: "lx_action: variant + size + alignment, fillColor (#hex solid, e.g. white button), radius (px) OR per-corner radiusTopLeft/TopRight/BottomRight/BottomLeft, backgroundGradient (fill) / textGradient (label), hover (hoverFillColor/hoverTextColor/hoverScale/transitionMs).",
        figureControls: "lx_figure: link (whole image), lightbox (click→full-screen overlay), hoverZoom, objectPosition (crop focus), ratio/fit/corners/goldOverlay.",
        dividerControls: "lx_divider: style (solid/dashed/dotted/fleuron), width preset + widthPercent, thickness preset + thicknessPx, tone, alignment, centre label OR labelIcon (e.g. an 'OR' separator).",
        iconListControls: "lx_icon_list: variant ['vertical'|'grid'|'row'|'checklist'] + columns + iconColor (tints icons, drops glow) + card (filled card per grid item) + per-item optional `code` (mini terminal with copy inside the card).",
        compareControls: "lx_comparison_table: 2–4 columns, per-cell value = check (yes/✓) / cross (no/×) / text, highlightColumn, accent (#hex — colours the ✓ + highlighted column header + tint band).",
        brandSwatches: "theme_swatches setting = operator-defined global brand colours ([{label,color}]); they surface as quick picks in every colour picker. Set via update_settings('theme_swatches', { swatches:[...] }).",
        cookieConsent: "cookie_consent setting = a GDPR consent banner. Shape: { enabled, title, message, policyUrl, position['bottom'|'bottom-left'|'bottom-right'|'center'], theme['auto'|'dark'|'light'], categories:[{key,label,description,required}] (≥1 required/'necessary'; well-known keys analytics|marketing|preferences map to Google Consent Mode signals), googleConsentMode(bool), buttons:{allowAll,rejectAll,customize,save}, reopenLabel, showReopenLink, consentVersion(bump to re-ask) }. Set via update_settings('cookie_consent', {...}). It gates GA4/Ads/GTM via Consent Mode v2 + fires a `cavecms:consent` JS event for other tags; visitors reopen it from the footer link.",
      },
      autoTone: "DARK SECTIONS JUST WORK: every text-on-section block (lx_heading, lx_text, lx_eyebrow, lx_stat, lx_quote, lx_cta_banner, lx_icon_list, lx_accordion, lx_comparison_table, lx_pricing_table, lx_progress_tracker, lx_tabs, lx_timeline, lx_toc, lx_countdown, lx_marquee, lx_progress, lx_channel_card, lx_testimonial, lx_testimonial_carousel, lx_animated_headline, lx_gallery, lx_carousel) auto-flips its text to a light tone on a dark section (dark token OR dark hex backgroundColor). You do NOT need to set `tone:'ivory'` on a dark section — only set `tone` to deliberately override. Hex tones are always respected as-is.",
    },

    editPage: {
      what: 'POST batch of 1–50 ops in ONE transaction (one revalidate, one audit row). Any op error rolls back the whole batch. This is the agent fast-lane — prefer it for multi-block work.',
      ops: {
        create: 'Add section/column/widget. Set tempId so later ops in the SAME batch can reference it as parent {ref:"tempId"}.',
        patchData: 'Update a widget’s content — full `data` OR shallow `dataPatch`.',
        patchMeta: 'Update presentation — full `meta` OR shallow `metaPatch` (section/column/widget).',
        delete: 'Soft-delete a block (cascades to descendants).',
        reorderChildren: 'Reorder a parent’s children — the COMPLETE ordered child-id set is required.',
      },
      response: '{ pageVersion, tempIds:{tempId→realId}, results:[{op, id, version, …}] }',
      opErrorFormat: 'op[<index>]:<code> — so you know exactly which op failed.',
    },

    branding: {
      how: 'update_settings({ key, value, version }) — SITE-WIDE. Read current values + versions via get_settings first. (get_theme is a no-scope shortcut to the palette + header/footer.)',
      theme_palette: {
        purpose: 'Site-wide colors. Header, footer, every section background token, and every button derive from this. Setting it to a brand’s real colors is what makes the whole site look like that brand.',
        shape: { mode: '"light" | "dark"', primary: '#hex (dominant text/dark)', secondary: '#hex (muted)', accent: '#hex (CTAs + highlights)', surfaceDark: '#hex (dark sections)', surfaceLight: '#hex (light sections)' },
      },
      site_header: {
        purpose: 'Logo, brand text, top nav, primary CTA.',
        shape: { brandText: 'string', logo: '{ media_id, alt } | null', logoMaxHeight: '24–96', theme: '"cream"|"obsidian"|"ivory"|"champagne"|"bone"', navItems: '[{ label, href, children?:[{label,href}] }] (max 6)', primaryCta: '{ text, href, openInNew? } | null  (NOTE: field is `text`, not `label`)' },
      },
      footer: {
        purpose: 'Footer logo, link columns, newsletter, copyright, legal links.',
        shape: { tagline: 'string', theme: 'header-theme token', logo: '{ media_id, alt } | null', columns: '[{ label, links:[{ text, href }] }]', newsletterHeading: 'string', newsletterBody: 'string', newsletterCtaLabel: 'string', copyright: 'string', legalLinks: '[{ text, href }]' },
      },
      typography: {
        purpose: 'Site-wide font pairing. Sets the heading + body typefaces for the WHOLE site (header, footer, every page). Match the brand’s real fonts. null = keep the default pairing.',
        shape: { heading: 'a font key (or null)', body: 'a font key (or null)' },
        availableFonts: Object.fromEntries(
          FONT_KEYS.map((k) => [k, `${FONT_CATALOG[k].family} (${FONT_CATALOG[k].kind})`]),
        ),
        pairingTips: [
          'A clean SaaS look: a geometric/grotesk sans for BOTH heading + body (e.g. poppins, inter, manrope, space-grotesk).',
          'Editorial / luxury: a display serif heading + a humanist sans body (e.g. fraunces or playfair-display heading + inter/work-sans body).',
          'Keep it to ONE or TWO families. Never more than two typefaces on a page.',
        ],
      },
      otherBrandKeys: ['social_links ([{ platform, href }])', 'contact_info ({ phone, email, address, hours })', 'default_seo ({ title, description, ogImagePath })', 'organization_json_ld', 'mobile_cta'],
      notReachableByToken: ['user management', 'security/auth settings', 'secret rotation', 'session policy', 'analytics toggle', 'the updater'],
    },

    constraints: {
      rateLimits: { mutations: '300/min per user (each batch op counts as one)', reads: '120/min per user', uploads: '10/min per user' },
      caps: { batchOps: '≤50 per edit_page', reorderIds: '≤500 per op', columnsPerSection: '≤4', imageUpload: '≤10 MB', pdfUpload: '≤25 MB', mediaListPage: '≤50 (cursor)', richText: '≤16 KB (lx_text.body_richtext)' },
      trash: 'All deletes are soft — recoverable for 30 days (restore_* tools).',
    },

    errorCodes: {
      http: { 400: 'malformed body / unknown block type', 401: 'missing/invalid token', 403: 'role/scope not permitted, or non-writable settings key', 404: 'missing/trashed/forged id', 409: 'optimistic-lock mismatch, slug in use, htmlId collision, column overflow, reorder drift', 413: 'upload too large', 422: 'validation failed', 429: 'rate limited' },
      batchOpCodes: ['stale_page_version', 'stale_block_version', 'not_found', 'parent_not_found', 'unknown_block_type', 'missing_data', 'column_parent_must_be_section', 'widget_parent_must_be_column', 'column_count_exceeded', 'html_id_collision', 'invalid_data', 'invalid_meta', 'wrong_field_for_kind', 'cannot_delete_fixed_block', 'incomplete_reorder', 'not_a_child', 'unknown_parent_ref'],
    },

    startHere: [
      '1. design_guide — MANDATORY. Read it; it unlocks every content-mutating tool for this session and defines the ultra-premium standard.',
      '2. get_theme — read the live palette + logo so you can match (or set) the brand.',
      '3. If building for a specific brand: fetch its official logo + real colors, then upload_media the logo and update_settings(theme_palette, site_header, footer) BEFORE composing.',
      '4. describe_block_types — see every block type + exact data shapes.',
      '5. Compose with edit_page (section → column → widget). Verify with get_page.',
    ],

    // The full tool surface (generated live — never drifts from what’s registered).
    tools,
    notes: [
      'requiresDesignGuide=true tools are locked until you call design_guide this session.',
      'scope "resource:action" is the token grant needed (read<write<delete); "none" = always available.',
      'Tools you actually SEE depend on your token’s role + scopes (progressive disclosure).',
    ],
  }
}
