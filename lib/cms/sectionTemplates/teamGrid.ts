import type { SectionTemplate } from './index'

// 3-up team grid: each column shows one teammate via lx_icon_box
// (icon → name → role). When the project ships a dedicated
// TeamMember widget post-V1, the template's blockType swaps over.

export const TEMPLATE_TEAM_GRID: SectionTemplate = {
  id: 'team-grid',
  name: 'Team Grid',
  description: 'Three-up grid for introducing the people behind the work.',
  previewImage: '/templates/team-grid.svg',
  blocks: [
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Meet the team',
                level: 'h2',
                size: 'display-lg',
                alignment: 'center',
                tone: 'obsidian',
                italic: false,
                animation: 'slide-up',
              },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 3, background: 'cream', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_icon_box',
              data: {
                icon: 'user',
                headline: 'Alex Carter',
                body: 'Role or title — one short line under the name.',
                alignment: 'center',
                accent: 'champagne-outline',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_icon_box',
              data: {
                icon: 'user',
                headline: 'Jamie Lin',
                body: 'Role or title — one short line under the name.',
                alignment: 'center',
                accent: 'champagne-outline',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_icon_box',
              data: {
                icon: 'user',
                headline: 'Morgan Reyes',
                body: 'Role or title — one short line under the name.',
                alignment: 'center',
                accent: 'champagne-outline',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },
  ],
}
