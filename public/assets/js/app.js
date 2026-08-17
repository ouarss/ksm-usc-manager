// USC Manager — vanilla JS front-end. No dependency, no CDN.

const state = {
    paths: null,
    stats: null,
    collections: [],
    tree: [],
    canBrowse: false,
    favDiverged: [], // collections whose DB rows no longer match their .fav mirror
    nautica: null, // { enabled, dir, new_count }
    view: { type: null, key: null, label: '' },
    // Explorer page (Songs/Charts/Artists/Effectors): scope + its filters
    explore: { scope: 'songs', q: '', levels: [], diffs: [], page: 1, sort: 'title' },
    songs: [],
    missing: [], // .fav entries of the current collection with no installed chart
    selected: new Set(), // folderids checked in the current view
    rendered: 0,
    playing: null, // folderid
};

const CHUNK_SIZE = 150;
const $ = (sel) => document.querySelector(sel);

/* ---------- i18n ---------- */

// English source strings are the keys. Translations live in one file per
// language under assets/js/lang/<code>.js (loaded before this script); a
// missing key falls back to the English source. {x} = placeholder,
// {s}/{s2} = plural markers filled by callers.
// Available UI languages: [code, native label]. A new language = one file in
// assets/js/lang/, a <script> tag in index.php, and one entry here.
const LANG_CHOICES = [
    ['en', 'English'],
    ['fr', 'Français'],
    ['ja', '日本語'],
    ['zh', '中文'],
    ['ko', '한국어'],
];
const savedLang = localStorage.getItem('usc-lang');
const LANG = LANG_CHOICES.some(([code]) => code === savedLang) ? savedLang : 'en';
const DICT = (window.USC_I18N && window.USC_I18N[LANG]) || {};

function t(key, vars = null) {
    let out = DICT[key] ?? key;
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            out = out.replaceAll(`{${name}}`, String(value));
        }
    }

    return out;
}

// Plural helpers: '' or 's' (and French feminine 's' via s2 where EN has none)
const plural = (n) => (n > 1 ? 's' : '');

// Static HTML rendered by index.php: translated once at boot
function applyStaticI18n() {
    if (LANG === 'en') return;
    const set = (selector, key, prop = 'textContent') => {
        const node = document.querySelector(selector);
        if (node) node[prop] = t(key);
    };
    set('#btn-import', 'Import Collection');
    set('#btn-settings', 'Settings');
    set('#search', 'Title, artist, effector…', 'placeholder');
    set('#btn-share', 'Share');
    set('#btn-rename', 'Rename');
    set('#btn-delete', 'Delete');
    set('#btn-fix-now', 'Update paths now');
    set('#btn-fix-config', 'Fix Main.cfg');
    set('#btn-fav-review', 'Review collections');
    set('#btn-fix-all', 'Fix everything');
    set('#btn-fix-later', 'Later');
    set('#btn-nautica-open', 'Open Nautica');
    set('#btn-nautica-later', 'Later');
    set('#setup .setup-card > p:first-of-type', 'Point the tool to your game installation folder — the one containing maps.db.');
    set('#setup-root', 'e.g. Z:\\Games\\USC', 'placeholder');
    set('#setup-browse', 'Browse…');
    set('#setup-form button[type="submit"]', 'Connect');
    const library = document.querySelector('.nav-section[data-target="nav-folders"]');
    if (library) library.firstChild.textContent = t('Library');
    const sort = $('#sort');
    sort.options[0].text = t('Sort by title');
    sort.options[1].text = t('Sort by artist');
    sort.options[2].text = t('Sort by level');
}
applyStaticI18n();

const DIFF_COLORS = {
    NOV: 'var(--diff-nov)', ADV: 'var(--diff-adv)', EXH: 'var(--diff-exh)',
    INF: 'var(--diff-inf)', MXM: 'var(--diff-mxm)', GRV: 'var(--diff-grv)',
    HVN: 'var(--diff-hvn)', VVD: 'var(--diff-vvd)', XCD: 'var(--diff-hvn)',
};

/* ---------- API ---------- */

const api = async (action, { params = {}, body = null, formData = null } = {}) => {
    const url = new URL('api.php', window.location.href);
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const options = {};
    if (formData) {
        options.method = 'POST';
        options.body = formData;
    } else if (body !== null) {
        options.method = 'POST';
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({ error: t('Unreadable server response') }));
    if (!response.ok || data.error) {
        throw new Error(data.error || t('Error {n}', { n: response.status }));
    }

    return data;
};

/* ---------- Toasts ---------- */

const toast = (message, kind = '') => {
    const node = el('div', `toast ${kind}`);
    node.textContent = message;
    $('#toasts').appendChild(node);
    setTimeout(() => node.remove(), 4500);
};

/* ---------- DOM helpers ---------- */

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;

    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));

    return node;
}

// A displayable name even when a chart has no title (falls back to artist,
// then the song folder name)
function songLabel(song) {
    return (song.title || '').trim()
        || (song.artist || '').trim()
        || (song.folder ? song.folder.split('/').pop() : '')
        || t('(untitled)');
}

// "Add to collection" glyph: a playlist with a plus (uses currentColor, so it
// picks up the magenta in-collection state)
function collectIcon() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', class: 'ico' });
    for (const [x1, y1, x2, y2] of [[3, 6, 15, 6], [3, 11, 15, 11], [3, 16, 11, 16], [18, 13, 18, 21], [14, 17, 22, 17]]) {
        svg.appendChild(svgEl('line', { x1, y1, x2, y2 }));
    }

    return svg;
}

const NUM_LOCALE = LANG === 'fr' ? 'fr-FR' : 'en-US';
const DATE_LOCALE = { fr: 'fr-FR', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' }[LANG] || 'en-GB';

const formatInt = (n) => Number(n).toLocaleString(NUM_LOCALE);

const formatScore = formatInt;

const formatDate = (ts) => new Date(ts * 1000).toLocaleString(DATE_LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/* ---------- Init ---------- */

async function boot() {
    try {
        const data = await api('init');
        applyInit(data);
    } catch (error) {
        toast(error.message, 'error');
        // init died before telling us whether the folder picker is available:
        // probe it, so a failed init never leaves the setup screen without
        // its Browse button (the only way out on a bad game root).
        await probeBrowse();
        showSetup();
    }
}

async function probeBrowse() {
    try {
        await api('browse-list', { body: { path: '' } });
        state.canBrowse = true;
    } catch {
        state.canBrowse = false;
    }
    $('#setup-browse').classList.toggle('hidden', !state.canBrowse);
}

function applyInit(data) {
    state.paths = data.paths;
    state.stats = data.stats;
    state.collections = data.collections;
    state.tree = data.tree;
    state.canBrowse = Boolean(data.can_browse);
    state.favDiverged = data.fav_diverged || [];
    $('#setup-browse').classList.toggle('hidden', !state.canBrowse);

    // Collections re-created from .fav files at startup (maps.db was rebuilt,
    // or historical KShootMania .fav files never imported before)
    if (data.restored && data.restored.length) {
        const songs = data.restored.reduce((sum, r) => sum + r.songs, 0);
        toast(t('{n} collection{s} restored from .fav files ({m} songs)', { n: data.restored.length, s: plural(data.restored.length), m: formatInt(songs) }), 'success');
    }

    renderPathsAlert();

    if (!data.paths.mapsdb_path || !data.paths.songs_root) {
        showSetup(data.paths.mapsdb_path && !data.paths.songs_root
            ? t('Database found but empty: run the game once to index your songs.')
            : '');

        return;
    }

    $('#setup').classList.add('hidden');
    $('#app').classList.remove('hidden');
    state.nautica = data.nautica;
    renderStats();
    renderCollectionsNav();
    renderFoldersNav();
    renderNauticaNav();
    renderNauticaAlert();

    // First load only: honor a bookmarked/reloaded hash, else the Explorer
    if (!routeReady) {
        if (location.hash.slice(1)) applyRoute();
        else openExplorer('songs');
        routeReady = true;
    }
}

function showSetup(message = '') {
    $('#app').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    const error = $('#setup-error');
    error.textContent = message;
    error.classList.toggle('hidden', message === '');
    $('#setup-root').focus();
}

$('#setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    connectRoot(
        $('#setup-root').value,
        event.currentTarget.querySelector('button[type="submit"]'),
        (error) => showSetup(error.message),
    );
});

// Each stat opens its dedicated page
function renderStats() {
    const { stats } = state;
    const s = $('#stats');
    s.innerHTML = '';
    const parts = [
        [stats.songs, t('songs'), () => openExplorer('songs')],
        [stats.charts, t('charts'), () => openExplorer('charts')],
        [stats.collections, t('collections'), openCollectionsPage],
        [stats.scores, t('scores'), openScoresPage],
    ];
    parts.forEach(([value, label, open], index) => {
        const button = el('button', 'stat-link');
        button.append(el('b', '', formatInt(value)), ` ${label}`);
        button.addEventListener('click', open);
        s.appendChild(button);
        if (index < parts.length - 1) s.append(' · ');
    });
}

/* ---------- Navigation ---------- */

function renderCollectionsNav() {
    const list = $('#nav-collections');
    list.innerHTML = '';
    list.className = 'nav-list nav-list-collections';

    if (!state.collections.length) {
        list.appendChild(el('li', 'nav-empty', t('No collections yet. Add a song to a collection to create one.')));
    }

    for (const collection of state.collections) {
        const item = el('li');
        const button = el('button', 'nav-item');
        button.append(
            Object.assign(el('span', 'name', collection.name), { title: collection.name }),
            el('span', 'count', String(collection.songs)),
        );
        if (state.view.type === 'collection' && state.view.key === collection.name) {
            button.classList.add('active');
        }
        button.addEventListener('click', () => loadCollection(collection.name));
        item.appendChild(button);
        list.appendChild(item);
    }

    applyNavSections(); // re-render resets the class list
}

function renderFoldersNav() {
    const list = $('#nav-folders');
    list.innerHTML = '';

    const all = el('li');
    const allButton = el('button', 'nav-item');
    allButton.append(el('span', 'nav-twisty-blank'), el('span', 'name', t('All songs')), el('span', 'count', formatInt(state.stats.songs)));
    allButton.dataset.rel = '';
    allButton.addEventListener('click', () => loadFolder('', t('All songs')));
    all.appendChild(allButton);
    list.appendChild(all);

    for (const node of state.tree) {
        list.appendChild(folderNavItem(node));
    }
    applyNavSections();
    markActiveNav();
}

function folderNavItem(node) {
    const item = el('li');
    const button = el('button', 'nav-item');
    button.dataset.rel = node.rel;

    if (node.children.length) {
        const twisty = el('span', 'nav-twisty', '+');
        twisty.addEventListener('click', (event) => {
            event.stopPropagation();
            const subtree = item.querySelector('.nav-subtree');
            const collapsed = subtree.classList.toggle('collapsed');
            twisty.textContent = collapsed ? '+' : '−';
        });
        button.appendChild(twisty);
    } else {
        // Reserve the twisty's width so leaf folders align with expandable ones
        button.appendChild(el('span', 'nav-twisty-blank'));
    }

    button.append(
        Object.assign(el('span', 'name', node.name), { title: node.name }),
        el('span', 'count', String(node.songs)),
    );
    // Clicking a folder loads its songs AND unfolds its subfolders below;
    // the twisty alone toggles folding without loading.
    button.addEventListener('click', () => {
        const subtree = item.querySelector('.nav-subtree');
        if (subtree) {
            subtree.classList.remove('collapsed');
            const twisty = button.querySelector('.nav-twisty');
            if (twisty) twisty.textContent = '−';
        }
        loadFolder(node.rel, node.name);
    });
    item.appendChild(button);

    if (node.children.length) {
        const subtree = el('ul', 'nav-subtree collapsed');
        for (const child of node.children) {
            subtree.appendChild(folderNavItem(child));
        }
        item.appendChild(subtree);
    }

    return item;
}

function markActiveNav() {
    document.querySelectorAll('.nav-item.active').forEach((n) => n.classList.remove('active'));
    if (state.view.type === 'folder') {
        document.querySelectorAll('#nav-folders .nav-item').forEach((n) => {
            if (n.dataset.rel === state.view.key) n.classList.add('active');
        });
    }
}

/* ---------- Stale-paths alert ---------- */

// The database of a restored backup may still carry paths from another
// machine or drive. Browsing keeps working either way, but the game itself
// reads those paths — offer the fix upfront.
function renderPathsAlert() {
    const { paths, stats } = state;
    const alert = $('#paths-alert');
    const text = $('#paths-alert-text');
    const fixPaths = $('#btn-fix-now');
    const fixConfig = $('#btn-fix-config');
    const fixAll = $('#btn-fix-all');
    const favReview = $('#btn-fav-review');
    text.innerHTML = '';
    fixPaths.classList.add('hidden');
    fixConfig.classList.add('hidden');
    fixAll.classList.add('hidden');
    favReview.classList.add('hidden');

    // Nothing on disk to point the database at: only the user can fix this
    // (wrong game folder, or a drive that is not mounted).
    if (paths.mapsdb_path && !paths.songs_root_exists) {
        text.append(t('Your songs folder is missing: '));
        text.appendChild(el('code', '', paths.songs_root));
        text.append(t('. Reconnect the tool to the right game folder (Settings), or mount that drive.'));
        alert.classList.remove('hidden');

        return;
    }

    // Main.cfg carries a dead SongFolder (usually copied from another machine).
    // The tool falls back to <root>/songs to stay usable, but the game reads
    // Main.cfg literally — its next scan would index nothing. Offer to fix it.
    if (paths.config_song_folder_gone) {
        text.append(t('Your Main.cfg points at a songs folder that no longer exists: '));
        text.appendChild(el('code', '', paths.config_song_folder));
        text.append(t('. The game will index nothing until this is fixed — it should point to '));
        text.appendChild(el('code', '', paths.songs_root));
        text.append(t('. A backup of Main.cfg is made first.'));
        fixConfig.classList.remove('hidden');
        fixAll.classList.remove('hidden');
        alert.classList.remove('hidden');

        return;
    }

    // maps.db is reachable and songs exist on disk, but no chart is indexed:
    // only the game builds Folders/Charts, so send the user there. Collections
    // and scores live in other tables and are kept.
    if (paths.mapsdb_path && paths.songs_root_exists && stats && stats.charts === 0) {
        text.append(t('Your song index is empty: launch the game once to build it. Your collections and scores are kept.'));
        alert.classList.remove('hidden');

        return;
    }

    if (!paths.paths_mismatch) {
        // Paths are healthy: last check is the .fav mirrors. A divergence means
        // the game rebuilt its index and recycled folderids — the collections
        // in the DB point at the wrong songs while the mirrors kept the truth.
        if (state.favDiverged.length) {
            const n = state.favDiverged.length;
            text.append(t('{n} collection{s} no longer match their .fav mirror files (this happens when the game rebuilds its index). The mirrors hold the good copy.', { n, s: plural(n) }));
            favReview.classList.remove('hidden');
            fixAll.classList.remove('hidden');
            alert.classList.remove('hidden');

            return;
        }
        alert.classList.add('hidden');

        return;
    }

    text.append(t('Your database points to '));
    text.appendChild(el('code', '', paths.db_songs_root));
    text.append(t(' but your songs folder is '));
    text.appendChild(el('code', '', paths.songs_root));
    text.append(t('. The game needs matching paths. A database backup is made first.'));
    fixPaths.classList.remove('hidden');
    fixAll.classList.remove('hidden');

    alert.classList.remove('hidden');
}

