<?php
declare(strict_types=1);

// Timestamped copy of maps.db into backups/.
// $auto backups are capped at one per day (write actions call this freely).
function backupDb(string $mapsDbPath, bool $auto = false): ?string
{
    if (!is_dir(BACKUP_DIR)) {
        mkdir(BACKUP_DIR, 0777, true);
    }

    if ($auto) {
        $todayMark = BACKUP_DIR . '/maps_' . date('Y-m-d') . '_auto.db';
        if (is_file($todayMark)) {
            return null;
        }
        copy($mapsDbPath, $todayMark);

        return $todayMark;
    }

    $target = BACKUP_DIR . '/maps_' . date('Y-m-d_H-i-s') . '.db';
    copy($mapsDbPath, $target);

    return $target;
}

// Candidate databases that may hold score history: backups next to the game
// and the tool's own backups
function scoreSources(string $gameRoot, string $currentDb): array
{
    $files = [];
    foreach (array_merge(
        glob($gameRoot . '/*maps.db*') ?: [],
        glob(BACKUP_DIR . '/*.db') ?: [],
    ) as $file) {
        $file = normalizePath($file);
        if ($file !== normalizePath($currentDb) && is_file($file)) {
            $files[$file] = true;
        }
    }

    $sources = [];
    foreach (array_keys($files) as $file) {
        $info = ['file' => $file, 'scores' => 0, 'from' => null, 'to' => null, 'compatible' => false, 'note' => null];
        try {
            $db = new PDO('sqlite:' . $file);
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $cols = array_column($db->query('PRAGMA table_info(Scores)')->fetchAll(PDO::FETCH_ASSOC), 'name');
            if (!in_array('chart_hash', $cols, true)) {
                $info['note'] = 'old USC format, scores not hash-keyed';
            } else {
                $info['compatible'] = true;
                $info['scores'] = (int) $db->query('SELECT COUNT(*) FROM Scores')->fetchColumn();
                $range = $db->query('SELECT MIN(timestamp) a, MAX(timestamp) b FROM Scores')->fetch(PDO::FETCH_ASSOC);
                $info['from'] = (int) $range['a'];
                $info['to'] = (int) $range['b'];
            }
        } catch (Throwable) {
            $info['note'] = 'not a readable database';
        }
        $sources[] = $info;
    }
    usort($sources, fn(array $a, array $b) => $b['scores'] <=> $a['scores']);

    return $sources;
}

