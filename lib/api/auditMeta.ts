import 'server-only'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { getRequestId } from '@/lib/api/withError'

// Shared extraction of the per-request audit metadata every CMS
// write handler attaches to audit_log rows: client IP, user-agent
// (capped at 255 chars matching the column), and the withError-
// generated requestId. Six API routes used to inline this same
// 6-line block; centralizing here keeps a single edit-site if the
// underlying header set ever changes (e.g. adding cf-connecting-ip
// or trusted-proxy logic).
export interface AuditMeta {
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export function auditMetaFromRequest(req: Request): AuditMeta {
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  return {
    ip: clientIpFromHeaders(headerObj, '127.0.0.1'),
    userAgent: (headerObj['user-agent'] ?? '').slice(0, 255) || null,
    requestId: getRequestId(req),
  }
}
