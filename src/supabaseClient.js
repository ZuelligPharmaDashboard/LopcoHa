import { createClient } from '@supabase/supabase-js';

const ENV_URL = import.meta.env.VITE_SUPABASE_URL || '';
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const hasEnvConfig = Boolean(ENV_URL && ENV_KEY);

export function getStoredConfig() {
  if (hasEnvConfig) {
    return { url: ENV_URL, key: ENV_KEY, source: 'env' };
  }
  try {
    const saved = JSON.parse(localStorage.getItem('smartclass_supabase_cfg') || 'null');
    if (saved?.url && saved?.key) {
      return { url: saved.url, key: saved.key, source: 'local' };
    }
  } catch (e) {
    console.error(e);
  }
  return null;
}

export function saveLocalConfig(url, key) {
  localStorage.setItem(
    'smartclass_supabase_cfg',
    JSON.stringify({ url: url.trim(), key: key.trim() })
  );
}

let cachedClient = null;
let cachedSignature = '';

export function getSupabaseClient() {
  const cfg = getStoredConfig();
  if (!cfg) return null;
  const sig = `${cfg.url}::${cfg.key}`;
  if (cachedClient && cachedSignature === sig) {
    return cachedClient;
  }
  cachedClient = createClient(cfg.url, cfg.key);
  cachedSignature = sig;
  return cachedClient;
}
