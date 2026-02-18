const CACHE_NAME = 'pk-explorer-v1';
const MAP_CACHE = 'pk-maps-v1';

// Assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Crimson+Text:wght@400;600&display=swap',
  'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js',
  'https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js',
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js'
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('📦 Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Service Worker: Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.error('📦 Service Worker: Cache failed', err))
  );
});

// Activate event - clean old caches
self.addEventListener('activate', event => {
  console.log('✅ Service Worker: Activated');
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys
            .filter(key => key !== CACHE_NAME && key !== MAP_CACHE)
            .map(key => {
              console.log('🗑️ Service Worker: Deleting old cache', key);
              return caches.delete(key);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache with network fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Map tiles - cache first strategy
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(
      caches.open(MAP_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) {
            return cached;
          }
          return fetch(event.request).then(response => {
            // Cache successful responses
            if (response.status === 200) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => {
            // Return offline tile placeholder if available
            return new Response('', { status: 503 });
          });
        })
      )
    );
    return;
  }

  // Supabase requests - network only (always fresh data)
  if (url.hostname.includes('supabase')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Return offline response for Supabase
        return new Response(JSON.stringify({ offline: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Other requests - network first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response.status === 200 && event.request.url.startsWith('http')) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Try cache if network fails
        return caches.match(event.request).then(cached => {
          if (cached) {
            console.log('📱 Service Worker: Serving from cache', event.request.url);
            return cached;
          }
          // Return offline page for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});

// Background Sync - sync offline points when connection restored
self.addEventListener('sync', event => {
  console.log('🔄 Service Worker: Background sync', event.tag);
  
  if (event.tag === 'sync-points') {
    event.waitUntil(syncPendingPoints());
  }
});

async function syncPendingPoints() {
  console.log('🔄 Service Worker: Syncing offline points...');
  
  try {
    // Open IndexedDB and get pending points
    const db = await openDB();
    const points = await getAllPendingPoints(db);
    
    if (points.length === 0) {
      console.log('✅ Service Worker: No pending points to sync');
      return;
    }
    
    console.log(`🔄 Service Worker: Syncing ${points.length} points...`);
    
    // Send each point to server
    for (const point of points) {
      try {
        const response = await fetch('/api/points', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(point)
        });
        
        if (response.ok) {
          // Remove from IndexedDB after successful sync
          await deletePendingPoint(db, point.id);
          console.log('✅ Service Worker: Point synced', point.id);
        }
      } catch (err) {
        console.error('❌ Service Worker: Failed to sync point', point.id, err);
      }
    }
    
    console.log('✅ Service Worker: Sync complete');
  } catch (err) {
    console.error('❌ Service Worker: Sync failed', err);
  }
}

// Helper functions for IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pk_explorer', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function getAllPendingPoints(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['points'], 'readonly');
    const store = transaction.objectStore('points');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });
}

function deletePendingPoint(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['points'], 'readwrite');
    const store = transaction.objectStore('points');
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Push Notifications
self.addEventListener('push', event => {
  console.log('🔔 Service Worker: Push notification received');
  
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'PK Explorer';
  const options = {
    body: data.body || 'Nova atualização disponível!',
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      timestamp: Date.now()
    },
    actions: [
      { action: 'open', title: 'Abrir', icon: '/icon-192.png' },
      { action: 'close', title: 'Fechar' }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  console.log('🔔 Service Worker: Notification clicked', event.action);
  
  event.notification.close();
  
  if (event.action === 'close') {
    return;
  }
  
  // Open the app
  const urlToOpen = event.notification.data.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // If app is already open, focus it
        for (const client of clientList) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Message handler for manual cache refresh
self.addEventListener('message', event => {
  console.log('💬 Service Worker: Message received', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_REFRESH') {
    event.waitUntil(
      caches.keys().then(keys => {
        return Promise.all(keys.map(key => caches.delete(key)));
      }).then(() => {
        return self.registration.unregister();
      })
    );
  }
});

console.log('🚀 Service Worker: Loaded');
