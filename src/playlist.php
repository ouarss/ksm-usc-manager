<?php
declare(strict_types=1);

// Portable collection format: machine-independent, keyed on chart hashes.
// A "song" is a set of chart hashes (its difficulties) plus display metadata
// used as a human-readable fallback when a chart is missing on the target.
const PLAYLIST_FORMAT = 'usc-collection';
const PLAYLIST_LEGACY_FORMATS = ['usc-collection', 'usc-playlist'];
const PLAYLIST_VERSION = 1;

function exportPlaylist(PDO $pdo, string $name): array
{
    $folderIds = collectionFolderIds($pdo, $name);
    if ($folderIds === []) {
        throw new RuntimeException('Empty or unknown collection: ' . $name);
    }

    $ids = implode(',', array_map('intval', $folderIds));
    $rows = $pdo->query(
        "SELECT folderid, title, artist, effector, level, diff_shortname, hash
         FROM Charts WHERE folderid IN ($ids) ORDER BY folderid, diff_index"
    )->fetchAll();

    $songs = [];
    foreach ($rows as $row) {
        $id = (int) $row['folderid'];
        if (!isset($songs[$id])) {
            $songs[$id] = [
                'title'    => $row['title'],
                'artist'   => $row['artist'],
                'effector' => $row['effector'],
                'charts'   => [],
            ];
        }
        $songs[$id]['charts'][] = [
            'hash'  => $row['hash'],
            'diff'  => $row['diff_shortname'],
            'level' => (int) $row['level'],
        ];
    }

    return [
        'format'      => PLAYLIST_FORMAT,
        'version'     => PLAYLIST_VERSION,
        'name'        => $name,
        'exported_at' => date('c'),
        'song_count'  => count($songs),
        'songs'       => array_values($songs),
    ];
}

// Accepts our .json playlists and legacy KShootMania .fav files
// (one song-folder path per line, relative to the songs folder).
function parsePlaylistFile(string $content, string $filename): array
{
    $isJson = str_ends_with(strtolower($filename), '.json')
        || str_starts_with(ltrim($content), '{');

    if ($isJson) {
        $data = json_decode($content, true);
        if (!is_array($data) || !in_array($data['format'] ?? '', PLAYLIST_LEGACY_FORMATS, true) || !is_array($data['songs'] ?? null)) {
            throw new RuntimeException('Unrecognized file: expected a USC collection (.json) or a .fav file');
        }

        return [
            'name'  => (string) ($data['name'] ?? ''),
            'songs' => $data['songs'],
        ];
    }

    // .fav: plain text lines like "SDVX 2nd Booth\dreamin_moimoi"
    $songs = [];
    foreach (preg_split('/\r\n|\r|\n/', $content) as $line) {
        $line = trim($line);
        if ($line !== '') {
            $songs[] = ['path_hint' => str_replace('/', '\\', $line)];
        }
    }
    if ($songs === []) {
        throw new RuntimeException('Empty file');
    }

    return [
        'name'  => preg_replace('/\.fav$/i', '', basename($filename)),
        'songs' => $songs,
    ];
}

