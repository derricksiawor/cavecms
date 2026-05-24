import type { SectionTemplate } from './index'

// 3-up team grid: each column shows one teammate via IconBox (icon →
// name → role). When the project ships a dedicated TeamMember widget
// (post-V1), the template's blockType swaps over.

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
              blockType: 'heading',
              data: { text: 'Meet the team' },
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
              blockType: 'icon_box',
              data: { icon: 'user', headline: 'Alex Carter' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'user', headline: 'Jamie Lin' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'user', headline: 'Morgan Reyes' },
            },
          ],
        },
      ],
    },
  ],
}
