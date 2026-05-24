// Single-source EditDrawer tab keys. Imported by EditDrawer.tsx, the
// context menu registry (contextMenuActions.ts), and each Editable*
// component that owns a `drawerInitialTab` state slot.
//
// Chunk H — a future tab addition ('seo' for hero blocks, 'animation'
// for component-level motion settings, etc.) lands here AND in the
// per-shape STYLE_KEYS / ADVANCED_KEYS routing in EditDrawer.tsx
// (those sets decide which existing field shapes route to which tab).
// Keep this list in lockstep with the tabForShape dispatcher.

// 'crm' surfaces ONLY on widget types that own a `crmDestinations`
// field — currently just `contact_form`. EditDrawer hides it when
// the active block's schema has no `crmDestinations` slot, so its
// presence in this union doesn't pollute every other widget's tab
// bar.
export type EditDrawerTab = 'content' | 'style' | 'advanced' | 'crm'

export const EDIT_DRAWER_TABS: readonly EditDrawerTab[] = [
  'content',
  'style',
  'advanced',
  'crm',
] as const
