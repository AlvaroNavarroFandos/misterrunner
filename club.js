/* ══════════════════════════════════════════════════════════════════════
   MisterRunner — club.js — Lazy chunk (TODO-12 sesión 2)
   ────────────────────────────────────────────────────────────────────
   Extraído de index.html (L36238–47057) en sesión TODO-12 sesión 2.
   Cargado dinámicamente desde index.html tras evento SIGNED_IN por
   _loadClubChunk(). Define todo el subsistema Club + Crews + Feed +
   Heatmap + MIS RÉCORDS + Onboarding.

   No envuelto en IIFE para preservar globalidad (las funciones del Club
   se invocan desde HTML inline onclick= y desde stubs del core).
   ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   CLUB — Supabase backend
══════════════════════════════════════════════════════════════════ */
var _sbFeedChannel = null, _sbDmChannel = null;
var _clubSupabaseInited = false;
var _activeChatUserId = null, _activeChatUsername = '';

async function _initClubSupabase() {
    if (_clubSupabaseInited) return;
    _clubSupabaseInited = true;
    const { data: { session } } = await window._sbClient.auth.getSession();
    if (!session) { _clubSupabaseInited = false; return; }
    const userId = session.user.id;

    _refreshUnreadBadge();

    // ── Migración: limpiar PRs corruptos (v2: usa el sanity cap mejorado) ──
    // Detecta récords de tiempo (best_5k, best_10k, best_half, best_marathon)
    // cuyo valor sea físicamente imposible (mayor que la duración de la
    // actividad que los generó). Si encuentra alguno, reconstruye todos los
    // récords desde el histórico local. v2 bumps el flag para corregir los
    // registros que la v1 había descartado por error.
    (async function _prCleanupV2() {
        try {
            var FLAG_V1 = _uk('mr_pr_cleanup_v1_done');
            var FLAG_V2 = _uk('mr_pr_cleanup_v2_done');
            if (localStorage.getItem(FLAG_V2) === '1') return;
            var sb = window._sbClient;
            // Esperar a que activities esté cargado
            var acts = (typeof window._getActivities === 'function') ? window._getActivities() : [];
            if (!acts.length) {
                // Activities aún no cargado — reintentar tras un breve delay
                setTimeout(function(){ _prCleanupV2(); }, 1500);
                return;
            }
            // En v2 siempre rebuild si v1 estaba marcado (los récords se descartaron),
            // o si detectamos alguna inconsistencia
            var needsRebuild = (localStorage.getItem(FLAG_V1) === '1');
            if (!needsRebuild) {
                var { data: recs } = await sb.from('user_records')
                    .select('record_type,value,activity_local_id,activity_datestr')
                    .eq('user_id', userId);
                if (Array.isArray(recs) && recs.length) {
                    var actsById = {};
                    acts.forEach(function(a){ if (a && a.id != null) actsById[String(a.id)] = a; });
                    var TIME_TYPES = ['best_1k','best_5k','best_10k','best_half','best_marathon'];
                    for (var i = 0; i < recs.length; i++) {
                        var r = recs[i];
                        if (TIME_TYPES.indexOf(r.record_type) < 0) continue;
                        var a = actsById[String(r.activity_local_id)];
                        if (!a || !a.durationSec) continue;
                        if (Number(r.value) > Number(a.durationSec) + 1) {
                            needsRebuild = true; break;
                        }
                    }
                }
            }
            if (needsRebuild && typeof window._rebuildAllRecordsFromHistory === 'function') {
                console.log('[MR][PR cleanup v2] reconstruyendo PRs con sanity cap inteligente...');
                await window._rebuildAllRecordsFromHistory();
            }
            localStorage.setItem(FLAG_V2, '1');
        } catch(e) {
            console.warn('[MR][PR cleanup v2] fail:', e);
        }
    })();

    if (_sbFeedChannel) window._sbClient.removeChannel(_sbFeedChannel);
    _sbFeedChannel = window._sbClient.channel('club-feed')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'club_posts' }, (payload) => {
            // Si está abierto el detalle de un crew y el nuevo post pertenece a ese crew, refrescar su feed
            var det = document.getElementById('crew-detail-view');
            if (det && payload && payload.new && payload.new.crew_id
                && det.dataset.crewId === payload.new.crew_id
                && det.dataset.activeTab === 'feed') {
                var feedTarget = document.getElementById('crew-feed-' + det.dataset.crewId);
                if (feedTarget && typeof renderClubFeed === 'function') {
                    renderClubFeed({ crewId: det.dataset.crewId, target: feedTarget });
                }
            }
            // Si la vista del Club no está visible, no hacemos nada con el feed global
            if (document.getElementById('club-view')?.style.display === 'none') return;
            // Si la pestaña activa es Crews o Récords, no sobrescribir la lista
            var _tab = localStorage.getItem(_uk('mr_club_tab')) || 'all';
            if (_tab !== 'crews' && _tab !== 'records') renderClubFeed();
        })
        .subscribe();

    // ── Social notifications ───────────────────────────────────────
    (async function _initSocialNotifs() {
        try {
            var sb = window._sbClient;
            var { data:{ session } } = await sb.auth.getSession();
            if (!session) return;
            var myId = session.user.id;

            function _fireNotif(title, body) {
                if (Notification.permission !== 'granted') return;
                var n = new Notification(title, {
                    body: body,
                    icon: '/icon-192.png',
                    badge: '/badge-72.png',
                    tag: 'mr-social-' + Date.now()
                });
                setTimeout(function() { n.close(); }, 6000);
            }

            // DM notifications
            sb.channel('mr-dms-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'messages',
                    filter: 'to_id=eq.' + myId
                }, async function(payload) {
                    var fromId = payload.new?.from_id;
                    if (!fromId || fromId === myId) return;
                    // Don't notify if chat with sender is open
                    if (typeof _activeChatUserId !== 'undefined' && _activeChatUserId === fromId) return;
                    var { data: prof } = await sb.from('profiles').select('username, display_name').eq('id', fromId).single();
                    var sender = prof?.display_name || prof?.username || 'Alguien';
                    _fireNotif('MisterRunner', sender + ': ' + (payload.new?.content || 'Mensaje nuevo').substring(0, 80));
                    _refreshUnreadBadge && _refreshUnreadBadge();
                })
                .subscribe();

            // Reaction notifications
            sb.channel('mr-reactions-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'reactions'
                }, async function(payload) {
                    var reactorId = payload.new?.user_id;
                    if (!reactorId || reactorId === myId) return;
                    // Check if the post belongs to me
                    var postId = payload.new?.post_id;
                    var { data: post } = await sb.from('club_posts').select('user_id').eq('id', postId).single();
                    if (!post || post.user_id !== myId) return;
                    var { data: prof } = await sb.from('profiles').select('username, display_name').eq('id', reactorId).single();
                    var who = prof?.display_name || prof?.username || 'Alguien';
                    var emoji = payload.new?.emoji || '❤️';
                    _fireNotif('MisterRunner', who + ' ha reaccionado a tu post ' + emoji);
                })
                .subscribe();

            // Comment notifications:
            //  · Si soy el dueño del post → me llega "X comentó..."
            //  · Si alguien responde a un comentario MÍO (parent_comment_id) → me llega "X respondió a tu comentario..."
            sb.channel('mr-comments-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'post_comments'
                }, async function(payload) {
                    var commenterId = payload.new?.user_id;
                    if (!commenterId || commenterId === myId) return;
                    var postId = payload.new?.post_id;
                    var parentCid = payload.new?.parent_comment_id || null;

                    // ¿Soy el autor del comentario padre? (notificación de respuesta)
                    var iAmParentAuthor = false;
                    if (parentCid) {
                        try {
                            var { data: parentC } = await sb.from('post_comments').select('user_id').eq('id', parentCid).single();
                            if (parentC && parentC.user_id === myId) iAmParentAuthor = true;
                        } catch(_) {}
                    }

                    // ¿Soy el dueño del post? (notificación normal de comentario en mi post)
                    var iAmPostOwner = false;
                    try {
                        var { data: post } = await sb.from('club_posts').select('user_id').eq('id', postId).single();
                        if (post && post.user_id === myId) iAmPostOwner = true;
                    } catch(_) {}

                    // Si no me afecta ninguna de las dos, salir
                    if (!iAmParentAuthor && !iAmPostOwner) return;
                    // Si soy ambos (respondiendo a mi propio comentario en mi propio post),
                    // disparar solo una notif (priorizamos la de respuesta directa)

                    var { data: prof } = await sb.from('profiles').select('username, display_name').eq('id', commenterId).single();
                    var who = prof?.display_name || prof?.username || 'Alguien';
                    var preview = (payload.new?.content || '').substring(0, 60);
                    var msg = iAmParentAuthor
                        ? who + ' respondió a tu comentario: ' + preview
                        : who + ' comentó: ' + preview;
                    _fireNotif('MisterRunner', msg);
                    // Trigger the bell dot
                    var dot = document.getElementById('club-notif-dot');
                    if (dot) dot.style.display = 'block';
                })
                .subscribe();

            // Follow notifications
            sb.channel('mr-follows-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'follows',
                    filter: 'following_id=eq.' + myId
                }, async function(payload) {
                    var followerId = payload.new?.follower_id;
                    if (!followerId || followerId === myId) return;
                    var { data: prof } = await sb.from('profiles').select('username, display_name').eq('id', followerId).single();
                    var who = prof?.display_name || prof?.username || 'Alguien';
                    _fireNotif('MisterRunner', who + ' ha empezado a seguirte');
                })
                .subscribe();

            // Tag notifications: cuando alguien me etiqueta en su post
            sb.channel('mr-tags-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'club_posts'
                }, async function(payload) {
                    var authorId = payload.new?.user_id;
                    if (!authorId || authorId === myId) return;
                    var tagged = payload.new?.tagged_user_ids;
                    if (!Array.isArray(tagged) || tagged.indexOf(myId) < 0) return;
                    var { data: prof } = await sb.from('profiles').select('username, display_name').eq('id', authorId).single();
                    var who = prof?.display_name || prof?.username || 'Alguien';
                    _fireNotif('MisterRunner', who + ' te ha etiquetado en su entreno');
                    var dot = document.getElementById('club-notif-dot');
                    if (dot) dot.style.display = 'block';
                })
                .subscribe();

            // Crew invite notifications: cuando alguien me invita, refresca
            // el array global y, si estoy mirando la pestaña Crews, repinta
            // para que aparezca el banner de invitaciones pendientes.
            sb.channel('mr-crew-invites-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'crew_invites',
                    filter: 'invited_user_id=eq.' + myId
                }, async function(payload) {
                    try {
                        var inviterId = payload.new?.invited_by;
                        var crewId = payload.new?.crew_id;
                        // Sacar nombres para la notif
                        var [ { data: inviter }, { data: crew } ] = await Promise.all([
                            sb.from('profiles').select('username, display_name').eq('id', inviterId).single(),
                            sb.from('crews').select('name').eq('id', crewId).single()
                        ]);
                        var who   = (inviter && (inviter.display_name || inviter.username)) || 'Alguien';
                        var crewN = (crew    && crew.name)        || 'un crew';
                        _fireNotif('MisterRunner', who + ' te ha invitado a ' + crewN);
                        // Refrescar memoria + pestaña Crews si está visible
                        if (typeof _refreshMyCrewInvites === 'function') await _refreshMyCrewInvites();
                        if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();
                        var _tab = localStorage.getItem(_uk('mr_club_tab')) || 'all';
                        if (_tab === 'crews' && document.getElementById('club-feed')
                            && typeof renderClubCrewsList === 'function') {
                            renderClubCrewsList();
                        }
                    } catch(e) {}
                })
                .subscribe();

            // Crew challenge notifications: cuando el owner crea un reto en
            // un crew donde soy miembro, lanzar push. RLS ya restringe los
            // INSERT visibles a los miembros — aquí solo formateamos.
            sb.channel('mr-crew-challenges-' + myId)
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'crew_challenges'
                }, async function(payload) {
                    try {
                        var n = payload && payload.new;
                        if (!n || !n.crew_id) return;
                        // Si soy el propio creador, no notificar a mí mismo
                        if (n.created_by === myId) return;
                        // Sacar nombres
                        var [ { data: who }, { data: crew } ] = await Promise.all([
                            sb.from('profiles').select('username, display_name').eq('id', n.created_by).single(),
                            sb.from('crews').select('name').eq('id', n.crew_id).single()
                        ]);
                        var owner = (who  && (who.display_name || who.username))  || 'Alguien';
                        var crewN = (crew && crew.name)     || 'tu crew';
                        var title = n.title || 'un reto';
                        _fireNotif('🏆 Nuevo reto', owner + ' ha lanzado «' + title + '» en ' + crewN);
                        if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();
                        // Si la tab Retos del crew correspondiente está abierta, repintar
                        var ov = document.getElementById('crew-detail-view');
                        if (ov && ov.dataset.crewId === n.crew_id && ov.dataset.activeTab === 'challenges') {
                            // Trigger re-render: el handler de tab lo dispara
                            var tabBtn = ov.querySelector('button[data-tab="challenges"]');
                            if (tabBtn) tabBtn.click();
                        }
                    } catch(e) {}
                })
                .subscribe();

            // Realtime de eventos/quedadas del crew: si la vista del crew
            // correspondiente está abierta, recargar el banner cuando llegue
            // cualquier cambio (INSERT/UPDATE/DELETE del evento o de respuestas).
            sb.channel('mr-crew-events-' + myId)
                .on('postgres_changes', {
                    event: '*', schema: 'public', table: 'crew_event'
                }, function(payload) {
                    try {
                        var row = payload && (payload.new || payload.old);
                        if (!row || !row.crew_id) return;
                        var ov = document.getElementById('crew-detail-view');
                        if (!ov || ov.dataset.crewId !== row.crew_id) return;
                        var crew = (window._myCrews || []).find(function(c) { return c.id === row.crew_id; });
                        var container = document.getElementById('crew-event-banner');
                        if (crew && container && typeof window._loadCrewEventBanner === 'function') {
                            window._loadCrewEventBanner(crew, container);
                        }
                    } catch(_) {}
                })
                .on('postgres_changes', {
                    event: '*', schema: 'public', table: 'crew_event_responses'
                }, function(payload) {
                    try {
                        var row = payload && (payload.new || payload.old);
                        if (!row || !row.event_id) return;
                        var ov = document.getElementById('crew-detail-view');
                        if (!ov) return;
                        // Solo recargar si la vista del crew abierta tiene este evento
                        var container = document.getElementById('crew-event-banner');
                        if (!container) return;
                        var crew = (window._myCrews || []).find(function(c) { return c.id === ov.dataset.crewId; });
                        if (crew && typeof window._loadCrewEventBanner === 'function') {
                            window._loadCrewEventBanner(crew, container);
                        }
                    } catch(_) {}
                })
                .subscribe();
        } catch(e) {}
    })();

    if (_sbDmChannel) window._sbClient.removeChannel(_sbDmChannel);
    _sbDmChannel = window._sbClient.channel('dm-' + userId)
        .on('postgres_changes', {
            event: 'INSERT', schema: 'public', table: 'messages',
            filter: 'to_id=eq.' + userId
        }, (payload) => {
            _refreshUnreadBadge();
            if (_activeChatUserId === payload.new.from_id) {
                _appendBubble(payload.new, false, payload.new.from_id);
                window._sbClient.from('messages')
                    .update({ read_at: new Date().toISOString() })
                    .eq('from_id', payload.new.from_id).eq('to_id', userId).is('read_at', null);
            }
        })
        .subscribe();

    // ── BLOQUEOS Y SILENCIOS ──────────────────────────────────────
    // Cargamos al iniciar sesión los user_id que el usuario actual ha
    // bloqueado o silenciado, y también quiénes le han bloqueado a él.
    // Mantenemos Sets en memoria para que los filtros del feed sean O(1).
    await _refreshBlockSets();

    // ── CREWS (grupos privados) ───────────────────────────────────
    // Cargamos los crews a los que pertenece el usuario para poder
    // filtrar feeds, mostrar selectores de destino al publicar, etc.
    await _refreshMyCrews();
    // Y las invitaciones pendientes que tengo
    await _refreshMyCrewInvites();
    // Comprobar el dot del botón CLUB del Home tras tener crews + invites
    if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();

    console.log('[MR] Club Supabase OK. User:', userId);
}

// Sets globales: bloqueados por mí, silenciados por mí, gente que me bloqueó.
// Se rellenan en _refreshBlockSets() y se usan en filtros de feed/perfil/DM.
window._myBlocks = new Set();    // userIds que YO he bloqueado
window._myMutes  = new Set();    // userIds que YO he silenciado
window._blockedMe = new Set();   // userIds que ME han bloqueado a mí

async function _refreshBlockSets() {
    var sb = window._sbClient;
    try {
        var { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        var myId = session.user.id;
        // Mis bloqueos y silencios
        var { data: mine, error: e1 } = await sb.from('user_blocks')
            .select('target_id, type').eq('user_id', myId);
        if (e1) { console.warn('[MR] user_blocks read mine:', e1); }
        window._myBlocks = new Set((mine||[]).filter(r => r.type === 'block').map(r => r.target_id));
        window._myMutes  = new Set((mine||[]).filter(r => r.type === 'mute').map(r => r.target_id));
        // Quien me ha bloqueado (para no mostrarles mis posts ni permitirles chatear)
        var { data: theirs, error: e2 } = await sb.from('user_blocks')
            .select('user_id').eq('target_id', myId).eq('type', 'block');
        if (e2) { console.warn('[MR] user_blocks read theirs:', e2); }
        window._blockedMe = new Set((theirs||[]).map(r => r.user_id));
    } catch (e) {
        console.warn('[MR] _refreshBlockSets failed:', e);
    }
}
window._refreshBlockSets = _refreshBlockSets;

// Helpers públicos
function isBlocked(uid)   { return window._myBlocks  && window._myBlocks.has(uid); }
function isMuted(uid)     { return window._myMutes   && window._myMutes.has(uid); }
function blockedMe(uid)   { return window._blockedMe && window._blockedMe.has(uid); }
// Para el feed: filtramos cualquier post de gente bloqueada o silenciada,
// y también lo bloqueado mutuamente (cinturón + tirantes).
function hiddenByMe(uid)  { return isBlocked(uid) || isMuted(uid) || blockedMe(uid); }
window.isBlocked = isBlocked;
window.isMuted   = isMuted;
window.blockedMe = blockedMe;
window.hiddenByMe = hiddenByMe;

// ── CREWS (grupos privados) ───────────────────────────────────────
// Estado en memoria: los crews a los que pertenezco. Se rellena en
// _refreshMyCrews() al iniciar sesión. _myCrews guarda objetos con
// los datos del crew + mi rol; _myCrewIds es un Set para lookup O(1).
window._myCrews   = [];          // [{id, name, avatar_url, owner_id, role}, ...]
window._myCrewIds = new Set();   // Set<crewId> para isMemberOf() rápido

async function _refreshMyCrews() {
    var sb = window._sbClient;
    try {
        var { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        var myId = session.user.id;
        // Leemos mis filas en crew_members y hacemos join con crews para
        // traer nombre, foto, descripción y owner en una sola query.
        var { data, error } = await sb.from('crew_members')
            .select('role, crew:crews(id, name, description, avatar_url, owner_id)')
            .eq('user_id', myId);
        if (error) {
            // Si la tabla aún no existe en Supabase, no queremos romper el
            // resto de la app: dejamos arrays vacíos y avisamos por consola.
            console.warn('[MR] crew_members read failed (¿tabla creada?):', error);
            window._myCrews   = [];
            window._myCrewIds = new Set();
            return;
        }
        var rows = (data || []).filter(r => r.crew); // descarta huérfanos
        window._myCrews = rows.map(r => ({
            id:          r.crew.id,
            name:        r.crew.name,
            description: r.crew.description,
            avatar_url:  r.crew.avatar_url,
            owner_id:    r.crew.owner_id,
            role:        r.role
        }));
        window._myCrewIds = new Set(window._myCrews.map(c => c.id));
    } catch (e) {
        console.warn('[MR] _refreshMyCrews failed:', e);
        window._myCrews   = [];
        window._myCrewIds = new Set();
    }
}
window._refreshMyCrews = _refreshMyCrews;

// ── INVITACIONES PENDIENTES ──────────────────────────────────────
// Carga las invitaciones pendientes que tengo para mostrarlas en
// la pestaña Crews. Patrón defensivo: si la tabla no existe, dejo
// el array vacío y aviso, sin romper nada.
window._myCrewInvites = [];   // [{id, crew_id, crew, invited_by, inviter}, ...]
async function _refreshMyCrewInvites() {
    var sb = window._sbClient;
    try {
        var { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        var myId = session.user.id;
        var { data: invs, error } = await sb.from('crew_invites')
            .select('id, crew_id, invited_by, created_at')
            .eq('invited_user_id', myId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        if (error) {
            console.warn('[MR] crew_invites read failed (¿tabla creada?):', error);
            window._myCrewInvites = [];
            return;
        }
        if (!invs || !invs.length) {
            window._myCrewInvites = [];
            return;
        }
        // Enriquecer con datos del crew y del invitador (dos queries en bloque)
        var crewIds   = [...new Set(invs.map(function(i) { return i.crew_id; }))];
        var inviterIds = [...new Set(invs.map(function(i) { return i.invited_by; }))];
        var [{ data: crewsData }, { data: inviters }] = await Promise.all([
            sb.from('crews').select('id, name, avatar_url').in('id', crewIds),
            sb.from('profiles').select('id, username, display_name, avatar_url').in('id', inviterIds)
        ]);
        var crewMap    = {}; (crewsData || []).forEach(function(c) { crewMap[c.id] = c; });
        var inviterMap = {}; (inviters || []).forEach(function(p) { inviterMap[p.id] = p; });
        window._myCrewInvites = invs.map(function(i) {
            return {
                id:         i.id,
                crew_id:    i.crew_id,
                crew:       crewMap[i.crew_id]   || null,
                invited_by: i.invited_by,
                inviter:    inviterMap[i.invited_by] || null,
                created_at: i.created_at
            };
        }).filter(function(i) { return i.crew; }); // descartar inválidas
    } catch (e) {
        console.warn('[MR] _refreshMyCrewInvites failed:', e);
        window._myCrewInvites = [];
    }
    // Tras (re)cargar, refrescar badge de pestaña Crews si el Club está visible
    if (typeof _refreshCrewsTabBadge === 'function') _refreshCrewsTabBadge();
}
window._refreshMyCrewInvites = _refreshMyCrewInvites;

function getMyCrewInvites() { return window._myCrewInvites || []; }
window.getMyCrewInvites = getMyCrewInvites;

// Helpers públicos para uso desde otros bloques <script>.
function isMemberOf(crewId) { return window._myCrewIds && window._myCrewIds.has(crewId); }
function getMyCrews()       { return window._myCrews || []; }
window.isMemberOf = isMemberOf;
window.getMyCrews = getMyCrews;

// ── PANTALLA "MIS CREWS" ──────────────────────────────────────────
// Overlay full-screen con la lista de mis crews. Si no tengo, estado
// vacío con CTA. Botón "+ Crear crew" en la cabecera (handler del
// modal de creación se conectará en el PASO 3).
async function openMyCrews() {
    // Si ya está abierto, no duplicar
    if (document.getElementById('club-crews-view')) return;

    // Refrescamos por si el usuario ha cambiado algo desde otra pestaña
    if (typeof _refreshMyCrews === 'function') {
        try { await _refreshMyCrews(); } catch (e) {}
    }
    var crews = getMyCrews();

    var ov = document.createElement('div');
    ov.id = 'club-crews-view';
    ov.style.cssText = 'position:fixed;inset:0;z-index:20005;background:var(--bg);display:flex;flex-direction:column;'
        + 'transform:translateX(100%);transition:transform .32s cubic-bezier(.32,.72,0,1);';

    // ─── Cabecera ───
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+10px) 15px 12px;'
        + 'display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);background:var(--bg);';
    var backBtn = document.createElement('button');
    backBtn.style.cssText = 'width:34px;height:34px;border-radius:50%;border:none;background:var(--card);cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    backBtn.onclick = function() {
        ov.style.transform = 'translateX(100%)';
        setTimeout(function() { ov.remove(); }, 320);
    };
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'flex:1;font-size:17px;font-weight:800;color:var(--tw);letter-spacing:.2px;';
    titleEl.textContent = 'Mis Crews';
    // Pildorita verde con el nº de crews
    var countPill = document.createElement('div');
    countPill.style.cssText = 'height:24px;padding:0 9px;border-radius:12px;background:var(--silver-grad);'
        + 'color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;flex-shrink:0;';
    countPill.textContent = String(crews.length);
    hdr.appendChild(backBtn);
    hdr.appendChild(titleEl);
    hdr.appendChild(countPill);

    // ─── Cuerpo (lista o estado vacío) ───
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:14px 15px 90px;display:flex;flex-direction:column;gap:10px;';

    if (!crews.length) {
        // Estado vacío con CTA
        var empty = document.createElement('div');
        empty.style.cssText = 'margin-top:40px;text-align:center;padding:30px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;';
        empty.innerHTML =
            '<div style="width:84px;height:84px;border-radius:50%;background:linear-gradient(135deg,var(--silver-tint),var(--silver-tint));border:2px dashed var(--silver-bd);display:flex;align-items:center;justify-content:center;">'
              + '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="var(--silver)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
              + '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
              + '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
              + '</svg>'
            + '</div>'
            + '<div style="font-size:16px;font-weight:800;color:var(--tw);">Aún no estás en ningún Crew</div>'
            + '<div style="font-size:12.5px;color:var(--tm);max-width:280px;line-height:1.45;">'
              + 'Los Crews son grupos privados de runners. Comparte rutas, planes o cervezas post-tirada solo con los tuyos.'
            + '</div>';
        body.appendChild(empty);
    } else {
        // Lista de crews
        crews.forEach(function(c) {
            var card = document.createElement('div');
            card.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;'
                + 'background:var(--card);border:1px solid var(--border);cursor:pointer;'
                + 'transition:transform .15s ease, box-shadow .15s ease;';
            card.onmouseenter = function() { card.style.boxShadow = '0 2px 10px rgba(0,0,0,.08)'; };
            card.onmouseleave = function() { card.style.boxShadow = ''; };
            card.onclick = function() {
                // Pasamos el crew completo al detalle (incluye role/desc/avatar)
                openCrewDetail(c);
            };
            // Avatar (foto o iniciales sobre verde oliva)
            var av = document.createElement('div');
            av.style.cssText = 'width:48px;height:48px;border-radius:14px;background:var(--silver-grad);'
                + 'display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;'
                + 'overflow:hidden;flex-shrink:0;';
            if (c.avatar_url) {
                var img = document.createElement('img');
                img.src = c.avatar_url; img.loading = 'lazy';
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                av.appendChild(img);
            } else {
                av.textContent = (c.name || '?')[0].toUpperCase();
            }
            // Texto
            var info = document.createElement('div');
            info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;';
            var nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-size:14.5px;font-weight:800;color:var(--tw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            nameEl.textContent = c.name || 'Crew';
            var roleEl = document.createElement('div');
            roleEl.style.cssText = 'font-size:10.5px;color:var(--tm);display:flex;align-items:center;gap:6px;';
            var roleLabel = c.role === 'owner' ? 'Propietario' : (c.role === 'admin' ? 'Admin' : 'Miembro');
            var roleColor = c.role === 'owner' ? '#c4881e' : (c.role === 'admin' ? 'var(--silver)' : 'var(--tm)');
            roleEl.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + roleColor + ';"></span>'
                + '<span style="font-weight:700;color:' + roleColor + ';letter-spacing:.2px;">' + roleLabel + '</span>';
            info.appendChild(nameEl);
            info.appendChild(roleEl);
            // Botón "Editar" — sólo visible si soy owner del crew
            if (c.role === 'owner') {
                var editBtn = document.createElement('button');
                editBtn.setAttribute('aria-label', 'Editar crew');
                editBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;border:1px solid var(--border);'
                    + 'background:var(--bg);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
                editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--silver)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
                editBtn.onclick = function(ev) {
                    ev.stopPropagation(); // evitar abrir detalle al pulsar editar
                    openCrewEditor({
                        id: c.id,
                        name: c.name,
                        description: c.description || '',
                        avatar_url: c.avatar_url || null
                    });
                };
                card.appendChild(editBtn);
            }
            // Chevron
            var chev = document.createElement('div');
            chev.style.cssText = 'flex-shrink:0;opacity:.5;';
            chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';

            card.appendChild(av);
            card.appendChild(info);
            card.appendChild(chev);
            body.appendChild(card);
        });
    }

    // ─── Botón flotante "+ Crear crew" ───
    var fab = document.createElement('button');
    fab.style.cssText = 'position:absolute;bottom:calc(env(safe-area-inset-bottom,0px)+22px);left:50%;transform:translateX(-50%);'
        + 'height:48px;padding:0 22px;border-radius:24px;border:none;cursor:pointer;'
        + 'background:var(--silver-grad);color:#fff;font-family:var(--f);'
        + 'font-size:14px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:8px;'
        + 'box-shadow:0 4px 14px rgba(80,85,92,.35);';
    fab.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
        + '<span>Crear crew</span>';
    fab.onclick = function() {
        // Modo "crear": sin argumentos
        openCrewEditor();
    };

    ov.appendChild(hdr);
    ov.appendChild(body);
    ov.appendChild(fab);
    document.body.appendChild(ov);
    // Slide-in
    requestAnimationFrame(function() { ov.style.transform = 'translateX(0)'; });
}
window.openMyCrews = openMyCrews;

// ── BANNER DE INVITACIONES PENDIENTES ─────────────────────────────
// Tarjeta desplegable que se muestra arriba de la lista de crews
// cuando hay invitaciones a las que aún no he respondido.
function _buildCrewInvitesBanner(invites) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'background:linear-gradient(135deg,rgba(196,136,30,.12),rgba(232,168,37,.06));'
        + 'border:1.5px solid rgba(196,136,30,.45);border-radius:14px;overflow:hidden;'
        + 'margin-bottom:4px;';

    // Cabecera del banner (siempre visible, toca para desplegar)
    var head = document.createElement('button');
    head.style.cssText = 'width:100%;display:flex;align-items:center;gap:10px;padding:12px 14px;'
        + 'background:transparent;border:none;cursor:pointer;font-family:var(--f);text-align:left;';
    var dot = document.createElement('div');
    dot.style.cssText = 'width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#c4881e,#e8a825);'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;'
        + 'box-shadow:0 2px 8px rgba(196,136,30,.35);';
    dot.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:13px;font-weight:800;color:var(--tw);letter-spacing:.1px;';
    ttl.textContent = invites.length === 1
        ? '1 invitación pendiente'
        : invites.length + ' invitaciones pendientes';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:10.5px;color:var(--tm);margin-top:1px;';
    sub.textContent = 'Toca para revisar';
    info.appendChild(ttl);
    info.appendChild(sub);
    var chev = document.createElement('div');
    chev.style.cssText = 'flex-shrink:0;transition:transform .25s ease;';
    chev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>';
    head.appendChild(dot);
    head.appendChild(info);
    head.appendChild(chev);

    // Lista (oculta al principio)
    var list = document.createElement('div');
    list.style.cssText = 'max-height:0;opacity:0;overflow:hidden;'
        + 'transition:max-height .3s ease,opacity .25s ease,padding .25s ease;'
        + 'padding:0 12px;border-top:1px solid rgba(196,136,30,.25);';
    invites.forEach(function(inv, idx) {
        var row = _buildCrewInviteRow(inv);
        if (idx === invites.length - 1) row.style.borderBottom = 'none';
        list.appendChild(row);
    });

    var open = false;
    head.onclick = function() {
        open = !open;
        if (open) {
            list.style.maxHeight = (invites.length * 88 + 16) + 'px';
            list.style.opacity = '1';
            list.style.padding = '10px 12px 12px';
            chev.style.transform = 'rotate(180deg)';
        } else {
            list.style.maxHeight = '0';
            list.style.opacity = '0';
            list.style.padding = '0 12px';
            chev.style.transform = '';
        }
    };

    wrap.appendChild(head);
    wrap.appendChild(list);
    return wrap;
}

// Fila individual de invitación (avatar crew + texto + Aceptar/Rechazar)
function _buildCrewInviteRow(inv) {
    var row = document.createElement('div');
    row.dataset.inviteId = inv.id;
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;'
        + 'border-bottom:1px solid rgba(196,136,30,.15);';
    // (último sin border-bottom — lo hacemos con :last-child equivalente via JS)
    var av = document.createElement('div');
    av.style.cssText = 'width:42px;height:42px;border-radius:12px;background:var(--silver-grad);'
        + 'display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;'
        + 'overflow:hidden;flex-shrink:0;';
    if (inv.crew && inv.crew.avatar_url) {
        var img = document.createElement('img');
        img.src = inv.crew.avatar_url; img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        av.appendChild(img);
    } else {
        av.textContent = (inv.crew && inv.crew.name || '?')[0].toUpperCase();
    }
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;line-height:1.25;';
    var crewName = document.createElement('div');
    crewName.style.cssText = 'font-size:13px;font-weight:800;color:var(--tw);'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    crewName.textContent = (inv.crew && inv.crew.name) || 'Crew';
    var byLine = document.createElement('div');
    byLine.style.cssText = 'font-size:10.5px;color:var(--tm);margin-top:2px;';
    var _invName = (inv.inviter && (inv.inviter.display_name || inv.inviter.username)) || '?';
    byLine.textContent = 'Invitado por ' + _invName;
    info.appendChild(crewName);
    info.appendChild(byLine);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:5px;flex-shrink:0;';
    var rejectBtn = document.createElement('button');
    rejectBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:1px solid rgba(239,68,68,.35);'
        + 'background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    rejectBtn.setAttribute('aria-label', 'Rechazar');
    rejectBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    var acceptBtn = document.createElement('button');
    acceptBtn.style.cssText = 'height:30px;padding:0 12px;border-radius:15px;border:none;cursor:pointer;'
        + 'background:var(--silver-grad);color:#fff;'
        + 'font-family:var(--f);font-size:11px;font-weight:800;letter-spacing:.3px;';
    acceptBtn.textContent = 'Aceptar';
    actions.appendChild(rejectBtn);
    actions.appendChild(acceptBtn);

    acceptBtn.onclick = function() { _acceptCrewInvite(inv, row, acceptBtn, rejectBtn); };
    rejectBtn.onclick = function() { _rejectCrewInvite(inv, row, acceptBtn, rejectBtn); };

    row.appendChild(av);
    row.appendChild(info);
    row.appendChild(actions);
    return row;
}

// ── Aceptar invitación ────────────────────────────────────────────
async function _acceptCrewInvite(inv, row, acceptBtn, rejectBtn) {
    var sb = window._sbClient;
    acceptBtn.disabled = true; rejectBtn.disabled = true;
    acceptBtn.style.opacity = '.6';
    acceptBtn.textContent = 'Entrando…';
    try {
        var { error } = await sb.rpc('accept_crew_invite', { _invite_id: inv.id });
        if (error) throw error;
        // Refrescar estado y repintar lista entera
        await _refreshMyCrews();
        await _refreshMyCrewInvites();
        if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();
        if (typeof showToast === 'function') {
            showToast('Te has unido a ' + (inv.crew && inv.crew.name || 'el crew'), 2200);
        }
        // Repintar la pestaña Crews si está visible
        if (typeof renderClubCrewsList === 'function') renderClubCrewsList();
    } catch (e) {
        console.error('[MR] accept invite failed:', e);
        alert('No se pudo aceptar la invitación.\n' + (e.message || e));
        acceptBtn.disabled = false; rejectBtn.disabled = false;
        acceptBtn.style.opacity = '1';
        acceptBtn.textContent = 'Aceptar';
    }
}
window._acceptCrewInvite = _acceptCrewInvite;

// ── Rechazar invitación ───────────────────────────────────────────
async function _rejectCrewInvite(inv, row, acceptBtn, rejectBtn) {
    var sb = window._sbClient;
    acceptBtn.disabled = true; rejectBtn.disabled = true;
    rejectBtn.style.opacity = '.5';
    try {
        // Borramos la invitación (la policy permite al invitado borrarla)
        var { error } = await sb.from('crew_invites').delete().eq('id', inv.id);
        if (error) throw error;
        await _refreshMyCrewInvites();
        if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();
        // Animación de salida de la fila
        row.style.transition = 'opacity .25s ease, transform .25s ease, max-height .25s ease, margin .25s ease, padding .25s ease';
        row.style.opacity = '0';
        row.style.maxHeight = '0';
        row.style.padding = '0';
        row.style.margin = '0';
        setTimeout(function() {
            // Si ya no quedan invitaciones, repintar para quitar el banner entero
            if (!getMyCrewInvites().length && typeof renderClubCrewsList === 'function') {
                renderClubCrewsList();
            } else {
                row.remove();
            }
        }, 260);
    } catch (e) {
        console.error('[MR] reject invite failed:', e);
        alert('No se pudo rechazar.\n' + (e.message || e));
        acceptBtn.disabled = false; rejectBtn.disabled = false;
        rejectBtn.style.opacity = '1';
    }
}
window._rejectCrewInvite = _rejectCrewInvite;

// ── LISTA DE CREWS INLINE EN EL FEED ───────────────────────────────
// Cuando la pestaña "Crews" está activa, el contenedor #club-feed se
// sustituye por esta lista. Tap en una tarjeta → openCrewDetail.
// Botón "+ Crear crew" al final.
async function renderClubCrewsList() {
    var container = document.getElementById('club-feed');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:13px;">Cargando crews…</div>';

    // Refrescamos desde BD por si algo cambió en otro dispositivo
    if (typeof _refreshMyCrews === 'function') {
        try { await _refreshMyCrews(); } catch (e) {}
    }
    if (typeof _refreshMyCrewInvites === 'function') {
        try { await _refreshMyCrewInvites(); } catch (e) {}
    }
    var crews = getMyCrews();
    var invites = getMyCrewInvites();

    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:4px 0 20px;display:flex;flex-direction:column;gap:10px;';

    // ─── Banner de invitaciones pendientes (si hay) ───
    if (invites.length) {
        var banner = _buildCrewInvitesBanner(invites);
        wrap.appendChild(banner);
    }

    if (!crews.length) {
        // Estado vacío
        var empty = document.createElement('div');
        empty.style.cssText = 'margin-top:30px;text-align:center;padding:30px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;';
        empty.innerHTML =
            '<div style="width:84px;height:84px;border-radius:50%;background:linear-gradient(135deg,var(--silver-tint),var(--silver-tint));border:2px dashed var(--silver-bd);display:flex;align-items:center;justify-content:center;">'
              + '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="var(--silver)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
              + '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
              + '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
              + '</svg>'
            + '</div>'
            + '<div style="font-size:16px;font-weight:800;color:var(--tw);">Aún no estás en ningún Crew</div>'
            + '<div style="font-size:12.5px;color:var(--tm);max-width:280px;line-height:1.45;">'
              + 'Los Crews son grupos privados de runners. Comparte rutas, planes o cervezas post-tirada solo con los tuyos.'
            + '</div>';
        wrap.appendChild(empty);
    } else {
        // Cabecera mini con contador
        var hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0 2px 4px;';
        var ct = document.createElement('div');
        ct.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.4px;';
        ct.textContent = crews.length + ' CREW' + (crews.length === 1 ? '' : 'S');
        hdr.appendChild(ct);
        wrap.appendChild(hdr);

        // Tarjetas
        var _crewsStaggerStart = wrap.children.length;
        crews.forEach(function(c) {
            var card = document.createElement('div');
            card.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;'
                + 'background:var(--card);border:1px solid var(--border);cursor:pointer;'
                + 'transition:transform .15s ease, box-shadow .15s ease;';
            card.onmouseenter = function() { card.style.boxShadow = '0 2px 10px rgba(0,0,0,.08)'; };
            card.onmouseleave = function() { card.style.boxShadow = ''; };
            card.onclick = function() { openCrewDetail(c); };

            // Avatar verde oliva
            var av = document.createElement('div');
            av.style.cssText = 'width:48px;height:48px;border-radius:14px;background:var(--silver-grad);'
                + 'display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;'
                + 'overflow:hidden;flex-shrink:0;';
            if (c.avatar_url) {
                var img = document.createElement('img');
                img.src = c.avatar_url; img.loading = 'lazy';
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                av.appendChild(img);
            } else {
                av.textContent = (c.name || '?')[0].toUpperCase();
            }
            // Info
            var info = document.createElement('div');
            info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;';
            var nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-size:14.5px;font-weight:800;color:var(--tw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            nameEl.textContent = c.name || 'Crew';
            var roleEl = document.createElement('div');
            roleEl.style.cssText = 'font-size:10.5px;color:var(--tm);display:flex;align-items:center;gap:6px;';
            var roleLabel = c.role === 'owner' ? 'Propietario' : (c.role === 'admin' ? 'Admin' : 'Miembro');
            var roleColor = c.role === 'owner' ? '#c4881e' : (c.role === 'admin' ? 'var(--silver)' : 'var(--tm)');
            roleEl.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + roleColor + ';"></span>'
                + '<span style="font-weight:700;color:' + roleColor + ';letter-spacing:.2px;">' + roleLabel + '</span>';
            info.appendChild(nameEl);
            info.appendChild(roleEl);

            // Botón Editar (sólo owner)
            if (c.role === 'owner') {
                var editBtn = document.createElement('button');
                editBtn.setAttribute('aria-label', 'Editar crew');
                editBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;border:1px solid var(--border);'
                    + 'background:var(--bg);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
                editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--silver)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
                editBtn.onclick = function(ev) {
                    ev.stopPropagation();
                    openCrewEditor({
                        id: c.id,
                        name: c.name,
                        description: c.description || '',
                        avatar_url: c.avatar_url || null
                    });
                };
                card.appendChild(av);
                card.appendChild(info);
                card.appendChild(editBtn);
            } else {
                var chev = document.createElement('div');
                chev.style.cssText = 'flex-shrink:0;opacity:.5;';
                chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';
                card.appendChild(av);
                card.appendChild(info);
                card.appendChild(chev);
            }
            wrap.appendChild(card);
        });
        try {
            var _crewsNew = Array.prototype.slice.call(wrap.children, _crewsStaggerStart);
            if (typeof _staggerIn === 'function') _staggerIn(_crewsNew, { step: 40 });
        } catch(_) {}
    }

    // Botón "+ Crear crew" siempre visible al final
    var createBtn = document.createElement('button');
    createBtn.style.cssText = 'margin-top:6px;height:46px;border-radius:23px;border:none;cursor:pointer;'
        + 'background:var(--silver-grad);color:#fff;font-family:var(--f);'
        + 'font-size:14px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:7px;'
        + 'box-shadow:0 3px 10px rgba(80,85,92,.25);';
    createBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
        + '<span>Crear crew</span>';
    createBtn.onclick = function() { openCrewEditor(); };
    wrap.appendChild(createBtn);

    container.appendChild(wrap);
}
window.renderClubCrewsList = renderClubCrewsList;

// Helper unificado: tras crear/editar/eliminar/salir, repinta la vista
// de crews que esté visible (la pestaña inline o el overlay legado).
function _refreshCrewsListIfVisible() {
    // Caso 1: overlay legado abierto
    var crewsView = document.getElementById('club-crews-view');
    if (crewsView) {
        crewsView.remove();
        setTimeout(function() { openMyCrews(); }, 60);
        return;
    }
    // Caso 2: pestaña Crews activa dentro del Club
    var mode = localStorage.getItem(_uk('mr_club_tab')) || 'all';
    if (mode === 'crews' && document.getElementById('club-feed')) {
        renderClubCrewsList();
    }
}
window._refreshCrewsListIfVisible = _refreshCrewsListIfVisible;

// ══ [FASE 7] RANKING GLOBAL DE PRs DEL CLUB ═══════════════════════════
// Cuando la pestaña "Récords" está activa, el contenedor #club-feed se
// sustituye por un ranking de los 8 PRs de tiempo más populares
// (5K / 10K / Media / Maratón / 3000m / 1K / 100m / Mejor pace medio).
//
// Datos:
//   - Lee de la tabla `user_records` aprovechando la policy
//     `records_public_read` (SELECT true) que ya está activa.
//   - Para cada record_type hace UNA query con ORDER BY value ASC
//     LIMIT 10 (tiempos: menor = mejor).
//   - Hidrata los profiles (username + avatar) en una sola query
//     extra in('id', [...]) tras juntar todos los user_ids únicos.
//
// Scope (sub-toggle Global / Siguiendo):
//   - mr_club_records_scope = 'global' (default) | 'following'
//   - 'following' filtra por los user_ids que sigo + yo mismo.
//
// Render:
//   - Top 3 colapsado con medallas oro/plata/bronce SIN texto.
//   - Botón "Ver Top 10 ▾" expande a top 10.
//   - Si yo (el usuario actual) NO estoy en el top mostrado, aparece
//     un separador "TU POSICIÓN" + mi fila con la posición numérica.
//   - Si yo no tengo ese récord, empty state "Aún no tienes este récord".
//   - Click en avatar → openUserProfile(uid, username, avatarUrl).
//
// El estado UI (qué secciones están expandidas) es VOLÁTIL: vive en
// una variable de closure, NO se persiste. Coherente con S26.C-2.
const RECORDS_RANKING_ORDER = [
    { type: 'best_5k',       label: 'Mejor 5K',           medalText: '5K'  },
    { type: 'best_10k',      label: 'Mejor 10K',          medalText: '10K' },
    { type: 'best_half',     label: 'Media maratón',      medalText: '21K' },
    { type: 'best_marathon', label: 'Maratón',            medalText: '42K' },
    { type: 'best_3000m',    label: 'Mejor 3000m',        medalText: '3K'  },
    { type: 'best_1k',       label: 'Mejor 1K',           medalText: '1K'  },
    { type: 'best_100m',     label: 'Mejor 100m',         medalText: null  },
    { type: 'best_pace',     label: 'Mejor pace medio',   medalText: 'PR'  }
];

// Estado UI volátil para "qué secciones están expandidas a top 10"
var _clubRecordsExpanded = {};

function _getClubRecordsScope() {
    return localStorage.getItem(_uk('mr_club_records_scope')) || 'global';
}
function _setClubRecordsScope(scope) {
    if (scope !== 'global' && scope !== 'following') scope = 'global';
    localStorage.setItem(_uk('mr_club_records_scope'), scope);
}

// Medalla de posición pequeñita (sin texto) para top 3
function _buildPositionMedalSVG(rank, size) {
    if (typeof window._buildMedalSVG !== 'function') return '';
    size = size || 28;
    var tier;
    if (rank === 1) tier = 'gold';
    else if (rank === 2) tier = 'silver';
    else if (rank === 3) tier = 'bronze';
    else return '';
    var svg = window._buildMedalSVG({ tier: tier, centerText: null });
    // Sustituir size del SVG (default 56x64)
    var h = Math.round(size * 64 / 56);
    return svg.replace('width="56" height="64"', 'width="' + size + '" height="' + h + '"');
}

// Bonita fecha "YYYY-MM-DD" → "18 abr 2026". Reusa la del _openPRsSheet.
function _clubRecordsPrettyDate(dateStr) {
    if (typeof window._prsPrettyDate === 'function') return window._prsPrettyDate(dateStr);
    try {
        var parts = String(dateStr).split('-').map(Number);
        var meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        return parts[2] + ' ' + meses[parts[1]-1] + ' ' + parts[0];
    } catch(_) { return dateStr; }
}

// Construir el avatar circular (con foto o iniciales)
function _buildClubRecordAvatar(prof, isMe) {
    var av = document.createElement('div');
    var isDark = document.body.classList.contains('dark-mode');
    var initials = (prof.display_name || prof.username || '?').slice(0, 2).toUpperCase();
    var baseStyle = 'width:36px;height:36px;border-radius:50%;flex-shrink:0;cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;'
        + 'color:#3C2C08;font-size:14px;font-weight:900;font-family:var(--f);'
        + 'background:linear-gradient(135deg, #C9A84C, #8A6E1F);'
        + 'transition:transform .15s ease;'
        + 'overflow:hidden;'
        + (isMe ? 'border:2px solid var(--gold);' : 'border:2px solid transparent;');
    av.style.cssText = baseStyle;
    if (prof.avatar_url) {
        var img = document.createElement('img');
        img.src = prof.avatar_url;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        img.onerror = function() {
            img.remove();
            av.textContent = initials;
        };
        av.appendChild(img);
    } else {
        av.textContent = initials;
    }
    av.addEventListener('touchstart', function() { av.style.transform = 'scale(.95)'; }, { passive: true });
    av.addEventListener('touchend',   function() { av.style.transform = ''; }, { passive: true });
    return av;
}

// Construir UNA fila del ranking
function _buildClubRecordRow(rank, prof, value, type, dateStr, isMe, isMeOutOfTop, showPrivateLock) {
    var row = document.createElement('li');
    var isDark = document.body.classList.contains('dark-mode');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;'
        + 'border-bottom:1px solid var(--border);'
        + 'list-style:none;'
        + (isMe ? (isDark ? 'background:rgba(201,168,76,.10);' : 'background:rgba(201,168,76,.08);') : '');

    // Posición: medalla para top 3, círculo gris numerado para el resto
    var posWrap = document.createElement('div');
    posWrap.style.cssText = 'width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
    if (rank <= 3 && !isMeOutOfTop) {
        posWrap.innerHTML = _buildPositionMedalSVG(rank, 28);
    } else {
        var posNum = document.createElement('div');
        posNum.style.cssText = 'width:32px;height:32px;border-radius:50%;background:var(--bg);'
            + 'border:1px solid var(--border);color:var(--tm);font-size:13px;font-weight:800;font-family:var(--f);'
            + 'display:flex;align-items:center;justify-content:center;';
        posNum.textContent = rank;
        posWrap.appendChild(posNum);
    }
    row.appendChild(posWrap);

    // Avatar (clickable → openUserProfile)
    var av = _buildClubRecordAvatar(prof, isMe);
    if (!isMe && typeof window.openUserProfile === 'function') {
        (function(_id, _un, _ua) {
            av.onclick = function() { window.openUserProfile(_id, _un, _ua); };
        })(prof.id, prof.display_name || prof.username, prof.avatar_url);
    }
    row.appendChild(av);

    // Info: nombre + fecha
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:13px;font-weight:800;color:var(--tw);'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;';
    nameEl.textContent = prof.display_name || prof.username || 'Runner';
    if (isMe) {
        var meBadge = document.createElement('span');
        meBadge.style.cssText = 'font-size:10px;font-weight:800;color:var(--gold);letter-spacing:.5px;margin-left:4px;';
        meBadge.textContent = '· TÚ';
        nameEl.appendChild(meBadge);
        // [FASE 7.B] Candadito dorado si soy privado (sólo visible para mí)
        if (showPrivateLock && typeof window._buildPrivateLockBadgeSVG === 'function') {
            var lockSpan = document.createElement('span');
            lockSpan.innerHTML = window._buildPrivateLockBadgeSVG();
            // Insertar el contenido del span (no el wrapper) directamente
            var lockEl = lockSpan.firstChild;
            if (lockEl) nameEl.appendChild(lockEl);
        }
    }
    info.appendChild(nameEl);
    if (dateStr) {
        var dateEl = document.createElement('div');
        dateEl.style.cssText = 'font-size:10px;font-weight:600;color:var(--tm);margin-top:2px;';
        dateEl.textContent = _clubRecordsPrettyDate(dateStr);
        info.appendChild(dateEl);
    }
    row.appendChild(info);

    // Valor
    var valEl = document.createElement('div');
    valEl.style.cssText = 'font-size:15px;font-weight:900;color:var(--tw);letter-spacing:-.3px;'
        + 'font-variant-numeric:tabular-nums;';
    if (typeof window._formatRecordValue === 'function') {
        valEl.textContent = window._formatRecordValue(type, value);
    } else {
        valEl.textContent = String(value);
    }
    row.appendChild(valEl);

    // Click en toda la fila (excepto avatar) abre perfil
    if (!isMe && typeof window.openUserProfile === 'function') {
        (function(_id, _un, _ua) {
            row.onclick = function(e) {
                // Si clickaron el avatar, ya se maneja allí
                if (e.target.closest('div[style*="border-radius:50%"]') && e.target.closest('div[style*="border-radius:50%"]') !== posWrap) {
                    return;
                }
                window.openUserProfile(_id, _un, _ua);
            };
            row.style.cursor = 'pointer';
        })(prof.id, prof.display_name || prof.username, prof.avatar_url);
    }

    return row;
}

// Renderiza UNA sección (un PR con su top + posibles extras)
function _renderClubRecordSection(container, def, rows, myId, profilesById, myIsPublic) {
    var isDark = document.body.classList.contains('dark-mode');
    var section = document.createElement('div');
    section.className = 'mr-club-record-section';
    section.dataset.type = def.type;
    section.style.cssText = 'background:var(--card);margin:0 15px 14px;'
        + 'border:1px solid var(--border);border-radius:16px;'
        + 'overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04);';

    // ── Header de la sección ──
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px 10px;border-bottom:1px solid var(--border);';

    var medalWrap = document.createElement('div');
    medalWrap.style.cssText = 'width:42px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
    if (typeof window._getPRMeta === 'function' && typeof window._buildMedalSVG === 'function') {
        var meta = window._getPRMeta(def.type) || { tier: 'gold', centerText: def.medalText };
        var svg = window._buildMedalSVG(meta);
        // Reducir el SVG de 56x64 a 42x48 para el header
        medalWrap.innerHTML = svg.replace('width="56" height="64"', 'width="42" height="48"');
    }
    header.appendChild(medalWrap);

    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    var lblEl = document.createElement('div');
    lblEl.style.cssText = 'font-size:13px;font-weight:800;color:var(--tw);letter-spacing:-.2px;line-height:1.2;';
    lblEl.textContent = def.label;
    info.appendChild(lblEl);
    var subEl = document.createElement('div');
    subEl.style.cssText = 'font-size:10.5px;font-weight:700;color:var(--tm);margin-top:2px;letter-spacing:.3px;text-transform:uppercase;';
    var participantes = rows.length;
    subEl.textContent = participantes + (participantes === 1 ? ' participante' : ' participantes');
    info.appendChild(subEl);
    header.appendChild(info);

    section.appendChild(header);

    // ── Lista ──
    var ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;margin:0;padding:0;';

    var isExpanded = !!_clubRecordsExpanded[def.type];
    var maxVisible = isExpanded ? 10 : 3;

    if (!rows.length) {
        // Estado totalmente vacío (nadie tiene este récord en el scope)
        var empty = document.createElement('li');
        empty.style.cssText = 'padding:18px 14px;text-align:center;color:var(--tm);font-size:12px;font-weight:700;list-style:none;';
        empty.innerHTML = '<div style="font-size:24px;margin-bottom:8px;opacity:.5;">🏃</div>Sin participantes aún en este récord';
        ul.appendChild(empty);
    } else {
        // Pintar el top N
        var myPosInList = -1;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].user_id === myId) { myPosInList = i + 1; break; }
        }
        var visibleRows = rows.slice(0, maxVisible);
        visibleRows.forEach(function(r, idx) {
            var rank = idx + 1;
            var prof = profilesById[r.user_id] || { id: r.user_id, username: null, display_name: 'Runner', avatar_url: null };
            var isMe = (r.user_id === myId);
            // Si soy yo Y soy privado, mostrar candadito
            var showLock = isMe && !myIsPublic;
            ul.appendChild(_buildClubRecordRow(rank, prof, r.value, def.type, r.activity_datestr, isMe, false, showLock));
        });

        // Quitar borde a la última fila visible (estética)
        var lastChild = ul.lastChild;
        if (lastChild && lastChild.style) lastChild.style.borderBottom = 'none';

        // ¿Estoy fuera del top mostrado pero TENGO este récord?
        if (myPosInList > maxVisible) {
            // Separador
            var sep = document.createElement('li');
            sep.style.cssText = 'padding:6px 14px;background:var(--bg);font-size:10px;font-weight:800;'
                + 'color:var(--tm);letter-spacing:1.2px;text-transform:uppercase;'
                + 'border-bottom:1px solid var(--border);border-top:1px solid var(--border);'
                + 'list-style:none;';
            sep.textContent = 'Tu posición';
            ul.appendChild(sep);
            // Restaurar borde inferior a la última fila del top (ahora hay continuación)
            if (lastChild && lastChild.style) lastChild.style.borderBottom = '1px solid var(--border)';
            // Mi fila con posición numérica
            var myRow = rows[myPosInList - 1];
            var myProf = profilesById[myRow.user_id] || { id: myRow.user_id, username: null, display_name: 'Tú', avatar_url: null };
            var showLockOut = !myIsPublic;
            var meRowEl = _buildClubRecordRow(myPosInList, myProf, myRow.value, def.type, myRow.activity_datestr, true, true, showLockOut);
            meRowEl.style.borderBottom = 'none';
            ul.appendChild(meRowEl);
        } else if (myPosInList === -1) {
            // No tengo este récord
            var sep2 = document.createElement('li');
            sep2.style.cssText = 'padding:6px 14px;background:var(--bg);font-size:10px;font-weight:800;'
                + 'color:var(--tm);letter-spacing:1.2px;text-transform:uppercase;'
                + 'border-bottom:1px solid var(--border);border-top:1px solid var(--border);'
                + 'list-style:none;';
            sep2.textContent = 'Tu posición';
            ul.appendChild(sep2);
            if (lastChild && lastChild.style) lastChild.style.borderBottom = '1px solid var(--border)';
            var emptyMe = document.createElement('li');
            emptyMe.style.cssText = 'padding:14px;text-align:center;color:var(--tm);font-size:12px;font-weight:700;list-style:none;';
            emptyMe.textContent = 'Aún no tienes este récord';
            ul.appendChild(emptyMe);
        }
    }

    section.appendChild(ul);

    // ── Botón "Ver Top 10 ▾" / "Ocultar ▴" ──
    // Sólo si hay más de 3 filas O si está expandido
    if (rows.length > 3) {
        var moreBtn = document.createElement('button');
        moreBtn.style.cssText = 'width:100%;background:transparent;border:none;'
            + 'border-top:1px solid var(--border);padding:11px;'
            + 'font-family:var(--f);font-size:12px;font-weight:700;color:var(--tm);'
            + 'cursor:pointer;letter-spacing:.3px;'
            + 'transition:color .2s ease, background .2s ease;';
        if (isExpanded) {
            moreBtn.textContent = 'Ocultar ▴';
        } else {
            moreBtn.textContent = 'Ver Top ' + Math.min(10, rows.length) + ' ▾';
        }
        (function(_t) {
            moreBtn.onclick = function() {
                _clubRecordsExpanded[_t] = !_clubRecordsExpanded[_t];
                // Re-renderizar solo esta sección
                if (typeof renderClubRecordsRanking === 'function') {
                    renderClubRecordsRanking();
                }
            };
        })(def.type);
        section.appendChild(moreBtn);
    }

    container.appendChild(section);
}

// Render principal de la pestaña Récords
async function renderClubRecordsRanking() {
    var container = document.getElementById('club-feed');
    if (!container) return;

    var sb = window._sbClient;
    if (!sb) {
        container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:13px;">Sin sesión activa.</div>';
        return;
    }

    // Skeleton de carga
    container.innerHTML = '';
    var loadingWrap = document.createElement('div');
    loadingWrap.style.cssText = 'padding:12px 0 20px;';
    for (var k = 0; k < 3; k++) {
        var skel = document.createElement('div');
        skel.style.cssText = 'background:var(--card);margin:0 15px 14px;border:1px solid var(--border);'
            + 'border-radius:16px;height:180px;'
            + 'background:linear-gradient(90deg, var(--card) 0%, rgba(201,168,76,.12) 50%, var(--card) 100%);'
            + 'background-size:200% 100%;animation:mrPrsShimmer 1.6s ease-in-out infinite;';
        loadingWrap.appendChild(skel);
    }
    container.appendChild(loadingWrap);

    // Inyectar keyframe shimmer si no existe (lo usa _openPRsSheet también)
    if (!document.getElementById('mr-prs-anim-style')) {
        var style = document.createElement('style');
        style.id = 'mr-club-records-anim-style';
        style.textContent = '@keyframes mrPrsShimmer { 0% { background-position:-200% 0; } 100% { background-position:200% 0; } }';
        document.head.appendChild(style);
    }

    try {
        // Sesión actual
        var sessionRes = await sb.auth.getSession();
        var session = sessionRes && sessionRes.data && sessionRes.data.session;
        if (!session) {
            container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:13px;">Sin sesión activa.</div>';
            return;
        }
        var myId = session.user.id;

        // ── Resolver scope ──
        var scope = _getClubRecordsScope();
        var allowedUserIds = null; // null = sin filtro (global)
        if (scope === 'following') {
            // Mis seguidos + yo mismo
            var followsRes = await sb.from('follows')
                .select('following_id')
                .eq('follower_id', myId);
            var followingIds = ((followsRes && followsRes.data) || []).map(function(r) { return r.following_id; });
            allowedUserIds = followingIds.concat([myId]);
            // Dedup
            allowedUserIds = Array.from(new Set(allowedUserIds));
        }

        // ── Una query por cada record_type ──
        var types = RECORDS_RANKING_ORDER.map(function(d) { return d.type; });
        var queries = types.map(function(t) {
            var q = sb.from('user_records')
                .select('user_id, value, activity_local_id, activity_datestr, achieved_at')
                .eq('record_type', t)
                .order('value', { ascending: true })  // tiempos: menor = mejor
                .limit(30); // limit 30 para tener margen si Álvaro está en posiciones 11-30
            if (allowedUserIds && allowedUserIds.length) {
                q = q.in('user_id', allowedUserIds);
            } else if (allowedUserIds && !allowedUserIds.length) {
                // Sin seguidos + yo solo: forzar resultado vacío (no debería pasar porque siempre incluyo myId)
                q = q.in('user_id', ['00000000-0000-0000-0000-000000000000']);
            }
            return q;
        });
        var resultsByType = await Promise.all(queries);

        // ── Recolectar todos los user_ids únicos para hidratar profiles ──
        var userIdsSet = {};
        var rowsByType = {};
        resultsByType.forEach(function(res, idx) {
            var t = types[idx];
            var data = (res && res.data) || [];
            rowsByType[t] = data;
            data.forEach(function(r) { userIdsSet[r.user_id] = true; });
        });
        var userIds = Object.keys(userIdsSet);

        // Hidratar profiles en una sola query
        var profilesById = {};
        if (userIds.length) {
            var profRes = await sb.from('profiles')
                .select('id, username, display_name, avatar_url')
                .in('id', userIds);
            ((profRes && profRes.data) || []).forEach(function(p) {
                profilesById[p.id] = p;
            });
        }

        // ── Limpiar skeleton y pintar ──
        container.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.style.cssText = 'padding:0 0 80px;';

        // Sub-toggle Global / Siguiendo
        var scopeRow = document.createElement('div');
        scopeRow.style.cssText = 'margin:10px 15px 12px;display:flex;background:var(--card);'
            + 'border:1px solid var(--border);border-radius:10px;padding:3px;';
        var btnGlobal = document.createElement('button');
        var btnFollow = document.createElement('button');
        var scopeBase = 'flex:1;height:30px;border:none;border-radius:8px;background:transparent;'
            + 'font-family:var(--f);font-size:11px;font-weight:700;letter-spacing:.3px;cursor:pointer;color:var(--tm);'
            + 'transition:background .2s ease, color .2s ease;';
        var scopeActive = 'background:var(--bg);color:var(--tw);box-shadow:0 1px 3px rgba(0,0,0,.08);';
        btnGlobal.style.cssText = scopeBase + (scope === 'global' ? scopeActive : '');
        btnFollow.style.cssText = scopeBase + (scope === 'following' ? scopeActive : '');
        btnGlobal.textContent = 'Global';
        btnFollow.textContent = 'Siguiendo';
        btnGlobal.onclick = function() {
            if (scope === 'global') return;
            _setClubRecordsScope('global');
            renderClubRecordsRanking();
        };
        btnFollow.onclick = function() {
            if (scope === 'following') return;
            _setClubRecordsScope('following');
            renderClubRecordsRanking();
        };
        scopeRow.appendChild(btnGlobal);
        scopeRow.appendChild(btnFollow);
        wrap.appendChild(scopeRow);

        // [FASE 7.B] ¿Soy público o privado? Para mostrar candado en mi fila.
        var myIsPublic = await getMyPRsPublic();

        // Render cada sección (incluso si vacía)
        RECORDS_RANKING_ORDER.forEach(function(def) {
            var rows = rowsByType[def.type] || [];
            _renderClubRecordSection(wrap, def, rows, myId, profilesById, myIsPublic);
        });

        container.appendChild(wrap);

    } catch (err) {
        console.error('[MR][FASE7] Error renderizando ranking:', err);
        container.innerHTML = '<div style="text-align:center;padding:40px 30px;color:var(--tm);font-size:13px;">'
            + '<div style="font-size:32px;margin-bottom:10px;">⚠️</div>'
            + 'No se pudo cargar el ranking. Inténtalo más tarde.'
            + '</div>';
    }
}
window.renderClubRecordsRanking = renderClubRecordsRanking;
window._buildPositionMedalSVG = _buildPositionMedalSVG;

// ══ [FASE 7.B] PRIVACIDAD DE PRs ══════════════════════════════════════
// Toggle para que el usuario decida si sus PRs son visibles en el
// ranking del Club o no. Persistencia en columna `profiles.prs_public`.
// La policy RLS `records_public_read_gated` (creada en Supabase) blinda
// esto a nivel BD: si prs_public=false, NADIE puede leer mis records
// (excepto yo mismo).
//
// Defaults: false (privado). Hay que activarlo explícitamente.
// Tu propia fila siempre aparece en el ranking (la policy permite
// auth.uid()=user_id), pero con un mini candado dorado si eres privado.
// ─────────────────────────────────────────────────────────────────────

// Caché en memoria del estado actual (true/false/null si no cargado)
var _myPRsPublic = null;

// Lee el estado actual de prs_public del usuario logueado.
// Devuelve true/false. Cachea en _myPRsPublic.
async function getMyPRsPublic(forceRefresh) {
    if (_myPRsPublic !== null && !forceRefresh) return _myPRsPublic;
    try {
        var sb = window._sbClient;
        if (!sb) return false;
        var sessionRes = await sb.auth.getSession();
        var session = sessionRes && sessionRes.data && sessionRes.data.session;
        if (!session) return false;
        var profRes = await sb.from('profiles')
            .select('prs_public')
            .eq('id', session.user.id)
            .single();
        if (profRes && profRes.data) {
            _myPRsPublic = !!profRes.data.prs_public;
        } else {
            _myPRsPublic = false;
        }
        return _myPRsPublic;
    } catch (e) {
        console.warn('[MR][FASE7.B] getMyPRsPublic falló:', e);
        return false;
    }
}
window.getMyPRsPublic = getMyPRsPublic;

// Refresca el icono del botón candado según el estado actual.
// - Privado (default): candado cerrado, color crimson (rojo Club)
// - Público:           candado abierto, color gold (oro Club)
async function _refreshPrivacyBtn() {
    var btn = document.getElementById('club-privacy-btn');
    if (!btn) return;
    var isPublic = await getMyPRsPublic();
    var color = isPublic ? '#c4881e' : '#a32130';
    var bg = isPublic
        ? 'background:linear-gradient(135deg,rgba(196,136,30,.10),rgba(196,136,30,.04));'
        : 'background:var(--card);';
    btn.style.cssText = 'width:44px;height:42px;border-radius:11px;border:1.5px solid '
        + (isPublic ? 'var(--gold-bd)' : 'rgba(163,33,48,.35)')
        + ';' + bg
        + 'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
        + 'transition:background .2s ease, border-color .2s ease;';
    if (isPublic) {
        // Candado abierto (open lock)
        btn.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
        btn.setAttribute('aria-label', 'Mis récords son públicos. Tap para hacerlos privados.');
        btn.title = 'Récords públicos · tap para privatizar';
    } else {
        // Candado cerrado (closed lock)
        btn.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        btn.setAttribute('aria-label', 'Mis récords son privados. Tap para hacerlos públicos.');
        btn.title = 'Récords privados · tap para publicar';
    }
}
window._refreshPrivacyBtn = _refreshPrivacyBtn;

// Handler del botón candado. Si actualmente privado → muestra modal de
// confirmación antes de hacer público. Si público → privatiza directo.
async function toggleMyPRsPublic() {
    var isPublic = await getMyPRsPublic();
    if (isPublic) {
        // Público → privado: instantáneo, sin confirmación
        await _setMyPRsPublic(false);
        if (typeof showToast === 'function') {
            showToast('Tus récords ya son privados', 3000);
        }
    } else {
        // Privado → público: modal de confirmación obligatorio
        _openPRsPublicConfirmModal();
    }
}
window.toggleMyPRsPublic = toggleMyPRsPublic;

// Hace el UPDATE en BD, refresca caché y repinta UI.
async function _setMyPRsPublic(newValue) {
    var sb = window._sbClient;
    if (!sb) return;
    try {
        var sessionRes = await sb.auth.getSession();
        var session = sessionRes && sessionRes.data && sessionRes.data.session;
        if (!session) return;
        var upd = await sb.from('profiles')
            .update({ prs_public: !!newValue })
            .eq('id', session.user.id);
        if (upd && upd.error) {
            console.error('[MR][FASE7.B] UPDATE prs_public falló:', upd.error);
            if (typeof showToast === 'function') {
                showToast('No se pudo actualizar la privacidad. Reintenta.', 4000);
            }
            return;
        }
        _myPRsPublic = !!newValue;
        await _refreshPrivacyBtn();
        // Si la tab Récords está visible, repintarla
        var mode = localStorage.getItem(_uk('mr_club_tab')) || 'all';
        if (mode === 'records' && typeof renderClubRecordsRanking === 'function') {
            renderClubRecordsRanking();
        }
    } catch (e) {
        console.error('[MR][FASE7.B] _setMyPRsPublic exception:', e);
    }
}

// Modal de confirmación al activar público. Reusa el lenguaje visual
// del modal "Compartir en el Club" (#club-share-confirm).
function _openPRsPublicConfirmModal() {
    if (document.getElementById('prs-public-confirm-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'prs-public-confirm-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:25500;background:rgba(0,0,0,.6);'
        + 'display:flex;align-items:flex-end;justify-content:center;'
        + 'opacity:0;transition:opacity .25s ease;'
        + '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);';
    modal.innerHTML = ''
        + '<div id="prs-public-confirm-inner" style="background:var(--card);border-radius:28px 28px 20px 20px;padding:28px 22px 22px;width:100%;max-width:420px;box-shadow:0 -4px 40px rgba(0,0,0,.35);transform:translateY(30px);transition:transform .3s cubic-bezier(.32,.72,0,1);">'
        +   '<div style="text-align:center;margin-bottom:22px;">'
        +     '<div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(196,136,30,.18),rgba(196,136,30,.06));border:2px solid var(--gold-bd);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 4px 20px rgba(196,136,30,.2);">'
        +       '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>'
        +     '</div>'
        +     '<div style="font-size:19px;font-weight:900;color:var(--tw);margin-bottom:8px;letter-spacing:-.3px;">Hacer públicos tus récords</div>'
        +     '<div style="font-size:13px;color:var(--ts);line-height:1.6;">Tus PRs y marcas serán visibles para<br>todos los usuarios del Club.<br><br>Podrás revertirlo en cualquier momento.</div>'
        +   '</div>'
        +   '<div style="display:flex;flex-direction:column;gap:10px;">'
        +     '<button id="prs-public-confirm-ok" style="width:100%;background:linear-gradient(135deg,var(--gold) 0%,#b87800 100%);border:none;border-radius:16px;padding:16px;font-family:var(--f);font-size:15px;font-weight:800;color:#fff;cursor:pointer;letter-spacing:.3px;box-shadow:0 4px 16px rgba(196,136,30,.4);">Hacer públicos ✓</button>'
        +     '<button id="prs-public-confirm-cancel" style="width:100%;background:transparent;border:1.5px solid var(--border);border-radius:16px;padding:14px;font-family:var(--f);font-size:14px;font-weight:600;color:var(--ts);cursor:pointer;">Cancelar</button>'
        +   '</div>'
        + '</div>';
    document.body.appendChild(modal);
    requestAnimationFrame(function() { requestAnimationFrame(function() {
        modal.style.opacity = '1';
        var inner = document.getElementById('prs-public-confirm-inner');
        if (inner) inner.style.transform = 'translateY(0)';
    }); });

    var closeModal = function() {
        modal.style.opacity = '0';
        var inner = document.getElementById('prs-public-confirm-inner');
        if (inner) inner.style.transform = 'translateY(30px)';
        setTimeout(function() { if (modal.parentNode) modal.remove(); }, 250);
    };

    document.getElementById('prs-public-confirm-ok').onclick = async function() {
        closeModal();
        await _setMyPRsPublic(true);
        if (typeof showToast === 'function') {
            showToast('Tus récords ya son públicos en el Club', 3000);
        }
    };
    document.getElementById('prs-public-confirm-cancel').onclick = closeModal;
    // Tap fuera para cerrar
    modal.addEventListener('click', function(e) {
        if (e.target === modal) closeModal();
    });
}

// Mini candado dorado para mostrar en mi fila cuando soy privado.
// SVG inline pequeño, dentro de un círculo gold sutil.
function _buildPrivateLockBadgeSVG() {
    return ''
        + '<span aria-label="Sólo visible para ti" title="Sólo visible para ti" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,rgba(196,136,30,.20),rgba(196,136,30,.08));border:1px solid var(--gold-bd);margin-left:5px;vertical-align:middle;flex-shrink:0;">'
        +   '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="11" rx="2" ry="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
        + '</span>';
}
window._buildPrivateLockBadgeSVG = _buildPrivateLockBadgeSVG;

// ── MODAL CREAR / EDITAR CREW ─────────────────────────────────────
// Si se llama sin parámetros: modo "crear". Si se le pasa un objeto
// crew (id, name, description, avatar_url): modo "editar".
async function openCrewEditor(existing) {
    var isEdit = !!(existing && existing.id);
    var sb = window._sbClient;

    // Evitar duplicados si pulsan el botón dos veces
    if (document.getElementById('crew-editor-modal')) return;

    // Backdrop oscuro a pantalla completa
    var backdrop = document.createElement('div');
    backdrop.id = 'crew-editor-modal';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:20020;background:rgba(0,0,0,.55);'
        + 'display:flex;align-items:center;justify-content:center;padding:18px;'
        + 'opacity:0;transition:opacity .2s ease;';

    // Tarjeta del modal
    var card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:380px;background:var(--bg);border-radius:18px;'
        + 'padding:18px 18px 14px;display:flex;flex-direction:column;gap:14px;'
        + 'max-height:90vh;overflow-y:auto;'
        + 'box-shadow:0 12px 40px rgba(0,0,0,.4);'
        + 'transform:translateY(20px);transition:transform .25s cubic-bezier(.32,.72,0,1);';

    // Cabecera
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;';
    head.innerHTML =
        '<div style="width:34px;height:34px;border-radius:50%;background:var(--silver-grad);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
          + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
          + '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
          + '</svg>'
        + '</div>'
        + '<div style="flex:1;">'
          + '<div style="font-size:16px;font-weight:800;color:var(--tw);">' + (isEdit ? 'Editar crew' : 'Nuevo crew') + '</div>'
          + '<div style="font-size:11px;color:var(--tm);">' + (isEdit ? 'Cambia los detalles de tu crew' : 'Crea un grupo privado de runners') + '</div>'
        + '</div>';
    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:none;background:var(--card);cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    head.appendChild(closeBtn);

    // ─── Selector de foto (round, tap para elegir) ───
    var photoWrap = document.createElement('div');
    photoWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
    var photoBtn = document.createElement('button');
    photoBtn.type = 'button';
    photoBtn.style.cssText = 'width:92px;height:92px;border-radius:50%;border:2px dashed var(--silver-bd);'
        + 'background:linear-gradient(135deg,var(--silver-tint),var(--silver-tint));cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0;position:relative;';
    var photoIcon = document.createElement('div');
    photoIcon.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--silver);';
    photoIcon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--silver)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
        + '<span style="font-size:9.5px;font-weight:700;letter-spacing:.3px;">FOTO</span>';
    photoBtn.appendChild(photoIcon);
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    photoWrap.appendChild(photoBtn);
    var photoHint = document.createElement('div');
    photoHint.style.cssText = 'font-size:10.5px;color:var(--tm);';
    photoHint.textContent = 'Toca para elegir foto (opcional)';
    photoWrap.appendChild(photoHint);
    photoWrap.appendChild(fileInput);

    // Estado en memoria de la foto: o bien una URL ya subida (al editar)
    // o bien un Blob nuevo pendiente de subir.
    var pendingPhotoBlob = null;
    var existingAvatarUrl = isEdit ? (existing.avatar_url || null) : null;

    function renderPhotoPreview(src) {
        photoBtn.innerHTML = '';
        var img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        photoBtn.appendChild(img);
    }
    if (existingAvatarUrl) renderPhotoPreview(existingAvatarUrl);

    photoBtn.onclick = function() { fileInput.click(); };
    fileInput.onchange = function() {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) { alert('La foto es muy grande (máximo 5 MB).'); return; }
        pendingPhotoBlob = f;
        var reader = new FileReader();
        reader.onload = function(e) { renderPhotoPreview(e.target.result); };
        reader.readAsDataURL(f);
    };

    // ─── Campo nombre ───
    var nameLbl = document.createElement('label');
    nameLbl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    nameLbl.innerHTML = '<span style="font-size:11px;font-weight:700;color:var(--tm);letter-spacing:.4px;">NOMBRE *</span>';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = 'Ej. Coleguitas, Trail Madrid...';
    nameInput.value = isEdit ? (existing.name || '') : '';
    nameInput.style.cssText = 'height:42px;padding:0 12px;border-radius:10px;border:1.5px solid var(--border);'
        + 'background:var(--card);color:var(--tw);font-family:var(--f);font-size:14px;font-weight:600;outline:none;'
        + 'transition:border-color .15s ease;';
    nameInput.onfocus = function() { nameInput.style.borderColor = 'var(--silver)'; };
    nameInput.onblur  = function() { nameInput.style.borderColor = 'var(--border)'; };
    nameLbl.appendChild(nameInput);

    // ─── Campo descripción ───
    var descLbl = document.createElement('label');
    descLbl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    descLbl.innerHTML = '<span style="font-size:11px;font-weight:700;color:var(--tm);letter-spacing:.4px;">DESCRIPCIÓN</span>';
    var descInput = document.createElement('textarea');
    descInput.maxLength = 200;
    descInput.rows = 3;
    descInput.placeholder = 'De qué va este crew (opcional)';
    descInput.value = isEdit ? (existing.description || '') : '';
    descInput.style.cssText = 'padding:10px 12px;border-radius:10px;border:1.5px solid var(--border);'
        + 'background:var(--card);color:var(--tw);font-family:var(--f);font-size:13.5px;font-weight:500;outline:none;'
        + 'resize:none;line-height:1.4;transition:border-color .15s ease;';
    descInput.onfocus = function() { descInput.style.borderColor = 'var(--silver)'; };
    descInput.onblur  = function() { descInput.style.borderColor = 'var(--border)'; };
    descLbl.appendChild(descInput);

    // ─── Botonera (Guardar + Eliminar si es edit) ───
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px;';

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.style.cssText = 'height:46px;border-radius:23px;border:none;cursor:pointer;'
        + 'background:var(--silver-grad);color:#fff;'
        + 'font-family:var(--f);font-size:14px;font-weight:800;letter-spacing:.4px;'
        + 'display:flex;align-items:center;justify-content:center;gap:7px;'
        + 'box-shadow:0 3px 10px rgba(80,85,92,.25);';
    saveBtn.innerHTML = '<span>' + (isEdit ? 'Guardar cambios' : 'Crear crew') + '</span>';
    actions.appendChild(saveBtn);

    if (isEdit) {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.style.cssText = 'height:38px;border-radius:19px;border:1.5px solid rgba(239,68,68,.4);background:transparent;'
            + 'color:#ef4444;font-family:var(--f);font-size:12.5px;font-weight:800;letter-spacing:.3px;cursor:pointer;';
        delBtn.textContent = 'Eliminar crew';
        delBtn.onclick = function() { _deleteCrewWithConfirm(existing, backdrop); };
        actions.appendChild(delBtn);
    }

    // Cerrar modal con animación
    function closeModal() {
        backdrop.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        setTimeout(function() { backdrop.remove(); }, 220);
    }
    closeBtn.onclick = closeModal;
    backdrop.onclick = function(e) { if (e.target === backdrop) closeModal(); };

    // ─── Submit ───
    saveBtn.onclick = async function() {
        var name = (nameInput.value || '').trim();
        if (name.length < 2) {
            nameInput.style.borderColor = '#ef4444';
            nameInput.focus();
            return;
        }
        var desc = (descInput.value || '').trim() || null;

        // Bloquear botón mientras se procesa
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.65';
        saveBtn.innerHTML = '<span>Guardando…</span>';

        try {
            var { data:{ session } } = await sb.auth.getSession();
            if (!session) throw new Error('No session');
            var myId = session.user.id;

            // 1) Crear o actualizar fila en `crews`
            var crewId;
            if (isEdit) {
                crewId = existing.id;
                var { error: upErr } = await sb.from('crews')
                    .update({ name: name, description: desc })
                    .eq('id', crewId);
                if (upErr) throw upErr;
            } else {
                // Crear crew + añadir owner como miembro de forma ATÓMICA
                // vía función SECURITY DEFINER en Supabase. Evita el 403 que
                // daba el SELECT post-INSERT (la policy de read pide ser
                // miembro, y todavía no lo eres en ese microsegundo).
                var { data: newId, error: rpcErr } = await sb.rpc('create_crew', {
                    _name: name,
                    _description: desc
                });
                if (rpcErr) throw rpcErr;
                crewId = newId;
            }

            // 2) Subir foto nueva si hay
            if (pendingPhotoBlob) {
                try {
                    var ext = pendingPhotoBlob.type.includes('png') ? 'png' : 'jpg';
                    var path = 'crew-avatars/' + crewId + '.' + ext;
                    var { error: upE } = await sb.storage.from('media')
                        .upload(path, pendingPhotoBlob, { upsert: true, contentType: pendingPhotoBlob.type });
                    if (!upE) {
                        var { data: ud } = sb.storage.from('media').getPublicUrl(path);
                        // Truco anti-caché para que el avatar se vea recién subido
                        var newUrl = ud.publicUrl + '?t=' + Date.now();
                        await sb.from('crews').update({ avatar_url: newUrl }).eq('id', crewId);
                    } else {
                        console.warn('[MR] crew photo upload error:', upE);
                    }
                } catch (e) {
                    console.warn('[MR] crew photo upload failed:', e);
                }
            }

            // 3) Refrescar lista y cerrar
            if (typeof _refreshMyCrews === 'function') await _refreshMyCrews();
            closeModal();
            // Repintar la vista de crews que esté abierta (pestaña o overlay)
            if (typeof _refreshCrewsListIfVisible === 'function') _refreshCrewsListIfVisible();

        } catch (e) {
            console.error('[MR] crew save failed:', e);
            alert('No se pudo guardar el crew.\n' + (e.message || e));
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
            saveBtn.innerHTML = '<span>' + (isEdit ? 'Guardar cambios' : 'Crear crew') + '</span>';
        }
    };

    // Montar
    card.appendChild(head);
    card.appendChild(photoWrap);
    card.appendChild(nameLbl);
    card.appendChild(descLbl);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    requestAnimationFrame(function() {
        backdrop.style.opacity = '1';
        card.style.transform = 'translateY(0)';
    });
    // Auto-focus al nombre si es crear
    if (!isEdit) setTimeout(function() { nameInput.focus(); }, 280);
}
window.openCrewEditor = openCrewEditor;

// ── Eliminar crew con confirmación doble (escribir el nombre) ────
async function _deleteCrewWithConfirm(crew, parentBackdrop) {
    var sb = window._sbClient;

    // Modal de confirmación encima del editor
    var bk = document.createElement('div');
    bk.style.cssText = 'position:fixed;inset:0;z-index:20030;background:rgba(0,0,0,.7);'
        + 'display:flex;align-items:center;justify-content:center;padding:18px;'
        + 'opacity:0;transition:opacity .2s ease;';
    var card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:340px;background:var(--bg);border-radius:18px;'
        + 'padding:20px;display:flex;flex-direction:column;gap:14px;'
        + 'box-shadow:0 12px 40px rgba(0,0,0,.45);'
        + 'transform:translateY(20px);transition:transform .25s cubic-bezier(.32,.72,0,1);';
    card.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;">'
          + '<div style="width:36px;height:36px;border-radius:50%;background:rgba(239,68,68,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
            + '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
          + '</div>'
          + '<div style="flex:1;font-size:15px;font-weight:800;color:var(--tw);">Eliminar crew</div>'
        + '</div>'
        + '<div style="font-size:12.5px;color:var(--tm);line-height:1.45;">'
          + 'Esto borrará el crew <b style="color:var(--tw);">' + (crew.name || '') + '</b>, '
          + 'todos sus miembros y todos los posts publicados en él. <b>No se puede deshacer.</b>'
        + '</div>'
        + '<div style="font-size:11.5px;color:var(--tm);">'
          + 'Para confirmar, escribe el nombre del crew:'
        + '</div>';
    var confirmInput = document.createElement('input');
    confirmInput.type = 'text';
    confirmInput.placeholder = crew.name || '';
    confirmInput.style.cssText = 'height:40px;padding:0 12px;border-radius:10px;border:1.5px solid var(--border);'
        + 'background:var(--card);color:var(--tw);font-family:var(--f);font-size:13.5px;font-weight:600;outline:none;';
    confirmInput.onfocus = function() { confirmInput.style.borderColor = '#ef4444'; };
    confirmInput.onblur  = function() { confirmInput.style.borderColor = 'var(--border)'; };
    card.appendChild(confirmInput);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:2px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.style.cssText = 'flex:1;height:42px;border-radius:21px;border:1.5px solid var(--border);background:transparent;'
        + 'color:var(--tw);font-family:var(--f);font-size:13px;font-weight:700;cursor:pointer;';
    cancelBtn.textContent = 'Cancelar';
    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.disabled = true;
    confirmBtn.style.cssText = 'flex:1;height:42px;border-radius:21px;border:none;'
        + 'background:#ef4444;color:#fff;font-family:var(--f);font-size:13px;font-weight:800;'
        + 'cursor:not-allowed;opacity:.5;transition:opacity .15s ease;';
    confirmBtn.textContent = 'Eliminar';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    card.appendChild(btnRow);

    // Habilitar el botón solo cuando el nombre coincide exactamente
    confirmInput.oninput = function() {
        var match = confirmInput.value.trim() === (crew.name || '').trim() && confirmInput.value.trim().length > 0;
        confirmBtn.disabled = !match;
        confirmBtn.style.opacity = match ? '1' : '.5';
        confirmBtn.style.cursor = match ? 'pointer' : 'not-allowed';
    };

    function closeMe() {
        bk.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        setTimeout(function() { bk.remove(); }, 220);
    }
    cancelBtn.onclick = closeMe;
    bk.onclick = function(e) { if (e.target === bk) closeMe(); };

    confirmBtn.onclick = async function() {
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '.5';
        confirmBtn.textContent = 'Eliminando…';
        try {
            // El delete sobre crews dispara CASCADE en crew_members y club_posts
            var { error } = await sb.from('crews').delete().eq('id', crew.id);
            if (error) throw error;
            if (typeof _refreshMyCrews === 'function') await _refreshMyCrews();
            // Cerrar este modal y el editor padre
            closeMe();
            if (parentBackdrop) parentBackdrop.remove();
            // Si estaba abierto el detalle de ESTE crew, cerrarlo (ya no existe)
            var det = document.getElementById('crew-detail-view');
            if (det && det.dataset.crewId === crew.id) {
                det.style.transform = 'translateX(100%)';
                setTimeout(function() { det.remove(); }, 320);
            }
            // Repintar la vista de crews
            if (typeof _refreshCrewsListIfVisible === 'function') _refreshCrewsListIfVisible();
        } catch (e) {
            console.error('[MR] crew delete failed:', e);
            alert('No se pudo eliminar el crew.\n' + (e.message || e));
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.textContent = 'Eliminar';
        }
    };

    bk.appendChild(card);
    document.body.appendChild(bk);
    requestAnimationFrame(function() {
        bk.style.opacity = '1';
        card.style.transform = 'translateY(0)';
    });
}

// ── DETALLE DEL CREW ──────────────────────────────────────────────
// Pantalla full-screen con cabecera del crew, tabs Feed/Miembros y
// (en sub-pasos siguientes) contenido real. Por ahora solo el chasis
// navegable: back funcional, tabs intercambiables, placeholders.
async function openCrewDetail(crew) {
    if (!crew || !crew.id) return;
    // Evitar duplicados si se pulsa dos veces seguidas
    if (document.getElementById('crew-detail-view')) return;

    var sb = window._sbClient;
    // Refresco rápido para tener los datos del crew lo más actuales
    // (por si el nombre/foto cambió desde otra pestaña)
    if (typeof _refreshMyCrews === 'function') {
        try { await _refreshMyCrews(); } catch (e) {}
    }
    // Buscamos la versión "fresca" del crew en _myCrews; si no está
    // (raro) usamos la que nos pasaron
    var fresh = (getMyCrews() || []).find(function(c) { return c.id === crew.id; });
    var c = fresh || crew;

    var ov = document.createElement('div');
    ov.id = 'crew-detail-view';
    ov.dataset.crewId = c.id;
    ov.style.cssText = 'position:fixed;inset:0;z-index:20010;background:var(--bg);display:flex;flex-direction:column;'
        + 'transform:translateX(100%);transition:transform .32s cubic-bezier(.32,.72,0,1);overflow:hidden;';

    // ─── CABECERA ───
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+8px) 14px 0;'
        + 'background:var(--bg);';

    // Top row: back + Wall plata + CREW centrado + ✏️ (owner) o spacer
    var topRow = document.createElement('div');
    topRow.style.cssText = 'position:relative;display:flex;align-items:center;gap:8px;height:38px;margin-bottom:10px;';
    var backBtn = document.createElement('button');
    backBtn.setAttribute('aria-label', 'Volver');
    backBtn.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1.5px solid var(--silver-bd);background:var(--card);cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;z-index:1;';
    backBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    backBtn.onclick = function() {
        // Limpiar canales real-time del reto si los hay
        if (ov._challengeRtChannels && ov._challengeRtChannels.length) {
            try {
                ov._challengeRtChannels.forEach(function(ch) {
                    try { window._sbClient.removeChannel(ch); } catch(_) {}
                });
            } catch(_) {}
            ov._challengeRtChannels = [];
        }
        ov.style.transform = 'translateX(100%)';
        setTimeout(function() { ov.remove(); }, 320);
    };
    var topTitle = document.createElement('div');
    topTitle.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);'
        + 'font-size:13px;font-weight:800;color:var(--tm);text-align:center;letter-spacing:1.8px;'
        + 'pointer-events:none;text-transform:uppercase;';
    topTitle.textContent = 'CREW';
    // Píldora Wall — PLATEADA para diferenciarse del Wall dorado del Club global
    var boardBtn = document.createElement('button');
    boardBtn.id = 'crew-board-btn';
    boardBtn.style.cssText = 'height:32px;padding:0 12px;border-radius:16px;'
        + 'border:1.5px solid var(--silver-bd);background:var(--silver-grad);'
        + 'cursor:pointer;display:flex;align-items:center;gap:5px;flex-shrink:0;'
        + 'font-family:var(--f);z-index:1;'
        + 'box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(80,85,92,.28);';
    boardBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.25));"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="14" y2="13"/></svg>'
        + '<span style="font-size:11px;font-weight:800;color:#fff;letter-spacing:.4px;text-shadow:0 1px 1px rgba(0,0,0,.22);">Wall</span>';
    boardBtn.onclick = function() {
        toggleClubBoard({ crewId: c.id, crewName: c.name });
    };
    // Espaciador derecho — si soy owner, lo convierto en botón ✏️ Reacciones
    var topSpace = document.createElement('div');
    if (c.role === 'owner') {
        topSpace = document.createElement('button');
        topSpace.setAttribute('aria-label','Editar reacciones del crew');
        topSpace.style.cssText = 'width:36px;height:32px;border-radius:16px;'
            + 'border:1.5px solid var(--silver-bd);background:var(--silver-grad);'
            + 'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
            + 'box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(80,85,92,.28);';
        topSpace.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.25));"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        topSpace.onclick = function() { _openCrewReactionsEditor(c); };
    } else {
        topSpace.style.cssText = 'width:36px;height:32px;flex-shrink:0;';
    }
    topRow.appendChild(backBtn);
    topRow.appendChild(boardBtn);
    topRow.appendChild(topTitle);
    var topFlex = document.createElement('div');
    topFlex.style.cssText = 'flex:1;';
    topRow.appendChild(topFlex);
    topRow.appendChild(topSpace);

    // ─── HERO CARD premium plateada ────────────────────────────────────
    var ident = document.createElement('div');
    ident.style.cssText = 'background:linear-gradient(135deg,var(--card) 0%,var(--surface) 100%);'
        + 'border:1px solid var(--silver-bd);border-radius:16px;'
        + 'padding:12px 12px 10px;position:relative;overflow:hidden;';

    // Halo radial plata decorativo
    var haloC = document.createElement('div');
    haloC.setAttribute('aria-hidden', 'true');
    haloC.style.cssText = 'position:absolute;top:-30px;right:-30px;width:120px;height:120px;border-radius:50%;'
        + 'background:radial-gradient(circle,rgba(138,143,150,.20) 0%,transparent 70%);pointer-events:none;';
    ident.appendChild(haloC);

    // Row 1: avatar cuadrado plata + nombre/descripción/role
    var row1C = document.createElement('div');
    row1C.style.cssText = 'display:flex;align-items:center;gap:11px;position:relative;z-index:1;';

    var av = document.createElement('div');
    av.style.cssText = 'width:56px;height:56px;border-radius:14px;background:var(--silver-grad);'
        + 'display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;'
        + 'overflow:hidden;flex-shrink:0;box-shadow:0 4px 12px rgba(80,85,92,.25);';
    if (c.avatar_url) {
        var img = document.createElement('img');
        img.src = c.avatar_url; img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        av.appendChild(img);
    } else {
        av.textContent = (c.name || '?')[0].toUpperCase();
    }
    var identText = document.createElement('div');
    identText.style.cssText = 'flex:1;min-width:0;line-height:1.2;';
    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:18px;font-weight:900;color:var(--tw);letter-spacing:.1px;'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;';
    nameEl.textContent = c.name || 'Crew';
    identText.appendChild(nameEl);
    if (c.description) {
        var descEl = document.createElement('div');
        descEl.style.cssText = 'margin-top:3px;font-size:11.5px;color:var(--tm);line-height:1.35;'
            + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
        descEl.textContent = c.description;
        identText.appendChild(descEl);
    }
    // Mini-pildorita rol
    var roleMini = document.createElement('div');
    var roleLabel = c.role === 'owner' ? 'Propietario' : (c.role === 'admin' ? 'Admin' : 'Miembro');
    var roleColor = c.role === 'owner' ? '#c4881e' : (c.role === 'admin' ? 'var(--silver)' : 'var(--tm)');
    roleMini.style.cssText = 'margin-top:5px;display:inline-flex;align-items:center;gap:5px;'
        + 'font-size:10px;font-weight:800;color:' + roleColor + ';letter-spacing:.3px;';
    roleMini.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + roleColor + ';"></span>'
        + '<span>' + roleLabel.toUpperCase() + '</span>';
    identText.appendChild(roleMini);

    row1C.appendChild(av);
    row1C.appendChild(identText);
    ident.appendChild(row1C);

    // Divider plata
    var dividerC = document.createElement('div');
    dividerC.style.cssText = 'height:1px;background:var(--silver-bd);margin:10px 0 9px;opacity:.5;position:relative;z-index:1;';
    ident.appendChild(dividerC);

    // Row 2: stats Miembros / Posts / Retos (con IDs para carga asíncrona)
    var row2C = document.createElement('div');
    row2C.style.cssText = 'display:flex;align-items:center;gap:8px;position:relative;z-index:1;';
    row2C.innerHTML = ''
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="crew-stat-members">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Miembros</div>'
        + '</div>'
        + '<div style="width:1px;height:22px;background:var(--silver-bd);opacity:.4;flex-shrink:0;"></div>'
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="crew-stat-posts">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Posts</div>'
        + '</div>'
        + '<div style="width:1px;height:22px;background:var(--silver-bd);opacity:.4;flex-shrink:0;"></div>'
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="crew-stat-challenges">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Retos</div>'
        + '</div>';
    ident.appendChild(row2C);

    // Spacer entre hero y banners/tabs
    var heroSpacerC = document.createElement('div');
    heroSpacerC.style.cssText = 'height:10px;';

    // Tabs
    var tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:0;border-bottom:1.5px solid var(--silver-bd);margin:0 -14px;padding:0 14px;';
    function makeTab(id, label) {
        var t = document.createElement('button');
        t.dataset.tab = id;
        t.style.cssText = 'flex:1;height:36px;border:none;background:transparent;cursor:pointer;'
            + 'font-family:var(--f);font-size:12.5px;font-weight:800;color:var(--tm);letter-spacing:.3px;'
            + 'position:relative;transition:color .15s ease,border-bottom-color .15s ease;'
            + 'border-bottom:2.5px solid transparent;margin-bottom:-1.5px;';
        t.textContent = label;
        return t;
    }
    var tabFeed = makeTab('feed', 'Feed');
    var tabChallenges = makeTab('challenges', 'Retos');
    var tabMembers = makeTab('members', 'Miembros');
    tabsRow.appendChild(tabFeed);
    tabsRow.appendChild(tabChallenges);
    tabsRow.appendChild(tabMembers);

    hdr.appendChild(topRow);
    hdr.appendChild(ident);
    hdr.appendChild(heroSpacerC);

    // Banner del reto activo (se rellena asíncronamente; oculto si no hay reto)
    var challengeBanner = document.createElement('div');
    challengeBanner.id = 'crew-active-challenge-banner';
    challengeBanner.style.cssText = 'display:none;margin:0 -15px 10px;padding:0 15px;';
    hdr.appendChild(challengeBanner);
    _loadActiveChallengeBanner(c, challengeBanner);
    // Exponer en ov para que código externo (real-time) pueda recargarlo
    ov._loadActiveChallengeBannerFn = _loadActiveChallengeBanner;

    // Banner del evento/quedada (oculto si no hay evento Y no soy owner)
    var eventBanner = document.createElement('div');
    eventBanner.id = 'crew-event-banner';
    eventBanner.style.cssText = 'margin:0 -15px 10px;padding:0 15px;';
    hdr.appendChild(eventBanner);
    if (typeof window._loadCrewEventBanner === 'function') {
        window._loadCrewEventBanner(c, eventBanner);
    }
    ov._loadCrewEventBannerFn = (typeof window._loadCrewEventBanner === 'function')
        ? window._loadCrewEventBanner : null;

    hdr.appendChild(tabsRow);

    // ─── Cuerpo (cambia según tab) ───
    var body = document.createElement('div');
    body.id = 'crew-detail-body';
    body.style.cssText = 'flex:1;overflow-y:auto;';

    // ─── Banner del reto activo en la cabecera ──────────────────────
    // Mini-tarjeta plateada con título + barra de progreso. Tap → tab Retos
    // + abrir el modal detalle.
    async function _loadActiveChallengeBanner(crew, container) {
        var sb = window._sbClient;
        try {
            var { data: chs, error } = await sb.from('crew_challenges')
                .select('*')
                .eq('crew_id', crew.id)
                .eq('status', 'active')
                .limit(1);
            if (error) {
                if (error.code === 'PGRST205' || error.code === '42P01') return;
                throw error;
            }
            if (!chs || chs.length === 0) {
                container.style.display = 'none';
                return;
            }
            var ch = chs[0];
            // Pedir progreso
            var pct = 0;
            try {
                var { data: prog } = await sb.rpc('get_challenge_progress', { _challenge_id: ch.id });
                if (prog) {
                    var totalKm = Number(prog.total_km || 0);
                    var totalSes = Number(prog.total_sessions || 0);
                    var target = Number(ch.target_value || 0);
                    if (ch.challenge_type === 'collective_distance') {
                        pct = target > 0 ? Math.min(100, Math.round((totalKm / target) * 100)) : 0;
                    } else if (ch.challenge_type === 'collective_sessions') {
                        pct = target > 0 ? Math.min(100, Math.round((totalSes / target) * 100)) : 0;
                    } else if (ch.challenge_type === 'individual_consistency') {
                        // Calcular cumplidores
                        var { data: mems } = await sb.from('crew_members').select('user_id').eq('crew_id', crew.id);
                        var memIds = (mems || []).map(function(m) { return m.user_id; });
                        var minKm = Number(ch.target_value || 0);
                        var minSec = ch.target_secondary != null ? Number(ch.target_secondary) : null;
                        var contribMap = {};
                        (prog.contributors || []).forEach(function(x) { contribMap[x.user_id] = x; });
                        var cumplen = 0;
                        memIds.forEach(function(uid) {
                            var co = contribMap[uid];
                            var km = co ? Number(co.km || 0) : 0;
                            var ses = co ? Number(co.sessions || 0) : 0;
                            if (km >= minKm && (minSec === null || ses >= minSec)) cumplen++;
                        });
                        pct = memIds.length > 0 ? Math.round((cumplen / memIds.length) * 100) : 0;
                    }
                }
            } catch(_) {}

            // Pintar
            var typeEmoji = {
                'collective_distance':    '📏',
                'collective_sessions':    '🔥',
                'individual_consistency': '🎯'
            }[ch.challenge_type] || '🏆';

            container.style.display = 'block';
            container.innerHTML = '';
            var card = document.createElement('button');
            card.type = 'button';
            card.style.cssText = 'all:unset;box-sizing:border-box;width:100%;cursor:pointer;'
                + 'display:flex;align-items:center;gap:11px;padding:10px 13px;border-radius:14px;'
                + 'border:1.5px solid var(--silver-bd);background:var(--silver-tint);'
                + 'transition:background .15s,transform .1s;';
            card.onpointerdown = function() { card.style.transform = 'scale(.98)'; };
            card.onpointerup = function() { card.style.transform = 'scale(1)'; };
            card.onpointerleave = function() { card.style.transform = 'scale(1)'; };

            var emojiBox = document.createElement('div');
            emojiBox.style.cssText = 'width:32px;height:32px;border-radius:9px;background:var(--silver-grad);'
                + 'display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;'
                + 'box-shadow:0 2px 5px rgba(80,85,92,.22);';
            emojiBox.textContent = typeEmoji;

            var col = document.createElement('div');
            col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;';
            var topR = document.createElement('div');
            topR.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
            var tEl = document.createElement('div');
            tEl.style.cssText = 'font-size:12px;font-weight:800;color:var(--tw);line-height:1.2;'
                + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;';
            tEl.textContent = ch.title || 'Reto activo';
            var pctEl = document.createElement('div');
            pctEl.style.cssText = 'font-size:11px;font-weight:900;color:var(--silver);letter-spacing:.3px;flex-shrink:0;';
            pctEl.textContent = pct + '%';
            topR.appendChild(tEl);
            topR.appendChild(pctEl);
            var bar = document.createElement('div');
            bar.style.cssText = 'height:6px;border-radius:3px;background:var(--silver-tint-strong);overflow:hidden;'
                + 'position:relative;';
            var fill = document.createElement('div');
            fill.style.cssText = 'height:100%;width:0%;background:var(--silver-grad);border-radius:3px;'
                + 'transition:width .6s cubic-bezier(.32,.72,0,1);';
            bar.appendChild(fill);
            col.appendChild(topR);
            col.appendChild(bar);

            var arrow = document.createElement('div');
            arrow.style.cssText = 'flex-shrink:0;color:var(--tm);';
            arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

            card.appendChild(emojiBox);
            card.appendChild(col);
            card.appendChild(arrow);

            card.onclick = function() {
                // Cambiar a tab Retos
                setActiveTab('challenges');
                // Abrir detalle del reto
                setTimeout(function() {
                    if (typeof window.openCrewChallengeDetail === 'function') {
                        window.openCrewChallengeDetail(ch, crew);
                    }
                }, 100);
            };

            container.appendChild(card);

            // Animar barra
            requestAnimationFrame(function() {
                requestAnimationFrame(function() { fill.style.width = pct + '%'; });
            });
        } catch(e) {
            console.error('[MR] active challenge banner load failed:', e);
            container.style.display = 'none';
        }
    }

    // Estados placeholder (sub-pasos 4.B y 4.C los rellenan)
    function renderTabFeed() {
        // Contenedor con id único para este crew. renderClubFeed acepta
        // un target opcional para escribir aquí en lugar de #club-feed.
        body.innerHTML = '<div id="crew-feed-' + c.id + '" style="padding:12px 12px 30px;"></div>';
        var target = document.getElementById('crew-feed-' + c.id);
        if (target && typeof renderClubFeed === 'function') {
            renderClubFeed({ crewId: c.id, target: target });
        }
    }
    async function renderTabMembers() {
        // Placeholder mientras carga
        body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--tm);font-size:12px;">Cargando miembros…</div>';

        var sb = window._sbClient;
        try {
            var { data: { session } } = await sb.auth.getSession();
            if (!session) {
                body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--tm);">Inicia sesión.</div>';
                return;
            }
            var myId = session.user.id;
            var amOwner = (c.owner_id === myId) || c.role === 'owner';

            // Traer miembros del crew (sin join — más robusto que depender
            // del nombre exacto de la FK en el schema cache de Supabase)
            var { data: members, error } = await sb.from('crew_members')
                .select('user_id, role, joined_at')
                .eq('crew_id', c.id)
                .order('joined_at', { ascending: true });
            if (error) throw error;

            // Segunda query: traer perfiles en bloque por sus IDs
            var memberIds = (members || []).map(function(m) { return m.user_id; });
            var profilesById = {};
            if (memberIds.length) {
                var { data: profs, error: pErr } = await sb.from('profiles')
                    .select('id, username, display_name, avatar_url')
                    .in('id', memberIds);
                if (pErr) throw pErr;
                (profs || []).forEach(function(p) { profilesById[p.id] = p; });
            }

            // Construimos una lista enriquecida {user_id, role, joined_at, profiles}
            var list = (members || []).map(function(m) {
                return {
                    user_id:   m.user_id,
                    role:      m.role,
                    joined_at: m.joined_at,
                    profiles:  profilesById[m.user_id] || null
                };
            }).filter(function(m) { return m.profiles; });

            // ─── Render ───
            body.innerHTML = '';
            var wrap = document.createElement('div');
            wrap.style.cssText = 'padding:14px 15px 100px;display:flex;flex-direction:column;gap:8px;';

            // Cabecera con contador + botón Invitar (sólo owner)
            var headRow = document.createElement('div');
            headRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
            var countEl = document.createElement('div');
            countEl.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.4px;';
            countEl.textContent = list.length + ' MIEMBRO' + (list.length === 1 ? '' : 'S');
            headRow.appendChild(countEl);
            if (amOwner) {
                var inviteBtn = document.createElement('button');
                inviteBtn.style.cssText = 'height:30px;padding:0 12px;border-radius:15px;'
                    + 'background:var(--silver-grad);color:#fff;border:none;cursor:pointer;'
                    + 'font-family:var(--f);font-size:11.5px;font-weight:800;letter-spacing:.3px;'
                    + 'display:flex;align-items:center;gap:5px;';
                inviteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Invitar</span>';
                inviteBtn.onclick = function() {
                    // Conectado en el sub-paso 4.D
                    if (typeof openCrewInviteModal === 'function') {
                        openCrewInviteModal(c);
                    } else {
                        alert('Invitar runners (sub-paso 4.D — próximamente)');
                    }
                };
                headRow.appendChild(inviteBtn);
            }
            wrap.appendChild(headRow);

            // Lista de miembros
            var _membersStaggerStart = wrap.children.length;
            list.forEach(function(m) {
                var p = m.profiles;
                var isMe   = p.id === myId;
                var isHim  = m.role === 'owner';

                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:11px;padding:10px 12px;'
                    + 'background:var(--card);border:1px solid var(--border);border-radius:12px;';

                // Avatar
                var av = document.createElement('div');
                av.style.cssText = 'width:42px;height:42px;border-radius:50%;background:var(--crimson);'
                    + 'display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;'
                    + 'overflow:hidden;flex-shrink:0;cursor:pointer;';
                if (p.avatar_url) {
                    var img = document.createElement('img');
                    img.src = p.avatar_url; img.loading = 'lazy';
                    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                    av.appendChild(img);
                } else {
                    av.textContent = (p.display_name || p.username || '?')[0].toUpperCase();
                }
                // Tap en avatar → abrir perfil del runner (si existe la función)
                av.onclick = function() {
                    if (typeof openClubUserProfile === 'function' && !isMe) {
                        openClubUserProfile(p.id);
                    }
                };

                // Texto
                var info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
                var nameLine = document.createElement('div');
                nameLine.style.cssText = 'display:flex;align-items:center;gap:6px;';
                var nameEl = document.createElement('span');
                nameEl.style.cssText = 'font-size:14px;font-weight:800;color:var(--tw);'
                    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                nameEl.textContent = p.display_name || p.username || '?';
                nameLine.appendChild(nameEl);
                if (isMe) {
                    var meTag = document.createElement('span');
                    meTag.style.cssText = 'font-size:9.5px;font-weight:800;color:var(--gold);'
                        + 'background:rgba(196,136,30,.18);padding:2px 6px;border-radius:8px;letter-spacing:.4px;';
                    meTag.textContent = 'TÚ';
                    nameLine.appendChild(meTag);
                }
                info.appendChild(nameLine);

                var roleEl = document.createElement('div');
                roleEl.style.cssText = 'font-size:10.5px;color:var(--tm);display:flex;align-items:center;gap:5px;';
                var roleLabel = m.role === 'owner' ? 'Propietario' : (m.role === 'admin' ? 'Admin' : 'Miembro');
                var roleColor = m.role === 'owner' ? '#c4881e' : (m.role === 'admin' ? 'var(--silver)' : 'var(--tm)');
                roleEl.innerHTML = '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + roleColor + ';"></span>'
                    + '<span style="font-weight:700;color:' + roleColor + ';letter-spacing:.2px;">' + roleLabel + '</span>';
                info.appendChild(roleEl);

                row.appendChild(av);
                row.appendChild(info);

                // Botón expulsar (solo owner sobre no-owners)
                if (amOwner && !isHim && !isMe) {
                    var kickBtn = document.createElement('button');
                    kickBtn.setAttribute('aria-label', 'Expulsar');
                    kickBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;'
                        + 'border:1px solid rgba(239,68,68,.35);background:transparent;cursor:pointer;'
                        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
                    kickBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
                    kickBtn.onclick = function() {
                        _kickCrewMember(c, p);
                    };
                    row.appendChild(kickBtn);
                }

                wrap.appendChild(row);
            });
            try {
                var _membersNew = Array.prototype.slice.call(wrap.children, _membersStaggerStart);
                if (typeof _staggerIn === 'function') _staggerIn(_membersNew, { step: 40 });
            } catch(_) {}

            // Botón "Salir del crew" abajo (sólo si NO soy owner)
            if (!amOwner) {
                var leaveBtn = document.createElement('button');
                leaveBtn.style.cssText = 'margin-top:16px;height:42px;border-radius:21px;'
                    + 'border:1.5px solid rgba(239,68,68,.4);background:transparent;color:#ef4444;'
                    + 'font-family:var(--f);font-size:13px;font-weight:800;letter-spacing:.3px;cursor:pointer;';
                leaveBtn.textContent = 'Salir del crew';
                leaveBtn.onclick = function() { _leaveCrew(c); };
                wrap.appendChild(leaveBtn);
            }

            body.appendChild(wrap);
        } catch (e) {
            console.error('[MR] crew members load failed:', e);
            body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);font-size:12px;">No se pudieron cargar los miembros.</div>';
        }
    }

    // ─── Helper: cargar retos del crew (activos + histórico) ───
    // Devuelve { active, history }. Si la tabla aún no existe (SQL pendiente),
    // devolvemos estructura vacía para que la UI muestre el estado "sin retos"
    // sin pintar errores. Cualquier otro error sí se propaga.
    // También aplica lazy expiration: si encuentra retos activos con ends_at
    // ya pasado, llama al RPC expire_challenge y recarga.
    async function _loadCrewChallenges(crewId) {
        var sb = window._sbClient;
        var { data, error } = await sb.from('crew_challenges')
            .select('*')
            .eq('crew_id', crewId)
            .order('created_at', { ascending: false });
        if (error) {
            if (error.code === 'PGRST205' || error.code === '42P01') {
                console.info('[MR] crew_challenges aún no existe en BD — modo "sin retos"');
                return { active: [], history: [] };
            }
            throw error;
        }

        // Lazy expiration: detectar retos activos con ends_at vencida
        var nowMs = Date.now();
        var toExpire = (data || []).filter(function(ch) {
            return ch.status === 'active' && new Date(ch.ends_at).getTime() < nowMs;
        });
        if (toExpire.length > 0) {
            try {
                await Promise.all(toExpire.map(function(ch) {
                    return sb.rpc('expire_challenge', { _challenge_id: ch.id });
                }));
                // Recargar para reflejar los cambios
                var reRes = await sb.from('crew_challenges')
                    .select('*')
                    .eq('crew_id', crewId)
                    .order('created_at', { ascending: false });
                if (!reRes.error) {
                    data = reRes.data;
                }
            } catch(e) {
                console.warn('[MR] expire_challenge RPC failed (continuamos con datos actuales):', e);
            }
        }

        var active = [], history = [];
        (data || []).forEach(function(ch) {
            if (ch.status === 'active') active.push(ch);
            else history.push(ch);
        });
        return { active: active, history: history };
    }

    // ─── Tab "Retos" ───
    async function renderTabChallenges() {
        var amOwner = (c.role === 'owner');
        // Placeholder mientras carga
        body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--tm);font-size:12px;">Cargando retos…</div>';

        var data;
        try {
            data = await _loadCrewChallenges(c.id);
        } catch (e) {
            console.error('[MR] crew_challenges load failed:', e);
            body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);font-size:12px;">No se pudieron cargar los retos.</div>';
            return;
        }

        // ── Check: retos recién completados que NO he visto celebrar ──
        // Usamos localStorage por reto. Solo disparamos para retos completados
        // hace <24h, para no resucitar celebraciones antiguas al primer login.
        try {
            var nowMs = Date.now();
            data.history.forEach(function(ch) {
                if (ch.status !== 'completed' || !ch.completed_at) return;
                var compMs = new Date(ch.completed_at).getTime();
                if (!isFinite(compMs)) return;
                if (nowMs - compMs > 24 * 3600 * 1000) return; // >24h, ignorar
                var key = _uk('mr_challenge_celebrated_' + ch.id);
                if (localStorage.getItem(key)) return;
                localStorage.setItem(key, '1');
                // Disparar celebración (con un mini-delay para que la tab termine de pintarse)
                setTimeout(function() { _showCrewChallengeCelebration(ch, c); }, 250);
            });
        } catch(_) {}

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.style.cssText = 'padding:18px 14px 40px;display:flex;flex-direction:column;gap:14px;';

        // ── Estado VACÍO (sin reto activo y sin histórico) ──
        if (data.active.length === 0 && data.history.length === 0) {
            var empty = document.createElement('div');
            empty.style.cssText = 'margin-top:18px;padding:40px 22px;text-align:center;'
                + 'border:1.5px dashed var(--silver-bd);border-radius:18px;background:var(--silver-tint);'
                + 'display:flex;flex-direction:column;align-items:center;gap:12px;';
            empty.innerHTML =
                '<div style="font-size:46px;line-height:1;filter:drop-shadow(0 2px 4px rgba(80,85,92,.25));">🏆</div>'
                + '<div style="font-size:15px;font-weight:800;color:var(--tw);letter-spacing:.2px;">Aún no hay retos en marcha</div>'
                + '<div style="font-size:12px;color:var(--tm);line-height:1.5;max-width:280px;">'
                + (amOwner
                    ? 'Lanza un reto colectivo y motiva al crew a sumar kilómetros juntos.'
                    : 'El propietario del crew puede lanzar retos colectivos para que sumemos entre todos.')
                + '</div>';
            if (amOwner) {
                var createBtn = document.createElement('button');
                createBtn.style.cssText = 'margin-top:6px;height:42px;padding:0 22px;border-radius:21px;'
                    + 'border:1.5px solid var(--silver-bd);background:var(--silver-grad);cursor:pointer;'
                    + 'display:inline-flex;align-items:center;gap:8px;'
                    + 'font-family:var(--f);font-size:13px;font-weight:800;color:#fff;letter-spacing:.4px;'
                    + 'text-shadow:0 1px 1px rgba(0,0,0,.22);'
                    + 'box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 3px 8px rgba(80,85,92,.3);';
                createBtn.innerHTML = '<span style="font-size:18px;font-weight:900;line-height:1;">+</span>'
                    + '<span>Crear reto</span>';
                createBtn.onclick = function() {
                    // PASO B implementará el modal completo
                    if (typeof window.openCreateCrewChallenge === 'function') {
                        window.openCreateCrewChallenge(c);
                    } else {
                        showToast('Próximamente: creación de retos', 2200);
                    }
                };
                empty.appendChild(createBtn);
            }
            wrap.appendChild(empty);
        } else {
            // Tarjeta de reto activo + (TODO PASO F) histórico

            // Botón "+ Nuevo reto" SOLO si no hay activo (UNIQUE index lo garantiza)
            if (amOwner && data.active.length === 0) {
                var newBtnRow = document.createElement('div');
                newBtnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:2px;';
                var newBtn = document.createElement('button');
                newBtn.style.cssText = 'height:38px;padding:0 18px;border-radius:19px;'
                    + 'border:1.5px solid var(--silver-bd);background:var(--silver-grad);cursor:pointer;'
                    + 'display:inline-flex;align-items:center;gap:6px;'
                    + 'font-family:var(--f);font-size:12px;font-weight:800;color:#fff;letter-spacing:.4px;'
                    + 'text-shadow:0 1px 1px rgba(0,0,0,.22);'
                    + 'box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(80,85,92,.28);';
                newBtn.innerHTML = '<span style="font-size:16px;font-weight:900;line-height:1;">+</span><span>Nuevo reto</span>';
                newBtn.onclick = function() {
                    if (typeof window.openCreateCrewChallenge === 'function') {
                        window.openCreateCrewChallenge(c);
                    } else {
                        showToast('Próximamente: creación de retos', 2200);
                    }
                };
                newBtnRow.appendChild(newBtn);
                wrap.appendChild(newBtnRow);
            }

            // Tarjeta del reto activo
            if (data.active.length > 0) {
                var cardHost = document.createElement('div');
                cardHost.dataset.challengeId = data.active[0].id;
                wrap.appendChild(cardHost);
                // Lanzamos el render asíncrono; el host queda como placeholder
                _renderChallengeCard(data.active[0], c, cardHost).catch(function(e) {
                    console.error('[MR] render challenge card failed:', e);
                });
            }

            // Histórico de retos pasados (completados, expirados, cancelados)
            if (data.history.length > 0) {
                _renderChallengeHistory(data.history, c, wrap);
            }
        }

        body.appendChild(wrap);
    }

    // ─── Sección colapsable de histórico de retos pasados ──────────────
    function _renderChallengeHistory(history, crew, container) {
        var section = document.createElement('div');
        section.style.cssText = 'margin-top:14px;border-radius:14px;'
            + 'border:1px solid var(--border);background:var(--card);overflow:hidden;';

        // Header del colapsable
        var header = document.createElement('button');
        header.type = 'button';
        header.style.cssText = 'all:unset;box-sizing:border-box;width:100%;cursor:pointer;'
            + 'display:flex;align-items:center;gap:10px;padding:13px 14px;'
            + 'font-family:var(--f);transition:background .15s;';
        var hdrIcon = document.createElement('div');
        hdrIcon.style.cssText = 'width:30px;height:30px;border-radius:9px;background:var(--silver-tint-strong);'
            + 'display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;';
        hdrIcon.textContent = '📜';
        var hdrText = document.createElement('div');
        hdrText.style.cssText = 'flex:1;min-width:0;';
        var hdrTitle = document.createElement('div');
        hdrTitle.style.cssText = 'font-size:12px;font-weight:800;color:var(--tw);letter-spacing:.3px;';
        hdrTitle.textContent = 'Retos pasados';
        var hdrCount = document.createElement('div');
        hdrCount.style.cssText = 'font-size:10px;color:var(--tm);font-weight:600;margin-top:2px;';
        hdrCount.textContent = history.length + (history.length === 1 ? ' reto' : ' retos');
        hdrText.appendChild(hdrTitle);
        hdrText.appendChild(hdrCount);
        var chevron = document.createElement('div');
        chevron.style.cssText = 'flex-shrink:0;transition:transform .25s ease;color:var(--tm);';
        chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        header.appendChild(hdrIcon);
        header.appendChild(hdrText);
        header.appendChild(chevron);

        // Lista (oculta por defecto)
        var list = document.createElement('div');
        list.style.cssText = 'display:none;padding:0 12px 12px;flex-direction:column;gap:8px;';
        list.dataset.expanded = '0';

        history.forEach(function(ch) {
            list.appendChild(_buildChallengeHistoryRow(ch, crew));
        });

        var expanded = false;
        header.onclick = function() {
            expanded = !expanded;
            if (expanded) {
                list.style.display = 'flex';
                chevron.style.transform = 'rotate(180deg)';
            } else {
                list.style.display = 'none';
                chevron.style.transform = 'rotate(0deg)';
            }
        };

        section.appendChild(header);
        section.appendChild(list);
        container.appendChild(section);
    }

    // ─── Tarjeta mini de un reto del histórico ─────────────────────────
    function _buildChallengeHistoryRow(challenge, crew) {
        var row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'all:unset;box-sizing:border-box;width:100%;cursor:pointer;'
            + 'padding:12px 12px;border-radius:11px;background:var(--bsoft,var(--card2,var(--card)));'
            + 'border:1px solid var(--border);'
            + 'display:flex;align-items:center;gap:10px;font-family:var(--f);'
            + 'transition:background .15s,transform .1s;';
        row.onpointerdown = function() { row.style.transform = 'scale(.985)'; };
        row.onpointerup = function() { row.style.transform = 'scale(1)'; };
        row.onpointerleave = function() { row.style.transform = 'scale(1)'; };

        // Icono según tipo
        var typeMeta = {
            'collective_distance':    '📏',
            'collective_sessions':    '🔥',
            'individual_consistency': '🎯'
        };
        var emoji = typeMeta[challenge.challenge_type] || '🏆';

        // Estado: color + label
        var statusMeta = {
            'completed': { color: '#10b981', bg: 'rgba(16,185,129,.14)', label: 'COMPLETADO' },
            'expired':   { color: 'var(--tm)', bg: 'var(--silver-tint)',    label: 'EXPIRADO' },
            'cancelled': { color: '#ef4444', bg: 'rgba(239,68,68,.12)',  label: 'CANCELADO' }
        }[challenge.status] || { color: 'var(--tm)', bg: 'var(--silver-tint)', label: (challenge.status || '').toUpperCase() };

        // Bloque izquierdo: emoji
        var emojiBox = document.createElement('div');
        emojiBox.style.cssText = 'width:32px;height:32px;border-radius:9px;background:var(--silver-tint);'
            + 'display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;'
            + 'opacity:.8;';
        emojiBox.textContent = emoji;
        row.appendChild(emojiBox);

        // Bloque central: título + fechas
        var col = document.createElement('div');
        col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;';
        var titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:12.5px;font-weight:800;color:var(--tw);line-height:1.2;'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        titleEl.textContent = challenge.title || '—';
        var datesEl = document.createElement('div');
        datesEl.style.cssText = 'font-size:10px;color:var(--tm);font-weight:600;'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        function _fmt(iso) {
            try {
                var d = new Date(iso);
                return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' });
            } catch(_) { return ''; }
        }
        datesEl.textContent = _fmt(challenge.starts_at) + ' → ' + _fmt(challenge.ends_at);
        col.appendChild(titleEl);
        col.appendChild(datesEl);
        row.appendChild(col);

        // Bloque derecho: chip de estado
        var chip = document.createElement('div');
        chip.style.cssText = 'flex-shrink:0;padding:3px 8px;border-radius:9px;'
            + 'background:' + statusMeta.bg + ';color:' + statusMeta.color + ';'
            + 'font-size:9px;font-weight:900;letter-spacing:.6px;';
        chip.textContent = statusMeta.label;
        row.appendChild(chip);

        // Tap → abre detalle (modo lectura para retos no activos)
        row.onclick = function() {
            if (typeof window.openCrewChallengeDetail === 'function') {
                window.openCrewChallengeDetail(challenge, crew);
            }
        };

        return row;
    }

    // ─── Render de UNA tarjeta de reto activo ──────────────────────
    // Carga progreso vía RPC + miembros del crew para mostrar top 3 con avatares.
    async function _renderChallengeCard(challenge, crew, container) {
        var sb = window._sbClient;
        var amOwner = (crew.role === 'owner');

        // Skeleton mientras carga
        container.innerHTML = '<div style="padding:32px 16px;text-align:center;color:var(--tm);font-size:12px;'
            + 'border:1.5px solid var(--silver-bd);border-radius:18px;background:var(--card);">Cargando reto…</div>';

        // Carga en paralelo: progreso del reto + miembros del crew (para avatares/usernames)
        var progressData = null, members = [];
        try {
            var [ progressRes, membersRes ] = await Promise.all([
                sb.rpc('get_challenge_progress', { _challenge_id: challenge.id }),
                sb.from('crew_members').select('user_id').eq('crew_id', crew.id)
            ]);
            if (progressRes.error) throw progressRes.error;
            progressData = progressRes.data || { total_km: 0, total_sessions: 0, contributors: [] };
            var memberIds = (membersRes.data || []).map(function(m) { return m.user_id; });
            if (memberIds.length) {
                var { data: profs, error: pErr } = await sb.from('profiles')
                    .select('id, username, display_name, avatar_url')
                    .in('id', memberIds);
                if (pErr) throw pErr;
                members = profs || [];
            }
        } catch (e) {
            console.error('[MR] challenge progress fetch failed:', e);
            container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);font-size:12px;'
                + 'border:1.5px solid var(--border);border-radius:18px;background:var(--card);">No se pudo cargar el reto.</div>';
            return;
        }

        // Mapa rápido user_id → profile
        var profileMap = {};
        members.forEach(function(p) { if (p && p.id) profileMap[p.id] = p; });

        // ── Cálculo de progreso según tipo ──
        var totalKm = Number(progressData.total_km || 0);
        var totalSessions = Number(progressData.total_sessions || 0);
        var contributors = progressData.contributors || [];

        var current, target, unitLabel, bigCurrent, bigTarget;
        if (challenge.challenge_type === 'collective_distance') {
            current = totalKm;
            target = Number(challenge.target_value || 0);
            unitLabel = 'km';
            bigCurrent = current.toFixed(1);
            bigTarget = '/ ' + (target % 1 === 0 ? target : target.toFixed(1)) + ' km';
        } else if (challenge.challenge_type === 'collective_sessions') {
            current = totalSessions;
            target = Number(challenge.target_value || 0);
            unitLabel = 'sesiones';
            bigCurrent = String(Math.floor(current));
            bigTarget = '/ ' + Math.floor(target) + ' sesiones';
        } else {
            // individual_consistency: cuántos miembros del crew cumplen el mínimo
            var minKm = Number(challenge.target_value || 0);
            var minSec = challenge.target_secondary != null ? Number(challenge.target_secondary) : null;
            var memberIds = members.map(function(p) { return p.id; });
            var cumplen = 0;
            memberIds.forEach(function(uid) {
                var contrib = contributors.find(function(x) { return x.user_id === uid; });
                var km = contrib ? Number(contrib.km || 0) : 0;
                var ses = contrib ? Number(contrib.sessions || 0) : 0;
                // Cumple si km >= minKm Y (no hay minSec o sesiones >= minSec)
                if (km >= minKm && (minSec === null || ses >= minSec)) cumplen++;
            });
            current = cumplen;
            target = memberIds.length;
            unitLabel = 'miembros';
            bigCurrent = String(cumplen);
            bigTarget = '/ ' + memberIds.length + ' miembros';
        }
        var pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

        // ── Countdown ──
        var endsAt = new Date(challenge.ends_at);
        var now = new Date();
        var msLeft = endsAt - now;
        var countdownTop, countdownVal;
        if (msLeft <= 0) {
            countdownTop = 'ESTADO';
            countdownVal = 'Terminado';
        } else {
            var daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
            // "hoy" si ends_at es hoy mismo
            var endsToday = (endsAt.toDateString() === now.toDateString());
            if (endsToday) {
                countdownTop = 'TERMINA';
                countdownVal = 'Hoy';
            } else if (daysLeft === 1) {
                countdownTop = 'TERMINA';
                countdownVal = 'Mañana';
            } else {
                countdownTop = 'QUEDAN';
                countdownVal = daysLeft + ' días';
            }
        }

        // ── Icono + etiqueta tipo ──
        var typeMeta = {
            'collective_distance':    { emoji: '📏', label: 'Distancia colectiva' },
            'collective_sessions':    { emoji: '🔥', label: 'Sesiones colectivas' },
            'individual_consistency': { emoji: '🎯', label: 'Constancia individual' }
        }[challenge.challenge_type] || { emoji: '🏆', label: 'Reto' };

        // ── Construcción de la tarjeta ──
        var card = document.createElement('div');
        card.style.cssText = 'border-radius:18px;border:1.5px solid var(--silver-bd);'
            + 'background:var(--card);overflow:hidden;'
            + 'box-shadow:0 4px 14px rgba(0,0,0,.12);';

        // Header
        var hdr = document.createElement('div');
        hdr.style.cssText = 'padding:14px 16px 12px;display:flex;align-items:flex-start;gap:12px;'
            + 'border-bottom:1px solid var(--border);';
        var iconBox = document.createElement('div');
        iconBox.style.cssText = 'width:38px;height:38px;border-radius:11px;background:var(--silver-grad);'
            + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;'
            + 'box-shadow:0 2px 6px rgba(80,85,92,.28);font-size:20px;line-height:1;';
        iconBox.textContent = typeMeta.emoji;
        var titleCol = document.createElement('div');
        titleCol.style.cssText = 'flex:1;min-width:0;';
        var typeLbl = document.createElement('div');
        typeLbl.style.cssText = 'font-size:10px;font-weight:800;color:var(--tm);letter-spacing:1.2px;'
            + 'text-transform:uppercase;margin-bottom:3px;';
        typeLbl.textContent = typeMeta.label;
        var titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:15px;font-weight:900;color:var(--tw);line-height:1.25;letter-spacing:.2px;'
            + 'word-break:break-word;';
        titleEl.textContent = challenge.title || '—';
        titleCol.appendChild(typeLbl);
        titleCol.appendChild(titleEl);
        var cdCol = document.createElement('div');
        cdCol.style.cssText = 'text-align:right;flex-shrink:0;';
        var cdTop = document.createElement('div');
        cdTop.style.cssText = 'font-size:10px;font-weight:800;color:var(--tm);letter-spacing:.4px;';
        cdTop.textContent = countdownTop;
        var cdVal = document.createElement('div');
        cdVal.style.cssText = 'font-size:14px;font-weight:900;color:var(--tw);line-height:1.1;margin-top:2px;';
        cdVal.textContent = countdownVal;
        cdCol.appendChild(cdTop);
        cdCol.appendChild(cdVal);
        hdr.appendChild(iconBox);
        hdr.appendChild(titleCol);
        hdr.appendChild(cdCol);
        card.appendChild(hdr);

        // Big number
        var big = document.createElement('div');
        big.style.cssText = 'padding:16px;display:flex;align-items:baseline;justify-content:center;'
            + 'gap:8px;flex-wrap:wrap;';
        var bigVal = document.createElement('div');
        bigVal.style.cssText = 'font-size:34px;font-weight:900;color:var(--tw);line-height:1;letter-spacing:-.5px;';
        bigVal.textContent = bigCurrent;
        var bigUnit = document.createElement('div');
        bigUnit.style.cssText = 'font-size:14px;color:var(--tm);font-weight:800;';
        bigUnit.textContent = bigTarget;
        var pctPill = document.createElement('div');
        pctPill.style.cssText = 'margin-left:6px;padding:3px 9px;border-radius:10px;'
            + 'background:var(--silver-tint-strong);font-size:11px;font-weight:900;color:var(--tw);letter-spacing:.3px;';
        pctPill.textContent = pct + '%';
        big.appendChild(bigVal);
        big.appendChild(bigUnit);
        big.appendChild(pctPill);
        card.appendChild(big);

        // Barra de progreso
        var barWrap = document.createElement('div');
        barWrap.style.cssText = 'padding:0 16px 16px;';
        var bar = document.createElement('div');
        bar.style.cssText = 'height:10px;border-radius:5px;background:var(--silver-tint);overflow:hidden;'
            + 'position:relative;border:1px solid var(--silver-bd);';
        var fill = document.createElement('div');
        fill.style.cssText = 'height:100%;width:0%;background:var(--silver-grad);border-radius:4px;'
            + 'box-shadow:inset 0 -1px 2px rgba(0,0,0,.18);transition:width .6s cubic-bezier(.32,.72,0,1);';
        bar.appendChild(fill);
        barWrap.appendChild(bar);
        card.appendChild(barWrap);
        // Animar el llenado tras pintar
        requestAnimationFrame(function() {
            requestAnimationFrame(function() { fill.style.width = pct + '%'; });
        });

        // Top 3 contribuidores
        // Para constancia individual el ranking se ordena igual por km descendente
        var topNContrib = contributors.slice(0, 3);
        if (topNContrib.length > 0) {
            var topWrap = document.createElement('div');
            topWrap.style.cssText = 'padding:0 16px 12px;';
            var topLbl = document.createElement('div');
            topLbl.style.cssText = 'font-size:10px;font-weight:800;color:var(--tm);letter-spacing:.6px;'
                + 'text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px;';
            topLbl.innerHTML = '<span style="font-size:11px;">🏅</span><span>Top contribuidores</span>';
            topWrap.appendChild(topLbl);
            var topList = document.createElement('div');
            topList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
            var medalColors = ['#c4881e', '#a8adb5', '#9b6a3a']; // oro, plata, bronce
            var myId = null;
            try {
                var { data: { session } } = await sb.auth.getSession();
                myId = session && session.user && session.user.id;
            } catch(_) {}
            topNContrib.forEach(function(contrib, idx) {
                var prof = profileMap[contrib.user_id] || {};
                var row = document.createElement('div');
                var isMe = (myId && contrib.user_id === myId);
                row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;'
                    + 'background:' + (isMe ? 'var(--silver-tint-strong)' : 'var(--silver-tint)') + ';';
                var pos = document.createElement('div');
                pos.style.cssText = 'font-size:13px;font-weight:900;color:' + medalColors[idx] + ';width:18px;text-align:center;flex-shrink:0;';
                pos.textContent = (idx + 1);
                var av = document.createElement('div');
                av.style.cssText = 'width:26px;height:26px;border-radius:50%;background:var(--card2,var(--card));'
                    + 'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;'
                    + 'color:var(--tw);border:1.5px solid ' + medalColors[idx] + ';overflow:hidden;flex-shrink:0;';
                if (prof.avatar_url) {
                    var im = document.createElement('img');
                    im.src = prof.avatar_url; im.loading = 'lazy';
                    im.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                    av.appendChild(im);
                } else {
                    av.textContent = ((prof.display_name || prof.username || '?')[0] || '?').toUpperCase();
                }
                var nameEl = document.createElement('div');
                nameEl.style.cssText = 'flex:1;font-size:12px;font-weight:700;color:var(--tw);'
                    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;';
                nameEl.textContent = prof.display_name || prof.username || '—';
                var valEl = document.createElement('div');
                valEl.style.cssText = 'font-size:12px;font-weight:900;color:var(--tw);flex-shrink:0;';
                // Mostrar km o sesiones según tipo
                if (challenge.challenge_type === 'collective_sessions') {
                    valEl.textContent = Math.floor(contrib.sessions || 0) + ' ses.';
                } else {
                    valEl.textContent = Number(contrib.km || 0).toFixed(1) + ' km';
                }
                row.appendChild(pos);
                row.appendChild(av);
                row.appendChild(nameEl);
                row.appendChild(valEl);
                topList.appendChild(row);
            });
            topWrap.appendChild(topList);
            card.appendChild(topWrap);
        }

        // Botones inferiores
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'padding:0 16px 14px;display:flex;gap:8px;';
        var detailBtn = document.createElement('button');
        detailBtn.style.cssText = 'flex:1;height:38px;border-radius:19px;'
            + 'border:1.5px solid var(--silver-bd);background:var(--silver-tint);'
            + 'cursor:pointer;font-family:var(--f);font-size:12px;font-weight:800;color:var(--tw);'
            + 'letter-spacing:.3px;';
        detailBtn.textContent = 'Ver detalle';
        detailBtn.onclick = function() {
            if (typeof window.openCrewChallengeDetail === 'function') {
                window.openCrewChallengeDetail(challenge, crew);
            } else {
                showToast('Próximamente: detalle del reto', 2200);
            }
        };
        btnRow.appendChild(detailBtn);
        if (amOwner) {
            var cancelBtnCard = document.createElement('button');
            cancelBtnCard.setAttribute('aria-label', 'Cancelar reto');
            cancelBtnCard.style.cssText = 'width:38px;height:38px;border-radius:19px;'
                + 'border:1.5px solid rgba(239,68,68,.35);background:transparent;cursor:pointer;'
                + 'display:flex;align-items:center;justify-content:center;color:#ef4444;'
                + 'font-family:var(--f);font-size:18px;font-weight:900;line-height:1;';
            cancelBtnCard.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            cancelBtnCard.onclick = function() {
                _cancelCrewChallenge(challenge, crew);
            };
            btnRow.appendChild(cancelBtnCard);
        }
        card.appendChild(btnRow);

        container.innerHTML = '';
        container.appendChild(card);

        // ── Check de completado tras el render inicial ──
        // Si el progreso ya está al 100% (caso típico: posts existentes antes
        // de crear el reto), disparamos complete_challenge sin esperar evento.
        if (pct >= 100 && challenge.status === 'active') {
            console.info('[MR] post-render: pct >= 100, triggering completion check');
            _triggerChallengeCompletion(challenge, crew);
        }

        // ── Real-time: actualizar progreso al publicar/borrar posts del crew ──
        _attachChallengeRealtimeIfNeeded(challenge, crew);
    }

    // ─── Disparar completado: llamar al RPC + celebrar localmente ────
    // Extraído para poder reutilizar desde render inicial y desde real-time.
    async function _triggerChallengeCompletion(challenge, crew) {
        var sb = window._sbClient;
        try {
            var compResp = await sb.rpc('complete_challenge', { _challenge_id: challenge.id });
            console.info('[MR] complete_challenge RPC response:', compResp);
            if (compResp && compResp.error) {
                console.error('[MR] complete_challenge RPC error:', compResp.error);
                return;
            }
            var compRes = compResp && compResp.data;
            if (compRes && compRes.ok === true) {
                console.info('[MR] challenge completed via RPC — firing celebration locally');
                try { localStorage.setItem(_uk('mr_challenge_celebrated_' + challenge.id), '1'); } catch(_) {}
                var updatedCh = Object.assign({}, challenge, { status: 'completed', completed_at: new Date().toISOString() });
                _showCrewChallengeCelebration(updatedCh, crew);
            } else if (compRes) {
                console.info('[MR] complete_challenge returned:', compRes);
            }
        } catch(e) {
            console.warn('[MR] trigger completion failed:', e);
        }
    }

    // ─── Suscripción real-time para el reto activo del crew ──────────
    // Se engancha al ov del crew detail. Escucha INSERT y DELETE de
    // club_posts con crew_id=crew.id; en cada evento re-renderiza la
    // tarjeta (lo que dispara un re-fetch del RPC get_challenge_progress).
    // Si el progreso alcanza el objetivo → llama a complete_challenge RPC.
    function _attachChallengeRealtimeIfNeeded(challenge, crew) {
        var ovCrew = document.getElementById('crew-detail-view');
        if (!ovCrew || ovCrew.dataset.crewId !== crew.id) return;
        if (!ovCrew._challengeRtChannels) ovCrew._challengeRtChannels = [];
        // Si ya hay canales activos para este challenge, no duplicar
        if (ovCrew._challengeRtChallengeId === challenge.id) return;
        // Si había canales de un challenge anterior, limpiarlos
        if (ovCrew._challengeRtChannels.length) {
            ovCrew._challengeRtChannels.forEach(function(ch) {
                try { window._sbClient.removeChannel(ch); } catch(_) {}
            });
            ovCrew._challengeRtChannels = [];
        }
        ovCrew._challengeRtChallengeId = challenge.id;

        var sb = window._sbClient;

        // Handler común: re-render de la tarjeta + check de completado
        var refreshTimer = null;
        function scheduleRefresh() {
            // Debounce 350ms para agrupar ráfagas (e.g. múltiples reactions)
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(function() {
                refreshTimer = null;
                _refreshChallengeCardAndCheckComplete(challenge, crew);
            }, 350);
        }

        var chPosts = sb.channel('mr-crew-challenge-posts-' + crew.id)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'club_posts',
                filter: 'crew_id=eq.' + crew.id
            }, function() { scheduleRefresh(); })
            .on('postgres_changes', {
                event: 'DELETE', schema: 'public', table: 'club_posts',
                filter: 'crew_id=eq.' + crew.id
            }, function() { scheduleRefresh(); })
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'club_posts',
                filter: 'crew_id=eq.' + crew.id
            }, function(payload) {
                // Si se marca deleted_at, también afecta al progreso
                if (payload && payload.new && payload.new.deleted_at) {
                    scheduleRefresh();
                }
            })
            .subscribe();
        ovCrew._challengeRtChannels.push(chPosts);

        // Canal de UPDATE del propio reto: si pasa a 'completed' o 'cancelled',
        // mostrar celebración (completed) o refrescar tab (cancelled).
        var chState = sb.channel('mr-crew-challenge-state-' + crew.id)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'crew_challenges',
                filter: 'crew_id=eq.' + crew.id
            }, async function(payload) {
                try {
                    var oldRow = payload && payload.old;
                    var newRow = payload && payload.new;
                    if (!newRow) return;
                    var wasActive = !oldRow || oldRow.status === 'active';
                    if (wasActive && newRow.status === 'completed') {
                        // Mostrar celebración (si no se mostró ya por otra vía)
                        try { localStorage.setItem(_uk('mr_challenge_celebrated_' + newRow.id), '1'); } catch(_) {}
                        _showCrewChallengeCelebration(newRow, crew);
                    } else if (wasActive && newRow.status !== 'active') {
                        // Cualquier otro cambio (cancelled, expired): repintar tab
                        var tabBtn = ovCrew.querySelector('button[data-tab="challenges"]');
                        if (tabBtn && ovCrew.dataset.activeTab === 'challenges') tabBtn.click();
                    }
                } catch(_) {}
            })
            .subscribe();
        ovCrew._challengeRtChannels.push(chState);
    }

    // ─── Re-render in-place de la tarjeta (incluye check de completado) ──
    async function _refreshChallengeCardAndCheckComplete(challenge, crew) {
        var ovCrew = document.getElementById('crew-detail-view');
        if (!ovCrew || ovCrew.dataset.crewId !== crew.id) return;
        // Refrescar banner siempre (independiente de la tab activa)
        var banner = ovCrew.querySelector('#crew-active-challenge-banner');
        if (banner && typeof ovCrew._loadActiveChallengeBannerFn === 'function') {
            ovCrew._loadActiveChallengeBannerFn(crew, banner);
        }
        // Si ya no estamos en la tab Retos, no refrescar la tarjeta (pero el
        // canal de state seguirá activo hasta el cleanup natural).
        if (ovCrew.dataset.activeTab !== 'challenges') return;
        var host = ovCrew.querySelector('[data-challenge-id="' + challenge.id + '"]');
        if (!host) return;
        // Re-render: la tarjeta entera vuelve a montarse. El check de
        // completado (cuando pct >= 100) está integrado en _renderChallengeCard.
        try {
            await _renderChallengeCard(challenge, crew, host);
        } catch(e) {
            console.error('[MR] refresh challenge card failed:', e);
        }
    }

    // ─── Modal de celebración cuando se completa el reto ──────────────
    function _showCrewChallengeCelebration(challenge, crew) {
        // Evitar duplicados
        if (document.getElementById('crew-challenge-celebration')) return;

        var ovCel = document.createElement('div');
        ovCel.id = 'crew-challenge-celebration';
        ovCel.style.cssText = 'position:fixed;inset:0;z-index:20050;background:rgba(0,0,0,.65);'
            + 'display:flex;align-items:center;justify-content:center;padding:24px;'
            + 'opacity:0;transition:opacity .35s ease;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);'
            + 'overflow:hidden;';

        // Confeti: piezas absolutas que caen con animación CSS keyframe
        // Inyectamos las keyframes una sola vez
        if (!document.getElementById('mr-confetti-style')) {
            var st = document.createElement('style');
            st.id = 'mr-confetti-style';
            st.textContent =
                '@keyframes mrConfettiFall {'
              + '  0%   { transform: translate3d(0,-30vh,0) rotate(0deg); opacity: 0; }'
              + '  10%  { opacity: 1; }'
              + '  100% { transform: translate3d(var(--dx,0),110vh,0) rotate(720deg); opacity: 1; }'
              + '}';
            document.head.appendChild(st);
        }
        var confettiColors = ['#c4881e', '#e8b94a', '#a8adb5', '#d4d7dc', '#f0d272'];
        var CONFETTI_N = 60;
        for (var i = 0; i < CONFETTI_N; i++) {
            var p = document.createElement('div');
            var col = confettiColors[i % confettiColors.length];
            var leftPct = Math.round(Math.random() * 100);
            var dx = Math.round((Math.random() - 0.5) * 80); // -40px a +40px
            var dur = (2.4 + Math.random() * 2.2).toFixed(2);
            var delay = (Math.random() * 0.6).toFixed(2);
            var w = 5 + Math.round(Math.random() * 5);
            var h = 8 + Math.round(Math.random() * 8);
            var rot = Math.round(Math.random() * 360);
            p.style.cssText = 'position:absolute;top:0;left:' + leftPct + '%;'
                + 'width:' + w + 'px;height:' + h + 'px;background:' + col + ';'
                + 'border-radius:2px;transform:rotate(' + rot + 'deg);'
                + '--dx:' + dx + 'vw;'
                + 'animation:mrConfettiFall ' + dur + 's cubic-bezier(.32,.72,0,1) ' + delay + 's forwards;'
                + 'pointer-events:none;';
            ovCel.appendChild(p);
        }

        // Tarjeta central
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--card);border-radius:22px;padding:36px 26px 24px;'
            + 'border:2px solid #c4881e;text-align:center;max-width:340px;width:100%;'
            + 'box-shadow:0 8px 30px rgba(0,0,0,.55),0 0 40px rgba(196,136,30,.25);'
            + 'transform:scale(.85);opacity:0;transition:transform .35s cubic-bezier(.32,1.6,.4,1),opacity .3s ease;'
            + 'position:relative;z-index:1;';

        var trophy = document.createElement('div');
        trophy.style.cssText = 'font-size:72px;line-height:1;margin-bottom:12px;filter:drop-shadow(0 4px 12px rgba(196,136,30,.5));';
        trophy.textContent = '🏆';

        var celLabel = document.createElement('div');
        celLabel.style.cssText = 'font-size:11px;font-weight:800;color:#c4881e;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;';
        celLabel.textContent = '¡Reto completado!';

        var celTitle = document.createElement('div');
        celTitle.style.cssText = 'font-size:20px;font-weight:900;color:var(--tw);line-height:1.25;letter-spacing:.2px;margin-bottom:16px;word-break:break-word;';
        celTitle.textContent = challenge.title || '—';

        var statsBox = document.createElement('div');
        statsBox.style.cssText = 'padding:14px 12px;border-radius:14px;background:rgba(196,136,30,.12);'
            + 'border:1px solid rgba(196,136,30,.35);margin-bottom:18px;';
        var statsBig = document.createElement('div');
        statsBig.style.cssText = 'font-size:28px;font-weight:900;color:var(--tw);line-height:1;margin-bottom:4px;';
        statsBig.textContent = 'Cargando…';
        var statsSub = document.createElement('div');
        statsSub.style.cssText = 'font-size:11px;color:var(--tm);font-weight:700;';
        statsSub.textContent = ' ';
        statsBox.appendChild(statsBig);
        statsBox.appendChild(statsSub);

        var msg = document.createElement('div');
        msg.style.cssText = 'font-size:12px;color:var(--tm);line-height:1.5;margin-bottom:20px;';
        msg.textContent = (crew.name || 'El crew') + ' ha cumplido el objetivo. ¡Choca esos cinco con tu crew! 🙌';

        var btn = document.createElement('button');
        btn.style.cssText = 'width:100%;height:44px;border-radius:22px;'
            + 'border:none;background:linear-gradient(135deg,#c4881e 0%,#e8b94a 100%);'
            + 'color:#1a1612;font-family:var(--f);font-size:13px;font-weight:800;letter-spacing:.3px;'
            + 'cursor:pointer;box-shadow:0 4px 14px rgba(196,136,30,.4);';
        btn.textContent = '¡A por el siguiente!';

        card.appendChild(trophy);
        card.appendChild(celLabel);
        card.appendChild(celTitle);
        card.appendChild(statsBox);
        card.appendChild(msg);
        card.appendChild(btn);

        ovCel.appendChild(card);
        document.body.appendChild(ovCel);

        // Animar
        requestAnimationFrame(function() {
            ovCel.style.opacity = '1';
            card.style.transform = 'scale(1)';
            card.style.opacity = '1';
        });

        function close() {
            ovCel.style.opacity = '0';
            card.style.transform = 'scale(.85)';
            card.style.opacity = '0';
            setTimeout(function() {
                if (ovCel.parentNode) ovCel.parentNode.removeChild(ovCel);
                // Repintar tab Retos al cerrar para mostrar histórico
                var ovDet = document.getElementById('crew-detail-view');
                if (ovDet && ovDet.dataset.crewId === crew.id && ovDet.dataset.activeTab === 'challenges') {
                    var tabBtn = ovDet.querySelector('button[data-tab="challenges"]');
                    if (tabBtn) tabBtn.click();
                }
            }, 320);
        }
        btn.onclick = close;
        ovCel.onclick = function(e) { if (e.target === ovCel) close(); };

        // Cargar stats finales asíncronamente
        (async function() {
            try {
                var sb = window._sbClient;
                var [ progRes, memsRes ] = await Promise.all([
                    sb.rpc('get_challenge_progress', { _challenge_id: challenge.id }),
                    sb.from('crew_members').select('user_id').eq('crew_id', crew.id)
                ]);
                var prog = progRes.data || { total_km: 0, total_sessions: 0, contributors: [] };
                var memCount = (memsRes.data || []).length;
                var contribCount = (prog.contributors || []).length;
                if (challenge.challenge_type === 'collective_distance') {
                    statsBig.textContent = Number(prog.total_km || 0).toFixed(1) + ' km';
                    statsSub.textContent = 'entre ' + contribCount + ' miembro' + (contribCount === 1 ? '' : 's')
                        + ' · ' + Math.floor(prog.total_sessions || 0) + ' sesiones';
                } else if (challenge.challenge_type === 'collective_sessions') {
                    statsBig.textContent = Math.floor(prog.total_sessions || 0) + ' sesiones';
                    statsSub.textContent = 'entre ' + contribCount + ' miembro' + (contribCount === 1 ? '' : 's')
                        + ' · ' + Number(prog.total_km || 0).toFixed(1) + ' km totales';
                } else {
                    statsBig.textContent = memCount + ' de ' + memCount + ' ✓';
                    statsSub.textContent = 'todos los miembros han cumplido el mínimo';
                }
            } catch(e) {
                statsBig.textContent = '🎉';
                statsSub.textContent = '';
            }
        })();

        // Notificación push local
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                var n = new Notification('🎉 Reto completado', {
                    body: (crew.name || 'El crew') + ' ha completado «' + (challenge.title || '') + '»',
                    icon: '/icon-192.png',
                    badge: '/badge-72.png',
                    tag: 'mr-challenge-' + challenge.id
                });
                setTimeout(function() { try { n.close(); } catch(_) {} }, 7000);
            }
        } catch(_) {}
    }
    window._showCrewChallengeCelebration = _showCrewChallengeCelebration;

    // ─── Cancelar reto (solo owner) — doble confirm ────────────────
    async function _cancelCrewChallenge(challenge, crew) {
        if (!challenge || !challenge.id) return;
        var ok1 = confirm('¿Cancelar el reto «' + (challenge.title || '') + '»?\n\n'
            + 'Se marcará como cancelado y aparecerá en el histórico.');
        if (!ok1) return;
        var ok2 = confirm('Esta acción no se puede deshacer. ¿Seguro?');
        if (!ok2) return;
        var sb = window._sbClient;
        try {
            var { error } = await sb.from('crew_challenges')
                .update({ status: 'cancelled' })
                .eq('id', challenge.id);
            if (error) {
                console.error('[MR] cancel challenge failed:', error);
                showToast('No se pudo cancelar el reto', 2400);
                return;
            }
            showToast('Reto cancelado', 2200);
            // Repintar tab
            var ovDetail = document.getElementById('crew-detail-view');
            if (ovDetail && ovDetail.dataset.crewId === crew.id && ovDetail.dataset.activeTab === 'challenges') {
                var tabBtn = ovDetail.querySelector('button[data-tab="challenges"]');
                if (tabBtn) tabBtn.click();
            }
        } catch(e) {
            console.error('[MR] cancel challenge error:', e);
            showToast('No se pudo cancelar el reto', 2400);
        }
    }

    function setActiveTab(name) {
        // Estilo activo: color silver-dk + border-bottom plateado
        [tabFeed, tabChallenges, tabMembers].forEach(function(t) {
            var active = t.dataset.tab === name;
            t.style.color = active ? 'var(--silver-dk)' : 'var(--tm)';
            t.style.borderBottomColor = active ? 'var(--silver-dk)' : 'transparent';
            // Limpiar barra antigua si existe (legacy)
            var existingBar = t.querySelector('[data-tab-bar]');
            if (existingBar) existingBar.remove();
        });
        ov.dataset.activeTab = name;
        // Refrescar banner del reto activo (puede haber cambiado tras crear/cancelar/completar)
        if (challengeBanner) {
            _loadActiveChallengeBanner(c, challengeBanner);
        }
        // Si salimos de la tab "challenges", desuscribimos los canales real-time
        // para no acumular suscripciones cuando el usuario hace ping-pong entre tabs.
        if (name !== 'challenges' && ov._challengeRtChannels && ov._challengeRtChannels.length) {
            try {
                ov._challengeRtChannels.forEach(function(ch) {
                    try { window._sbClient.removeChannel(ch); } catch(_) {}
                });
            } catch(_) {}
            ov._challengeRtChannels = [];
        }
        if (name === 'feed') renderTabFeed();
        else if (name === 'challenges') renderTabChallenges();
        else renderTabMembers();
    }
    tabFeed.onclick       = function() { setActiveTab('feed'); };
    tabChallenges.onclick = function() { setActiveTab('challenges'); };
    tabMembers.onclick    = function() { setActiveTab('members'); };

    ov.appendChild(hdr);
    ov.appendChild(body);
    document.body.appendChild(ov);

    // Estado inicial: tab Feed
    setActiveTab('feed');

    // Cargar stats del crew (Miembros / Posts / Retos) — async sin bloquear UI
    // Nota: usamos select normal + .length en lugar de count:exact,head:true
    // porque count:exact requiere policies RLS especiales que pueden fallar
    // silenciosamente devolviendo null.
    (function _loadCrewStats() {
        try {
            var sbS = window._sbClient;
            if (!sbS || !c || !c.id) return;
            Promise.all([
                sbS.from('crew_members').select('user_id').eq('crew_id', c.id),
                sbS.from('club_posts').select('id').eq('crew_id', c.id),
                sbS.from('crew_challenges').select('id').eq('crew_id', c.id)
            ]).then(function(results) {
                var nm = (results[0] && Array.isArray(results[0].data)) ? results[0].data.length : 0;
                var np = (results[1] && Array.isArray(results[1].data)) ? results[1].data.length : 0;
                var nc = (results[2] && Array.isArray(results[2].data)) ? results[2].data.length : 0;
                var elM = ov.querySelector('#crew-stat-members');
                var elP = ov.querySelector('#crew-stat-posts');
                var elC = ov.querySelector('#crew-stat-challenges');
                if (elM) elM.textContent = String(nm);
                if (elP) elP.textContent = String(np);
                if (elC) elC.textContent = String(nc);
            }).catch(function(e) {
                console.warn('[MR] crew stats load fail:', e);
                var elM = ov.querySelector('#crew-stat-members');
                var elP = ov.querySelector('#crew-stat-posts');
                var elC = ov.querySelector('#crew-stat-challenges');
                if (elM && elM.textContent === '—') elM.textContent = '0';
                if (elP && elP.textContent === '—') elP.textContent = '0';
                if (elC && elC.textContent === '—') elC.textContent = '0';
            });
        } catch (e) { /* swallow */ }
    })();

    // Slide-in
    requestAnimationFrame(function() { ov.style.transform = 'translateX(0)'; });
}
window.openCrewDetail = openCrewDetail;

// ─── Modal: crear nuevo reto del crew ──────────────────────────────
// Solo accesible para owners. Inserta en crew_challenges con status='active'.
// Si ya hay uno activo en ese crew, el UNIQUE index lo bloquea (toast).
async function openCreateCrewChallenge(crew) {
    if (!crew || !crew.id) return;
    if (crew.role !== 'owner') {
        showToast('Solo el propietario puede crear retos', 2200);
        return;
    }
    // Evitar duplicados
    if (document.getElementById('crew-challenge-create-modal')) return;

    var sb = window._sbClient;

    // ── Overlay ──
    var ov = document.createElement('div');
    ov.id = 'crew-challenge-create-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:20020;background:rgba(0,0,0,.55);'
        + 'display:flex;align-items:flex-end;justify-content:center;'
        + 'opacity:0;transition:opacity .22s ease;'
        + 'padding:0;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);';

    // ── Sheet (subiendo desde abajo) ──
    var sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:520px;background:var(--bg);'
        + 'border-radius:20px 20px 0 0;padding:0;'
        + 'transform:translateY(100%);transition:transform .28s cubic-bezier(.32,.72,0,1);'
        + 'max-height:92vh;overflow-y:auto;display:flex;flex-direction:column;'
        + 'box-shadow:0 -8px 24px rgba(0,0,0,.35);';

    // ── Cabecera ──
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:14px 16px 12px;'
        + 'border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;'
        + 'position:sticky;top:0;background:var(--bg);z-index:1;';
    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.style.cssText = 'width:34px;height:34px;border-radius:50%;border:none;background:var(--card);'
        + 'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
        + 'font-size:18px;line-height:1;color:var(--tm);';
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    var hdrText = document.createElement('div');
    hdrText.style.cssText = 'flex:1;min-width:0;';
    var hdrCrewName = document.createElement('div');
    hdrCrewName.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    hdrCrewName.textContent = crew.name || 'Crew';
    var hdrMain = document.createElement('div');
    hdrMain.style.cssText = 'font-size:17px;font-weight:900;color:var(--tw);letter-spacing:.2px;line-height:1.2;';
    hdrMain.textContent = 'Nuevo reto';
    hdrText.appendChild(hdrCrewName);
    hdrText.appendChild(hdrMain);
    var hdrIcon = document.createElement('div');
    hdrIcon.style.cssText = 'font-size:24px;line-height:1;filter:drop-shadow(0 2px 4px rgba(80,85,92,.4));flex-shrink:0;';
    hdrIcon.textContent = '🏆';
    hdr.appendChild(closeBtn);
    hdr.appendChild(hdrText);
    hdr.appendChild(hdrIcon);

    // ── Body ──
    var bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'padding:16px 16px 20px;display:flex;flex-direction:column;gap:18px;';

    // ── Estado del form ──
    var state = {
        type: 'collective_distance',
        title: '',
        target: '',
        targetSec: '',
        startsAt: '',
        endsAt: ''
    };

    // ── Sección: tipo de reto ──
    var typeSection = document.createElement('div');
    var typeLabel = document.createElement('div');
    typeLabel.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px;';
    typeLabel.textContent = 'Tipo de reto';
    typeSection.appendChild(typeLabel);

    var typeList = document.createElement('div');
    typeList.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    var TYPES = [
        { id: 'collective_distance',     emoji: '📏', name: 'Distancia colectiva', desc: 'X km entre todos en un periodo' },
        { id: 'collective_sessions',     emoji: '🔥', name: 'Sesiones colectivas', desc: 'X sesiones entre todos' },
        { id: 'individual_consistency',  emoji: '🎯', name: 'Constancia individual', desc: 'Todos cumplen un mínimo' }
    ];

    var typeButtons = {};
    TYPES.forEach(function(t) {
        var b = document.createElement('button');
        b.type = 'button';
        b.dataset.typeId = t.id;
        b.style.cssText = 'all:unset;box-sizing:border-box;width:100%;'
            + 'padding:12px 14px;border-radius:12px;cursor:pointer;'
            + 'display:flex;align-items:center;gap:11px;'
            + 'font-family:var(--f);transition:background .15s,border-color .15s;';
        b.innerHTML =
            '<div data-radio style="width:18px;height:18px;border-radius:50%;border:2px solid var(--tm);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s;"></div>'
            + '<div style="flex:1;min-width:0;">'
            +   '<div style="font-size:13px;font-weight:800;color:var(--tw);line-height:1.2;">' + t.name + '</div>'
            +   '<div style="font-size:11px;color:var(--tm);margin-top:2px;line-height:1.3;">' + t.desc + '</div>'
            + '</div>'
            + '<div style="font-size:18px;line-height:1;flex-shrink:0;">' + t.emoji + '</div>';
        b.onclick = function() {
            state.type = t.id;
            applyTypeStyle();
            applyTargetUnits();
        };
        typeList.appendChild(b);
        typeButtons[t.id] = b;
    });
    function applyTypeStyle() {
        Object.keys(typeButtons).forEach(function(k) {
            var btn = typeButtons[k];
            var active = (k === state.type);
            btn.style.border = active
                ? '1.5px solid var(--silver-bd)'
                : '1.5px solid var(--border)';
            btn.style.background = active
                ? 'var(--silver-tint)'
                : 'var(--card)';
            var radio = btn.querySelector('[data-radio]');
            if (radio) {
                radio.style.borderColor = active ? 'var(--silver)' : 'var(--tm)';
                radio.style.background  = active ? 'var(--silver)' : 'transparent';
                radio.innerHTML = active
                    ? '<div style="width:7px;height:7px;border-radius:50%;background:var(--bg);"></div>'
                    : '';
            }
        });
    }
    typeSection.appendChild(typeList);
    bodyEl.appendChild(typeSection);

    // ── Sección: título ──
    var titleSection = document.createElement('div');
    var titleLabel = document.createElement('div');
    titleLabel.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px;';
    titleLabel.textContent = 'Título del reto';
    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.maxLength = 60;
    titleInput.placeholder = 'p. ej. 200 km en Mayo';
    titleInput.style.cssText = 'width:100%;padding:11px 13px;border-radius:10px;'
        + 'border:1.5px solid var(--border);background:var(--card);'
        + 'font-family:var(--f);font-size:13px;color:var(--tw);font-weight:600;'
        + 'outline:none;box-sizing:border-box;';
    titleInput.oninput = function() {
        state.title = titleInput.value;
        titleHint.textContent = (titleInput.value.trim().length < 3)
            ? 'Mínimo 3 caracteres'
            : '';
    };
    titleInput.onfocus = function() { titleInput.style.borderColor = 'var(--silver-bd)'; };
    titleInput.onblur  = function() { titleInput.style.borderColor = 'var(--border)'; };
    var titleHint = document.createElement('div');
    titleHint.style.cssText = 'font-size:10px;color:var(--danger);margin-top:4px;min-height:12px;';
    titleSection.appendChild(titleLabel);
    titleSection.appendChild(titleInput);
    titleSection.appendChild(titleHint);
    bodyEl.appendChild(titleSection);

    // ── Sección: objetivo ──
    var targetSection = document.createElement('div');
    var targetLabel = document.createElement('div');
    targetLabel.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px;';
    targetSection.appendChild(targetLabel);
    var targetRow = document.createElement('div');
    targetRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
    var targetInput = document.createElement('input');
    targetInput.type = 'number';
    targetInput.min = '1';
    targetInput.step = 'any';
    targetInput.inputMode = 'decimal';
    targetInput.placeholder = '0';
    targetInput.style.cssText = 'flex:1;padding:11px 13px;border-radius:10px;'
        + 'border:1.5px solid var(--border);background:var(--card);'
        + 'font-family:var(--f);font-size:18px;color:var(--tw);font-weight:900;'
        + 'outline:none;box-sizing:border-box;text-align:center;';
    targetInput.oninput = function() { state.target = targetInput.value; };
    targetInput.onfocus = function() { targetInput.style.borderColor = 'var(--silver-bd)'; };
    targetInput.onblur  = function() { targetInput.style.borderColor = 'var(--border)'; };
    var targetUnit = document.createElement('div');
    targetUnit.style.cssText = 'font-size:13px;color:var(--tm);font-weight:700;min-width:64px;';
    targetRow.appendChild(targetInput);
    targetRow.appendChild(targetUnit);
    targetSection.appendChild(targetRow);

    // Subcampo opcional para constancia individual
    var targetSecBlock = document.createElement('div');
    targetSecBlock.style.cssText = 'margin-top:10px;display:none;';
    var targetSecLabel = document.createElement('div');
    targetSecLabel.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px;';
    targetSecLabel.textContent = 'o (opcional) mínimo de sesiones por persona';
    var targetSecRow = document.createElement('div');
    targetSecRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
    var targetSecInput = document.createElement('input');
    targetSecInput.type = 'number';
    targetSecInput.min = '1';
    targetSecInput.step = '1';
    targetSecInput.inputMode = 'numeric';
    targetSecInput.placeholder = '0';
    targetSecInput.style.cssText = 'flex:1;padding:11px 13px;border-radius:10px;'
        + 'border:1.5px solid var(--border);background:var(--card);'
        + 'font-family:var(--f);font-size:15px;color:var(--tw);font-weight:800;'
        + 'outline:none;box-sizing:border-box;text-align:center;';
    targetSecInput.oninput = function() { state.targetSec = targetSecInput.value; };
    targetSecInput.onfocus = function() { targetSecInput.style.borderColor = 'var(--silver-bd)'; };
    targetSecInput.onblur  = function() { targetSecInput.style.borderColor = 'var(--border)'; };
    var targetSecUnit = document.createElement('div');
    targetSecUnit.style.cssText = 'font-size:12px;color:var(--tm);font-weight:700;min-width:64px;';
    targetSecUnit.textContent = 'sesiones';
    targetSecRow.appendChild(targetSecInput);
    targetSecRow.appendChild(targetSecUnit);
    targetSecBlock.appendChild(targetSecLabel);
    targetSecBlock.appendChild(targetSecRow);
    targetSection.appendChild(targetSecBlock);
    bodyEl.appendChild(targetSection);

    function applyTargetUnits() {
        if (state.type === 'collective_distance') {
            targetLabel.textContent = 'Objetivo (km)';
            targetUnit.textContent = 'km';
            targetSecBlock.style.display = 'none';
        } else if (state.type === 'collective_sessions') {
            targetLabel.textContent = 'Objetivo (sesiones)';
            targetUnit.textContent = 'sesiones';
            targetSecBlock.style.display = 'none';
            // Forzar entero en sesiones colectivas
            targetInput.step = '1';
            targetInput.inputMode = 'numeric';
        } else if (state.type === 'individual_consistency') {
            targetLabel.textContent = 'Mínimo por persona (km)';
            targetUnit.textContent = 'km';
            targetSecBlock.style.display = 'block';
        }
        // Restaurar step si volvemos a distance
        if (state.type !== 'collective_sessions') {
            targetInput.step = 'any';
            targetInput.inputMode = 'decimal';
        }
    }

    // ── Sección: fechas ──
    var datesSection = document.createElement('div');
    datesSection.style.cssText = 'display:flex;gap:10px;';
    function makeDateBlock(labelText, defaultDate) {
        var w = document.createElement('div');
        w.style.cssText = 'flex:1;min-width:0;';
        var l = document.createElement('div');
        l.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px;';
        l.textContent = labelText;
        var inp = document.createElement('input');
        inp.type = 'date';
        inp.value = defaultDate;
        inp.style.cssText = 'width:100%;padding:11px 12px;border-radius:10px;'
            + 'border:1.5px solid var(--border);background:var(--card);'
            + 'font-family:var(--f);font-size:13px;color:var(--tw);font-weight:700;'
            + 'outline:none;box-sizing:border-box;';
        inp.onfocus = function() { inp.style.borderColor = 'var(--silver-bd)'; };
        inp.onblur  = function() { inp.style.borderColor = 'var(--border)'; };
        w.appendChild(l);
        w.appendChild(inp);
        return { wrap: w, input: inp };
    }
    function _toYMD(d) {
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + dd;
    }
    var todayD = new Date();
    var plus30 = new Date(); plus30.setDate(plus30.getDate() + 30);
    var startBlock = makeDateBlock('Inicio', _toYMD(todayD));
    var endBlock   = makeDateBlock('Fin',    _toYMD(plus30));
    state.startsAt = startBlock.input.value;
    state.endsAt   = endBlock.input.value;
    startBlock.input.onchange = function() { state.startsAt = startBlock.input.value; };
    endBlock.input.onchange   = function() { state.endsAt   = endBlock.input.value; };
    datesSection.appendChild(startBlock.wrap);
    datesSection.appendChild(endBlock.wrap);
    bodyEl.appendChild(datesSection);

    // ── Hint informativo ──
    var hint = document.createElement('div');
    hint.style.cssText = 'padding:10px 12px;border-radius:10px;background:var(--silver-tint);'
        + 'font-size:11px;color:var(--tm);line-height:1.45;text-align:center;';
    hint.textContent = 'Solo cuentan las actividades de running publicadas al crew durante el periodo.';
    bodyEl.appendChild(hint);

    // ── Botones ──
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;margin-top:4px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.style.cssText = 'flex:1;height:46px;border-radius:23px;'
        + 'border:1.5px solid var(--border);background:transparent;color:var(--tm);'
        + 'font-family:var(--f);font-size:13px;font-weight:800;letter-spacing:.3px;cursor:pointer;';
    cancelBtn.textContent = 'Cancelar';
    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.style.cssText = 'flex:1.4;height:46px;border-radius:23px;'
        + 'border:1.5px solid var(--silver-bd);background:var(--silver-grad);'
        + 'color:#fff;font-family:var(--f);font-size:13px;font-weight:800;letter-spacing:.3px;'
        + 'cursor:pointer;text-shadow:0 1px 1px rgba(0,0,0,.22);'
        + 'box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 3px 8px rgba(80,85,92,.3);';
    submitBtn.textContent = '🏆 Lanzar reto';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    bodyEl.appendChild(actions);

    sheet.appendChild(hdr);
    sheet.appendChild(bodyEl);
    ov.appendChild(sheet);
    document.body.appendChild(ov);

    // ── Cierre ──
    function close() {
        ov.style.opacity = '0';
        sheet.style.transform = 'translateY(100%)';
        setTimeout(function() { ov.remove(); }, 280);
    }
    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    ov.onclick = function(e) { if (e.target === ov) close(); };

    // ── Submit ──
    submitBtn.onclick = async function() {
        var title = state.title.trim();
        if (title.length < 3) {
            showToast('El título debe tener al menos 3 caracteres', 2400);
            titleInput.focus();
            return;
        }
        var targetNum = parseFloat(state.target);
        if (!isFinite(targetNum) || targetNum <= 0) {
            showToast('El objetivo debe ser un número positivo', 2400);
            targetInput.focus();
            return;
        }
        var startsAt = state.startsAt;
        var endsAt   = state.endsAt;
        if (!startsAt || !endsAt) {
            showToast('Indica fecha de inicio y de fin', 2400);
            return;
        }
        // Comparamos por timestamps al inicio del día (locales) — el CHECK del
        // backend usa timestamptz, así que mandamos ISO completo.
        var startDate = new Date(startsAt + 'T00:00:00');
        var endDate   = new Date(endsAt   + 'T23:59:59');
        if (!(endDate > startDate)) {
            showToast('La fecha de fin debe ser posterior al inicio', 2600);
            return;
        }

        var targetSecNum = parseFloat(state.targetSec);
        var targetSecondary = (state.type === 'individual_consistency' && isFinite(targetSecNum) && targetSecNum > 0)
            ? targetSecNum
            : null;

        // Bloquear botón mientras se envía
        submitBtn.disabled = true;
        submitBtn.style.opacity = '.65';
        submitBtn.style.cursor = 'default';
        submitBtn.textContent = 'Lanzando…';

        try {
            var { data: { session } } = await sb.auth.getSession();
            if (!session) {
                showToast('Inicia sesión', 2400);
                throw new Error('no-session');
            }
            var payload = {
                crew_id:          crew.id,
                created_by:       session.user.id,
                challenge_type:   state.type,
                title:            title,
                target_value:     targetNum,
                target_secondary: targetSecondary,
                starts_at:        startDate.toISOString(),
                ends_at:          endDate.toISOString(),
                status:           'active'
            };
            var { data, error } = await sb.from('crew_challenges').insert(payload).select().single();
            if (error) {
                // 23505 = unique_violation (idx_crew_challenges_one_active)
                if (error.code === '23505') {
                    showToast('Ya hay un reto activo en este crew', 2800);
                } else if (error.code === 'PGRST205' || error.code === '42P01') {
                    showToast('La tabla de retos no está creada todavía', 3000);
                } else {
                    console.error('[MR] create challenge failed:', error);
                    showToast('No se pudo crear el reto', 2600);
                }
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
                submitBtn.textContent = '🏆 Lanzar reto';
                return;
            }
            // Éxito: cerrar modal, refrescar tab si está abierta
            showToast('🏆 Reto lanzado', 2600);
            close();
            // Repintar tab Retos del crew abierto
            var ovDetail = document.getElementById('crew-detail-view');
            if (ovDetail && ovDetail.dataset.crewId === crew.id && ovDetail.dataset.activeTab === 'challenges') {
                var tabBtn = ovDetail.querySelector('button[data-tab="challenges"]');
                if (tabBtn) tabBtn.click();
            }
        } catch(e) {
            if (e && e.message !== 'no-session') {
                console.error('[MR] create challenge error:', e);
                showToast('No se pudo crear el reto', 2600);
            }
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            submitBtn.style.cursor = 'pointer';
            submitBtn.textContent = '🏆 Lanzar reto';
        }
    };

    // Estilos iniciales
    applyTypeStyle();
    applyTargetUnits();

    // Animación de entrada
    requestAnimationFrame(function() {
        ov.style.opacity = '1';
        sheet.style.transform = 'translateY(0)';
    });
}
window.openCreateCrewChallenge = openCreateCrewChallenge;

// ─── Modal: detalle full-screen del reto del crew ──────────────────
// Ranking completo con todos los miembros, indicador de cumplimiento por
// miembro en retos de constancia individual, y acciones de owner.
async function openCrewChallengeDetail(challenge, crew) {
    if (!challenge || !challenge.id || !crew) return;
    if (document.getElementById('crew-challenge-detail-view')) return;

    var sb = window._sbClient;
    var amOwner = (crew.role === 'owner');

    // ── Overlay ──
    var ov = document.createElement('div');
    ov.id = 'crew-challenge-detail-view';
    ov.dataset.challengeId = challenge.id;
    ov.style.cssText = 'position:fixed;inset:0;z-index:20030;background:var(--bg);'
        + 'display:flex;flex-direction:column;'
        + 'transform:translateX(100%);transition:transform .32s cubic-bezier(.32,.72,0,1);overflow:hidden;';

    // ── Cabecera ──
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+10px) 15px 12px;'
        + 'border-bottom:1px solid var(--border);background:var(--bg);';

    var topRow = document.createElement('div');
    topRow.style.cssText = 'position:relative;display:flex;align-items:center;gap:10px;height:44px;margin-bottom:6px;';
    var backBtn = document.createElement('button');
    backBtn.setAttribute('aria-label', 'Volver');
    backBtn.style.cssText = 'width:42px;height:42px;border-radius:50%;border:none;background:var(--card);cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;z-index:1;';
    backBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    var topTitle = document.createElement('div');
    topTitle.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);'
        + 'font-size:14px;font-weight:800;color:var(--tm);text-align:center;letter-spacing:1.8px;'
        + 'pointer-events:none;text-transform:uppercase;';
    topTitle.textContent = 'RETO';
    var topSpacer = document.createElement('div');
    topSpacer.style.cssText = 'width:42px;height:42px;flex-shrink:0;';
    topRow.appendChild(backBtn);
    topRow.appendChild(document.createElement('div')).style.cssText = 'flex:1;';
    topRow.appendChild(topSpacer);
    topRow.appendChild(topTitle);
    hdr.appendChild(topRow);

    // Bloque identidad del reto: icono + título + fechas
    var typeMeta = {
        'collective_distance':    { emoji: '📏', label: 'Distancia colectiva' },
        'collective_sessions':    { emoji: '🔥', label: 'Sesiones colectivas' },
        'individual_consistency': { emoji: '🎯', label: 'Constancia individual' }
    }[challenge.challenge_type] || { emoji: '🏆', label: 'Reto' };

    var ident = document.createElement('div');
    ident.style.cssText = 'display:flex;align-items:center;gap:14px;padding:4px 2px 12px;';
    var avBox = document.createElement('div');
    avBox.style.cssText = 'width:54px;height:54px;border-radius:16px;background:var(--silver-grad);'
        + 'display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;'
        + 'box-shadow:0 4px 12px rgba(80,85,92,.25);';
    avBox.textContent = typeMeta.emoji;
    var identText = document.createElement('div');
    identText.style.cssText = 'flex:1;min-width:0;';
    var typeLbl = document.createElement('div');
    typeLbl.style.cssText = 'font-size:10px;font-weight:800;color:var(--tm);letter-spacing:1.2px;text-transform:uppercase;margin-bottom:3px;';
    typeLbl.textContent = typeMeta.label + ' · ' + (crew.name || 'Crew');
    var titleH = document.createElement('div');
    titleH.style.cssText = 'font-size:18px;font-weight:900;color:var(--tw);line-height:1.2;letter-spacing:.2px;'
        + 'word-break:break-word;';
    titleH.textContent = challenge.title || '—';
    var datesRow = document.createElement('div');
    datesRow.style.cssText = 'margin-top:5px;font-size:11px;color:var(--tm);font-weight:600;';
    function _fmtDateShort(iso) {
        try {
            var d = new Date(iso);
            return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch(_) { return ''; }
    }
    datesRow.textContent = _fmtDateShort(challenge.starts_at) + ' → ' + _fmtDateShort(challenge.ends_at);
    identText.appendChild(typeLbl);
    identText.appendChild(titleH);
    identText.appendChild(datesRow);
    ident.appendChild(avBox);
    ident.appendChild(identText);
    hdr.appendChild(ident);

    // ── Body scrollable ──
    var bodyEl = document.createElement('div');
    bodyEl.id = 'crew-challenge-detail-body';
    bodyEl.style.cssText = 'flex:1;overflow-y:auto;';

    ov.appendChild(hdr);
    ov.appendChild(bodyEl);
    document.body.appendChild(ov);

    // Cierre
    backBtn.onclick = function() {
        ov.style.transform = 'translateX(100%)';
        setTimeout(function() { ov.remove(); }, 320);
    };

    // Slide-in
    requestAnimationFrame(function() { ov.style.transform = 'translateX(0)'; });

    // ── Carga de datos ──
    bodyEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--tm);font-size:12px;">Cargando…</div>';

    var progressData = null, members = [], myId = null;
    try {
        var sessRes = await sb.auth.getSession();
        myId = sessRes.data && sessRes.data.session && sessRes.data.session.user.id;

        var [ progressRes, membersRes ] = await Promise.all([
            sb.rpc('get_challenge_progress', { _challenge_id: challenge.id }),
            sb.from('crew_members').select('user_id').eq('crew_id', crew.id)
        ]);
        if (progressRes.error) throw progressRes.error;
        progressData = progressRes.data || { total_km: 0, total_sessions: 0, contributors: [] };

        var memberIds = (membersRes.data || []).map(function(m) { return m.user_id; });
        if (memberIds.length) {
            var { data: profs, error: pErr } = await sb.from('profiles')
                .select('id, username, display_name, avatar_url')
                .in('id', memberIds);
            if (pErr) throw pErr;
            members = profs || [];
        }
    } catch (e) {
        console.error('[MR] challenge detail load failed:', e);
        bodyEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);font-size:12px;">No se pudo cargar el reto.</div>';
        return;
    }

    // Map: user_id → profile
    var profileMap = {};
    members.forEach(function(p) { if (p && p.id) profileMap[p.id] = p; });
    // Map: user_id → contribución
    var contribMap = {};
    (progressData.contributors || []).forEach(function(c) { contribMap[c.user_id] = c; });

    // ── Cálculo de progreso global según tipo ──
    var totalKm = Number(progressData.total_km || 0);
    var totalSessions = Number(progressData.total_sessions || 0);
    var globalCurrent, globalTarget, globalUnit, bigCurrent, bigTarget;

    if (challenge.challenge_type === 'collective_distance') {
        globalCurrent = totalKm;
        globalTarget = Number(challenge.target_value || 0);
        globalUnit = 'km';
        bigCurrent = globalCurrent.toFixed(1);
        bigTarget = '/ ' + (globalTarget % 1 === 0 ? globalTarget : globalTarget.toFixed(1)) + ' km';
    } else if (challenge.challenge_type === 'collective_sessions') {
        globalCurrent = totalSessions;
        globalTarget = Number(challenge.target_value || 0);
        globalUnit = 'sesiones';
        bigCurrent = String(Math.floor(globalCurrent));
        bigTarget = '/ ' + Math.floor(globalTarget) + ' sesiones';
    } else {
        // individual_consistency: cuántos cumplen
        var minKm = Number(challenge.target_value || 0);
        var minSec = challenge.target_secondary != null ? Number(challenge.target_secondary) : null;
        var cumplen = 0;
        members.forEach(function(p) {
            var contrib = contribMap[p.id];
            var km = contrib ? Number(contrib.km || 0) : 0;
            var ses = contrib ? Number(contrib.sessions || 0) : 0;
            if (km >= minKm && (minSec === null || ses >= minSec)) cumplen++;
        });
        globalCurrent = cumplen;
        globalTarget = members.length;
        globalUnit = 'miembros';
        bigCurrent = String(cumplen);
        bigTarget = '/ ' + members.length + ' miembros';
    }
    var pct = globalTarget > 0 ? Math.min(100, Math.round((globalCurrent / globalTarget) * 100)) : 0;

    // ── Pintar body ──
    bodyEl.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:20px 16px 100px;display:flex;flex-direction:column;gap:20px;';

    // Sección global: big number + barra
    var globalCard = document.createElement('div');
    globalCard.style.cssText = 'border-radius:18px;border:1.5px solid var(--silver-bd);'
        + 'background:var(--card);padding:22px 16px 20px;'
        + 'display:flex;flex-direction:column;align-items:center;gap:12px;'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.12);';

    var big = document.createElement('div');
    big.style.cssText = 'display:flex;align-items:baseline;justify-content:center;gap:8px;flex-wrap:wrap;';
    var bigValEl = document.createElement('div');
    bigValEl.style.cssText = 'font-size:46px;font-weight:900;color:var(--tw);line-height:1;letter-spacing:-1px;';
    bigValEl.textContent = bigCurrent;
    var bigUnit = document.createElement('div');
    bigUnit.style.cssText = 'font-size:16px;color:var(--tm);font-weight:800;';
    bigUnit.textContent = bigTarget;
    var pctPill = document.createElement('div');
    pctPill.style.cssText = 'margin-left:6px;padding:4px 11px;border-radius:11px;'
        + 'background:var(--silver-tint-strong);font-size:12px;font-weight:900;color:var(--tw);letter-spacing:.3px;';
    pctPill.textContent = pct + '%';
    big.appendChild(bigValEl);
    big.appendChild(bigUnit);
    big.appendChild(pctPill);

    var barWrap = document.createElement('div');
    barWrap.style.cssText = 'width:100%;padding:0 4px;';
    var bar = document.createElement('div');
    bar.style.cssText = 'height:12px;border-radius:6px;background:var(--silver-tint);overflow:hidden;'
        + 'position:relative;border:1px solid var(--silver-bd);';
    var fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:0%;background:var(--silver-grad);border-radius:5px;'
        + 'box-shadow:inset 0 -1px 2px rgba(0,0,0,.18);transition:width .7s cubic-bezier(.32,.72,0,1);';
    bar.appendChild(fill);
    barWrap.appendChild(bar);

    globalCard.appendChild(big);
    globalCard.appendChild(barWrap);
    wrap.appendChild(globalCard);

    requestAnimationFrame(function() {
        requestAnimationFrame(function() { fill.style.width = pct + '%'; });
    });

    // ── Ranking completo (todos los miembros, incluso los que no aportan) ──
    var rankSection = document.createElement('div');
    rankSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    var rankHeader = document.createElement('div');
    rankHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;padding:0 2px;';
    var rankTitle = document.createElement('div');
    rankTitle.style.cssText = 'font-size:11px;font-weight:800;color:var(--tm);letter-spacing:.6px;text-transform:uppercase;';
    rankTitle.textContent = 'Ranking del crew';
    var rankCount = document.createElement('div');
    rankCount.style.cssText = 'font-size:11px;font-weight:700;color:var(--tm);';
    rankCount.textContent = members.length + ' miembros';
    rankHeader.appendChild(rankTitle);
    rankHeader.appendChild(rankCount);
    rankSection.appendChild(rankHeader);

    // Construir lista combinada: todos los miembros, con su contribución o 0
    var rows = members.map(function(p) {
        var contrib = contribMap[p.id];
        return {
            profile:  p,
            km:       contrib ? Number(contrib.km || 0) : 0,
            sessions: contrib ? Number(contrib.sessions || 0) : 0,
            hasContrib: !!contrib
        };
    });
    // Orden: aportantes primero por km desc, luego no aportantes alfabéticos
    rows.sort(function(a, b) {
        if (a.hasContrib && !b.hasContrib) return -1;
        if (!a.hasContrib && b.hasContrib) return 1;
        if (a.hasContrib && b.hasContrib) {
            if (challenge.challenge_type === 'collective_sessions') return b.sessions - a.sessions;
            return b.km - a.km;
        }
        // Ambos sin aportar
        var an = (a.profile.display_name || a.profile.username || '');
        var bn = (b.profile.display_name || b.profile.username || '');
        return an.localeCompare(bn);
    });

    var medalColors = ['#c4881e', '#a8adb5', '#9b6a3a']; // oro, plata, bronce
    var minKmInd = (challenge.challenge_type === 'individual_consistency') ? Number(challenge.target_value || 0) : null;
    var minSecInd = (challenge.challenge_type === 'individual_consistency' && challenge.target_secondary != null)
                    ? Number(challenge.target_secondary) : null;

    rows.forEach(function(row, idx) {
        var rowEl = document.createElement('div');
        var isMe = (myId && row.profile.id === myId);
        var noContrib = !row.hasContrib;
        rowEl.style.cssText = 'display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:12px;'
            + 'background:' + (isMe ? 'var(--silver-tint-strong)' : (noContrib ? 'transparent' : 'var(--silver-tint)')) + ';'
            + 'border:1.5px solid ' + (isMe ? 'var(--silver-bd)' : (noContrib ? 'var(--border)' : 'transparent')) + ';'
            + 'opacity:' + (noContrib ? '.72' : '1') + ';';

        // Posición (medalla solo top 3 con aportes)
        var posEl = document.createElement('div');
        posEl.style.cssText = 'font-size:14px;font-weight:900;width:22px;text-align:center;flex-shrink:0;'
            + 'color:' + (idx < 3 && row.hasContrib ? medalColors[idx] : 'var(--tm)') + ';';
        posEl.textContent = row.hasContrib ? String(idx + 1) : '—';

        // Avatar
        var av = document.createElement('div');
        av.style.cssText = 'width:34px;height:34px;border-radius:50%;background:var(--card2,var(--card));'
            + 'display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--tw);'
            + 'overflow:hidden;flex-shrink:0;'
            + 'border:1.5px solid ' + (idx < 3 && row.hasContrib ? medalColors[idx] : 'var(--border)') + ';';
        if (row.profile.avatar_url) {
            var im = document.createElement('img');
            im.src = row.profile.avatar_url; im.loading = 'lazy';
            im.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            av.appendChild(im);
        } else {
            av.textContent = ((row.profile.display_name || row.profile.username || '?')[0] || '?').toUpperCase();
        }

        // Nombre + estado
        var nameCol = document.createElement('div');
        nameCol.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
        var nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:13px;font-weight:800;color:var(--tw);'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = (row.profile.display_name || row.profile.username || '—') + (isMe ? ' · tú' : '');
        nameCol.appendChild(nameEl);

        var subEl = document.createElement('div');
        subEl.style.cssText = 'font-size:10px;font-weight:600;color:var(--tm);'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

        if (challenge.challenge_type === 'individual_consistency') {
            // Indicador "cumple" / "le faltan X"
            var kmOk = row.km >= minKmInd;
            var secOk = (minSecInd === null || row.sessions >= minSecInd);
            if (kmOk && secOk) {
                subEl.style.color = '#10b981';
                subEl.textContent = '✓ Cumple el mínimo';
            } else {
                var parts = [];
                if (!kmOk) parts.push('faltan ' + (minKmInd - row.km).toFixed(1) + ' km');
                if (!secOk) parts.push('faltan ' + (minSecInd - row.sessions) + ' sesiones');
                subEl.style.color = noContrib ? 'var(--tm)' : '#c4881e';
                subEl.textContent = parts.join(' · ');
            }
        } else {
            if (row.hasContrib) {
                var ses = Math.floor(row.sessions);
                subEl.textContent = ses + ' ' + (ses === 1 ? 'sesión' : 'sesiones');
            } else {
                subEl.style.color = 'var(--tm)';
                subEl.textContent = 'Sin aportes aún';
            }
        }
        nameCol.appendChild(subEl);

        // Valor (km o sesiones según tipo) + porcentaje individual
        var valCol = document.createElement('div');
        valCol.style.cssText = 'text-align:right;flex-shrink:0;display:flex;flex-direction:column;gap:2px;';
        var valEl = document.createElement('div');
        valEl.style.cssText = 'font-size:14px;font-weight:900;color:var(--tw);line-height:1.1;';
        if (challenge.challenge_type === 'collective_sessions') {
            valEl.textContent = Math.floor(row.sessions) + ' ses.';
        } else {
            valEl.textContent = row.km.toFixed(1) + ' km';
        }
        var indPct = document.createElement('div');
        indPct.style.cssText = 'font-size:10px;font-weight:700;color:var(--tm);';
        // % individual del aporte sobre el objetivo (solo para colectivos)
        if (challenge.challenge_type === 'collective_distance' && globalTarget > 0) {
            var p = Math.round((row.km / globalTarget) * 100);
            indPct.textContent = p + '% del objetivo';
        } else if (challenge.challenge_type === 'collective_sessions' && globalTarget > 0) {
            var p2 = Math.round((row.sessions / globalTarget) * 100);
            indPct.textContent = p2 + '% del objetivo';
        } else {
            indPct.textContent = ''; // en consistency lo sustituye subEl
        }
        valCol.appendChild(valEl);
        if (indPct.textContent) valCol.appendChild(indPct);

        rowEl.appendChild(posEl);
        rowEl.appendChild(av);
        rowEl.appendChild(nameCol);
        rowEl.appendChild(valCol);
        rankSection.appendChild(rowEl);
    });

    wrap.appendChild(rankSection);

    // ── Acciones owner: Cancelar / Eliminar ──
    if (amOwner) {
        var actions = document.createElement('div');
        actions.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:10px;';

        // Solo permitimos Cancelar si sigue activo
        if (challenge.status === 'active') {
            var cancelBtn = document.createElement('button');
            cancelBtn.style.cssText = 'height:46px;border-radius:23px;'
                + 'border:1.5px solid rgba(239,68,68,.4);background:transparent;color:#ef4444;'
                + 'font-family:var(--f);font-size:13px;font-weight:800;letter-spacing:.3px;cursor:pointer;';
            cancelBtn.textContent = 'Cancelar reto';
            cancelBtn.onclick = async function() {
                var ok1 = confirm('¿Cancelar el reto «' + (challenge.title || '') + '»?\n\n'
                    + 'Se marcará como cancelado y aparecerá en el histórico.');
                if (!ok1) return;
                var ok2 = confirm('Esta acción no se puede deshacer. ¿Seguro?');
                if (!ok2) return;
                try {
                    var { error } = await sb.from('crew_challenges')
                        .update({ status: 'cancelled' })
                        .eq('id', challenge.id);
                    if (error) {
                        console.error('[MR] cancel challenge failed:', error);
                        showToast('No se pudo cancelar el reto', 2400);
                        return;
                    }
                    showToast('Reto cancelado', 2200);
                    // Cerrar modal y repintar tab
                    backBtn.click();
                    var ovDetail = document.getElementById('crew-detail-view');
                    if (ovDetail && ovDetail.dataset.crewId === crew.id && ovDetail.dataset.activeTab === 'challenges') {
                        var tabBtn = ovDetail.querySelector('button[data-tab="challenges"]');
                        if (tabBtn) tabBtn.click();
                    }
                } catch(e) {
                    console.error('[MR] cancel challenge error:', e);
                    showToast('No se pudo cancelar el reto', 2400);
                }
            };
            actions.appendChild(cancelBtn);
        }

        // Eliminar (doble confirm con escritura del nombre)
        var deleteBtn = document.createElement('button');
        deleteBtn.style.cssText = 'height:42px;border-radius:21px;'
            + 'border:none;background:transparent;color:var(--tm);'
            + 'font-family:var(--f);font-size:12px;font-weight:700;letter-spacing:.3px;cursor:pointer;'
            + 'text-decoration:underline;text-underline-offset:3px;';
        deleteBtn.textContent = 'Eliminar reto permanentemente';
        deleteBtn.onclick = async function() {
            var ok1 = confirm('¿Eliminar permanentemente el reto «' + (challenge.title || '') + '»?\n\n'
                + 'Se borrará de la base de datos y desaparecerá del histórico.');
            if (!ok1) return;
            var typed = prompt('Para confirmar, escribe el título del reto:\n\n' + (challenge.title || ''));
            if (typed === null) return;
            // Normalizar: trim + colapsar espacios múltiples + lowercase (más tolerante)
            function _norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
            if (_norm(typed) !== _norm(challenge.title)) {
                showToast('El título no coincide. Reto no eliminado.', 2800);
                return;
            }
            try {
                var { error } = await sb.from('crew_challenges').delete().eq('id', challenge.id);
                if (error) {
                    console.error('[MR] delete challenge failed:', error);
                    showToast('No se pudo eliminar el reto', 2400);
                    return;
                }
                showToast('Reto eliminado', 2200);
                backBtn.click();
                var ovDetail2 = document.getElementById('crew-detail-view');
                if (ovDetail2 && ovDetail2.dataset.crewId === crew.id && ovDetail2.dataset.activeTab === 'challenges') {
                    var tabBtn2 = ovDetail2.querySelector('button[data-tab="challenges"]');
                    if (tabBtn2) tabBtn2.click();
                }
            } catch(e) {
                console.error('[MR] delete challenge error:', e);
                showToast('No se pudo eliminar el reto', 2400);
            }
        };
        actions.appendChild(deleteBtn);

        wrap.appendChild(actions);
    }

    bodyEl.appendChild(wrap);
}
window.openCrewChallengeDetail = openCrewChallengeDetail;

// ── Expulsar miembro del crew (sólo owner) ───────────────────────
async function _kickCrewMember(crew, profile) {
    var sb = window._sbClient;
    var ok = confirm('¿Expulsar a ' + (profile.display_name || profile.username || 'este runner') + ' de "' + crew.name + '"?');
    if (!ok) return;
    try {
        var { error } = await sb.from('crew_members')
            .delete()
            .eq('crew_id', crew.id)
            .eq('user_id', profile.id);
        if (error) throw error;
        // Refrescar tab Miembros si está abierto
        var view = document.getElementById('crew-detail-view');
        if (view && view.dataset.activeTab === 'members') {
            // Re-disparar el tab clic para repintar
            var tabBtn = view.querySelector('button[data-tab="members"]');
            if (tabBtn) tabBtn.click();
        }
    } catch (e) {
        console.error('[MR] kick member failed:', e);
        alert('No se pudo expulsar.\n' + (e.message || e));
    }
}
window._kickCrewMember = _kickCrewMember;

// ── Salir del crew (sólo miembros no-owner) ──────────────────────
async function _leaveCrew(crew) {
    var sb = window._sbClient;
    var ok = confirm('¿Salir del crew "' + crew.name + '"?\nDejarás de ver sus posts.');
    if (!ok) return;
    try {
        var { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error('No session');
        var myId = session.user.id;
        var { error } = await sb.from('crew_members')
            .delete()
            .eq('crew_id', crew.id)
            .eq('user_id', myId);
        if (error) throw error;
        // Refrescar Sets globales y cerrar el detalle
        if (typeof _refreshMyCrews === 'function') await _refreshMyCrews();
        var view = document.getElementById('crew-detail-view');
        if (view) {
            view.style.transform = 'translateX(100%)';
            setTimeout(function() { view.remove(); }, 320);
        }
        // Repintar la vista de crews que esté abierta
        if (typeof _refreshCrewsListIfVisible === 'function') _refreshCrewsListIfVisible();
    } catch (e) {
        console.error('[MR] leave crew failed:', e);
        alert('No se pudo salir del crew.\n' + (e.message || e));
    }
}
window._leaveCrew = _leaveCrew;

// ── MODAL DE INVITAR A UN CREW ─────────────────────────────────────
// Dos sub-pestañas: "Buscar" (por username via RPC) y "Seguidos"
// (atajo desde la gente que sigo). Cada fila lleva un botón Invitar
// que inserta una fila en crew_invites con status='pending'.
async function openCrewInviteModal(crew) {
    if (!crew || !crew.id) return;
    if (document.getElementById('crew-invite-modal')) return;
    var sb = window._sbClient;

    var { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    var myId = session.user.id;

    // Backdrop
    var bk = document.createElement('div');
    bk.id = 'crew-invite-modal';
    bk.style.cssText = 'position:fixed;inset:0;z-index:20025;background:rgba(0,0,0,.55);'
        + 'display:flex;align-items:flex-end;justify-content:center;'
        + 'opacity:0;transition:opacity .22s ease;';

    // Sheet desde abajo (estilo mobile)
    var sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:480px;background:var(--bg);'
        + 'border-radius:20px 20px 0 0;padding:14px 16px 22px;'
        + 'display:flex;flex-direction:column;gap:12px;max-height:88vh;'
        + 'box-shadow:0 -8px 30px rgba(0,0,0,.35);'
        + 'transform:translateY(40px);transition:transform .28s cubic-bezier(.32,.72,0,1);';

    // Handle visual de drag (no funcional, sólo affordance)
    var handle = document.createElement('div');
    handle.style.cssText = 'width:42px;height:4px;border-radius:2px;background:var(--border);margin:2px auto 4px;';

    // Cabecera
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;';
    head.innerHTML =
        '<div style="width:34px;height:34px;border-radius:50%;background:var(--silver-grad);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
          + '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>'
          + '<line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'
          + '</svg>'
        + '</div>'
        + '<div style="flex:1;">'
          + '<div style="font-size:16px;font-weight:800;color:var(--tw);">Invitar a "' + (crew.name || 'Crew') + '"</div>'
          + '<div style="font-size:11px;color:var(--tm);">Los invitados verán tu invitación pendiente</div>'
        + '</div>';
    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:none;background:var(--card);cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    head.appendChild(closeBtn);

    // Tabs Buscar / Seguidos
    var tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:6px;background:var(--card);padding:4px;border-radius:12px;';
    function makeSubTab(id, label) {
        var b = document.createElement('button');
        b.dataset.tab = id;
        b.style.cssText = 'flex:1;height:32px;border:none;border-radius:9px;cursor:pointer;'
            + 'font-family:var(--f);font-size:12px;font-weight:700;letter-spacing:.2px;'
            + 'background:transparent;color:var(--tm);transition:background .15s, color .15s;';
        b.textContent = label;
        return b;
    }
    var tabSearch  = makeSubTab('search',  'Buscar');
    var tabFollows = makeSubTab('follows', 'Seguidos');
    tabsRow.appendChild(tabSearch);
    tabsRow.appendChild(tabFollows);

    // Input de búsqueda (sólo visible en tab Buscar)
    var searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'display:flex;align-items:center;gap:8px;padding:0 12px;'
        + 'background:var(--card);border:1.5px solid var(--border);border-radius:12px;height:42px;';
    searchWrap.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Username (ej. alvaro)';
    searchInput.style.cssText = 'flex:1;border:none;background:transparent;outline:none;'
        + 'color:var(--tw);font-family:var(--f);font-size:14px;font-weight:600;';
    searchWrap.appendChild(searchInput);

    // Contenedor de resultados (cambia entre Buscar y Seguidos)
    var results = document.createElement('div');
    results.style.cssText = 'min-height:200px;max-height:50vh;overflow-y:auto;'
        + 'display:flex;flex-direction:column;gap:8px;padding-right:2px;';

    // Estado para no duplicar invitaciones en la misma sesión:
    // tras pulsar Invitar, marcamos el ID localmente y deshabilitamos el botón.
    var invitedLocal = new Set();

    // ─── Lógica de renderizado de una fila de candidato ───
    function buildRow(user) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;'
            + 'background:var(--card);border:1px solid var(--border);border-radius:12px;';
        var av = document.createElement('div');
        av.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--crimson);'
            + 'display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;'
            + 'overflow:hidden;flex-shrink:0;';
        if (user.avatar_url) {
            var img = document.createElement('img');
            img.src = user.avatar_url; img.loading = 'lazy';
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            av.appendChild(img);
        } else {
            av.textContent = (user.display_name || user.username || '?')[0].toUpperCase();
        }
        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        var nm = document.createElement('div');
        nm.style.cssText = 'font-size:13.5px;font-weight:800;color:var(--tw);'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nm.textContent = user.display_name || user.username || '?';
        info.appendChild(nm);

        var btn = document.createElement('button');
        btn.style.cssText = 'height:32px;padding:0 14px;border-radius:16px;'
            + 'background:var(--silver-grad);color:#fff;border:none;cursor:pointer;'
            + 'font-family:var(--f);font-size:11.5px;font-weight:800;letter-spacing:.3px;flex-shrink:0;';
        btn.textContent = 'Invitar';

        if (invitedLocal.has(user.id)) {
            btn.disabled = true;
            btn.style.opacity = '.5';
            btn.style.cursor = 'default';
            btn.textContent = 'Invitado';
        }

        btn.onclick = async function() {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.style.opacity = '.6';
            btn.textContent = 'Enviando…';
            try {
                var { error } = await sb.from('crew_invites').insert({
                    crew_id: crew.id,
                    invited_user_id: user.id,
                    invited_by: myId
                });
                if (error) throw error;
                invitedLocal.add(user.id);
                btn.textContent = '✓ Invitado';
                btn.style.opacity = '.7';
                btn.style.cursor = 'default';
                if (typeof showToast === 'function') {
                    showToast('Invitación enviada a ' + (user.display_name || user.username), 2000);
                }
            } catch (e) {
                console.error('[MR] invite failed:', e);
                // Si ya existía una invitación pendiente (UNIQUE constraint), tratarlo como éxito
                if (e && (e.code === '23505' || /duplicate/i.test(e.message || ''))) {
                    invitedLocal.add(user.id);
                    btn.textContent = '✓ Invitado';
                    btn.style.opacity = '.7';
                    btn.style.cursor = 'default';
                } else {
                    alert('No se pudo enviar la invitación.\n' + (e.message || e));
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = 'Invitar';
                }
            }
        };

        row.appendChild(av);
        row.appendChild(info);
        row.appendChild(btn);
        return row;
    }

    // ─── Tab "Buscar" ───
    var _searchTimer = null;
    function runSearch(q) {
        q = (q || '').trim();
        results.innerHTML = '';
        if (q.length < 2) {
            results.innerHTML = '<div style="text-align:center;padding:30px 20px;color:var(--tm);font-size:12px;line-height:1.5;">'
                + 'Escribe al menos 2 letras<br><span style="opacity:.6;">Aparecen runners que aún no son miembros ni tienen invitación pendiente</span>'
                + '</div>';
            return;
        }
        results.innerHTML = '<div style="text-align:center;padding:20px;color:var(--tm);font-size:12px;">Buscando…</div>';
        sb.rpc('search_users_for_crew_invite', { _crew_id: crew.id, _query: q })
          .then(function(r) {
            if (r.error) throw r.error;
            var users = r.data || [];
            results.innerHTML = '';
            if (!users.length) {
                results.innerHTML = '<div style="text-align:center;padding:30px 20px;color:var(--tm);font-size:12px;">Sin resultados para "' + q + '"</div>';
                return;
            }
            users.forEach(function(u) { results.appendChild(buildRow(u)); });
          })
          .catch(function(e) {
            console.error('[MR] invite search failed:', e);
            results.innerHTML = '<div style="text-align:center;padding:30px;color:var(--danger);font-size:12px;">Error al buscar.</div>';
          });
    }

    // ─── Tab "Seguidos" ───
    async function loadFollows() {
        results.innerHTML = '<div style="text-align:center;padding:20px;color:var(--tm);font-size:12px;">Cargando…</div>';
        try {
            // A quién sigo
            var { data: followsData, error: fErr } = await sb.from('follows')
                .select('following_id')
                .eq('follower_id', myId);
            if (fErr) throw fErr;
            var followIds = (followsData || []).map(function(r) { return r.following_id; });
            if (!followIds.length) {
                results.innerHTML = '<div style="text-align:center;padding:30px 20px;color:var(--tm);font-size:12px;line-height:1.5;">'
                    + 'No sigues a nadie aún<br><span style="opacity:.6;">Sigue a runners desde el Club para invitarlos más rápido</span>'
                    + '</div>';
                return;
            }
            // Excluir miembros actuales del crew y gente con invitación pendiente
            var { data: mem } = await sb.from('crew_members').select('user_id').eq('crew_id', crew.id);
            var memberSet = new Set((mem || []).map(function(m) { return m.user_id; }));
            var { data: pend } = await sb.from('crew_invites')
                .select('invited_user_id').eq('crew_id', crew.id).eq('status', 'pending');
            var pendSet = new Set((pend || []).map(function(p) { return p.invited_user_id; }));
            var elegibles = followIds.filter(function(id) {
                return !memberSet.has(id) && !pendSet.has(id);
            });
            if (!elegibles.length) {
                results.innerHTML = '<div style="text-align:center;padding:30px 20px;color:var(--tm);font-size:12px;">'
                    + 'Ya invitaste a todos los que sigues, o ya son miembros 🙌'
                    + '</div>';
                return;
            }
            // Cargar profiles en bloque
            var { data: profs, error: pErr } = await sb.from('profiles')
                .select('id, username, display_name, avatar_url')
                .in('id', elegibles);
            if (pErr) throw pErr;
            results.innerHTML = '';
            (profs || []).sort(function(a, b) {
                var an = (a.display_name || a.username || '');
                var bn = (b.display_name || b.username || '');
                return an.localeCompare(bn);
            }).forEach(function(u) { results.appendChild(buildRow(u)); });
        } catch (e) {
            console.error('[MR] follows load failed:', e);
            results.innerHTML = '<div style="text-align:center;padding:30px;color:var(--danger);font-size:12px;">No se pudieron cargar tus seguidos.</div>';
        }
    }

    // ─── Cambio de sub-tab ───
    function setSubTab(name) {
        [tabSearch, tabFollows].forEach(function(b) {
            var active = b.dataset.tab === name;
            b.style.background = active ? 'var(--silver-grad)' : 'transparent';
            b.style.color = active ? '#fff' : 'var(--tm)';
            b.style.fontWeight = active ? '800' : '700';
        });
        if (name === 'search') {
            searchWrap.style.display = 'flex';
            runSearch(searchInput.value);
            setTimeout(function() { searchInput.focus(); }, 60);
        } else {
            searchWrap.style.display = 'none';
            loadFollows();
        }
    }
    tabSearch.onclick  = function() { setSubTab('search'); };
    tabFollows.onclick = function() { setSubTab('follows'); };

    // Debounce del input
    searchInput.oninput = function() {
        clearTimeout(_searchTimer);
        var v = searchInput.value;
        _searchTimer = setTimeout(function() { runSearch(v); }, 280);
    };

    // Cerrar
    function closeMe() {
        bk.style.opacity = '0';
        sheet.style.transform = 'translateY(40px)';
        setTimeout(function() { bk.remove(); }, 240);
        // Tras cerrar el modal, repintar tab Miembros si está abierto
        // (por si invitamos y refrescamos contadores futuros)
        var view = document.getElementById('crew-detail-view');
        if (view && view.dataset.activeTab === 'members') {
            var t = view.querySelector('button[data-tab="members"]');
            if (t) t.click();
        }
    }
    closeBtn.onclick = closeMe;
    bk.onclick = function(e) { if (e.target === bk) closeMe(); };

    // Montar
    sheet.appendChild(handle);
    sheet.appendChild(head);
    sheet.appendChild(tabsRow);
    sheet.appendChild(searchWrap);
    sheet.appendChild(results);
    bk.appendChild(sheet);
    document.body.appendChild(bk);
    requestAnimationFrame(function() {
        bk.style.opacity = '1';
        sheet.style.transform = 'translateY(0)';
    });

    // Estado inicial: tab Buscar
    setSubTab('search');
}
window.openCrewInviteModal = openCrewInviteModal;

// ── SELECTOR DE DESTINOS AL PUBLICAR ──────────────────────────────
// Muestra un bottom sheet con checklist: "Club público" + cada crew
// del que soy miembro. Devuelve una Promise con un objeto:
//   { toPublic: boolean, crewIds: string[] }
// El caller decide cuántos inserts hacer (1 por destino).
// Si el usuario cierra sin confirmar, resuelve con null.
function pickPublishDestinations(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
        // Refrescamos para tener crews actualizados (no bloqueante si falla)
        Promise.resolve(
            typeof _refreshMyCrews === 'function' ? _refreshMyCrews() : null
        ).finally(function() {
            var crews = (typeof getMyCrews === 'function') ? getMyCrews() : [];

            // NOTA: ya NO usamos shortcut si no hay crews — siempre mostramos
            // el modal para que el usuario pueda etiquetar runners ('👥 Etiquetar').

            // Estado: por defecto solo Club público marcado
            var toPublic = true;
            var selectedCrewIds = new Set();
            var selectedTaggedIds = new Set();   // IDs de runners etiquetados
            var taggedProfiles = [];             // [{id, username, avatar_url}, ...]

            // ─── Backdrop + sheet ───
            var bk = document.createElement('div');
            // El z-index debe estar por encima de cualquier otro modal:
            // el heatmap overlay vive en 99999, así que vamos a 100001.
            bk.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);'
                + 'display:flex;align-items:flex-end;justify-content:center;'
                + 'opacity:0;transition:opacity .22s ease;';
            var sheet = document.createElement('div');
            sheet.style.cssText = 'width:100%;max-width:480px;background:var(--bg);'
                + 'border-radius:20px 20px 0 0;padding:14px 16px 22px;'
                + 'display:flex;flex-direction:column;gap:12px;max-height:88vh;'
                + 'box-shadow:0 -8px 30px rgba(0,0,0,.35);'
                + 'transform:translateY(40px);transition:transform .28s cubic-bezier(.32,.72,0,1);';
            var handle = document.createElement('div');
            handle.style.cssText = 'width:42px;height:4px;border-radius:2px;background:var(--border);margin:2px auto 4px;';

            // ─── Cabecera ───
            var head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:flex-start;gap:10px;';
            var headIcon = document.createElement('div');
            headIcon.style.cssText = 'width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#c4881e,#e8a825);'
                + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
            headIcon.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
            var headText = document.createElement('div');
            headText.style.cssText = 'flex:1;';
            headText.innerHTML = '<div style="font-size:16px;font-weight:800;color:var(--tw);">¿Dónde compartir?</div>'
                + '<div style="font-size:11px;color:var(--tm);margin-top:1px;">Marca uno o varios destinos</div>';
            var closeBtn = document.createElement('button');
            closeBtn.setAttribute('aria-label', 'Cancelar');
            closeBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:none;background:var(--card);cursor:pointer;'
                + 'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
            closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            head.appendChild(headIcon);
            head.appendChild(headText);
            head.appendChild(closeBtn);

            // ─── Lista de checkboxes ───
            var list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow-y:auto;';

            // Confirm button (lo referencio aquí para poder actualizarlo desde las rows)
            var confirmBtn = document.createElement('button');

            function updateConfirmState() {
                var n = (toPublic ? 1 : 0) + selectedCrewIds.size;
                if (n === 0) {
                    confirmBtn.disabled = true;
                    confirmBtn.style.opacity = '.45';
                    confirmBtn.style.cursor = 'not-allowed';
                    confirmBtn.textContent = 'Marca un destino';
                } else {
                    confirmBtn.disabled = false;
                    confirmBtn.style.opacity = '1';
                    confirmBtn.style.cursor = 'pointer';
                    confirmBtn.textContent = n === 1 ? 'Compartir' : ('Compartir en ' + n + ' sitios');
                }
            }

            // Fila reusable de destino
            function buildDestRow(opts) {
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:11px;padding:11px 12px;'
                    + 'background:var(--card);border:1.5px solid var(--border);border-radius:13px;cursor:pointer;'
                    + 'transition:border-color .15s ease, background .15s ease;';
                var av = document.createElement('div');
                av.style.cssText = 'width:38px;height:38px;border-radius:' + (opts.isPublic ? '50%' : '12px') + ';'
                    + 'background:' + opts.bg + ';display:flex;align-items:center;justify-content:center;'
                    + 'color:#fff;font-size:14px;font-weight:800;overflow:hidden;flex-shrink:0;';
                if (opts.avatarUrl) {
                    var img = document.createElement('img');
                    img.src = opts.avatarUrl; img.loading = 'lazy';
                    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                    av.appendChild(img);
                } else if (opts.iconSvg) {
                    av.innerHTML = opts.iconSvg;
                } else {
                    av.textContent = (opts.label || '?')[0].toUpperCase();
                }
                var info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;';
                var ttl = document.createElement('div');
                ttl.style.cssText = 'font-size:14px;font-weight:800;color:var(--tw);'
                    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                ttl.textContent = opts.label;
                info.appendChild(ttl);
                if (opts.sub) {
                    var sb2 = document.createElement('div');
                    sb2.style.cssText = 'font-size:10.5px;color:var(--tm);margin-top:1px;';
                    sb2.textContent = opts.sub;
                    info.appendChild(sb2);
                }
                // Checkbox visual a la derecha
                var cb = document.createElement('div');
                cb.style.cssText = 'width:24px;height:24px;border-radius:7px;'
                    + 'border:2px solid var(--border);background:transparent;flex-shrink:0;'
                    + 'display:flex;align-items:center;justify-content:center;transition:all .15s ease;';
                cb.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="opacity:0;transition:opacity .15s ease;"><polyline points="20 6 9 17 4 12"/></svg>';

                function setVisualChecked(on) {
                    if (on) {
                        row.style.borderColor = opts.checkedColor;
                        row.style.background = opts.checkedBg;
                        cb.style.background = opts.checkedColor;
                        cb.style.borderColor = opts.checkedColor;
                        cb.firstChild.style.opacity = '1';
                    } else {
                        row.style.borderColor = 'var(--border)';
                        row.style.background = 'var(--card)';
                        cb.style.background = 'transparent';
                        cb.style.borderColor = 'var(--border)';
                        cb.firstChild.style.opacity = '0';
                    }
                }
                setVisualChecked(opts.initialChecked);

                row.onclick = function() {
                    opts.onToggle(function(nowChecked) {
                        setVisualChecked(nowChecked);
                        updateConfirmState();
                    });
                };

                row.appendChild(av);
                row.appendChild(info);
                row.appendChild(cb);
                return row;
            }

            // 1) Club público
            list.appendChild(buildDestRow({
                isPublic: true,
                label: 'Club público',
                sub: 'Visible para todos tus seguidores',
                bg: 'linear-gradient(135deg,#c4881e,#e8a825)',
                iconSvg: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
                checkedColor: '#c4881e',
                checkedBg: 'rgba(196,136,30,.10)',
                initialChecked: true,
                onToggle: function(applyVisual) {
                    toPublic = !toPublic;
                    applyVisual(toPublic);
                }
            }));

            // 2) Cada crew
            crews.forEach(function(c) {
                list.appendChild(buildDestRow({
                    isPublic: false,
                    label: c.name || 'Crew',
                    sub: c.role === 'owner' ? 'Propietario' : (c.role === 'admin' ? 'Admin' : 'Miembro'),
                    bg: 'var(--silver-grad)',
                    avatarUrl: c.avatar_url || null,
                    checkedColor: 'var(--silver)',
                    checkedBg: 'var(--silver-tint)',
                    initialChecked: false,
                    onToggle: function(applyVisual) {
                        if (selectedCrewIds.has(c.id)) {
                            selectedCrewIds.delete(c.id);
                            applyVisual(false);
                        } else {
                            selectedCrewIds.add(c.id);
                            applyVisual(true);
                        }
                    }
                }));
            });

            // ─── Bloque "Etiquetar runners" ───
            var tagSection = document.createElement('div');
            tagSection.style.cssText = 'display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bsoft);padding-top:10px;margin-top:2px;';
            var tagBtn = document.createElement('button');
            tagBtn.style.cssText = 'display:flex;align-items:center;gap:11px;padding:10px 12px;'
                + 'background:var(--card);border:1.5px dashed var(--border);border-radius:13px;cursor:pointer;'
                + 'transition:border-color .15s ease, background .15s ease;font-family:var(--f);text-align:left;width:100%;';
            function renderTagBtn() {
                if (selectedTaggedIds.size === 0) {
                    tagBtn.style.borderStyle = 'dashed';
                    tagBtn.style.borderColor = 'var(--border)';
                    tagBtn.style.background = 'var(--card)';
                    tagBtn.innerHTML = '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#7c3aed);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'
                        + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
                        + '</div>'
                        + '<div style="flex:1;min-width:0;">'
                        +   '<div style="font-size:14px;font-weight:800;color:var(--tw);">Etiquetar runners</div>'
                        +   '<div style="font-size:10.5px;color:var(--tm);margin-top:1px;">Si has corrido con alguien</div>'
                        + '</div>'
                        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2.4" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';
                } else {
                    tagBtn.style.borderStyle = 'solid';
                    tagBtn.style.borderColor = '#a855f7';
                    tagBtn.style.background = 'rgba(168,85,247,.08)';
                    // Render avatares apilados
                    var stack = '<div style="display:flex;align-items:center;flex-shrink:0;">';
                    var maxShown = 3;
                    taggedProfiles.slice(0, maxShown).forEach(function(p, idx) {
                        var off = idx * -10;
                        if (p.avatar_url) {
                            stack += '<div style="width:30px;height:30px;border-radius:50%;border:2px solid var(--bg);overflow:hidden;margin-left:'+(idx===0?0:off)+'px;flex-shrink:0;"><img src="'+p.avatar_url+'" loading="lazy" style="width:100%;height:100%;object-fit:cover;"></div>';
                        } else {
                            stack += '<div style="width:30px;height:30px;border-radius:50%;background:var(--crimson);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg);margin-left:'+(idx===0?0:off)+'px;flex-shrink:0;">'+(p.display_name||p.username||'?')[0].toUpperCase()+'</div>';
                        }
                    });
                    if (taggedProfiles.length > maxShown) {
                        stack += '<div style="width:30px;height:30px;border-radius:50%;background:#a855f7;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg);margin-left:-10px;flex-shrink:0;">+'+(taggedProfiles.length-maxShown)+'</div>';
                    }
                    stack += '</div>';
                    var summary = taggedProfiles.length === 1
                        ? (taggedProfiles[0].display_name || taggedProfiles[0].username || '?')
                        : taggedProfiles.length + ' etiquetados';
                    tagBtn.innerHTML = stack
                        + '<div style="flex:1;min-width:0;">'
                        +   '<div style="font-size:14px;font-weight:800;color:var(--tw);">' + summary + '</div>'
                        +   '<div style="font-size:10.5px;color:#a855f7;margin-top:1px;font-weight:700;">Toca para editar</div>'
                        + '</div>'
                        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.4" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';
                }
            }
            renderTagBtn();
            tagBtn.onclick = async function() {
                var result = await _openTagRunnersModal(taggedProfiles.slice());
                if (result) {
                    taggedProfiles = result;
                    selectedTaggedIds = new Set(result.map(function(p){ return p.id; }));
                    renderTagBtn();
                }
            };
            tagSection.appendChild(tagBtn);

            // ─── Botón confirmar ───
            confirmBtn.style.cssText = 'height:46px;border-radius:23px;border:none;cursor:pointer;'
                + 'background:linear-gradient(135deg,#c4881e,#e8a825);color:#000;'
                + 'font-family:var(--f);font-size:14px;font-weight:800;letter-spacing:.3px;margin-top:4px;'
                + 'box-shadow:0 3px 10px rgba(196,136,30,.25);'
                + 'transition:opacity .15s ease;';
            updateConfirmState();

            function closeMe(result) {
                bk.style.opacity = '0';
                sheet.style.transform = 'translateY(40px)';
                setTimeout(function() { bk.remove(); resolve(result); }, 240);
            }
            closeBtn.onclick = function() { closeMe(null); };
            bk.onclick = function(e) { if (e.target === bk) closeMe(null); };
            confirmBtn.onclick = function() {
                if (confirmBtn.disabled) return;
                closeMe({ toPublic: toPublic, crewIds: Array.from(selectedCrewIds), taggedUserIds: Array.from(selectedTaggedIds) });
            };

            // Montaje
            sheet.appendChild(handle);
            sheet.appendChild(head);
            sheet.appendChild(list);
            sheet.appendChild(tagSection);
            sheet.appendChild(confirmBtn);
            bk.appendChild(sheet);
            document.body.appendChild(bk);
            requestAnimationFrame(function() {
                bk.style.opacity = '1';
                sheet.style.transform = 'translateY(0)';
            });
        });
    });
}
window.pickPublishDestinations = pickPublishDestinations;

/* ───────────────────────────────────────────────────────────────────
   Modal de selección de runners para etiquetar
   - Lista de seguidos del usuario actual
   - Search incremental en la cabecera
   - Tap para marcar/desmarcar
   - Devuelve array de perfiles seleccionados o null si cancela
   ─────────────────────────────────────────────────────────────────── */
function _openTagRunnersModal(initialSelected) {
    initialSelected = initialSelected || [];
    return new Promise(async function(resolve) {
        var sb = window._sbClient;
        var { data: { session } } = await sb.auth.getSession();
        if (!session) { resolve(null); return; }
        var myId = session.user.id;

        // Backdrop + sheet
        var bk = document.createElement('div');
        bk.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);'
            + 'display:flex;align-items:flex-end;justify-content:center;'
            + 'opacity:0;transition:opacity .22s ease;';
        var sheet = document.createElement('div');
        sheet.style.cssText = 'width:100%;max-width:480px;background:var(--bg);'
            + 'border-radius:20px 20px 0 0;padding:14px 16px 22px;display:flex;flex-direction:column;gap:10px;'
            + 'height:85vh;max-height:85vh;box-shadow:0 -8px 30px rgba(0,0,0,.35);'
            + 'transform:translateY(40px);transition:transform .28s cubic-bezier(.32,.72,0,1);';

        var handle = document.createElement('div');
        handle.style.cssText = 'width:42px;height:4px;border-radius:2px;background:var(--border);margin:2px auto 4px;flex-shrink:0;';
        sheet.appendChild(handle);

        // Cabecera
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:10px;flex-shrink:0;';
        var headIcon = document.createElement('div');
        headIcon.style.cssText = 'width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#7c3aed);display:flex;align-items:center;justify-content:center;flex-shrink:0;';
        headIcon.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        var headText = document.createElement('div');
        headText.style.cssText = 'flex:1;';
        var headTitle = document.createElement('div');
        headTitle.style.cssText = 'font-size:16px;font-weight:800;color:var(--tw);';
        headTitle.textContent = 'Etiquetar runners';
        var headSub = document.createElement('div');
        headSub.id = 'tag-sub-count';
        headSub.style.cssText = 'font-size:11px;color:var(--tm);margin-top:1px;';
        headText.appendChild(headTitle); headText.appendChild(headSub);
        var closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:none;background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
        closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        head.appendChild(headIcon); head.appendChild(headText); head.appendChild(closeBtn);
        sheet.appendChild(head);

        // Search
        var searchWrap = document.createElement('div');
        searchWrap.style.cssText = 'position:relative;flex-shrink:0;';
        var searchInput = document.createElement('input');
        searchInput.type = 'text'; searchInput.placeholder = 'Buscar entre los que sigues…';
        searchInput.style.cssText = 'width:100%;height:42px;padding:0 14px 0 38px;border-radius:21px;'
            + 'background:var(--card);border:1.5px solid var(--border);font-family:var(--f);font-size:13.5px;color:var(--tw);outline:none;box-sizing:border-box;';
        var searchIcon = document.createElement('span');
        searchIcon.style.cssText = 'position:absolute;left:14px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--tm);';
        searchIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
        searchWrap.appendChild(searchInput); searchWrap.appendChild(searchIcon);
        sheet.appendChild(searchWrap);

        // Lista
        var list = document.createElement('div');
        list.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:6px;padding:4px 0;';
        list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:12px;">Cargando…</div>';
        sheet.appendChild(list);

        // Footer
        var footer = document.createElement('div');
        footer.style.cssText = 'flex-shrink:0;display:flex;gap:10px;padding-top:6px;';
        var clearBtn = document.createElement('button');
        clearBtn.style.cssText = 'flex:1;height:44px;border-radius:22px;border:1.5px solid var(--border);background:var(--card);color:var(--tm);font-family:var(--f);font-size:13px;font-weight:700;cursor:pointer;';
        clearBtn.textContent = 'Limpiar';
        var doneBtn = document.createElement('button');
        doneBtn.style.cssText = 'flex:2;height:44px;border-radius:22px;border:none;cursor:pointer;'
            + 'background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;font-family:var(--f);font-size:14px;font-weight:800;letter-spacing:.3px;'
            + 'box-shadow:0 3px 10px rgba(168,85,247,.30);';
        doneBtn.textContent = 'Listo';
        footer.appendChild(clearBtn); footer.appendChild(doneBtn);
        sheet.appendChild(footer);

        bk.appendChild(sheet);
        document.body.appendChild(bk);
        requestAnimationFrame(function() { bk.style.opacity = '1'; sheet.style.transform = 'translateY(0)'; });

        // Estado interno
        var selected = new Map(); // id → profile object
        initialSelected.forEach(function(p) { selected.set(p.id, p); });
        var allProfiles = [];   // perfiles cargados
        function updateSubCount() {
            headSub.textContent = selected.size === 0 ? 'Toca a quien corrió contigo' : selected.size + ' etiquetado' + (selected.size===1?'':'s');
        }
        updateSubCount();

        // Cargar seguidos (con su perfil)
        try {
            var { data: rows } = await sb.from('follows')
                .select('following_id, profiles!follows_following_id_fkey(id, username, display_name, avatar_url)')
                .eq('follower_id', myId);
            allProfiles = (rows || [])
                .map(function(r){ return r.profiles; })
                .filter(function(p){ return p && p.id; })
                .sort(function(a,b){
                    var an = (a.display_name || a.username || '');
                    var bn = (b.display_name || b.username || '');
                    return an.localeCompare(bn);
                });
        } catch(e) { allProfiles = []; }

        function renderList(filterText) {
            var ft = (filterText || '').trim().toLowerCase();
            var filtered = ft ? allProfiles.filter(function(p){
                var hay = ((p.display_name || '') + ' ' + (p.username || '')).toLowerCase();
                return hay.indexOf(ft) >= 0;
            }) : allProfiles;
            list.innerHTML = '';
            if (!filtered.length) {
                list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:12px;line-height:1.5;">'
                    + (ft ? 'Nadie coincide con "' + filterText + '"' : 'Aún no sigues a nadie. Cuando empieces a seguir runners aparecerán aquí.')
                    + '</div>';
                return;
            }
            filtered.forEach(function(p) {
                var row = document.createElement('div');
                var isSel = selected.has(p.id);
                row.style.cssText = 'display:flex;align-items:center;gap:11px;padding:9px 12px;'
                    + 'background:' + (isSel ? 'rgba(168,85,247,.10)' : 'var(--card)') + ';'
                    + 'border:1.5px solid ' + (isSel ? '#a855f7' : 'var(--border)') + ';'
                    + 'border-radius:12px;cursor:pointer;transition:all .15s ease;';
                var av = document.createElement('div');
                av.style.cssText = 'width:36px;height:36px;border-radius:50%;background:var(--crimson);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:800;';
                if (p.avatar_url) { var i = document.createElement('img'); i.src = p.avatar_url; i.loading='lazy'; i.style.cssText='width:100%;height:100%;object-fit:cover;'; av.appendChild(i); }
                else av.textContent = (p.display_name||p.username||'?')[0].toUpperCase();
                var name = document.createElement('div');
                name.style.cssText = 'flex:1;min-width:0;font-size:14px;font-weight:700;color:var(--tw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                name.textContent = p.display_name || p.username || '?';
                var cb = document.createElement('div');
                cb.style.cssText = 'width:24px;height:24px;border-radius:7px;border:2px solid ' + (isSel?'#a855f7':'var(--border)') + ';background:' + (isSel?'#a855f7':'transparent') + ';flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s ease;';
                cb.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="opacity:' + (isSel?'1':'0') + ';transition:opacity .15s ease;"><polyline points="20 6 9 17 4 12"/></svg>';
                row.appendChild(av); row.appendChild(name); row.appendChild(cb);
                (function(_p) {
                    row.onclick = function() {
                        if (selected.has(_p.id)) selected.delete(_p.id);
                        else selected.set(_p.id, _p);
                        updateSubCount();
                        renderList(searchInput.value);
                    };
                })(p);
                list.appendChild(row);
            });
        }
        renderList('');

        searchInput.oninput = function() { renderList(this.value); };

        function closeMe(result) {
            bk.style.opacity = '0';
            sheet.style.transform = 'translateY(40px)';
            setTimeout(function() { bk.remove(); resolve(result); }, 240);
        }
        closeBtn.onclick = function() { closeMe(null); };
        bk.onclick = function(e) { if (e.target === bk) closeMe(null); };
        clearBtn.onclick = function() { selected.clear(); updateSubCount(); renderList(searchInput.value); };
        doneBtn.onclick = function() {
            var out = [];
            selected.forEach(function(p){ out.push(p); });
            closeMe(out);
        };
    });
}
window._openTagRunnersModal = _openTagRunnersModal;

// Helper: inserta el mismo post en N destinos. Si toPublic es true, se
// crea una fila con crew_id NULL. Por cada crewId, otra fila con ese
// crew_id. Devuelve { ok: number, errors: any[] }.
async function _insertPostToDestinations(basePost, destinations) {
    var sb = window._sbClient;
    var ok = 0, errors = [];
    var inserts = [];
    // Si hay etiquetados, los añadimos a basePost (array de UUIDs)
    var taggedIds = (destinations.taggedUserIds && destinations.taggedUserIds.length)
        ? destinations.taggedUserIds : null;
    if (destinations.toPublic) {
        inserts.push(Object.assign({}, basePost, { crew_id: null, tagged_user_ids: taggedIds }));
    }
    (destinations.crewIds || []).forEach(function(cid) {
        inserts.push(Object.assign({}, basePost, { crew_id: cid, tagged_user_ids: taggedIds }));
    });
    // Insertamos en paralelo para reducir latencia
    var results = await Promise.allSettled(inserts.map(function(row) {
        // Fallback: si la columna tagged_user_ids no existe aún, reintentar sin ella
        return sb.from('club_posts').insert(row).then(function(res) {
            if (res.error && (res.error.message || '').toLowerCase().indexOf('tagged_user_ids') >= 0) {
                var clean = Object.assign({}, row); delete clean.tagged_user_ids;
                return sb.from('club_posts').insert(clean);
            }
            return res;
        });
    }));
    results.forEach(function(r) {
        if (r.status === 'fulfilled' && !r.value.error) ok++;
        else errors.push(r.status === 'fulfilled' ? r.value.error : r.reason);
    });
    return { ok: ok, total: inserts.length, errors: errors };
}
window._insertPostToDestinations = _insertPostToDestinations;

// Aplicar/quitar bloqueo o silencio. Refresca sets al terminar.
async function setUserBlockState(targetId, type, on) {
    var sb = window._sbClient;
    try {
        var { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error('No session');
        var myId = session.user.id;
        if (on) {
            // Upsert: si ya existía como otro tipo, sustituimos
            var { error } = await sb.from('user_blocks')
                .upsert({ user_id: myId, target_id: targetId, type: type }, { onConflict: 'user_id,target_id' });
            if (error) throw error;
            // Bloquear implica también dejar de seguir (relación rota en ambos sentidos)
            if (type === 'block') {
                await sb.from('follows').delete().or('and(follower_id.eq.'+myId+',following_id.eq.'+targetId+'),and(follower_id.eq.'+targetId+',following_id.eq.'+myId+')');
            }
        } else {
            var { error: e2 } = await sb.from('user_blocks')
                .delete().eq('user_id', myId).eq('target_id', targetId).eq('type', type);
            if (e2) throw e2;
        }
        await _refreshBlockSets();
        return true;
    } catch (e) {
        console.error('[MR] setUserBlockState:', e);
        alert('No se pudo guardar el cambio. ¿Está creada la tabla user_blocks en Supabase?');
        return false;
    }
}
window.setUserBlockState = setUserBlockState;

async function _refreshUnreadBadge() {
    try {
        const { data: { session } } = await window._sbClient.auth.getSession();
        if (!session) return;
        const { count } = await window._sbClient.from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('to_id', session.user.id).is('read_at', null);
        const btn = document.getElementById('club-btn');
        if (!btn) return;
        // Sumar conversaciones forzadas a "no leído" localmente
        var forcedExtra = (typeof _getForcedUnreadCount === 'function') ? _getForcedUnreadCount() : 0;
        var total = (count || 0) + forcedExtra;
        var badge = btn.querySelector('.club-unread-badge');
        if (total > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'club-unread-badge';
                badge.style.cssText = 'position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:9px;background:var(--crimson);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px;border:2px solid var(--bg);';
                btn.style.position = 'relative';
                btn.appendChild(badge);
            }
            badge.textContent = total > 99 ? '99+' : String(total);
        } else if (badge) {
            badge.remove();
        }
    } catch(e) {}
}

/* ── Open/Close Club ─────────────────────────────────────────────── */
function _setThemeColor(color) {
    var m = document.getElementById('theme-color-meta');
    if (m) m.setAttribute('content', color);
    // Also update the duplicate if exists
    var all = document.querySelectorAll('meta[name="theme-color"]');
    all.forEach(function(el) { el.setAttribute('content', color); });
}

function openClub() {
    _setThemeColor('#c4881e');
    var v = document.getElementById('club-view');
    if (!v) return;
    // Set logo src on first open (idempotent — el navegador cachea el data URL)
    var _logo = document.getElementById('club-header-logo');
    if (_logo && !_logo.src) _logo.src = MR_LOGO;
    // Cerrar el tablón si quedó abierto de una visita anterior — siempre empezamos limpio
    var _board = document.getElementById('club-board-panel');
    if (_board) _board.remove();
    var _bb = document.getElementById('club-board-btn');
    if (_bb) _bb.style.boxShadow = '';
    v.style.display = 'flex';
    requestAnimationFrame(function() { requestAnimationFrame(function() { v.style.transform = 'translateY(0)'; }); });
    // Aplicar estilos de las pestañas (Para ti / Siguiendo / Crews / Récords) según estado guardado
    if (typeof _refreshClubTabStyles === 'function') _refreshClubTabStyles();
    // [FASE 7.B] Refrescar icono del candado de privacidad de PRs
    if (typeof _refreshPrivacyBtn === 'function') _refreshPrivacyBtn();
    // Renderizar según pestaña activa: feed normal, lista de crews o ranking de récords
    var _tabMode = localStorage.getItem(_uk('mr_club_tab')) || 'all';
    if (_tabMode === 'crews' && typeof renderClubCrewsList === 'function') {
        renderClubCrewsList();
    } else if (_tabMode === 'records' && typeof renderClubRecordsRanking === 'function') {
        renderClubRecordsRanking();
    } else {
        renderClubFeed();
    }
    _loadClubHeaderStats();
    _checkClubDots();
    // Marcar "última visita al Club" para que el dot del Home se apague respecto a
    // los retos ya conocidos. Las invitaciones pendientes seguirán encendiéndolo
    // (no caducan solas; el usuario tiene que aceptarlas o rechazarlas).
    try { localStorage.setItem(_uk('mr_last_crew_check'), new Date().toISOString()); } catch(_) {}
    if (typeof _checkHomeCrewDot === 'function') _checkHomeCrewDot();
    _initPTR();
    // Request notification permission if not yet granted
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// ── TABLÓN SEMANAL ─────────────────────────────────────────────────
// Resumen agregado de la semana en curso (lunes 00:00 → domingo 23:59
// hora local). Solo lectura. Se calcula on-demand consultando los posts
// publicados al Club esta semana. No necesita tablas extra ni cron jobs.
function _getWeekStartISO() {
    // Devuelve la fecha ISO (UTC) del lunes de la semana actual a las 00:00
    // según la hora local del usuario. Útil como filtro de Supabase.
    var now = new Date();
    var dow = now.getDay(); // 0=domingo, 1=lunes…
    var daysFromMonday = (dow === 0) ? 6 : (dow - 1);
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday, 0, 0, 0, 0);
    return monday.toISOString();
}

function _fmtWeekRange() {
    // Devuelve "Semana del 12 – 18 may" para el header del tablón
    var now = new Date();
    var dow = now.getDay();
    var daysFromMonday = (dow === 0) ? 6 : (dow - 1);
    var mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday);
    var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    var months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    var dM = mon.getDate(), dS = sun.getDate();
    var mM = months[mon.getMonth()], mS = months[sun.getMonth()];
    return (mM === mS)
        ? ('Semana del ' + dM + ' – ' + dS + ' ' + mS)
        : ('Semana del ' + dM + ' ' + mM + ' – ' + dS + ' ' + mS);
}

async function toggleClubBoard(opts) {
    opts = opts || {};
    var crewId   = opts.crewId   || null;
    var crewName = opts.crewName || null;
    // Contenedor donde insertar el panel: por defecto #club-feed (global).
    // Si nos pasan crewId, insertamos dentro del feed del crew.
    var feed = opts.container
        || (crewId ? document.getElementById('crew-feed-' + crewId) : null)
        || document.getElementById('club-feed');
    if (!feed) return;
    // Identificador único del panel para coexistir global/crew sin pisar
    var panelId = crewId ? ('crew-board-panel-' + crewId) : 'club-board-panel';
    var existing = document.getElementById(panelId);
    if (existing) {
        // Cerrar con animación
        existing.style.maxHeight = '0px';
        existing.style.opacity = '0';
        existing.style.marginBottom = '0px';
        setTimeout(function() { existing.remove(); }, 280);
        // Quitar resalte del botón (puede ser el global o el del detalle del crew)
        var btn = document.getElementById(crewId ? 'crew-board-btn' : 'club-board-btn');
        if (btn) {
            // Restauramos la sombra base de cada uno (el plateado tiene sombra metálica de relieve)
            btn.style.boxShadow = crewId
                ? 'inset 0 -2px 4px rgba(0,0,0,.18),0 2px 6px rgba(80,85,92,.28)'
                : '';
        }
        return;
    }
    // Crear panel con placeholder de carga.
    // Fondo: gradiente metálico premium (más limpio que el muro de ladrillo).
    //   · Dorado para el Club global (combina con el lenguaje dorado)
    //   · Plateado para el Crew (combina con el lenguaje plateado)
    var panel = document.createElement('div');
    panel.id = panelId;
    // Paletas de gradiente
    var THEME = crewId ? {
        // Plateado premium (silver gradient)
        bg: 'linear-gradient(135deg, #b8bcc2 0%, #9aa0a8 35%, #7d828a 65%, #b8bcc2 100%)',
        bgOverlay: 'linear-gradient(180deg, rgba(255,255,255,.18) 0%, transparent 30%, transparent 70%, rgba(0,0,0,.18) 100%)',
        borderColor: 'rgba(93,97,104,.65)',
        innerShadow: 'inset 0 1px 0 rgba(255,255,255,.32), inset 0 -1px 0 rgba(0,0,0,.20)',
        outerShadow: '0 4px 14px rgba(80,85,92,.30)'
    } : {
        // Dorado premium (gold gradient)
        bg: 'linear-gradient(135deg, #e8a825 0%, #c4881e 35%, #8b6210 65%, #e8a825 100%)',
        bgOverlay: 'linear-gradient(180deg, rgba(255,255,255,.20) 0%, transparent 30%, transparent 70%, rgba(0,0,0,.22) 100%)',
        borderColor: 'rgba(143,98,16,.65)',
        innerShadow: 'inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.22)',
        outerShadow: '0 4px 14px rgba(196,136,30,.30)'
    };
    panel.style.cssText = "flex-shrink:0;max-height:0;opacity:0;overflow:hidden;"
        + "transition:max-height .35s ease,opacity .25s ease,margin-bottom .25s ease;"
        + "background:" + THEME.bg + ";"
        + "border:1.5px solid " + THEME.borderColor + ";border-radius:14px;margin-bottom:0;"
        + "box-shadow:" + THEME.innerShadow + "," + THEME.outerShadow + ";"
        + "position:relative;";
    panel.innerHTML = '<div aria-hidden="true" style="position:absolute;inset:0;background:' + THEME.bgOverlay + ';pointer-events:none;border-radius:13px;"></div>'
        + '<div style="padding:24px 20px;text-align:center;color:#fff;font-size:12px;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.35);position:relative;z-index:1;">Cargando el muro…</div>';
    feed.insertBefore(panel, feed.firstChild);
    // Reflow → animar a max-height grande
    requestAnimationFrame(function() {
        panel.style.maxHeight = '900px';
        panel.style.opacity = '1';
        panel.style.marginBottom = '14px';
    });
    var btn2 = document.getElementById(crewId ? 'crew-board-btn' : 'club-board-btn');
    if (btn2) {
        // Glow del color correspondiente para reforzar el contexto visual
        btn2.style.boxShadow = crewId
            ? 'inset 0 -2px 4px rgba(0,0,0,.18),0 0 0 3px rgba(138,143,150,.32),0 2px 8px rgba(80,85,92,.4)'
            : '0 0 0 3px rgba(196,136,30,.25)';
    }
    // Render real
    try {
        var html = await _buildClubBoardHTML({ crewId: crewId, crewName: crewName });
        panel.innerHTML = html;
        // Re-ajustar max-height tras render real (por si el contenido lo necesita)
        requestAnimationFrame(function() { panel.style.maxHeight = panel.scrollHeight + 'px'; });
        // Listener para cerrar con el botón X interno (mismo contexto)
        var closeX = panel.querySelector('[data-board-close]');
        if (closeX) closeX.onclick = function() { toggleClubBoard({ crewId: crewId, crewName: crewName, container: feed }); };
    } catch (e) {
        panel.innerHTML = '<div style="padding:24px 20px;text-align:center;color:var(--tm);font-size:12px;">No se pudo cargar el tablón.</div>';
    }
}

async function _buildClubBoardHTML(opts) {
    opts = opts || {};
    var crewId   = opts.crewId   || null;
    var crewName = opts.crewName || null;
    var sb = window._sbClient;
    var weekStart = _getWeekStartISO();
    // Traer todos los posts de la semana con autor y reacciones.
    // Si hay crewId → solo posts de ese crew.
    // Si NO hay crewId → solo posts públicos (crew_id IS NULL), igual que
    // el feed global, para coherencia (no mezclar privados en stats globales).
    var q = sb
        .from('club_posts')
        .select('id, act_data, created_at, profiles!club_posts_user_id_fkey(id, username, display_name, avatar_url), reactions(id)')
        .gte('created_at', weekStart)
        .order('created_at', { ascending: false });
    if (crewId) q = q.eq('crew_id', crewId);
    else        q = q.is('crew_id', null);
    var { data: posts, error } = await q;
    if (error) throw error;
    posts = posts || [];

    // ── Helpers ───────────────────────────────────────────────
    function fmtKm(v) { return (Math.round(v * 10) / 10).toFixed(1) + ' km'; }
    function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function avatarHTML(u, size, ring) {
        var sz = size || 28;
        var initials = (u.name || '?').charAt(0).toUpperCase();
        var border = ring ? 'box-shadow:0 0 0 2px ' + ring + ';' : '';
        if (u.avatar) {
            return '<div style="width:'+sz+'px;height:'+sz+'px;border-radius:50%;overflow:hidden;flex-shrink:0;'+border+'"><img src="'+escapeHtml(u.avatar)+'" style="width:100%;height:100%;object-fit:cover;display:block;"/></div>';
        }
        return '<div style="width:'+sz+'px;height:'+sz+'px;border-radius:50%;background:#9c1d28;color:#fff;display:flex;align-items:center;justify-content:center;font-size:'+Math.round(sz*.4)+'px;font-weight:800;flex-shrink:0;'+border+'">'+escapeHtml(initials)+'</div>';
    }
    // Antes había cinta washi pegando cada nota. Lo hemos quitado porque
    // los carteles "pegados con cola" quedan más limpios sobre el muro.
    // Mantenemos las funciones como no-op para no tocar las llamadas
    // existentes en el resto del builder.
    function tape(_color, _pos) { return ''; }
    function pin(_color)        { return ''; }
    // Base de "nota" sobre muro de ladrillo: papel blanco con sombra más
    // marcada (el muro es oscuro, necesita más contraste que el corcho).
    function noteStyle(extraBg) {
        var bg = extraBg || 'rgba(255,255,255,.97)';
        return 'position:relative;background:'+bg+';border-radius:4px;'
             + 'box-shadow:0 4px 12px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.3);'
             + 'padding:10px 12px;';
    }
    var medals = ['🥇', '🥈', '🥉'];

    // ── Header del panel (siempre) ────────────────────────────
    // Título contextual: si estamos en un crew, ponemos su nombre.
    function _safeName(n) { return String(n || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    var titleText = crewId
        ? ('🏆 Esta semana en ' + _safeName(crewName || 'el crew'))
        : '🏆 Esta semana en el Club';
    var header = '<div style="' + noteStyle() + 'margin:14px 14px 12px;display:flex;align-items:center;justify-content:space-between;">'
              +    pin('red')
              +    '<div>'
              +      '<div style="font-size:13px;font-weight:800;color:#1a1f2e;letter-spacing:.2px;">' + titleText + '</div>'
              +      '<div style="margin-top:2px;font-size:10px;color:#6b6b6b;font-weight:600;">' + _fmtWeekRange() + '</div>'
              +    '</div>'
              +    '<button data-board-close style="width:28px;height:28px;border-radius:50%;border:none;background:rgba(0,0,0,.08);color:#1a1f2e;cursor:pointer;font-size:14px;line-height:1;font-weight:700;">×</button>'
              +  '</div>';

    // Si no hay posts esta semana — header + nota vacía
    if (!posts.length) {
        return header
            + '<div style="' + noteStyle() + 'margin:0 14px 14px;text-align:center;padding:18px 16px 20px;">'
            +    pin('green')
            +   '<div style="font-size:32px;margin-bottom:8px;">🌱</div>'
            +   '<div style="font-size:13px;font-weight:800;color:#1a1f2e;margin-bottom:4px;">Aún no hay publicaciones esta semana</div>'
            +   '<div style="font-size:11px;color:#6b6b6b;line-height:1.5;">Sé el primero — comparte tu primer entreno desde Biblioteca.</div>'
            + '</div>';
    }

    // ── Agregar métricas en cliente ──────────────────────────
    var totalKm = 0;
    var totalSessions = posts.length;
    var byUser = {}; // userId -> { name, avatar, km, sessions }
    var longest = null; // post con act_data.distKm máximo
    var topPost = null; // post con más reacciones

    posts.forEach(function(p) {
        var act = p.act_data || {};
        var km = Number(act.distKm || 0);
        if (!isFinite(km) || km <= 0) km = 0;
        totalKm += km;

        var prof = p.profiles || {};
        var uid = prof.id || 'anon';
        if (!byUser[uid]) byUser[uid] = { id: uid, name: prof.display_name || prof.username || 'Runner', avatar: prof.avatar_url || null, km: 0, sessions: 0 };
        byUser[uid].km += km;
        byUser[uid].sessions += 1;

        if (km > 0 && (!longest || km > Number(longest.act_data.distKm || 0))) longest = p;

        var rxCount = (p.reactions || []).length;
        if (!topPost || rxCount > ((topPost.reactions || []).length)) topPost = p;
    });

    // Top 3 por km
    var top3 = Object.values(byUser)
        .filter(function(u) { return u.km > 0; })
        .sort(function(a, b) { return b.km - a.km; })
        .slice(0, 3);

    // ── Construir HTML ─────────────────────────────────────────
    var h = header;

    // KPIs como dos post-its de colores (amarillo + verde) — cinta a lados alternos
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 14px 14px;">'
      +    '<div style="' + noteStyle('#fff8d6') + '">'
      +      tape('orange', 'topRight')
      +      '<div style="font-size:9px;color:#7a6810;font-weight:700;letter-spacing:.6px;text-transform:uppercase;">🏃 Km del club</div>'
      +      '<div style="margin-top:3px;font-size:20px;font-weight:900;color:#0e1f3a;font-family:var(--f);line-height:1.1;">' + fmtKm(totalKm) + '</div>'
      +    '</div>'
      +    '<div style="' + noteStyle('#d4edd4') + '">'
      +      tape('green', 'topLeft')
      +      '<div style="font-size:9px;color:#3a6b3a;font-weight:700;letter-spacing:.6px;text-transform:uppercase;">📊 Sesiones</div>'
      +      '<div style="margin-top:3px;font-size:20px;font-weight:900;color:#0e1f3a;font-family:var(--f);line-height:1.1;">' + totalSessions + '</div>'
      +    '</div>'
      +  '</div>';

    // Top 3 podium en una nota
    if (top3.length) {
        h += '<div style="' + noteStyle() + 'margin:0 14px 14px;">';
        h +=   tape('yellow', 'topRight');
        h +=   '<div style="font-size:10px;color:#666;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;">👑 Top runners</div>';
        h +=   '<div style="display:flex;flex-direction:column;gap:6px;">';
        top3.forEach(function(u, i) {
            var medal = medals[i] || '';
            h += '<div style="display:flex;align-items:center;gap:10px;">'
              +    '<div style="font-size:16px;width:22px;text-align:center;flex-shrink:0;">' + medal + '</div>'
              +    avatarHTML(u, 30, i === 0 ? 'rgba(232,168,37,.6)' : null)
              +    '<div style="flex:1;min-width:0;font-size:12.5px;font-weight:700;color:#1a1f2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(u.name) + '</div>'
              +    '<div style="font-size:13px;font-weight:800;color:#c4881e;font-family:var(--f);flex-shrink:0;">' + fmtKm(u.km) + '</div>'
              +  '</div>';
        });
        h +=   '</div>';
        h += '</div>';
    }

    // Sesión más larga — nota con acento dorado a la izquierda
    if (longest) {
        var lAct = longest.act_data || {};
        var lProf = longest.profiles || {};
        var lUser = { name: lProf.display_name || lProf.username || 'Runner', avatar: lProf.avatar_url || null };
        var lKm = Number(lAct.distKm || 0);
        var lDur = Number(lAct.durationSec || 0);
        var lDurStr = '';
        if (lDur > 0) {
            var h_ = Math.floor(lDur / 3600);
            var m_ = Math.floor((lDur % 3600) / 60);
            lDurStr = (h_ > 0 ? h_ + 'h ' : '') + m_ + 'min';
        }
        h += '<div style="' + noteStyle() + 'margin:0 14px 14px;border-left:4px solid #e8a825;display:flex;align-items:center;gap:10px;">'
          +    tape('blue', 'topLeft')
          +    avatarHTML(lUser, 34)
          +    '<div style="flex:1;min-width:0;">'
          +      '<div style="font-size:10px;color:#666;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">🔥 Sesión más larga</div>'
          +      '<div style="margin-top:2px;font-size:12.5px;font-weight:700;color:#1a1f2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(lUser.name) + ' · ' + escapeHtml(lAct.name || 'Carrera') + '</div>'
          +    '</div>'
          +    '<div style="text-align:right;flex-shrink:0;">'
          +      '<div style="font-size:15px;font-weight:900;color:#c4881e;font-family:var(--f);line-height:1.1;">' + fmtKm(lKm) + '</div>'
          +      (lDurStr ? '<div style="margin-top:1px;font-size:10px;color:#888;">' + lDurStr + '</div>' : '')
          +    '</div>'
          +  '</div>';
    }

    // Post con más reacciones (solo si tiene al menos 1)
    if (topPost && (topPost.reactions || []).length > 0) {
        var tProf = topPost.profiles || {};
        var tUser = { name: tProf.display_name || tProf.username || 'Runner', avatar: tProf.avatar_url || null };
        var tAct = topPost.act_data || {};
        var rxCount = topPost.reactions.length;
        h += '<div style="' + noteStyle() + 'margin:0 14px 14px;display:flex;align-items:center;gap:10px;">'
          +    tape('purple', 'topRight')
          +    avatarHTML(tUser, 32)
          +    '<div style="flex:1;min-width:0;">'
          +      '<div style="font-size:10px;color:#666;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">❤️ Post top</div>'
          +      '<div style="margin-top:2px;font-size:12.5px;font-weight:700;color:#1a1f2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(tUser.name) + ' · ' + escapeHtml(tAct.name || 'Carrera') + '</div>'
          +    '</div>'
          +    '<div style="background:rgba(239,68,68,.15);color:#c0392b;font-size:11px;font-weight:800;padding:5px 10px;border-radius:12px;flex-shrink:0;">' + rxCount + ' ❤</div>'
          +  '</div>';
    }

    return h;
}
window.toggleClubBoard = toggleClubBoard;

// ══ FEED FILTER — Para ti / Siguiendo / Crews / Récords ══════════════
// Las dos primeras pestañas son toggles del feed normal (filtro por
// seguidos). La tercera ("Crews") sustituye el feed por la lista de
// mis crews — al tocar un crew se abre su detalle. La cuarta ("Récords",
// FASE 7) sustituye el feed por el ranking global del Club.
// Modo persistido en LocalStorage:
//   mr_club_tab = 'all' (default) | 'following' | 'crews' | 'records'
function setClubFeedFilter(mode) {
    if (mode !== 'all' && mode !== 'following' && mode !== 'crews' && mode !== 'records') mode = 'all';
    localStorage.setItem(_uk('mr_club_tab'), mode);
    // Compatibilidad: el toggle viejo solo conocía following sí/no
    if (mode === 'following') localStorage.setItem(_uk('mr_feed_only_following'), '1');
    else if (mode === 'all')  localStorage.setItem(_uk('mr_feed_only_following'), '0');
    _refreshClubTabStyles();
    if (mode === 'crews') {
        if (typeof renderClubCrewsList === 'function') renderClubCrewsList();
    } else if (mode === 'records') {
        if (typeof renderClubRecordsRanking === 'function') renderClubRecordsRanking();
    } else {
        if (typeof renderClubFeed === 'function') renderClubFeed();
    }
}
window.setClubFeedFilter = setClubFeedFilter;

function _refreshClubTabStyles() {
    var mode = localStorage.getItem(_uk('mr_club_tab')) || 'all';
    // Fallback: si el modo guardado no existe pero el toggle viejo está activado, usar following
    if (mode !== 'crews' && mode !== 'records' && localStorage.getItem(_uk('mr_feed_only_following')) === '1') mode = 'following';
    var tAll   = document.getElementById('club-tab-all');
    var tFol   = document.getElementById('club-tab-following');
    var tCrews = document.getElementById('club-tab-crews');
    var tRecs  = document.getElementById('club-tab-records');
    if (!tAll || !tFol || !tCrews) return;
    // [FASE 8 polish] Pill premium con fondo sólido cuando activo
    // - Para ti / Siguiendo → fondo crimson, texto blanco
    // - Crews → fondo silver, texto blanco (mantiene identidad plateada)
    // - [FASE 7] Récords → fondo gold, texto cobre oscuro
    var base = 'flex:1;height:36px;border:none;border-radius:10px;background:transparent;'
             + 'font-family:var(--f);font-size:12px;letter-spacing:.3px;cursor:pointer;'
             + 'transition:background .22s ease, color .22s ease, box-shadow .22s ease, transform .15s ease;'
             + 'position:relative;margin:0 2px;';
    var inactive  = 'color:var(--tm);font-weight:700;';
    var activeRed = 'color:#fff;font-weight:900;'
                  + 'background:linear-gradient(135deg, #a32130 0%, #8f1a28 50%, #6f0f1a 100%);'
                  + 'box-shadow:0 2px 8px rgba(143,26,40,.35), inset 0 1px 0 rgba(255,255,255,.18);';
    var activeSil = 'color:#fff;font-weight:900;'
                  + 'background:linear-gradient(135deg, #9aa3ad 0%, #7a838c 50%, #5d646c 100%);'
                  + 'box-shadow:0 2px 8px rgba(122,131,140,.45), inset 0 1px 0 rgba(255,255,255,.25);';
    var activeGld = 'color:#3C2C08;font-weight:900;'
                  + 'background:linear-gradient(135deg, #FFE9A5 0%, #C9A84C 50%, #8A6E1F 100%);'
                  + 'box-shadow:0 2px 8px rgba(201,168,76,.45), inset 0 1px 0 rgba(255,255,255,.4);';
    tAll.style.cssText   = base + (mode === 'all'       ? activeRed : inactive);
    tFol.style.cssText   = base + (mode === 'following' ? activeRed : inactive);
    tCrews.style.cssText = base + (mode === 'crews'     ? activeSil : inactive);
    if (tRecs) tRecs.style.cssText = base + (mode === 'records' ? activeGld : inactive);
    // Badge de invitaciones pendientes (si hay)
    _refreshCrewsTabBadge();
}
window._refreshClubTabStyles = _refreshClubTabStyles;

// Pinta o quita el contador rojo en la pestaña Crews según haya
// invitaciones pendientes. Se llama desde:
//  - _refreshClubTabStyles() (al abrir Club / cambiar pestaña)
//  - _refreshMyCrewInvites() (tras cargar invitaciones)
//  - canal real-time de crew_invites (cuando llega una nueva)
function _refreshCrewsTabBadge() {
    var tCrews = document.getElementById('club-tab-crews');
    if (!tCrews) return;
    var existing = tCrews.querySelector('[data-crew-badge]');
    var count = 0;
    if (typeof getMyCrewInvites === 'function') {
        count = (getMyCrewInvites() || []).length;
    }
    if (!count) {
        if (existing) existing.remove();
        return;
    }
    var label = count > 9 ? '9+' : String(count);
    if (existing) {
        existing.textContent = label;
        return;
    }
    var badge = document.createElement('span');
    badge.setAttribute('data-crew-badge', '1');
    badge.style.cssText = 'position:absolute;top:2px;right:6px;min-width:16px;height:16px;'
        + 'padding:0 4px;border-radius:8px;background:#ef4444;color:#fff;'
        + 'font-size:9px;font-weight:800;line-height:16px;text-align:center;'
        + 'border:1.5px solid var(--bg);box-shadow:0 1px 3px rgba(239,68,68,.45);'
        + 'pointer-events:none;letter-spacing:0;';
    badge.textContent = label;
    tCrews.appendChild(badge);
}
window._refreshCrewsTabBadge = _refreshCrewsTabBadge;

// ── Swipe horizontal entre tabs del Club (Para ti / Siguiendo / Crews) ──
// Gesto premium: el feed se desliza al cambiar de tab, reusando las clases
// `mr-fx-view-slide-l/r` (las mismas que usa el swipe entre pestañas globales).
// Se attacha una sola vez vigilando que el feed exista, y respeta:
//   • Scroll vertical del feed
//   • Elementos con scroll horizontal interno (PR strips, mapas, etc.)
//   • Tags interactivas (INPUT/CANVAS/TEXTAREA/SELECT)
(function setupClubFeedSwipe(){
    var TABS = ['all', 'following', 'crews', 'records'];
    var TH_DX_MIN = 70;
    var TH_RATIO  = 1.4;
    var TH_VX_MIN = 0.35;

    var attached = false;
    function attach() {
        if (attached) return;
        var feed = document.getElementById('club-feed');
        if (!feed) return;
        attached = true;

        var sx = 0, sy = 0, st = 0, active = false, cancelled = false;

        function shouldIgnore(target) {
            if (!target || !(target instanceof Element)) return true;
            var el = target;
            while (el && el !== feed) {
                if (el.nodeType === 1) {
                    if (el.dataset && el.dataset.hScroll === '1') return true;
                    // overflow-x interno (PR strips de las cards, etc.)
                    var cs = el.scrollWidth > el.clientWidth + 4 ? getComputedStyle(el) : null;
                    if (cs && (cs.overflowX === 'auto' || cs.overflowX === 'scroll')) return true;
                    var tn = el.tagName;
                    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || tn === 'CANVAS') return true;
                    if (el.isContentEditable) return true;
                }
                el = el.parentNode;
            }
            return false;
        }

        function currentTabIdx() {
            var mode = localStorage.getItem(_uk('mr_club_tab')) || 'all';
            if (mode !== 'crews' && mode !== 'records' && localStorage.getItem(_uk('mr_feed_only_following')) === '1') mode = 'following';
            var i = TABS.indexOf(mode);
            return i < 0 ? 0 : i;
        }

        function goToTab(idx, dir) {
            if (idx < 0 || idx >= TABS.length) return;
            // Aplicar animación direccional al feed antes del cambio
            try {
                feed.classList.remove('mr-fx-view-slide-l', 'mr-fx-view-slide-r', 'mr-fx-view-in');
                void feed.offsetWidth; // forzar reflow
                feed.classList.add(dir === 'l' ? 'mr-fx-view-slide-l' : 'mr-fx-view-slide-r');
            } catch(_){}
            if (navigator.vibrate) try { navigator.vibrate(12); } catch(_){}
            if (typeof setClubFeedFilter === 'function') setClubFeedFilter(TABS[idx]);
        }

        feed.addEventListener('touchstart', function(e) {
            if (!e.touches || e.touches.length !== 1) { active = false; return; }
            cancelled = shouldIgnore(e.target);
            if (cancelled) { active = false; return; }
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            st = Date.now();
            active = true;
        }, { passive: true });

        feed.addEventListener('touchmove', function(e) {
            if (!active || cancelled) return;
            var t = e.touches[0];
            var dx = t.clientX - sx;
            var dy = t.clientY - sy;
            if (Math.abs(dy) > Math.abs(dx) * 0.9 && Math.abs(dy) > 14) {
                cancelled = true;
                active = false;
            }
        }, { passive: true });

        feed.addEventListener('touchend', function(e) {
            if (!active || cancelled) { active = false; return; }
            active = false;
            var t = (e.changedTouches && e.changedTouches[0]) || null;
            if (!t) return;
            var dx = t.clientX - sx;
            var dy = t.clientY - sy;
            var dt = Math.max(1, Date.now() - st);
            var vx = Math.abs(dx) / dt;
            if (Math.abs(dx) < TH_DX_MIN && vx < TH_VX_MIN) return;
            if (Math.abs(dx) < Math.abs(dy) * TH_RATIO) return;
            var idx = currentTabIdx();
            if (dx < 0) goToTab(idx + 1, 'l');   // swipe izq → siguiente tab
            else        goToTab(idx - 1, 'r');   // swipe der → anterior tab
        }, { passive: true });

        feed.addEventListener('touchcancel', function(){ active = false; cancelled = false; }, { passive: true });
    }

    // Intentar attachar ahora; si no, esperar a que aparezca #club-feed.
    if (!attach()) {
        var observer = new MutationObserver(function() {
            if (document.getElementById('club-feed')) {
                attach();
                if (attached) observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();

// ══ HEATMAP — Mapa de calor de rutas (últimos 30 días) ═══════════════
// Renderiza todas las rutas de un runner superpuestas en un canvas
// con compositing aditivo. Donde se cruzan, los píxeles se suman y
// aparecen zonas "calientes" más brillantes. Sin Mapbox, sin red.
//
// Fuente de datos:
//   • userId === 'me' → array `activities` local (LocalStorage/IDB)
//   • userId === <uuid> → club_posts del runner en los últimos 30 días
//
// La cache `_heatmapCache[key]` evita recomputar al volver a abrir.
var _heatmapCache = {};

async function openHeatmap(userId, displayName) {
    var isMe = (userId === 'me');
    var cacheKey = isMe ? 'me' : userId;
    // Para el heatmap propio invalidamos siempre la cache: leer de la
    // memoria local es instantáneo y así reflejamos cualquier actividad
    // recién importada o borrada sin recargar la app.
    if (isMe) delete _heatmapCache[cacheKey];
    // Rango por defecto: 30 días. Si el conjunto resulta vacío y el usuario
    // tiene actividades fuera de ese rango, ampliaremos a 90 días automáticamente.
    var DAYS_PRIMARY = 30;
    var DAYS_FALLBACK = 90;
    var daysUsed = DAYS_PRIMARY;

    // ── Crear overlay ────────────────────────────────────────
    var ov = document.createElement('div');
    ov.id = 'heatmap-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px;animation:_hmFade .22s ease-out;';
    if (!document.getElementById('_hmFadeStyle')) {
        var st = document.createElement('style');
        st.id = '_hmFadeStyle';
        st.textContent = '@keyframes _hmFade{from{opacity:0}to{opacity:1}}';
        document.head.appendChild(st);
    }
    ov.onclick = function(e) {
        if (e.target === ov) {
            ov.style.animation = '_hmFade .16s ease-out reverse';
            setTimeout(function() { ov.remove(); }, 150);
        }
    };

    // Contenedor central (la "tarjeta")
    var card = document.createElement('div');
    card.style.cssText = 'background:var(--card);border:1.5px solid var(--gold-bd);border-radius:18px;padding:14px;max-width:360px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.55);';

    // Header (título + botón cerrar)
    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    var title = document.createElement('div');
    title.innerHTML = '<div style="font-size:13px;font-weight:800;color:var(--tw);letter-spacing:.3px;">🔥 HEATMAP'
                    + (isMe ? '' : ' · ' + (displayName || 'Runner').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;'))
                    + '</div>'
                    + '<div style="margin-top:2px;font-size:10px;color:var(--tm);font-weight:600;">Últimos <span id="hm-days">30</span> días · <span id="hm-count">…</span></div>';
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:1px solid var(--border);background:var(--bg);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    closeBtn.onclick = function() {
        ov.style.animation = '_hmFade .16s ease-out reverse';
        setTimeout(function() { ov.remove(); }, 150);
    };
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);

    // Canvas
    var canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 640; // alta resolución para Retina
    canvas.style.cssText = 'width:100%;aspect-ratio:1/1;border-radius:12px;background:#0a0f1c;display:block;';

    // Footer info
    var footer = document.createElement('div');
    footer.id = 'hm-footer';
    footer.style.cssText = 'margin-top:10px;font-size:10px;color:var(--tm);text-align:center;line-height:1.6;';
    footer.textContent = 'Cargando rutas…';

    // Action row: download + share (sólo se muestran cuando hay tracks)
    var actionsRow = document.createElement('div');
    actionsRow.id = 'hm-actions';
    actionsRow.style.cssText = 'display:none;margin-top:10px;gap:8px;justify-content:center;';

    var dlBtn = document.createElement('button');
    dlBtn.id = 'hm-dl-btn';
    dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span style="margin-left:6px;">Descargar</span>';
    dlBtn.style.cssText = 'flex:1;max-width:160px;height:38px;border-radius:10px;border:1.5px solid var(--gold-bd);background:linear-gradient(135deg,#c4881e,#e8a825);color:#000;font-family:var(--f);font-size:12px;font-weight:800;letter-spacing:.4px;display:flex;align-items:center;justify-content:center;cursor:pointer;';

    var shBtn = document.createElement('button');
    shBtn.id = 'hm-sh-btn';
    shBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg><span style="margin-left:6px;">Compartir</span>';
    shBtn.style.cssText = 'flex:1;max-width:160px;height:38px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);color:var(--tw);font-family:var(--f);font-size:12px;font-weight:800;letter-spacing:.4px;display:flex;align-items:center;justify-content:center;cursor:pointer;';

    actionsRow.appendChild(dlBtn);
    actionsRow.appendChild(shBtn);

    // Botón "Compartir al Club" (solo en heatmap propio)
    var clubBtn = null;
    if (isMe) {
        clubBtn = document.createElement('button');
        clubBtn.id = 'hm-club-btn';
        clubBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span style="margin-left:6px;">Al Club</span>';
        clubBtn.style.cssText = 'flex:1;max-width:160px;height:38px;border-radius:10px;border:1.5px solid var(--gold-bd);background:var(--bg);color:var(--gold);font-family:var(--f);font-size:12px;font-weight:800;letter-spacing:.4px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
        actionsRow.appendChild(clubBtn);
    }

    card.appendChild(hdr);
    card.appendChild(canvas);
    card.appendChild(footer);
    card.appendChild(actionsRow);
    ov.appendChild(card);
    document.body.appendChild(ov);

    // Helper para construir el filename
    function _heatmapFilename() {
        var who = isMe ? 'mio' : (displayName || 'runner').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        var d = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : n; };
        var datePart = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
        return 'misterrunner-heatmap-' + who + '-' + datePart + '.png';
    }

    // Descargar imagen PNG
    dlBtn.onclick = function() {
        try {
            var url = canvas.toDataURL('image/png');
            var link = document.createElement('a');
            link.href = url;
            link.download = _heatmapFilename();
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (e) {
            console.error('[Heatmap] download:', e);
        }
    };

    // Compartir vía Web Share API si está disponible, o fallback a descarga
    shBtn.onclick = async function() {
        try {
            var blob = await new Promise(function(res) { canvas.toBlob(res, 'image/png'); });
            if (!blob) throw new Error('No blob');
            var file = new File([blob], _heatmapFilename(), { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: 'Mi heatmap de MisterRunner',
                    text: isMe ? 'Mis rutas de los últimos ' + daysUsed + ' días 🔥' : ''
                });
            } else {
                // Fallback: descarga directa
                dlBtn.onclick();
            }
        } catch (e) {
            // Usuario canceló o el navegador no permite — silencioso
            if (e && e.name !== 'AbortError') console.error('[Heatmap] share:', e);
        }
    };

    // Publicar el heatmap como post en el Club / Crews
    if (clubBtn) clubBtn.onclick = async function() {
        // Selector de destinos (sustituye al confirm() clásico)
        var dest = (typeof pickPublishDestinations === 'function')
            ? await pickPublishDestinations()
            : { toPublic: true, crewIds: [] };
        if (!dest) return; // canceló
        var sb = window._sbClient;
        var origHTML = clubBtn.innerHTML;
        clubBtn.innerHTML = '<span style="font-size:11px;">Publicando…</span>';
        clubBtn.disabled = true;
        try {
            var { data: { session } } = await sb.auth.getSession();
            if (!session) throw new Error('No session');
            var myId = session.user.id;
            // Convertimos canvas a Blob PNG
            var blob = await new Promise(function(res) { canvas.toBlob(res, 'image/png'); });
            if (!blob) throw new Error('No blob');
            // Subimos a Supabase Storage
            var pth = myId + '/heatmap-' + Date.now() + '.png';
            var { error: upE } = await sb.storage.from('media').upload(pth, blob, { contentType: 'image/png' });
            if (upE) throw upE;
            var { data: ud } = sb.storage.from('media').getPublicUrl(pth);
            var photoUrl = ud.publicUrl;
            // Creamos el post con act_data especial tipo "heatmap"
            var actData = {
                type: 'heatmap',
                name: '🔥 Mi Heatmap · ' + daysUsed + ' días',
                dateStr: (function() {
                    var d = new Date();
                    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
                })(),
                heatmapStats: {
                    days: daysUsed,
                    totalKm: Math.round(totalKm * 10) / 10,
                    nRoutes: tracks.length,
                    nZones: (typeof nClusters !== 'undefined' ? nClusters : 1)
                }
            };
            var res = await _insertPostToDestinations({
                user_id: myId,
                act_data: actData,
                photo_url: photoUrl
            }, dest);
            if (!res.ok) throw (res.errors[0] || new Error('No se pudo publicar'));
            // Feedback éxito
            clubBtn.innerHTML = '<span style="font-size:11px;">✓ Publicado</span>';
            setTimeout(function() {
                var ovEl = document.getElementById('heatmap-overlay');
                if (ovEl) ovEl.remove();
                if (typeof renderClubFeed === 'function') renderClubFeed();
            }, 700);
        } catch (e) {
            console.error('[Heatmap] club share:', e);
            clubBtn.innerHTML = origHTML;
            clubBtn.disabled = false;
            alert('No se pudo publicar el heatmap. ' + (e.message || ''));
        }
    };

    // ── Obtener tracks ───────────────────────────────────────
    var tracks; // array de arrays de {lat,lon}
    var totalKm = 0;
    // ── Función reutilizable: cargar tracks con una ventana de N días ────
    // Devuelve { tracks, totalKm, debug }. La separamos para poder llamarla
    // con un rango mayor si el primer intento sale vacío.
    async function _loadTracksInWindow(days) {
        var cutoffMs = Date.now() - days * 24 * 3600 * 1000;
        var outTracks = [], outKm = 0;
        var dbg = { total: 0, inRange: 0, conRecords: 0, pintables: 0, sample: '' };
        if (isMe) {
            var acts = (typeof window._getActivities === 'function')
                ? window._getActivities()
                : (typeof activities !== 'undefined' ? activities : []);
            if (acts && acts.length) {
                dbg.total = acts.length;
                var a0 = acts[0];
                dbg.sample = 'name="' + (a0.name || a0.dateStr || '?')
                           + '", dateStr=' + JSON.stringify(a0.dateStr)
                           + ', id=' + a0.id
                           + ', records=' + (Array.isArray(a0.records) ? a0.records.length : (a0.records === undefined ? 'undefined' : typeof a0.records))
                           + ', distKm=' + a0.distKm;
                acts.forEach(function(a) {
                    // Determinar fecha (dateStr | id timestamp | sin fecha → incluir)
                    var actTimeMs = null;
                    if (a.dateStr) {
                        var d = new Date(a.dateStr + 'T00:00:00');
                        if (!isNaN(d.getTime())) actTimeMs = d.getTime();
                    }
                    if (actTimeMs === null && typeof a.id === 'number' && a.id > 1e12) {
                        actTimeMs = a.id;
                    }
                    if (actTimeMs !== null && actTimeMs < cutoffMs) return;
                    dbg.inRange++;

                    if (a.records && a.records.length > 1) {
                        dbg.conRecords++;
                        var cleaned = a.records.filter(function(r) {
                            return r && isFinite(r.lat) && isFinite(r.lon);
                        });
                        if (cleaned.length > 1) {
                            outTracks.push(cleaned);
                            outKm += Number(a.distKm || 0);
                            dbg.pintables++;
                        }
                    }
                });
            }
        } else {
            var sb = window._sbClient;
            var cutoffISO = new Date(cutoffMs).toISOString();
            var resp = await sb.from('club_posts')
                .select('act_data, created_at')
                .eq('user_id', userId)
                .gte('created_at', cutoffISO)
                .order('created_at', { ascending: false });
            if (resp.error) throw resp.error;
            (resp.data || []).forEach(function(p) {
                dbg.inRange++;
                var ad = p.act_data || {};
                if (ad.records && ad.records.length > 1) {
                    dbg.conRecords++;
                    var cleaned = ad.records.filter(function(r) {
                        return r && isFinite(r.lat) && isFinite(r.lon);
                    });
                    if (cleaned.length > 1) {
                        outTracks.push(cleaned);
                        outKm += Number(ad.distKm || 0);
                        dbg.pintables++;
                    }
                }
            });
        }
        return { tracks: outTracks, totalKm: outKm, debug: dbg };
    }

    try {
        if (_heatmapCache[cacheKey]) {
            tracks = _heatmapCache[cacheKey].tracks;
            totalKm = _heatmapCache[cacheKey].totalKm;
            daysUsed = _heatmapCache[cacheKey].daysUsed || DAYS_PRIMARY;
        } else {
            // Intento 1: 30 días
            var r1 = await _loadTracksInWindow(DAYS_PRIMARY);
            tracks = r1.tracks; totalKm = r1.totalKm;
            openHeatmap._lastDebug = '30d → total=' + r1.debug.total +
                                    ', inRange=' + r1.debug.inRange +
                                    ', conRecords=' + r1.debug.conRecords +
                                    ', pintables=' + r1.debug.pintables +
                                    (r1.debug.sample ? ' · ' + r1.debug.sample : '');
            // Si vacío y hay actividades fuera de los 30 días → reintentar con 90
            if (!tracks.length && r1.debug.total > 0) {
                var r2 = await _loadTracksInWindow(DAYS_FALLBACK);
                if (r2.tracks.length) {
                    tracks = r2.tracks; totalKm = r2.totalKm;
                    daysUsed = DAYS_FALLBACK;
                    openHeatmap._lastDebug += ' || 90d → pintables=' + r2.debug.pintables;
                }
            }
            console.log('[Heatmap] ' + openHeatmap._lastDebug);
            // Filtrar tracks vacíos tras el filtrado de coords
            tracks = tracks.filter(function(t) { return t.length > 1; });
            _heatmapCache[cacheKey] = { tracks: tracks, totalKm: totalKm, daysUsed: daysUsed };
        }
    } catch (e) {
        console.error('[Heatmap] Error cargando rutas:', e);
        footer.innerHTML = '<div style="color:#ef4444;">Error cargando rutas: ' + (e && e.message ? e.message : 'desconocido') + '</div>';
        return;
    }

    var nRutas = tracks.length;
    document.getElementById('hm-count').textContent = nRutas + (nRutas === 1 ? ' ruta' : ' rutas');
    // Reflejar el rango realmente usado (puede haber ampliado a 90 días)
    var daysEl = document.getElementById('hm-days');
    if (daysEl) daysEl.textContent = daysUsed;

    // ── Caso vacío ───────────────────────────────────────────
    if (!nRutas) {
        var ctx0 = canvas.getContext('2d');
        ctx0.fillStyle = '#0a0f1c';
        ctx0.fillRect(0, 0, 640, 640);
        ctx0.fillStyle = 'rgba(255,255,255,.25)';
        ctx0.font = 'bold 26px system-ui, sans-serif';
        ctx0.textAlign = 'center';
        ctx0.fillText('🗺️', 320, 300);
        ctx0.font = '14px system-ui, sans-serif';
        ctx0.fillText('Sin rutas en ' + daysUsed + ' días', 320, 340);
        if (isMe) {
            var dbg = openHeatmap._lastDebug || '(sin diagnóstico)';
            footer.textContent = 'No hay actividades importadas en los últimos ' + daysUsed + ' días.'
                             + '<div style="margin-top:8px;font-size:9px;opacity:.6;line-height:1.5;word-break:break-all;">Debug: ' + dbg + '</div>';
        } else {
            footer.textContent = 'Este runner no ha publicado rutas en los últimos ' + daysUsed + ' días.';
        }
        return;
    }

    // ── Detectar clusters geográficos ─────────────────────────
    // Agrupamos tracks cuyo centroide esté a < 50 km de algún miembro del grupo.
    // Si todos están cerca → 1 cluster (render tradicional).
    // Si hay zonas alejadas → mini-grid con cada zona en su propia celda.
    function trackCentroid(t) {
        var sLat = 0, sLon = 0;
        for (var i = 0; i < t.length; i++) { sLat += t[i].lat; sLon += t[i].lon; }
        return { lat: sLat / t.length, lon: sLon / t.length };
    }
    function kmBetween(a, b) {
        var R = 6371;
        var dLat = (b.lat - a.lat) * Math.PI / 180;
        var dLon = (b.lon - a.lon) * Math.PI / 180;
        var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
        var x = Math.sin(dLat/2)**2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    }
    var CLUSTER_RADIUS_KM = 50;
    var trackCentroids = tracks.map(trackCentroid);
    var clusters = []; // [{ trackIdxs:[i,...], center:{lat,lon} }]
    trackCentroids.forEach(function(c, i) {
        var joined = false;
        for (var k = 0; k < clusters.length; k++) {
            if (kmBetween(c, clusters[k].center) <= CLUSTER_RADIUS_KM) {
                clusters[k].trackIdxs.push(i);
                // Actualizar centro como media
                var n = clusters[k].trackIdxs.length;
                clusters[k].center = {
                    lat: (clusters[k].center.lat * (n - 1) + c.lat) / n,
                    lon: (clusters[k].center.lon * (n - 1) + c.lon) / n
                };
                joined = true; break;
            }
        }
        if (!joined) clusters.push({ trackIdxs: [i], center: c });
    });
    // Ordenar por nº de rutas (cluster mayor primero)
    clusters.sort(function(a, b) { return b.trackIdxs.length - a.trackIdxs.length; });

    // Tabla mínima de ciudades españolas para etiquetar zonas (lat, lon, nombre).
    // Si la distancia al centroide del cluster < 30 km → asignamos esa etiqueta.
    var CITIES = [
        { lat: 40.416, lon: -3.703, name: 'Madrid' },
        { lat: 41.385, lon:  2.173, name: 'Barcelona' },
        { lat: 39.470, lon: -0.376, name: 'Valencia' },
        { lat: 37.389, lon: -5.984, name: 'Sevilla' },
        { lat: 41.649, lon: -0.886, name: 'Zaragoza' },
        { lat: 43.263, lon: -2.935, name: 'Bilbao' },
        { lat: 36.721, lon: -4.421, name: 'Málaga' },
        { lat: 28.124, lon: -15.430, name: 'Las Palmas' },
        { lat: 37.176, lon: -3.598, name: 'Granada' },
        { lat: 43.362, lon: -8.411, name: 'A Coruña' },
        { lat: 43.535, lon: -5.661, name: 'Gijón' },
        { lat: 39.864, lon: -4.027, name: 'Toledo' },
        { lat: 38.346, lon: -0.481, name: 'Alicante' },
        { lat: 37.984, lon: -1.130, name: 'Murcia' },
        { lat: 38.005, lon: -1.124, name: 'Murcia' },
        { lat: 40.965, lon: -5.664, name: 'Salamanca' },
        { lat: 42.236, lon: -8.720, name: 'Vigo' },
        { lat: 42.871, lon: -8.547, name: 'Santiago' },
        { lat: 40.633, lon: -3.165, name: 'Alcalá' },
        { lat: 39.470, lon: -6.372, name: 'Cáceres' },
        // Fuera de España (algunas referencias)
        { lat: 48.857, lon:  2.351, name: 'París' },
        { lat: 51.507, lon: -0.128, name: 'Londres' },
        { lat: 41.902, lon: 12.496, name: 'Roma' },
        { lat: 52.520, lon: 13.405, name: 'Berlín' },
        { lat: 38.722, lon: -9.139, name: 'Lisboa' },
        { lat: 40.713, lon: -74.006, name: 'Nueva York' },
    ];
    function labelForCluster(c) {
        var best = null, bestD = Infinity;
        for (var i = 0; i < CITIES.length; i++) {
            var d = kmBetween(c.center, CITIES[i]);
            if (d < bestD) { bestD = d; best = CITIES[i]; }
        }
        if (best && bestD < 60) return best.name;
        // Sin etiqueta: devolvemos coordenadas redondeadas
        return c.center.lat.toFixed(2) + ', ' + c.center.lon.toFixed(2);
    }

    // ── Pintar ────────────────────────────────────────────────
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    // Fondo carbón general
    var fullGrad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.7);
    fullGrad.addColorStop(0, '#0e1f3a');
    fullGrad.addColorStop(1, '#050a14');
    ctx.fillStyle = fullGrad;
    ctx.fillRect(0, 0, W, H);

    // Función reutilizable: dibuja un cluster (subset de tracks) en una sub-celda
    function drawCluster(trackSubset, x0, y0, cellW, cellH, label) {
        // BBox del subset
        var bLatMin = Infinity, bLatMax = -Infinity, bLonMin = Infinity, bLonMax = -Infinity;
        trackSubset.forEach(function(t) {
            t.forEach(function(r) {
                if (r.lat < bLatMin) bLatMin = r.lat;
                if (r.lat > bLatMax) bLatMax = r.lat;
                if (r.lon < bLonMin) bLonMin = r.lon;
                if (r.lon > bLonMax) bLonMax = r.lon;
            });
        });
        var padLat = (bLatMax - bLatMin) * 0.08 || 0.001;
        var padLon = (bLonMax - bLonMin) * 0.08 || 0.001;
        bLatMin -= padLat; bLatMax += padLat; bLonMin -= padLon; bLonMax += padLon;
        var latRad = (bLatMin + bLatMax) / 2 * Math.PI / 180;
        var lonSpanM = (bLonMax - bLonMin) * 111320 * Math.cos(latRad);
        var latSpanM = (bLatMax - bLatMin) * 111320;
        // Reservar espacio inferior para la etiqueta (24 px)
        var labelH = label ? 26 : 0;
        var usableH = cellH - labelH;
        var ppm;
        if (lonSpanM / cellW > latSpanM / usableH) {
            ppm = (cellW * 0.94) / lonSpanM;
        } else {
            ppm = (usableH * 0.94) / latSpanM;
        }
        var pxW = lonSpanM * ppm, pxH = latSpanM * ppm;
        var subOffX = x0 + (cellW - pxW) / 2;
        var subOffY = y0 + (usableH - pxH) / 2;
        function lon2x(lon) { return subOffX + (lon - bLonMin) * 111320 * Math.cos(latRad) * ppm; }
        function lat2y(lat) { return subOffY + (bLatMax - lat) * 111320 * ppm; }

        // 3 pasadas heatmap
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, cellW, usableH);
        ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        var passes = [
            { color: 'rgba(232,168,37,0.18)', w: 8 },
            { color: 'rgba(255,180,80,0.42)', w: 2.4 },
            { color: 'rgba(255,240,220,0.55)', w: 0.9 }
        ];
        passes.forEach(function(p) {
            ctx.strokeStyle = p.color; ctx.lineWidth = p.w;
            trackSubset.forEach(function(t) {
                ctx.beginPath();
                for (var i = 0; i < t.length; i++) {
                    var x = lon2x(t[i].lon), y = lat2y(t[i].lat);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            });
        });
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';

        // Etiqueta de zona
        if (label) {
            ctx.fillStyle = 'rgba(232,168,37,.85)';
            ctx.font = 'bold 18px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x0 + cellW / 2, y0 + cellH - labelH / 2);
        }
    }

    // Layout: 1, 2, 3-4 clusters → grid 1x1, 1x2, 2x2
    var nClusters = clusters.length;
    if (nClusters === 1) {
        // Render tradicional, sin etiqueta de zona (toda la actividad es la misma)
        var c = clusters[0];
        var subset = c.trackIdxs.map(function(i) { return tracks[i]; });
        drawCluster(subset, 0, 0, W, H, null);
    } else {
        // Mostramos hasta 4 clusters. Si hay más, los demás se mencionan en footer.
        var shown = clusters.slice(0, 4);
        var hiddenN = clusters.length - shown.length;
        var cols, rows;
        if (shown.length === 2)      { cols = 1; rows = 2; }
        else if (shown.length === 3) { cols = 2; rows = 2; }
        else                          { cols = 2; rows = 2; }
        var cellW = W / cols, cellH = H / rows;

        shown.forEach(function(c, idx) {
            var col = idx % cols, row = Math.floor(idx / cols);
            var subset = c.trackIdxs.map(function(i) { return tracks[i]; });
            var label = labelForCluster(c) + ' · ' + c.trackIdxs.length + (c.trackIdxs.length === 1 ? ' ruta' : ' rutas');
            drawCluster(subset, col * cellW, row * cellH, cellW, cellH, label);
        });

        // Dibujar líneas de separación sutiles entre celdas
        ctx.strokeStyle = 'rgba(232,168,37,.18)';
        ctx.lineWidth = 1;
        for (var ci = 1; ci < cols; ci++) {
            ctx.beginPath();
            ctx.moveTo(ci * cellW, 0); ctx.lineTo(ci * cellW, H);
            ctx.stroke();
        }
        for (var ri = 1; ri < rows; ri++) {
            ctx.beginPath();
            ctx.moveTo(0, ri * cellH); ctx.lineTo(W, ri * cellH);
            ctx.stroke();
        }

        // Si hay clusters ocultos, anotarlo
        if (hiddenN > 0) {
            ctx.fillStyle = 'rgba(255,255,255,.5)';
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('+' + hiddenN + ' zona' + (hiddenN === 1 ? '' : 's') + ' no mostrada' + (hiddenN === 1 ? '' : 's'), 12, H - 14);
        }
    }

    // ── Branding overlay (tarjeta compartible) ────────────────
    // Barra superior con título, barra inferior con stats + logo grande
    // abajo derecha (sustituye al watermark de texto antiguo).
    var TOP_BAR = 60;    // alto barra superior
    var BOTTOM_BAR = 60; // alto barra inferior (un pelín mayor para el logo)
    var kmStrCanvas = (Math.round(totalKm * 10) / 10).toFixed(1);

    // Barra superior: degradado oscuro semitransparente
    var topGrad = ctx.createLinearGradient(0, 0, 0, TOP_BAR);
    topGrad.addColorStop(0, 'rgba(8,12,22,0.92)');
    topGrad.addColorStop(1, 'rgba(8,12,22,0.0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, TOP_BAR);

    // Título "🔥 HEATMAP · Nombre" y subtítulo "Últimos N días"
    // (ya no hay logo arriba — solo texto)
    var titleText = '🔥 HEATMAP';
    if (!isMe && displayName) titleText += ' · ' + displayName;
    else if (isMe) titleText += ' · Mis rutas';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(titleText, 16, 12);
    ctx.fillStyle = 'rgba(232,168,37,0.85)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Últimos ' + daysUsed + ' días', 16, 38);

    // Barra inferior: degradado oscuro
    var botGrad = ctx.createLinearGradient(0, H - BOTTOM_BAR, 0, H);
    botGrad.addColorStop(0, 'rgba(8,12,22,0.0)');
    botGrad.addColorStop(0.4, 'rgba(8,12,22,0.85)');
    botGrad.addColorStop(1, 'rgba(8,12,22,0.95)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, H - BOTTOM_BAR, W, BOTTOM_BAR);

    // Stats izquierda: km recorridos + nº rutas
    ctx.fillStyle = '#e8a825';
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(kmStrCanvas + ' km', 16, H - 24);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(nRutas + (nRutas === 1 ? ' ruta' : ' rutas')
               + (nClusters > 1 ? ' · ' + nClusters + ' zonas' : ''),
               16, H - 9);

    // Logo MR grande abajo a la derecha (sustituye al watermark de texto).
    // Esperamos al onload del logo antes de habilitar los botones para
    // garantizar que el PNG descargado ya lo incluya.
    var logoImg = new Image();
    logoImg.onload = function() {
        ctx.save();
        ctx.beginPath();
        var logoSize = 52;
        var logoX = W - logoSize - 14;
        var logoY = H - logoSize - 12;
        var r = 9;
        ctx.moveTo(logoX + r, logoY);
        ctx.lineTo(logoX + logoSize - r, logoY);
        ctx.quadraticCurveTo(logoX + logoSize, logoY, logoX + logoSize, logoY + r);
        ctx.lineTo(logoX + logoSize, logoY + logoSize - r);
        ctx.quadraticCurveTo(logoX + logoSize, logoY + logoSize, logoX + logoSize - r, logoY + logoSize);
        ctx.lineTo(logoX + r, logoY + logoSize);
        ctx.quadraticCurveTo(logoX, logoY + logoSize, logoX, logoY + logoSize - r);
        ctx.lineTo(logoX, logoY + r);
        ctx.quadraticCurveTo(logoX, logoY, logoX + r, logoY);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
        ctx.restore();
        if (actionsRow) actionsRow.style.display = 'flex';
    };
    logoImg.onerror = function() {
        if (actionsRow) actionsRow.style.display = 'flex';
    };
    if (typeof MR_LOGO === 'string') {
        logoImg.src = MR_LOGO;
    } else {
        if (actionsRow) actionsRow.style.display = 'flex';
    }

    // ── Footer info (debajo del canvas, en el modal) ──────────
    var kmStr = (Math.round(totalKm * 10) / 10).toFixed(1);
    var zonasInfo = (nClusters > 1) ? (' · <b style="color:var(--tw);font-weight:800;">' + nClusters + '</b> zonas') : '';
    footer.innerHTML = '<b style="color:var(--tw);font-weight:800;">' + kmStr + ' km</b> recorridos · '
                     + '<b style="color:var(--tw);font-weight:800;">' + nRutas + '</b> ' + (nRutas === 1 ? 'ruta' : 'rutas')
                     + zonasInfo
                     + (isMe ? '' : '<br><span style="opacity:.7;">Solo se muestran rutas publicadas al Club</span>');
}
window.openHeatmap = openHeatmap;

// ═══════════════════════════════════════════════════════════════════════
// PASO E — SECCIÓN MIS RÉCORDS (sheet con grid 3×3 de medallas)
// E2: shell visual con placeholders. E3 cargará datos reales de Supabase.
// ═══════════════════════════════════════════════════════════════════════
function _openPRsSheet(userId, displayName, isSelf) {
    // Si userId === 'me' resolvemos al usuario actual
    var sb = window._sbClient;
    var resolveSelf = (userId === 'me' || isSelf === true);

    // Evitar dobles aperturas
    if (document.getElementById('mr-prs-sheet')) return;

    // Orden FIJO de récords en el grid (de más cotizado a menos)
    // [FASE 8] +6 PRs nuevos al final: streak, week, month, cadence, hr_easy, efficiency
    var ORDER = ['best_marathon','best_half','best_10k','best_5k','best_3000m','best_1k','best_100m','best_pace','longest_run','best_ascent','hottest_day','coldest_day',
                 'best_streak_days','best_week_km','best_month_km','best_cadence','lowest_hr_easy','best_efficiency_index'];
    // Hitos kilométricos acumulados, en orden ascendente
    var ORDER_MILESTONES = ['km_50','km_100','km_200','km_500','km_1000','km_2000','km_3000','km_4000','km_5000','km_10000','km_20000','km_40000'];
    // [FASE 8] Hitos de racha (3) — se mostrarán en su propia sección debajo
    var ORDER_STREAK_MILESTONES = ['streak_15','streak_30','streak_100'];

    // Detectar tema
    var isDark = document.body.classList.contains('dark-mode');

    // ── Backdrop ──────────────────────────────────────────────────────
    var back = document.createElement('div');
    back.id = 'mr-prs-sheet';
    back.style.cssText = [
        'position:fixed','inset:0','z-index:99996',
        'background:rgba(0,0,0,.55)',
        'backdrop-filter:blur(5px)','-webkit-backdrop-filter:blur(5px)',
        'display:flex','align-items:flex-end','justify-content:center',
        'opacity:0','transition:opacity .25s ease'
    ].join(';');

    // [Bloque B · UI premium] Inyectar keyframes una sola vez
    if (!document.getElementById('mr-prs-anim-style')) {
        var animStyle = document.createElement('style');
        animStyle.id = 'mr-prs-anim-style';
        animStyle.textContent = [
            '@keyframes mrPrsDot {',
            '  0%, 100% { opacity:.3; transform:scale(.85); }',
            '  50% { opacity:1; transform:scale(1.1); }',
            '}',
            '@keyframes mrPrsShimmer {',
            '  0% { background-position:-200% 0; }',
            '  100% { background-position:200% 0; }',
            '}',
            '@keyframes mrPrsStaggerIn {',
            '  0% { opacity:0; transform:translateY(8px) scale(.94); }',
            '  100% { opacity:1; transform:translateY(0) scale(1); }',
            '}',
            '.mr-prs-card-skeleton {',
            '  background: linear-gradient(90deg,',
            '    var(--card) 0%, rgba(201,168,76,.12) 50%, var(--card) 100%) !important;',
            '  background-size: 200% 100% !important;',
            '  animation: mrPrsShimmer 1.6s ease-in-out infinite;',
            '}',
            '.mr-prs-card-stagger {',
            '  animation: mrPrsStaggerIn .42s cubic-bezier(.34,1.45,.64,1) both;',
            '}',
        ].join('\n');
        document.head.appendChild(animStyle);
    }

    // ── Sheet ─────────────────────────────────────────────────────────
    var sheet = document.createElement('div');
    sheet.style.cssText = [
        'width:100%','max-width:480px',
        'background:var(--bg)',
        'border-radius:22px 22px 0 0',
        'box-shadow:0 -8px 30px rgba(0,0,0,.4)',
        'display:flex','flex-direction:column',
        'max-height:92vh',
        'transform:translateY(40px)','transition:transform .3s cubic-bezier(.32,.72,0,1)',
        'overflow:hidden'
    ].join(';');

    // ── Handle drag visual ────────────────────────────────────────────
    var handle = document.createElement('div');
    handle.style.cssText = 'width:42px;height:4px;border-radius:2px;background:var(--border);margin:8px auto 6px;flex-shrink:0;';
    sheet.appendChild(handle);

    // ── Cabecera premium (Opción A · silver gradient + línea decorativa dorada) ─
    // Wrapper coherente con banner KPI biblioteca (mismo lenguaje visual)
    var hdrWrap = document.createElement('div');
    hdrWrap.style.cssText = 'position:relative;margin:0 14px 12px;border-radius:16px;padding:14px;background:' + (isDark ? 'linear-gradient(135deg, #1c1c1f 0%, #26262a 50%, #1c1c1f 100%)' : 'linear-gradient(135deg, #fafafa 0%, #e8e8ed 50%, #fafafa 100%)') + ';border:1px solid var(--border);overflow:hidden;flex-shrink:0;';
    // Línea decorativa dorada superior (2px, fade a los lados)
    var hdrAccent = document.createElement('div');
    hdrAccent.style.cssText = 'position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg, transparent, #c4881e 30%, #f5d97a 50%, #c4881e 70%, transparent);';
    hdrWrap.appendChild(hdrAccent);

    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:12px;';

    // Icono trofeo XL 52px con radial gradient premium
    var icon = document.createElement('div');
    icon.style.cssText = 'flex-shrink:0;width:52px;height:52px;border-radius:13px;background:radial-gradient(circle at 30% 30%, #f5d97a, #c4881e 60%, #8a5a11);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 -6px 12px rgba(0,0,0,.25), 0 4px 10px rgba(196,136,30,.35);';
    icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3C2C08" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M5 4H4v2a3 3 0 0 0 3 3"/><path d="M19 4h1v2a3 3 0 0 1-3 3"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="8" y1="20" x2="16" y2="20"/></svg>';
    hdr.appendChild(icon);

    // Texto: título + contador
    var ttlWrap = document.createElement('div');
    ttlWrap.style.cssText = 'flex:1;min-width:0;';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:20px;font-weight:800;color:var(--tw);letter-spacing:-.5px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    ttl.textContent = resolveSelf ? 'Mis récords' : ('Récords de ' + (displayName || 'Runner'));
    var counter = document.createElement('div');
    counter.id = 'mr-prs-counter';
    counter.style.cssText = 'margin-top:8px;font-size:11px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;';
    // [Bloque B · UI premium] Loading dots animados durante fetch
    counter.innerHTML = '<span style="color:var(--tm);opacity:.75;font-weight:600;">Cargando récords</span>'
        + '<span class="mr-prs-dots" style="display:inline-flex;gap:2px;">'
            + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:0s;"></span>'
            + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:.2s;"></span>'
            + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:.4s;"></span>'
        + '</span>';
    ttlWrap.appendChild(ttl);
    ttlWrap.appendChild(counter);
    hdr.appendChild(ttlWrap);

    // Botón cerrar
    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;border:none;background:var(--bsoft);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    closeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ts)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    hdr.appendChild(closeBtn);
    hdrWrap.appendChild(hdr);
    sheet.appendChild(hdrWrap);

    // ── Contenedor scrollable que englobará ambas secciones ───────────
    var scrollArea = document.createElement('div');
    scrollArea.style.cssText = [
        'overflow-y:auto','overflow-x:hidden',
        '-webkit-overflow-scrolling:touch',
        'padding-bottom:max(16px,env(safe-area-inset-bottom,0px) + 14px)'
    ].join(';');

    // ── Grid de PRs ────────────────────────────────────────────────────
    var grid = document.createElement('div');
    grid.id = 'mr-prs-grid';
    grid.style.cssText = [
        'display:grid',
        'grid-template-columns:repeat(3,1fr)',
        'gap:8px',
        'padding:4px 14px 16px'
    ].join(';');

    // Crear cards de PRs en estado "sin marcar" inicialmente (placeholder con shimmer)
    ORDER.forEach(function(type) {
        var card = _buildPRGridCard(type, null, isDark);
        card.classList.add('mr-prs-card-skeleton');
        grid.appendChild(card);
    });
    scrollArea.appendChild(grid);

    // ── Divisor + título sección hitos ─────────────────────────────────
    var section2Title = document.createElement('div');
    section2Title.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 16px 8px;flex-shrink:0;';
    section2Title.innerHTML =
        '<div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#E8C76A 0%,#A88A2E 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(201,168,76,.35);">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3C2C08" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>' +
        '</div>' +
        '<div style="flex:1;min-width:0;line-height:1.2;">' +
            '<div style="font-size:14px;font-weight:800;color:var(--tw);">Hitos kilométricos</div>' +
            '<div style="font-size:10.5px;color:var(--tm);font-weight:600;margin-top:1px;">Acumulados de por vida — no se pierden nunca</div>' +
        '</div>';
    scrollArea.appendChild(section2Title);

    // ── Grid de hitos ──────────────────────────────────────────────────
    var gridMs = document.createElement('div');
    gridMs.id = 'mr-prs-milestones-grid';
    gridMs.style.cssText = [
        'display:grid',
        'grid-template-columns:repeat(3,1fr)',
        'gap:8px',
        'padding:0 14px 6px'
    ].join(';');
    ORDER_MILESTONES.forEach(function(type) {
        var card = _buildPRGridCard(type, null, isDark);
        card.classList.add('mr-prs-card-skeleton');
        gridMs.appendChild(card);
    });
    scrollArea.appendChild(gridMs);

    // ── [FASE 8] Divisor + título sección Hitos de RACHA ──────────────
    var section3Title = document.createElement('div');
    section3Title.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 16px 8px;flex-shrink:0;';
    section3Title.innerHTML =
        '<div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#FFB347 0%,#C25A28 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(224,122,40,.45);">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3D1A08" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 C12 2 6 8 6 13 a6 6 0 0 0 12 0 C18 8 12 2 12 2 z"/></svg>' +
        '</div>' +
        '<div style="flex:1;min-width:0;line-height:1.2;">' +
            '<div style="font-size:14px;font-weight:800;color:var(--tw);">Hitos de racha</div>' +
            '<div style="font-size:10.5px;color:var(--tm);font-weight:600;margin-top:1px;">Días seguidos sin descanso — proeza máxima</div>' +
        '</div>';
    scrollArea.appendChild(section3Title);

    // ── Grid de hitos de racha (3 columnas, 1 fila) ───────────────────
    var gridStreak = document.createElement('div');
    gridStreak.id = 'mr-prs-streak-grid';
    gridStreak.style.cssText = [
        'display:grid',
        'grid-template-columns:repeat(3,1fr)',
        'gap:8px',
        'padding:0 14px 6px'
    ].join(';');
    ORDER_STREAK_MILESTONES.forEach(function(type) {
        var card = _buildPRGridCard(type, null, isDark);
        card.classList.add('mr-prs-card-skeleton');
        gridStreak.appendChild(card);
    });
    scrollArea.appendChild(gridStreak);

    sheet.appendChild(scrollArea);

    back.appendChild(sheet);
    document.body.appendChild(back);

    // Animación de entrada
    requestAnimationFrame(function() {
        back.style.opacity = '1';
        sheet.style.transform = 'translateY(0)';
    });

    // ── E3: carga real de récords desde Supabase ─────────────────────
    // [Bloque B · UI premium] Las cards arrancan con clase mr-prs-card-skeleton
    // (shimmer animado). Al llegar los datos, las reemplazamos por las reales
    // con animación stagger.
    (async function loadRecords() {
        try {
            if (!sb) throw new Error('Sin Supabase');
            // Resolver UUID real si es perfil propio
            var targetUid = userId;
            if (resolveSelf) {
                var sessRes = await sb.auth.getSession();
                var s = sessRes && sessRes.data && sessRes.data.session;
                if (!s) throw new Error('Sin sesión');
                targetUid = s.user.id;
            }
            // Consultar récords del usuario
            var qres = await sb.from('user_records')
                .select('record_type,value,activity_local_id,activity_datestr,achieved_at')
                .eq('user_id', targetUid);
            if (qres.error) throw qres.error;
            var rows = qres.data || [];
            // Indexar por record_type
            var byType = {};
            rows.forEach(function(r) { byType[r.record_type] = r; });

            // Re-renderizar AMBOS grids con datos reales
            // [Bloque B · UI premium] Stagger entrance: cards aparecen escalonadas
            grid.innerHTML = '';
            var marked = 0;
            ORDER.forEach(function(type, idx) {
                var rec = byType[type] || null;
                if (rec) marked++;
                var card = _buildPRGridCard(type, rec, isDark);
                card.classList.add('mr-prs-card-stagger');
                card.style.animationDelay = (idx * 28) + 'ms';
                grid.appendChild(card);
            });
            gridMs.innerHTML = '';
            var unlocked = 0;
            ORDER_MILESTONES.forEach(function(type, idx) {
                var rec = byType[type] || null;
                if (rec) unlocked++;
                var card = _buildPRGridCard(type, rec, isDark);
                card.classList.add('mr-prs-card-stagger');
                // Hitos arrancan tras los récords para encadenar fluidamente
                card.style.animationDelay = ((ORDER.length * 28) + idx * 22) + 'ms';
                gridMs.appendChild(card);
            });
            // [FASE 8] Grid de hitos racha
            gridStreak.innerHTML = '';
            var streakUnlocked = 0;
            ORDER_STREAK_MILESTONES.forEach(function(type, idx) {
                var rec = byType[type] || null;
                if (rec) streakUnlocked++;
                var card = _buildPRGridCard(type, rec, isDark);
                card.classList.add('mr-prs-card-stagger');
                card.style.animationDelay = ((ORDER.length * 28) + (ORDER_MILESTONES.length * 22) + idx * 22) + 'ms';
                gridStreak.appendChild(card);
            });
            // [Bloque B · UI premium] Sustituir loading dots por contador real
            // [FASE 8] Ampliado a 18 récords (12+6) + 12 hitos km + 3 hitos racha
            // [P.Records Opción A] Jerarquía visual: número XL + total gris + label uppercase
            counter.innerHTML =
                  '<span style="display:inline-flex;align-items:baseline;gap:4px;">'
                +   '<span style="font-size:13px;font-weight:800;color:var(--tw);letter-spacing:-.3px;">' + marked + '</span>'
                +   '<span style="color:var(--tm);font-weight:600;font-size:10px;">/ ' + ORDER.length + '</span>'
                +   '<span style="font-size:9px;color:var(--ts);font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-left:2px;">Récords</span>'
                + '</span>'
                + '<span style="display:inline-flex;align-items:baseline;gap:4px;">'
                +   '<span style="font-size:13px;font-weight:800;color:var(--tw);letter-spacing:-.3px;">' + (unlocked + streakUnlocked) + '</span>'
                +   '<span style="color:var(--tm);font-weight:600;font-size:10px;">/ ' + (ORDER_MILESTONES.length + ORDER_STREAK_MILESTONES.length) + '</span>'
                +   '<span style="font-size:9px;color:var(--ts);font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-left:2px;">Hitos</span>'
                + '</span>';
        } catch (e) {
            console.warn('[MR][PRs] load fail:', e && e.message ? e.message : e);
            // [Bloque B · UI premium] Sustituir loading dots por mensaje de error
            counter.innerHTML = '<span style="color:var(--tm);opacity:.85;">Error de carga</span>';
            // Mostrar mensaje de error reemplazando el grid
            grid.innerHTML = '';
            grid.classList.remove('mr-prs-card-skeleton');
            grid.style.display = 'flex';
            grid.style.flexDirection = 'column';
            grid.style.alignItems = 'center';
            grid.style.gap = '12px';
            grid.style.padding = '40px 20px';
            grid.style.opacity = '1';
            var errBox = document.createElement('div');
            errBox.style.cssText = 'text-align:center;color:var(--tm);font-size:13px;line-height:1.5;font-family:var(--f);max-width:280px;';
            errBox.innerHTML = '<div style="font-size:32px;margin-bottom:8px;">⚠️</div>'
                + '<div style="font-weight:700;color:var(--tw);margin-bottom:4px;">No se pudieron cargar los récords</div>'
                + '<div style="font-size:11.5px;">Comprueba tu conexión e inténtalo de nuevo.</div>';
            grid.appendChild(errBox);
            var retryBtn = document.createElement('button');
            retryBtn.style.cssText = 'margin-top:6px;padding:8px 18px;border-radius:14px;border:1.5px solid var(--gold-bd);background:var(--gold-lt);color:var(--gold);font-family:var(--f);font-size:12px;font-weight:800;cursor:pointer;';
            retryBtn.textContent = 'Reintentar';
            retryBtn.onclick = function() {
                // [Bloque B · UI premium] Restaurar loading dots y shimmer
                counter.innerHTML = '<span style="opacity:.75;">Cargando récords</span>'
                    + '<span class="mr-prs-dots" style="display:inline-flex;gap:2px;">'
                        + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:0s;"></span>'
                        + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:.2s;"></span>'
                        + '<span style="width:3px;height:3px;border-radius:50%;background:var(--gold);animation:mrPrsDot 1.4s infinite;animation-delay:.4s;"></span>'
                    + '</span>';
                // Volver a los grids originales y relanzar
                grid.style.display = 'grid';
                grid.style.flexDirection = '';
                grid.style.alignItems = '';
                grid.style.gap = '8px';
                grid.style.padding = '4px 14px 16px';
                grid.innerHTML = '';
                ORDER.forEach(function(type) {
                    var c = _buildPRGridCard(type, null, isDark);
                    c.classList.add('mr-prs-card-skeleton');
                    grid.appendChild(c);
                });
                gridMs.innerHTML = '';
                ORDER_MILESTONES.forEach(function(type) {
                    var c = _buildPRGridCard(type, null, isDark);
                    c.classList.add('mr-prs-card-skeleton');
                    gridMs.appendChild(c);
                });
                // [FASE 8] Grid streak también al retry
                gridStreak.innerHTML = '';
                ORDER_STREAK_MILESTONES.forEach(function(type) {
                    var c = _buildPRGridCard(type, null, isDark);
                    c.classList.add('mr-prs-card-skeleton');
                    gridStreak.appendChild(c);
                });
                loadRecords();
            };
            grid.appendChild(retryBtn);
        }
    })();

    // ── Cierre ────────────────────────────────────────────────────────
    function closeMe() {
        back.style.opacity = '0';
        sheet.style.transform = 'translateY(40px)';
        setTimeout(function() { if (back.parentNode) back.remove(); }, 280);
        document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') closeMe(); }
    document.addEventListener('keydown', onKey);
    closeBtn.onclick = closeMe;
    back.addEventListener('click', function(e) { if (e.target === back) closeMe(); });
}

// ── Card individual del grid ─────────────────────────────────────────
// rec: null (sin marcar) o { value, formatted, activity_local_id, activity_datestr }
function _buildPRGridCard(type, rec, isDark) {
    var meta = (typeof window._getPRMeta === 'function') ? window._getPRMeta(type) : null;
    if (!meta) meta = { tier:'gold', label:type, centerText:'PR' };
    var marked = !!rec;

    // [P.Records Opción A] Mapping tier → color del accent bar superior.
    // Cada card tiene una línea corta de 2px del color del tier (fade a los lados)
    // que da identidad visual sin sobrecargar. Cubre todos los tiers de PR_META.
    var TIER_ACCENT = {
        trophy_dark:'#a16207', trophy_navy:'#1e40af',
        gold:'#c4881e', silver:'#a8afb8', track:'#a56236',
        lightning:'#f97316', mountain:'#10b981',
        flame:'#dc2626', snow:'#3b82f6',
        milestone_bronze:'#a56236', milestone_silver:'#a8afb8', milestone_gold:'#c4881e',
        milestone_platinum:'#d4d4d8', milestone_diamond:'#22d3ee',
        streak_fire:'#f97316', streak_15:'#fb923c', streak_30:'#f97316', streak_100:'#dc2626',
        cadence_metro:'#8b5cf6', heart_zen:'#3b82f6',
        week_calendar:'#0ea5e9', month_calendar:'#0284c7',
        efficiency_spark:'#eab308'
    };
    var accentCol = TIER_ACCENT[meta.tier] || '#a1a1aa';

    var card = document.createElement('div');
    card.style.cssText = [
        'position:relative','overflow:hidden',
        'background:' + (marked ? 'var(--card)' : (isDark ? 'rgba(255,255,255,.03)' : 'var(--bsoft)')),
        'border:1px solid var(--border)',
        'border-radius:14px',
        'padding:14px 8px 12px',
        'display:flex','flex-direction:column','align-items:center',
        'gap:4px','min-width:0',
        'transition:transform .15s ease, box-shadow .15s ease',
        marked ? 'cursor:pointer' : 'cursor:default',
        marked ? 'box-shadow:0 1px 3px rgba(0,0,0,.05), 0 0 0 1px rgba(0,0,0,.04)' : ''
    ].filter(Boolean).join(';');

    // [P.Records Opción A] Accent bar superior con color del tier
    // (fade a los lados). Opacity reducido si no marked → sutil identificador.
    var accent = document.createElement('div');
    accent.style.cssText = 'position:absolute;top:0;left:20%;right:20%;height:2px;background:linear-gradient(90deg, transparent, ' + accentCol + ', transparent);' + (marked ? '' : 'opacity:.25;');
    card.appendChild(accent);

    // Medalla SVG
    var medalWrap = document.createElement('div');
    medalWrap.style.cssText = 'width:48px;height:54px;display:flex;align-items:center;justify-content:center;margin-top:4px;' + (marked ? '' : 'filter:grayscale(1) opacity(.45);');
    if (typeof window._buildMedalSVG === 'function') {
        var svg = window._buildMedalSVG(meta);
        medalWrap.innerHTML = svg.replace('width="56" height="64"', 'width="48" height="54"');
    }
    card.appendChild(medalWrap);

    // Label del tipo
    var lblEl = document.createElement('div');
    lblEl.style.cssText = 'font-size:9px;font-weight:800;color:' + (marked ? 'var(--ts)' : 'var(--tm)') + ';text-align:center;letter-spacing:.9px;text-transform:uppercase;line-height:1.15;min-height:22px;display:flex;align-items:center;justify-content:center;';
    lblEl.textContent = meta.label || type;
    card.appendChild(lblEl);

    // ¿Es un hito kilométrico acumulado o un hito de racha?
    // [FASE 8] Incluimos también streak_* en la categoría hito
    var isMilestone = (typeof type === 'string') && (type.indexOf('km_') === 0 || type.indexOf('streak_') === 0);

    // Valor · XL con tabular-nums y letter-spacing negativo para elegancia
    var valEl = document.createElement('div');
    valEl.style.cssText = 'font-size:19px;font-weight:800;color:' + (marked ? 'var(--tw)' : 'var(--tm)') + ';letter-spacing:-.6px;line-height:1;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums;';
    if (marked && typeof window._formatRecordValue === 'function') {
        valEl.textContent = window._formatRecordValue(type, rec.value);
    } else if (isMilestone && typeof window._formatRecordValue === 'function') {
        // Hito sin desbloquear: mostrar el objetivo en gris
        valEl.textContent = window._formatRecordValue(type, null);
    } else {
        valEl.textContent = '—';
    }
    card.appendChild(valEl);

    // Subtítulo (fecha en pill sutil / "Sin marcar" / "Sin desbloquear")
    var subEl = document.createElement('div');
    if (marked && rec.activity_datestr) {
        // Fecha en pill bg-soft con letter-spacing y uppercase (jerarquía)
        subEl.style.cssText = 'display:inline-block;margin-top:8px;padding:2px 8px;background:var(--bsoft);border-radius:10px;font-size:9px;color:var(--ts);font-weight:700;letter-spacing:.4px;text-transform:uppercase;line-height:1.3;white-space:nowrap;';
        subEl.textContent = _prsPrettyDate(rec.activity_datestr);
    } else {
        subEl.style.cssText = 'margin-top:8px;font-size:9px;color:var(--tm);text-align:center;opacity:.85;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;';
        subEl.textContent = isMilestone ? 'Sin desbloquear' : 'Sin marcar';
    }
    card.appendChild(subEl);

    // Click (solo si marcado) — E4 implementará la apertura de actividad
    if (marked) {
        card.addEventListener('click', function() {
            // Hook para E4: abrir actividad si está disponible localmente
            if (typeof window._openPRActivity === 'function') {
                window._openPRActivity(rec);
            }
        });
        card.addEventListener('touchstart', function() { card.style.transform = 'scale(.97)'; }, { passive:true });
        card.addEventListener('touchend',   function() { card.style.transform = '';            }, { passive:true });
    }

    return card;
}

// Helper de fecha bonita "YYYY-MM-DD" → "18 abr 2026"
function _prsPrettyDate(dateStr) {
    try {
        var parts = String(dateStr).split('-').map(Number);
        var meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        return parts[2] + ' ' + meses[parts[1]-1] + ' ' + parts[0];
    } catch(_) { return dateStr; }
}

window._openPRsSheet = _openPRsSheet;
window._buildPRGridCard = _buildPRGridCard;

// ── E4: click en card de PR → abrir actividad si está disponible ─────
// rec: { value, formatted, activity_local_id, activity_datestr }
function _openPRActivity(rec) {
    if (!rec || !rec.activity_local_id) return;
    var localId = String(rec.activity_local_id);
    // Buscar la actividad en IndexedDB local
    var acts = (typeof window._getActivities === 'function') ? window._getActivities() : [];
    var act = null;
    for (var i = 0; i < acts.length; i++) {
        if (String(acts[i].id) === localId) { act = acts[i]; break; }
    }
    if (!act) {
        // Actividad no disponible localmente (típico en perfiles ajenos
        // o si se importó desde otro dispositivo)
        if (typeof showToast === 'function') {
            showToast('Esta actividad no está disponible en este dispositivo', 3500);
        }
        return;
    }
    // Cerrar el sheet de PRs antes de navegar
    var sheet = document.getElementById('mr-prs-sheet');
    if (sheet) sheet.remove();
    // Navegar a la pestaña Biblioteca (actividades)
    var libBtn = document.querySelector('[data-target="activities"]');
    if (libBtn) {
        document.querySelectorAll('.nb').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
        libBtn.classList.add('active');
        var libView = document.getElementById('view-activities');
        if (libView) libView.classList.add('active');
    }
    // Abrir detalle de la actividad
    if (typeof window.openActivityDetail === 'function') {
        // Pequeño delay para que la transición de vista no choque con la apertura
        setTimeout(function() { window.openActivityDetail(act); }, 50);
    } else {
        console.warn('[MR][PRs] openActivityDetail no disponible');
    }
}
window._openPRActivity = _openPRActivity;

/* ── Helpers de formato temporal premium ──────────────────────────
   _relTime(ts): "hace un momento" / "hace 5 min" / "hace 2h" / "ayer" / "hace 3 días" / "15 may" / "15 may 2024"
   _imessageTime(ts): formato iMessage: "14:32" (hoy), "Ayer", "Lun", "15 may"
   _activityGroup(ts): "today" / "yesterday" / "thisWeek" / "earlier" */
function _relTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var s = Math.floor((now - d) / 1000);
    if (s < 60) return 'ahora';
    var m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    var midNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var midD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dDay = Math.round((midNow - midD) / 86400000);
    if (dDay === 1) return 'ayer';
    if (dDay < 7) return 'hace ' + dDay + ' días';
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('es-ES', {day:'numeric',month:'short'}).replace('.','');
    return d.toLocaleDateString('es-ES', {day:'numeric',month:'short',year:'numeric'}).replace('.','');
}
function _imessageTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var midNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var midD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dDay = Math.round((midNow - midD) / 86400000);
    if (dDay === 0) return d.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'});
    if (dDay === 1) return 'Ayer';
    if (dDay < 7) {
        var wd = d.toLocaleDateString('es-ES', {weekday:'short'}).replace('.','');
        return wd.charAt(0).toUpperCase() + wd.slice(1);
    }
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('es-ES', {day:'numeric',month:'short'}).replace('.','');
    return d.toLocaleDateString('es-ES', {day:'2-digit',month:'2-digit',year:'2-digit'});
}
function _activityGroup(ts) {
    if (!ts) return 'earlier';
    var d = new Date(ts), now = new Date();
    var midNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var midD = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dDay = Math.round((midNow - midD) / 86400000);
    if (dDay === 0) return 'today';
    if (dDay === 1) return 'yesterday';
    if (dDay < 7) return 'thisWeek';
    return 'earlier';
}

async function openClubActivity() {
    var sb = window._sbClient;
    var { data:{ session } } = await sb.auth.getSession();
    if (!session) return;
    var myId = session.user.id;

    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:20010;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);';

    // ── Cabecera estilo CLUB ──────────────────────────────────────
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+8px) 15px 14px;background:var(--bg);border-bottom:2px solid var(--gold-bd);position:relative;';
    // Accent radial sutil de fondo (mismo lenguaje que cabecera CLUB)
    var hdrAccent = document.createElement('div');
    hdrAccent.setAttribute('aria-hidden','true');
    hdrAccent.style.cssText = 'position:absolute;top:0;left:50%;transform:translateX(-50%);width:280px;height:120px;background:radial-gradient(ellipse at center top,rgba(143,26,40,.12) 0%,rgba(143,26,40,.04) 50%,transparent 75%);pointer-events:none;';
    hdr.appendChild(hdrAccent);
    var topRow = document.createElement('div');
    topRow.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:space-between;height:44px;';
    var bb = document.createElement('button');
    bb.style.cssText = 'width:42px;height:42px;border-radius:50%;border:1.5px solid var(--gold-bd);background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.06);';
    bb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    bb.onclick = function(){ ov.style.transform='translateX(100%)'; setTimeout(function(){ if(ov.parentNode) ov.remove(); }, 320); };
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);font-size:26px;font-weight:900;color:var(--crimson);letter-spacing:3px;text-align:center;pointer-events:none;';
    titleEl.textContent = 'ACTIVIDAD';
    var spacer = document.createElement('div'); spacer.style.cssText = 'width:42px;flex-shrink:0;';
    topRow.appendChild(bb); topRow.appendChild(titleEl); topRow.appendChild(spacer);
    hdr.appendChild(topRow);

    var list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 0 24px;background:var(--bg);';
    if (typeof fxSkeleton === 'function') {
        var skWrap = document.createElement('div');
        skWrap.style.cssText = 'padding:6px 18px;';
        fxSkeleton(skWrap, { count: 5, template: 'list' });
        list.appendChild(skWrap);
    } else {
        list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--tm);font-size:13px;">Cargando…</div>';
    }
    ov.appendChild(hdr); ov.appendChild(list);
    document.body.appendChild(ov);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ ov.style.transform = 'translateX(0)'; }); });

    // ── Carga de datos ─────────────────────────────────────────────
    var { data: myPosts } = await sb.from('club_posts').select('id,act_data').eq('user_id', myId);
    var myPostIds = (myPosts||[]).map(p=>p.id);
    var items = [];
    if (myPostIds.length) {
        var { data: reactions } = await sb.from('reactions')
            .select('emoji,user_id,post_id,created_at,profiles!reactions_user_id_fkey(username,display_name,avatar_url)')
            .in('post_id',myPostIds).neq('user_id',myId).order('created_at',{ascending:false}).limit(50);
        (reactions||[]).forEach(function(r) {
            items.push({type:'reaction',ts:r.created_at,username:r.profiles?.display_name||r.profiles?.username||'?',avatar:r.profiles?.avatar_url,emoji:r.emoji,text:'reaccionó a tu post',userId:r.user_id});
        });
        try {
            var { data: comments } = await sb.from('post_comments')
                .select('content,user_id,post_id,created_at,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)')
                .in('post_id',myPostIds).neq('user_id',myId).order('created_at',{ascending:false}).limit(50);
            (comments||[]).forEach(function(c) {
                var preview = (c.content || '').substring(0, 60);
                if (c.content && c.content.length > 60) preview += '…';
                items.push({type:'comment',ts:c.created_at,username:c.profiles?.display_name||c.profiles?.username||'?',avatar:c.profiles?.avatar_url,text:'comentó: '+preview,userId:c.user_id});
            });
        } catch(e) {}
    }
    // ── Respuestas a comentarios míos (en cualquier post, no solo los míos) ──
    try {
        var { data: myComments } = await sb.from('post_comments').select('id').eq('user_id', myId);
        var myCommentIds = (myComments || []).map(function(c){ return c.id; });
        if (myCommentIds.length) {
            var { data: replies } = await sb.from('post_comments')
                .select('content,user_id,parent_comment_id,created_at,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)')
                .in('parent_comment_id', myCommentIds)
                .neq('user_id', myId)
                .order('created_at', {ascending:false}).limit(50);
            (replies||[]).forEach(function(r) {
                var preview = (r.content || '').substring(0, 60);
                if (r.content && r.content.length > 60) preview += '…';
                items.push({type:'reply',ts:r.created_at,username:r.profiles?.display_name||r.profiles?.username||'?',avatar:r.profiles?.avatar_url,text:'respondió a tu comentario: '+preview,userId:r.user_id});
            });
        }
    } catch(e) { /* parent_comment_id columna ausente — ignorar */ }
    var { data: newFollows } = await sb.from('follows')
        .select('follower_id,created_at,profiles!follows_follower_id_fkey(username,display_name,avatar_url)')
        .eq('following_id',myId).order('created_at',{ascending:false}).limit(30);
    (newFollows||[]).forEach(function(f) {
        items.push({type:'follow',ts:f.created_at,username:f.profiles?.display_name||f.profiles?.username||'?',avatar:f.profiles?.avatar_url,text:'empezó a seguirte',userId:f.follower_id});
    });
    items.sort(function(a,b){ return new Date(b.ts)-new Date(a.ts); });

    var dot = document.getElementById('club-notif-dot');
    if (dot) dot.style.display = 'none';
    localStorage.setItem(_uk('mr_last_activity_check'), new Date().toISOString());

    if (!items.length) {
        list.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 30px;color:var(--tm);text-align:center;">'
            + '<div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(196,136,30,.15),rgba(143,26,40,.10));display:flex;align-items:center;justify-content:center;margin-bottom:16px;border:1.5px solid var(--gold-bd);">'
            + '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
            + '</div>'
            + '<div style="font-size:15px;font-weight:700;color:var(--tw);margin-bottom:4px;">Sin actividad aún</div>'
            + '<div style="font-size:12px;color:var(--tm);line-height:1.5;">Las reacciones, comentarios<br>y seguidores nuevos aparecerán aquí.</div>'
            + '</div>';
        return;
    }

    // ── Agrupar por fecha ──────────────────────────────────────────
    var groups = {today:[], yesterday:[], thisWeek:[], earlier:[]};
    items.forEach(function(it){ groups[_activityGroup(it.ts)].push(it); });
    var groupLabels = {today:'HOY', yesterday:'AYER', thisWeek:'ESTA SEMANA', earlier:'ANTES'};
    var order = ['today','yesterday','thisWeek','earlier'];

    list.innerHTML = '';
    order.forEach(function(g){
        if (!groups[g].length) return;
        var lbl = document.createElement('div');
        lbl.style.cssText = 'padding:14px 18px 6px;font-size:10.5px;font-weight:800;color:var(--tm);letter-spacing:1.2px;text-transform:uppercase;';
        lbl.textContent = groupLabels[g];
        list.appendChild(lbl);
        groups[g].forEach(function(item){
            list.appendChild(_buildActivityRow(item, ov));
        });
    });

    // Animación stagger sobre las filas
    if (typeof _staggerIn === 'function') {
        var rows = list.querySelectorAll('[data-act-row]');
        _staggerIn(rows, {delayStep:30, duration:300});
    }
}

/* Construye una fila premium de actividad */
function _buildActivityRow(item, ov) {
    var row = document.createElement('div');
    row.setAttribute('data-act-row','1');
    row.style.cssText = 'display:flex;align-items:center;gap:13px;padding:11px 18px;cursor:pointer;background:var(--bg);transition:background .15s;';
    row.addEventListener('touchstart', function(){ row.style.background = 'var(--bsoft)'; }, {passive:true});
    row.addEventListener('touchend', function(){ setTimeout(function(){ row.style.background = 'var(--bg)'; },120); }, {passive:true});
    row.addEventListener('mouseenter', function(){ row.style.background = 'var(--bsoft)'; });
    row.addEventListener('mouseleave', function(){ row.style.background = 'var(--bg)'; });

    // ── Avatar con mini-badge superpuesto ─────────────────────────
    var avWrap = document.createElement('div');
    avWrap.style.cssText = 'position:relative;width:46px;height:46px;flex-shrink:0;';
    var av = document.createElement('div');
    av.style.cssText = 'width:46px;height:46px;border-radius:50%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.10);';
    if (item.avatar) { var i=document.createElement('img');i.src=item.avatar;i.loading='lazy';i.style.cssText='width:100%;height:100%;object-fit:cover;';av.appendChild(i); }
    else av.textContent = (item.username||'?')[0].toUpperCase();
    avWrap.appendChild(av);

    // Mini-badge según tipo
    var badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;bottom:-2px;right:-2px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg);box-shadow:0 1px 3px rgba(0,0,0,.20);';
    if (item.type === 'reaction') {
        badge.style.background = 'linear-gradient(135deg,#f43f5e,#e11d48)';
        // emoji real de la reacción dentro del badge (más rico que un icono genérico)
        badge.innerHTML = '<span style="font-size:10px;line-height:1;">'+(item.emoji||'❤')+'</span>';
    } else if (item.type === 'follow') {
        badge.style.background = 'linear-gradient(135deg,#3b82f6,#1d4ed8)';
        badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>';
    } else if (item.type === 'comment') {
        badge.style.background = 'linear-gradient(135deg,#10b981,#059669)';
        badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    } else if (item.type === 'reply') {
        badge.style.background = 'linear-gradient(135deg,#a855f7,#7c3aed)';
        badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
    } else {
        badge.style.background = 'var(--gold)';
        badge.innerHTML = '<span style="font-size:10px;line-height:1;color:#fff;font-weight:700;">·</span>';
    }
    avWrap.appendChild(badge);

    // ── Cuerpo: username + texto evento ───────────────────────────
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;line-height:1.35;';
    var line1 = document.createElement('div');
    line1.style.cssText = 'font-size:13.5px;color:var(--tw);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
    line1.innerHTML = '<strong style="font-weight:700;">'+item.username+'</strong> <span style="color:var(--ts);">'+item.text+'</span>';
    body.appendChild(line1);

    // ── Tiempo relativo ───────────────────────────────────────────
    var t = document.createElement('div');
    t.style.cssText = 'flex-shrink:0;font-size:11.5px;color:var(--tm);font-weight:500;white-space:nowrap;align-self:center;';
    t.textContent = _relTime(item.ts);

    row.appendChild(avWrap); row.appendChild(body); row.appendChild(t);
    row.onclick = function(){
        ov.style.transform='translateX(100%)';
        setTimeout(function(){ if(ov.parentNode) ov.remove(); openUserProfile(item.userId,item.username,item.avatar); }, 320);
    };
    return row;
}

async function _openBlockMenu(anchorBtn, targetId, targetName) {
    // Cerrar otro menú abierto si existe
    var prev = document.getElementById('mr-block-menu');
    if (prev) { prev.remove(); return; }

    var muted   = isMuted(targetId);
    var blocked = isBlocked(targetId);

    var menu = document.createElement('div');
    menu.id = 'mr-block-menu';
    var rect = anchorBtn.getBoundingClientRect();
    // Posicionar a la derecha-debajo del botón, alineado al borde derecho
    var top = rect.bottom + 6, right = window.innerWidth - rect.right;
    menu.style.cssText = 'position:fixed;top:'+top+'px;right:'+right+'px;'
        + 'background:var(--card);border:1px solid var(--border);border-radius:10px;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,.25);min-width:160px;padding:4px 0;'
        + 'font-family:var(--f);font-size:12.5px;z-index:99999;';

    function rowHTML(icon, label, color, danger) {
        return '<div style="padding:10px 14px;display:flex;align-items:center;gap:9px;color:'
             + (color||'var(--tw)')+';cursor:pointer;font-weight:600;" '
             + 'onmouseover="this.style.background=\'var(--card2,var(--bsoft,rgba(127,127,127,.08)))\'" '
             + 'onmouseout="this.style.background=\'transparent\'">'
             + icon + '<span>' + label + '</span></div>';
    }
    var muteIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 12 19 8 23 4"/><line x1="13" y1="12" x2="23" y2="12"/><path d="M1 12h4l2 7h12l4-12"/></svg>';
    var blockIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';

    menu.innerHTML = ''
        + '<div data-action="mute">' + rowHTML(muteIcon, muted ? 'Quitar silencio' : 'Silenciar', null) + '</div>'
        + '<div style="height:1px;background:var(--border);"></div>'
        + '<div data-action="block">' + rowHTML(blockIcon, blocked ? 'Desbloquear' : 'Bloquear', '#ef4444') + '</div>';

    // Cerrar al pulsar fuera
    function dismiss(ev) {
        if (!menu.contains(ev.target) && ev.target !== anchorBtn) {
            menu.remove();
            document.removeEventListener('mousedown', dismiss, true);
            document.removeEventListener('touchstart', dismiss, true);
        }
    }
    setTimeout(function() {
        document.addEventListener('mousedown', dismiss, true);
        document.addEventListener('touchstart', dismiss, true);
    }, 0);

    menu.querySelector('[data-action="mute"]').onclick = async function() {
        menu.remove();
        var ok = await setUserBlockState(targetId, 'mute', !muted);
        if (ok) {
            _showBlockToast(muted ? 'Silencio retirado a @' + targetName : 'Silenciado @' + targetName);
            // Refrescar feed si está visible
            if (typeof renderClubFeed === 'function') renderClubFeed();
        }
    };
    menu.querySelector('[data-action="block"]').onclick = async function() {
        menu.remove();
        if (!blocked) {
            if (!confirm('¿Bloquear a @' + targetName + '? Dejaréis de seguiros y no podréis interactuar.')) return;
        }
        var ok = await setUserBlockState(targetId, 'block', !blocked);
        if (ok) {
            _showBlockToast(blocked ? 'Desbloqueado @' + targetName : 'Bloqueado @' + targetName);
            // Si bloqueé desde su perfil, lo cierro (ya no debería verlo)
            if (!blocked) {
                var ov = document.querySelector('[data-up-overlay]');
                if (ov) ov.remove();
                if (typeof renderClubFeed === 'function') renderClubFeed();
            } else {
                if (typeof renderClubFeed === 'function') renderClubFeed();
            }
        }
    };

    document.body.appendChild(menu);
}
window._openBlockMenu = _openBlockMenu;

function _showBlockToast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
        + 'background:#1a1f2e;color:#fff;padding:10px 16px;border-radius:10px;'
        + 'font-family:var(--f);font-size:12px;font-weight:600;z-index:99998;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:80%;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() {
        t.style.transition = 'opacity .3s';
        t.style.opacity = '0';
        setTimeout(function() { t.remove(); }, 320);
    }, 2200);
}

async function openUserProfile(userId, username, avatarUrl) {
    var sb = window._sbClient;
    var { data:{ session } } = await sb.auth.getSession();
    if (!session) return;
    var myId = session.user.id;
    var ov = document.createElement('div');
    ov.setAttribute('data-up-overlay', '1');
    ov.style.cssText = 'position:fixed;inset:0;z-index:20015;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;';
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+8px) 14px 0;background:var(--bg);position:relative;';

    // Top row: back + CLUB centrado + spacer
    var topRow = document.createElement('div');
    topRow.style.cssText = 'position:relative;display:flex;align-items:center;gap:8px;height:38px;margin-bottom:10px;';
    var bb = document.createElement('button');
    bb.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1.5px solid var(--gold-bd);background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    bb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    bb.onclick = function(){ _setThemeColor('#8f1a28'); ov.remove(); };
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);font-size:25px;font-weight:900;color:var(--crimson);letter-spacing:4px;text-align:center;pointer-events:none;';
    titleEl.textContent = 'CLUB';
    var spacer = document.createElement('div'); spacer.style.cssText = 'width:38px;flex-shrink:0;';
    topRow.appendChild(bb); topRow.appendChild(titleEl);
    var topFlex = document.createElement('div'); topFlex.style.cssText = 'flex:1;';
    topRow.appendChild(topFlex);
    topRow.appendChild(spacer);
    hdr.appendChild(topRow);

    // ─── HERO CARD premium dorada ─────────────────────────────────────
    var hero = document.createElement('div');
    hero.style.cssText = 'background:linear-gradient(135deg,var(--card) 0%,var(--surface) 100%);border:1px solid var(--gold-bd);border-radius:16px;padding:12px 12px 10px;position:relative;overflow:hidden;';

    // Halo radial decorativo
    var halo = document.createElement('div');
    halo.setAttribute('aria-hidden', 'true');
    halo.style.cssText = 'position:absolute;top:-30px;right:-30px;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,rgba(196,136,30,.18) 0%,transparent 70%);pointer-events:none;';
    hero.appendChild(halo);

    // Row 1: avatar | nombre+kebab+bio | botón Seguir/Siguiendo
    var row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;align-items:center;gap:11px;position:relative;z-index:1;';

    // Avatar con anillo dorado conic
    var avWrap = document.createElement('div');
    avWrap.style.cssText = 'position:relative;width:54px;height:54px;flex-shrink:0;';
    var ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 140deg,#c4881e 0deg,#e8a825 90deg,#8f1a28 180deg,#c4881e 270deg,#e8a825 360deg);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;';
    avWrap.appendChild(ring);

    var av = document.createElement('div');
    av.style.cssText = 'position:absolute;inset:3px;border-radius:50%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;overflow:hidden;border:2px solid var(--card);box-shadow:0 3px 10px rgba(0,0,0,.16);cursor:pointer;';
    if (avatarUrl) {
        var ai=document.createElement('img'); ai.src=avatarUrl; ai.style.cssText='width:100%;height:100%;object-fit:cover;'; av.appendChild(ai);
        av.onclick = function() {
            var ov2=document.createElement('div'); ov2.style.cssText='position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;';
            ov2.onclick=function(){ov2.remove();};
            var img2=document.createElement('img'); img2.src=avatarUrl; img2.style.cssText='width:240px;height:240px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.2);';
            var nm2=document.createElement('div'); nm2.style.cssText='color:#fff;font-size:16px;font-weight:700;'; nm2.textContent=username||'';
            ov2.appendChild(img2); ov2.appendChild(nm2); document.body.appendChild(ov2);
        };
    } else av.textContent=(username||'?')[0].toUpperCase();
    avWrap.appendChild(av);

    // Bloque nombre+kebab+bio (centro)
    var nameBlock = document.createElement('div');
    nameBlock.style.cssText = 'flex:1;min-width:0;line-height:1.2;';
    var nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'flex:1;min-width:0;font-size:17px;font-weight:800;color:var(--tw);letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;';
    nameEl.textContent = username || '—';
    nameRow.appendChild(nameEl);
    // Kebab ⋯ con menú silenciar/bloquear
    var kebab = document.createElement('button');
    kebab.setAttribute('aria-label', 'Más opciones');
    kebab.style.cssText = 'width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.08);color:var(--tw);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    kebab.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
    kebab.onclick = function(e) {
        e.stopPropagation();
        _openBlockMenu(kebab, userId, username || 'Runner');
    };
    // Adaptar kebab al tema oscuro
    if (document.body.classList.contains('dark-mode')) kebab.style.background = 'rgba(255,255,255,.08)';
    nameRow.appendChild(kebab);
    nameBlock.appendChild(nameRow);

    var bioEl = document.createElement('div');
    bioEl.id = 'up-bio';
    bioEl.style.cssText = 'margin-top:2px;font-size:11.5px;font-weight:500;color:var(--tm);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-style:italic;opacity:.85;min-height:15px;';
    bioEl.textContent = '—';
    nameBlock.appendChild(bioEl);

    // Botón Seguir/Siguiendo grande a la derecha (en lugar del logo MR)
    var amFollowing = false;
    var fBtn = document.createElement('button');
    fBtn.style.cssText = 'flex-shrink:0;height:32px;padding:0 14px;border-radius:9px;border:1px solid rgba(0,0,0,.18);font-family:var(--f);font-size:12px;font-weight:800;cursor:pointer;letter-spacing:.3px;line-height:1;display:inline-flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.18);';
    var updFBtn = function(){
        fBtn.style.background = amFollowing ? '#22c55e' : '#ef4444';
        fBtn.textContent = amFollowing ? '✓ Siguiendo' : '+ Seguir';
    };
    fBtn.onclick = async function() {
        if(amFollowing){ await sb.from('follows').delete().eq('follower_id',myId).eq('following_id',userId); amFollowing=false; }
        else { await sb.from('follows').insert({follower_id:myId,following_id:userId}); amFollowing=true; }
        updFBtn();
        var {count:fc}=await sb.from('follows').select('id',{count:'exact',head:true}).eq('following_id',userId);
        var foll = document.getElementById('up-followers'); if(foll) foll.textContent=fc||0;
    };

    row1.appendChild(avWrap);
    row1.appendChild(nameBlock);
    row1.appendChild(fBtn);
    hero.appendChild(row1);

    // Divider sutil dorado
    var divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:var(--gold-bd);margin:10px 0 9px;opacity:.5;position:relative;z-index:1;';
    hero.appendChild(divider);

    // Row 2: stats grandes con separadores verticales
    var row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;align-items:center;gap:8px;position:relative;z-index:1;';
    row2.innerHTML = ''
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="up-posts">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Posts</div>'
        + '</div>'
        + '<div style="width:1px;height:22px;background:var(--gold-bd);opacity:.4;flex-shrink:0;"></div>'
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="up-followers">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Seguidores</div>'
        + '</div>'
        + '<div style="width:1px;height:22px;background:var(--gold-bd);opacity:.4;flex-shrink:0;"></div>'
        + '<div style="flex:1;text-align:center;">'
        +   '<div style="font-size:14px;font-weight:900;color:var(--tw);line-height:1;"><span id="up-following">—</span></div>'
        +   '<div style="font-size:9.5px;color:var(--tm);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.4px;">Siguiendo</div>'
        + '</div>';
    hero.appendChild(row2);

    // Row 3: quick actions Heatmap + PRs
    var row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;gap:6px;margin-top:9px;position:relative;z-index:1;';
    var upHm = document.createElement('button');
    upHm.style.cssText = 'flex:1;height:30px;border-radius:9px;border:1px solid var(--gold-bd);background:var(--bg);color:var(--tw);font-family:var(--f);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;letter-spacing:.2px;';
    upHm.innerHTML = '<span style="font-size:13px;line-height:1;">🔥</span>Heatmap';
    (function(_uid, _uname) {
        upHm.onclick = function() { openHeatmap(_uid, _uname); };
    })(userId, username || 'Runner');
    var upPRs = document.createElement('button');
    upPRs.style.cssText = 'flex:1;height:30px;border-radius:9px;border:1px solid var(--gold-bd);background:var(--bg);color:var(--tw);font-family:var(--f);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;letter-spacing:.2px;';
    upPRs.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M5 4H4v2a3 3 0 0 0 3 3"/><path d="M19 4h1v2a3 3 0 0 1-3 3"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="8" y1="20" x2="16" y2="20"/></svg>PRs';
    (function(_uid, _uname) {
        upPRs.onclick = function() { _openPRsSheet(_uid, _uname, false); };
    })(userId, username || 'Runner');
    row3.appendChild(upHm);
    row3.appendChild(upPRs);
    hero.appendChild(row3);

    hdr.appendChild(hero);

    // Spacer bajo la hero card antes del feed
    var heroSpacer = document.createElement('div');
    heroSpacer.style.cssText = 'height:12px;';
    hdr.appendChild(heroSpacer);

    var feed = document.createElement('div');
    feed.id = 'profile-feed-' + userId;
    feed.style.cssText = 'flex:1;overflow-y:auto;padding:10px 15px 80px;display:block;';
    feed.innerHTML = '<div style="text-align:center;padding:20px;color:var(--tm);">Cargando posts...</div>';
    ov.appendChild(hdr); ov.appendChild(feed);
    document.body.appendChild(ov);

    // Load stats + follow state + bio in parallel
    const [{count:pc},{count:flc},{count:fgc},{data:fchk},bioRes] = await Promise.all([
        sb.from('club_posts').select('id',{count:'exact',head:true}).eq('user_id',userId),
        sb.from('follows').select('id',{count:'exact',head:true}).eq('following_id',userId),
        sb.from('follows').select('id',{count:'exact',head:true}).eq('follower_id',userId),
        sb.from('follows').select('id').eq('follower_id',myId).eq('following_id',userId),
        // Bio: graceful failure if column doesn't exist
        sb.from('profiles').select('bio').eq('id',userId).single().then(function(r){return r;}).catch(function(){return {data:null};})
    ]);
    document.getElementById('up-posts').textContent=pc||0;
    document.getElementById('up-followers').textContent=flc||0;
    document.getElementById('up-following').textContent=fgc||0;
    amFollowing=(fchk||[]).length>0; updFBtn();

    // Render bio (real text if filled, "—" placeholder otherwise)
    var bioText = '';
    if (bioRes && bioRes.data && typeof bioRes.data.bio === 'string') bioText = bioRes.data.bio.trim();
    var bioElLive = document.getElementById('up-bio');
    if (bioElLive) {
        if (bioText) {
            bioElLive.textContent = bioText;
            bioElLive.style.fontStyle = '';
            bioElLive.style.opacity = '';
            bioElLive.style.color = 'var(--tm)';
        } else {
            bioElLive.textContent = 'Sin bio';
            bioElLive.style.fontStyle = 'italic';
            bioElLive.style.opacity = '.6';
        }
    }

    var {data:posts} = await sb.from('club_posts')
        .select('*, profiles!club_posts_user_id_fkey(id,username,display_name,avatar_url), reactions(id,user_id,emoji)')
        .eq('user_id',userId).order('created_at',{ascending:false}).limit(30);

    // Cargar perfiles de etiquetados (igual que renderClubFeed)
    var taggedProfilesMap = {};
    try {
        var allTaggedIds = new Set();
        (posts || []).forEach(function(p) {
            if (Array.isArray(p.tagged_user_ids)) {
                p.tagged_user_ids.forEach(function(id){ if (id) allTaggedIds.add(id); });
            }
        });
        if (allTaggedIds.size > 0) {
            var { data: tagProfs } = await sb.from('profiles').select('id, username, display_name, avatar_url').in('id', Array.from(allTaggedIds));
            (tagProfs || []).forEach(function(p){ taggedProfilesMap[p.id] = p; });
        }
    } catch(e) {}

    feed.innerHTML='';
    if(!posts||!posts.length){
        feed.innerHTML='<div style="text-align:center;padding:40px;color:var(--tm);font-size:13px;">Sin posts aún.</div>';
    } else {
        // Insertar cards con ids de canvas únicos para el perfil (prefijo 'prof-')
        // para evitar conflicto con los canvas del feed que tienen el mismo post id
        var _profStaggerStart = feed.children.length;
        posts.forEach(function(p) {
            var card = _buildClubCard(p, myId, new Set(), null, taggedProfilesMap);
            // Renombrar el canvas para que no colisione con el del feed
            var cv = card.querySelector('[id="club-map-' + p.id + '"]');
            if (cv) cv.id = 'prof-map-' + p.id;
            feed.appendChild(card);
        });
        try {
            var _profNew = Array.prototype.slice.call(feed.children, _profStaggerStart);
            if (typeof _staggerIn === 'function') _staggerIn(_profNew);
        } catch(_) {}

        // Copiar el track del feed al perfil, o dibujarlo si no está en el feed
        function _drawProfileTrack(p) {
            var actData = p.act_data || {};
            if (!actData.records || actData.records.length <= 10) return;
            if (typeof window.drawTrack !== 'function') return;

            // Canvas del perfil (id renombrado)
            var cv = document.getElementById('prof-map-' + p.id);
            if (!cv) return;

            // Canvas del feed (id original) — puede tener el track ya pintado
            var feedCanvas = document.getElementById('club-map-' + p.id);
            if (feedCanvas && feedCanvas.width > 10 && feedCanvas.height > 10) {
                // Copiar del feed al perfil — canvas distintos, sin conflicto
                try {
                    cv.width  = feedCanvas.width;
                    cv.height = feedCanvas.height;
                    cv.getContext('2d').drawImage(feedCanvas, 0, 0);
                    return;
                } catch(e) {}
            }

            // No está en el feed — dibujar directamente (con caché de Mapbox si existe)
            var pw = (cv.parentElement && cv.parentElement.offsetWidth > 10)
                ? cv.parentElement.offsetWidth : Math.round(window.innerWidth);
            var ph = (cv.parentElement && cv.parentElement.offsetHeight > 10)
                ? cv.parentElement.offsetHeight : 220;
            cv.width  = pw;
            cv.height = ph;
            try {
                if (typeof window.drawTrackFromCacheOrFallback === 'function') {
                    // cacheKey uses act.id/dateStr — same key drawTrackWithMapbox uses in detail view
                    var ck = actData.id || actData.dateStr || ('post-' + p.id);
                    window.drawTrackFromCacheOrFallback(cv, actData.records, actData.shoeColor || '', ck);
                } else {
                    window.drawTrack(cv, actData.records, actData.shoeColor || '');
                }
            } catch(e) {}
        }

        // Pasada a 200ms: el overlay ya tiene layout y el feed ya habrá pintado sus tracks (setTimeout 150ms)
        setTimeout(function() { posts.forEach(_drawProfileTrack); }, 200);
        // Pasada a 900ms: seguro para imagen satelital no cacheada
        setTimeout(function() { posts.forEach(_drawProfileTrack); }, 900);
    }
}

async function _checkClubDots() {
    try {
        var sb=window._sbClient;
        var {data:{session}}=await sb.auth.getSession();
        if(!session) return;
        var myId=session.user.id;
        var lastCheck=localStorage.getItem(_uk('mr_last_activity_check'))||'2020-01-01';
        var {data:myPosts}=await sb.from('club_posts').select('id').eq('user_id',myId);
        var myPostIds=(myPosts||[]).map(p=>p.id);
        var hasNew=false;
        if(myPostIds.length){var{count:rc}=await sb.from('reactions').select('id',{count:'exact',head:true}).in('post_id',myPostIds).neq('user_id',myId).gt('created_at',lastCheck);if(rc>0)hasNew=true;}
        // New comments on my posts (gracefully skip if table missing)
        if(myPostIds.length){
            try {
                var{count:cc}=await sb.from('post_comments').select('id',{count:'exact',head:true}).in('post_id',myPostIds).neq('user_id',myId).gt('created_at',lastCheck);
                if(cc>0)hasNew=true;
            } catch(e) {}
        }
        var{count:fc}=await sb.from('follows').select('id',{count:'exact',head:true}).eq('following_id',myId).gt('created_at',lastCheck);
        if(fc>0)hasNew=true;
        var dot=document.getElementById('club-notif-dot');
        if(dot)dot.style.display=hasNew?'block':'none';
        var{count:dc}=await sb.from('messages').select('id',{count:'exact',head:true}).eq('to_id',myId).is('read_at',null);
        var dmDot=document.getElementById('club-dm-dot');
        if(dmDot)dmDot.style.display=(dc>0)?'block':'none';
    } catch(e){}
}

// ── DOT del botón CLUB en el Home ──────────────────────────────────
// Indica que el usuario tiene algo del lado social que merece su atención:
//   (a) alguna invitación a crew pendiente, O
//   (b) algún reto activo en sus crews creado tras la última visita al Club.
// Se enciende sin abrir el Club; se apaga al entrar al Club (timestamp
// mr_last_crew_check) o al aceptar/rechazar la invitación.
async function _checkHomeCrewDot() {
    var homeDot = document.getElementById('home-club-dot');
    if (!homeDot) return;
    try {
        // (a) Invitaciones pendientes — ya vienen cacheadas en _myCrewInvites
        var hasInvites = (typeof getMyCrewInvites === 'function')
            && getMyCrewInvites().length > 0;
        // (b) Retos activos creados tras la última visita al Club
        var hasNewChallenge = false;
        var myCrewIds = (window._myCrewIds && window._myCrewIds.size > 0)
            ? Array.from(window._myCrewIds) : [];
        if (myCrewIds.length && window._sbClient) {
            var lastCheck = localStorage.getItem(_uk('mr_last_crew_check')) || '2020-01-01';
            try {
                var { count: cc } = await window._sbClient
                    .from('crew_challenges')
                    .select('id', { count: 'exact', head: true })
                    .in('crew_id', myCrewIds)
                    .eq('status', 'active')
                    .gt('created_at', lastCheck);
                if (cc > 0) hasNewChallenge = true;
            } catch (e) { /* tabla aún no existe → silencioso */ }
        }
        homeDot.style.display = (hasInvites || hasNewChallenge) ? 'block' : 'none';
    } catch (e) {
        // En cualquier fallo, ocultar el dot — preferimos falso negativo a falso positivo.
        homeDot.style.display = 'none';
    }
}
window._checkHomeCrewDot = _checkHomeCrewDot;

async function _loadClubHeaderStats() {
    try {
        var sb = window._sbClient;
        var { data:{ session } } = await sb.auth.getSession();
        if (!session) return;
        var myId = session.user.id;
        // Avatar + username
        var avEl = document.getElementById('club-hdr-avatar');
        var unEl = document.getElementById('club-hdr-username');
        if (avEl && unEl) {
            if (profileData.avatar && profileData.avatar.startsWith('data:')) {
                var img = document.createElement('img');
                img.src = profileData.avatar;
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                avEl.innerHTML = '';
                avEl.appendChild(img);
            } else {
                avEl.textContent = (profileData.name||'?')[0].toUpperCase();
            }
            unEl.textContent = profileData.name || '—';
            // Bio: always visible. Render via the shared helper (handles placeholder).
            // Click anywhere on the bio (filled or empty) → inline edit.
            var bioEl = document.getElementById('club-hdr-bio');
            if (bioEl) {
                // First, render from local data (instant)
                _renderClubHeaderBio(bioEl, profileData.bio);
                // Then try to pull the latest bio from Supabase (catches up if user
                // edited it from another device). Silently no-op if column missing.
                (async function() {
                    try {
                        var { data: prof, error } = await sb.from('profiles').select('bio').eq('id', myId).single();
                        if (!error && prof && typeof prof.bio === 'string') {
                            if ((prof.bio || '').trim() !== (profileData.bio || '').trim()) {
                                profileData.bio = prof.bio || '';
                                _renderClubHeaderBio(bioEl, profileData.bio);
                                if (typeof saveAppState === 'function') { try { saveAppState(); } catch(e) {} }
                            }
                        }
                    } catch(e) { /* column missing or offline — ignore */ }
                })();
            }
        }
        // Posts count
        var { count: postCount } = await sb.from('club_posts').select('id', {count:'exact',head:true}).eq('user_id', myId);
        var postsEl = document.getElementById('club-stat-posts');
        if (postsEl) postsEl.textContent = postCount || 0;
        // Followers count
        var { count: follCount } = await sb.from('follows').select('id', {count:'exact',head:true}).eq('following_id', myId);
        var follEl = document.getElementById('club-stat-followers');
        if (follEl) follEl.textContent = follCount || 0;
        // Following count
        var { count: followingCount } = await sb.from('follows').select('id', {count:'exact',head:true}).eq('follower_id', myId);
        var followingEl = document.getElementById('club-stat-following');
        if (followingEl) followingEl.textContent = followingCount || 0;
    } catch(e) {}
}

// Photo zoom modal — fullscreen image viewer for club post photos.
// Click anywhere or ESC closes. Reuses _avFade animation if available.
function _openPhotoZoom(url) {
    if (!url) return;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.96);display:flex;align-items:center;justify-content:center;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);animation:_avFade .18s ease-out;cursor:zoom-out;';
    // Ensure the fade keyframe exists (might not be loaded yet if avatar wasn't tapped)
    if (!document.getElementById('_avFadeStyle')) {
        var st = document.createElement('style');
        st.id = '_avFadeStyle';
        st.textContent = '@keyframes _avFade{from{opacity:0}to{opacity:1}}';
        document.head.appendChild(st);
    }
    var img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;';
    ov.appendChild(img);

    var close = function() {
        ov.style.animation = '_avFade .14s ease-out reverse';
        setTimeout(function(){ if(ov.parentNode) ov.remove(); document.removeEventListener('keydown', onKey); }, 130);
    };
    var onKey = function(e) { if (e.key === 'Escape') close(); };
    ov.onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
}

function _openClubAvatarView() {
    // Accept any avatar source: data: URI, https URL from Supabase Storage, anything.
    var src = profileData && profileData.avatar ? profileData.avatar : '';
    if (!src) return;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;animation:_avFade .18s ease-out;';
    // Inject the keyframes once
    if (!document.getElementById('_avFadeStyle')) {
        var st = document.createElement('style');
        st.id = '_avFadeStyle';
        st.textContent = '@keyframes _avFade{from{opacity:0}to{opacity:1}}';
        document.head.appendChild(st);
    }
    ov.onclick = function() {
        ov.style.animation = '_avFade .14s ease-out reverse';
        setTimeout(function() { ov.remove(); }, 130);
    };
    var img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'width:260px;height:260px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.2);';
    var name = document.createElement('div');
    name.style.cssText = 'color:#fff;font-size:18px;font-weight:700;';
    name.textContent = profileData.name || '';
    ov.appendChild(img); ov.appendChild(name);
    document.body.appendChild(ov);
}

// Inline bio editor for the club header.
// Click → swaps the div for a textarea. Blur or Enter (without Shift) saves.
// Escape cancels. Persists to profileData + IndexedDB locally, and to Supabase if available.
function _editClubBio(bioEl) {
    if (!bioEl || bioEl.dataset.editing === '1') return;
    bioEl.dataset.editing = '1';

    var currentBio = (typeof profileData !== 'undefined' && profileData.bio) ? profileData.bio.trim() : '';
    // Preserve the slot's geometry so the textarea doesn't jump the layout
    var rect = bioEl.getBoundingClientRect();
    var minH = Math.max(28, rect.height);

    var ta = document.createElement('textarea');
    ta.value = currentBio;
    ta.maxLength = 150;
    ta.rows = 2;
    ta.placeholder = 'Añade tu bio (máx 150 caracteres)...';
    ta.style.cssText = [
        'width:100%',
        'min-height:' + minH + 'px',
        'box-sizing:border-box',
        'background:var(--card)',
        'color:var(--tw)',
        'border:1.5px solid var(--gold-bd)',
        'border-radius:8px',
        'padding:6px 8px',
        'font-family:var(--f),system-ui,sans-serif',
        'font-size:12px',
        'font-weight:500',
        'line-height:1.35',
        'resize:none',
        'outline:none',
        'display:block'
    ].join(';');

    // Insert textarea, hide the original div
    var hadDisplay = bioEl.style.display;
    bioEl.style.display = 'none';
    bioEl.parentNode.insertBefore(ta, bioEl.nextSibling);
    ta.focus();
    // Place caret at the end so user can keep typing
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch(e) {}

    var done = false;
    function cleanup(saved) {
        if (done) return; done = true;
        var newVal = saved ? ta.value.trim().slice(0, 150) : currentBio;
        ta.remove();
        bioEl.dataset.editing = '';
        bioEl.style.display = hadDisplay || '';
        // Update profileData + UI immediately
        if (typeof profileData !== 'undefined') profileData.bio = newVal;
        _renderClubHeaderBio(bioEl, newVal);
        // Persist
        if (saved) {
            if (typeof saveAppState === 'function') { try { saveAppState(); } catch(e) {} }
            _saveBioToSupabase(newVal);
        }
    }

    ta.addEventListener('blur', function() { cleanup(true); });
    ta.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cleanup(false); }
    });
}

// Apply the right look to the bio element depending on whether there's content
function _renderClubHeaderBio(bioEl, bioText) {
    if (!bioEl) return;
    var text = (bioText || '').trim();
    if (text) {
        bioEl.textContent = text;
        bioEl.style.color = '';        // inherit (var(--tm))
        bioEl.style.fontStyle = '';
        bioEl.style.opacity = '';
    } else {
        bioEl.textContent = 'Añade tu bio...';
        bioEl.style.color = 'var(--tm)';
        bioEl.style.fontStyle = 'italic';
        bioEl.style.opacity = '.85';
    }
    bioEl.style.cursor = 'pointer';
    bioEl.style.display = '-webkit-box';
}

// Save bio to Supabase. Graceful failure if column doesn't exist or no session.
async function _saveBioToSupabase(bio) {
    try {
        var sb = window._sbClient;
        if (!sb) return;
        var { data:{ session } } = await sb.auth.getSession();
        if (!session) return;
        var { error } = await sb.from('profiles').update({ bio: bio }).eq('id', session.user.id);
        if (error) {
            // Column doesn't exist? PGRST204 ("could not find column") is common.
            // We log to console for debugging but never alert the user — local save still works.
            console.warn('[bio] Supabase save skipped:', error.message);
        }
    } catch(e) {
        console.warn('[bio] Supabase save failed:', e);
    }
}

async function openClubFollowersList(type) {
    var sb = window._sbClient;
    var { data:{ session } } = await sb.auth.getSession();
    if (!session) return;
    var myId = session.user.id;
    var title = type === 'followers' ? 'Seguidores' : 'Seguidos';
    var query = type === 'followers'
        ? sb.from('follows').select('follower_id, profiles!follows_follower_id_fkey(id,username,display_name,avatar_url)').eq('following_id', myId)
        : sb.from('follows').select('following_id, profiles!follows_following_id_fkey(id,username,display_name,avatar_url)').eq('follower_id', myId);
    var { data } = await query;
    var users = (data||[]).map(function(r) { return type==='followers' ? r.profiles : r.profiles; }).filter(Boolean);
    var ov = document.createElement('div');
    ov.id = 'club-followers-view';
    ov.style.cssText = 'position:fixed;inset:0;z-index:20005;background:var(--bg);display:flex;flex-direction:column;';
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+10px) 15px 10px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);';
    var backBtn = document.createElement('button');
    backBtn.style.cssText = 'width:34px;height:34px;border-radius:50%;border:none;background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    backBtn.onclick = function() { ov.remove(); };
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:16px;font-weight:800;color:var(--tw);';
    titleEl.textContent = title;
    hdr.appendChild(backBtn); hdr.appendChild(titleEl);
    var list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;padding:12px 15px;display:flex;flex-direction:column;gap:12px;';
    if (!users.length) {
        list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tm);font-size:13px;">Sin ' + title.toLowerCase() + ' aún.</div>';
    } else {
        users.forEach(function(u) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:12px;';
            var av = document.createElement('div');
            av.style.cssText = 'width:42px;height:42px;border-radius:50%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;overflow:hidden;flex-shrink:0;';
            if (u.avatar_url) { var i=document.createElement('img');i.src=u.avatar_url;i.loading='lazy';i.style.cssText='width:100%;height:100%;object-fit:cover;';av.appendChild(i); }
            else av.textContent = (u.display_name||u.username||'?')[0].toUpperCase();
            var name = document.createElement('div');
            name.style.cssText = 'font-size:14px;font-weight:700;color:var(--tw);flex:1;';
            name.textContent = u.display_name || u.username || '?';
            row.appendChild(av); row.appendChild(name);
            list.appendChild(row);
        });
    }
    ov.appendChild(hdr); ov.appendChild(list);
    document.body.appendChild(ov);
}
function closeClub() {
    _setThemeColor('#8f1a28');
    var v = document.getElementById('club-view');
    if (!v) return;
    v.style.transform = 'translateY(-100%)';
    setTimeout(function() { v.style.display = 'none'; }, 400);
}

// ── ONBOARDING DEL CLUB ───────────────────────────────────────────
// Devuelve el HTML de las 3 tarjetas explicativas que se muestran cuando el
// feed "Para ti" está vacío. Cada tarjeta lleva al CTA correspondiente.
// Acciones expuestas en window para que onclick funcione tras innerHTML.
window._onbActions = {
    findRunners: function() {
        if (typeof openClubSearch === 'function') openClubSearch();
    },
    goCrews: function() {
        if (typeof setClubFeedFilter === 'function') setClubFeedFilter('crews');
    },
    goLibrary: function() {
        // Cerrar el Club y cambiar a la pestaña Biblioteca
        if (typeof closeClub === 'function') closeClub();
        setTimeout(function() {
            var libBtn = document.querySelector('[data-target="activities"]');
            if (libBtn) libBtn.click();
        }, 250);
    }
};
function _buildClubOnboardingHTML() {
    // Cada tarjeta: icono grande circular, título, descripción, botón CTA.
    // Estilo consistente con las cards del Home (fondo card, border, radius 14).
    function _card(icon, iconBg, title, desc, ctaLabel, ctaFn, ctaColor) {
        return ''
          + '<div onclick="window._onbActions.' + ctaFn + '()" style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:transform .15s ease, box-shadow .15s ease;" '
          +   'onmouseover="this.style.transform=\'translateY(-1px)\';this.style.boxShadow=\'0 4px 12px rgba(0,0,0,.08)\';" '
          +   'onmouseout="this.style.transform=\'translateY(0)\';this.style.boxShadow=\'none\';">'
          +   '<div style="width:44px;height:44px;border-radius:12px;background:' + iconBg + ';display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">' + icon + '</div>'
          +   '<div style="flex:1;min-width:0;">'
          +     '<div style="font-size:13px;font-weight:800;color:var(--tw);line-height:1.2;margin-bottom:3px;">' + title + '</div>'
          +     '<div style="font-size:11px;color:var(--ts);line-height:1.4;margin-bottom:6px;">' + desc + '</div>'
          +     '<div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:' + ctaColor + ';">'
          +       '<span>' + ctaLabel + '</span>'
          +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="' + ctaColor + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
          +     '</div>'
          +   '</div>'
          + '</div>';
    }
    return ''
      + '<div style="padding:24px 4px 20px;">'
      +   '<div style="text-align:center;margin-bottom:18px;">'
      +     '<div style="font-size:36px;margin-bottom:6px;">👋</div>'
      +     '<div style="font-size:17px;font-weight:800;color:var(--tw);margin-bottom:4px;">Bienvenido al Club</div>'
      +     '<div style="font-size:12px;color:var(--ts);line-height:1.5;max-width:280px;margin:0 auto;">Tres pasos para empezar a compartir tus carreras con otros runners.</div>'
      +   '</div>'
      +   '<div style="display:flex;flex-direction:column;gap:10px;">'
      +     _card('🔍', 'rgba(196,136,30,.15)', 'Encuentra a otros runners', 'Busca a tus amigos por nombre y síguelos para ver sus carreras.', 'Buscar runners', 'findRunners', 'var(--gold)')
      +     _card('🏆', 'rgba(138,143,150,.20)', 'Únete a un crew', 'Crews privados con tus amigos para retos colectivos y rankings semanales.', 'Ver crews', 'goCrews', 'var(--silver-dk)')
      +     _card('🏃', 'rgba(143,26,40,.12)', 'Comparte tu primera carrera', 'Desde tu Biblioteca puedes publicar cualquier actividad al Club.', 'Ir a Biblioteca', 'goLibrary', 'var(--crimson)')
      +   '</div>'
      + '</div>';
}
window._buildClubOnboardingHTML = _buildClubOnboardingHTML;

/* ── Feed ────────────────────────────────────────────────────────── */
async function renderClubFeed(opts) {
    // ── Parámetros opcionales ──
    // opts.crewId  → si se pasa, filtramos por ese crew (vista del Crew).
    //               si no, mostramos solo posts SIN crew (feed global).
    // opts.target  → contenedor DOM donde renderizar. Por defecto #club-feed.
    opts = opts || {};
    var crewId = opts.crewId || null;
    var container = opts.target || document.getElementById('club-feed');
    if (!container) return;
    // Preservar el panel del Tablón si está abierto. ID distinto según contexto:
    //   global → 'club-board-panel'
    //   crew   → 'crew-board-panel-<crewId>'
    var _boardSaved = crewId
        ? document.getElementById('crew-board-panel-' + crewId)
        : document.getElementById('club-board-panel');
    container.innerHTML = '';
    if (typeof fxSkeleton === 'function') fxSkeleton(container, { count: 3, template: 'feed' });
    else container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--tm);font-size:13px;">Cargando...</div>';
    if (_boardSaved) container.insertBefore(_boardSaved, container.firstChild);

    try {
        const { data: { session } } = await window._sbClient.auth.getSession();
        if (!session) {
            container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tm);">Inicia sesión para ver el Club</div>';
            return;
        }
        const myId = session.user.id;

        // Load mutual follows for DM button logic
        const [{ data: iFollow }, { data: followMe }] = await Promise.all([
            window._sbClient.from('follows').select('following_id').eq('follower_id', myId),
            window._sbClient.from('follows').select('follower_id').eq('following_id', myId)
        ]);
        const iFollowSet = new Set((iFollow||[]).map(r => r.following_id));
        const followMeSet = new Set((followMe||[]).map(r => r.follower_id));
        const mutualSet = new Set([...iFollowSet].filter(id => followMeSet.has(id)));

        // Query base: con filtro por crew o solo posts públicos
        var q = window._sbClient
            .from('club_posts')
            .select('*, profiles!club_posts_user_id_fkey(id, username, display_name, avatar_url), reactions(id, user_id, emoji)')
            .order('created_at', { ascending: false })
            .limit(50);
        if (crewId) {
            q = q.eq('crew_id', crewId);
        } else {
            // Feed global: SOLO posts sin crew (los de crew solo se ven en su detalle)
            q = q.is('crew_id', null);
        }
        const { data: posts, error } = await q;

        if (error) throw error;

        // Si es feed de crew → cargar custom_emojis del crew (si existen)
        var crewEmojis = null;
        if (crewId) {
            try {
                var { data: crewRow } = await window._sbClient
                    .from('crews').select('custom_emojis').eq('id', crewId).single();
                if (crewRow && Array.isArray(crewRow.custom_emojis) && crewRow.custom_emojis.length === 5) {
                    crewEmojis = crewRow.custom_emojis;
                }
            } catch(e) { /* columna no existe aún o crew borrado → ignorar */ }
        }

        // Cargar perfiles de etiquetados (todos los tagged_user_ids del batch)
        var taggedProfilesMap = {};
        try {
            var allTaggedIds = new Set();
            (posts || []).forEach(function(p) {
                if (Array.isArray(p.tagged_user_ids)) {
                    p.tagged_user_ids.forEach(function(id){ if (id) allTaggedIds.add(id); });
                }
            });
            if (allTaggedIds.size > 0) {
                var { data: tagProfs } = await window._sbClient
                    .from('profiles').select('id, username, display_name, avatar_url')
                    .in('id', Array.from(allTaggedIds));
                (tagProfs || []).forEach(function(p){ taggedProfilesMap[p.id] = p; });
            }
        } catch(e) { /* columna o tabla no disponible — ignorar */ }

        // Preservar el panel del Tablón si está abierto antes de redibujar el feed
        var _board = crewId
            ? document.getElementById('crew-board-panel-' + crewId)
            : document.getElementById('club-board-panel');
        if (_board) _board.parentNode.removeChild(_board);

        // ── Filtros: ocultar posts de gente bloqueada/silenciada o que me bloqueó.
        // El toggle "Solo seguidos" solo aplica al feed global, no al feed de un crew
        // (en un crew ya son todos "tus" runners por definición).
        var onlyFollowing = !crewId && localStorage.getItem(_uk('mr_feed_only_following')) === '1';
        var visiblePosts = (posts || []).filter(function(p) {
            var uid = p.user_id;
            if (typeof hiddenByMe === 'function' && hiddenByMe(uid)) return false;
            if (onlyFollowing && uid !== myId && !iFollowSet.has(uid)) return false;
            return true;
        });

        if (!visiblePosts || !visiblePosts.length) {
            var emptyHTML;
            if (crewId) {
                emptyHTML = '<div style="text-align:center;padding:40px 20px;color:var(--tm);"><div style="font-size:32px;margin-bottom:10px;">🏃</div><div style="font-size:14px;font-weight:700;color:var(--tp);margin-bottom:6px;">Este crew aún no tiene posts</div><div style="font-size:12px;line-height:1.6;">Cuando alguien comparta una actividad al crew, aparecerá aquí.</div></div>';
            } else if (onlyFollowing) {
                emptyHTML = '<div style="text-align:center;padding:40px 20px;color:var(--tm);"><div style="font-size:32px;margin-bottom:10px;">🏃</div><div style="font-size:14px;font-weight:700;color:var(--tp);margin-bottom:6px;">Sin posts de gente que sigues</div><div style="font-size:12px;line-height:1.6;">Cambia a "Para ti" para ver todos los posts del Club.</div></div>';
            } else {
                // Feed "Para ti" vacío → onboarding interactivo
                emptyHTML = (typeof _buildClubOnboardingHTML === 'function')
                    ? _buildClubOnboardingHTML()
                    : '<div style="text-align:center;padding:40px 20px;color:var(--tm);"><div style="font-size:32px;margin-bottom:10px;">🏃</div><div style="font-size:14px;font-weight:700;color:var(--tp);margin-bottom:6px;">Tu Club está vacío</div><div style="font-size:12px;line-height:1.6;">Sigue a otros runners y comparte tus actividades.</div></div>';
            }
            container.innerHTML = emptyHTML;
            if (_board) container.insertBefore(_board, container.firstChild);
            return;
        }

        container.innerHTML = '';
        if (_board) container.appendChild(_board);
        var _staggerStart = container.children.length; // índice antes de añadir cards
        visiblePosts.forEach(post => container.appendChild(_buildClubCard(post, myId, mutualSet, crewEmojis, taggedProfilesMap)));
        // Animación stagger sólo a las tarjetas recién montadas (no al Wall)
        try {
            var _newCards = Array.prototype.slice.call(container.children, _staggerStart);
            _staggerIn(_newCards);
        } catch(_) {}

        setTimeout(() => {
            visiblePosts.forEach(post => {
                const actData = post.act_data || {};
                if (actData.records?.length > 10 && typeof window.drawTrack === 'function') {
                    const cv = document.getElementById('club-map-' + post.id);
                    if (cv) {
                        const pw = cv.parentElement?.offsetWidth || 300;
                        const ph = cv.parentElement?.offsetHeight || 200;
                        cv.width = pw;
                        cv.height = ph;
                        try {
                            if (typeof window.drawTrackFromCacheOrFallback === 'function') {
                                // Same cacheKey as detail view → reuses Mapbox image from localStorage if user has seen it
                                const ck = actData.id || actData.dateStr || ('post-' + post.id);
                                window.drawTrackFromCacheOrFallback(cv, actData.records, actData.shoeColor || '', ck);
                            } else {
                                window.drawTrack(cv, actData.records, actData.shoeColor || '');
                            }
                        } catch(e) {}
                    }
                }
            });
        }, 150);
    } catch(err) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger);font-size:13px;">Error al cargar. Desliza hacia abajo para reintentar.</div>';
        console.error('[Club] Feed error:', err);
    }
}

/* ── Build club card ─────────────────────────────────────────────── */
// Detect if an activity is a Personal Best vs the local user's recorded marcas.
// Returns a label like '5K' / '10K' / 'HM' / 'M', or null if not a PB.
// Only meaningful for own posts (we don't have other users' marcas client-side).
function _detectPB(act) {
    try {
        if (typeof profileData === 'undefined' || !profileData.marcas) return null;
        var dist = act.distKm;
        var dur = act.durationSec;
        if (!dist || !dur || dur <= 0) return null;
        // Match real distance to a PB bucket
        var bucket = null;
        if (dist >= 4.8 && dist <= 5.5)   bucket = { key: '5k',  label: '5K' };
        else if (dist >= 9.5 && dist <= 10.8) bucket = { key: '10k', label: '10K' };
        else if (dist >= 20.5 && dist <= 21.5) bucket = { key: 'hm', label: 'HM' };
        else if (dist >= 41.5 && dist <= 43.0) bucket = { key: 'm',  label: 'M' };
        if (!bucket) return null;
        var pbStr = profileData.marcas[bucket.key];
        if (!pbStr || pbStr === '—' || pbStr === '\u2014') return null; // no previous mark
        // Parse "MM:SS" or "HH:MM:SS"
        var parts = String(pbStr).split(':').map(Number);
        var pbSec = parts.length === 3 ? parts[0]*3600+parts[1]*60+parts[2] : parts[0]*60+(parts[1]||0);
        if (!pbSec || pbSec <= 0) return null;
        // Beat means strictly faster
        return dur < pbSec ? bucket.label : null;
    } catch(e) { return null; }
}

// ─── Helper: animación stagger para tarjetas que se montan en lote ─────
// Aplica fade-in + slide-up con delay incremental a cada elemento.
// Cap a 12 elementos para que el último delay no pase de ~600ms.
// Uso: _staggerIn(container.children) tras appendear todo de golpe.
function _staggerIn(elements, opts) {
    if (!elements || !elements.length) return;
    opts = opts || {};
    var step  = opts.step  || 50;   // ms entre cada elemento
    var dur   = opts.dur   || 350;  // duración de la animación
    var maxN  = opts.maxN  || 12;   // tope de delays escalonados
    var dy    = opts.dy    || 8;    // px de translateY inicial

    // Inyectar keyframes una sola vez
    if (!document.getElementById('mr-stagger-style')) {
        var st = document.createElement('style');
        st.id = 'mr-stagger-style';
        st.textContent =
            '@keyframes mrStaggerFadeUp {'
          + '  from { opacity: 0; transform: translate3d(0,var(--mr-dy,8px),0); }'
          + '  to   { opacity: 1; transform: translate3d(0,0,0); }'
          + '}';
        document.head.appendChild(st);
    }

    // Detectar prefers-reduced-motion (accesibilidad)
    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(_) {}
    if (reduce) return; // sin animación si el usuario lo pidió

    var n = elements.length;
    for (var i = 0; i < n; i++) {
        var el = elements[i];
        if (!el || !el.style) continue;
        var delay = Math.min(i, maxN) * step;
        el.style.setProperty('--mr-dy', dy + 'px');
        el.style.opacity = '0';
        el.style.animation = 'mrStaggerFadeUp ' + dur + 'ms cubic-bezier(.32,.72,0,1) ' + delay + 'ms forwards';
        // Limpiar tras terminar para que no afecte a re-renders/hover
        (function(_el) {
            setTimeout(function() {
                if (!_el || !_el.style) return;
                _el.style.animation = '';
                _el.style.opacity = '';
                _el.style.removeProperty('--mr-dy');
            }, delay + dur + 50);
        })(el);
    }
}
window._staggerIn = _staggerIn;

/* ───────────────────────────────────────────────────────────────────
   EFECTOS PREMIUM (helpers globales)
   Los keyframes y clases CSS están en el <style> estático del head
   para máxima fiabilidad (se aplican siempre, sin esperar a JS).
   ─────────────────────────────────────────────────────────────────── */

/* fxConfetti: explosión de confetti corta (PR celebration) */
function fxConfetti(opts) {
    opts = opts || {};
    var n = opts.count || 50;
    var colors = opts.colors || ['#c4881e','#e8a825','#f43f5e','#a855f7','#22c55e','#3b82f6','#fff'];
    var origin = opts.origin || { x: window.innerWidth/2, y: window.innerHeight/3 };
    var container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:100049;overflow:hidden;';
    document.body.appendChild(container);
    for (var i = 0; i < n; i++) {
        var p = document.createElement('div');
        var size = 6 + Math.random() * 8;
        var spread = (Math.random() - 0.5) * window.innerWidth * 0.9;
        var color = colors[Math.floor(Math.random() * colors.length)];
        var rotate = 360 + Math.random() * 720;
        var delay = Math.random() * 120;
        var duration = 1400 + Math.random() * 1100;
        var isRect = Math.random() > 0.4;
        p.style.cssText = 'position:absolute;left:' + origin.x + 'px;top:' + origin.y + 'px;'
            + 'width:' + size + 'px;height:' + (isRect ? size * 0.4 : size) + 'px;'
            + 'background:' + color + ';'
            + (isRect ? '' : 'border-radius:50%;')
            + '--cx:' + spread + 'px;--cdx:' + ((Math.random()-0.5)*60) + 'px;--cr:' + rotate + 'deg;'
            + 'animation:_fxConfettiFall ' + duration + 'ms cubic-bezier(.32,.72,0,1) ' + delay + 'ms forwards;'
            + 'will-change:transform,opacity;';
        container.appendChild(p);
    }
    setTimeout(function(){ if (container.parentNode) container.remove(); }, 2800);
}
window.fxConfetti = fxConfetti;

/* fxSkeleton: crea N bloques skeleton dentro de un contenedor */
function fxSkeleton(container, opts) {
    if (!container) return;
    opts = opts || {};
    var count = opts.count || 3;
    var template = opts.template || 'feed'; // 'feed' | 'list' | 'profile'
    container.innerHTML = '';
    for (var i = 0; i < count; i++) {
        var card = document.createElement('div');
        if (template === 'feed') {
            card.style.cssText = 'margin:0 0 12px;padding:14px;background:var(--card);border-radius:14px;border:1px solid var(--border);';
            card.innerHTML =
              '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">'
              + '<div class="mr-fx-skeleton" style="width:42px;height:42px;border-radius:50%;"></div>'
              + '<div style="flex:1;display:flex;flex-direction:column;gap:6px;">'
              +   '<div class="mr-fx-skeleton" style="width:45%;height:11px;"></div>'
              +   '<div class="mr-fx-skeleton" style="width:30%;height:9px;"></div>'
              + '</div>'
              + '</div>'
              + '<div class="mr-fx-skeleton" style="width:100%;height:160px;border-radius:10px;margin-bottom:10px;"></div>'
              + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">'
              +   '<div class="mr-fx-skeleton" style="height:38px;"></div>'
              +   '<div class="mr-fx-skeleton" style="height:38px;"></div>'
              +   '<div class="mr-fx-skeleton" style="height:38px;"></div>'
              +   '<div class="mr-fx-skeleton" style="height:38px;"></div>'
              + '</div>';
        } else if (template === 'list') {
            card.style.cssText = 'display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:1px solid var(--bsoft);';
            card.innerHTML =
              '<div class="mr-fx-skeleton" style="width:42px;height:42px;border-radius:50%;flex-shrink:0;"></div>'
              + '<div style="flex:1;display:flex;flex-direction:column;gap:5px;">'
              +   '<div class="mr-fx-skeleton" style="width:50%;height:10px;"></div>'
              +   '<div class="mr-fx-skeleton" style="width:30%;height:8px;"></div>'
              + '</div>';
        } else if (template === 'profile') {
            card.style.cssText = 'padding:12px 0;';
            card.innerHTML =
              '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">'
              + '<div class="mr-fx-skeleton" style="width:64px;height:64px;border-radius:50%;"></div>'
              + '<div style="flex:1;display:flex;flex-direction:column;gap:8px;">'
              +   '<div class="mr-fx-skeleton" style="width:55%;height:13px;"></div>'
              +   '<div class="mr-fx-skeleton" style="width:35%;height:10px;"></div>'
              + '</div>'
              + '</div>'
              + '<div class="mr-fx-skeleton" style="width:100%;height:60px;border-radius:10px;"></div>';
        }
        container.appendChild(card);
    }
}
window.fxSkeleton = fxSkeleton;

function _buildClubCard(post, myId, mutualSet, crewEmojis, taggedProfilesMap) {
    mutualSet = mutualSet || new Set();
    taggedProfilesMap = taggedProfilesMap || {};
    var act = post.act_data || {};
    var profile = post.profiles || {};
    var user = profile.display_name || profile.username || '?';
    var avatarUrl = profile.avatar_url || '';
    var userId = profile.id;
    var isOwn = userId === myId;
    var reactions = post.reactions || [];

    var distVal = act.distKm > 0 ? act.distKm.toFixed(2) : '--';
    var pace = '--';
    if (act.distKm > 0 && act.durationSec > 0) {
        var sPerKm = act.durationSec / act.distKm;
        pace = Math.floor(sPerKm / 60) + "'" + String(Math.round(sPerKm % 60)).padStart(2, '0') + '"';
    }
    var dur = '--';
    if (act.durationSec > 0) {
        var dh = Math.floor(act.durationSec/3600), dm = Math.floor((act.durationSec%3600)/60), ds = act.durationSec%60;
        dur = dh > 0 ? dh + ':' + String(dm).padStart(2,'0') + ':' + String(ds).padStart(2,'0') : dm + ':' + String(ds).padStart(2,'0');
    }
    var TLAB = {easy:'Easy Run',recovery:'Recovery',series:'Series',long:'Long Run',race:'Carrera',heatmap:'🔥 Heatmap'};
    var TCOL = {easy:'#4ade80',recovery:'#60a5fa',series:'#f87171',long:'#7c3aed',race:'#e879f9',heatmap:'#e8a825'};
    var tl = TLAB[act.type] || act.type || 'Actividad';
    var tc = TCOL[act.type] || '#aaa';
    var diff = Date.now() - new Date(post.created_at).getTime();
    var m2 = Math.floor(diff / 60000);
    var ago = m2 < 60 ? m2 + 'm' : m2 < 1440 ? Math.floor(m2/60) + 'h' : Math.floor(m2/1440) + 'd';
    var dateStr = act.dateStr ? new Date(act.dateStr+'T12:00:00').toLocaleDateString('es-ES', {weekday:'short',day:'numeric',month:'short'}) : '';
    var hasT = !!(act.records && act.records.length > 10);
    var hasP = !!(post.photo_url);

    var card = document.createElement('div');
    // [v8.x — V5 Editorial] Card sin border, sombra tabaco cálida, esquinas más
    // redondeadas. Se siente como una pieza de magazine de fotografía sobre el cream.
    card.style.cssText = 'background:var(--card);border-radius:22px;overflow:hidden;margin-bottom:12px;display:flex;flex-direction:column;width:100%;flex-shrink:0;min-height:0;box-sizing:border-box;box-shadow:0 8px 24px rgba(101,67,33,.16), 0 2px 6px rgba(74,49,24,.18);';

    /* Header */
    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 13px 9px;flex-shrink:0;';
    var av = document.createElement('div');
    av.style.cssText = 'width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--crimson),#c0243a);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;flex-shrink:0;overflow:hidden;';
    if (avatarUrl) { var avImg = document.createElement('img'); avImg.src = avatarUrl; avImg.loading = 'lazy'; avImg.style.cssText = 'width:100%;height:100%;object-fit:cover;'; av.appendChild(avImg); }
    else av.textContent = (user[0] || '?').toUpperCase();
    if (!isOwn && userId) { av.style.cursor='pointer'; (function(_id,_un,_ua){av.onclick=function(){openUserProfile(_id,_un,_ua);};})(userId,user,avatarUrl); }
    hdr.appendChild(av);
    var uInfo = document.createElement('div'); uInfo.style.cssText = 'flex:1;min-width:0;';
    var uNW = document.createElement('div'); uNW.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var uNT = document.createElement('span'); uNT.style.cssText = 'font-size:14px;font-weight:700;color:var(--tw);' + (!isOwn&&userId?'cursor:pointer;':''); uNT.textContent = user;
    if (!isOwn && userId) { (function(_id,_un,_ua){uNT.onclick=function(){openUserProfile(_id,_un,_ua);};})(userId,user,avatarUrl); }
    uNW.appendChild(uNT);
    if (isOwn) { var ob = document.createElement('span'); ob.style.cssText = 'font-size:8px;font-weight:700;color:var(--gold);background:var(--gold-lt);border:1px solid var(--gold-bd);border-radius:4px;padding:1px 5px;'; ob.textContent = 'TÚ'; uNW.appendChild(ob); }
    // Chip plateado "🔒 Crew" — sólo si el post pertenece a un crew (privado).
    // Sirve como recordatorio visual del contexto cuando navegamos por el feed del crew.
    // Si conozco el nombre del crew (porque soy miembro), lo mostramos; si no, "Crew" genérico.
    if (post.crew_id) {
        var crewName = '';
        if (typeof getMyCrews === 'function') {
            var mine = getMyCrews().find(function(c){ return c.id === post.crew_id; });
            if (mine) crewName = mine.name || '';
        }
        var cChip = document.createElement('span');
        cChip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;'
            + 'font-size:8.5px;font-weight:800;color:#fff;'
            + 'background:var(--silver-grad);'
            + 'border-radius:4px;padding:2px 6px;letter-spacing:.2px;'
            + 'text-shadow:0 1px 1px rgba(0,0,0,.18);'
            + 'box-shadow:inset 0 -1px 2px rgba(0,0,0,.18),0 1px 2px rgba(80,85,92,.25);'
            + 'max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        cChip.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
            + '<span>' + (crewName ? crewName.toUpperCase() : 'CREW') + '</span>';
        uNW.appendChild(cChip);
    }
    var uDt = document.createElement('div'); uDt.style.cssText = 'font-size:11px;color:var(--tm);margin-top:2px;'; uDt.textContent = dateStr;
    uInfo.appendChild(uNW); uInfo.appendChild(uDt);

    // Gear row (shoes + watch) — only shown if the user has any equipment recorded for this activity.
    // Both are stored inside act_data: shoeName / shoeColor (set when the activity was created),
    // and watch (stamped on the post when published).
    var shoeName = act.shoeName || '';
    var shoeColor = act.shoeColor || '';
    // Watch: prefer the one stamped on the post (act_data.watch). If not present,
    // try the author's current profile watch (loaded via the profiles join, may be undefined).
    // For OWN posts published before the watch-stamping change, fall back to the user's local
    // profileData.watch so the user always sees their own watch in their feed.
    // Last-resort fallback: read the visible watch field in the profile UI.
    var watchName = act.watch || (profile && profile.watch) || '';
    if (!watchName && isOwn) {
        if (typeof profileData !== 'undefined' && profileData.watch) {
            watchName = profileData.watch;
        } else {
            var _wd = document.getElementById('watch-display');
            if (_wd && _wd.textContent && _wd.textContent.trim() && _wd.textContent.trim() !== '—') {
                watchName = _wd.textContent.trim();
            }
        }
    }
    if (shoeName || watchName) {
        var gearRow = document.createElement('div');
        gearRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;';
        if (shoeName) {
            var shChip = document.createElement('span');
            shChip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--tm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;line-height:1.2;';
            // Colored shoe icon (tinted with shoeColor if available)
            var shoeStroke = shoeColor || 'var(--tm)';
            shChip.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="' + shoeStroke + '" stroke-width="1.8" stroke-linecap="round"><path d="M2 18h20M6 18l1-6h10l1 6"/><path d="M9 12l1-4h4l1 4"/></svg><span style="overflow:hidden;text-overflow:ellipsis;">' + shoeName + '</span>';
            gearRow.appendChild(shChip);
        }
        if (watchName) {
            var wChip = document.createElement('span');
            wChip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--tm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;line-height:1.2;';
            // Smartwatch icon (rectangle with strap nubs + small inner display)
            wChip.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 6V3h6v3M9 18v3h6v-3"/><circle cx="12" cy="12" r="1.5" fill="var(--tm)" stroke="none"/></svg><span style="overflow:hidden;text-overflow:ellipsis;">' + watchName + '</span>';
            gearRow.appendChild(wChip);
        }
        uInfo.appendChild(gearRow);
    }

    hdr.appendChild(uInfo);
    var rightCol = document.createElement('div'); rightCol.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';
    // Weather emoji (si la actividad tiene clima registrado por Open-Meteo)
    // Solo el icono — la temperatura se omite a propósito por fiabilidad.
    var _wEmoji = (typeof window._weatherEmoji === 'function') ? window._weatherEmoji(act.weather) : '';
    if (_wEmoji) {
        var wxEl = document.createElement('div');
        wxEl.style.cssText = 'font-size:14px;line-height:1;';
        wxEl.title = (act.weather && act.weather.condition) ? act.weather.condition : '';
        wxEl.textContent = _wEmoji;
        rightCol.appendChild(wxEl);
    }
    var agoEl = document.createElement('div'); agoEl.style.cssText = 'font-size:11px;color:var(--tm);'; agoEl.textContent = ago;
    rightCol.appendChild(agoEl);
    if (!isOwn && userId && mutualSet.has(userId)) {
        var dmBtn = document.createElement('button');
        dmBtn.style.cssText = 'background:none;border:1.5px solid var(--border);border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
        dmBtn.title = 'Mensaje privado';
        dmBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ts)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
        (function(_uid, _un, _ua) { dmBtn.onclick = function() { openChat(_uid, _un, _ua); }; })(userId, user, avatarUrl);
        rightCol.appendChild(dmBtn);
    }
    if (isOwn) {
        var delBtn = document.createElement('button');
        delBtn.style.cssText = 'background:none;border:none;cursor:pointer;opacity:.45;';
        delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--crimson)" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>';
        (function(_pid, _card) {
            delBtn.onclick = function() {
                var exMod = document.getElementById('del-post-modal'); if (exMod) exMod.remove();
                var modal = document.createElement('div');
                modal.id = 'del-post-modal';
                modal.style.cssText = 'position:fixed;inset:0;z-index:60000;display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(env(safe-area-inset-bottom,0px)+20px);background:rgba(0,0,0,.55);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s;';
                modal.innerHTML = '<div style="background:var(--card);border-radius:22px 22px 18px 18px;padding:24px 20px 20px;width:100%;max-width:420px;box-shadow:0 -4px 40px rgba(0,0,0,.35);transform:translateY(30px);transition:transform .3s cubic-bezier(.32,.72,0,1);" id="del-post-inner"><div style="text-align:center;margin-bottom:18px;"><div style="width:52px;height:52px;border-radius:50%;background:rgba(239,68,68,.12);border:1.5px solid rgba(239,68,68,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:22px;">🗑</div><div style="font-size:17px;font-weight:800;color:var(--tw);margin-bottom:6px;">Eliminar del Club</div><div style="font-size:12px;color:var(--ts);line-height:1.5;">Esta actividad desaparecerá del feed de tus seguidores.</div></div><div style="display:flex;gap:10px;"><button id="del-post-cancel" style="flex:1;background:var(--surface);border:1.5px solid var(--border);border-radius:14px;padding:14px;font-family:var(--f);font-size:14px;font-weight:700;color:var(--ts);cursor:pointer;">Cancelar</button><button id="del-post-ok" style="flex:1;background:#ef4444;border:none;border-radius:14px;padding:14px;font-family:var(--f);font-size:14px;font-weight:700;color:#fff;cursor:pointer;">Eliminar</button></div></div>';
                document.body.appendChild(modal);
                requestAnimationFrame(function() { requestAnimationFrame(function() {
                    modal.style.opacity = '1';
                    document.getElementById('del-post-inner').style.transform = 'translateY(0)';
                }); });
                var closeModal = function() { modal.style.opacity='0'; setTimeout(function(){ if(modal.parentNode) modal.remove(); },250); };
                document.getElementById('del-post-cancel').onclick = closeModal;
                modal.addEventListener('click', function(ev) { if (ev.target===modal) closeModal(); });
                document.getElementById('del-post-ok').onclick = function() {
                    closeModal();
                    window._sbClient.from('club_posts').delete().eq('id', _pid).then(function(res) {
                        if (res.error) { showToast('Error al eliminar: ' + res.error.message, 3000); return; }
                        _card.style.opacity = '0';
                        _card.style.transition = 'opacity .2s';
                        setTimeout(function() { if (_card.parentNode) _card.remove(); }, 200);
                        showToast('Eliminado del Club', 1800);
                    });
                };
            };
        })(post.id, card);
        rightCol.appendChild(delBtn);
    }
    hdr.appendChild(rightCol);
    card.appendChild(hdr);

    // ── Chip de etiquetados (si hay tagged_user_ids) ──────────────
    if (Array.isArray(post.tagged_user_ids) && post.tagged_user_ids.length > 0) {
        var tagChip = document.createElement('div');
        tagChip.style.cssText = 'flex-shrink:0;margin:0 15px 8px;padding:8px 12px;'
            + 'background:rgba(168,85,247,.10);border:1px solid rgba(168,85,247,.30);border-radius:10px;'
            + 'display:flex;align-items:center;gap:8px;font-family:var(--f);';
        // Icono usuarios
        var tagIcon = document.createElement('div');
        tagIcon.style.cssText = 'flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#a855f7;';
        tagIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        tagChip.appendChild(tagIcon);
        // Texto: "Con @runner1, @runner2"
        var tagText = document.createElement('div');
        tagText.style.cssText = 'flex:1;min-width:0;font-size:12px;color:var(--tw);line-height:1.4;font-weight:600;';
        var conSpan = document.createElement('span');
        conSpan.style.cssText = 'color:var(--tm);font-weight:500;';
        conSpan.textContent = 'Con ';
        tagText.appendChild(conSpan);
        post.tagged_user_ids.forEach(function(uid, idx) {
            var prof = taggedProfilesMap[uid];
            if (!prof) return; // perfil borrado o no cargado
            var span = document.createElement('span');
            span.style.cssText = 'color:#a855f7;font-weight:800;cursor:pointer;';
            // [BUGFIX B3 · FIX B] Si hay display_name (nombre humano) lo mostramos sin @;
            // si solo hay username (handle), mantenemos el @ como en una mención.
            span.textContent = prof.display_name || ('@' + (prof.username || '?'));
            (function(_uid, _un, _ua) {
                span.onclick = function(e){ e.stopPropagation(); if (typeof openUserProfile === 'function') openUserProfile(_uid, _un, _ua); };
            })(prof.id, prof.display_name || prof.username, prof.avatar_url);
            tagText.appendChild(span);
            if (idx < post.tagged_user_ids.length - 1) {
                var sep = document.createElement('span');
                sep.style.cssText = 'color:var(--tm);font-weight:500;';
                sep.textContent = ', ';
                tagText.appendChild(sep);
            }
        });
        tagChip.appendChild(tagText);
        card.appendChild(tagChip);
    }

    // ── Banner de carrera oficial (solo si raceName) ───────────────
    if (act.raceName && String(act.raceName).trim()) {
        var raceBn = document.createElement('div');
        raceBn.style.cssText = 'flex-shrink:0;margin:0 15px 8px;padding:12px 14px;'
            + 'background:linear-gradient(135deg,rgba(196,136,30,.18) 0%,rgba(196,136,30,.06) 60%,rgba(143,26,40,.10) 100%);'
            + 'border:1.5px solid var(--gold-bd);border-radius:12px;'
            + 'box-shadow:0 2px 10px rgba(196,136,30,.18),inset 0 1px 0 rgba(255,255,255,.06);'
            + 'display:flex;align-items:center;gap:11px;position:relative;overflow:hidden;';
        // Resplandor radial decorativo
        var raceAccent = document.createElement('div');
        raceAccent.setAttribute('aria-hidden','true');
        raceAccent.style.cssText = 'position:absolute;top:-30px;right:-20px;width:120px;height:120px;background:radial-gradient(circle,rgba(232,168,37,.22) 0%,transparent 60%);pointer-events:none;';
        raceBn.appendChild(raceAccent);
        // Icono medalla
        var medal = document.createElement('div');
        medal.style.cssText = 'flex-shrink:0;width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#e8a825,#c4881e);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(196,136,30,.45),inset 0 1px 0 rgba(255,255,255,.35);font-size:22px;line-height:1;position:relative;z-index:1;';
        medal.textContent = '🏅';
        raceBn.appendChild(medal);
        // Texto: chip + nombre
        var raceInfo = document.createElement('div');
        raceInfo.style.cssText = 'flex:1;min-width:0;position:relative;z-index:1;';
        var raceChip = document.createElement('div');
        raceChip.style.cssText = 'display:inline-block;font-size:9.5px;font-weight:800;color:var(--gold);letter-spacing:1.4px;text-transform:uppercase;margin-bottom:3px;text-shadow:0 1px 0 rgba(0,0,0,.20);';
        raceChip.textContent = 'CARRERA OFICIAL';
        var raceName = document.createElement('div');
        raceName.style.cssText = 'font-size:16px;font-weight:800;color:var(--tw);line-height:1.2;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        raceName.textContent = String(act.raceName).trim();
        raceInfo.appendChild(raceChip);
        raceInfo.appendChild(raceName);
        raceBn.appendChild(raceInfo);
        // Distancia oficial autoinferida (5K/10K/21K/42K/Otra)
        var dKm = act.distKm || 0;
        var distLabel = null;
        if (dKm >= 41.5 && dKm <= 43.5) distLabel = '42K';
        else if (dKm >= 20.5 && dKm <= 22) distLabel = '21K';
        else if (dKm >= 9.7 && dKm <= 10.5) distLabel = '10K';
        else if (dKm >= 4.8 && dKm <= 5.3) distLabel = '5K';
        if (distLabel) {
            var distBadge = document.createElement('div');
            distBadge.style.cssText = 'flex-shrink:0;padding:5px 10px;background:linear-gradient(135deg,#c4881e,#a06f12);border:1px solid rgba(255,255,255,.18);border-radius:8px;font-size:11.5px;font-weight:900;color:#fff;letter-spacing:.6px;position:relative;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.20);text-shadow:0 1px 1px rgba(0,0,0,.30);';
            distBadge.textContent = distLabel;
            raceBn.appendChild(distBadge);
        }
        card.appendChild(raceBn);
    }

    /* Media */
    if (hasP || hasT) {
        var mw = document.createElement('div');
        if (hasP && hasT) {
            mw.style.cssText = 'position:relative;display:flex;width:100%;height:200px;background:#0d1520;overflow:hidden;flex-shrink:0;gap:2px;';
            var photoSide = document.createElement('div');
            photoSide.style.cssText = 'flex:1;position:relative;overflow:hidden;cursor:zoom-in;';
            var ph = document.createElement('img'); ph.src = post.photo_url; ph.loading = 'lazy';
            ph.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
            photoSide.appendChild(ph);
            (function(_url){ photoSide.onclick = function() { _openPhotoZoom(_url); }; })(post.photo_url);
            mw.appendChild(photoSide);
            var trackSide = document.createElement('div');
            trackSide.style.cssText = 'flex:1;overflow:hidden;background:#0d1520;';
            var cvo = document.createElement('canvas');
            cvo.id = 'club-map-' + post.id;
            cvo.width = Math.round(window.innerWidth / 2); cvo.height = 200;
            cvo.style.cssText = 'width:100%;height:100%;display:block;';
            trackSide.appendChild(cvo); mw.appendChild(trackSide);
        } else if (hasP) {
            mw.style.cssText = 'position:relative;width:100%;height:200px;background:#0d1520;overflow:hidden;flex-shrink:0;cursor:zoom-in;';
            var ph = document.createElement('img'); ph.src = post.photo_url; ph.loading = 'lazy';
            ph.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
            mw.appendChild(ph);
            var gb = document.createElement('div');
            gb.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:80px;background:linear-gradient(to top,rgba(0,0,0,.5),transparent);pointer-events:none;';
            mw.appendChild(gb);
            (function(_url){ mw.onclick = function() { _openPhotoZoom(_url); }; })(post.photo_url);
        } else {
            mw.style.cssText = 'position:relative;width:100%;height:200px;background:#0d1520;overflow:hidden;flex-shrink:0;';
            var cvFull = document.createElement('canvas');
            cvFull.id = 'club-map-' + post.id;
            cvFull.width = Math.round(window.innerWidth);
            cvFull.height = 200;
            cvFull.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
            mw.appendChild(cvFull);
        }
        // PR overlay: medalla flotante en esquina superior derecha del media.
        // - 1 PR  → medalla específica del tipo (10K, HM, M, etc.)
        // - 2+ PRs → copa genérica dorada + chip con "Nº"
        if (act.pr && Array.isArray(act.pr.records) && act.pr.records.length && typeof window._buildMedalSVG === 'function' && typeof window._getPRMeta === 'function') {
            var prRecs = act.pr.records;
            var medalWrap = document.createElement('div');
            medalWrap.style.cssText = 'position:absolute;top:10px;right:10px;width:44px;height:50px;z-index:3;filter:drop-shadow(0 0 12px rgba(217,168,62,.55)) drop-shadow(0 3px 8px rgba(0,0,0,.55));pointer-events:none;';
            if (prRecs.length === 1) {
                // 1 solo PR → su medalla específica
                var prMeta = window._getPRMeta(prRecs[0].type) || { tier:'gold', centerText:'PR', label:prRecs[0].type };
                var medalSvg = window._buildMedalSVG(prMeta);
                medalWrap.innerHTML = medalSvg.replace('width="56" height="64"', 'width="44" height="50"');
            } else {
                // 2+ PRs → copa genérica + chip con número
                medalWrap.innerHTML =
                    '<svg width="44" height="50" viewBox="0 0 56 64" xmlns="http://www.w3.org/2000/svg">'
                  +   '<defs>'
                  +     '<linearGradient id="trGrad' + post.id + '" x1="0" y1="0" x2="0" y2="1">'
                  +       '<stop offset="0%" stop-color="#f5d97a"/>'
                  +       '<stop offset="50%" stop-color="#e8a825"/>'
                  +       '<stop offset="100%" stop-color="#a06f12"/>'
                  +     '</linearGradient>'
                  +     '<linearGradient id="trGradS' + post.id + '" x1="0" y1="0" x2="0" y2="1">'
                  +       '<stop offset="0%" stop-color="#c4881e"/>'
                  +       '<stop offset="100%" stop-color="#7a4f0a"/>'
                  +     '</linearGradient>'
                  +   '</defs>'
                  +   '<ellipse cx="28" cy="60" rx="14" ry="2.5" fill="rgba(0,0,0,.45)"/>'
                  +   '<rect x="24" y="48" width="8" height="9" fill="url(#trGradS' + post.id + ')" rx="1"/>'
                  +   '<rect x="18" y="55" width="20" height="4" fill="url(#trGradS' + post.id + ')" rx="1.5"/>'
                  +   '<path d="M14 10 L42 10 L40 36 Q40 46 28 46 Q16 46 16 36 Z" fill="url(#trGrad' + post.id + ')" stroke="#7a4f0a" stroke-width="1.2"/>'
                  +   '<path d="M14 14 Q6 16 6 24 Q6 30 14 30" fill="none" stroke="url(#trGradS' + post.id + ')" stroke-width="3" stroke-linecap="round"/>'
                  +   '<path d="M42 14 Q50 16 50 24 Q50 30 42 30" fill="none" stroke="url(#trGradS' + post.id + ')" stroke-width="3" stroke-linecap="round"/>'
                  +   '<path d="M19 14 L37 14" stroke="#fff" stroke-width=".8" stroke-linecap="round" opacity=".55"/>'
                  +   '<text x="28" y="33" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="14" font-weight="900" fill="#fff" text-anchor="middle" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4));">PR</text>'
                  + '</svg>'
                  + '<div style="position:absolute;top:-4px;right:-6px;min-width:20px;height:20px;border-radius:10px;background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg);padding:0 5px;box-shadow:0 2px 4px rgba(0,0,0,.35);font-family:var(--f);">' + prRecs.length + '</div>';
            }
            mw.appendChild(medalWrap);
        }
        card.appendChild(mw);
    }

    /* Name + type */
    var nameRow = document.createElement('div');
    nameRow.style.cssText = 'padding:10px 13px 6px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-shrink:0;';
    var nmEl = document.createElement('div'); nmEl.style.cssText = 'font-size:18px;font-weight:800;color:var(--tw);letter-spacing:-.3px;line-height:1.2;flex:1;'; nmEl.textContent = act.name || tl;
    var rightBadges = document.createElement('div'); rightBadges.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;margin-top:4px;';
    // PB badge (own posts only — we don't have remote marcas)
    if (isOwn) {
        var pbLabel = _detectPB(act);
        if (pbLabel) {
            var pbBadge = document.createElement('div');
            pbBadge.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:10px;font-weight:800;padding:4px 9px;border-radius:99px;background:linear-gradient(135deg,#c4881e,#e8a825);color:#1a1208;border:1px solid #a36e0f;box-shadow:0 1px 4px rgba(196,136,30,.35);';
            pbBadge.innerHTML = '<span style="font-size:11px;">🏆</span><span>PB ' + pbLabel + '</span>';
            pbBadge.title = 'Nueva marca personal en ' + pbLabel;
            rightBadges.appendChild(pbBadge);
        }
    }
    var tbEl = document.createElement('div'); tbEl.style.cssText = 'font-size:10px;font-weight:700;padding:4px 10px;border-radius:99px;background:' + tc + '22;color:' + tc + ';border:1px solid ' + tc + '44;'; tbEl.textContent = tl;
    rightBadges.appendChild(tbEl);
    nameRow.appendChild(nmEl); nameRow.appendChild(rightBadges); card.appendChild(nameRow);

    /* PR strip — fila horizontal con chips compactos de cada récord batido */
    if (act.pr && Array.isArray(act.pr.records) && act.pr.records.length && typeof window._getPRMeta === 'function') {
        var prStrip = document.createElement('div');
        prStrip.style.cssText = 'display:flex;gap:6px;padding:0 13px 8px;overflow-x:auto;flex-shrink:0;scrollbar-width:none;-ms-overflow-style:none;';
        prStrip.style.setProperty('-webkit-overflow-scrolling', 'touch');
        var isDarkTheme = document.body.classList.contains('dark-mode');
        // Paletas por tier (modo claro vs oscuro). Buscamos buen contraste:
        //   - claro: fondo coloreado sólido, label oscuro, valor casi negro
        //   - oscuro: fondo tintado, label suave, valor crema
        var palettesLight = {
            trophy: { bg:'#F4DFA0', border:'#A88A2E', label:'#6E5316', value:'#3C2C08' },
            gold:   { bg:'#F4DFA0', border:'#A88A2E', label:'#6E5316', value:'#3C2C08' },
            silver: { bg:'#D9DDE2', border:'#8A95A0', label:'#4A5560', value:'#1F2933' },
            flame:  { bg:'#F8C8CD', border:'#A02C3A', label:'#7A1D27', value:'#400C12' },
            snow:   { bg:'#C6E0F2', border:'#5A87B5', label:'#1F4A70', value:'#0B2638' }
        };
        var palettesDark = {
            trophy: { bg:'rgba(232,199,106,.16)', border:'rgba(201,168,76,.55)', label:'#E8C76A', value:'#F5E6C8' },
            gold:   { bg:'rgba(201,168,76,.14)',  border:'rgba(201,168,76,.45)', label:'#C9A84C', value:'#F5E6C8' },
            silver: { bg:'rgba(191,199,207,.14)', border:'rgba(191,199,207,.45)', label:'#BFC7CF', value:'#F0F2F4' },
            flame:  { bg:'rgba(143,26,40,.20)',   border:'rgba(143,26,40,.55)',  label:'#E78C96', value:'#FFE5E8' },
            snow:   { bg:'rgba(120,165,200,.20)', border:'rgba(120,165,200,.5)', label:'#B0D2EB', value:'#E8F2FB' }
        };
        var palettes = isDarkTheme ? palettesDark : palettesLight;
        act.pr.records.forEach(function(r){
            var rMeta = window._getPRMeta(r.type) || { tier:'gold', label:r.type };
            var cs = palettes[rMeta.tier] || palettes.gold;
            var chip = document.createElement('div');
            chip.style.cssText = 'flex-shrink:0;background:'+cs.bg+';border:1px solid '+cs.border+';border-radius:10px;padding:6px 11px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;';
            var lbl = (rMeta.label || r.label || r.type).toUpperCase();
            var val = r.formatted || '';
            chip.innerHTML = '<div style="font-size:8.5px;font-weight:800;color:'+cs.label+';letter-spacing:.7px;line-height:1;white-space:nowrap;">' + String(lbl).replace(/[&<>"']/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}) + '</div>'
                + '<div style="font-size:13px;font-weight:800;color:'+cs.value+';line-height:1.1;letter-spacing:-.2px;white-space:nowrap;">' + String(val).replace(/[&<>"']/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}) + '</div>';
            prStrip.appendChild(chip);
        });
        card.appendChild(prStrip);
    }

    /* Divider */
    var dv1 = document.createElement('div'); dv1.style.cssText = 'margin:0 13px;border-top:1px solid var(--border);flex-shrink:0;'; card.appendChild(dv1);

    /* Stats */
    var sg = document.createElement('div'); sg.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);padding:8px 6px 7px;flex-shrink:0;';
    var statCells;
    if (act.type === 'heatmap' && act.heatmapStats) {
        var hs = act.heatmapStats;
        statCells = [
            { v: (hs.totalKm != null ? hs.totalKm.toFixed(1) : '--'), u: 'KM' },
            { v: String(hs.nRoutes || '--'), u: hs.nRoutes === 1 ? 'Ruta' : 'Rutas' },
            { v: String(hs.nZones || 1), u: (hs.nZones === 1 ? 'Zona' : 'Zonas') },
            { v: String(hs.days || 30) + 'd', u: 'Periodo' }
        ];
    } else {
        statCells = [
            { v: distVal, u: 'KM' },
            { v: dur, u: 'Tiempo' },
            { v: pace, u: 'Ritmo' },
            { v: act.avgHr > 0 ? String(act.avgHr) : '--', u: 'FC' }
        ];
    }
    statCells.forEach(function(s) {
        var cell = document.createElement('div'); cell.style.cssText = 'text-align:center;padding:2px;';
        cell.innerHTML = '<div style="font-size:16px;font-weight:800;color:var(--tw);line-height:1.1;font-variant-numeric:tabular-nums;">' + s.v + '</div><div style="font-size:9px;color:var(--tm);text-transform:uppercase;letter-spacing:.8px;margin-top:2px;">' + s.u + '</div>';
        sg.appendChild(cell);
    });
    card.appendChild(sg);

    /* Reactions */
    var dv2 = document.createElement('div'); dv2.style.cssText = 'margin:0 13px;border-top:1px solid var(--border);flex-shrink:0;'; card.appendChild(dv2);
    card.appendChild(_renderReactionBar(post.id, reactions, myId, act.shoeName || '', crewEmojis));
    /* Comments section */
    card.appendChild(_renderCommentsSection(post.id, myId, profile));
    return card;
}

/* ── Comments section ────────────────────────────────────────────── */
// Collapsible comments under each post. Loads count first (cheap), expands to show full list.
// Stores in Supabase `post_comments` table. Graceful fallback if table missing.
function _renderCommentsSection(postId, myId, ownerProfile) {
    var wrap = document.createElement('div');
    wrap.id = 'cmt-wrap-' + postId;
    wrap.style.cssText = 'border-top:1px solid var(--bsoft);flex-shrink:0;';

    // Toggle button row
    var toggle = document.createElement('button');
    toggle.style.cssText = 'width:100%;background:none;border:none;padding:8px 13px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-family:var(--f);';
    toggle.innerHTML = '<span style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ts);font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ts)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span id="cmt-label-' + postId + '">Comentarios</span></span><svg id="cmt-chev-' + postId + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tm)" stroke-width="2" stroke-linecap="round" style="transition:transform .2s;"><polyline points="6 9 12 15 18 9"/></svg>';

    // Collapsible body
    var body = document.createElement('div');
    body.id = 'cmt-body-' + postId;
    body.style.cssText = 'display:none;padding:0 15px 12px;';
    body.innerHTML = '<div id="cmt-list-' + postId + '" style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px;"></div>';

    // Estado de "respondiendo a..."
    var replyState = { parentId: null, parentUsername: null, parentUserId: null };

    // Chip "Respondiendo a @usuario · ✕" — aparece encima del input
    var replyChip = document.createElement('div');
    replyChip.id = 'cmt-replychip-' + postId;
    replyChip.style.cssText = 'display:none;align-items:center;gap:8px;padding:6px 10px;margin-bottom:6px;background:var(--bsoft);border-left:3px solid var(--crimson);border-radius:0 8px 8px 0;font-size:11.5px;color:var(--ts);';
    body.appendChild(replyChip);

    // Input row
    var inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:8px;align-items:flex-end;';
    var ta = document.createElement('textarea');
    ta.placeholder = 'Escribe un comentario...';
    ta.rows = 1;
    ta.maxLength = 500;
    ta.style.cssText = 'flex:1;background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:8px 12px;font-family:var(--f);font-size:13px;color:var(--tw);outline:none;resize:none;max-height:80px;line-height:1.35;';
    ta.oninput = function() { this.style.height='auto'; this.style.height=Math.min(this.scrollHeight, 80)+'px'; };
    var sendBtn = document.createElement('button');
    sendBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#c4881e,#e8a825);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>';
    inputRow.appendChild(ta); inputRow.appendChild(sendBtn);
    body.appendChild(inputRow);

    wrap.appendChild(toggle);
    wrap.appendChild(body);

    // ---------- Logic ----------
    var loaded = false;
    var expanded = false;
    var _allComments = []; // cache local de todos los comentarios del post

    // Activar/desactivar modo "responder"
    function setReplyTarget(parentId, parentUsername, parentUserId) {
        replyState.parentId = parentId;
        replyState.parentUsername = parentUsername;
        replyState.parentUserId = parentUserId;
        if (parentId) {
            replyChip.style.display = 'flex';
            replyChip.innerHTML = '<span style="flex:1;">Respondiendo a <b style="color:var(--tw);">@' + parentUsername + '</b></span>'
                + '<button id="cmt-cancelreply-' + postId + '" style="background:none;border:none;cursor:pointer;color:var(--tm);padding:2px;display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
            var cancelBtn = document.getElementById('cmt-cancelreply-' + postId);
            if (cancelBtn) cancelBtn.onclick = function(){ setReplyTarget(null, null, null); ta.value = ''; ta.style.height='auto'; };
            // Pre-rellenar con la mención
            var prefill = '@' + parentUsername + ' ';
            // Si el usuario ya estaba escribiendo algo sin mención, lo conservamos prefijado
            if (!ta.value || ta.value.indexOf('@' + parentUsername) !== 0) {
                ta.value = prefill;
                ta.style.height = 'auto';
                ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
            }
            // Focus tras paint, cursor al final
            setTimeout(function(){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
        } else {
            replyChip.style.display = 'none';
            replyChip.innerHTML = '';
        }
    }

    async function loadComments() {
        var listEl = document.getElementById('cmt-list-' + postId);
        if (!listEl) return;
        listEl.innerHTML = '<div style="font-size:11px;color:var(--tm);padding:6px 0;">Cargando comentarios...</div>';
        try {
            var sb = window._sbClient;
            var { data, error } = await sb.from('post_comments')
                .select('id,content,created_at,user_id,parent_comment_id,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)')
                .eq('post_id', postId).order('created_at', { ascending: true });
            if (error) {
                // Fallback sin parent_comment_id (si la columna aún no existe)
                try {
                    var { data: data2, error: err2 } = await sb.from('post_comments')
                        .select('id,content,created_at,user_id,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)')
                        .eq('post_id', postId).order('created_at', { ascending: true });
                    if (!err2) {
                        (data2 || []).forEach(function(c){ c.parent_comment_id = null; });
                        _allComments = data2 || [];
                        renderList(_allComments);
                        updateCount(_allComments.filter(function(c){ return !c.parent_comment_id; }).length);
                        return;
                    }
                } catch(e2){}
                listEl.innerHTML = '<div style="font-size:11px;color:var(--tm);padding:6px 0;font-style:italic;">Comentarios no disponibles aún.</div>';
                return;
            }
            _allComments = data || [];
            renderList(_allComments);
            // Solo contamos comentarios raíz (no respuestas) para el label
            updateCount(_allComments.filter(function(c){ return !c.parent_comment_id; }).length);
        } catch(e) {
            listEl.innerHTML = '<div style="font-size:11px;color:var(--tm);padding:6px 0;font-style:italic;">Error al cargar.</div>';
        }
    }

    // Agrupar respuestas bajo su padre
    function groupComments(comments) {
        var roots = [];
        var repliesByParent = {};
        comments.forEach(function(c){
            if (c.parent_comment_id) {
                if (!repliesByParent[c.parent_comment_id]) repliesByParent[c.parent_comment_id] = [];
                repliesByParent[c.parent_comment_id].push(c);
            } else {
                roots.push(c);
            }
        });
        // Ordenar respuestas por fecha desc (más recientes primero)
        Object.keys(repliesByParent).forEach(function(k){
            repliesByParent[k].sort(function(a,b){ return new Date(b.created_at) - new Date(a.created_at); });
        });
        return { roots: roots, repliesByParent: repliesByParent };
    }

    function renderList(comments) {
        var listEl = document.getElementById('cmt-list-' + postId);
        if (!listEl) return;
        var grouped = groupComments(comments);
        if (!grouped.roots.length) {
            listEl.innerHTML = '<div style="font-size:11px;color:var(--tm);padding:4px 0;font-style:italic;">Sé el primero en comentar.</div>';
            return;
        }
        listEl.innerHTML = '';
        grouped.roots.forEach(function(c) {
            listEl.appendChild(buildCommentBlock(c, grouped.repliesByParent[c.id] || []));
        });
    }

    // Bloque comentario padre + sus respuestas (con plegado)
    function buildCommentBlock(parent, replies) {
        var block = document.createElement('div');
        block.dataset.parentId = parent.id;
        block.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        block.appendChild(buildCommentRow(parent, false));

        if (replies.length > 0) {
            // Contenedor con indent + línea vertical conectora
            var repliesWrap = document.createElement('div');
            repliesWrap.style.cssText = 'position:relative;margin-left:14px;padding-left:18px;display:flex;flex-direction:column;gap:8px;';
            // Línea vertical conectora plateada sutil
            var connector = document.createElement('div');
            connector.setAttribute('aria-hidden','true');
            connector.style.cssText = 'position:absolute;left:0;top:4px;bottom:8px;width:2px;background:linear-gradient(180deg,var(--silver-bd) 0%,rgba(160,160,170,.12) 100%);border-radius:1px;';
            repliesWrap.appendChild(connector);

            var shown = Math.min(2, replies.length);
            var visible = replies.slice(0, shown);
            visible.forEach(function(r){ repliesWrap.appendChild(buildCommentRow(r, true)); });

            // Botón "Ver todas (N)" si hay más
            if (replies.length > 2) {
                var more = document.createElement('button');
                var hiddenCount = replies.length - shown;
                more.style.cssText = 'background:none;border:none;cursor:pointer;text-align:left;padding:2px 0;color:var(--ts);font-family:var(--f);font-size:11.5px;font-weight:700;display:flex;align-items:center;gap:5px;align-self:flex-start;';
                more.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg><span>Ver ' + hiddenCount + ' respuesta' + (hiddenCount===1?'':'s') + ' más</span>';
                var _expanded = false;
                more.onclick = function() {
                    if (_expanded) {
                        // Colapsar: quitar las extra
                        var allRows = repliesWrap.querySelectorAll('[data-cid]');
                        for (var i = allRows.length - 1; i >= 2; i--) allRows[i].remove();
                        _expanded = false;
                        more.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg><span>Ver ' + hiddenCount + ' respuesta' + (hiddenCount===1?'':'s') + ' más</span>';
                    } else {
                        var rest = replies.slice(shown);
                        rest.forEach(function(r){ repliesWrap.insertBefore(buildCommentRow(r, true), more); });
                        _expanded = true;
                        more.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="transform:rotate(180deg);"><polyline points="6 9 12 15 18 9"/></svg><span>Ocultar respuestas</span>';
                    }
                };
                repliesWrap.appendChild(more);
            }

            block.appendChild(repliesWrap);
        }
        return block;
    }

    function buildCommentRow(c, isReply) {
        var prof = c.profiles || {};
        var un = prof.display_name || prof.username || '?';
        var avUrl = prof.avatar_url || '';
        var isMine = c.user_id === myId;

        // Wrap exterior para swipe (con fondo "Responder" detrás)
        var wrapRow = document.createElement('div');
        wrapRow.dataset.cid = c.id;
        wrapRow.style.cssText = 'position:relative;overflow:hidden;';

        // Fondo "Responder" plateado
        var replyBg = document.createElement('div');
        replyBg.style.cssText = 'position:absolute;inset:0;background:linear-gradient(90deg,rgba(127,131,138,.10),var(--silver-grad));display:flex;align-items:center;justify-content:end;padding-right:18px;opacity:0;transition:opacity .15s;pointer-events:none;border-radius:14px;';
        replyBg.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.22));"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
        wrapRow.appendChild(replyBg);

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;background:var(--bg);transform:translateX(0);transition:transform .25s cubic-bezier(.25,.46,.45,.94);will-change:transform;';

        // Avatar — más pequeño si es respuesta
        var avSize = isReply ? 22 : 28;
        var avc = document.createElement('div');
        avc.style.cssText = 'width:'+avSize+'px;height:'+avSize+'px;border-radius:50%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-size:'+(isReply?10:12)+'px;font-weight:700;color:#fff;flex-shrink:0;overflow:hidden;cursor:' + (isMine?'default':'pointer') + ';';
        if (avUrl) { var ai = document.createElement('img'); ai.src = avUrl; ai.style.cssText = 'width:100%;height:100%;object-fit:cover;'; avc.appendChild(ai); }
        else avc.textContent = (un[0]||'?').toUpperCase();
        if (!isMine && c.user_id) {
            (function(_id,_un,_ua){ avc.onclick = function(){ openUserProfile(_id,_un,_ua); }; })(c.user_id, un, avUrl);
        }

        var bubble = document.createElement('div');
        bubble.style.cssText = 'flex:1;min-width:0;padding:1px 0 0;';
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin-bottom:1px;';
        var nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:11.5px;font-weight:800;color:var(--tw);' + (!isMine && c.user_id ? 'cursor:pointer;' : '');
        nameSpan.textContent = un;
        if (!isMine && c.user_id) {
            (function(_id,_un,_ua){ nameSpan.onclick = function(){ openUserProfile(_id,_un,_ua); }; })(c.user_id, un, avUrl);
        }
        var dateSpan = document.createElement('span');
        dateSpan.style.cssText = 'font-size:10px;color:var(--tm);flex-shrink:0;';
        var d = Date.now() - new Date(c.created_at).getTime();
        var mm = Math.floor(d/60000);
        dateSpan.textContent = mm < 1 ? 'ahora' : mm < 60 ? mm+'m' : mm < 1440 ? Math.floor(mm/60)+'h' : Math.floor(mm/1440)+'d';
        header.appendChild(nameSpan); header.appendChild(dateSpan);
        if (isMine) {
            var delBtn = document.createElement('button');
            delBtn.style.cssText = 'margin-left:auto;background:none;border:none;cursor:pointer;padding:0;opacity:.5;';
            delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--crimson)" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            (function(_cid){
                delBtn.onclick = async function() {
                    if (!confirm('¿Eliminar este comentario?' + (isReply ? '' : '\n\nSi tiene respuestas, también se eliminarán.'))) return;
                    try {
                        await window._sbClient.from('post_comments').delete().eq('id', _cid);
                        // Recargar lista para reflejar cascada de respuestas
                        await loadComments();
                    } catch(e) {}
                };
            })(c.id);
            header.appendChild(delBtn);
        }
        var textEl = document.createElement('div');
        textEl.style.cssText = 'font-size:13px;color:var(--tw);line-height:1.35;white-space:pre-wrap;word-break:break-word;';
        textEl.textContent = c.content;
        bubble.appendChild(header); bubble.appendChild(textEl);

        row.appendChild(avc); row.appendChild(bubble);
        wrapRow.appendChild(row);

        // ── Swipe lateral → "Responder" ────────────────────────────
        // Solo a comentarios ajenos (no a los propios) — swipe en mi propio comentario no tiene sentido
        if (!isMine && c.user_id) {
            (function(_pid, _puname, _puserid){
                var startX=0, startY=0, curX=0, swiping=false, swipeAxis=null, revealed=false;
                row.addEventListener('touchstart', function(e){
                    startX = e.touches[0].clientX; startY = e.touches[0].clientY; curX = 0;
                    swiping = true; swipeAxis = null;
                    row.style.transition = 'none';
                }, {passive:true});
                row.addEventListener('touchmove', function(e){
                    if (!swiping) return;
                    var dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
                    if (!swipeAxis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                        swipeAxis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
                    }
                    if (swipeAxis !== 'h') return;
                    if (dx < 0 && !revealed) {
                        curX = Math.max(-70, dx);
                        row.style.transform = 'translateX(' + curX + 'px)';
                        replyBg.style.opacity = String(Math.min(1, Math.abs(curX) / 70));
                    } else if (revealed && dx > 0) {
                        curX = Math.min(0, dx - 70);
                        row.style.transform = 'translateX(' + curX + 'px)';
                        replyBg.style.opacity = String(Math.max(0, 1 + curX / 70));
                    }
                }, {passive:true});
                row.addEventListener('touchend', function(){
                    swiping = false;
                    row.style.transition = 'transform .25s cubic-bezier(.25,.46,.45,.94)';
                    if (curX < -40 && !revealed) {
                        // Disparar acción: responder
                        revealed = true;
                        replyBg.style.opacity = '1';
                        row.style.transform = 'translateX(-70px)';
                        try { if(navigator.vibrate) navigator.vibrate(15); } catch(e){}
                        // Tras un instante, volver a posición y abrir modo respuesta
                        setTimeout(function(){
                            row.style.transform = 'translateX(0)';
                            replyBg.style.opacity = '0';
                            revealed = false;
                            // Si la respuesta es a una respuesta (1 nivel ya), el padre del hilo es el comentario raíz
                            // No el comentario al que respondemos directamente
                            var actualParentId = _pid;
                            if (isReply) {
                                // Buscar el padre raíz de esta respuesta
                                var thisComment = _allComments.find(function(cc){ return cc.id === _pid; });
                                if (thisComment && thisComment.parent_comment_id) {
                                    actualParentId = thisComment.parent_comment_id;
                                }
                            }
                            setReplyTarget(actualParentId, _puname, _puserid);
                            // Expandir el body si no está expandido (no debería ocurrir aquí)
                        }, 280);
                    } else {
                        row.style.transform = 'translateX(0)';
                        replyBg.style.opacity = '0';
                    }
                });
            })(c.id, un, c.user_id);
        }

        return wrapRow;
    }

    function updateCount(n) {
        var lbl = document.getElementById('cmt-label-' + postId);
        if (lbl) lbl.textContent = n > 0 ? 'Comentarios (' + n + ')' : 'Comentarios';
    }

    // Initial count fetch (light, head-only) — solo comentarios raíz
    (async function initialCount() {
        try {
            var sb = window._sbClient;
            // Intentar contar solo raíces (parent NULL); si falla por columna ausente, contar todos
            var { count, error } = await sb.from('post_comments')
                .select('id', { count: 'exact', head: true })
                .eq('post_id', postId)
                .is('parent_comment_id', null);
            if (error) {
                var r2 = await sb.from('post_comments').select('id', { count: 'exact', head: true }).eq('post_id', postId);
                if (!r2.error && typeof r2.count === 'number') updateCount(r2.count);
            } else if (typeof count === 'number') updateCount(count);
        } catch(e) {}
    })();

    toggle.onclick = function() {
        expanded = !expanded;
        body.style.display = expanded ? 'block' : 'none';
        var chev = document.getElementById('cmt-chev-' + postId);
        if (chev) chev.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0)';
        if (expanded && !loaded) {
            loaded = true;
            loadComments();
        }
    };

    async function sendComment() {
        var txt = (ta.value || '').trim();
        if (!txt) return;
        sendBtn.disabled = true;
        try {
            var sb = window._sbClient;
            var payload = { post_id: postId, user_id: myId, content: txt };
            if (replyState.parentId) payload.parent_comment_id = replyState.parentId;
            var { data, error } = await sb.from('post_comments')
                .insert(payload)
                .select('id,content,created_at,user_id,parent_comment_id,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)')
                .single();
            if (error) {
                // Si falla por parent_comment_id (columna ausente), reintentar sin ella
                if (replyState.parentId && (error.message || '').toLowerCase().indexOf('parent_comment_id') >= 0) {
                    delete payload.parent_comment_id;
                    var retry = await sb.from('post_comments').insert(payload)
                        .select('id,content,created_at,user_id,profiles!post_comments_user_id_fkey(username,display_name,avatar_url)').single();
                    if (!retry.error) {
                        retry.data.parent_comment_id = null;
                        data = retry.data;
                    } else {
                        alert('No se pudo enviar el comentario. ¿Has creado la tabla post_comments y la columna parent_comment_id en Supabase?');
                        return;
                    }
                } else {
                    alert('No se pudo enviar el comentario. ¿Has creado la tabla post_comments en Supabase?');
                    console.warn('[comments] insert error', error);
                    return;
                }
            }
            ta.value = ''; ta.style.height = 'auto';
            var wasReply = !!replyState.parentId;
            setReplyTarget(null, null, null);
            // Añadir a la cache y re-renderizar para mantener agrupación correcta
            _allComments.push(data);
            renderList(_allComments);
            // Actualizar contador (solo raíces)
            var rootCount = _allComments.filter(function(cc){ return !cc.parent_comment_id; }).length;
            updateCount(rootCount);
        } catch(e) {
            console.warn('[comments] send failed', e);
        } finally {
            sendBtn.disabled = false;
        }
    }
    sendBtn.onclick = sendComment;
    ta.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } };

    return wrap;
}

/* ── Reactions ───────────────────────────────────────────────────── */
function _renderReactionBar(postId, reactions, myId, shoeName, crewEmojis) {
    // Note: `shoeName` param kept for backward compatibility but is no longer rendered here —
    // the shoe (and watch) chips now live in the post header next to name+date.
    // crewEmojis: array opcional de 5 emojis personalizados del crew (si el post pertenece a un crew con custom_emojis).
    var DEFAULT_EMOJIS = ['❤️','💪','🔥','🐐','🐢'];
    var EMOJIS = (Array.isArray(crewEmojis) && crewEmojis.length === 5) ? crewEmojis.slice() : DEFAULT_EMOJIS;
    var bar = document.createElement('div');
    bar.id = 'rxbar-' + postId;
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 13px 9px;flex-wrap:nowrap;border-top:1px solid var(--bsoft);';
    var emWrap = document.createElement('div'); emWrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;';
    EMOJIS.forEach(function(em) {
        var users = (reactions || []).filter(function(r) { return r.emoji === em; }).map(function(r) { return r.user_id; });
        var iMine = users.indexOf(myId) >= 0;
        var btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:5px 10px;border-radius:99px;border:1.5px solid ' + (iMine?'var(--crimson)':'var(--border)') + ';background:' + (iMine?'var(--crim-lt)':'var(--card2)') + ';cursor:pointer;transition:all .15s;font-size:14px;flex-shrink:0;';
        btn.innerHTML = em + (users.length ? '<span style="font-size:11px;font-weight:700;color:' + (iMine?'var(--crimson)':'var(--ts)') + ';">' + users.length + '</span>' : '');
        (function(_em, _pid, _iMine, _reactions, _bar, _btn) {
            _btn.onclick = function() {
                if (!myId) return;
                // Lanzar animación volátil antes de reemplazar el bar
                if (typeof _animateReactionPop === 'function') {
                    try { _animateReactionPop(_btn, _em, _iMine); } catch(_) {}
                }
                var newReactions = _iMine
                    ? (_reactions||[]).filter(function(r) { return !(r.user_id===myId && r.emoji===_em); })
                    : (_reactions||[]).concat([{user_id:myId, emoji:_em, post_id:_pid}]);
                var newBar = _renderReactionBar(_pid, newReactions, myId, undefined, crewEmojis);
                _bar.parentNode && _bar.parentNode.replaceChild(newBar, _bar);
                if (_iMine) {
                    window._sbClient.from('reactions').delete().eq('post_id',_pid).eq('user_id',myId).eq('emoji',_em).then(() => {});
                } else {
                    window._sbClient.from('reactions').insert({post_id:_pid,user_id:myId,emoji:_em}).then(() => {});
                }
            };
        })(em, postId, iMine, reactions, bar, btn);
        emWrap.appendChild(btn);
    });
    bar.appendChild(emWrap);
    return bar;
}

/* ═══════════════════════════════════════════════════════════════════
   EVENTO / QUEDADA DEL CREW (#7)
   Modelo simple: cada crew tiene como mucho UN evento activo.
   - El owner puede crear/editar/borrar.
   - Cualquier miembro responde "Voy" o "No voy" (cambiar de opinión OK).
   - No se pueden borrar respuestas (decisión: cambia al otro botón).
   ─────────────────────────────────────────────────────────────────── */

// Cache local de respuestas en memoria por evento, para optimismo en UI
window._crewEventCache = {}; // { eventId: { yes:Set<uid>, no:Set<uid>, myResp:'yes'|'no'|null } }

// Carga del banner del evento — renderiza el contenido según haya/no haya
// evento y si soy o no owner. Idempotente: se puede llamar varias veces.
window._loadCrewEventBanner = async function(crew, container) {
    if (!crew || !crew.id || !container) return;
    var sb = window._sbClient;
    if (!sb) { container.style.display = 'none'; return; }
    var isOwner = (crew.role === 'owner');
    try {
        var { data: events, error } = await sb.from('crew_event')
            .select('*')
            .eq('crew_id', crew.id)
            .limit(1);
        if (error) {
            // Si la tabla aún no existe, ocultar silenciosamente
            if (error.code === 'PGRST205' || error.code === '42P01') {
                container.style.display = 'none';
                return;
            }
            throw error;
        }
        var ev = (events && events.length) ? events[0] : null;
        if (!ev && !isOwner) {
            // No hay evento Y no soy owner → ocultar banner
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }
        container.style.display = 'block';
        if (!ev && isOwner) {
            // Estado vacío para owner: invitación a crear
            container.innerHTML = _renderCrewEventEmptyOwner(crew);
            return;
        }
        // Hay evento → cargar respuestas y renderizar
        await _renderCrewEventFull(crew, ev, container);
    } catch (e) {
        console.warn('[MR][crew-event] load fail:', e && e.message ? e.message : e);
        container.style.display = 'none';
    }
};

function _renderCrewEventEmptyOwner(crew) {
    return ''
      + '<div style="background:linear-gradient(135deg,rgba(196,136,30,.10),rgba(232,168,37,.16));'
      +   'border:1.5px dashed rgba(196,136,30,.45);border-radius:14px;padding:13px 14px;'
      +   'display:flex;align-items:center;gap:12px;">'
      +   '<div style="flex-shrink:0;width:36px;height:36px;border-radius:10px;'
      +     'background:linear-gradient(135deg,#E8C76A,#C4881E);'
      +     'display:flex;align-items:center;justify-content:center;font-size:18px;'
      +     'box-shadow:0 2px 6px rgba(196,136,30,.35);">📅</div>'
      +   '<div style="flex:1;min-width:0;">'
      +     '<div style="font-size:12.5px;font-weight:800;color:var(--tw);line-height:1.2;">Anuncia una quedada</div>'
      +     '<div style="font-size:10.5px;color:var(--ts);line-height:1.35;margin-top:2px;">Los miembros confirman asistencia con un toque</div>'
      +   '</div>'
      +   '<button onclick="window._openCrewEventEditor(' + JSON.stringify(crew).replace(/"/g,'&quot;') + ', null)" '
      +     'style="flex-shrink:0;height:32px;padding:0 12px;border-radius:10px;border:none;'
      +     'background:linear-gradient(135deg,#C4881E,#A56F11);color:#fff;font-family:var(--f);'
      +     'font-size:11.5px;font-weight:800;letter-spacing:.2px;cursor:pointer;'
      +     'box-shadow:0 2px 6px rgba(196,136,30,.4);">+ Crear</button>'
      + '</div>';
}

async function _renderCrewEventFull(crew, ev, container) {
    var sb = window._sbClient;
    var isOwner = (crew.role === 'owner');
    // Cargar respuestas
    var yesSet = new Set(), noSet = new Set();
    var myResp = null;
    try {
        var { data: resps } = await sb.from('crew_event_responses')
            .select('user_id, response')
            .eq('event_id', ev.id);
        var myId = null;
        try {
            var { data: sess } = await sb.auth.getSession();
            myId = sess && sess.session && sess.session.user && sess.session.user.id;
        } catch(_) {}
        (resps || []).forEach(function(r) {
            if (r.response === 'yes') yesSet.add(r.user_id);
            else if (r.response === 'no') noSet.add(r.user_id);
            if (r.user_id === myId) myResp = r.response;
        });
        // Guardar en cache para updates optimistas
        window._crewEventCache[ev.id] = { yes: yesSet, no: noSet, myResp: myResp, myId: myId };
    } catch(e) {
        console.warn('[MR][crew-event] responses fail:', e && e.message ? e.message : e);
    }

    var safeTitle = String(ev.title == null ? '' : ev.title)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    var yesCount = yesSet.size, noCount = noSet.size;
    var yesActive = (myResp === 'yes');
    var noActive  = (myResp === 'no');

    var ownerBtn = '';
    if (isOwner) {
        ownerBtn = ''
          + '<button id="crew-event-edit-btn" aria-label="Editar evento" '
          +   'style="position:absolute;top:10px;right:10px;width:30px;height:30px;border-radius:50%;'
          +   'border:none;background:rgba(0,0,0,.10);display:flex;align-items:center;justify-content:center;cursor:pointer;">'
          +   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
          + '</button>';
    }

    container.innerHTML = ''
      + '<div style="position:relative;background:linear-gradient(135deg,#fff7e6 0%,#fdebc0 100%);'
      +   'border:1.5px solid rgba(196,136,30,.45);border-radius:14px;padding:13px 14px 11px;'
      +   'box-shadow:0 2px 10px rgba(196,136,30,.18);">'
      +   ownerBtn
      +   '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;' + (isOwner ? 'padding-right:30px;' : '') + '">'
      +     '<span style="font-size:14px;">📅</span>'
      +     '<span style="font-size:9.5px;font-weight:800;letter-spacing:1.4px;color:#A56F11;text-transform:uppercase;">EVENTO DEL CREW</span>'
      +   '</div>'
      +   '<div style="font-size:13px;font-weight:700;color:#3d2a05;line-height:1.4;margin-bottom:10px;word-wrap:break-word;' + (isOwner ? 'padding-right:30px;' : '') + '">' + safeTitle + '</div>'
      +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
      +     _crewEventResponseBtn(ev.id, 'yes', yesActive, yesCount)
      +     _crewEventResponseBtn(ev.id, 'no',  noActive,  noCount)
      +   '</div>'
      + '</div>';

    if (isOwner) {
        var editBtn = document.getElementById('crew-event-edit-btn');
        if (editBtn) editBtn.onclick = function(e) {
            e.stopPropagation();
            window._openCrewEventEditor(crew, ev);
        };
    }
}

function _crewEventResponseBtn(eventId, kind, active, count) {
    // kind: 'yes' | 'no'
    var icon, color, bgActive, label;
    if (kind === 'yes') {
        label = 'Voy';
        color = '#16a34a';
        bgActive = 'linear-gradient(135deg,#22c55e,#16a34a)';
        icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + (active ? '#fff' : '#16a34a') + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    } else {
        label = 'No voy';
        color = '#dc2626';
        bgActive = 'linear-gradient(135deg,#ef4444,#dc2626)';
        icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + (active ? '#fff' : '#dc2626') + '" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    var bgStyle = active
        ? 'background:' + bgActive + ';color:#fff;border:1.5px solid ' + color + ';'
        : 'background:rgba(255,255,255,.6);color:' + color + ';border:1.5px solid ' + color + ';';
    return ''
      + '<button onclick="window._respondCrewEvent(\'' + eventId + '\',\'' + kind + '\',this)" '
      +   'data-kind="' + kind + '" '
      +   'style="height:38px;border-radius:10px;cursor:pointer;font-family:var(--f);'
      +   'display:flex;align-items:center;justify-content:center;gap:7px;'
      +   'font-size:12px;font-weight:800;letter-spacing:.3px;transition:transform .12s ease;'
      +   bgStyle + '">'
      +   icon
      +   '<span>' + label + '</span>'
      +   '<span style="font-weight:700;opacity:.85;">(' + count + ')</span>'
      + '</button>';
}

// Responder al evento (insert/upsert con onConflict)
window._respondCrewEvent = async function(eventId, kind, btnEl) {
    if (!eventId || (kind !== 'yes' && kind !== 'no')) return;
    var sb = window._sbClient;
    if (!sb) return;
    // Micro-feedback táctil
    if (btnEl) {
        btnEl.style.transform = 'scale(.96)';
        setTimeout(function() { if (btnEl) btnEl.style.transform = ''; }, 130);
    }
    var sessRes = await sb.auth.getSession();
    var myId = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.user && sessRes.data.session.user.id;
    if (!myId) return;

    // Update optimista en cache + UI
    var cache = window._crewEventCache[eventId];
    if (!cache) cache = window._crewEventCache[eventId] = { yes: new Set(), no: new Set(), myResp: null, myId: myId };
    var prev = cache.myResp;
    if (prev === kind) return; // ya está, no hago nada (decisión A: no toggle)
    // Quitar voto previo si existía
    if (prev === 'yes') cache.yes.delete(myId);
    if (prev === 'no')  cache.no.delete(myId);
    // Añadir nuevo
    if (kind === 'yes') cache.yes.add(myId);
    else                cache.no.add(myId);
    cache.myResp = kind;

    // Repintar botones del banner (optimista)
    _repaintCrewEventButtons(eventId);

    // Persistir (upsert por PK compuesta event_id+user_id)
    try {
        var { error } = await sb.from('crew_event_responses').upsert({
            event_id: eventId,
            user_id:  myId,
            response: kind,
            responded_at: new Date().toISOString()
        }, { onConflict: 'event_id,user_id' });
        if (error) throw error;
    } catch(e) {
        console.warn('[MR][crew-event] respond fail:', e && e.message ? e.message : e);
        // Revertir optimismo en caso de error
        if (kind === 'yes') cache.yes.delete(myId);
        else                cache.no.delete(myId);
        if (prev === 'yes') cache.yes.add(myId);
        if (prev === 'no')  cache.no.add(myId);
        cache.myResp = prev;
        _repaintCrewEventButtons(eventId);
        if (typeof showToast === 'function') showToast('No se pudo guardar tu respuesta', 2400);
    }
};

function _repaintCrewEventButtons(eventId) {
    var cache = window._crewEventCache[eventId];
    if (!cache) return;
    var banner = document.getElementById('crew-event-banner');
    if (!banner) return;
    var yesBtn = banner.querySelector('button[data-kind="yes"]');
    var noBtn  = banner.querySelector('button[data-kind="no"]');
    if (yesBtn) yesBtn.outerHTML = _crewEventResponseBtn(eventId, 'yes', cache.myResp === 'yes', cache.yes.size);
    if (noBtn)  {
        // Re-query porque outerHTML invalidó el ref anterior
        noBtn = banner.querySelector('button[data-kind="no"]');
        if (noBtn) noBtn.outerHTML = _crewEventResponseBtn(eventId, 'no', cache.myResp === 'no', cache.no.size);
    }
}

/* ═══════════════════════════════════════════════════════════════════
   Editor de evento (modal del owner)
   ─────────────────────────────────────────────────────────────────── */
window._openCrewEventEditor = function(crew, existingEvent) {
    if (!crew || !crew.id) return;
    if (document.getElementById('crew-event-editor')) return; // evitar doble apertura
    var sb = window._sbClient;

    var back = document.createElement('div');
    back.id = 'crew-event-editor';
    back.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.55);'
        + 'backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);'
        + 'display:flex;align-items:flex-end;justify-content:center;'
        + 'opacity:0;transition:opacity .25s ease;';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:480px;background:var(--bg);'
        + 'border-radius:22px 22px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.4);'
        + 'display:flex;flex-direction:column;'
        + 'transform:translateY(40px);transition:transform .3s cubic-bezier(.32,.72,0,1);'
        + 'padding:14px 16px max(20px,env(safe-area-inset-bottom,0px) + 14px);';

    var isEdit = !!existingEvent;
    var title = isEdit ? 'Editar evento' : 'Nueva quedada';

    sheet.innerHTML = ''
      + '<div style="width:42px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 12px;"></div>'
      + '<div style="display:flex;align-items:center;gap:11px;margin-bottom:14px;">'
      +   '<div style="flex-shrink:0;width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#E8C76A,#C4881E);display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 6px rgba(196,136,30,.35);">📅</div>'
      +   '<div style="flex:1;font-size:16px;font-weight:800;color:var(--tw);">' + title + '</div>'
      +   '<button id="crev-close" aria-label="Cerrar" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--card);display:flex;align-items:center;justify-content:center;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--ts);margin-bottom:6px;font-weight:600;letter-spacing:.3px;">EVENTO O QUEDADA</div>'
      + '<textarea id="crev-input" maxlength="200" placeholder="Ej. Domingo 11:00 — Tirada larga en el Canal Imperial" '
      +   'style="width:100%;min-height:92px;padding:12px;border-radius:12px;border:1.5px solid var(--border);'
      +   'background:var(--card);color:var(--tw);font-family:var(--f);font-size:14px;line-height:1.45;resize:none;'
      +   'box-sizing:border-box;outline:none;"></textarea>'
      + '<div id="crev-counter" style="text-align:right;font-size:10.5px;color:var(--tm);margin-top:4px;font-weight:600;">0 / 200</div>'
      + '<div style="display:flex;gap:10px;margin-top:14px;">'
      +   (isEdit
            ? '<button id="crev-delete" style="flex:1;height:44px;border-radius:12px;border:1.5px solid #dc2626;background:rgba(220,38,38,.08);color:#dc2626;font-family:var(--f);font-size:13px;font-weight:800;cursor:pointer;">Borrar</button>'
            : '')
      +   '<button id="crev-save" style="flex:2;height:44px;border-radius:12px;border:none;background:linear-gradient(135deg,#C4881E,#A56F11);color:#fff;font-family:var(--f);font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 2px 8px rgba(196,136,30,.4);">' + (isEdit ? 'Guardar' : 'Publicar') + '</button>'
      + '</div>';

    back.appendChild(sheet);
    document.body.appendChild(back);
    requestAnimationFrame(function() {
        back.style.opacity = '1';
        sheet.style.transform = 'translateY(0)';
    });

    var input = sheet.querySelector('#crev-input');
    var counter = sheet.querySelector('#crev-counter');
    if (existingEvent && existingEvent.title) input.value = existingEvent.title;
    counter.textContent = (input.value.length) + ' / 200';
    input.addEventListener('input', function() {
        counter.textContent = input.value.length + ' / 200';
    });
    setTimeout(function() { input.focus(); }, 250);

    function closeMe() {
        back.style.opacity = '0';
        sheet.style.transform = 'translateY(40px)';
        setTimeout(function() { back.remove(); }, 280);
    }
    sheet.querySelector('#crev-close').onclick = closeMe;
    back.addEventListener('click', function(e) { if (e.target === back) closeMe(); });

    sheet.querySelector('#crev-save').onclick = async function() {
        var txt = (input.value || '').trim();
        if (txt.length < 1) { if (typeof showToast === 'function') showToast('Escribe el título del evento', 2200); return; }
        if (txt.length > 200) txt = txt.slice(0, 200);
        var btn = this;
        btn.disabled = true; var orig = btn.textContent; btn.textContent = 'Guardando…';
        try {
            var sessRes = await sb.auth.getSession();
            var myId = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.user && sessRes.data.session.user.id;
            if (!myId) throw new Error('Sin sesión');
            // Upsert: una sola fila por crew_id (UNIQUE en BD)
            var { error } = await sb.from('crew_event').upsert({
                crew_id: crew.id,
                title:   txt,
                created_by: myId,
                updated_at: new Date().toISOString()
            }, { onConflict: 'crew_id' });
            if (error) throw error;
            closeMe();
            // Recargar el banner
            var container = document.getElementById('crew-event-banner');
            if (container && typeof window._loadCrewEventBanner === 'function') {
                window._loadCrewEventBanner(crew, container);
            }
            if (typeof showToast === 'function') showToast(isEdit ? 'Evento actualizado' : 'Evento publicado', 2000);
        } catch(e) {
            console.warn('[MR][crew-event] save fail:', e && e.message ? e.message : e);
            if (typeof showToast === 'function') showToast('No se pudo guardar el evento', 2400);
            btn.disabled = false; btn.textContent = orig;
        }
    };

    if (isEdit) {
        sheet.querySelector('#crev-delete').onclick = async function() {
            if (!confirm('¿Borrar el evento? Las respuestas se perderán.')) return;
            var btn = this;
            btn.disabled = true; btn.textContent = 'Borrando…';
            try {
                var { error } = await sb.from('crew_event').delete().eq('id', existingEvent.id);
                if (error) throw error;
                closeMe();
                var container = document.getElementById('crew-event-banner');
                if (container && typeof window._loadCrewEventBanner === 'function') {
                    window._loadCrewEventBanner(crew, container);
                }
                if (typeof showToast === 'function') showToast('Evento borrado', 1800);
            } catch(e) {
                console.warn('[MR][crew-event] delete fail:', e && e.message ? e.message : e);
                if (typeof showToast === 'function') showToast('No se pudo borrar', 2400);
                btn.disabled = false; btn.textContent = 'Borrar';
            }
        };
    }
};

/* ───────────────────────────────────────────────────────────────────
   Editor de emojis personalizados del crew (solo owner)
   Modal premium tipo iOS con:
   - 5 slots editables en grid superior
   - Picker con categorías scrollables abajo
   - Botón Restaurar default + Guardar
   ─────────────────────────────────────────────────────────────────── */
function _openCrewReactionsEditor(crew) {
    if (!crew || !crew.id) return;
    var DEFAULT_EMOJIS = ['❤️','💪','🔥','🐐','🐢'];

    // Cerrar si ya está abierto
    var prev = document.getElementById('crew-rx-editor');
    if (prev) prev.remove();

    // Cargar valor actual del crew
    var currentEmojis = DEFAULT_EMOJIS.slice();
    var hasCustom = false;

    var overlay = document.createElement('div');
    overlay.id = 'crew-rx-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:20020;background:rgba(0,0,0,0.6);opacity:0;transition:opacity .25s;display:flex;flex-direction:column;justify-content:flex-end;';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:var(--card);border-top-left-radius:20px;border-top-right-radius:20px;padding:8px 0 calc(env(safe-area-inset-bottom,0px) + 12px);transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);max-height:88vh;display:flex;flex-direction:column;';

    // Grabber
    var grabber = document.createElement('div');
    grabber.style.cssText = 'width:42px;height:4.5px;background:var(--bsoft);border-radius:3px;margin:8px auto 14px;flex-shrink:0;';
    sheet.appendChild(grabber);

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'flex-shrink:0;padding:0 18px 14px;text-align:center;';
    hdr.innerHTML = '<div style="font-size:17px;font-weight:800;color:var(--tw);letter-spacing:.2px;">Reacciones del Crew</div>'
        + '<div style="font-size:12px;color:var(--tm);margin-top:4px;line-height:1.4;">Elige los 5 emojis que verán los miembros<br>al reaccionar a posts del crew</div>';
    sheet.appendChild(hdr);

    // Slots (5 grandes seleccionables)
    var slotsRow = document.createElement('div');
    slotsRow.style.cssText = 'flex-shrink:0;padding:6px 18px 14px;display:flex;gap:8px;justify-content:center;';
    var selectedSlot = 0; // índice del slot activo
    var slotEls = [];
    function refreshSlots() {
        slotEls.forEach(function(s, i) {
            var active = (i === selectedSlot);
            s.style.background = active ? 'var(--silver-tint-strong)' : 'var(--bsoft)';
            s.style.borderColor = active ? 'var(--silver)' : 'var(--border)';
            s.style.boxShadow = active ? '0 0 0 2px var(--silver-tint,rgba(160,160,170,.20))' : 'none';
            s.querySelector('.slot-emoji').textContent = currentEmojis[i];
        });
    }
    for (var i = 0; i < 5; i++) {
        var slot = document.createElement('button');
        slot.style.cssText = 'width:54px;height:54px;border-radius:14px;border:2px solid var(--border);background:var(--bsoft);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;transition:all .15s;flex-shrink:0;position:relative;';
        var em = document.createElement('span');
        em.className = 'slot-emoji';
        em.style.cssText = 'line-height:1;';
        em.textContent = currentEmojis[i];
        slot.appendChild(em);
        // mini-índice
        var idx = document.createElement('span');
        idx.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:var(--silver-grad);color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--card);box-shadow:0 1px 3px rgba(0,0,0,.20);';
        idx.textContent = String(i+1);
        slot.appendChild(idx);
        (function(_i){ slot.onclick = function(){ selectedSlot = _i; refreshSlots(); }; })(i);
        slotEls.push(slot);
        slotsRow.appendChild(slot);
    }
    sheet.appendChild(slotsRow);

    // Pestañas de categorías
    var categories = [
        { id:'smileys', label:'😊', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾'] },
        { id:'people', label:'👋', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦵','🦿','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','💋','🩸'] },
        { id:'sport', label:'🏃', emojis: ['🏃','🏃‍♀️','🚴','🚴‍♀️','🏊','🏊‍♀️','⛹️','🏋️','🤸','🤼','🤽','🤾','🤹','🧘','🚶','🏇','⛷️','🏂','🏌️','🏄','🎽','🎯','⛳','🪁','🏸','🎾','🏏','🏑','🏒','🥍','🏓','🥊','🥋','⛸️','🎣','🎿','🛷','🥌','🏆','🥇','🥈','🥉','🏅','🎖️','💯','⚡','🔥','💥','💫','⭐','🌟','✨'] },
        { id:'animals', label:'🐐', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔'] },
        { id:'food', label:'🍎', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','☕','🍵','🧉','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🧊','🥄','🍴','🍽️','🥣','🥡','🥢'] },
        { id:'objects', label:'🎉', emojis: ['🎉','🎊','🎂','🍾','🥂','🎁','🎈','🪅','🎀','🪄','✨','💫','⭐','🌟','💥','💯','💢','💦','💨','🕳️','💣','💬','🗯️','💭','💤','🛒','🎒','🩴','👟','👡','👠','👢','👑','👒','🎩','🎓','🧢','🪖','📱','💻','⌚','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎'] },
        { id:'symbols', label:'❤️', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼','⚧','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','⏏️','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂','🔄','🔃','🎵','🎶','➕','➖','➗','✖️','♾️','💲','💱','™️','©️','®️'] }
    ];

    // Tab strip
    var tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'flex-shrink:0;display:flex;gap:0;padding:0 12px;border-top:1px solid var(--bsoft);border-bottom:1px solid var(--bsoft);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;';
    var tabBtns = [];
    var activeCat = 0;
    var emojiGrid; // se asigna abajo
    function renderEmojiGrid(){
        emojiGrid.innerHTML = '';
        var cat = categories[activeCat];
        cat.emojis.forEach(function(emoji){
            var b = document.createElement('button');
            b.style.cssText = 'width:100%;aspect-ratio:1;border:none;background:transparent;cursor:pointer;font-size:23px;line-height:1;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:background .12s,transform .08s;padding:0;';
            b.textContent = emoji;
            b.onmouseenter = function(){ b.style.background='var(--bsoft)'; };
            b.onmouseleave = function(){ b.style.background='transparent'; };
            b.onclick = function(){
                // Si el emoji ya está en otro slot, lo ignoramos (evitar duplicados)
                if (currentEmojis.some(function(e,i){ return e===emoji && i!==selectedSlot; })) {
                    // Feedback de "ya está": pequeño shake
                    b.style.animation = '_rxNope .25s ease';
                    setTimeout(function(){ b.style.animation=''; }, 280);
                    return;
                }
                currentEmojis[selectedSlot] = emoji;
                refreshSlots();
                // Animar el slot que acaba de cambiar
                var s = slotEls[selectedSlot];
                s.style.transform = 'scale(1.15)';
                setTimeout(function(){ s.style.transform = 'scale(1)'; }, 180);
                // Avanzar al siguiente slot automáticamente (si no es el último)
                if (selectedSlot < 4) {
                    selectedSlot++;
                    refreshSlots();
                }
                try { if(navigator.vibrate) navigator.vibrate(8); } catch(e){}
            };
            emojiGrid.appendChild(b);
        });
    }
    function refreshTabs(){
        tabBtns.forEach(function(t,i){
            var active = (i === activeCat);
            t.style.borderBottom = active ? '2.5px solid var(--silver)' : '2.5px solid transparent';
            t.style.opacity = active ? '1' : '.55';
        });
    }
    categories.forEach(function(cat, idx){
        var t = document.createElement('button');
        t.style.cssText = 'flex:1;min-width:46px;height:42px;border:none;background:transparent;cursor:pointer;font-size:22px;line-height:1;border-bottom:2.5px solid transparent;transition:opacity .15s,border-color .15s;opacity:.55;padding:0;';
        t.textContent = cat.label;
        t.onclick = function(){ activeCat = idx; refreshTabs(); renderEmojiGrid(); emojiGrid.scrollTop = 0; };
        tabBtns.push(t);
        tabsRow.appendChild(t);
    });
    sheet.appendChild(tabsRow);

    // Grid de emojis
    emojiGrid = document.createElement('div');
    emojiGrid.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 12px 6px;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;';
    sheet.appendChild(emojiGrid);

    // Animación "nope" para emojis duplicados
    if (!document.getElementById('_rxNopeStyle')) {
        var st = document.createElement('style');
        st.id = '_rxNopeStyle';
        st.textContent = '@keyframes _rxNope{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}';
        document.head.appendChild(st);
    }

    // Footer con acciones
    var footer = document.createElement('div');
    footer.style.cssText = 'flex-shrink:0;padding:10px 18px 0;display:flex;gap:10px;border-top:1px solid var(--bsoft);';

    var resetBtn = document.createElement('button');
    resetBtn.style.cssText = 'flex:1;height:46px;border-radius:14px;border:1.5px solid var(--border);background:var(--bsoft);color:var(--tm);font-family:var(--f);font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;';
    resetBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>Restaurar</span>';
    resetBtn.onclick = function(){
        if (!confirm('¿Restaurar las reacciones por defecto?')) return;
        currentEmojis = DEFAULT_EMOJIS.slice();
        hasCustom = false;
        selectedSlot = 0;
        refreshSlots();
    };
    footer.appendChild(resetBtn);

    var saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'flex:2;height:46px;border-radius:14px;border:none;background:var(--silver-grad);color:#fff;font-family:var(--f);font-size:14px;font-weight:800;cursor:pointer;letter-spacing:.3px;box-shadow:inset 0 -2px 4px rgba(0,0,0,.18),0 3px 10px rgba(80,85,92,.32);';
    saveBtn.textContent = 'Guardar';
    saveBtn.onclick = async function(){
        saveBtn.disabled = true;
        saveBtn.textContent = 'Guardando…';
        // Si el array == default y el crew no tenía custom → guardar NULL
        // Si el array == default y el crew tenía custom → guardar NULL (resetear)
        // Si difiere del default → guardar array
        var isDefault = currentEmojis.every(function(e,i){ return e === DEFAULT_EMOJIS[i]; });
        var payload = isDefault ? null : currentEmojis;
        try {
            var { error } = await window._sbClient.rpc('set_crew_custom_emojis', {
                _crew_id: crew.id,
                _emojis: payload
            });
            if (error) { throw error; }
            showToast(isDefault ? 'Reacciones restauradas' : 'Reacciones guardadas', 1800);
            closeSheet();
            // Refrescar feed del crew si está visible
            var det = document.getElementById('crew-detail-view');
            if (det && det.dataset.crewId === crew.id) {
                if (typeof renderClubFeed === 'function') {
                    var fc = document.getElementById('crew-feed-container-' + crew.id) || document.getElementById('crew-detail-body');
                    if (fc) renderClubFeed({ crewId: crew.id, target: fc });
                }
            }
        } catch(e) {
            console.error('set_crew_custom_emojis error:', e);
            showToast('Error al guardar reacciones', 2200);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Guardar';
        }
    };
    footer.appendChild(saveBtn);
    sheet.appendChild(footer);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    function closeSheet(){
        overlay.style.opacity = '0';
        sheet.style.transform = 'translateY(100%)';
        setTimeout(function(){ if(overlay.parentNode) overlay.remove(); }, 300);
    }
    overlay.addEventListener('click', function(e){ if(e.target===overlay) closeSheet(); });

    // Cargar emojis actuales del crew y luego mostrar
    (async function(){
        try {
            var { data } = await window._sbClient.from('crews').select('custom_emojis').eq('id', crew.id).single();
            if (data && Array.isArray(data.custom_emojis) && data.custom_emojis.length === 5) {
                currentEmojis = data.custom_emojis.slice();
                hasCustom = true;
            }
        } catch(e) {}
        refreshSlots();
        refreshTabs();
        renderEmojiGrid();
        requestAnimationFrame(function(){ requestAnimationFrame(function(){
            overlay.style.opacity = '1';
            sheet.style.transform = 'translateY(0)';
        });});
    })();
}

// ─── Helper: animación de reacción al pulsar ───────────────────────────
// Clona el emoji del botón pulsado, lo posiciona en absoluto sobre él,
// y lo anima fuera de la barra. Diferencia entre añadir (vuela arriba con
// escala+rotación) y quitar (desvanece en su sitio).
// Respeta prefers-reduced-motion.
function _animateReactionPop(btnEl, emoji, wasMine) {
    if (!btnEl || !emoji) return;
    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(_) {}
    if (reduce) return;

    // Inyectar keyframes una sola vez
    if (!document.getElementById('mr-reaction-anim-style')) {
        var st = document.createElement('style');
        st.id = 'mr-reaction-anim-style';
        st.textContent =
            '@keyframes mrReactPopUp {'
          + '  0%   { opacity: 1; transform: translate(-50%,-50%) scale(1) rotate(0deg); }'
          + '  35%  { opacity: 1; transform: translate(-50%,-110%) scale(1.9) rotate(-8deg); }'
          + '  100% { opacity: 0; transform: translate(-50%,-220%) scale(1.4) rotate(8deg); }'
          + '}'
          + '@keyframes mrReactFadeOut {'
          + '  0%   { opacity: 1; transform: translate(-50%,-50%) scale(1); }'
          + '  100% { opacity: 0; transform: translate(-50%,-50%) scale(.6); }'
          + '}'
          + '@keyframes mrReactBtnPulse {'
          + '  0%   { transform: scale(1); }'
          + '  40%  { transform: scale(.88); }'
          + '  100% { transform: scale(1); }'
          + '}';
        document.head.appendChild(st);
    }

    // Pulso de feedback en el propio botón
    btnEl.style.animation = 'mrReactBtnPulse 280ms cubic-bezier(.32,.72,0,1)';
    setTimeout(function() { if (btnEl && btnEl.style) btnEl.style.animation = ''; }, 320);

    // Posición del botón en viewport
    var rect = btnEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;

    // Clon flotante posicionado en viewport
    var ghost = document.createElement('div');
    ghost.textContent = emoji;
    var dur = wasMine ? 280 : 620;
    var anim = wasMine ? 'mrReactFadeOut' : 'mrReactPopUp';
    ghost.style.cssText =
        'position:fixed;left:' + cx + 'px;top:' + cy + 'px;'
      + 'transform:translate(-50%,-50%) scale(1);'
      + 'font-size:22px;line-height:1;pointer-events:none;'
      + 'z-index:99999;will-change:transform,opacity;'
      + 'animation:' + anim + ' ' + dur + 'ms cubic-bezier(.32,.72,0,1) forwards;'
      + 'text-shadow:0 2px 8px rgba(0,0,0,.15);';
    document.body.appendChild(ghost);

    // Partículas extras al añadir (no al quitar): refuerza la sensación
    if (!wasMine) {
        var particles = ['✨','✨','✨'];
        particles.forEach(function(p, idx) {
            var part = document.createElement('div');
            part.textContent = p;
            var dx = (idx - 1) * 22 + (Math.random()*10 - 5);
            var dy = -30 - Math.random() * 20;
            var rot = (idx - 1) * 12;
            part.style.cssText =
                'position:fixed;left:' + cx + 'px;top:' + cy + 'px;'
              + 'transform:translate(-50%,-50%) scale(.4);'
              + 'font-size:12px;line-height:1;pointer-events:none;'
              + 'z-index:99998;opacity:0;will-change:transform,opacity;'
              + 'transition:transform 520ms cubic-bezier(.32,.72,0,1) ' + (idx*40) + 'ms,'
              + ' opacity 520ms ease-out ' + (idx*40) + 'ms;';
            document.body.appendChild(part);
            // Forzar reflow antes del cambio para que la transición se dispare
            // eslint-disable-next-line no-unused-expressions
            part.offsetHeight;
            requestAnimationFrame(function() {
                part.style.transform = 'translate(calc(-50% + ' + dx + 'px),calc(-50% + ' + dy + 'px)) scale(1) rotate(' + rot + 'deg)';
                part.style.opacity = '1';
            });
            // Fade out al final
            setTimeout(function() {
                if (!part || !part.style) return;
                part.style.opacity = '0';
                part.style.transform = 'translate(calc(-50% + ' + (dx*1.4) + 'px),calc(-50% + ' + (dy*1.5) + 'px)) scale(.6) rotate(' + (rot*2) + 'deg)';
            }, 280 + idx*40);
            setTimeout(function() { if (part && part.parentNode) part.remove(); }, 700 + idx*40);
        });
    }

    setTimeout(function() { if (ghost && ghost.parentNode) ghost.remove(); }, dur + 50);
}

/* ── Share to Club ───────────────────────────────────────────────── */
function shareActivityToClub(actId, actObj) {
    var existing = document.getElementById('club-confirm-modal'); if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'club-confirm-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:60000;display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(env(safe-area-inset-bottom,0px)+20px);background:rgba(0,0,0,.55);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s;';
    modal.innerHTML = '<div style="background:var(--card);border-radius:28px 28px 20px 20px;padding:28px 22px 22px;width:100%;max-width:420px;box-shadow:0 -4px 40px rgba(0,0,0,.35);transform:translateY(30px);transition:transform .3s cubic-bezier(.32,.72,0,1);" id="club-confirm-inner"><div style="text-align:center;margin-bottom:22px;"><div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(196,136,30,.18),rgba(196,136,30,.06));border:2px solid var(--gold-bd);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:28px;box-shadow:0 4px 20px rgba(196,136,30,.2);">🏃</div><div style="font-size:19px;font-weight:900;color:var(--tw);margin-bottom:8px;letter-spacing:-.3px;">Compartir en el Club</div><div style="font-size:13px;color:var(--ts);line-height:1.6;">Esta actividad se publicará en el Club<br>y podrán verla tus seguidores.</div></div><div style="display:flex;flex-direction:column;gap:10px;"><button id="club-confirm-ok" style="width:100%;background:linear-gradient(135deg,var(--gold) 0%,#b87800 100%);border:none;border-radius:16px;padding:16px;font-family:var(--f);font-size:15px;font-weight:800;color:#fff;cursor:pointer;letter-spacing:.3px;box-shadow:0 4px 16px rgba(196,136,30,.4);">Publicar en el Club ✓</button><button id="club-cancel-btn" style="width:100%;background:transparent;border:1.5px solid var(--border);border-radius:16px;padding:14px;font-family:var(--f);font-size:14px;font-weight:600;color:var(--ts);cursor:pointer;">Cancelar</button></div></div>';
    document.body.appendChild(modal);
    requestAnimationFrame(function() { requestAnimationFrame(function() {
        modal.style.opacity = '1';
        var inner = document.getElementById('club-confirm-inner');
        if (inner) inner.style.transform = 'translateY(0)';
    }); });

    var closeModal = function() {
        modal.style.opacity = '0';
        setTimeout(function() { if (modal.parentNode) modal.remove(); }, 250);
    };

    document.getElementById('club-cancel-btn').addEventListener('click', function() {
        closeModal();
    });
    modal.addEventListener('click', function(e) {
        if (e.target === modal) closeModal();
    });
    document.getElementById('club-confirm-ok').addEventListener('click', function() {
        closeModal();
        setTimeout(function() { _doShareActivityToClub(actId, actObj); }, 300);
    });
}

async function _doShareActivityToClub(actId, actObj) {
    try {
        var sb = window._sbClient;
        if (!sb) { showToast('Error: cliente no disponible', 3000); return; }

        const { data: { session } } = await sb.auth.getSession();
        if (!session) { showToast('Inicia sesión para compartir', 2000); return; }
        const myId = session.user.id;

        // Use passed actObj directly, or fallback to lookup
        // FASE 6.1.b: comparación tolerante string/number para UUIDs BD.
        var act = actObj || ((typeof activities !== 'undefined') ? activities.find(function(a) { return String(a.id) === String(actId); }) : null);
        if (!act) { showToast('Actividad no encontrada', 2000); return; }

        // Selector de destinos antes de cualquier trabajo (upload de foto, etc.)
        var dest = (typeof pickPublishDestinations === 'function')
            ? await pickPublishDestinations()
            : { toPublic: true, crewIds: [] };
        if (!dest) return; // canceló

        _showClubPublishingBanner();

        var cleanActData = Object.assign({}, act, {
            photoB64: null,
            records: (typeof _downsampleRecords === 'function')
                ? _downsampleRecords(act.records || [], 800)
                : (act.records || []).slice(0, 800)
        });
        var photoUrl = null;

        if (act.photoB64 && act.photoB64.startsWith('data:')) {
            try {
                var res = await fetch(act.photoB64);
                var blob = await res.blob();
                var ext = blob.type.includes('png') ? 'png' : 'jpg';
                var path = myId + '/post-' + Date.now() + '.' + ext;
                var { error: upErr } = await sb.storage.from('media').upload(path, blob);
                if (!upErr) {
                    var { data: urlData } = sb.storage.from('media').getPublicUrl(path);
                    photoUrl = urlData.publicUrl;
                }
            } catch(e) { console.warn('[Club] Photo upload failed:', e); }
        }

        var result = await _insertPostToDestinations({
            user_id: myId,
            act_data: cleanActData,
            photo_url: photoUrl
        }, dest);

        var pb = document.getElementById('club-publishing-banner'); if (pb) pb.remove();

        if (!result.ok) {
            var err = result.errors[0] || {};
            console.error('[Club] Insert error:', err);
            showToast('Error: ' + (err.message || JSON.stringify(err)), 4000);
            return;
        }
        _showClubSharedBanner();
    } catch(e) {
        var pb2 = document.getElementById('club-publishing-banner'); if (pb2) pb2.remove();
        console.error('[Club] Share error:', e);
        showToast('Error inesperado: ' + e.message, 4000);
    }
}

function _showClubPublishingBanner() {
    var ex = document.getElementById('club-publishing-banner'); if (ex) ex.remove();
    var b = document.createElement('div'); b.id = 'club-publishing-banner';
    b.style.cssText = 'position:fixed;bottom:calc(env(safe-area-inset-bottom,0px)+80px);left:50%;transform:translateX(-50%) translateY(20px);z-index:40000;background:var(--card);border:1.5px solid var(--border);border-radius:16px;padding:14px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);opacity:0;transition:all .3s cubic-bezier(.32,.72,0,1);min-width:220px;';
    b.innerHTML = '<div style="width:18px;height:18px;border:2.5px solid var(--crimson);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0;"></div><div style="font-size:13px;font-weight:600;color:var(--tw);">Publicando en el Club…</div>';
    document.body.appendChild(b);
    requestAnimationFrame(function() { requestAnimationFrame(function() { b.style.opacity = '1'; b.style.transform = 'translateX(-50%) translateY(0)'; }); });
}

function _showClubSharedBanner() {
    var ex = document.getElementById('club-shared-banner'); if (ex) ex.remove();
    var b = document.createElement('div'); b.id = 'club-shared-banner';
    b.style.cssText = 'position:fixed;inset:0;z-index:60001;display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(env(safe-area-inset-bottom,0px)+20px);background:rgba(0,0,0,.5);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s;';
    b.innerHTML = '<div id="club-shared-inner" style="background:var(--card);border-radius:28px 28px 20px 20px;padding:28px 22px 22px;width:100%;max-width:420px;box-shadow:0 -4px 40px rgba(0,0,0,.35);transform:translateY(30px);transition:transform .3s cubic-bezier(.32,.72,0,1);text-align:center;">'
        + '<div style="width:64px;height:64px;border-radius:50%;background:rgba(46,180,96,.12);border:2px solid rgba(46,180,96,.35);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:28px;">✅</div>'
        + '<div style="font-size:19px;font-weight:900;color:var(--tw);margin-bottom:6px;">¡Publicado en el Club!</div>'
        + '<div style="font-size:13px;color:var(--ts);line-height:1.6;margin-bottom:22px;">Tu actividad ya está visible<br>para tus seguidores.</div>'
        + '<button id="club-shared-go" style="width:100%;background:linear-gradient(135deg,var(--gold) 0%,#b87800 100%);border:none;border-radius:16px;padding:16px;font-family:var(--f);font-size:15px;font-weight:800;color:#fff;cursor:pointer;letter-spacing:.3px;box-shadow:0 4px 16px rgba(196,136,30,.4);margin-bottom:10px;">Ir al Club →</button>'
        + '<button id="club-shared-close" style="width:100%;background:transparent;border:1.5px solid var(--border);border-radius:16px;padding:13px;font-family:var(--f);font-size:14px;font-weight:600;color:var(--ts);cursor:pointer;">Cerrar</button>'
        + '</div>';
    document.body.appendChild(b);
    requestAnimationFrame(function() { requestAnimationFrame(function() {
        b.style.opacity = '1';
        var inner = document.getElementById('club-shared-inner');
        if (inner) inner.style.transform = 'translateY(0)';
    }); });
    var close = function() { b.style.opacity='0'; setTimeout(function(){if(b.parentNode)b.remove();},250); };
    document.getElementById('club-shared-go').onclick = function() {
        close();
        var detOverlay = document.getElementById('act-detail-overlay');
        if (detOverlay) detOverlay.remove();
        document.querySelectorAll('.sheet-backdrop').forEach(function(s){s.classList.remove('open');});
        openClub();
    };
    document.getElementById('club-shared-close').onclick = close;
    b.addEventListener('click', function(e){if(e.target===b)close();});
}

/* ── User search ─────────────────────────────────────────────────── */
function openClubSearch() {
    var v = document.getElementById('club-search-view'); if (!v) return;
    v.style.display = 'flex'; v.style.flexDirection = 'column';
    setTimeout(function() { var i = document.getElementById('club-search-input'); if (i) i.focus(); }, 100);
}
function closeClubSearch() {
    var v = document.getElementById('club-search-view'); if (v) v.style.display = 'none';
}

async function clubSearch(q) {
    var container = document.getElementById('club-search-results'); if (!container) return;
    q = (q || '').trim();
    if (!q) { container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tm);font-size:13px;">Escribe un nombre para buscar</div>'; return; }
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--tm);">Buscando...</div>';

    try {
        const { data: { session } } = await window._sbClient.auth.getSession();
        const myId = session?.user?.id;

        const { data: users, error } = await window._sbClient.from('profiles')
            .select('id, username, display_name, avatar_url, city')
            .or('username.ilike.%' + q + '%,display_name.ilike.%' + q + '%')
            .neq('id', myId || '00000000-0000-0000-0000-000000000000')
            .limit(20);

        if (error) throw error;
        if (!users || !users.length) { container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tm);">No se encontró ningún usuario</div>'; return; }

        container.innerHTML = '';
        for (var ui = 0; ui < users.length; ui++) {
            var u = users[ui];
            var { data: followData } = await window._sbClient.from('follows')
                .select('id').eq('follower_id', myId || '').eq('following_id', u.id).maybeSingle();
            var isF = !!followData;

            // [BUGFIX B3 · FIX B] Nombre humano preferido. Si el user tiene
            // display_name ("Álvaro Navarro"), lo mostramos como nombre principal
            // y dejamos el @username como subtítulo (handle). Si no, fallback al
            // username puro. Avatar fallback usa la inicial del nombre mostrado.
            var _displayName = u.display_name || u.username || '';
            var _hasDisplay  = !!u.display_name;

            var el = document.createElement('div');
            el.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--card);border-radius:12px;border:1px solid var(--border);margin-bottom:6px;';
            var av = document.createElement('div');
            av.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--crimson);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:700;flex-shrink:0;overflow:hidden;cursor:pointer;';
            if (u.avatar_url) { var iav = document.createElement('img'); iav.src = u.avatar_url; iav.loading = 'lazy'; iav.style.cssText = 'width:100%;height:100%;object-fit:cover;'; av.appendChild(iav); }
            else av.textContent = (_displayName || '?').charAt(0).toUpperCase();
            var info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;cursor:pointer;';
            // Render seguro con textContent (display_name puede contener cualquier carácter)
            var _nameDiv = document.createElement('div');
            _nameDiv.style.cssText = 'font-size:13px;font-weight:700;color:var(--tw);';
            _nameDiv.textContent = _displayName;
            info.appendChild(_nameDiv);
            var _subParts = [];
            if (_hasDisplay) _subParts.push('@' + u.username);
            if (u.city) _subParts.push(u.city);
            if (_subParts.length) {
                var _subDiv = document.createElement('div');
                _subDiv.style.cssText = 'font-size:10px;color:var(--tm);';
                _subDiv.textContent = _subParts.join(' · ');
                info.appendChild(_subDiv);
            }
            // Avatar y nombre/info abren el perfil del runner (imprescindible para
            // poder des-silenciar o desbloquear desde la lupa, ya que sus posts
            // están filtrados del feed).
            (function(_id, _un, _ua) {
                var openIt = function() { closeClubSearch(); openUserProfile(_id, _un, _ua); };
                av.onclick = openIt;
                info.onclick = openIt;
            })(u.id, _displayName, u.avatar_url);

            var dmBtn2 = document.createElement('button');
            dmBtn2.style.cssText = 'padding:7px 10px;border-radius:20px;border:1.5px solid var(--border);background:var(--card2);color:var(--ts);font-family:var(--f);font-size:13px;cursor:pointer;margin-right:6px;';
            dmBtn2.textContent = '💬'; dmBtn2.title = 'Mensaje';
            (function(_id, _un, _ua) { dmBtn2.onclick = function() { closeClubSearch(); openChat(_id, _un, _ua); }; })(u.id, _displayName, u.avatar_url);

            var fBtn = document.createElement('button');
            fBtn.dataset.uid = u.id; fBtn.dataset.following = isF ? '1' : '0';
            fBtn.style.cssText = 'padding:7px 14px;border-radius:20px;border:1.5px solid ' + (isF?'var(--border)':'var(--crimson)') + ';background:' + (isF?'var(--card2)':'var(--crimson)') + ';color:' + (isF?'var(--ts)':'#fff') + ';font-family:var(--f);font-size:11px;font-weight:700;cursor:pointer;';
            fBtn.textContent = isF ? 'Siguiendo' : '+ Seguir';
            fBtn.onclick = function() {
                var wasF = this.dataset.following === '1';
                var _id = this.dataset.uid;
                var _btn = this; _btn.disabled = true;
                (wasF
                    ? window._sbClient.from('follows').delete().eq('follower_id',myId).eq('following_id',_id)
                    : window._sbClient.from('follows').insert({follower_id:myId,following_id:_id})
                ).then(function() {
                    _btn.disabled = false;
                    _btn.dataset.following = wasF ? '0' : '1';
                    _btn.textContent = wasF ? '+ Seguir' : 'Siguiendo';
                    _btn.style.background = wasF ? 'var(--crimson)' : 'var(--card2)';
                    _btn.style.color = wasF ? '#fff' : 'var(--ts)';
                    _btn.style.borderColor = wasF ? 'var(--crimson)' : 'var(--border)';
                    if (typeof showToast === 'function') showToast(wasF ? 'Dejaste de seguir' : '✓ Siguiendo', 2000);
                });
            };
            el.appendChild(av); el.appendChild(info); el.appendChild(dmBtn2); el.appendChild(fBtn);
            container.appendChild(el);
        }
    } catch(err) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger);">Error buscando usuarios</div>';
        console.error('[Club] Search error:', err);
    }
}

/* ══════════════════════════════════════════════════════════════════
   CHAT DM — iMessage style, Supabase Realtime
══════════════════════════════════════════════════════════════════ */
async function openChat(otherUserId, otherUsername, otherAvatar) {
    _activeChatUserId = otherUserId;
    _activeChatUsername = otherUsername;

    // Limpiar flag local de "marcado como no leído" (al abrir la conversación)
    if (typeof _setForcedUnread === 'function') _setForcedUnread(otherUserId, false);

    const { data: { session } } = await window._sbClient.auth.getSession();
    const myId = session?.user?.id;
    if (myId) {
        await window._sbClient.from('messages')
            .update({read_at: new Date().toISOString()})
            .eq('from_id', otherUserId).eq('to_id', myId).is('read_at', null);
        _refreshUnreadBadge();
    }

    var chatView = document.getElementById('club-chat-view');
    if (!chatView) {
        chatView = document.createElement('div');
        chatView.id = 'club-chat-view';
        chatView.style.cssText = 'position:fixed;inset:0;z-index:20002;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);';
        document.body.appendChild(chatView);
    }
    chatView.innerHTML = '';

    /* Topbar - fully integrated with status bar like iMessage */
    var tb = document.createElement('div');
    tb.style.cssText = 'flex-shrink:0;background:var(--bg);padding-top:env(safe-area-inset-top,0px);';

    var tbInner = document.createElement('div');
    tbInner.style.cssText = 'display:grid;grid-template-columns:52px 1fr 52px;align-items:center;padding:6px 8px 10px;';

    var backBtn = document.createElement('button');
    backBtn.style.cssText = 'border:none;background:none;cursor:pointer;display:flex;align-items:center;gap:2px;padding:6px 4px;color:#007AFF;font-size:16px;font-family:var(--f);';
    backBtn.innerHTML = '<svg width="10" height="17" viewBox="0 0 10 17" fill="none"><path d="M9 1L1 8.5L9 16" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    backBtn.onclick = function() { chatView.style.transform = 'translateX(100%)'; _activeChatUserId = null; _setThemeColor('#c4881e'); };

    // Center: avatar + name (bigger avatar, closer to real iMessage)
    var centerCol = document.createElement('div');
    centerCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;';
    var avC = document.createElement('div');
    avC.style.cssText = 'width:50px;height:50px;border-radius:50%;background:var(--crimson);overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.10);';
    if (otherAvatar) {
        var avCI = document.createElement('img');
        avCI.src = otherAvatar;
        avCI.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        avC.appendChild(avCI);
        centerCol.onclick = function() {
            var ov2 = document.createElement('div');
            ov2.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;animation:_avFade .18s ease-out;';
            if (!document.getElementById('_avFadeStyle')) {
                var st = document.createElement('style');
                st.id = '_avFadeStyle';
                st.textContent = '@keyframes _avFade{from{opacity:0}to{opacity:1}}';
                document.head.appendChild(st);
            }
            ov2.onclick = function() {
                ov2.style.animation = '_avFade .14s ease-out reverse';
                setTimeout(function() { ov2.remove(); }, 130);
            };
            var img2 = document.createElement('img');
            img2.src = otherAvatar;
            img2.style.cssText = 'width:240px;height:240px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.2);';
            var nm2 = document.createElement('div');
            nm2.style.cssText = 'color:#fff;font-size:17px;font-weight:700;';
            nm2.textContent = otherUsername || '';
            ov2.appendChild(img2); ov2.appendChild(nm2);
            document.body.appendChild(ov2);
        };
    } else avC.textContent = (otherUsername || '?')[0].toUpperCase();

    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:12px;font-weight:600;color:#007AFF;letter-spacing:-.1px;';
    nameEl.textContent = otherUsername;
    centerCol.appendChild(avC); centerCol.appendChild(nameEl);

    // Long-press en el avatar+nombre → action sheet con opción "Eliminar conversación"
    (function(_oid, _oun, _oua){
        var lpTimer=null, lpFired=false, lpStartX=0, lpStartY=0;
        function cancel(){ if(lpTimer){clearTimeout(lpTimer);lpTimer=null;} }
        var origOnClick = centerCol.onclick;
        centerCol.onclick = function(e){
            if (lpFired) { lpFired = false; return; } // long-press ya abrió el sheet
            if (origOnClick) return origOnClick.call(this, e);
        };
        centerCol.addEventListener('touchstart', function(e){
            lpStartX = e.touches[0].clientX; lpStartY = e.touches[0].clientY; lpFired = false;
            lpTimer = setTimeout(function(){
                lpFired = true; lpTimer = null;
                try { if (navigator.vibrate) navigator.vibrate(15); } catch(e2){}
                centerCol.style.transition = 'transform .15s ease';
                centerCol.style.transform = 'scale(0.95)';
                setTimeout(function(){ centerCol.style.transform = 'scale(1)'; setTimeout(function(){ centerCol.style.transition=''; }, 150); }, 120);
                _openConvActionSheet(_oid, _oun, _oua);
            }, 500);
        }, {passive:true});
        centerCol.addEventListener('touchmove', function(e){
            if (lpTimer && (Math.abs(e.touches[0].clientX - lpStartX) > 6 || Math.abs(e.touches[0].clientY - lpStartY) > 6)) cancel();
        }, {passive:true});
        centerCol.addEventListener('touchend', cancel);
        centerCol.addEventListener('touchcancel', cancel);
        // Mouse fallback
        var msDown=false, msTimer=null, msStartX=0, msStartY=0;
        centerCol.addEventListener('mousedown', function(e){
            msDown=true; msStartX=e.clientX; msStartY=e.clientY; lpFired=false;
            msTimer = setTimeout(function(){
                if(!msDown)return;
                lpFired = true; msTimer=null;
                centerCol.style.transition = 'transform .15s ease';
                centerCol.style.transform = 'scale(0.95)';
                setTimeout(function(){ centerCol.style.transform = 'scale(1)'; setTimeout(function(){ centerCol.style.transition=''; }, 150); }, 120);
                _openConvActionSheet(_oid, _oun, _oua);
            }, 500);
        });
        centerCol.addEventListener('mousemove', function(e){
            if(!msDown)return;
            if (msTimer && (Math.abs(e.clientX - msStartX) > 6 || Math.abs(e.clientY - msStartY) > 6)) { clearTimeout(msTimer); msTimer=null; }
        });
        centerCol.addEventListener('mouseup', function(){ msDown=false; if(msTimer){clearTimeout(msTimer);msTimer=null;} });
        centerCol.addEventListener('mouseleave', function(){ msDown=false; if(msTimer){clearTimeout(msTimer);msTimer=null;} });
    })(otherUserId, otherUsername, otherAvatar);

    var msgsHeaderBtn = document.createElement('button');
    msgsHeaderBtn.style.cssText = 'border:none;background:none;cursor:pointer;font-size:15px;color:#007AFF;font-family:var(--f);font-weight:400;justify-self:end;padding:6px 4px;white-space:nowrap;';
    msgsHeaderBtn.textContent = "DM's";
    msgsHeaderBtn.onclick = function() { chatView.style.transform = 'translateX(100%)'; setTimeout(() => openConversations(), 350); };

    tbInner.appendChild(backBtn); tbInner.appendChild(centerCol); tbInner.appendChild(msgsHeaderBtn);
    tb.appendChild(tbInner);
    chatView.appendChild(tb);

    /* Messages */
    var msgsArea = document.createElement('div');
    msgsArea.id = 'chat-messages-' + otherUserId;
    msgsArea.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 12px 8px;display:flex;flex-direction:column;gap:4px;background:var(--bg);';
    chatView.appendChild(msgsArea);

    /* Input — area blends with bg; the textarea keeps its own color to look floating */
    var inputArea = document.createElement('div');
    inputArea.style.cssText = 'flex-shrink:0;padding:8px 12px calc(var(--nav-h) + env(safe-area-inset-bottom,0px) - 40px);background:var(--bg);display:flex;gap:8px;align-items:flex-end;';
    var ta = document.createElement('textarea');
    ta.id = 'chat-input-' + otherUserId;
    ta.placeholder = 'iMessage'; ta.rows = 1;
    ta.style.cssText = 'flex:1;background:var(--surface);border:1px solid var(--border);border-radius:22px;padding:10px 16px;font-family:var(--f);font-size:16px;color:var(--tw);outline:none;resize:none;max-height:120px;line-height:1.4;';
    ta.oninput = function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; };
    (function(_ouid) { ta.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMsg(_ouid); } }; })(otherUserId);
    var sendBtn = document.createElement('button');
    sendBtn.style.cssText = 'width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#c4881e,#e8a825);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>';
    (function(_ouid) { sendBtn.onclick = function() { _sendMsg(_ouid); }; })(otherUserId);
    inputArea.appendChild(ta); inputArea.appendChild(sendBtn);
    chatView.appendChild(inputArea);

    /* Show */
    chatView.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => { chatView.style.transform = 'translateX(0)'; }));

    /* Load history */
    if (myId) {
        const { data: msgs } = await window._sbClient.from('messages')
            .select('*')
            .or('and(from_id.eq.' + myId + ',to_id.eq.' + otherUserId + '),and(from_id.eq.' + otherUserId + ',to_id.eq.' + myId + ')')
            .order('created_at', {ascending: true}).limit(100);
        if (msgs) msgs.forEach(m => _appendBubble(m, m.from_id === myId, otherUserId));
        msgsArea.scrollTop = msgsArea.scrollHeight;
    }
}

async function _sendMsg(toId) {
    var ta = document.getElementById('chat-input-' + toId);
    if (!ta) { 
        // Fallback: find textarea in chat view
        var chatView = document.getElementById('club-chat-view');
        ta = chatView ? chatView.querySelector('textarea') : null;
    }
    var content = ta ? ta.value.trim() : '';
    if (!content) return;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    const { data: { session } } = await window._sbClient.auth.getSession();
    const myId = session?.user?.id; if (!myId) { showToast('Sesión expirada', 2000); return; }
    const { data: msg, error } = await window._sbClient.from('messages')
        .insert({from_id: myId, to_id: toId, content}).select().single();
    if (error) { showToast('Error: ' + error.message, 3000); return; }
    if (msg) {
        _appendBubble(msg, true, toId);
        var area = document.getElementById('chat-messages-' + toId);
        if (!area) { var chatView2 = document.getElementById('club-chat-view'); area = chatView2 ? chatView2.querySelector('[id^="chat-messages-"]') : null; }
        if (area) area.scrollTop = area.scrollHeight;
    }
}

function _appendBubble(msg, isMine, otherId) {
    var area = document.getElementById('chat-messages-' + otherId);
    if (!area) return;
    var time = new Date(msg.created_at).toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'});
    var isDark = document.body.classList.contains('dark-mode');
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:' + (isMine?'flex-end':'flex-start') + ';margin-bottom:2px;';
    var bubble = document.createElement('div');
    var bgColor = isMine ? '#0d2b55' : (isDark ? '#2c2c2e' : '#e9e9eb');
    var textColor = isMine ? '#fff' : (isDark ? '#fff' : '#000');
    var radius = isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px';
    bubble.style.cssText = 'max-width:72%;padding:9px 14px;border-radius:' + radius + ';background:' + bgColor + ';color:' + textColor + ';font-size:15px;line-height:1.45;word-break:break-word;';
    bubble.textContent = msg.content;
    var timeEl = document.createElement('div');
    timeEl.style.cssText = 'font-size:10px;color:var(--tm);margin-top:3px;padding:0 4px;';
    timeEl.textContent = time;
    wrap.appendChild(bubble);
    wrap.appendChild(timeEl);
    area.appendChild(wrap);
}

/* ── Forced unread (long-press → "marcar como no leído") ───────────
   Persistencia local con localStorage. Clave: _uk('mr_unread_chat_' + otherId)
   Valor: '1' si está marcada como no leída a la fuerza, ausente si no.
   Se limpia automáticamente al abrir la conversación. */
function _isForcedUnread(otherId) {
    try { return localStorage.getItem(_uk('mr_unread_chat_' + otherId)) === '1'; }
    catch(e) { return false; }
}
function _setForcedUnread(otherId, val) {
    try {
        var k = _uk('mr_unread_chat_' + otherId);
        if (val) localStorage.setItem(k, '1');
        else localStorage.removeItem(k);
    } catch(e) {}
}
function _getForcedUnreadCount() {
    try {
        var n = 0, pre = _uk('mr_unread_chat_');
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf(pre) === 0 && localStorage.getItem(k) === '1') n++;
        }
        return n;
    } catch(e) { return 0; }
}

async function openConversations() {
    var convView = document.getElementById('club-convs-view');
    if (!convView) {
        convView = document.createElement('div');
        convView.id = 'club-convs-view';
        convView.style.cssText = 'position:fixed;inset:0;z-index:20001;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);';
        document.body.appendChild(convView);
    }
    // Cabecera estilo CLUB (igual lenguaje visual)
    convView.innerHTML =
        '<div style="flex-shrink:0;padding:calc(env(safe-area-inset-top,0px)+8px) 15px 14px;background:var(--bg);border-bottom:2px solid var(--gold-bd);position:relative;">'
        +   '<div aria-hidden="true" style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:280px;height:120px;background:radial-gradient(ellipse at center top,rgba(143,26,40,.12) 0%,rgba(143,26,40,.04) 50%,transparent 75%);pointer-events:none;"></div>'
        +   '<div style="position:relative;display:flex;align-items:center;justify-content:space-between;height:44px;">'
        +     '<button onclick="document.getElementById(\'club-convs-view\').style.transform=\'translateX(100%)\';" style="width:42px;height:42px;border-radius:50%;border:1.5px solid var(--gold-bd);background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.06);">'
        +       '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tw)" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>'
        +     '</button>'
        +     '<div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);font-size:26px;font-weight:900;color:var(--crimson);letter-spacing:3px;text-align:center;pointer-events:none;">MENSAJES</div>'
        +     '<div style="width:42px;flex-shrink:0;"></div>'
        +   '</div>'
        + '</div>'
        + '<div id="convs-list" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 0 24px;background:var(--bg);"></div>';
    convView.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => { convView.style.transform = 'translateX(0)'; }));

    // Skeleton mientras carga
    var _convsListEl = document.getElementById('convs-list');
    if (_convsListEl) {
        if (typeof fxSkeleton === 'function') {
            var skWrap = document.createElement('div');
            skWrap.style.cssText = 'padding:6px 18px;';
            fxSkeleton(skWrap, { count: 4, template: 'list' });
            _convsListEl.appendChild(skWrap);
        } else {
            _convsListEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--tm);font-size:13px;">Cargando…</div>';
        }
    }

    const { data: { session } } = await window._sbClient.auth.getSession();
    if (!session) return;
    const { data: convs } = await window._sbClient.rpc('get_conversations', {for_user_id: session.user.id});
    var list = document.getElementById('convs-list');
    if (!list) return;
    if (!convs || !convs.length) {
        list.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 30px;color:var(--tm);text-align:center;">'
            + '<div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(196,136,30,.15),rgba(143,26,40,.10));display:flex;align-items:center;justify-content:center;margin-bottom:16px;border:1.5px solid var(--gold-bd);">'
            +   '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
            + '</div>'
            + '<div style="font-size:15px;font-weight:700;color:var(--tw);margin-bottom:4px;">Sin conversaciones</div>'
            + '<div style="font-size:12px;color:var(--tm);line-height:1.5;">Toca el 💬 en una tarjeta del Club<br>para empezar a chatear.</div>'
            + '</div>';
        return;
    }
    list.innerHTML = '';
    convs.forEach(c => {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;overflow:hidden;';
        var delBg = document.createElement('div');
        delBg.style.cssText = 'position:absolute;inset:0;background:linear-gradient(90deg,#dc2626,#ef4444);display:flex;align-items:center;justify-content:end;padding-right:26px;opacity:0;transition:opacity .15s;pointer-events:none;';
        delBg.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
        wrap.appendChild(delBg);
        var el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;gap:13px;padding:11px 18px;cursor:pointer;background:var(--bg);transform:translateX(0);transition:transform .25s cubic-bezier(.25,.46,.45,.94);will-change:transform;';
        // Estado efectivo de no-leído: RPC (BD) OR forced local
        var forced = _isForcedUnread(c.other_id);
        var hasUnread = (c.unread_count > 0) || forced;
        (function(_id, _un, _ua, _wrap, _el, _delBg) {
            var startX=0,startY=0,curX=0,swiping=false,swipeAxis=null,revealed=false;
            var lpTimer=null,lpFired=false,lpStartX=0,lpStartY=0;
            function cancelLongPress(){ if(lpTimer){clearTimeout(lpTimer);lpTimer=null;} }
            _el.addEventListener('touchstart',function(e){
                startX=e.touches[0].clientX;startY=e.touches[0].clientY;curX=0;swiping=true;swipeAxis=null;_el.style.transition='none';
                if(revealed)return; // si swipe revelado, no long-press
                lpStartX=startX;lpStartY=startY;lpFired=false;
                lpTimer=setTimeout(function(){
                    lpFired=true;lpTimer=null;
                    // Vibración suave si está disponible
                    try{ if(navigator.vibrate)navigator.vibrate(15); }catch(e){}
                    // Feedback visual: scale ligero
                    _el.style.transition='transform .15s ease';
                    _el.style.transform='scale(0.97)';
                    setTimeout(function(){ _el.style.transform='scale(1)'; setTimeout(function(){ _el.style.transition='transform .25s cubic-bezier(.25,.46,.45,.94)'; },150); },120);
                    _openConvActionSheet(_id, _un, _ua);
                }, 500);
            },{passive:true});
            _el.addEventListener('touchmove',function(e){
                if(!swiping)return;
                var dx=e.touches[0].clientX-startX,dy=e.touches[0].clientY-startY;
                // Si el dedo se mueve >6px en cualquier eje → cancelar long-press
                if(lpTimer&&(Math.abs(e.touches[0].clientX-lpStartX)>6||Math.abs(e.touches[0].clientY-lpStartY)>6)) cancelLongPress();
                if(!swipeAxis&&(Math.abs(dx)>6||Math.abs(dy)>6))swipeAxis=Math.abs(dx)>Math.abs(dy)*1.2?'h':'v';
                if(swipeAxis!=='h')return;
                if(dx<0&&!revealed){curX=Math.max(-80,dx);_el.style.transform='translateX('+curX+'px)';_delBg.style.opacity=String(Math.min(1,Math.abs(curX)/80));}
                else if(revealed&&dx>0){curX=Math.min(0,dx-80);_el.style.transform='translateX('+curX+'px)';_delBg.style.opacity=String(Math.max(0,1+curX/80));}
            },{passive:true});
            _el.addEventListener('touchend',function(){
                cancelLongPress();
                swiping=false;_el.style.transition='transform .25s cubic-bezier(.25,.46,.45,.94)';
                if(curX<-44&&!revealed){_el.style.transform='translateX(-80px)';_delBg.style.opacity='1';_delBg.style.pointerEvents='auto';revealed=true;}
                else if(revealed&&curX>-40){_el.style.transform='translateX(0)';_delBg.style.opacity='0';_delBg.style.pointerEvents='none';revealed=false;}
                else if(!revealed){_el.style.transform='translateX(0)';_delBg.style.opacity='0';}
            });
            _el.addEventListener('touchcancel',cancelLongPress);
            // Mouse fallback para escritorio
            var msDown=false,msTimer=null,msStartX=0,msStartY=0;
            _el.addEventListener('mousedown',function(e){
                if(revealed)return;
                msDown=true;msStartX=e.clientX;msStartY=e.clientY;lpFired=false;
                msTimer=setTimeout(function(){
                    if(!msDown)return;
                    lpFired=true;msTimer=null;
                    _el.style.transition='transform .15s ease';
                    _el.style.transform='scale(0.97)';
                    setTimeout(function(){ _el.style.transform='scale(1)'; setTimeout(function(){ _el.style.transition='transform .25s cubic-bezier(.25,.46,.45,.94)'; },150); },120);
                    _openConvActionSheet(_id, _un, _ua);
                },500);
            });
            _el.addEventListener('mousemove',function(e){
                if(!msDown)return;
                if(msTimer&&(Math.abs(e.clientX-msStartX)>6||Math.abs(e.clientY-msStartY)>6)){clearTimeout(msTimer);msTimer=null;}
            });
            _el.addEventListener('mouseup',function(){ msDown=false; if(msTimer){clearTimeout(msTimer);msTimer=null;} });
            _el.addEventListener('mouseleave',function(){ msDown=false; if(msTimer){clearTimeout(msTimer);msTimer=null;} });
            _el.onclick=function(e){
                if(lpFired){lpFired=false;return;} // long-press ya abrió el sheet
                if(revealed){_el.style.transform='translateX(0)';_delBg.style.opacity='0';_delBg.style.pointerEvents='none';revealed=false;return;}
                convView.style.transform='translateX(100%)';setTimeout(()=>openChat(_id,_un,_ua),350);
            };
            _delBg.addEventListener('click',async function(){
                if(!confirm('¿Eliminar esta conversación?')){_el.style.transform='translateX(0)';_delBg.style.opacity='0';_delBg.style.pointerEvents='none';revealed=false;return;}
                try {
                    var { error } = await window._sbClient.rpc('delete_conversation_with', { _other_user_id: _id });
                    if (error) { console.error(error); showToast('Error al eliminar', 2200); _el.style.transform='translateX(0)';_delBg.style.opacity='0';_delBg.style.pointerEvents='none';revealed=false; return; }
                } catch(e) { console.error(e); showToast('Error al eliminar', 2200); _el.style.transform='translateX(0)';_delBg.style.opacity='0';_delBg.style.pointerEvents='none';revealed=false; return; }
                _setForcedUnread(_id, false); // limpiar flag local también
                _wrap.style.transition='opacity .2s,max-height .3s';_wrap.style.opacity='0';_wrap.style.maxHeight='0';_wrap.style.overflow='hidden';
                setTimeout(function(){if(_wrap.parentNode)_wrap.remove();},300);
                _refreshUnreadBadge();
                showToast('Conversación eliminada',1800);
            });
        })(c.other_id,c.other_username,c.other_avatar,wrap,el,delBg);
        var av = document.createElement('div');
        // Avatar 52px con anillo de gradiente sutil cuando hay no-leído
        if (hasUnread) {
            av.style.cssText = 'width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#e8a825,var(--crimson));padding:2px;flex-shrink:0;position:relative;';
            var avInner = document.createElement('div');
            avInner.style.cssText = 'width:100%;height:100%;border-radius:50%;background:var(--crimson);overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;border:2px solid var(--bg);';
            if (c.other_avatar){var ai=document.createElement('img');ai.src=c.other_avatar;ai.loading='lazy';ai.style.cssText='width:100%;height:100%;object-fit:cover;';avInner.appendChild(ai);}
            else avInner.textContent=(c.other_username||'×')[0].toUpperCase();
            av.appendChild(avInner);
        } else {
            av.style.cssText = 'width:52px;height:52px;border-radius:50%;background:var(--crimson);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;position:relative;box-shadow:0 1px 4px rgba(0,0,0,.10);';
            if (c.other_avatar){var ai=document.createElement('img');ai.src=c.other_avatar;ai.loading='lazy';ai.style.cssText='width:100%;height:100%;object-fit:cover;';av.appendChild(ai);}
            else av.textContent=(c.other_username||'×')[0].toUpperCase();
        }
        if(hasUnread){
            var ub=document.createElement('span');
            ub.style.cssText='position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:var(--crimson);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg);padding:0 4px;box-shadow:0 1px 3px rgba(0,0,0,.20);';
            // Si solo es forced (sin mensajes reales sin leer en BD), no mostramos número, solo un punto
            ub.textContent = c.unread_count > 0 ? String(c.unread_count) : '';
            if (c.unread_count === 0 && forced) { ub.style.minWidth='11px'; ub.style.height='11px'; ub.style.borderRadius='50%'; ub.style.top='0'; ub.style.right='0'; ub.style.padding='0'; }
            av.appendChild(ub);
        }
        var info=document.createElement('div');info.style.cssText='flex:1;min-width:0;line-height:1.35;';
        var lastAt = _imessageTime(c.last_at);
        var nameColor = hasUnread ? 'var(--tw)' : 'var(--tw)';
        var msgColor  = hasUnread ? 'var(--tw)' : 'var(--ts)';
        var msgWeight = hasUnread ? '600' : '500';
        var timeColor = hasUnread ? 'var(--crimson)' : 'var(--tm)';
        var timeWeight = hasUnread ? '700' : '500';
        var _displayName = c.other_username ? ('@' + c.other_username) : '[usuario eliminado]';
        info.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">'
          +   '<span style="font-size:15px;font-weight:700;color:'+nameColor+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.1px;'+(c.other_username?'':'font-style:italic;opacity:.7;')+'">'+_displayName+'</span>'
          +   '<span style="font-size:11.5px;color:'+timeColor+';font-weight:'+timeWeight+';white-space:nowrap;flex-shrink:0;">'+lastAt+'</span>'
          + '</div>'
          + '<div style="font-size:13px;color:'+msgColor+';font-weight:'+msgWeight+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">'+(c.last_message||'')+'</div>';
        el.appendChild(av);el.appendChild(info);wrap.appendChild(el);list.appendChild(wrap);
    });
}

/* Action sheet del long-press en la lista de conversaciones */
/* Borrado de conversación entera con otro usuario.
   Usa la RPC delete_conversation_with(_other_user_id) SECURITY DEFINER.
   Confirma con confirm() nativo, refresca UI y badges. */
async function _deleteConversationWith(otherId, otherUsername) {
    if (!confirm('¿Eliminar toda la conversación con @' + (otherUsername || '') + '?\n\nSe borrarán todos los mensajes en ambas direcciones. Esta acción no se puede deshacer.')) return false;
    try {
        var { data, error } = await window._sbClient.rpc('delete_conversation_with', { _other_user_id: otherId });
        if (error) {
            console.error('delete_conversation_with error:', error);
            showToast('Error al eliminar la conversación', 2200);
            return false;
        }
        // Limpiar flag local de "marcado como no leído" si existía
        if (typeof _setForcedUnread === 'function') _setForcedUnread(otherId, false);
        // Si el chat con este usuario está abierto, cerrarlo
        if (_activeChatUserId === otherId) {
            var cv = document.getElementById('club-chat-view');
            if (cv) { cv.style.transform = 'translateX(100%)'; }
            _activeChatUserId = null;
            _setThemeColor('#c4881e');
        }
        _refreshUnreadBadge();
        showToast('Conversación eliminada', 1800);
        // Si la lista de conversaciones está visible, refrescarla
        var convView = document.getElementById('club-convs-view');
        if (convView && convView.style.transform === 'translateX(0px)') {
            setTimeout(function(){ openConversations(); }, 250);
        }
        return true;
    } catch (e) {
        console.error('delete_conversation_with exception:', e);
        showToast('Error al eliminar la conversación', 2200);
        return false;
    }
}

function _openConvActionSheet(otherId, otherUsername, otherAvatar) {
    // Cerrar cualquier sheet previo
    var prev = document.getElementById('conv-action-sheet');
    if (prev) prev.remove();

    var overlay = document.createElement('div');
    overlay.id = 'conv-action-sheet';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:20010;background:rgba(0,0,0,0.5);opacity:0;transition:opacity .2s;display:flex;flex-direction:column;justify-content:flex-end;';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:var(--card);border-top-left-radius:18px;border-top-right-radius:18px;padding:8px 12px calc(env(safe-area-inset-bottom,0px) + 16px);transform:translateY(100%);transition:transform .28s cubic-bezier(.32,.72,0,1);';

    var grabber = document.createElement('div');
    grabber.style.cssText = 'width:38px;height:4px;background:var(--bsoft);border-radius:2px;margin:8px auto 14px;';
    sheet.appendChild(grabber);

    var header = document.createElement('div');
    header.style.cssText = 'font-size:13px;color:var(--tm);text-align:center;margin-bottom:10px;';
    header.textContent = '@' + otherUsername;
    sheet.appendChild(header);

    var forced = _isForcedUnread(otherId);
    var actionLabel = forced ? 'Marcar como leído' : 'Marcar como no leído';
    var actionIcon = forced
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/></svg>';

    var btnAction = document.createElement('button');
    btnAction.style.cssText = 'width:100%;display:flex;align-items:center;gap:14px;padding:14px 14px;background:transparent;border:none;border-radius:12px;cursor:pointer;color:var(--tw);font-size:15px;font-weight:600;text-align:left;';
    btnAction.innerHTML = '<span style="color:var(--crimson);display:flex;">' + actionIcon + '</span><span>' + actionLabel + '</span>';
    btnAction.onclick = function() {
        _setForcedUnread(otherId, !forced);
        _refreshUnreadBadge();
        closeSheet();
        showToast(forced ? 'Marcado como leído' : 'Marcado como no leído', 1500);
        // Refrescar la lista para reflejar el cambio
        setTimeout(function(){ if(document.getElementById('club-convs-view') && document.getElementById('club-convs-view').style.transform === 'translateX(0px)') openConversations(); }, 200);
    };
    sheet.appendChild(btnAction);

    var sep1 = document.createElement('div');
    sep1.style.cssText = 'height:1px;background:var(--bsoft);margin:4px 8px;';
    sheet.appendChild(sep1);

    // Botón Eliminar conversación
    var btnDelete = document.createElement('button');
    btnDelete.style.cssText = 'width:100%;display:flex;align-items:center;gap:14px;padding:14px 14px;background:transparent;border:none;border-radius:12px;cursor:pointer;color:var(--crimson);font-size:15px;font-weight:600;text-align:left;';
    btnDelete.innerHTML = '<span style="display:flex;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4c0-.5.4-1 1-1h4c.5 0 1 .4 1 1v2"/></svg></span><span>Eliminar conversación</span>';
    btnDelete.onclick = function(){
        closeSheet();
        // Pequeño delay para que se cierre suave antes de mostrar el confirm
        setTimeout(function(){ _deleteConversationWith(otherId, otherUsername); }, 200);
    };
    sheet.appendChild(btnDelete);

    var sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--bsoft);margin:4px 8px;';
    sheet.appendChild(sep);

    var btnCancel = document.createElement('button');
    btnCancel.style.cssText = 'width:100%;padding:14px;background:transparent;border:none;border-radius:12px;cursor:pointer;color:var(--ts);font-size:15px;font-weight:600;';
    btnCancel.textContent = 'Cancelar';
    btnCancel.onclick = function(){ closeSheet(); };
    sheet.appendChild(btnCancel);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    function closeSheet(){
        overlay.style.opacity = '0';
        sheet.style.transform = 'translateY(100%)';
        setTimeout(function(){ if(overlay.parentNode) overlay.remove(); }, 280);
    }
    overlay.addEventListener('click', function(e){ if(e.target===overlay) closeSheet(); });

    requestAnimationFrame(function(){ requestAnimationFrame(function(){
        overlay.style.opacity = '1';
        sheet.style.transform = 'translateY(0)';
    });});
}

/* ── Pull to refresh ─────────────────────────────────────────────── */
function _initPTR() {
    var feed = document.getElementById('club-feed');
    if (!feed || feed._ptr) return; feed._ptr = true;
    var startY = 0, pulling = false, triggered = false;
    feed.addEventListener('touchstart', function(e) { if (feed.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; triggered = false; } }, {passive: true});
    feed.addEventListener('touchmove', function(e) { if (!pulling) return; var dy = e.touches[0].clientY - startY; if (dy > 65 && !triggered) { triggered = true; } }, {passive: true});
    feed.addEventListener('touchend', function() {
        if (!pulling) return;
        pulling = false;
        if (triggered) {
            triggered = false;
            var _tab = localStorage.getItem(_uk('mr_club_tab')) || 'all';
            if (_tab === 'crews' && typeof renderClubCrewsList === 'function') renderClubCrewsList();
            else if (_tab === 'records' && typeof renderClubRecordsRanking === 'function') renderClubRecordsRanking();
            else renderClubFeed();
        }
    }, {passive: true});
}
