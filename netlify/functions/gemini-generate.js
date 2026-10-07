const axios = require('axios');

exports.handler = async function(event, context) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const GEMINI_API_URL = process.env.GEMINI_API_URL;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const ADMIN_SECRET = process.env.ADMIN_SECRET; // optional fallback secret for CI/local

    // Autorisation: vérifier Netlify Identity (roles) si présent dans context.clientContext
    const client = context && context.clientContext;
    const hasAdminRole = client && client.user && client.user.app_metadata && Array.isArray(client.user.app_metadata.roles) && client.user.app_metadata.roles.includes('admin');
    // Fallback : header x-admin-secret (utile pour tests ou appel serveur-to-server) — configurez ADMIN_SECRET dans Netlify vars
    const providedSecret = (event.headers && (event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || event.headers['x-admin-secret'.toLowerCase()])) || null;

    if (!hasAdminRole) {
      if (!ADMIN_SECRET || providedSecret !== ADMIN_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: admin role required' }) };
      }
    }

    if (!GEMINI_API_URL || !GEMINI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured: GEMINI_API_URL / GEMINI_API_KEY missing' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const prompt = body.prompt || 'Génère une courte annonce pour un restaurant chic, 1 phrase.';

    const resp = await axios.post(GEMINI_API_URL, {
      prompt,
      max_tokens: 120
    }, {
      headers: {
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, data: resp.data })
    };
  } catch (err) {
    console.error('Function error', err && err.toString());
    const status = err.response ? err.response.status : 500;
    const body = err.response && err.response.data ? err.response.data : { message: err.message };
    return { statusCode: status, body: JSON.stringify({ ok: false, error: body }) };
  }
};
