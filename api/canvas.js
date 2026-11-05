// Pass-through for Canvas. Never stores or logs tokens.
const dns = require('dns').promises;
const net = require('net');

const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|::ffff:|fc|fd|fe80)/i;

async function safeOrigin(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' || net.isIP(x.hostname) || x.hostname === 'localhost') return null;
  try {
    const a = await dns.lookup(x.hostname, { all: true });
    if (a.some(r => PRIVATE.test(r.address))) return null;
  } catch { return null; }
  return x.origin;
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { action, url, token, pt, pid, oid, done } = body || {};

    const base = await safeOrigin(url);
    if (!base || !token) return res.status(400).json({ error: 'Bad URL or token' });

    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', payload) => {
      const r = await fetch(base + path, {
        method, headers, redirect: 'error',
        body: payload ? JSON.stringify(payload) : undefined
      });
      if (!r.ok) throw new Error('Canvas ' + r.status);
      return r;
    };

    if (action === 'verify') {
      const u = await (await call('/api/v1/users/self')).json();
      return res.json({ name: u.name });
    }

    if (action === 'items') {
      const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
      let path = `/api/v1/planner/items?start_date=${day(-14)}&end_date=${day(120)}&per_page=100`;
      const raw = [];
      for (let page = 0; path && page < 5; page++) {
        const r = await call(path);
        raw.push(...(await r.json()));
        const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '');
        path = null;
        if (m) { try { const n = new URL(m[1]); if (n.origin === base) path = n.pathname + n.search; } catch {} }
      }
      const courses = new Map(), items = [];
      for (const x of raw) {
        if (!['assignment', 'quiz', 'discussion_topic'].includes(x.plannable_type) || !x.course_id) continue;
        const pl = x.plannable || {};
        courses.set(x.course_id, x.context_name || 'Class');
        items.push({
          pt: x.plannable_type, pid: x.plannable_id, cid: x.course_id,
          name: pl.title || pl.name || 'Assignment',
          due: pl.due_at || x.plannable_date || null,
          oid: x.planner_override ? x.planner_override.id : null,
          done: x.planner_override ? !!x.planner_override.marked_complete : !!(x.submissions && x.submissions.submitted)
        });
      }
      return res.json({ courses: [...courses].map(([id, name]) => ({ id, name })), items });
    }

    if (action === 'complete') {
      const r = oid
        ? await call('/api/v1/planner/overrides/' + encodeURIComponent(oid), 'PUT', { marked_complete: !!done })
        : await call('/api/v1/planner/overrides', 'POST', { plannable_type: pt, plannable_id: pid, marked_complete: !!done });
      const j = await r.json();
      return res.json({ oid: j.id });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e) });
  }
};