// Rewrite the database's path prefix onto the real songs folder. The server
// takes a full maps.db backup before touching anything.
async function applyPathFix(button, onDone = null) {
    const { paths } = state;
    button.disabled = true;
    try {
        const data = await api('fix-paths', {
            body: {
                from: paths.db_songs_root,
                to: paths.songs_root,
            },
        });
        if (onDone) onDone();
        toast(t('{n} folders and {m} charts updated', { n: formatInt(data.folders_updated), m: formatInt(data.charts_updated) }), 'success');
        await boot();
        reloadCurrentView();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

// Offered right after connecting a game folder, when the database still
// carries the paths of another machine or drive.
function promptPathFix() {
    openModal((modal) => {
        const { paths } = state;
        modal.appendChild(el('h3', '', t('Update the database paths?')));

        const note = el('p', 'note note-warn');
        note.append(t('Your database points to '));
        note.appendChild(el('code', '', paths.db_songs_root));
        note.append(t(' but your songs folder is '));
        note.appendChild(el('code', '', paths.songs_root));
        note.append(t('. The game needs matching paths. A database backup is made first.'));
        modal.appendChild(note);

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Later'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Back up and update paths'));
        confirm.addEventListener('click', () => applyPathFix(confirm, closeModal));
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

// Rewrite Main.cfg's SongFolder onto the real songs folder (the game scans it
// literally). The server backs Main.cfg up first, then we re-init.
async function applyConfigFix(button) {
    button.disabled = true;
    try {
        await api('fix-config', { body: {} });
        toast(t('Main.cfg updated — launch the game to rebuild its song index.'), 'success');
        await boot();
        reloadCurrentView();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

$('#btn-fix-later').addEventListener('click', () => {
    $('#paths-alert').classList.add('hidden');
});

$('#btn-fix-now').addEventListener('click', (event) => {
    applyPathFix(event.currentTarget);
});

$('#btn-fix-config').addEventListener('click', (event) => {
    applyConfigFix(event.currentTarget);
});

$('#btn-fav-review').addEventListener('click', () => {
    openCollectionsPage();
});

$('#btn-fix-all').addEventListener('click', promptFixAll);

// One-click repair after a game-folder move: Main.cfg, the DB path prefixes,
// then every collection whose .fav mirror diverged. Full backup server-side.
function promptFixAll() {
    openModal((modal) => {
        const { paths } = state;
        modal.appendChild(el('h3', '', t('Fix everything?')));
        modal.appendChild(el('p', 'note', t('A full database backup is taken first, then:')));
        const list = el('ul', 'note');
        if (paths.config_song_folder_gone) {
            list.appendChild(el('li', '', t('Rewrite the stale SongFolder in Main.cfg (backed up first)')));
        }
        if (paths.paths_mismatch) {
            list.appendChild(el('li', '', t('Update the database paths onto the songs folder')));
        }
        if (state.favDiverged.length) {
            list.appendChild(el('li', '', t('Restore {n} collection{s} from the .fav mirror files', { n: state.favDiverged.length, s: plural(state.favDiverged.length) })));
        }
        modal.appendChild(list);

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Back up and fix'));
        confirm.addEventListener('click', () => applyFixAll(confirm));
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

async function applyFixAll(button) {
    button.disabled = true;
    try {
        const report = await api('fix-all', { body: {} });
        closeModal();
        if (report.config_fixed) {
            toast(t('Main.cfg updated — launch the game to rebuild its song index.'), 'success');
        }
        if (report.folders_updated || report.charts_updated) {
            toast(t('{n} folders and {m} charts updated', { n: formatInt(report.folders_updated), m: formatInt(report.charts_updated) }), 'success');
        }
        if (report.resynced.length) {
            const songs = report.resynced.reduce((sum, r) => sum + r.matched, 0);
            toast(t('{n} collection{s} restored from .fav files ({m} songs)', { n: report.resynced.length, s: plural(report.resynced.length), m: formatInt(songs) }), 'success');
        }
        for (const skip of report.skipped) {
            toast(t('{c} skipped: {r}', { c: skip.name, r: skip.reason }), 'error');
        }
        if (!report.config_fixed && !report.folders_updated && !report.resynced.length && !report.skipped.length) {
            toast(t('Nothing to fix.'), 'success');
        }
        await boot();
        reloadCurrentView();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

// A diverged collection's .fav mirror carries content the database lost
// (typically after the game rebuilt its index). Any write regenerates the
// mirror from the database and destroys that copy: warn before the first one.
function confirmDivergedWrite(name, onConfirm) {
    const diverged = state.favDiverged.find((d) => d.name === name);
    if (!diverged) return onConfirm();
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Edit a diverged collection?')));
        modal.appendChild(el('p', 'note note-warn',
            t('The .fav mirror of "{c}" differs from the database. Editing now regenerates the mirror from the database and that difference is lost. If the mirror holds the good copy (after a game re-index), restore it first from the Collections page.', { c: name })));

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Edit anyway'));
        confirm.addEventListener('click', () => {
            state.favDiverged = state.favDiverged.filter((d) => d.name !== name);
            closeModal();
            renderPathsAlert();
            onConfirm();
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

// Re-open the current view in place (after a path fix, a collection edit…).
function reloadCurrentView() {
    const view = state.view;
    if (view.type === 'folder') loadFolder(view.key, view.label);
    else if (view.type === 'collection') loadCollection(view.key);
    else if (view.type === 'artist') loadArtist(view.key);
    else if (view.type === 'page') applyRoute();
}

/* ---------- Routing (hash slugs + browser history) ---------- */

let routeReady = false; // first navigation replaces history instead of pushing

// A view -> URL slug. Keys with '/' (folder paths) are percent-encoded.
function viewSlug(view) {
    switch (view.type) {
        case 'folder': return view.key === '' ? 'folder' : 'folder/' + encodeURIComponent(view.key);
        case 'collection': return 'collection/' + encodeURIComponent(view.key);
        case 'artist': return 'artist/' + encodeURIComponent(view.key);
        // Explorer scopes (songs/charts/artists/effectors) and the standalone
        // pages (scores/collections/nautica). A search seeds the scope with a q.
        case 'page': return view.q ? 'search/' + encodeURIComponent(view.q) : view.key;
        default: return 'songs';
    }
}

// Reflect the current view in the address bar. No-op when already there, so
// applyRoute() (fired by Back) never pushes a duplicate entry.
function syncHash(view) {
    const slug = viewSlug(view);
    if (location.hash.slice(1) === slug) return;
    if (routeReady) history.pushState({}, '', '#' + slug);
    else history.replaceState({}, '', '#' + slug);
}

// Open whatever view the current hash points to (used at boot and on Back).
function applyRoute() {
    const slug = location.hash.slice(1);
    const slash = slug.indexOf('/');
    const head = slash === -1 ? slug : slug.slice(0, slash);
    const rest = slash === -1 ? '' : decodeURIComponent(slug.slice(slash + 1));

    switch (head) {
        case '':
        case 'songs': return openExplorer('songs');
        case 'charts': return openExplorer('charts');
        case 'artists': return openExplorer('artists');
        case 'effectors': return openExplorer('effectors');
        case 'search': return openExplorer('songs', { q: rest });
        case 'folder': return loadFolder(rest, rest.split('/').pop() || t('All songs'));
        case 'collection': return loadCollection(rest);
        case 'artist': return loadArtist(rest);
        case 'scores': return openScoresPage();
        case 'collections': return openCollectionsPage();
        case 'nautica':
            if (state.nautica?.enabled) return openNauticaPage();
            return openExplorer('songs');
        default: return openExplorer('songs');
    }
}

window.addEventListener('popstate', applyRoute);

/* ---------- Views ---------- */

async function loadFolder(rel, label) {
    await loadView({ type: 'folder', key: rel, label }, () =>
        api('songs', { params: { folder: rel } }));
}

async function loadCollection(name) {
    await loadView({ type: 'collection', key: name, label: name }, () =>
        api('collection', { params: { name } }));
}

async function loadView(view, fetcher) {
    const listNode = $('#songlist');
    listNode.innerHTML = '';
    listNode.appendChild(el('p', 'songlist-empty', t('Loading…')));
    state.view = view;
    syncHash(view);
    state.selected.clear();
    $('#context').classList.remove('page-mode', 'explorer-mode');
    $('#nautica-section').classList.remove('active');
    updateSelectionUi();
    renderContext();
    renderCollectionsNav();
    markActiveNav();

    try {
        const data = await fetcher();
        state.songs = sortSongs(data.songs, $('#sort').value);
        state.missing = data.missing || [];
        renderSongList(true);
        renderContext();
    } catch (error) {
        listNode.innerHTML = '';
        listNode.appendChild(el('p', 'songlist-empty', error.message));
    }
}

function renderContext() {
    const titleNode = $('#context-title');
    titleNode.innerHTML = '';
    if (state.view.type === 'folder' && state.view.key !== '') {
        titleNode.appendChild(breadcrumb(state.view.key));
    } else {
        titleNode.textContent = state.view.label || ' ';
    }
    let count = state.songs.length
        ? t('{n} song{s}', { n: formatInt(state.songs.length), s: plural(state.songs.length) })
        : '';
    if (state.missing.length) {
        count += (count ? ' · ' : '') + t('{n} not installed', { n: formatInt(state.missing.length) });
    }
    $('#context-count').textContent = count;
    $('#collection-actions').classList.toggle('hidden', state.view.type !== 'collection');
}

// Clickable trail back up to the library root
function breadcrumb(rel) {
    const wrap = el('span', 'crumbs');
    const root = el('button', 'crumb', t('All songs'));
    root.addEventListener('click', () => loadFolder('', t('All songs')));
    wrap.appendChild(root);

    const parts = rel.split('/');
    let acc = '';
    parts.forEach((part, index) => {
        wrap.appendChild(el('span', 'crumb-sep', ' / '));
        acc = acc === '' ? part : `${acc}/${part}`;
        if (index === parts.length - 1) {
            wrap.appendChild(el('span', '', part));
        } else {
            const target = acc;
            const link = el('button', 'crumb', part);
            link.addEventListener('click', () => loadFolder(target, part));
            wrap.appendChild(link);
        }
    });

    return wrap;
}

function sortSongs(songs, mode) {
    const sorted = [...songs];
    if (mode === 'title') {
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }));
    } else if (mode === 'artist') {
        sorted.sort((a, b) => a.artist.localeCompare(b.artist, 'en', { sensitivity: 'base', numeric: true }));
    } else if (mode === 'level') {
        const max = (song) => Math.max(...song.charts.map((c) => c.level));
        sorted.sort((a, b) => max(b) - max(a));
    }

    return sorted;
}

$('#sort').addEventListener('change', () => {
    if (state.view.type === 'page') return;
    state.songs = sortSongs(state.songs, $('#sort').value);
    renderSongList(true);
});

/* ---------- Song list (chunked rendering) ---------- */

function renderSongList(reset) {
    const listNode = $('#songlist');
    if (reset) {
        listNode.innerHTML = '';
        state.rendered = 0;
        listNode.scrollTop = 0;
    }

    if (!state.songs.length && !state.missing.length) {
        listNode.appendChild(el('p', 'songlist-empty', emptyMessage()));

        return;
    }

    const slice = state.songs.slice(state.rendered, state.rendered + CHUNK_SIZE);
    const fragment = document.createDocumentFragment();
    for (const song of slice) {
        fragment.appendChild(songRow(song));
    }
    listNode.appendChild(fragment);
    state.rendered += slice.length;

    // Greyed entries: songs kept in the .fav but not installed — after the
    // last real row, once
    if (state.rendered === state.songs.length && state.missing.length && !listNode.querySelector('.song.missing')) {
        for (const entry of state.missing) {
            listNode.appendChild(missingRow(entry));
        }
    }
}

function missingRow(entry) {
    const row = el('div', 'song missing');
    const jacket = el('div', 'jacket');
    jacket.appendChild(el('div', 'jacket-fallback', '?'));

    const info = el('div', 'song-info');
    const title = el('p', 'song-title');
    title.appendChild(el('span', 'song-title-text', entry.name));
    info.appendChild(title);
    if (entry.parent) info.appendChild(el('p', 'song-artist', entry.parent));
    info.appendChild(el('p', 'song-sub', t('Not installed — kept in the collection\'s .fav file')));

    row.append(jacket, info, el('span', 'missing-tag', t('Missing')));

    return row;
}

function emptyMessage() {
    if (state.view.type === 'collection') return t('This collection is empty.');

    return t('No songs here.');
}

const sentinelObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.rendered < state.songs.length) {
        renderSongList(false);
    }
}, { root: null, rootMargin: '600px' });
sentinelObserver.observe($('#list-sentinel'));

function songRow(song, selectable = true) {
    const row = el('div', 'song');
    row.dataset.folderid = song.folderid;
    if (state.playing === song.folderid) row.classList.add('playing');

    // Selection checkbox (omitted on the Explorer, which is browse-only)
    if (selectable) {
        const check = el('input', 'song-select');
        check.type = 'checkbox';
        check.checked = state.selected.has(song.folderid);
        check.setAttribute('aria-label', t('Select {t}', { t: song.title }));
        check.addEventListener('change', () => {
            if (check.checked) state.selected.add(song.folderid);
            else state.selected.delete(song.folderid);
            updateSelectionUi();
        });
        row.appendChild(check);
    }

    // Jacket + play
    const jacket = el('div', 'jacket');
    if (song.jacket) {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = 'media.php?f=' + encodeURIComponent(song.jacket);
        img.addEventListener('error', () => { img.replaceWith(jacketFallback(song)); });
        jacket.appendChild(img);
    } else {
        jacket.appendChild(jacketFallback(song));
    }
    if (song.preview) {
        const play = el('button', 'play-btn');
        play.setAttribute('aria-label', t('Play preview'));
        play.addEventListener('click', () => togglePreview(song));
        jacket.appendChild(play);
    }

    // Title / artist — a green dot marks songs with saved scores
    const info = el('div', 'song-info');
    const title = el('p', 'song-title');
    title.appendChild(el('span', 'song-title-text', songLabel(song)));
    info.appendChild(title);
    if (song.artist) info.appendChild(el('p', 'song-artist', song.artist));

    // Right column: BPM with the effector underneath
    const meta = el('div', 'song-meta');
    if (song.bpm) meta.appendChild(el('span', 'song-bpm', `${song.bpm} BPM`));
    if (song.effector) {
        meta.appendChild(Object.assign(el('span', 'song-effector', song.effector), { title: t('Effector: {e}', { e: song.effector }) }));
    }

    // Difficulty badges
    const diffs = el('ul', 'diffs');
    let plays = 0;
    for (const chart of song.charts) {
        const badge = el('li', 'diff');
        badge.style.setProperty('--diff-color', DIFF_COLORS[chart.diff] || 'var(--diff-any)');
        if (chart.plays > 0) {
            badge.classList.add('played');
            badge.title = t('{n} play{s} — best score {sc}', { n: chart.plays, s: plural(chart.plays), sc: formatScore(chart.best) });
        }
        badge.append(el('span', 'd-name', chart.diff), el('span', 'd-level', String(chart.level)));
        diffs.appendChild(badge);
        plays += chart.plays;
    }
    if (plays > 0) {
        const dot = el('span', 'score-dot');
        dot.title = t('{n} saved score{s}', { n: plays, s: plural(plays) });
        title.appendChild(dot);
    }

    // Actions
    const actions = el('div', 'song-actions');
    const collectButton = el('button', 'btn btn-collect btn-icon');
    collectButton.setAttribute('aria-label', t('Add to collection'));
    collectButton.title = t('Add to collection');
    collectButton.appendChild(collectIcon());
    collectButton.addEventListener('click', () => openCollect(song));
    actions.appendChild(collectButton);

    row.append(jacket, info, meta, diffs, actions);

    // Anywhere else on the row: the song info popup
    row.addEventListener('click', (event) => {
        if (event.target.closest('button, input')) return;
        openSongInfo(song);
    });

    return row;
}

function jacketFallback(song) {
    return el('div', 'jacket-fallback', (song.title[0] || '?').toUpperCase());
}

/* ---------- Preview player ---------- */

const audio = $('#audio');
let previewBounds = { start: 0, end: 0 };

audio.volume = Number(localStorage.getItem('usc-volume') ?? 65) / 100;
$('#player-volume').value = audio.volume * 100;

function togglePreview(song) {
    if (state.playing === song.folderid) {
        if (audio.paused) audio.play();
        else audio.pause();
        updatePlayingUi();

        return;
    }

    state.playing = song.folderid;
    previewBounds = {
        start: song.preview_offset / 1000,
        end: song.preview_length > 0 ? (song.preview_offset + song.preview_length) / 1000 : 0,
    };
    audio.src = 'media.php?f=' + encodeURIComponent(song.preview);
    audio.play().catch(() => toast(t('Could not play this preview'), 'error'));

    $('#player-title').textContent = song.title ? `${song.title} — ${song.artist}` : songLabel(song);
    $('#player').classList.remove('hidden');
    updatePlayingUi();
}

audio.addEventListener('loadedmetadata', () => {
    if (previewBounds.start > 0 && previewBounds.start < audio.duration) {
        audio.currentTime = previewBounds.start;
    }
});

// Loop the in-game preview segment, like song select does
audio.addEventListener('timeupdate', () => {
    const { start, end } = previewBounds;
    if (end > 0 && audio.currentTime >= end) {
        audio.currentTime = start;
    }
    const total = end > 0 ? end - start : audio.duration || 1;
    const position = Math.max(0, audio.currentTime - (end > 0 ? start : 0));
    $('#player-progress').style.width = `${Math.min(100, (position / total) * 100)}%`;
});

audio.addEventListener('ended', () => { audio.currentTime = previewBounds.start; audio.play(); });
audio.addEventListener('play', updatePlayingUi);
audio.addEventListener('pause', updatePlayingUi);

$('#player-toggle').addEventListener('click', () => {
    if (audio.paused) audio.play();
    else audio.pause();
});

$('#player-volume').addEventListener('input', (event) => {
    audio.volume = event.target.value / 100;
    localStorage.setItem('usc-volume', event.target.value);
});

function updatePlayingUi() {
    $('#player').classList.toggle('playing', !audio.paused);
    document.querySelectorAll('.song.playing').forEach((n) => n.classList.remove('playing'));
    if (!audio.paused && state.playing !== null) {
        const row = document.querySelector(`.song[data-folderid="${state.playing}"]`);
        if (row) row.classList.add('playing');
    }
}

/* ---------- Search ---------- */

// The global search feeds the Explorer page: a broad query lands on the
// Songs tab (or stays on Charts if that's the current scope). Emptying it
// clears the query; a single character waits for more.
let searchTimer = null;
$('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const query = event.target.value.trim();
    if (query.length === 1) return;
    searchTimer = setTimeout(() => {
        const scope = state.explore.scope === 'charts' ? 'charts' : 'songs';
        openExplorer(scope, { q: query });
    }, 350);
});

/* ---------- Modals ---------- */

function openModal(builder) {
    const root = $('#modal-root');
    const modal = root.querySelector('.modal');
    modal.className = 'modal'; // builders may add size variants
    modal.innerHTML = '';
    builder(modal);
    root.classList.remove('hidden');
    const input = modal.querySelector('input[type="text"]');
    if (input) input.focus();
}

function closeModal() {
    $('#modal-root').classList.add('hidden');
}

$('#modal-root').querySelector('.modal-overlay').addEventListener('click', closeModal);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
});

/* ---------- Native folder picker ---------- */

// set-root can take a while on a big library: lock the triggering button and
// swallow re-clicks while the first request runs.
let connecting = false;

async function connectRoot(path, button = null, onError = null) {
    if (connecting) return;
    connecting = true;
    const label = button ? button.textContent : '';
    if (button) {
        button.disabled = true;
        button.textContent = t('Connecting…');
    }
    try {
        const data = await api('set-root', { body: { game_root: path } });
        closeModal();
        applyInit(data);
        toast(t('Game folder connected'), 'success');
        // A dead Main.cfg is the first thing to fix (its banner is already up);
        // don't stack the path-fix modal on top — offer it once that's sorted.
        if (data.paths.paths_mismatch && data.paths.songs_root_exists && !data.paths.config_song_folder_gone) {
            promptPathFix();
        }
    } catch (error) {
        if (onError) onError(error);
        else toast(error.message, 'error');
    } finally {
        connecting = false;
        if (button) {
            button.disabled = false;
            button.textContent = label;
        }
    }
}

// In-app folder picker: navigates the server's directories (drive list, then
// subfolders) in a modal and hands the picked absolute path to onPick.
// Replaces the old native Windows dialog, which could open invisibly
// depending on how the server process runs.
function openFolderPicker(onPick, startPath = '') {
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Pick a folder')));
        const crumb = el('p', 'modal-sub folder-crumb');
        const list = el('ul', 'modal-list');
        const actions = el('div', 'newcollection');
        const cancel = el('button', 'btn', t('Cancel'));
        const select = el('button', 'btn btn-primary', t('Use this folder'));
        let current = '';

        const row = (label, onClick, mapsdb = false) => {
            const item = el('li');
            const button = el('button', 'collect-row' + (mapsdb ? ' has-mapsdb' : ''));
            button.append(el('span', 'name', label));
            if (mapsdb) button.append(el('span', 'count', 'maps.db ✓'));
            button.addEventListener('click', onClick);
            item.appendChild(button);
            list.appendChild(item);
        };

        async function load(path) {
            list.textContent = '';
            list.appendChild(el('li', 'nav-empty', t('Loading…')));
            try {
                const data = await api('browse-list', { body: { path } });
                current = data.path;
                crumb.textContent = current || t('Drives');
                crumb.classList.toggle('has-mapsdb', data.has_mapsdb);
                select.classList.toggle('btn-mapsdb', data.has_mapsdb);
                if (data.has_mapsdb) crumb.appendChild(el('span', 'mapsdb-badge', ' maps.db ✓'));
                select.disabled = current === '';
                list.textContent = '';
                if (current !== '') row('..', () => load(data.parent));
                for (const { name, mapsdb } of data.dirs) {
                    row(name, () => load(current === '' ? name : `${current}/${name}`), mapsdb);
                }
                if (!data.dirs.length) list.appendChild(el('li', 'nav-empty', t('No subfolders.')));
            } catch (error) {
                if (path !== '') return load(''); // e.g. stale start path
                list.textContent = '';
                toast(error.message, 'error');
            }
        }

        cancel.addEventListener('click', closeModal);
        select.addEventListener('click', () => {
            onPick(current, select);
        });
        actions.append(cancel, select);
        modal.append(crumb, list, actions);
        load(startPath);
    });
}

function browseForRoot(input) {
    // The modal stays open while connecting: connectRoot closes it on
    // success, and on error the user can simply pick another folder.
    openFolderPicker((path, button) => {
        if (input) input.value = path;
        connectRoot(path, button);
    }, input?.value.trim() || '');
}

$('#setup-browse').addEventListener('click', () => {
    browseForRoot($('#setup-root'));
});

// Folder picker that only fills a text input (no root switch)
function browseInto(input) {
    openFolderPicker((path) => {
        input.value = path;
        closeModal();
    }, input.value.trim());
}

/* ---------- Multi-selection (bulk add to collection) ---------- */

function updateSelectionUi() {
    const count = state.selected.size;
    const total = state.songs.length;

    const selectAll = $('#select-all');
    selectAll.checked = count > 0 && count === total;
    selectAll.indeterminate = count > 0 && count < total;

    const button = $('#btn-add-selected');
    button.classList.toggle('hidden', count === 0);
    button.textContent = t('Add to Collection ({n})', { n: formatInt(count) });

    refreshExploreSelection(); // the Explorer has its own selection toolbar
}

// Select all applies to the whole loaded result, not just rendered rows
$('#select-all').addEventListener('change', (event) => {
    state.selected.clear();
    if (event.target.checked) {
        for (const song of state.songs) state.selected.add(song.folderid);
    }
    document.querySelectorAll('.song-select').forEach((check) => {
        check.checked = event.target.checked;
    });
    updateSelectionUi();
});

$('#btn-add-selected').addEventListener('click', () => {
    if (state.selected.size) openBulkCollect();
});

function openBulkCollect() {
    const count = state.selected.size;
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Add {n} song{s} to Collection', { n: formatInt(count), s: plural(count) })));
        modal.appendChild(el('p', 'modal-sub', t('Pick a collection, or create a new one. Songs already in it are not duplicated.')));

        const list = el('ul', 'modal-list');
        for (const collection of state.collections) {
            const item = el('li');
            const row = el('button', 'collect-row');
            row.append(el('span', 'name', collection.name), el('span', 'count', String(collection.songs)));
            row.addEventListener('click', () => bulkAdd(collection.name));
            item.appendChild(row);
            list.appendChild(item);
        }
        if (!state.collections.length) {
            list.appendChild(el('li', 'nav-empty', t('No collections yet.')));
        }
        modal.appendChild(list);

        const create = el('div', 'newcollection');
        const input = el('input');
        input.type = 'text';
        input.placeholder = t('New collection…');
        const button = el('button', 'btn btn-primary', t('Create and add'));
        const submit = () => {
            if (input.value.trim()) bulkAdd(input.value.trim());
        };
        button.addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') submit();
        });
        create.append(input, button);
        modal.appendChild(create);
    });
}