// Match parsed songs against the local database.
// Order of confidence: chart hash, then folder path suffix (.fav),
// then title+artist metadata (flagged so the user can see it is fuzzy).
function matchPlaylist(PDO $pdo, array $parsed): array
{
    $songs = $parsed['songs'];

    $hashToFolder = hashLookup($pdo, collectHashes($songs));

    $matched = [];
    $missing = [];
    $seenFolderIds = [];

    foreach ($songs as $song) {
        $folderId = null;
        $via = null;

        foreach ($song['charts'] ?? [] as $chart) {
            if (isset($hashToFolder[$chart['hash'] ?? ''])) {
                $folderId = $hashToFolder[$chart['hash']];
                $via = 'hash';
                break;
            }
        }

        if ($folderId === null && !empty($song['path_hint'])) {
            $folderId = folderIdByPathSuffix($pdo, $song['path_hint']);
            $via = 'path';
            if ($folderId === null) {
                // Pack folders get renamed over the years: retry on the song
                // folder name alone, the stable part of the path
                $basename = basename(str_replace('\\', '/', $song['path_hint']));
                $folderId = folderIdByPathSuffix($pdo, $basename);
                $via = 'folder';
            }
        }

        if ($folderId === null && !empty($song['title'])) {
            $folderId = folderIdByMetadata($pdo, (string) $song['title'], (string) ($song['artist'] ?? ''));
            $via = 'metadata';
        }

        $label = [
            'title'  => $song['title'] ?? ($song['path_hint'] ?? '?'),
            'artist' => $song['artist'] ?? '',
            'levels' => array_map(fn(array $c) => $c['level'] ?? 0, $song['charts'] ?? []),
        ];

        if ($folderId === null) {
            $missing[] = $label;
        } elseif (!isset($seenFolderIds[$folderId])) {
            $seenFolderIds[$folderId] = true;
            $matched[] = $label + ['folderid' => $folderId, 'via' => $via];
        }
    }

    return [
        'name'    => $parsed['name'],
        'matched' => $matched,
        'missing' => $missing,
    ];
}

function collectHashes(array $songs): array
{
    $hashes = [];
    foreach ($songs as $song) {
        foreach ($song['charts'] ?? [] as $chart) {
            if (!empty($chart['hash'])) {
                $hashes[] = (string) $chart['hash'];
            }
        }
    }

    return $hashes;
}

function hashLookup(PDO $pdo, array $hashes): array
{
    $map = [];
    foreach (array_chunk($hashes, 500) as $chunk) {
        $placeholders = implode(',', array_fill(0, count($chunk), '?'));
        $stmt = $pdo->prepare("SELECT hash, folderid FROM Charts WHERE hash IN ($placeholders)");
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll() as $row) {
            $map[$row['hash']] = (int) $row['folderid'];
        }
    }

    return $map;
}

function folderIdByPathSuffix(PDO $pdo, string $pathHint): ?int
{
    $stmt = $pdo->prepare("SELECT rowid FROM Folders WHERE path LIKE :suffix ESCAPE '!' LIMIT 1");
    $stmt->execute(['suffix' => '%\\' . escapeLike($pathHint)]);
    $id = $stmt->fetchColumn();

    return $id === false ? null : (int) $id;
}

function folderIdByMetadata(PDO $pdo, string $title, string $artist): ?int
{
    $stmt = $pdo->prepare(
        'SELECT folderid FROM Charts
         WHERE title = :title COLLATE NOCASE AND artist = :artist COLLATE NOCASE
         LIMIT 1'
    );
    $stmt->execute(['title' => $title, 'artist' => $artist]);
    $id = $stmt->fetchColumn();

    return $id === false ? null : (int) $id;
}

// ---------------------------------------------------------------------------
// .fav synchronization — one collection = one .fav file in the songs folder.
// The DB is what the game reads; the .fav files are the durable mirror that
// survives maps.db rebuilds. Every collection write re-generates its .fav;
// at startup, .fav files without a matching collection are imported back.
// ---------------------------------------------------------------------------

function favFiles(string $songsRoot): array
{
    $files = glob($songsRoot . '/*.fav');

    return $files === false ? [] : array_map('basename', $files);
}

// Collection names become file names: reject characters Windows forbids
function validateCollectionName(string $name): void
{
    if (preg_match('#[\\\\/:*?"<>|]#', $name)) {
        throw new RuntimeException('Collection names cannot contain \\ / : * ? " < > | — they are also .fav file names');
    }
    if (mb_strlen($name) > 100) {
        throw new RuntimeException('Collection name too long (100 characters max)');
    }
}

// Legacy collections may still carry illegal characters: sanitize for disk
function favFilenameFor(string $name): string
{
    return preg_replace('#[\\\\/:*?"<>|]#', '_', trim($name));
}

