// PDQ Rank Tracker — Cloudflare Worker
//
// Endpoints
//   GET  /health           — liveness probe (no auth)
//   GET  /data             — load the rank-tracker JSON blob (auth required)
//   PUT  /data             — save the rank-tracker JSON blob (auth required)
//
// Auth: every /data request must carry "X-Auth: <secret>" matching the
// AUTH_SECRET Worker secret. The shared secret is stored client-side in
// localStorage after the first unlock.
//
// Storage: a single KV key per "tenant". Today there's one tenant — the value
// of AUTH_SECRET. Hashing it gives a stable opaque key without exposing the
// secret. If you later add multi-user auth, change tenantKey() to return the
// user id instead.

const KV_KEY_PREFIX = 'projects:';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const corsHeaders = buildCorsHeaders(origin, env);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        try {
            if (url.pathname === '/health') {
                return json({ ok: true, hasAuth: !!env.AUTH_SECRET }, 200, corsHeaders);
            }

            if (url.pathname === '/data') {
                const authError = checkAuth(request, env);
                if (authError) return json({ error: authError }, 401, corsHeaders);

                const tenant = await tenantKey(request);
                const kvKey = KV_KEY_PREFIX + tenant;

                if (request.method === 'GET') {
                    const raw = await env.RANK_DATA.get(kvKey);
                    if (!raw) return json({ projects: [], activeProjectId: null }, 200, corsHeaders);
                    // Stored as a JSON string; pass it back as-is to avoid a parse round-trip.
                    return new Response(raw, {
                        status: 200,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }

                if (request.method === 'PUT') {
                    const lenHeader = request.headers.get('Content-Length');
                    if (lenHeader && parseInt(lenHeader, 10) > MAX_BODY_BYTES) {
                        return json({ error: 'Payload too large' }, 413, corsHeaders);
                    }
                    const text = await request.text();
                    if (text.length > MAX_BODY_BYTES) {
                        return json({ error: 'Payload too large' }, 413, corsHeaders);
                    }
                    let parsed;
                    try { parsed = JSON.parse(text); }
                    catch (e) { return json({ error: 'Invalid JSON' }, 400, corsHeaders); }
                    if (!parsed || !Array.isArray(parsed.projects)) {
                        return json({ error: 'Invalid data format (expected { projects: [], activeProjectId })' }, 400, corsHeaders);
                    }
                    await env.RANK_DATA.put(kvKey, text);
                    return json({ ok: true, bytes: text.length }, 200, corsHeaders);
                }

                return json({ error: 'Method not allowed' }, 405, corsHeaders);
            }

            return json({ error: 'Not found' }, 404, corsHeaders);
        } catch (err) {
            console.error('Worker error:', err && err.stack || err);
            return json({ error: 'Internal error' }, 500, corsHeaders);
        }
    }
};

// ---------------- helpers ----------------

function checkAuth(request, env) {
    if (!env.AUTH_SECRET) return 'AUTH_SECRET not configured on the Worker';
    const provided = request.headers.get('X-Auth') || '';
    if (provided.length !== env.AUTH_SECRET.length) return 'Unauthorized';
    // Constant-time-ish comparison to avoid leaking length-difference timing.
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
        diff |= provided.charCodeAt(i) ^ env.AUTH_SECRET.charCodeAt(i);
    }
    return diff === 0 ? null : 'Unauthorized';
}

async function tenantKey(request) {
    // Hash the auth secret (sent on every request) to derive a stable tenant
    // id. Same secret → same KV key. If you later swap to multi-user, replace
    // this with the authenticated user's id.
    const secret = request.headers.get('X-Auth') || '';
    const buf = new TextEncoder().encode(secret);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
}

function buildCorsHeaders(origin, env) {
    const allowed = (env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '*');
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(body, status, extraHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
    });
}
