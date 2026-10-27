import type { FastifyReply, FastifyRequest } from 'fastify';
import { LifecycleError, MemberRuleError } from '@lbgos/modules/tenancy';

/** Maps module rule violations to HTTP; returns undefined for anything else. */
export function sendRuleError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  if (err instanceof LifecycleError) {
    if (err.code === 'REASON_REQUIRED') return send(422, err.code, err.message);
    if (err.code === 'NOT_FOUND') return send(404, 'NOT_FOUND', 'Not found.');
    return send(409, err.code, err.message);
  }
  if (err instanceof MemberRuleError) {
    if (err.code === 'NOT_FOUND') return send(404, 'NOT_FOUND', 'Not found.');
    if (err.code === 'GRANT_EXCEEDS_OWN' || err.code === 'SELF_CHANGE' || err.code === 'OWNER_PROTECTED') {
      return send(403, err.code, err.message);
    }
    return send(409, err.code, err.message);
  }
  return undefined;
}
