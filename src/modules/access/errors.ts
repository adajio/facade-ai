import type { FastifyReply, FastifyRequest } from 'fastify';

export class AccessError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly info: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function unauthenticated(): AccessError {
  return new AccessError(401, 'session_required', 'Войдите в приложение.');
}

export function unavailable(): AccessError {
  return new AccessError(404, 'not_found', 'Ресурс недоступен.');
}

export function forbidden(): AccessError {
  return new AccessError(403, 'forbidden', 'Для этого действия недостаточно полномочий.');
}

export function invalid(code = 'invalid_input', message = 'Проверьте входные данные.'): AccessError {
  return new AccessError(422, code, message);
}

export function sendAccessError(error: AccessError, request: FastifyRequest, reply: FastifyReply) {
  return reply.code(error.statusCode).send({
    ...error.info,
    code: error.code,
    message: error.message,
    requestId: request.id,
  });
}
