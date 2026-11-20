import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ServiceError } from './runtime.ts';

const loopback = (address: string | undefined) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** Only the authenticated gateway may supply identity and roles; browser headers alone grant nothing. */
export function createGatewayAuthentication({ production, env = process.env }: { production: boolean; env?: NodeJS.ProcessEnv }) {
  const local = env.LOCAL_DEMO_ONLY === 'true';
  if (production && local) throw new Error('LOCAL_DEMO_ONLY cannot be enabled in production.');
  const secret = Buffer.from(env.AUTH_GATEWAY_SECRET ?? '');
  if (!local && secret.length < 32) throw new Error('AUTH_GATEWAY_SECRET must contain at least 32 bytes.');

  function authenticate(request: Request): string {
    if (local) {
      if (!loopback(request.socket.remoteAddress)) throw new ServiceError('AUTH_REQUIRED', '请先登录。', 401);
      return 'local';
    }
    const supplied = Buffer.from(request.get('x-agentic-gateway-secret') ?? '');
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) throw new ServiceError('AUTH_REQUIRED', '请先登录。', 401);
    const ownerId = request.get('x-agentic-user-id');
    if (!ownerId || ownerId !== ownerId.trim() || ownerId.length > 200 || /[\x00-\x20\x7f,]/.test(ownerId)) throw new ServiceError('AUTH_REQUIRED', '请先登录。', 401);
    return ownerId;
  }
  function authorizeAdmin(request: Request): boolean {
    authenticate(request);
    return local || (request.get('x-agentic-roles') ?? '').split(',').some(role => role.trim() === 'admin');
  }
  const requireAdmin: RequestHandler = (request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    try {
      if (!authorizeAdmin(request)) throw new ServiceError('ADMIN_REQUIRED', '此入口需要管理权限。', 403);
      next();
    } catch (error) {
      response.status(error instanceof ServiceError ? error.status : 401).json({ error: { code: error instanceof ServiceError ? error.code : 'AUTH_REQUIRED', message: '此入口需要登录并具备管理权限。' } });
    }
  };
  return { authenticate, authorizeAdmin, requireAdmin };
}
