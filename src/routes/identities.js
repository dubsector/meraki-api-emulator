// The identity every API key acts as, and its API keys.

import { notFound } from '../http.js';
import { iso, isoMicro } from '../time.js';

const ME = '/administered/identities/me';

function identity(ctx) {
  const a = ctx.world.apiAdmin;
  const last = ctx.apiLog.items.at(-1);
  return {
    name: a.name,
    email: a.email,
    lastUsedDashboardAt: iso(last ? last.ts : ctx.now),
    authentication: {
      mode: 'email',
      api: { key: { created: ctx.keys.list().length > 0 } },
      twoFactor: { enabled: a.twoFactorAuthEnabled },
      saml: { enabled: false },
    },
  };
}

function revoke(ctx) {
  if (!ctx.keys.revoke(ctx.params.suffix)) throw notFound('API key');
}

export default [
  { op: 'getAdministeredIdentitiesMe', path: ME, handler: identity },
  { op: 'getAdministeredIdentitiesMeApiKeys', path: `${ME}/api/keys`, handler: (ctx) => ctx.keys.list().map((k) => ({ suffix: k.suffix, createdAt: isoMicro(k.createdAt) })) },
  { op: 'generateAdministeredIdentitiesMeApiKeys', method: 'POST', status: 202, path: `${ME}/api/keys/generate`, journal: false, handler: (ctx) => ({ key: ctx.keys.generate(ctx.now) }) },
  { op: 'revokeAdministeredIdentitiesMeApiKeys', method: 'POST', status: 202, path: `${ME}/api/keys/{suffix}/revoke`, journal: false, handler: revoke },
];