function favPath(string $songsDir, string $name): string
{
    return $songsDir . '/' . favFilenameFor($name) . '.fav';
}

// The manifest (data/fav-manifest.json) records which .fav files this tool
// manages: filename stem => collection name. Only manifested files are
// re-imported at startup — historical/foreign .fav files are left alone
// (they can still be imported explicitly through "Import Collection").
function loadFavManifest(): array
{
    $file = DATA_DIR . '/fav-manifest.json';
    if (!is_file($file)) {
        return [];
    }
    $data = json_decode((string) file_get_contents($file), true);

    return is_array($data) ? $data : [];
}

function saveFavManifest(array $manifest): void
{
    if (!is_dir(DATA_DIR)) {
        mkdir(DATA_DIR, 0777, true);
    }
    file_put_contents(DATA_DIR . '/fav-manifest.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// Lowercased lookup sets of every song folder in the DB, relative to the
// DB's own prefix: full relative paths and folder basenames.
function dbFolderSets(PDO $pdo, string $dbRoot): array
{
    $prefix = str_replace('/', '\\', $dbRoot) . '\\';
    $paths = [];
    $bases = [];
    foreach ($pdo->query('SELECT path FROM Folders') as $row) {
        $rel = str_starts_with($row['path'], $prefix) ? substr($row['path'], strlen($prefix)) : $row['path'];
        $rel = mb_strtolower($rel);
        $paths[$rel] = true;
        $parts = explode('\\', $rel);
        $bases[end($parts)] = true;
    }

    return [$paths, $bases];
}

// Does a .fav line point to a folder currently in the library?
// (full relative path first, folder name alone as fallback — packs get renamed)
function favLineResolves(string $line, array $paths, array $bases): bool
{
    $rel = mb_strtolower(str_replace('/', '\\', trim($line)));
    if (isset($paths[$rel])) {
        return true;
    }
    $parts = explode('\\', $rel);

    return isset($bases[end($parts)]);
}

// Lowercased lookup maps of every song folder in the DB, relative to the DB's
// own prefix: folderid => relative path, plus the reverse maps used to resolve
// .fav lines (full relative path first, folder basename as fallback).
function dbFolderMaps(PDO $pdo, string $dbRoot): array
{
    $prefix = str_replace('/', '\\', $dbRoot) . '\\';
    $idToRel = [];
    $pathToId = [];
    $baseToId = [];
    foreach ($pdo->query('SELECT rowid, path FROM Folders') as $row) {
        $rel = str_starts_with($row['path'], $prefix) ? substr($row['path'], strlen($prefix)) : $row['path'];
        $rel = mb_strtolower($rel);
        $id = (int) $row['rowid'];
        $idToRel[$id] = $rel;
        $pathToId[$rel] = $id;
        $parts = explode('\\', $rel);
        $baseToId[end($parts)] = $id;
    }

    return [$idToRel, $pathToId, $baseToId];
}

// Compare every collection against its .fav mirror. The two normally agree
// (each write regenerates the file); they diverge when the game rebuilds its
// index and recycles folderids — Collections then points at the wrong songs
// while the .fav still names the right folders — or when a .fav was edited
// outside the tool. A line resolving to no installed folder is not a
// divergence, just a "missing" chart (the collection's memory, see writeFav).
// Returns per collection: status in_sync|diverged|no_fav, only_fav (installed
// songs the mirror has and the DB rows lack), only_db (the reverse), missing.
function favSyncStatus(PDO $pdo, string $dbRoot, string $songsDir): array
{
    [$idToRel, $pathToId, $baseToId] = dbFolderMaps($pdo, $dbRoot);
    $result = [];

    foreach (collectionsList($pdo) as $collection) {
        $name = $collection['name'];
        $file = favPath($songsDir, $name);
        if (!is_file($file)) {
            $result[$name] = ['status' => 'no_fav', 'only_fav' => 0, 'only_db' => 0, 'missing' => 0];
            continue;
        }

        // Dead folderids (their Folders row was deleted by the game) have no
        // path to compare: ignored here, exactly like writeFav ignores them.
        $dbIds = [];
        foreach (collectionFolderIds($pdo, $name) as $id) {
            if (isset($idToRel[$id])) {
                $dbIds[$id] = true;
            }
        }

        $matched = [];
        $onlyFav = [];
        $missing = 0;
        foreach (preg_split('/\r\n|\r|\n/', (string) file_get_contents($file)) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $rel = mb_strtolower(str_replace('/', '\\', $line));
            $parts = explode('\\', $rel);
            $id = $pathToId[$rel] ?? $baseToId[end($parts)] ?? null;
            if ($id === null) {
                $missing++;
            } elseif (isset($dbIds[$id])) {
                $matched[$id] = true;
            } else {
                $onlyFav[$id] = true;
            }
        }
        $onlyDb = count($dbIds) - count($matched);

        $result[$name] = [
            'status'   => ($onlyFav !== [] || $onlyDb > 0) ? 'diverged' : 'in_sync',
            'only_fav' => count($onlyFav),
            'only_db'  => $onlyDb,
            'missing'  => $missing,
        ];
    }

    return $result;
}

// Rebuild a collection from its .fav mirror (same matching as an import:
// path suffix first, folder basename as fallback). The file itself is left
// untouched — it is the source here, and its unresolved lines must survive
// for when the missing charts get installed.
function resyncFromFav(PDO $pdo, string $songsDir, string $name): array
{
    $file = favPath($songsDir, $name);
    if (!is_file($file)) {
        throw new RuntimeException('No .fav mirror for collection: ' . $name);
    }

    $parsed = parsePlaylistFile((string) file_get_contents($file), basename($file));
    $match = matchPlaylist($pdo, $parsed);
    if ($match['matched'] === []) {
        throw new RuntimeException('No line of ' . basename($file) . ' matches an installed song — collection left untouched');
    }

    replaceCollection($pdo, $name, array_column($match['matched'], 'folderid'));

    return ['matched' => count($match['matched']), 'missing' => count($match['missing'])];
}

// .fav lines of a collection that resolve to no installed folder: shown
// greyed in the UI, and preserved when the mirror file is regenerated.
function favMissingEntries(PDO $pdo, string $dbRoot, string $songsDir, string $name): array
{
    $file = favPath($songsDir, $name);
    if (!is_file($file)) {
        return [];
    }

    [$paths, $bases] = dbFolderSets($pdo, $dbRoot);
    $missing = [];
    foreach (preg_split('/\r\n|\r|\n/', (string) file_get_contents($file)) as $line) {
        $line = trim($line);
        if ($line === '' || favLineResolves($line, $paths, $bases)) {
            continue;
        }
        $parts = explode('\\', str_replace('/', '\\', $line));
        $missing[] = ['path' => $line, 'name' => array_pop($parts), 'parent' => implode('\\', $parts)];
    }

    return $missing;
}

// Regenerate <name>.fav from the DB. Lines are song folder paths relative to
// the songs folder (CRLF, like KShootMania wrote them) — stripped against the
// DB's own prefix ($dbRoot) but written into the real songs folder ($songsDir),
// so the mirror stays correct even while the DB carries stale path prefixes.
// Lines pointing to uninstalled folders are carried over, never lost.
function writeFav(PDO $pdo, string $dbRoot, string $songsDir, string $name): void
{
    if (!is_dir($songsDir)) {
        throw new RuntimeException('Songs folder not found, cannot write the .fav mirror: ' . $songsDir);
    }

    $ids = collectionFolderIds($pdo, $name);
    $file = favPath($songsDir, $name);

    $prefix = str_replace('/', '\\', $dbRoot) . '\\';
    $lines = [];
    if ($ids !== []) {
        $stmt = $pdo->query('SELECT path FROM Folders WHERE rowid IN (' . implode(',', array_map('intval', $ids)) . ') ORDER BY path');
        foreach ($stmt as $row) {
            $path = $row['path'];
            $lines[] = str_starts_with($path, $prefix) ? substr($path, strlen($prefix)) : $path;
        }
    }

    // Keep lines whose songs are not installed (anymore): they are the
    // collection's memory, waiting for the charts to come back
    if (is_file($file)) {
        [$paths, $bases] = dbFolderSets($pdo, $dbRoot);
        foreach (preg_split('/\r\n|\r|\n/', (string) file_get_contents($file)) as $line) {
            $line = trim($line);
            if ($line !== '' && !favLineResolves($line, $paths, $bases) && !in_array($line, $lines, true)) {
                $lines[] = $line;
            }
        }
    }

    if ($lines === []) {
        deleteFav($songsDir, $name);

        return;
    }

    file_put_contents($file, implode("\r\n", $lines) . "\r\n");

    $manifest = loadFavManifest();
    $manifest[favFilenameFor($name)] = $name;
    saveFavManifest($manifest);
}

function deleteFav(string $songsDir, string $name): void
{
    $file = favPath($songsDir, $name);
    if (is_file($file)) {
        unlink($file);
    }
    $manifest = loadFavManifest();
    unset($manifest[favFilenameFor($name)]);
    saveFavManifest($manifest);
}

function renameFav(PDO $pdo, string $dbRoot, string $songsDir, string $oldName, string $newName): void
{
    deleteFav($songsDir, $oldName);
    writeFav($pdo, $dbRoot, $songsDir, $newName);
}

// Startup reconciliation:
//  - manifested .fav without its collection -> re-import it (this is how
//    collections survive a maps.db rebuild); foreign .fav files are ignored
//  - collection without a .fav -> write the file (and manifest it)
// Existing .fav files are never overwritten here, so lines pointing to
// uninstalled charts are preserved until the user edits that collection.
function startupSync(PDO $pdo, string $dbRoot, string $songsDir, string $mapsDbPath): array
{
    $collections = array_column(collectionsList($pdo), 'name');
    $manifest = loadFavManifest();
    $restored = [];

    foreach (favFiles($songsDir) as $file) {
        $stem = preg_replace('/\.fav$/i', '', $file);
        $name = $manifest[$stem] ?? null;
        if ($name === null || in_array($name, $collections, true)) {
            continue;
        }
        $parsed = parsePlaylistFile((string) file_get_contents($songsDir . '/' . $file), $file);
        $match = matchPlaylist($pdo, $parsed);
        if ($match['matched'] === []) {
            continue;
        }
        backupDb($mapsDbPath, auto: true);
        importApply($pdo, $name, array_column($match['matched'], 'folderid'));
        $collections[] = $name;
        $restored[] = ['name' => $name, 'songs' => count($match['matched']), 'missing' => count($match['missing'])];
    }

    foreach ($collections as $name) {
        if (!is_file(favPath($songsDir, $name))) {
            writeFav($pdo, $dbRoot, $songsDir, $name);
        } elseif (!isset($manifest[favFilenameFor($name)])) {
            // File already there (legacy or pre-manifest): adopt it without
            // overwriting, so a future rebuild can restore this collection
            $manifest[favFilenameFor($name)] = $name;
            saveFavManifest($manifest);
        }
    }

    return $restored;
}

// Insert matched songs into the target collection. Returns songs added
// (already-present songs are ignored, not duplicated).
function importApply(PDO $pdo, string $name, array $folderIds): int
{
    $pdo->beginTransaction();
    $stmt = $pdo->prepare('INSERT OR IGNORE INTO Collections (collection, folderid) VALUES (:name, :id)');
    $added = 0;
    foreach ($folderIds as $folderId) {
        $stmt->execute(['name' => $name, 'id' => (int) $folderId]);
        $added += $stmt->rowCount();
    }
    $pdo->commit();

    return $added;
}
