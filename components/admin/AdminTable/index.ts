// Re-export the AdminTable surface so existing imports keep working:
//
//   import { AdminTable, runPerRowMutation, ... } from '@/components/admin/AdminTable'

export { AdminTable } from './AdminTable'
export type { AdminTableProps } from './AdminTable'
export {
  runPerRowMutation,
  runPerRowMutationWithReauth,
  applyBulkRemoval,
  computePageRange,
} from './helpers'
export type {
  AdminTableColumn,
  AdminTableBulkAction,
  AdminTableSort,
  SortDirection,
  RunPerRowReauthArgs,
  RunPerRowReauthResult,
} from './helpers'