function bulkAdd(name) {
    confirmDivergedWrite(name, () => doBulkAdd(name));
}

async function doBulkAdd(name) {
    try {
        const data = await api('import-apply', { body: { name, folderids: [...state.selected] } });
        state.collections = data.collections;
        state.stats.collections = data.collections.length;
        closeModal();
        renderCollectionsNav();
        renderStats();
        toast(t('{n} song{s} added to {c}', { n: formatInt(data.added), s: plural(data.added), c: name }), 'success');
    } catch (error) {
        toast(error.message, 'error');
    }
}

/* ---------- Add to collection ---------- */

async function openCollect(song) {
    let inCollections;
    try {
        ({ collections: inCollections } = await api('song-collections', { params: { folderid: song.folderid } }));
    } catch (error) {
        toast(error.message, 'error');

        return;
    }

    openModal((modal) => {
        modal.appendChild(el('h3', '', songLabel(song)));
        modal.appendChild(el('p', 'modal-sub', t('Add or remove this song from your collections.')));

        const list = el('ul', 'modal-list');
        for (const collection of state.collections) {
            list.appendChild(collectRow(song, collection.name, collection.songs, inCollections.includes(collection.name)));
        }
        if (!state.collections.length) {
            list.appendChild(el('li', 'nav-empty', t('No collections yet.')));
        }
        modal.appendChild(list);

        const create = el('div', 'newcollection');
        const input = el('input');
        input.type = 'text';
        input.placeholder = t('New collection…');
        const button = el('button', 'btn btn-primary', t('Create and add'));
        const submit = () => {
            if (input.value.trim()) toggleCollection(song, input.value.trim());
        };
        button.addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') submit();
        });
        create.append(input, button);
        modal.appendChild(create);
    });
}

function collectRow(song, name, count, isIn) {
    const item = el('li');
    const row = el('button', `collect-row${isIn ? ' in' : ''}`);
    row.append(el('span', 'collect-check'), el('span', 'name', name), el('span', 'count', String(count)));
    row.addEventListener('click', () => toggleCollection(song, name));
    item.appendChild(row);

    return item;
}

function toggleCollection(song, name) {
    confirmDivergedWrite(name, () => doToggleCollection(song, name));
}

async function doToggleCollection(song, name) {
    try {
        const data = await api('toggle', { body: { folderid: song.folderid, collection: name } });
        state.collections = data.collections;
        state.stats.collections = data.collections.length;
        renderCollectionsNav();
        renderStats();
        toast(data.added
            ? t('"{t}" added to {c}', { t: songLabel(song), c: name })
            : t('"{t}" removed from {c}', { t: songLabel(song), c: name }), 'success');
        openCollect(song); // refresh the modal state

        // Unchecking the collection currently on screen: refresh its list
        if (state.view.type === 'collection' && name === state.view.key) {
            reloadCurrentView();
        }
    } catch (error) {
        toast(error.message, 'error');
    }
}

/* ---------- Collection actions (share / rename / delete) ---------- */

$('#btn-share').addEventListener('click', () => {
    const name = state.view.key;
    const url = new URL('api.php', window.location.href);
    url.searchParams.set('action', 'export');
    url.searchParams.set('name', name);
    window.location.href = url;
    toast(t('Collection downloaded. Send the file to a friend: they can add it with "Import Collection".'), 'success');
});

