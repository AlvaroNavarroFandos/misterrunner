/* MisterRunner Service Worker — Production */
const CACHE = 'mr-v3';
const SUPABASE_URL = 'https://wlvtxmqjteswatndovji.supabase.co';

/* ── Cache Strategy ───────────────────────────────────────────────── */
const STATIC_ASSETS = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  /* Never cache Supabase API calls */
  if (url.hostname.includes('supabase.co')) return;
  if (request.method !== 'GET') return;

  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return resp;
      }).catch(() => caches.match('/'));
    })
  );
});

/* ── Push Notifications ───────────────────────────────────────────── */
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: 'MisterRunner', body: e.data.text() }; }

  const { title = 'MisterRunner', body = '', url = '/', type } = payload;

  const opts = {
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: type || 'general',
    data: { url },
    actions: type === 'message' ? [
      { action: 'reply', title: 'Responder' },
      { action: 'dismiss', title: 'Descartar' }
    ] : []
  };

  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
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
