import { emit } from '../modules/registry.ts';
import { getDb, schema } from '../db/client.ts';

export async function audit(actorId: number | null, action: string, target: { type?: string; id?: number | null } = {}, detail: Record<string, unknown> = {}, ip?: string | null, tx = getDb()) {
  await tx.insert(schema.auditLog).values({ actorId, action, targetType: target.type ?? null, targetId: target.id ?? null, detail, ip: ip ?? null });
  void emit('audit.recorded', { actorId, action, targetType: target.type ?? null, targetId: target.id ?? null });
}

export async function securityEvent(userId: number | null, kind: string, info: { ip?: string | null; userAgent?: string | null; provider?: string | null; detail?: Record<string, unknown> } = {}) {
  await getDb().insert(schema.securityEvents).values({ userId, kind, ip: info.ip ?? null, userAgent: info.userAgent?.slice(0, 300) ?? null, provider: info.provider ?? null, detail: info.detail ?? {} });
}
