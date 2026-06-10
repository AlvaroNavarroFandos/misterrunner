/* MisterRunner Service Worker — Production */
/* Bloque K — Auditoría SW (K.1 + K.2) — 17 mayo 2026 */

const CACHE_VERSION = 'mr-v3.2-2026-06-10';
const CACHE_STATIC  = `${CACHE_VERSION}-static`;
const CACHE_PAGES   = `${CACHE_VERSION}-pages`;

const SUPABASE_URL = 'https://wlvtxmqjteswatndovji.supabase.co';

/* Assets que precacheamos en install. Si alguno falla, no rompe el install. */
const STATIC_ASSETS = [
  '/'
];

/* ── Helpers ──────────────────────────────────────────────────────── */

/* Solo cacheamos requests http(s). Excluye chrome-extension://, blob:, data:,
   ws:, wss:, file:, etc. → fix K.1 explícito. */
function isCacheable(request) {
  const url = request.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (request.method !== 'GET') return false;
  return true;
}

/* Detecta si un request es la "shell" navegacional (index.html). */
function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  // Fallback para navegadores antiguos o requests sin mode
  const accept = request.headers.get('accept') || '';
  return request.method === 'GET' && accept.includes('text/html');
}

/* ── Install: precache de estáticos ───────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(c => c.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Precache parcial:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: limpiar caches antiguos + tomar control ────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      const valid = new Set([CACHE_STATIC, CACHE_PAGES]);
      return Promise.all(
        keys.filter(k => !valid.has(k)).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

/* ── Fetch: enrutado por tipo de request ──────────────────────────── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  /* No tocar API de Supabase (auth, rest, realtime, storage). */
  if (url.hostname.includes('supabase.co')) return;

  /* Filtro global: si no es cacheable, dejar pasar sin interceptar. */
  if (!isCacheable(request)) return;

  /* Navegación / index.html → NETWORK-FIRST */
  if (isNavigationRequest(request)) {
    e.respondWith(networkFirst(request));
    return;
  }

  /* Assets estáticos same-origin → CACHE-FIRST */
  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(request));
    return;
  }

  /* Cross-origin (CDNs, fuentes, etc.) → CACHE-FIRST también,
     pero solo cacheamos respuestas opaque-safe (status 200, type basic/cors). */
  e.respondWith(cacheFirst(request));
});

/* ── Estrategias ──────────────────────────────────────────────────── */

/* NETWORK-FIRST: red primero, caché si falla. Usada para index.html.
   Tras una respuesta de red válida, actualizamos la copia en caché. */
async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && (fresh.type === 'basic' || fresh.type === 'cors')) {
      const clone = fresh.clone();
      caches.open(CACHE_PAGES).then(c => {
        // Doble check: solo cacheamos URLs http(s)
        if (request.url.startsWith('http')) c.put(request, clone);
      }).catch(() => {});
    }
    return fresh;
  } catch (err) {
    /* Offline o red caída → buscar en caché */
    const cached = await caches.match(request);
    if (cached) return cached;
    /* Fallback final: shell de la app */
    const shell = await caches.match('/');
    if (shell) return shell;
    /* Si ni eso, propagar el error */
    throw err;
  }
}

/* CACHE-FIRST: caché si existe, si no red. Actualiza caché en background. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    /* Refresh silencioso en background (stale-while-revalidate ligero) */
    fetch(request).then(resp => {
      if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
        caches.open(CACHE_STATIC).then(c => {
          if (request.url.startsWith('http')) c.put(request, resp.clone());
        }).catch(() => {});
      }
    }).catch(() => {});
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && (fresh.type === 'basic' || fresh.type === 'cors')) {
      const clone = fresh.clone();
      caches.open(CACHE_STATIC).then(c => {
        if (request.url.startsWith('http')) c.put(request, clone);
      }).catch(() => {});
    }
    return fresh;
  } catch (err) {
    /* Fallback para navegación si todo falla */
    const shell = await caches.match('/');
    if (shell) return shell;
    throw err;
  }
}

/* ── Push Notifications ───────────────────────────────────────────── */
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: 'MisterRunner', body: e.data.text() }; }
  const { title = 'MisterRunner', body = '', data = {} } = payload;
  const type = data.type || 'general';

  const opts = {
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'mr-' + type + '-' + Date.now(),
    data: data,
    actions: type === 'message' ? [
      { action: 'reply', title: 'Responder' },
      { action: 'dismiss', title: 'Descartar' }
    ] : []
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const type = data.type || 'general';

  // Decidir URL de destino según tipo de notificación
  let targetPath = '/';
  if (type === 'message') targetPath = '/?tab=club&chat=' + (data.fromId || '');
  else if (type === 'reaction') targetPath = '/?tab=club';
  else if (type === 'follow') targetPath = '/?tab=club';
  else if (type === 'import-reminder') targetPath = '/?tab=biblioteca';
  else if (type === 'training') targetPath = '/';
  else if (type === 'rest') targetPath = '/';

  const targetUrl = self.location.origin + targetPath;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'NOTIFICATION_CLICK', notifType: type, data });
        return;
      }
      return clients.openWindow(targetUrl);
    })
  );
});

/* ── Background Sync (queue DMs when offline) ─────────────────────── */
self.addEventListener('sync', e => {
  if (e.tag === 'send-message') {
    e.waitUntil(flushOfflineMessages());
  }
});

async function flushOfflineMessages() {
  const db = await openMsgQueue();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const msgs = await idbAll(store);
  for (const msg of msgs) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': self._sbKey || '',
          'Authorization': `Bearer ${self._sbToken || ''}`
        },
        body: JSON.stringify({ from_id: msg.from_id, to_id: msg.to_id, content: msg.content })
      });
      if (res.ok) store.delete(msg.id);
    } catch {}
  }
}

function openMsgQueue() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('mr-msg-queue', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e);
  });
}

function idbAll(store) {
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e);
  });
}