$('#btn-rename').addEventListener('click', () => {
    const oldName = state.view.key;
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Rename {c}', { c: oldName })));
        modal.appendChild(el('p', 'note note-warn', t('Using the name of an existing collection merges the two.')));
        const input = el('input');
        input.type = 'text';
        input.value = oldName;
        modal.appendChild(input);

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Rename'));
        confirm.addEventListener('click', () => {
            const newName = input.value.trim();
            if (!newName || newName === oldName) return closeModal();
            // Renaming moves the .fav mirror too (delete + regenerate from DB)
            confirmDivergedWrite(oldName, async () => {
                try {
                    const data = await api('rename-collection', { body: { old: oldName, new: newName } });
                    state.collections = data.collections;
                    closeModal();
                    renderCollectionsNav();
                    toast(t('Collection renamed to {c}', { c: newName }), 'success');
                    loadCollection(newName);
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
});

$('#btn-delete').addEventListener('click', () => {
    const name = state.view.key;
    const count = state.songs.length;
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Delete {c}', { c: name })));
        modal.appendChild(el('p', 'note note-warn',
            t('The collection and its {n} entries will be removed from the database. Songs and scores are untouched. An automatic backup is made first.', { n: formatInt(count) })));
        // Deleting also removes the .fav mirror — which may be the good copy
        if (state.favDiverged.some((d) => d.name === name)) {
            modal.appendChild(el('p', 'note note-warn',
                t('Careful: the .fav mirror of this collection diverges from the database (it may hold the good copy) and will be deleted with it.')));
        }

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-danger', t('Delete collection'));
        confirm.addEventListener('click', async () => {
            try {
                const data = await api('delete-collection', { body: { name } });
                state.collections = data.collections;
                state.stats.collections = data.collections.length;
                closeModal();
                renderCollectionsNav();
                renderStats();
                toast(t('Collection {c} deleted', { c: name }), 'success');
                const first = state.tree[0];
                if (first) loadFolder(first.rel, first.name);
            } catch (error) {
                toast(error.message, 'error');
            }
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
});

/* ---------- Import ---------- */

$('#btn-import').addEventListener('click', () => openImport());

function openImport() {
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Import Collection')));
        modal.appendChild(el('p', 'note',
            t('Accepts USC collections (.json) shared from this tool, and legacy KShootMania .fav files. Songs are matched against your library by chart fingerprint, wherever your folders live.')));

        const zone = el('div', 'dropzone', t('Drop a file here, or click to browse'));
        const input = el('input');
        input.type = 'file';
        input.accept = '.json,.fav';
        zone.appendChild(input);

        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            if (input.files[0]) previewImport(input.files[0]);
        });
        zone.addEventListener('dragover', (event) => {
            event.preventDefault();
            zone.classList.add('over');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', (event) => {
            event.preventDefault();
            zone.classList.remove('over');
            if (event.dataTransfer.files[0]) previewImport(event.dataTransfer.files[0]);
        });

        modal.appendChild(zone);
    });
}

async function previewImport(file) {
    const formData = new FormData();
    formData.append('playlist', file);

    try {
        showImportPreview(await api('import-preview', { formData }));
    } catch (error) {
        toast(error.message, 'error');
    }
}

function showImportPreview(preview) {
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Import Collection')));

        const summary = el('div', 'import-summary');
        const okStat = el('p', 'import-stat ok', String(preview.matched.length));
        okStat.appendChild(el('small', '', t('found in your library')));
        summary.appendChild(okStat);
        if (preview.missing.length) {
            const koStat = el('p', 'import-stat ko', String(preview.missing.length));
            koStat.appendChild(el('small', '', t('not found (charts not installed)')));
            summary.appendChild(koStat);
        }
        modal.appendChild(summary);

        if (preview.missing.length) {
            const list = el('ul', 'modal-list import-list');
            for (const song of preview.missing) {
                const item = el('li');
                item.append(
                    el('span', 'name', song.title),
                    el('span', 'who', song.artist || ''),
                    el('span', 'via', (song.levels || []).join(' / ')),
                );
                list.appendChild(item);
            }
            modal.appendChild(el('label', '', t('Missing songs — ask your friend for the folders:')));
            modal.appendChild(list);
        }

        const fuzzy = preview.matched.filter((song) => song.via !== 'hash').length;
        if (fuzzy) {
            modal.appendChild(el('p', 'note note-warn',
                t('{n} match(es) by title or folder name (similar chart, not identical).', { n: fuzzy })));
        }

        modal.appendChild(el('label', '', t('Import into collection:')));
        const input = el('input');
        input.type = 'text';
        input.value = preview.name || '';
        modal.appendChild(input);
        const conflictHint = el('p', 'note note-warn hidden');
        modal.appendChild(conflictHint);

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary');
        confirm.disabled = !preview.matched.length;

        // Importing under an existing name merges; a new name creates
        const plural2 = plural(preview.matched.length);
        const updateConflict = () => {
            const name = input.value.trim();
            const exists = state.collections.some((collection) => collection.name === name);
            confirm.textContent = exists
                ? t('Merge {n} song{s} into it', { n: formatInt(preview.matched.length), s: plural2 })
                : t('Create with {n} song{s}', { n: formatInt(preview.matched.length), s: plural2 });
            conflictHint.textContent = exists
                ? t('"{c}" already exists: these songs will be added to it (and its .fav file updated). Pick another name to create a new collection instead.', { c: name })
                : '';
            conflictHint.classList.toggle('hidden', !exists);
        };
        updateConflict();
        input.addEventListener('input', updateConflict);
        confirm.addEventListener('click', () => {
            const name = input.value.trim();
            if (!name) return toast(t('Give the collection a name'), 'error');
            confirmDivergedWrite(name, async () => {
                try {
                    const data = await api('import-apply', {
                        body: { name, folderids: preview.matched.map((song) => song.folderid) },
                    });
                    state.collections = data.collections;
                    state.stats.collections = data.collections.length;
                    closeModal();
                    renderCollectionsNav();
                    renderStats();
                    toast(t('{n} song{s} added to {c}', { n: formatInt(data.added), s: plural(data.added), c: name }), 'success');
                    loadCollection(name);
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

/* ---------- Song info popup (details, folder, scores) ---------- */

async function openSongInfo(song) {
    let scores = {};
    try {
        ({ scores } = await api('song-scores', { params: { folderid: song.folderid } }));
    } catch (error) {
        toast(error.message, 'error');
    }

    openModal((modal) => {
        modal.appendChild(el('h3', '', songLabel(song)));

        const details = [song.artist];
        if (song.effector) details.push(t('Effector: {e}', { e: song.effector }));
        if (song.bpm) details.push(`${song.bpm} BPM`);
        modal.appendChild(el('p', 'modal-sub', details.join(' — ')));

        // Where the song lives: the path loads that folder in-app (like the
        // sidebar); the button opens the song's own folder in the file explorer
        const parentRel = song.folder.split('/').slice(0, -1).join('/');
        const parentName = parentRel.split('/').pop() || 'All songs';
        const folderLine = el('p', 'modal-sub');
        folderLine.append(t('Folder: '));
        const link = el('button', 'folder-link', song.folder);
        link.title = t('Open {f}', { f: parentName });
        link.addEventListener('click', () => {
            closeModal();
            loadFolder(parentRel, parentName);
        });
        folderLine.appendChild(link);
        if (state.canBrowse) {
            const openBtn = el('button', 'btn btn-quiet folder-open', t('Open folder'));
            openBtn.title = t('Open in file explorer');
            openBtn.addEventListener('click', async () => {
                try {
                    const data = await api('open-folder', { body: { folder: song.folder } });
                    if (data.exact === false) {
                        toast(t('This song\'s folder is missing on disk — opened the nearest existing folder.'), '');
                    }
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
            folderLine.appendChild(openBtn);
        }
        modal.appendChild(folderLine);

        const charts = [...song.charts].reverse(); // hardest first
        for (const chart of charts) {
            const section = el('div', 'score-diff');
            const heading = el('h4', '', chart.name || chart.diff);
            heading.style.color = DIFF_COLORS[chart.diff] || 'var(--diff-any)';
            heading.appendChild(el('span', 'lvl', String(chart.level)));
            section.appendChild(heading);

            const chartScores = scores[chart.hash] || [];
            if (!chartScores.length) {
                section.appendChild(el('p', 'notplayed', t('Never played.')));
            } else {
                section.appendChild(scoreTable(chartScores));
            }
            modal.appendChild(section);
        }
    });
}

function scoreTable(chartScores) {
    const table = el('table', 'score-table');
    const head = table.createTHead().insertRow();
    for (const label of [t('Date'), 'Score', t('Gauge'), 'Crit', 'Near', 'Miss', 'Early/Late', 'Combo']) {
        head.appendChild(Object.assign(el('th'), { textContent: label }));
    }

    const body = table.createTBody();
    chartScores.forEach((score, index) => {
        const row = body.insertRow();
        if (index === 0) row.classList.add('top');
        row.insertCell().textContent = formatDate(score.timestamp);
        row.insertCell().textContent = formatScore(score.score);
        const gauge = row.insertCell();
        gauge.textContent = `${score.gauge} %`;
        gauge.className = score.gauge >= 70 ? 'gauge-clear' : 'gauge-fail';
        row.insertCell().textContent = score.crit;
        row.insertCell().textContent = score.near;
        row.insertCell().textContent = score.miss;
        row.insertCell().textContent = `${score.early}/${score.late}`;
        row.insertCell().textContent = score.combo;
    });

    return table;
}

/* ---------- Nautica (ksm.dev chart repository) ---------- */

const NAUTICA_DIFFS = ['NOV', 'ADV', 'EXH', 'INF'];

function renderNauticaNav() {
    const enabled = Boolean(state.nautica?.enabled);
    $('#nautica-section').classList.toggle('hidden', !enabled);
    if (!enabled) return;

    const badge = $('#nautica-badge');
    const count = state.nautica.new_count;
    badge.textContent = count > 0 ? t('{n} new', { n: count }) : '';
    badge.classList.toggle('hidden', count <= 0);
}

$('#nautica-section').addEventListener('click', () => openNauticaPage());

function renderNauticaAlert() {
    const show = Boolean(state.nautica?.enabled) && state.nautica.new_count > 0;
    const alert = $('#nautica-alert');
    alert.classList.toggle('hidden', !show);
    if (show) {
        const n = state.nautica.new_count;
        $('#nautica-alert-text').textContent =
            t('{n} new chart{s} available on Nautica.', { n: n === 30 ? '30+' : n, s: plural(n) });
    }
}

$('#btn-nautica-later').addEventListener('click', () => {
    $('#nautica-alert').classList.add('hidden');
});

$('#btn-nautica-open').addEventListener('click', () => {
    $('#nautica-alert').classList.add('hidden');
    openNauticaPage();
});

async function openNauticaPage() {
    await openPage('nautica', 'Nautica', async (node) => {
        if (!state.nautica?.enabled) {
            throw new Error(t('Nautica is not enabled (see Settings)'));
        }
        node.innerHTML = '';
        const page = el('div', 'page');
        node.appendChild(page);

        const controls = el('div', 'page-controls');
        const downloadAllButton = el('button', 'btn btn-primary', state.nautica.new_count > 0
            ? t('Download new ({n})', { n: state.nautica.new_count === 30 ? '30+' : state.nautica.new_count })
            : t('Download all'));
        downloadAllButton.title = t('Downloads every chart you don\'t already have, newest first, until it reaches your already-downloaded ones.');
        const query = el('input', 'page-search');
        query.type = 'search';
        query.placeholder = t('Search title, artist or effector…');
        const syncStatus = el('span', 'pager-info');
        const site = el('a', 'btn btn-quiet external-link', 'ksm.dev ↗');
        site.href = 'https://ksm.dev';
        site.target = '_blank';
        site.rel = 'noopener';
        controls.append(downloadAllButton, query, site, syncStatus);
        page.appendChild(controls);

        page.appendChild(el('p', 'note',
            t('Charts are downloaded into {d}. Launch the game afterwards so it indexes them.', { d: state.nautica.dir })));

        const logNode = el('div', 'log-panel hidden');
        page.appendChild(logNode);

        const wrap = el('div');
        page.appendChild(wrap);

        let currentPage = 1;
        const load = async () => {
            wrap.innerHTML = '';
            wrap.appendChild(el('p', 'songlist-empty', t('Loading…')));
            try {
                const data = await api('nautica-list', { params: { page: currentPage, q: query.value.trim() } });
                renderNauticaList(wrap, data, (delta) => {
                    currentPage += delta;
                    load();
                    $('#songlist').scrollTop = 0;
                });
            } catch (error) {
                wrap.innerHTML = '';
                wrap.appendChild(el('p', 'songlist-empty', error.message));
            }
        };

        let timer;
        query.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                currentPage = 1;
                load();
            }, 400);
        });

        downloadAllButton.addEventListener('click', () => {
            logNode.classList.remove('hidden');
            nauticaDownloadAll(downloadAllButton, syncStatus, logNode, load);
        });
        load();
    });
}

function renderNauticaList(wrap, data, paginate) {
    wrap.innerHTML = '';
    $('#context-count').textContent = t('page {n}', { n: data.page });

    for (const song of data.songs) {
        wrap.appendChild(nauticaRow(song));
    }
    if (!data.songs.length) {
        wrap.appendChild(el('p', 'songlist-empty', t('Nothing found on Nautica.')));
    }

    const pager = el('div', 'pager');
    const prev = el('button', 'btn', t('← Previous'));
    prev.disabled = data.page <= 1;
    prev.addEventListener('click', () => paginate(-1));
    const next = el('button', 'btn', t('Next →'));
    next.disabled = !data.has_next;
    next.addEventListener('click', () => paginate(1));
    pager.append(prev, el('span', 'pager-info', t('page {n}', { n: data.page })), next);
    wrap.appendChild(pager);
}

function nauticaRow(song) {
    const row = el('div', 'song nautica-song');

    const jacket = el('div', 'jacket');
    if (song.jacket) {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = song.jacket;
        img.addEventListener('error', () => { img.replaceWith(el('div', 'jacket-fallback', (song.title[0] || '?').toUpperCase())); });
        jacket.appendChild(img);
    } else {
        jacket.appendChild(el('div', 'jacket-fallback', (song.title[0] || '?').toUpperCase()));
    }
    if (song.preview) {
        const play = el('button', 'play-btn');
        play.setAttribute('aria-label', t('Play preview'));
        play.addEventListener('click', () => playRemotePreview(song));
        jacket.appendChild(play);
    }

    const info = el('div', 'song-info');
    const title = el('p', 'song-title');
    title.appendChild(el('span', 'song-title-text', song.title));
    if (song.is_new) title.appendChild(el('span', 'nautica-new', 'NEW'));
    info.appendChild(title);
    if (song.artist) info.appendChild(el('p', 'song-artist', song.artist));
    const sub = [t('Uploaded {d} — {n} download{s}', { d: (song.uploaded_at || '').slice(0, 10), n: formatInt(song.downloads), s: plural(song.downloads) })];
    if (song.effector) sub.push(t('Effector: {e}', { e: song.effector }));
    info.appendChild(el('p', 'song-sub', sub.join(' — ')));

    const diffs = el('ul', 'diffs');
    const sorted = [...song.charts].sort((a, b) => a.diff - b.diff);
    for (const chart of sorted) {
        const name = NAUTICA_DIFFS[Math.min(chart.diff, 4) - 1] || '?';
        const badge = el('li', 'diff');
        badge.style.setProperty('--diff-color', DIFF_COLORS[name] || 'var(--diff-any)');
        badge.append(el('span', 'd-name', name), el('span', 'd-level', String(chart.level)));
        diffs.appendChild(badge);
    }

    const actions = el('div', 'song-actions');
    if (song.installed) {
        actions.appendChild(el('span', 'installed-tag', t('Installed')));
    } else {
        const download = el('button', 'btn btn-primary', t('Download'));
        download.addEventListener('click', async () => {
            download.disabled = true;
            try {
                download.textContent = t('Downloading…');
                await api('nautica-download', { body: { id: song.id, step: 'fetch' } });
                download.textContent = t('Extracting…');
                await api('nautica-download', { body: { id: song.id, step: 'extract' } });
                toast(t('"{t}" downloaded — launch the game to index it', { t: song.title }), 'success');
                download.replaceWith(el('span', 'installed-tag', t('Installed')));
            } catch (error) {
                toast(error.message, 'error');
                download.disabled = false;
                download.textContent = t('Download');
            }
        });
        actions.appendChild(download);
    }

    row.append(jacket, info, diffs, actions);

    return row;
}

function playRemotePreview(song) {
    state.playing = null;
    previewBounds = { start: 0, end: 0 };
    audio.src = song.preview;
    audio.play().catch(() => toast(t('Could not play this preview'), 'error'));
    $('#player-title').textContent = song.title ? `${song.title} — ${song.artist}` : songLabel(song);
    $('#player').classList.remove('hidden');
    updatePlayingUi();
}

/* ----- Bulk runs: per-step log, failures skipped, polite pacing ----- */

const nauticaRun = { cancel: false }; // the Stop button flips this

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Randomized gap between charts (0.9–2.5s). ⚠️ DO NOT LOWER THESE VALUES —
// ksm.dev / nautica is a free community service run by volunteers. This delay
// is what keeps a bulk download from hammering their servers; lowering it (or
// removing the jitter) risks overloading them and getting the tool blocked.
// If anything, raise it. Never make it shorter.
const politeDelay = () => 900 + Math.floor(Math.random() * 1600);

function formatBytes(bytes) {
    return bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// One log line per chart, updated in place as it goes through its steps
function logLine(logNode, title) {
    const line = el('div', 'log-line');
    const name = el('span', 'log-name', title);
    const step = el('span', 'log-step');
    line.append(name, step);
    logNode.prepend(line);

    return {
        step: (text) => { step.textContent = text; },
        ok: (text) => { line.classList.add('ok'); step.textContent = text; },
        fail: (text) => { line.classList.add('fail'); step.textContent = text; },
    };
}

// Fetch, then extract — each step visible. Errors are returned, not thrown:
// one bad archive must never abort a whole run.
async function nauticaGetOne(song, logNode) {
    const line = logLine(logNode, song.title);
    try {
        line.step(t('downloading… ({s})', { s: '…' }));
        const fetched = await api('nautica-download', { body: { id: song.id, step: 'fetch' } });
        line.step(t('downloading… ({s})', { s: formatBytes(fetched.size) }));

        line.step(t('extracting…'));
        const done = await api('nautica-download', { body: { id: song.id, step: 'extract' } });
        line.ok(t('{n} files → {f}', { n: done.files, f: done.folder }));

        return true;
    } catch (error) {
        line.fail(t('failed: {e}', { e: error.message }));

        return false;
    }
}

// Bulk download driver ("Download all" button).
// pick(songs) returns the songs to take on that page, and whether to stop.
async function nauticaBulk({ button, status, logNode, refresh, pageCap, pick }) {
    nauticaRun.cancel = false;
    button.disabled = true;
    const stop = el('button', 'btn btn-danger-quiet', t('Stop'));
    stop.addEventListener('click', () => { nauticaRun.cancel = true; });
    status.after(stop);

    let ok = 0;
    let failed = 0;
    let newest = '';
    let capped = false;
    let first = true;

    try {
        for (let page = 1; page <= pageCap; page++) {
            if (nauticaRun.cancel) break;
            status.textContent = t('Fetching page {n}…', { n: page });
            const data = await api('nautica-list', { params: { page } });
            if (!data.songs.length) break;
            newest = newest || data.songs[0].uploaded_at;

            const { songs, done } = pick(data.songs);
            for (const song of songs) {
                if (nauticaRun.cancel) break;
                if (!first) {
                    const wait = politeDelay();
                    status.textContent = t('Waiting {s}s…', { s: (wait / 1000).toFixed(1) });
                    await sleep(wait);
                }
                first = false;
                status.textContent = t('Downloading {a}/{b} — {t}', { a: ok + failed + 1, b: '…', t: song.title });
                if (await nauticaGetOne(song, logNode)) ok++;
                else failed++;
            }

            if (done || !data.has_next || nauticaRun.cancel) break;
            capped = page === pageCap;
        }

        if (nauticaRun.cancel) {
            status.textContent = t('Stopped.');
        } else if (ok + failed === 0) {
            status.textContent = t('Nothing to download.');
        } else {
            status.textContent = failed
                ? t('Done: {ok} downloaded, {fail} failed.', { ok, fail: failed })
                : t('Done: {ok} downloaded.', { ok });
            if (capped) status.textContent += ' ' + t('Page limit reached — run it again to continue.');
            if (ok) {
                toast(t('{n} chart{s} downloaded — launch the game to index them.', { n: ok, s: plural(ok) }), 'success');
            }
        }

        const marked = await api('nautica-mark-seen', { body: { date: newest } });
        state.nautica = marked.nautica;
        renderNauticaNav();
        renderNauticaAlert();
        refresh();
    } catch (error) {
        toast(error.message, 'error');
        status.textContent = t('Sync interrupted — run it again to resume.');
    } finally {
        stop.remove();
        button.disabled = false;
    }
}

// Everything you don't already have, newest first. Installed charts are
// skipped; the run stops only when it reaches a page that is entirely
// installed (i.e. the already-synced backlog), or at the page cap.
function nauticaDownloadAll(button, status, logNode, refresh) {
    return nauticaBulk({
        button,
        status,
        logNode,
        refresh,
        pageCap: 40,
        pick: (songs) => {
            const take = songs.filter((song) => !song.installed);

            return { songs: take, done: take.length === 0 && songs.length > 0 };
        },
    });
}

/* ---------- Dedicated pages (header stats) ---------- */

async function openPage(key, label, loader) {
    state.view = { type: 'page', key, label };
    syncHash(state.view);
    state.songs = [];
    state.missing = [];
    state.selected.clear();
    updateSelectionUi();
    renderContext();
    renderCollectionsNav();
    markActiveNav();
    $('#nautica-section').classList.toggle('active', key === 'nautica');
    $('#context').classList.add('page-mode');
    $('#context').classList.remove('explorer-mode');

    const node = $('#songlist');
    node.innerHTML = '';
    node.appendChild(el('p', 'songlist-empty', t('Loading…')));
    try {
        await loader(node);
    } catch (error) {
        node.innerHTML = '';
        node.appendChild(el('p', 'songlist-empty', error.message));
    }
}

function statCard(value, label, onClick = null) {
    const card = el(onClick ? 'button' : 'div', 'stat-card' + (onClick ? ' clickable' : ''));
    card.append(el('p', 'stat-value', value), el('p', 'stat-label', label));
    if (onClick) card.addEventListener('click', onClick);

    return card;
}

// pairs: [label, value, tooltip?][] — pure CSS bars, no library
function barChart(pairs, onClick = null) {
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    // Past ~two dozen bars the columns are narrower than their own numbers and
    // the values run into each other: the hover title carries them instead
    const showValues = pairs.length <= 24;
    const chart = el('div', 'bar-chart');
    for (const [label, value, tooltip] of pairs) {
        const col = el('div', 'bar-col' + (onClick ? ' clickable' : ''));
        col.title = `${tooltip || label}: ${formatInt(value)}`;
        col.append(el('span', 'bar-value', showValues && value ? formatInt(value) : ''));
        const bar = el('div', 'bar');
        bar.style.height = `${Math.round((value / max) * 72) + (value ? 2 : 0)}px`;
        col.append(bar, el('span', 'bar-label', label));
        if (onClick) col.addEventListener('click', () => onClick(label, tooltip));
        chart.appendChild(col);
    }

    return chart;
}

function pageTable(headers, numericFrom = 1) {
    const table = el('table', 'page-table');
    const head = table.createTHead().insertRow();
    headers.forEach((label, index) => {
        const th = el('th', index >= numericFrom ? 'num' : '', label);
        head.appendChild(th);
    });

    return table;
}

/* ----- Scores page ----- */

async function openScoresPage() {
    await openPage('scores', t('Scores'), async (node) => {
        const { plays } = await api('scores-overview');
        node.innerHTML = '';
        const page = el('div', 'page scores-page');
        node.appendChild(page);

        // Client-side filters (instant). Levels multi-select: none = all levels.
        const ui = { levels: new Set(), result: 'all', text: '', timeMode: 'lines' };

        // Sections, in order: cards, level chart, time chart, level filter,
        // text filter, then the results table (with its own toolbar).
        const cardsWrap = el('div');
        const levelChartWrap = el('div');
        const timeWrap = el('div');
        const filterWrap = el('div', 'scores-filters');
        const tablesWrap = el('div');
        page.append(cardsWrap, levelChartWrap, timeWrap, filterWrap, tablesWrap);

        const render = () => {
            // baseRows: result + text (not level) — the level chart shows every
            // level so its bars stay clickable
            const baseRows = plays.filter((p) =>
                (ui.result === 'all' || (ui.result === 'clear' ? p.g >= 70 : p.g < 70))
                && (!ui.text
                    || (p.ti || '').toLowerCase().includes(ui.text)
                    || (p.ar || '').toLowerCase().includes(ui.text)
                    || (p.ef || '').toLowerCase().includes(ui.text)));
            const rows = ui.levels.size ? baseRows.filter((p) => ui.levels.has(p.lv)) : baseRows;

            $('#context-count').textContent = t('{n} plays', { n: formatInt(rows.length) });
            chipEls.forEach((chip, i) => chip.classList.toggle('active', ui.levels.has(i + 1)));

            renderScoreCards(cardsWrap, rows);
            renderScoreLevelChart(levelChartWrap, baseRows, toggleLevel);
            renderScoreTime(timeWrap, rows, ui);
            renderScoreTables(tablesWrap, rows, ui, render);
        };

        const toggleLevel = (level) => {
            if (ui.levels.has(level)) ui.levels.delete(level);
            else ui.levels.add(level);
            render();
        };

        // --- Persistent filter controls (below the charts) ---
        filterWrap.appendChild(el('h4', 'page-heading', t('Filter by level')));
        const levelChips = el('div', 'level-chips scores-levels');
        const chipEls = [];
        for (let level = 1; level <= 20; level++) {
            const chip = el('button', 'level-chip', String(level));
            chip.addEventListener('click', () => toggleLevel(level));
            chipEls.push(chip);
            levelChips.appendChild(chip);
        }
        filterWrap.appendChild(levelChips);

        const query = el('input', 'page-search scores-search');
        query.type = 'search';
        query.placeholder = t('Song, artist or effector…');
        let timer;
        query.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => { ui.text = query.value.trim().toLowerCase(); render(); }, 250);
        });
        filterWrap.appendChild(query);

        render();
    });
}

function renderScoreCards(wrap, rows) {
    wrap.innerHTML = '';
    const distinct = new Set(rows.map((p) => `${p.ti}|${p.lv}|${p.d}`)).size;
    const cleared = rows.filter((p) => p.g >= 70).length;
    const best = rows.reduce((memo, p) => (p.sc > (memo?.sc ?? -1) ? p : memo), null);
    const cards = el('div', 'stat-cards');
    cards.append(
        statCard(formatInt(rows.length), t('plays')),
        statCard(formatInt(distinct), t('charts played')),
        statCard(rows.length ? `${Math.round((cleared / rows.length) * 100)} %` : '—', t('clear rate')),
        statCard(best ? formatScore(best.sc) : '—', best ? t('best score — {t}', { t: best.ti || '?' }) : t('best score')),
    );
    wrap.appendChild(cards);
}

function renderScoreLevelChart(wrap, rows, onLevel) {
    wrap.innerHTML = '';
    const byLevel = new Map();
    for (const play of rows) {
        if (play.lv) byLevel.set(play.lv, (byLevel.get(play.lv) || 0) + 1);
    }
    wrap.appendChild(el('h4', 'page-heading', t('Plays by level — click to filter')));
    wrap.appendChild(barChart(
        Array.from({ length: 20 }, (_, i) => [String(i + 1), byLevel.get(i + 1) || 0]),
        (label) => onLevel(Number(label)),
    ));
}

// Plays over time: monthly bars by default, or a zoomable/pannable daily line
function renderScoreTime(wrap, rows, ui) {
    wrap.innerHTML = '';
    if (!rows.length) return;

    const head = el('div', 'scores-time-head');
    head.appendChild(el('h4', 'page-heading', t('Plays over time')));
    const seg = el('div', 'seg-switch');
    const barsBtn = el('button', 'seg', t('Bars'));
    const linesBtn = el('button', 'seg', t('Lines'));
    seg.append(barsBtn, linesBtn);
    head.appendChild(seg);
    wrap.appendChild(head);

    const chart = el('div');
    wrap.appendChild(chart);

    const draw = () => {
        barsBtn.classList.toggle('active', ui.timeMode === 'bars');
        linesBtn.classList.toggle('active', ui.timeMode === 'lines');
        chart.innerHTML = '';
        chart.appendChild(ui.timeMode === 'lines' ? scoresLineChart(scoreDailyPoints(rows)) : barChart(scoreMonthlyBars(rows)));
    };
    barsBtn.addEventListener('click', () => { ui.timeMode = 'bars'; draw(); });
    linesBtn.addEventListener('click', () => { ui.timeMode = 'lines'; draw(); });
    draw();
}

function scoreMonthlyBars(rows) {
    const byMonth = new Map();
    for (const play of rows) {
        const date = new Date(play.t * 1000);
        byMonth.set(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`, (byMonth.get(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`) || 0) + 1);
    }
    // Year marker whenever the year changes; tooltip names the month
    let lastYear = null;

    return [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, value]) => {
        const [year, month] = key.split('-');
        const label = year !== lastYear ? year : '';
        lastYear = year;
        const tip = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(DATE_LOCALE, { month: 'long', year: 'numeric' });

        return [label, value, tip];
    });
}

function scoreDailyPoints(rows) {
    const byDay = new Map();
    for (const play of rows) {
        const day = Math.floor(play.t / 86400) * 86400;
        byDay.set(day, (byDay.get(day) || 0) + 1);
    }

    return [...byDay.entries()].sort((a, b) => a[0] - b[0]);
}

// Daily counts comb into noise as soon as the window spans more than a few
// months, so the bucket widens with the visible span. Weeks start on Monday
// (UTC, like the daily points); months follow the local calendar.
const weekStart = (ts) => Math.floor((ts + 259200) / 604800) * 604800 - 259200;

function monthStart(ts) {
    const date = new Date(ts * 1000);

    return new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000;
}

function groupPoints(points, keyOf) {
    const grouped = new Map();
    for (const [ts, value] of points) {
        const key = keyOf(ts);
        grouped.set(key, (grouped.get(key) || 0) + value);
    }

    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
}

// Zoomable (wheel) / pannable (drag) line chart of play counts over time, with
// a crosshair reading out the hovered period and its count. Only the visible X
// window [x0, x1] changes; the SVG line stays crisp via non-scaling-stroke, and
// every label is an HTML overlay (SVG text would be stretched by
// preserveAspectRatio="none").
function scoresLineChart(points) {
    const wrap = el('div', 'linechart-wrap');
    if (points.length < 2) {
        wrap.appendChild(el('p', 'notplayed', t('Not enough history for a timeline yet.')));

        return wrap;
    }

    const W = 1000, H = 150, padT = 14, padB = 8;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'linechart', preserveAspectRatio: 'none', tabindex: '0' });
    const defs = svgEl('defs', {});
    const fade = svgEl('linearGradient', { id: 'linechart-fade', x1: '0', y1: '0', x2: '0', y2: '1' });
    fade.append(svgEl('stop', { offset: '0%', class: 'fade-top' }), svgEl('stop', { offset: '100%', class: 'fade-bottom' }));
    defs.appendChild(fade);
    const grids = svgEl('g', {});
    const area = svgEl('polygon', { class: 'linechart-area' });
    const line = svgEl('polyline', { class: 'linechart-line' });
    const cursor = svgEl('line', { class: 'linechart-cursor hidden', y1: '0', y2: String(H) });
    svg.append(defs, grids, area, line, cursor);

    const labels = el('div', 'linechart-labels');
    const ylabels = el('div', 'linechart-ylabels');
    const dot = el('span', 'linechart-dot hidden');
    const tip = el('div', 'linechart-tip hidden');
    const plot = el('div', 'linechart-plot');
    plot.append(svg, labels, ylabels, dot, tip);
    wrap.append(plot, el('p', 'linechart-hint', t('Hover to read, scroll to zoom, drag to pan')));

    // The three zoom levels, bucketed once: switching is then a lookup
    const levels = {
        day: points,
        week: groupPoints(points, weekStart),
        month: groupPoints(points, monthStart),
    };
    const tMin = points[0][0], tMax = points[points.length - 1][0];
    let x0 = tMin, x1 = tMax;
    let shown = points;          // buckets of the current level
    let px = () => 0, py = () => 0;

    const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString(DATE_LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
    const levelFor = (span) => (span > 800 * 86400 ? 'month' : span > 120 * 86400 ? 'week' : 'day');
    const periodLabel = (level, ts) => {
        if (level === 'month') return new Date(ts * 1000).toLocaleDateString(DATE_LOCALE, { month: 'long', year: 'numeric' });

        return level === 'week' ? t('Week of {d}', { d: fmtDay(ts) }) : fmtDay(ts);
    };

    let level = 'day';
    const draw = () => {
        const span = Math.max(1, x1 - x0);
        level = levelFor(span);
        shown = levels[level];
        px = (ts) => ((ts - x0) / span) * W;

        // Scale to what is on screen: zooming in on a quiet stretch should
        // show its shape, not a flat line under a far-away all-time peak
        const visible = shown.filter((p) => p[0] >= x0 && p[0] <= x1);
        const vMax = Math.max(1, ...visible.map((p) => p[1]));
        py = (v) => padT + (1 - v / vMax) * (H - padT - padB);

        const coords = shown.map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`);
        line.setAttribute('points', coords.join(' '));
        area.setAttribute('points', `${px(shown[0][0]).toFixed(1)},${H} ${coords.join(' ')} ${px(shown[shown.length - 1][0]).toFixed(1)},${H}`);

        grids.replaceChildren();
        labels.replaceChildren();
        ylabels.replaceChildren();

        // Y guides: the peak and its half, enough to read a height without
        // turning the plot into graph paper
        for (const value of [vMax, vMax / 2]) {
            const y = py(value);
            grids.appendChild(svgEl('line', { x1: '0', y1: y, x2: String(W), y2: y, class: 'linechart-grid linechart-grid-y' }));
            const label = el('span', 'linechart-label linechart-ylabel', formatInt(Math.round(value)));
            label.style.top = `${(y / H) * 100}%`;
            ylabels.appendChild(label);
        }

        for (let year = new Date(x0 * 1000).getFullYear(); year <= new Date(x1 * 1000).getFullYear(); year++) {
            const ts = new Date(year, 0, 1).getTime() / 1000;
            if (ts < x0 || ts > x1) continue;
            const x = px(ts);
            grids.appendChild(svgEl('line', { x1: x, y1: '0', x2: x, y2: String(H), class: 'linechart-grid' }));
            // Near an edge the grid line still marks the year, but its label
            // would sit on top of the window's start/end date
            if (x < 80 || x > W - 80) continue;
            const label = el('span', 'linechart-label', String(year));
            label.style.left = `${(x / W) * 100}%`;
            labels.appendChild(label);
        }
        labels.append(
            el('span', 'linechart-label edge', fmtDay(x0)),
            el('span', 'linechart-label edge edge-right', fmtDay(x1)),
        );
    };

    /* ----- Crosshair: snaps to the nearest bucket, reads out X and Y ----- */

    let readIndex = null;

    const hideRead = () => {
        readIndex = null;
        cursor.classList.add('hidden');
        dot.classList.add('hidden');
        tip.classList.add('hidden');
    };

    const showRead = (index) => {
        const point = shown[index];
        if (!point) return hideRead();
        readIndex = index;
        const x = px(point[0]), y = py(point[1]);
        cursor.setAttribute('x1', x);
        cursor.setAttribute('x2', x);
        cursor.classList.remove('hidden');
        dot.style.left = `${(x / W) * 100}%`;
        dot.style.top = `${(y / H) * 100}%`;
        dot.classList.remove('hidden');

        tip.replaceChildren(
            el('strong', '', t('{n} play{s}', { n: formatInt(point[1]), s: plural(point[1]) })),
            el('span', '', periodLabel(level, point[0])),
        );
        // Clamped so the readout never leaves the plot on the first/last
        // bucket, and flipped below the point when the peak touches the top
        tip.style.left = `${Math.min(88, Math.max(12, (x / W) * 100))}%`;
        tip.style.top = `${(y / H) * 100}%`;
        tip.classList.toggle('below', y < H * 0.32);
        tip.classList.remove('hidden');
    };

    // Nearest visible bucket to a viewBox x — the reader aims at a date, not
    // at a 2px line
    const readAt = (viewX) => {
        let best = null, bestDist = Infinity;
        shown.forEach((point, index) => {
            const dist = Math.abs(px(point[0]) - viewX);
            if (dist < bestDist) { bestDist = dist; best = index; }
        });
        if (best !== null) showRead(best);
    };

    const viewXof = (clientX) => {
        const rect = svg.getBoundingClientRect();

        return ((clientX - rect.left) / rect.width) * W;
    };

    svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const at = x0 + (viewXof(event.clientX) / W) * (x1 - x0);
        const factor = event.deltaY < 0 ? 0.8 : 1.25;
        const nx0 = Math.max(tMin, at - (at - x0) * factor);
        const nx1 = Math.min(tMax, at + (x1 - at) * factor);
        if (nx1 - nx0 >= 86400) {
            x0 = nx0; x1 = nx1;
            draw();
            readAt(viewXof(event.clientX));
        }
    }, { passive: false });

    let dragX = null;
    svg.addEventListener('pointerdown', (event) => {
        dragX = event.clientX;
        svg.setPointerCapture(event.pointerId);
        svg.classList.add('dragging');
        hideRead();
    });
    svg.addEventListener('pointermove', (event) => {
        if (dragX === null) {
            readAt(viewXof(event.clientX));

            return;
        }
        const rect = svg.getBoundingClientRect();
        const dt = ((event.clientX - dragX) / rect.width) * (x1 - x0);
        dragX = event.clientX;
        let nx0 = x0 - dt, nx1 = x1 - dt;
        if (nx0 < tMin) { nx1 += tMin - nx0; nx0 = tMin; }
        if (nx1 > tMax) { nx0 -= nx1 - tMax; nx1 = tMax; }
        x0 = Math.max(tMin, nx0); x1 = Math.min(tMax, nx1);
        draw();
    });
    const endDrag = () => { dragX = null; svg.classList.remove('dragging'); };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('pointerleave', () => { endDrag(); hideRead(); });

    // Keyboard reaches the same readout: the crosshair walks bucket by bucket
    svg.addEventListener('keydown', (event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (step) {
            event.preventDefault();
            const from = readIndex === null ? shown.findIndex((p) => p[0] >= x0) : readIndex + step;
            showRead(Math.min(shown.length - 1, Math.max(0, from)));
        } else if (event.key === 'Escape') {
            hideRead();
        }
    });
    svg.addEventListener('blur', hideRead);

    draw();

    return wrap;
}

function renderScoreTables(wrap, rows, ui, rerender) {
    wrap.innerHTML = '';

    // Result filter, above the table on the right
    const toolbar = el('div', 'scores-toolbar');
    const resultSelect = el('select', 'sort');
    resultSelect.append(new Option(t('All results'), 'all'), new Option(t('Cleared'), 'clear'), new Option(t('Failed'), 'fail'));
    resultSelect.value = ui.result;
    resultSelect.addEventListener('change', () => { ui.result = resultSelect.value; rerender(); });
    toolbar.appendChild(resultSelect);
    wrap.appendChild(toolbar);

    wrap.appendChild(el('h4', 'page-heading', t('Top scores')));
    wrap.appendChild(playsTable([...rows].sort((a, b) => b.sc - a.sc).slice(0, 10)));
    wrap.appendChild(el('h4', 'page-heading', t('Recent plays')));
    wrap.appendChild(playsTable(rows.slice(0, 15)));
}

function playsTable(rows) {
    const table = pageTable([t('Song'), t('Chart'), 'Score', t('Gauge'), t('Date')], 2);
    const body = table.createTBody();
    for (const play of rows) {
        const row = body.insertRow();
        const song = row.insertCell();
        song.appendChild(el('span', '', play.ti || t('Not installed')));
        if (play.ar) song.appendChild(el('span', 'cell-sub', ` ${play.ar}`));
        const chart = row.insertCell();
        if (play.d) {
            const label = el('span', '', `${play.d} ${play.lv}`);
            label.style.color = DIFF_COLORS[play.d] || 'var(--diff-any)';
            chart.appendChild(label);
            if (play.ef) chart.appendChild(el('span', 'cell-sub', ` ${play.ef}`));
        } else {
            chart.textContent = '—';
        }
        Object.assign(row.insertCell(), { textContent: formatScore(play.sc), className: 'num' });
        const gauge = row.insertCell();
        gauge.textContent = `${play.g} %`;
        gauge.className = 'num ' + (play.g >= 70 ? 'gauge-clear' : 'gauge-fail');
        Object.assign(row.insertCell(), { textContent: formatDate(play.t), className: 'num' });
    }
    if (!rows.length) {
        const row = table.createTBody().insertRow();
        Object.assign(row.insertCell(), { textContent: t('No plays match the filters.'), colSpan: 5, className: 'notplayed' });
    }

    return table;
}

/* ----- Collections page ----- */

async function openCollectionsPage() {
    await openPage('collections', t('Collections'), async (node) => {
        const { collections } = await api('collections-overview');
        $('#context-count').textContent = t('{n} collections', { n: formatInt(collections.length) });
        node.innerHTML = '';
        const page = el('div', 'page');

        const table = pageTable([t('Collection'), t('Songs'), t('Charts'), t('Levels'), t('Missing'), t('Sync'), ''], 1);
        const body = table.createTBody();
        for (const collection of collections) {
            const row = body.insertRow();
            const name = row.insertCell();
            const open = el('button', 'link-button', collection.name);
            open.addEventListener('click', () => loadCollection(collection.name));
            name.appendChild(open);
            Object.assign(row.insertCell(), { textContent: formatInt(collection.songs), className: 'num' });
            Object.assign(row.insertCell(), { textContent: formatInt(collection.charts), className: 'num' });
            Object.assign(row.insertCell(), { textContent: `${collection.min_level}–${collection.max_level}`, className: 'num' });
            const missing = row.insertCell();
            missing.className = 'num';
            if (collection.missing > 0) {
                missing.appendChild(el('span', 'missing-badge', String(collection.missing)));
            } else {
                missing.textContent = '—';
            }
            // Database vs .fav mirror: they diverge when the game rebuilt its
            // index (folderids recycled) or the mirror was edited by hand.
            const sync = row.insertCell();
            sync.className = 'num';
            if (collection.sync === 'diverged') {
                const badge = el('span', 'missing-badge', t('diverged'));
                badge.title = t('{a} only in .fav, {b} only in database', { a: collection.only_fav, b: collection.only_db });
                sync.appendChild(badge);
            } else {
                sync.textContent = collection.sync === 'in_sync' ? 'OK' : '—';
            }
            const actions = row.insertCell();
            actions.className = 'num';
            if (collection.sync === 'diverged') {
                const restore = el('button', 'btn', t('Restore from .fav'));
                restore.addEventListener('click', () => promptResyncFromFav(collection));
                const rewrite = el('button', 'btn btn-quiet', t('Rewrite .fav'));
                rewrite.addEventListener('click', () => promptResyncToFav(collection));
                actions.append(restore, rewrite);
            }
            const exportButton = el('button', 'btn', t('Export'));
            exportButton.addEventListener('click', () => {
                const url = new URL('api.php', window.location.href);
                url.searchParams.set('action', 'export');
                url.searchParams.set('name', collection.name);
                window.location.href = url;
            });
            actions.appendChild(exportButton);
        }
        page.appendChild(table);
        if (!collections.length) {
            page.appendChild(el('p', 'notplayed', 'No collections yet.'));
        }
        node.appendChild(page);
    });
}

// The mirror wins: rebuild the DB collection from the .fav lines (this is the
// recovery path after the game re-indexed and scrambled the folderids).
function promptResyncFromFav(collection) {
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Restore "{c}" from its .fav mirror?', { c: collection.name })));
        modal.appendChild(el('p', 'note note-warn',
            t('The mirror file wins: {a} song{s} only in the mirror will be added, {b} only in the database will be removed. Lines pointing to uninstalled charts stay in the file. A database backup is taken first.', { a: collection.only_fav, s: plural(collection.only_fav), b: collection.only_db })));

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Back up and restore'));
        confirm.addEventListener('click', async () => {
            confirm.disabled = true;
            try {
                const data = await api('resync-from-fav', { body: { name: collection.name } });
                state.collections = data.collections;
                closeModal();
                toast(t('"{c}" restored from its .fav ({n} songs, {m} not installed)', { c: collection.name, n: formatInt(data.matched), m: formatInt(data.missing) }), 'success');
                await boot();
                reloadCurrentView();
            } catch (error) {
                toast(error.message, 'error');
            } finally {
                confirm.disabled = false;
            }
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

// The database wins: regenerate the mirror (for a stale or hand-edited .fav).
function promptResyncToFav(collection) {
    openModal((modal) => {
        modal.appendChild(el('h3', '', t('Rewrite the .fav of "{c}" from the database?', { c: collection.name })));
        modal.appendChild(el('p', 'note note-warn',
            t('The database wins: the mirror is regenerated from the collection content and loses the {a} line{s} it alone carried. The current file is saved as .fav.bak first.', { a: collection.only_fav, s: plural(collection.only_fav) })));

        const actions = el('div', 'modal-actions');
        const cancel = el('button', 'btn btn-quiet', t('Cancel'));
        cancel.addEventListener('click', closeModal);
        const confirm = el('button', 'btn btn-primary', t('Back up and rewrite'));
        confirm.addEventListener('click', async () => {
            confirm.disabled = true;
            try {
                await api('resync-to-fav', { body: { name: collection.name } });
                closeModal();
                toast(t('.fav mirror rewritten for "{c}"', { c: collection.name }), 'success');
                await boot();
                reloadCurrentView();
            } catch (error) {
                toast(error.message, 'error');
            } finally {
                confirm.disabled = false;
            }
        });
        actions.append(cancel, confirm);
        modal.appendChild(actions);
    });
}

/* ----- Artists page ----- */

const NAME_PAGE_SIZE = 100;

// Gojūon rows: first-kana bucket for Japanese names (katakana folded to
// hiragana). Kanji, digits and symbols stay in '#'.
const KANA_ROWS = [
    ['あ', 0x3041, 0x304A],
    ['か', 0x304B, 0x3054],
    ['さ', 0x3055, 0x305E],
    ['た', 0x305F, 0x3069],
    ['な', 0x306A, 0x306E],
    ['は', 0x306F, 0x307D],
    ['ま', 0x307E, 0x3082],
    ['や', 0x3083, 0x3088],
    ['ら', 0x3089, 0x308D],
    ['わ', 0x308E, 0x3096],
];

function kanaRowOf(char) {
    let code = char.codePointAt(0);
    if (code >= 0x30A1 && code <= 0x30F6) code -= 0x60; // katakana -> hiragana
    if (code === 0x3094) return 'あ'; // ゔ
    for (const [head, low, high] of KANA_ROWS) {
        if (code >= low && code <= high) return head;
    }

    return null;
}

// Reusable browser for big name lists (Artists, Effectors):
// A–Z + kana bar + text filter + paginated table with sticky header
function nameBrowser({ items, getName, nameLabel, columns, onOpen, placeholder }) {
    const container = el('div');
    let letter = ''; // '' = all, 'A'..'Z', '#', or a gojūon row head
    let pageIndex = 0;

    const letterBar = el('div', 'letter-bar');
    const letters = [
        'All',
        ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
        '#',
        ...KANA_ROWS.map(([head]) => head),
    ];
    const chips = new Map();
    for (const value of letters) {
        const chip = el('button', 'level-chip' + (value === 'All' ? ' active' : ''), value);
        chip.addEventListener('click', () => {
            letter = value === 'All' ? '' : value;
            chips.forEach((c, v) => c.classList.toggle('active', (v === 'All' ? '' : v) === letter));
            pageIndex = 0;
            render();
        });
        chips.set(value, chip);
        letterBar.appendChild(chip);
    }

    const query = el('input', 'page-search');
    query.type = 'search';
    query.placeholder = placeholder;
    const controls = el('div', 'page-controls');
    controls.append(letterBar, query);

    const wrap = el('div');
    container.append(controls, wrap);

    const bucketOf = (name) => {
        const first = (name || '').charAt(0).toUpperCase();
        if (first >= 'A' && first <= 'Z') return first;

        return kanaRowOf(first) || '#';
    };

    const render = () => {
        const text = query.value.trim().toLowerCase();
        const rows = items.filter((item) =>
            (!letter || bucketOf(getName(item)) === letter)
            && (!text || (getName(item) || '').toLowerCase().includes(text)));

        pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(rows.length / NAME_PAGE_SIZE) - 1));
        const start = pageIndex * NAME_PAGE_SIZE;
        const slice = rows.slice(start, start + NAME_PAGE_SIZE);

        wrap.innerHTML = '';
        const table = pageTable([nameLabel, ...columns.map(([label]) => label)], 1);
        const body = table.createTBody();
        for (const item of slice) {
            const row = body.insertRow();
            const cell = row.insertCell();
            const open = el('button', 'link-button', getName(item) || t('(unknown)'));
            open.addEventListener('click', () => onOpen(item));
            cell.appendChild(open);
            for (const [, getter] of columns) {
                Object.assign(row.insertCell(), { textContent: formatInt(getter(item)), className: 'num' });
            }
        }
        wrap.appendChild(table);
        if (!rows.length) {
            wrap.appendChild(el('p', 'notplayed', t('No match.')));
        }

        const pager = el('div', 'pager');
        const prev = el('button', 'btn', t('← Previous'));
        prev.disabled = pageIndex === 0;
        prev.addEventListener('click', () => {
            pageIndex--;
            render();
            $('#songlist').scrollTop = 0;
        });
        const next = el('button', 'btn', t('Next →'));
        next.disabled = start + NAME_PAGE_SIZE >= rows.length;
        next.addEventListener('click', () => {
            pageIndex++;
            render();
            $('#songlist').scrollTop = 0;
        });
        const info = el('span', 'pager-info',
            rows.length ? t('{a}–{b} of {n}', { a: formatInt(start + 1), b: formatInt(Math.min(start + NAME_PAGE_SIZE, rows.length)), n: formatInt(rows.length) }) : '');
        pager.append(prev, info, next);
        wrap.appendChild(pager);
    };

    let timer;
    query.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            pageIndex = 0;
            render();
        }, 250);
    });
    render();

    return container;
}

// An artist's songs in the regular browser: previews, collections, the works
async function loadArtist(artist) {
    await loadView({ type: 'artist', key: artist, label: artist }, () =>
        api('songs', { params: { artist } }));
}

/* ---------- Explorer (Songs / Charts / Artists / Effectors) ---------- */

const EXPLORE_SCOPES = ['songs', 'charts', 'artists', 'effectors'];
const EXPLORE_DIFFS = ['NOV', 'ADV', 'EXH', 'INF'];
const EXPLORE_PER = 100;

// Opens the unified browse page on a given scope. opts.q seeds the query
// (used when the search box feeds the page).
async function openExplorer(scope, opts = {}) {
    if (!EXPLORE_SCOPES.includes(scope)) scope = 'songs';
    if ('q' in opts) {
        state.explore.q = opts.q;
        state.explore.page = 1;
    }
    if (state.explore.scope !== scope) state.explore.page = 1;
    state.explore.scope = scope;

    state.view = { type: 'page', key: scope, label: t(scope), q: state.explore.q };
    syncHash(state.view);
    state.songs = [];
    state.missing = [];
    state.selected.clear();
    updateSelectionUi();
    renderCollectionsNav();
    markActiveNav();
    $('#nautica-section').classList.remove('active');
    $('#context').classList.add('page-mode', 'explorer-mode');
    $('#search').value = state.explore.q; // keep the sidebar box in step

    await renderExplorer();
}

// Rebuilds the whole page (tabs + scope body). Filter/scope changes call this;
// paging refreshes only the inner list.
async function renderExplorer() {
    const node = $('#songlist');
    node.innerHTML = '';
    const page = el('div', 'page explorer');
    node.appendChild(page);

    // Scope tabs — library totals, click to switch what you browse
    const tabs = el('div', 'stat-cards explorer-tabs');
    for (const scope of EXPLORE_SCOPES) {
        const active = scope === state.explore.scope;
        const card = el('button', 'stat-card clickable explorer-tab' + (active ? ' active' : ''));
        card.append(el('p', 'stat-value', formatInt(state.stats[scope] ?? 0)), el('p', 'stat-label', t(scope)));
        if (!active) card.addEventListener('click', () => openExplorer(scope));
        tabs.appendChild(card);
    }
    page.appendChild(tabs);

    const body = el('div', 'explorer-body');
    page.appendChild(body);

    if (state.explore.scope === 'artists' || state.explore.scope === 'effectors') {
        await renderExploreNames(body);
    } else {
        await renderExploreCharts(body);
    }
}

function exploreParams() {
    const ex = state.explore;
    const params = { scope: ex.scope, page: ex.page, per: EXPLORE_PER, sort: ex.sort };
    if (ex.q) params.q = ex.q;
    if (ex.levels.length) params.levels = ex.levels.join(',');
    if (ex.diffs.length) params.diffs = ex.diffs.join(',');

    return params;
}

// Toggle a level/difficulty and rebuild the scope (chip states + data)
function toggleExploreFilter(key, value) {
    const arr = state.explore[key];
    const index = arr.indexOf(value);
    if (index === -1) arr.push(value);
    else arr.splice(index, 1);
    state.explore.page = 1;
    renderExplorer();
}

// Songs and Charts tabs: filter chips + level chart + server-paginated list
async function renderExploreCharts(body) {
    const ex = state.explore;

    // Level chart on top (filled by loadPage), filters below it
    const chartWrap = el('div', 'explore-chart');

    const controls = el('div', 'page-controls explore-controls');
    const levelChips = el('div', 'level-chips explore-levels');
    for (let level = 1; level <= 20; level++) {
        const chip = el('button', 'level-chip' + (ex.levels.includes(level) ? ' active' : ''), String(level));
        chip.addEventListener('click', () => toggleExploreFilter('levels', level));
        levelChips.appendChild(chip);
    }
    const diffChips = el('div', 'diff-chips explore-diffs');
    for (const diff of EXPLORE_DIFFS) {
        const chip = el('button', 'level-chip diff-chip' + (ex.diffs.includes(diff) ? ' active' : ''), diff);
        chip.style.setProperty('--diff-color', DIFF_COLORS[diff] || 'var(--diff-any)');
        chip.addEventListener('click', () => toggleExploreFilter('diffs', diff));
        diffChips.appendChild(chip);
    }
    const clear = el('button', 'btn btn-quiet', t('Clear filters'));
    const refreshClear = () => clear.classList.toggle('hidden', !ex.levels.length && !ex.diffs.length && !ex.q);
    refreshClear();
    clear.addEventListener('click', () => {
        state.explore = { ...ex, levels: [], diffs: [], q: '', page: 1 };
        $('#search').value = '';
        renderExplorer();
    });

    // Text search below the filters, kept in step with the sidebar box
    const search = el('input', 'page-search explore-search');
    search.type = 'search';
    search.placeholder = t('Title, artist, effector…');
    search.value = ex.q;
    let searchDebounce;
    search.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            ex.q = search.value.trim();
            ex.page = 1;
            $('#search').value = ex.q;
            state.view.q = ex.q;
            syncHash(state.view);
            refreshClear();
            loadPage();
        }, 300);
    });

    const searchRow = el('div', 'explore-search-row');
    searchRow.appendChild(search);
    controls.append(levelChips, diffChips, clear, searchRow);

    // Toolbar just above the table: selection (left) + sort (right)
    const selWrap = el('div', 'explore-selbar');
    const selMain = el('div', 'explore-selbar-main');
    const sort = el('select', 'sort');
    sort.append(new Option(t('Sort by title'), 'title'), new Option(t('Sort by artist'), 'artist'), new Option(t('Sort by level'), 'level'));
    sort.value = ex.sort;
    sort.addEventListener('change', () => { ex.sort = sort.value; ex.page = 1; loadPage(); });
    selWrap.append(selMain, sort);

    const listWrap = el('div', 'explore-list');
    const pagerWrap = el('div');
    body.append(chartWrap, controls, selWrap, listWrap, pagerWrap);

    const loadPage = async () => {
        listWrap.innerHTML = '';
        listWrap.appendChild(el('p', 'songlist-empty', t('Loading…')));
        try {
            const data = await api('explore', { params: exploreParams() });

            chartWrap.innerHTML = '';
            chartWrap.appendChild(el('h4', 'page-heading', t('Charts by level — click a bar to filter')));
            const pairs = Array.from({ length: 20 }, (_, i) => [String(i + 1), data.levels[i + 1] || 0]);
            chartWrap.appendChild(barChart(pairs, (label) => toggleExploreFilter('levels', Number(label))));

            listWrap.innerHTML = '';
            if (!data.items.length) {
                listWrap.appendChild(el('p', 'songlist-empty', t('No results.')));
            } else {
                const fragment = document.createDocumentFragment();
                for (const song of data.items) fragment.appendChild(songRow(song, true));
                listWrap.appendChild(fragment);
            }
            renderExplorePager(pagerWrap, data.total, loadPage);

            // Selection toolbar (checkbox picking → add to collection)
            exploreCtx = { bar: selMain, pageItems: data.items, songTotal: data.song_total };
            refreshExploreSelection();
        } catch (error) {
            listWrap.innerHTML = '';
            listWrap.appendChild(el('p', 'songlist-empty', error.message));
        }
    };

    await loadPage();
}

/* ----- Explorer multi-selection (checkbox → add to collection) ----- */

// Set by loadPage; refreshExploreSelection re-renders the toolbar from it
let exploreCtx = { bar: null, pageItems: [], songTotal: 0 };

// Keeps every visible checkbox (incl. duplicate-song rows in the Charts view)
// and the toolbar in step with state.selected
function refreshExploreSelection() {
    if (!exploreCtx.bar || state.view.type !== 'page' || !['songs', 'charts'].includes(state.explore.scope)) {
        return;
    }
    document.querySelectorAll('#songlist .song-select').forEach((check) => {
        const row = check.closest('.song');
        if (row) check.checked = state.selected.has(Number(row.dataset.folderid));
    });
    renderExploreSelectionBar(exploreCtx.bar, exploreCtx.pageItems, exploreCtx.songTotal);
}

function renderExploreSelectionBar(bar, pageItems, songTotal) {
    bar.innerHTML = '';
    const selected = state.selected.size;
    if (!pageItems.length && selected === 0) return; // empty page → :empty hides the bar
    const pageIds = [...new Set(pageItems.map((song) => song.folderid))];
    const pageAll = pageIds.length > 0 && pageIds.every((id) => state.selected.has(id));
    const pageSome = pageIds.some((id) => state.selected.has(id));

    const label = el('label', 'sel-page');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = pageAll;
    check.indeterminate = !pageAll && pageSome;
    check.addEventListener('change', () => {
        // Unchecking clears the whole selection (incl. off-page "Select all")
        if (check.checked) pageIds.forEach((id) => state.selected.add(id));
        else state.selected.clear();
        refreshExploreSelection();
    });
    label.append(check, el('span', '', t('Select page')));
    bar.appendChild(label);

    if (selected > 0) {
        bar.appendChild(el('span', 'sel-count', t('{n} selected', { n: formatInt(selected), s: plural(selected) })));
    }

    // Across-pages select-all: only once the whole page is ticked and there is
    // more to select than what's on screen
    if (pageAll && songTotal > pageIds.length && selected < songTotal) {
        const all = el('button', 'btn btn-laser', t('Select all {n}', { n: formatInt(songTotal) }));
        all.addEventListener('click', () => selectAllExplore());
        bar.appendChild(all);
    }

    if (selected > 0) {
        const add = el('button', 'btn btn-primary', t('Add to Collection ({n})', { n: formatInt(selected) }));
        add.addEventListener('click', openBulkCollect);
        const clear = el('button', 'btn btn-quiet', t('Clear selection'));
        clear.addEventListener('click', () => { state.selected.clear(); refreshExploreSelection(); });
        bar.append(add, clear);
    }
}

// Select every song matching the current filter, across all pages
async function selectAllExplore() {
    try {
        const { ids } = await api('explore-ids', { params: exploreParams() });
        state.selected = new Set(ids);
        refreshExploreSelection();
    } catch (error) {
        toast(error.message, 'error');
    }
}

function renderExplorePager(wrap, total, reload) {
    const ex = state.explore;
    const pages = Math.max(1, Math.ceil(total / EXPLORE_PER));
    if (ex.page > pages) ex.page = pages;
    const start = (ex.page - 1) * EXPLORE_PER;

    wrap.innerHTML = '';
    const pager = el('div', 'pager');
    const prev = el('button', 'btn', t('← Previous'));
    prev.disabled = ex.page <= 1;
    prev.addEventListener('click', () => { ex.page--; reload(); $('#songlist').scrollTop = 0; });
    const next = el('button', 'btn', t('Next →'));
    next.disabled = ex.page >= pages;
    next.addEventListener('click', () => { ex.page++; reload(); $('#songlist').scrollTop = 0; });
    const info = el('span', 'pager-info', total
        ? t('{a}–{b} of {n}', { a: formatInt(start + 1), b: formatInt(Math.min(start + EXPLORE_PER, total)), n: formatInt(total) })
        : t('No results.'));
    pager.append(prev, info, next);
    wrap.appendChild(pager);
}

// Artists and Effectors tabs: a top-15 chart + the full list (client-side
// A–Z + name filter + pagination via nameBrowser)
async function renderExploreNames(body) {
    const scope = state.explore.scope;
    body.appendChild(el('p', 'songlist-empty', t('Loading…')));

    let items;
    try {
        const data = await api(scope);
        items = data[scope];
    } catch (error) {
        body.innerHTML = '';
        body.appendChild(el('p', 'songlist-empty', error.message));

        return;
    }
    body.innerHTML = '';

    const nameKey = scope === 'artists' ? 'artist' : 'effector';
    const openItem = scope === 'artists'
        ? (name) => loadArtist(name)
        : (name) => openExplorer('charts', { q: name });

    const top = [...items].sort((a, b) => b.charts - a.charts).slice(0, 15);
    if (top.length) {
        body.appendChild(el('h4', 'page-heading',
            scope === 'artists' ? t('Top artists by charts') : t('Top effectors by charts')));
        body.appendChild(topBars(top.map((item) => [item[nameKey], item.charts]), openItem));
    }

    body.appendChild(nameBrowser({
        items,
        getName: (item) => item[nameKey],
        nameLabel: scope === 'artists' ? t('Artist') : t('Effector'),
        columns: [[t('Songs'), (item) => item.songs], [t('Charts'), (item) => item.charts]],
        onOpen: (item) => openItem(item[nameKey]),
        placeholder: scope === 'artists' ? t('Filter artists…') : t('Filter effectors…'),
    }));
}

// Horizontal bar list for the top artists/effectors — names are long, so the
// vertical barChart doesn't fit them
function topBars(pairs, onClick = null) {
    const max = Math.max(1, ...pairs.map((pair) => pair[1]));
    const wrap = el('div', 'top-bars');
    for (const [name, value] of pairs) {
        const row = el(onClick ? 'button' : 'div', 'top-bar' + (onClick ? ' clickable' : ''));
        const label = Object.assign(el('span', 'top-bar-name', name || t('(unknown)')), { title: name || '' });
        const track = el('span', 'top-bar-track');
        const fill = el('span', 'top-bar-fill');
        fill.style.width = `${Math.round((value / max) * 100)}%`;
        track.appendChild(fill);
        row.append(label, track, el('span', 'top-bar-value', formatInt(value)));
        if (onClick) row.addEventListener('click', () => onClick(name));
        wrap.appendChild(row);
    }

    return wrap;
}

/* ---------- Settings ---------- */

$('#btn-settings').addEventListener('click', () => openSettings());

let settingsTab = 'installation'; // remembered across openings

async function openSettings() {
    let backups = [];
    let backupsDir = '';
    let scoreSources = [];
    let colBackups = [];
    try {
        [{ backups, dir: backupsDir }, { sources: scoreSources }, { backups: colBackups }] =
            await Promise.all([api('backups'), api('score-sources'), api('collections-backups')]);
    } catch { /* all lists are informative only */ }

    openModal((modal) => {
        modal.classList.add('modal-settings');
        modal.appendChild(el('h3', '', t('Settings')));

        const sections = [
            ['installation', t('Installation'), settingsInstallation],
            ['backups', t('Backups'), (panel) => settingsBackups(panel, backups, backupsDir, colBackups)],
            ['scores', t('Restore scores'), (panel) => settingsScores(panel, scoreSources)],
            ['nautica', 'Nautica', settingsNautica],
            ['language', t('Language'), settingsLanguage],
            ['moved', t('Library moved'), settingsFixPaths],
        ];

        const layout = el('div', 'settings-layout');
        const nav = el('ul', 'settings-nav');
        const panel = el('div', 'settings-panel');
        const buttons = new Map();

        const select = (key) => {
            settingsTab = key;
            buttons.forEach((button, k) => button.classList.toggle('active', k === key));
            panel.innerHTML = '';
            sections.find(([k]) => k === key)[2](panel);
        };

        for (const [key, label] of sections) {
            const item = el('li');
            const button = el('button', 'settings-nav-item', label);
            button.addEventListener('click', () => select(key));
            buttons.set(key, button);
            item.appendChild(button);
            nav.appendChild(item);
        }

        layout.append(nav, panel);
        modal.appendChild(layout);
        if (!sections.some(([key]) => key === settingsTab)) settingsTab = 'installation';
        select(settingsTab);
    });
}

function settingsInstallation(panel) {
    const { paths } = state;
    panel.appendChild(el('h4', '', t('Installation')));

    const table = el('table', 'paths-table');
    const rows = [
        [t('Game folder'), paths.game_root],
        ['maps.db', paths.mapsdb_path],
        [t('Songs folder'), paths.songs_root],
        ['Main.cfg', paths.config_path || t('not found')],
    ];
    for (const [label, value] of rows) {
        const row = table.insertRow();
        row.insertCell().textContent = label;
        row.insertCell().appendChild(el('code', '', value || '—'));
    }
    panel.appendChild(table);

    panel.appendChild(el('p', 'hint', t('Switch to another installation — the folder containing maps.db:')));
    const rootForm = el('div', 'newcollection');
    const rootInput = el('input');
    rootInput.type = 'text';
    rootInput.value = paths.game_root || '';
    const rootButton = el('button', 'btn', t('Connect'));
    rootButton.addEventListener('click', (event) => connectRoot(rootInput.value, event.currentTarget));
    rootForm.appendChild(rootInput);
    if (state.canBrowse) {
        const browseButton = el('button', 'btn', t('Browse…'));
        browseButton.addEventListener('click', () => browseForRoot(rootInput));
        rootForm.appendChild(browseButton);
    }
    rootForm.appendChild(rootButton);
    panel.appendChild(rootForm);

    panel.appendChild(el('p', 'hint',
        t('Forget this installation and go back to the setup screen (nothing else is deleted).')));
    const disconnectButton = el('button', 'btn', t('Disconnect'));
    disconnectButton.addEventListener('click', async () => {
        disconnectButton.disabled = true;
        try {
            await api('disconnect', { body: {} });
            location.reload();
        } catch (error) {
            toast(error.message, 'error');
            disconnectButton.disabled = false;
        }
    });
    panel.appendChild(disconnectButton);
}

function settingsBackups(panel, backups, backupsDir, colBackups = []) {
    panel.appendChild(el('h4', '', t('Database backups')));
    panel.appendChild(el('p', 'hint',
        t('An automatic backup is made before the first change of each day.')));

    if (backupsDir) {
        const where = el('p', 'hint');
        where.append(t('Folder: '));
        where.appendChild(el('code', '', backupsDir));
        panel.appendChild(where);
    }

    const buttons = el('div', 'newcollection');
    const backupButton = el('button', 'btn', t('Back up now'));
    backupButton.addEventListener('click', async () => {
        try {
            const data = await api('backup', { body: {} });
            toast(t('Backup created: {f}', { f: data.backup }), 'success');
            openSettings();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
    buttons.appendChild(backupButton);
    if (state.canBrowse) {
        const openButton = el('button', 'btn', t('Open folder'));
        openButton.addEventListener('click', async () => {
            try {
                await api('open-backups-folder', { body: {} });
            } catch (error) {
                toast(error.message, 'error');
            }
        });
        buttons.appendChild(openButton);
    }
    panel.appendChild(buttons);
    if (backups.length) {
        const list = el('ul', 'backups-list');
        for (const backup of backups.slice(0, 10)) {
            list.appendChild(el('li', '', `${backup.file} — ${(backup.size / 1048576).toFixed(1)} MB`));
        }
        panel.appendChild(list);
    }

    // Collection backups: a daily portable snapshot, restorable on its own
    panel.appendChild(el('h4', 'settings-subhead', t('Collection backups')));
    panel.appendChild(el('p', 'hint',
        t('Your collections are also snapshotted here once a day — portable and re-importable, and kept even if a collection is deleted. Restoring only adds back songs, it never removes any.')));

    if (!colBackups.length) {
        panel.appendChild(el('p', 'hint', t('No collection backup yet — edit a collection to create one.')));

        return;
    }
    const colList = el('ul', 'score-sources');
    for (const backup of colBackups.slice(0, 12)) {
        const item = el('li', 'score-source');
        const info = el('div', 'score-source-info');
        info.appendChild(el('p', 'name', backup.file));
        info.appendChild(el('p', 'hint', `${t('{n} collections', { n: formatInt(backup.count) })} — ${formatDate(backup.date)}`));
        item.appendChild(info);

        const restore = el('button', 'btn', t('Restore'));
        restore.addEventListener('click', async () => {
            restore.disabled = true;
            try {
                const data = await api('restore-collections', { body: { file: backup.file } });
                state.collections = data.collections;
                state.stats.collections = data.collections.length;
                renderCollectionsNav();
                renderStats();
                toast(t('{n} collection{s} restored', { n: formatInt(data.restored.length), s: plural(data.restored.length) }), 'success');
            } catch (error) {
                toast(error.message, 'error');
            } finally {
                restore.disabled = false;
            }
        });
        item.appendChild(restore);
        colList.appendChild(item);
    }
    panel.appendChild(colList);
}

function settingsScores(panel, scoreSources) {
    panel.appendChild(el('h4', '', t('Restore scores')));
    panel.appendChild(el('p', 'hint',
        t('Copy score history from an older database. Only missing plays are added; a full backup is made first.')));
    const where = el('p', 'hint');
    where.append(t('Databases are looked up in the game folder ('));
    where.appendChild(el('code', '', 'maps.db*.bak'));
    where.append(', ');
    where.appendChild(el('code', '', '_maps.db'));
    where.append(t('…), in the tool\'s '));
    where.appendChild(el('code', '', 'backups/'));
    where.append(t(' folder. Hover a file for its full path.'));
    panel.appendChild(where);

    if (!scoreSources.length) {
        panel.appendChild(el('p', 'notplayed', t('No older database found.')));

        return;
    }

    const list = el('ul', 'modal-list score-sources');
    for (const source of scoreSources) {
        const item = el('li', 'score-source');
        const info = el('div', 'score-source-info');
        info.appendChild(Object.assign(el('p', 'name', source.file.split('/').pop()), { title: source.file }));
        info.appendChild(el('p', 'hint', source.compatible
            ? t('{n} scores — {a} to {b}', { n: formatInt(source.scores), a: formatDate(source.from).split(',')[0], b: formatDate(source.to).split(',')[0] })
            : source.note));
        item.appendChild(info);

        if (source.compatible && source.scores > 0) {
            const restoreButton = el('button', 'btn', t('Restore'));
            restoreButton.addEventListener('click', async () => {
                restoreButton.disabled = true;
                try {
                    const data = await api('restore-scores', { body: { file: source.file } });
                    closeModal();
                    toast(t('{n} score{s} restored', { n: formatInt(data.added), s: plural(data.added) }), 'success');
                    await boot();
                    reloadCurrentView();
                } catch (error) {
                    toast(error.message, 'error');
                    restoreButton.disabled = false;
                }
            });
            item.appendChild(restoreButton);
        }
        list.appendChild(item);
    }
    panel.appendChild(list);
}

function settingsNautica(panel) {
    const { paths } = state;
    panel.appendChild(el('h4', '', 'Nautica (ksm.dev)'));
    panel.appendChild(el('p', 'hint',
        t('Browse and download community charts. Downloads go to a dedicated folder inside your songs folder — required — and the game indexes them at launch.')));

    const toggle = el('label', 'toggle');
    const enableBox = el('input');
    enableBox.type = 'checkbox';
    enableBox.checked = Boolean(state.nautica?.enabled);
    toggle.append(enableBox, el('span', 'track'), el('span', '', t('Enable Nautica')));
    panel.appendChild(toggle);

    panel.appendChild(el('label', '', t('Download folder')));
    const dirInput = el('input', 'fix-input');
    dirInput.type = 'text';
    dirInput.placeholder = t('Download folder — e.g. {d}/nautica', { d: paths.songs_root || '' });
    dirInput.value = state.nautica?.dir || `${paths.songs_root || ''}/nautica`;
    if (state.canBrowse) {
        const dirRow = el('div', 'fix-row');
        const browse = el('button', 'btn', t('Browse…'));
        browse.addEventListener('click', () => browseInto(dirInput));
        dirRow.append(dirInput, browse);
        panel.appendChild(dirRow);
    } else {
        panel.appendChild(dirInput);
    }

    panel.appendChild(el('label', '', t('Tracking file (meta.json)')));
    const metaInput = el('input', 'fix-input');
    metaInput.type = 'text';
    metaInput.placeholder = `${paths.songs_root || ''}/meta.json`;
    metaInput.value = state.nautica?.meta || `${paths.songs_root || ''}/meta.json`;
    panel.appendChild(metaInput);
    panel.appendChild(el('p', 'hint', t('Records which charts you have downloaded. Kept in your songs folder so it travels with your library.')));

    const save = el('button', 'btn fix-submit', t('Save'));
    save.addEventListener('click', async () => {
        try {
            const data = await api('set-nautica', {
                body: { enabled: enableBox.checked, dir: dirInput.value, meta: metaInput.value },
            });
            state.nautica = data.nautica;
            renderNauticaNav();
            renderNauticaAlert();
            toast(data.nautica.enabled ? t('Nautica enabled') : t('Nautica disabled'), 'success');
            closeModal();
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    const site = el('a', 'btn btn-quiet fix-submit external-link', t('Open ksm.dev ↗'));
    site.href = 'https://ksm.dev';
    site.target = '_blank';
    site.rel = 'noopener';

    panel.append(save, site);
}

function settingsLanguage(panel) {
    panel.appendChild(el('h4', '', t('Language')));
    panel.appendChild(el('p', 'hint', t('Interface language:')));

    const options = el('div', 'newcollection');
    for (const [code, label] of LANG_CHOICES) {
        const button = el('button', 'btn' + (LANG === code ? ' btn-primary' : ''), label);
        button.addEventListener('click', () => {
            if (LANG === code) return;
            localStorage.setItem('usc-lang', code);
            location.reload();
        });
        options.appendChild(button);
    }
    panel.appendChild(options);
}

function settingsFixPaths(panel) {
    const { paths } = state;
    panel.appendChild(el('h4', '', t('Library moved')));
    panel.appendChild(el('p', 'hint',
        t('If you moved your songs folder, replace the old path with the new one in the database. Automatic backup before changes.')));

    const fromInput = el('input', 'fix-input');
    fromInput.type = 'text';
    fromInput.placeholder = t('Old path — e.g. E:\\Games\\USC\\songs');
    const toInput = el('input', 'fix-input');
    toInput.type = 'text';
    toInput.placeholder = t('New path — e.g. Z:\\Games\\USC\\songs');
    if (paths.paths_mismatch) {
        fromInput.value = paths.db_songs_root;
        toInput.value = paths.songs_root;
    }
    const fixButton = el('button', 'btn btn-danger fix-submit', t('Replace paths'));
    fixButton.addEventListener('click', async () => {
        try {
            const data = await api('fix-paths', { body: { from: fromInput.value, to: toInput.value } });
            toast(t('{n} folders and {m} charts updated', { n: formatInt(data.folders_updated), m: formatInt(data.charts_updated) }), 'success');
            closeModal();
            boot();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
    panel.append(fromInput, toInput, fixButton);
}

/* ---------- Sidebar sections (Collections / Library collapse) ---------- */

function applyNavSections() {
    document.querySelectorAll('.nav-section').forEach((header) => {
        const collapsed = localStorage.getItem(`usc-nav-${header.dataset.target}`) === '1';
        document.getElementById(header.dataset.target).classList.toggle('collapsed', collapsed);
        header.querySelector('.nav-twisty').textContent = collapsed ? '+' : '−';
    });
}

document.querySelectorAll('.nav-section').forEach((header) => {
    header.addEventListener('click', () => {
        const key = `usc-nav-${header.dataset.target}`;
        localStorage.setItem(key, localStorage.getItem(key) === '1' ? '0' : '1');
        applyNavSections();
    });
});

/* ---------- Mobile sidebar ---------- */

$('#btn-menu').addEventListener('click', () => {
    $('.sidebar').classList.toggle('open');
});

$('#songlist').addEventListener('click', () => {
    $('.sidebar').classList.remove('open');
});

/* ---------- Go ---------- */

boot();

