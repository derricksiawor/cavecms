import clsx from 'clsx'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Icon List widget. Canonical Elementor fields per
// `includes/widgets/icon-list.php`:
//   - view: traditional | inline
//   - icon_list (repeater): text + selected_icon + link
//   - link_click: full-width | inline
//   - dividers between items (switcher + style + weight + width + colour)
//   - per-item link target
//
// BWC narrows: no per-item link (icon-list items are not navigation
// targets in editorial luxury-RE pages — operators reach for the Icon
// Box widget when they need an icon-with-link). No dividers between rows
// — whitespace separates them; Tailwind's gap-* on the parent handles
// the rhythm. Layout collapses Elementor's view + grid-columns into
// three named presets (vertical / grid_2 / grid_3).
//
// Reference URLs:
//   - https://elementor.com/help/icon-list-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/icon-list.php
//   - https://code.elementor.com/classes/elementor-widget-icon-list/

interface IconListItem {
  icon: string
  label: string
}

interface IconListData {
  items: IconListItem[]
  layout: 'vertical' | 'grid_2' | 'grid_3'
  style: 'copper-circle' | 'copper-inline'
}

const LAYOUT_CLASS: Record<IconListData['layout'], string> = {
  vertical: 'flex flex-col gap-3',
  grid_2: 'grid grid-cols-1 sm:grid-cols-2 gap-4',
  grid_3: 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4',
}

export function IconList({
  data,
  inlineEdit,
  outerClass,
}: {
  data: IconListData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  if (data.items.length === 0) return null
  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      <ul className={LAYOUT_CLASS[data.layout]}>
        {data.items.map((item, i) => {
          return (
            <li key={i} className="flex items-center gap-3">
              {data.style === 'copper-circle' ? (
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 ring-1 ring-copper-400/30"
                >
                  <IconByName
                    name={item.icon}
                    className="h-3.5 w-3.5 text-copper-600"
                    strokeWidth={2}
                  />
                </span>
              ) : (
                <IconByName
                  name={item.icon}
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-copper-600"
                  strokeWidth={2}
                />
              )}
              {inlineEdit ? (
                <InlineEditable
                  blockId={inlineEdit.blockId}
                  blockVersion={inlineEdit.blockVersion}
                  pageId={inlineEdit.pageId}
                  pageVersion={inlineEdit.pageVersion}
                  initialData={data}
                  field="items[].label"
                  arrayIndices={[i]}
                  kind="plain"
                  initialValue={item.label}
                  as="span"
                  className="text-sm text-near-black"
                  placeholder="List item"
                />
              ) : (
                <span className="text-sm text-near-black">{item.label}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