// Copy score rows missing from the current DB. Same chart_hash + timestamp +
// score = same play (skipped). Orphan scores (chart not installed) are kept:
// they attach automatically if the chart is installed later.
function restoreScores(PDO $target, string $sourceFile): int
{
    $source = new PDO('sqlite:' . $sourceFile);
    $source->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    $sourceCols = array_column($source->query('PRAGMA table_info(Scores)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    if (!in_array('chart_hash', $sourceCols, true)) {
        throw new RuntimeException('This backup uses the old USC format (no chart hashes): its scores cannot be attached');
    }
    $targetCols = array_column($target->query('PRAGMA table_info(Scores)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    $cols = array_values(array_intersect($targetCols, $sourceCols));

    $existing = [];
    foreach ($target->query('SELECT chart_hash, timestamp, score FROM Scores') as $row) {
        $existing[$row['chart_hash'] . '|' . $row['timestamp'] . '|' . $row['score']] = true;
    }

    $insert = $target->prepare(
        'INSERT INTO Scores (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')'
    );
    $added = 0;
    $target->beginTransaction();
    foreach ($source->query('SELECT ' . implode(',', $cols) . ' FROM Scores', PDO::FETCH_ASSOC) as $row) {
        $key = $row['chart_hash'] . '|' . $row['timestamp'] . '|' . $row['score'];
        if (isset($existing[$key])) {
            continue;
        }
        $existing[$key] = true;
        $insert->execute(array_values($row));
        $added++;
    }
    $target->commit();

    return $added;
}

function backupsList(): array
{
    if (!is_dir(BACKUP_DIR)) {
        return [];
    }
    $list = [];
    foreach (glob(BACKUP_DIR . '/maps_*.db') as $file) {
        $list[] = ['file' => basename($file), 'size' => filesize($file), 'date' => filemtime($file)];
    }
    usort($list, fn(array $a, array $b) => $b['date'] <=> $a['date']);

    return $list;
}

// --- Collection backups ---------------------------------------------------
// The DB backup already contains the Collections table, but the user edits
// collections constantly and a .fav lives in the songs folder (deleted with
// its collection). This keeps a daily, portable, hash-based snapshot of every
// collection in backups/collections/ — outside the songs folder, so it
// survives a bad delete and a full library move, and stays re-importable.

function collectionsBackupDir(): string
{
    return BACKUP_DIR . '/collections';
}

// Every collection's songs stored with BOTH the folder path (exact restore on
// the same machine) and chart hashes (portable fallback if the library moved).
function backupCollections(PDO $pdo, string $dbRoot): ?string
{
    $file = collectionsBackupDir() . '/collections_' . date('Y-m-d') . '.json';
    if (is_file($file)) {
        return null; // one snapshot per day, like the DB backup
    }
    if (!is_dir(collectionsBackupDir())) {
        mkdir(collectionsBackupDir(), 0777, true);
    }

    $rootLen = strlen($dbRoot) + 1;
    $collections = [];
    foreach (collectionsList($pdo) as $collection) {
        $ids = collectionFolderIds($pdo, $collection['name']);
        if ($ids === []) {
            continue;
        }
        $idList = implode(',', array_map('intval', $ids));
        $rows = $pdo->query(
            "SELECT c.folderid, c.title, c.artist, c.effector, c.level, c.diff_shortname, c.hash, f.path AS folder_path
             FROM Charts c JOIN Folders f ON f.rowid = c.folderid
             WHERE c.folderid IN ($idList) ORDER BY c.folderid, c.diff_index"
        )->fetchAll();

        $songs = [];
        foreach ($rows as $row) {
            $id = (int) $row['folderid'];
            if (!isset($songs[$id])) {
                $songs[$id] = [
                    'title'    => $row['title'],
                    'artist'   => $row['artist'],
                    'effector' => $row['effector'],
                    'folder'   => substr(str_replace('\\', '/', $row['folder_path']), $rootLen),
                    'charts'   => [],
                ];
            }
            $songs[$id]['charts'][] = ['hash' => $row['hash'], 'diff' => $row['diff_shortname'], 'level' => (int) $row['level']];
        }
        $collections[] = ['name' => $collection['name'], 'song_count' => count($songs), 'songs' => array_values($songs)];
    }

    file_put_contents($file, json_encode([
        'format'      => 'usc-collections-backup',
        'version'     => 1,
        'exported_at' => date('c'),
        'collections' => $collections,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));

    return $file;
}

function collectionsBackupsList(): array
{
    if (!is_dir(collectionsBackupDir())) {
        return [];
    }
    $list = [];
    foreach (glob(collectionsBackupDir() . '/collections_*.json') as $file) {
        $data = json_decode((string) file_get_contents($file), true);
        $list[] = [
            'file'  => basename($file),
            'date'  => filemtime($file),
            'count' => is_array($data) ? count($data['collections'] ?? []) : 0,
        ];
    }
    usort($list, fn(array $a, array $b) => $b['date'] <=> $a['date']);

    return $list;
}

// Re-import every collection from a backup bundle. Additive (INSERT OR IGNORE
// via importApply): re-creates deleted collections and re-adds removed songs,
// never drops songs added since. Each song is resolved by its folder path
// first (exact on the same machine — avoids duplicate-pack charts that share a
// hash), then by chart hash. A full DB backup is taken first.
function restoreCollections(PDO $pdo, string $dbRoot, string $songsDir, string $mapsDbPath, string $file): array
{
    $path = collectionsBackupDir() . '/' . basename($file);
    $data = json_decode((string) @file_get_contents($path), true);
    if (!is_array($data) || ($data['format'] ?? '') !== 'usc-collections-backup') {
        throw new RuntimeException('Not a collections backup file');
    }

    backupDb($mapsDbPath); // full backup before restoring
    $restored = [];
    foreach ($data['collections'] ?? [] as $collection) {
        $name = (string) ($collection['name'] ?? '');
        $songs = $collection['songs'] ?? [];
        if ($name === '' || $songs === []) {
            continue;
        }
        $hashMap = hashLookup($pdo, collectHashes($songs));

        $folderIds = [];
        $seen = [];
        foreach ($songs as $song) {
            $folderId = null;
            if (!empty($song['folder'])) {
                $folderId = folderIdByPathSuffix($pdo, str_replace('/', '\\', (string) $song['folder']));
            }
            if ($folderId === null) {
                foreach ($song['charts'] ?? [] as $chart) {
                    if (isset($hashMap[$chart['hash'] ?? ''])) {
                        $folderId = $hashMap[$chart['hash']];
                        break;
                    }
                }
            }
            if ($folderId !== null && !isset($seen[$folderId])) {
                $seen[$folderId] = true;
                $folderIds[] = $folderId;
            }
        }
        if ($folderIds === []) {
            continue;
        }
        $added = importApply($pdo, $name, $folderIds);
        writeFav($pdo, $dbRoot, $songsDir, $name);
        $restored[] = ['name' => $name, 'added' => $added];
    }

    return $restored;
}
