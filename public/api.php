<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/bootstrap.php';

// The full-library view loads all ~14k charts in one response
ini_set('memory_limit', '512M');

// A single PHP warning printed before the payload makes the whole response
// unparseable JSON (and sends the headers early). Warnings go to the log.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

$action = $_GET['action'] ?? '';
$body = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw !== '' && str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) {
        $body = json_decode($raw, true) ?? [];
    }
}

try {
    handle($action, $body);
} catch (Throwable $e) {
    jsonError($e->getMessage(), 500);
}

function handle(string $action, array $body): never
{
    // Actions available before a game root is configured
    switch ($action) {
        case 'init':
            jsonResponse(actionInit());

        case 'browse-list':
            if (!canBrowseNatively()) {
                jsonError('Browsing the server\'s folders is only available when the tool runs locally');
            }
            jsonResponse(listFolders((string) ($body['path'] ?? '')));

        case 'set-root':
            $root = normalizePath((string) ($body['game_root'] ?? ''));
            if ($root === '' || !is_file($root . '/maps.db')) {
                jsonError('No maps.db in this folder: ' . ($root ?: '(empty)'));
            }
            $settings = loadSettings();
            unset($settings['disconnected']); // an explicit connect lifts the disconnect
            $settings['game_root'] = $root;
            saveSettings($settings);
            jsonResponse(actionInit());

        // Forget the configured game root and mark the tool as disconnected, so
        // auto-detection does not immediately re-find the installation next to
        // the tool. The next init falls back to the setup screen.
        case 'disconnect':
            $settings = loadSettings();
            unset($settings['game_root']);
            $settings['disconnected'] = true;
            saveSettings($settings);
            jsonResponse(['ok' => true]);
    }

    $paths = gamePaths();
    if ($paths['mapsdb_path'] === null) {
        jsonError('No game installation configured', 409);
    }
    $pdo = openDb($paths['mapsdb_path']);
    $songsRoot = $paths['songs_root'];                 // real disk location (media, .fav files)
    $dbRoot = $paths['db_songs_root'] ?? $songsRoot;   // prefix the DB paths are written with

    switch ($action) {
        // ---- Read ----
        case 'songs':
            $artist = trim((string) ($_GET['artist'] ?? ''));
            if ($artist !== '') {
                jsonResponse(['songs' => songList($pdo, $dbRoot, 'WHERE c.artist = :artist', ['artist' => $artist])]);
            }
            jsonResponse(['songs' => songsInFolder($pdo, $dbRoot, trim((string) ($_GET['folder'] ?? '')))]);

        case 'collection':
            $name = (string) ($_GET['name'] ?? '');
            jsonResponse([
                'songs'   => songsByFolderIds($pdo, $dbRoot, collectionFolderIds($pdo, $name)),
                'missing' => favMissingEntries($pdo, $dbRoot, $songsRoot, $name),
            ]);

        case 'song-scores':
            jsonResponse(['scores' => songScores($pdo, (int) ($_GET['folderid'] ?? 0))]);

        case 'song-collections':
            jsonResponse(['collections' => songCollections($pdo, (int) ($_GET['folderid'] ?? 0))]);

        case 'export':
            $name = (string) ($_GET['name'] ?? '');
            $playlist = exportPlaylist($pdo, $name);
            $file = preg_replace('/[^\p{L}\p{N} _-]/u', '', $name);
            header('Content-Type: application/json; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $file . '.usc-collection.json"');
            echo json_encode($playlist, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            exit;

        case 'scores-overview':
            jsonResponse(['plays' => scoresOverview($pdo)]);

        case 'collections-overview':
            jsonResponse(['collections' => collectionsOverview($pdo, $dbRoot, $songsRoot)]);

        case 'artists':
            jsonResponse(['artists' => artistsOverview($pdo)]);

        case 'effectors':
            jsonResponse(['effectors' => effectorsList($pdo)]);

        case 'explore':
            [$xLevels, $xDiffs] = chartFilters();
            $scope = (string) ($_GET['scope'] ?? 'songs');
            $q = trim((string) ($_GET['q'] ?? ''));
            $sort = (string) ($_GET['sort'] ?? 'title');
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $per = min(200, max(20, (int) ($_GET['per'] ?? 100)));
            $result = $scope === 'charts'
                ? exploreCharts($pdo, $dbRoot, $q, $xLevels, $xDiffs, $sort, $page, $per)
                : exploreSongs($pdo, $dbRoot, $q, $xLevels, $xDiffs, $sort, $page, $per);
            jsonResponse($result + [
                'levels' => exploreLevels($pdo, $q, $xDiffs),
                'page'   => $page,
                'per'    => $per,
            ]);

        case 'explore-ids':
            [$xLevels, $xDiffs] = chartFilters();
            jsonResponse(['ids' => exploreFolderIds($pdo, trim((string) ($_GET['q'] ?? '')), $xLevels, $xDiffs)]);

        case 'backups':
            jsonResponse(['backups' => backupsList(), 'dir' => normalizePath(BACKUP_DIR)]);

        case 'open-backups-folder':
            if (!canBrowseNatively()) {
                jsonError('Only available when the tool runs locally on Windows');
            }
            if (!is_dir(BACKUP_DIR)) {
                mkdir(BACKUP_DIR, 0777, true);
            }
            pclose(popen('explorer ' . escapeshellarg(str_replace('/', '\\', normalizePath(BACKUP_DIR))), 'r'));
            jsonResponse(['opened' => true]);

        case 'open-folder':
            if (!canBrowseNatively()) {
                jsonError('Only available when the tool runs locally on Windows');
            }
            $base = realpath($songsRoot);
            if ($base === false) {
                jsonError('Songs folder not found on disk');
            }
            // The DB can outlive folders (nautica downloads removed, library
            // trimmed…). Walk up to the nearest folder that still exists, so the
            // button always lands somewhere useful — never outside the songs root.
            $rel = trim(str_replace('\\', '/', (string) ($body['folder'] ?? '')), '/');
            $open = $base;
            $exact = true; // becomes false as soon as we have to climb a level
            while ($rel !== '') {
                $try = realpath($songsRoot . '/' . $rel);
                if ($try !== false && is_dir($try)
                    && strncmp($try . DIRECTORY_SEPARATOR, $base . DIRECTORY_SEPARATOR, strlen($base) + 1) === 0) {
                    $open = $try;
                    break;
                }
                $exact = false;
                $slash = strrpos($rel, '/');
                $rel = $slash === false ? '' : substr($rel, 0, $slash);
            }
            pclose(popen('explorer ' . escapeshellarg(str_replace('/', '\\', $open)), 'r'));
            jsonResponse(['opened' => true, 'exact' => $exact]);

        case 'score-sources':
            jsonResponse(['sources' => scoreSources($paths['game_root'], $paths['mapsdb_path'])]);

        case 'restore-scores':
            $file = normalizePath((string) ($body['file'] ?? ''));
            $known = array_column(scoreSources($paths['game_root'], $paths['mapsdb_path']), 'file');
            if (!in_array($file, $known, true)) {
                jsonError('Unknown backup file: ' . $file);
            }
            backupDb($paths['mapsdb_path']); // full manual backup before a mass insert
            $added = restoreScores($pdo, $file);
            jsonResponse(['added' => $added]);

        case 'collections-backups':
            jsonResponse(['backups' => collectionsBackupsList(), 'dir' => normalizePath(collectionsBackupDir())]);

        case 'restore-collections':
            $file = basename((string) ($body['file'] ?? ''));
            if ($file === '') {
                jsonError('No backup file given');
            }
            $restored = restoreCollections($pdo, $dbRoot, $songsRoot, $paths['mapsdb_path'], $file);
            jsonResponse(['restored' => $restored, 'collections' => collectionsList($pdo)]);

        // ---- Write (all auto-backup first, all synced to the .fav mirror) ----
        case 'toggle':
            $name = trim((string) ($body['collection'] ?? ''));
            $folderId = (int) ($body['folderid'] ?? 0);
            if ($name === '' || $folderId <= 0) {
                jsonError('Missing collection or song');
            }
            if (collectionFolderIds($pdo, $name) === []) { // creating a new collection
                validateCollectionName($name);
            }
            backupDb($paths['mapsdb_path'], auto: true);
            backupCollections($pdo, $dbRoot);
            $added = collectionToggle($pdo, $folderId, $name);
            writeFav($pdo, $dbRoot, $songsRoot, $name);
            jsonResponse(['added' => $added, 'collections' => collectionsList($pdo)]);

        case 'rename-collection':
            $old = trim((string) ($body['old'] ?? ''));
            $new = trim((string) ($body['new'] ?? ''));
            if ($old === '' || $new === '') {
                jsonError('Name cannot be empty');
            }
            validateCollectionName($new);
            backupDb($paths['mapsdb_path'], auto: true);
            backupCollections($pdo, $dbRoot);
            collectionRename($pdo, $old, $new);
            renameFav($pdo, $dbRoot, $songsRoot, $old, $new);
            jsonResponse(['collections' => collectionsList($pdo)]);

        case 'delete-collection':
            $name = trim((string) ($body['name'] ?? ''));
            if ($name === '') {
                jsonError('Missing collection name');
            }
            backupDb($paths['mapsdb_path'], auto: true);
            backupCollections($pdo, $dbRoot);
            $removed = collectionDelete($pdo, $name);
            deleteFav($songsRoot, $name);
            jsonResponse(['removed' => $removed, 'collections' => collectionsList($pdo)]);

        // ---- .fav mirror resync (DB and mirror diverge when the game
        // rebuilds its index and recycles folderids — see favSyncStatus) ----
        case 'resync-from-fav':
            $name = trim((string) ($body['name'] ?? ''));
            if ($name === '') {
                jsonError('Missing collection name');
            }
            backupDb($paths['mapsdb_path'], auto: true);
            backupCollections($pdo, $dbRoot);
            $report = resyncFromFav($pdo, $songsRoot, $name);
            jsonResponse($report + ['collections' => collectionsList($pdo)]);

        case 'resync-to-fav':
            $name = trim((string) ($body['name'] ?? ''));
            if ($name === '' || collectionFolderIds($pdo, $name) === []) {
                jsonError('Unknown or empty collection: ' . $name);
            }
            // The mirror is about to lose whatever it alone carried: keep a copy
            $file = favPath($songsRoot, $name);
            if (is_file($file)) {
                copy($file, $file . '.bak');
            }
            writeFav($pdo, $dbRoot, $songsRoot, $name);
            jsonResponse(['ok' => true]);

        case 'import-preview':
            if (empty($_FILES['playlist']) || $_FILES['playlist']['error'] !== UPLOAD_ERR_OK) {
                jsonError('No file received');
            }
            $content = file_get_contents($_FILES['playlist']['tmp_name']);
            $parsed = parsePlaylistFile($content, $_FILES['playlist']['name']);
            jsonResponse(matchPlaylist($pdo, $parsed));

        case 'import-apply':
            $name = trim((string) ($body['name'] ?? ''));
            $folderIds = $body['folderids'] ?? [];
            if ($name === '' || !is_array($folderIds) || $folderIds === []) {
                jsonError('Missing collection name or song list');
            }
            if (collectionFolderIds($pdo, $name) === []) { // creating a new collection
                validateCollectionName($name);
            }
            backupDb($paths['mapsdb_path'], auto: true);
            backupCollections($pdo, $dbRoot);
            $added = importApply($pdo, $name, $folderIds);
            writeFav($pdo, $dbRoot, $songsRoot, $name);
            jsonResponse(['added' => $added, 'collections' => collectionsList($pdo)]);

        case 'backup':
            jsonResponse(['backup' => basename(backupDb($paths['mapsdb_path']))]);

        // ---- Nautica (ksm.dev) ----
        case 'set-nautica':
            nauticaEnable(
                (bool) ($body['enabled'] ?? false),
                (string) ($body['dir'] ?? ''),
                $songsRoot,
                (string) ($body['meta'] ?? '')
            );
            jsonResponse(['nautica' => nauticaPublicState()]);

        case 'nautica-list':
            if (!nauticaSettings()['enabled']) {
                jsonError('Nautica is not enabled (see Settings)');
            }
            jsonResponse(nauticaList((int) ($_GET['page'] ?? 1), trim((string) ($_GET['q'] ?? ''))));

        case 'nautica-download':
            $nautica = nauticaSettings();
            if (!$nautica['enabled'] || !$nautica['dir']) {
                jsonError('Nautica is not enabled (see Settings)');
            }
            $id = trim((string) ($body['id'] ?? ''));
            if ($id === '') {
                jsonError('Missing song id');
            }
            $step = (string) ($body['step'] ?? 'full');
            if ($step === 'fetch') {
                jsonResponse(nauticaFetch($id));
            }
            if ($step === 'extract') {
                jsonResponse(nauticaExtract($id, $nautica['dir']));
            }
            nauticaFetch($id);
            jsonResponse(nauticaExtract($id, $nautica['dir']));

        case 'nautica-mark-seen':
            nauticaMarkSeen(trim((string) ($body['date'] ?? '')));
            jsonResponse(['nautica' => nauticaPublicState()]);

        case 'fix-paths':
            $from = str_replace('/', '\\', trim((string) ($body['from'] ?? '')));
            $to = str_replace('/', '\\', trim((string) ($body['to'] ?? '')));
            if (strlen($from) < 3 || strlen($to) < 3) {
                jsonError('Paths too short');
            }
            backupDb($paths['mapsdb_path']);
            jsonResponse(fixPaths($pdo, $from, $to));

        // Rewrite a stale SongFolder in Main.cfg onto the real songs folder, so
        // the game's next scan indexes the right place (Main.cfg backed up first).
        case 'fix-config':
            if ($paths['config_path'] === null) {
                jsonError('No Main.cfg found to update');
            }
            rewriteSongFolder($paths['config_path'], $songsRoot);
            jsonResponse(['ok' => true]);

        // One-click repair after a game-folder move: full backup, then every
        // applicable fix in dependency order — Main.cfg first (the game's next
        // scan reads it literally), the DB path prefixes, then the collections
        // whose .fav mirror diverged (rebuilt from the mirror, the durable copy).
        case 'fix-all':
            backupDb($paths['mapsdb_path']);
            $report = [
                'config_fixed'    => false,
                'folders_updated' => 0,
                'charts_updated'  => 0,
                'resynced'        => [],
                'skipped'         => [],
            ];

            if ($paths['config_song_folder_gone'] && $paths['config_path'] !== null) {
                rewriteSongFolder($paths['config_path'], $songsRoot);
                $report['config_fixed'] = true;
            }

            if ($paths['paths_mismatch'] && $paths['songs_root_exists']) {
                $fixed = fixPaths($pdo, str_replace('/', '\\', $dbRoot), str_replace('/', '\\', $songsRoot));
                $report['folders_updated'] = $fixed['folders_updated'];
                $report['charts_updated'] = $fixed['charts_updated'];
                $dbRoot = $songsRoot; // the .fav comparison below must use the new prefix
            }

            if ($paths['songs_root_exists']) {
                backupCollections($pdo, $dbRoot);
                foreach (favSyncStatus($pdo, $dbRoot, $songsRoot) as $name => $sync) {
                    if ($sync['status'] !== 'diverged') {
                        continue;
                    }
                    try {
                        $report['resynced'][] = ['name' => $name] + resyncFromFav($pdo, $songsRoot, $name);
                    } catch (Throwable $e) {
                        $report['skipped'][] = ['name' => $name, 'reason' => $e->getMessage()];
                    }
                }
            }

            jsonResponse($report);
    }

    jsonError('Unknown action: ' . $action, 404);
}

// Explorer chart filters from the query string: ?levels=17,18&diffs=NOV,INF
function chartFilters(): array
{
    $levels = array_values(array_filter(array_map('intval', explode(',', (string) ($_GET['levels'] ?? '')))));
    $diffs = array_values(array_filter(array_map('trim', explode(',', (string) ($_GET['diffs'] ?? '')))));

    return [$levels, $diffs];
}

function actionInit(): array
{
    $paths = gamePaths();
    $result = [
        'paths'       => $paths,
        'can_browse'  => canBrowseNatively(),
        'stats'       => null,
        'collections'  => [],
        'tree'         => [],
        'restored'     => [],
        'fav_diverged' => [],
        'nautica'      => null,
    ];

    if ($paths['mapsdb_path'] !== null && $paths['songs_root'] !== null) {
        $pdo = openDb($paths['mapsdb_path']);
        $dbRoot = $paths['db_songs_root'] ?? $paths['songs_root'];
        $result['stats'] = dbStats($pdo);
        $result['collections'] = collectionsList($pdo);
        $result['tree'] = folderTree($pdo, $dbRoot);

        // Everything below touches the songs folder: skipped when it is not
        // reachable (wrong game root, unmounted drive) so the database side
        // stays readable and the UI can tell the user what to fix.
        if ($paths['songs_root_exists']) {
            $result['restored'] = startupSync($pdo, $dbRoot, $paths['songs_root'], $paths['mapsdb_path']);
            // Collections whose DB rows no longer match their .fav mirror
            // (typically after the game rebuilt its index): the UI offers a
            // per-collection resync and warns before any write on them.
            foreach (favSyncStatus($pdo, $dbRoot, $paths['songs_root']) as $name => $sync) {
                if ($sync['status'] === 'diverged') {
                    $result['fav_diverged'][] = [
                        'name'     => $name,
                        'only_fav' => $sync['only_fav'],
                        'only_db'  => $sync['only_db'],
                    ];
                }
            }
            $nautica = nauticaSettings();
            if ($nautica['enabled'] && $nautica['dir']) {
                nauticaEnsureMeta($paths['songs_root']);
                nauticaImportLegacy($nautica['dir'], $paths['songs_root']);
            }
            nauticaDailyCheck();
            $result['nautica'] = nauticaPublicState();
        }
    }

    return $result;
}

// Prefix-replace in Folders.path and Charts.path (after moving a songs folder).
// substr-based on purpose: REPLACE() would also hit mid-string occurrences.
function fixPaths(PDO $pdo, string $from, string $to): array
{
    $pdo->beginTransaction();

    $stmt = $pdo->prepare(
        "UPDATE Folders SET path = :to || substr(path, :cut)
         WHERE path LIKE :prefix ESCAPE '!'"
    );
    $params = ['to' => $to, 'cut' => strlen($from) + 1, 'prefix' => escapeLike($from) . '%'];
    $stmt->execute($params);
    $folders = $stmt->rowCount();

    $stmt = $pdo->prepare(
        "UPDATE Charts SET path = :to || substr(path, :cut)
         WHERE path LIKE :prefix ESCAPE '!'"
    );
    $stmt->execute($params);
    $charts = $stmt->rowCount();

    $pdo->commit();

    return ['folders_updated' => $folders, 'charts_updated' => $charts];
}
