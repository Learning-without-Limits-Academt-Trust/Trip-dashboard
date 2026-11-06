// Netlify Function: serves every /api/* request using Netlify Blobs for storage.
import { getStore } from '@netlify/blobs';
import { handle } from '../../lib/core.mjs';

function blobAdapter() {
  // Data is kept in the EU (Frankfurt). Set before first use: a store's data never moves region afterwards.
  const s = getStore({ name: 'trust-trips', consistency: 'strong', region: process.env.BLOBS_REGION || 'eu-central-1' });
  return {
    async get(key) {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async set(key, data, opts = {}) {
      const o = {};
      if (opts.onlyIfMatch) o.onlyIfMatch = opts.onlyIfMatch;
      else if (opts.onlyIfNew) o.onlyIfNew = true;
      return s.setJSON(key, data, o);
    },
    del: key => s.delete(key),
    async list(prefix) { const { blobs } = await s.list({ prefix }); return blobs.map(b => b.key); },
  };
}

export default async (request, context) =>
  handle(request, { store: blobAdapter(), env: process.env, ip: context.ip || 'unknown' });

export const config = { path: '/api/*' };
