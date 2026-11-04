import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { createHandler } from './handler.mjs';

function environmentKey(collection: string, legacy: string): string {
  const raw = Deno.env.get(collection);
  if (raw) {
    const keys = JSON.parse(raw);
    if (typeof keys.default === 'string' && keys.default) return keys.default;
  }
  const fallback = Deno.env.get(legacy);
  if (!fallback) throw new Error('Server configuration unavailable');
  return fallback;
}

// Secret values are supplied by the Edge runtime, never by source or the browser.
const handler = createHandler({
  getClients(authorization: string) {
    const url = Deno.env.get('SUPABASE_URL');
    if (!url) throw new Error('Server configuration unavailable');
    const publicKey = environmentKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
    const secretKey = environmentKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    return {
      userClient: createClient(url, publicKey, {global: {headers: {Authorization: authorization}}, auth: {persistSession: false, autoRefreshToken: false}}),
      adminClient: createClient(url, secretKey, {auth: {persistSession: false, autoRefreshToken: false}})
    };
  }
});

Deno.serve(handler);
