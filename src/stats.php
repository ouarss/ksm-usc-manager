<?php
declare(strict_types=1);

// Every play, joined with its chart (one chart per hash — the library holds
// duplicate files that share hashes). Compact keys, the front computes the
// stats client-side so filters are instant: t=timestamp, sc=score, g=gauge,
// lv=level, d=diff, ti=title, ar=artist, ef=effector, fid=folderid.
function scoresOverview(PDO $pdo): array
{
    $sql = "SELECT s.timestamp AS t, s.score AS sc, ROUND(s.gauge * 100, 1) AS g,
                   c.level AS lv, c.diff_shortname AS d, c.title AS ti, c.artist AS ar,
                   c.effector AS ef, c.folderid AS fid
            FROM Scores s
            LEFT JOIN (
                SELECT hash, title, artist, level, diff_shortname, effector, folderid, MIN(rowid)
                FROM Charts GROUP BY hash
            ) c ON c.hash = s.chart_hash
            ORDER BY s.timestamp DESC";

    $plays = [];
    foreach ($pdo->query($sql) as $row) {
        $plays[] = [
            't'   => (int) $row['t'],
            'sc'  => (int) $row['sc'],
            'g'   => (float) $row['g'],
            'lv'  => $row['lv'] === null ? null : (int) $row['lv'],
            'd'   => $row['d'],
            'ti'  => $row['ti'],
            'ar'  => $row['ar'],
            'ef'  => $row['ef'],
            'fid' => $row['fid'] === null ? null : (int) $row['fid'],
        ];
    }

    return $plays;
}

// One row per collection: size, level range, and how many .fav entries
// point to uninstalled charts
function collectionsOverview(PDO $pdo, string $dbRoot, string $songsDir): array
{
    $sync = favSyncStatus($pdo, $dbRoot, $songsDir);
    $rows = [];

    foreach (collectionsList($pdo) as $collection) {
        $name = $collection['name'];
        $ids = collectionFolderIds($pdo, $name);
        $idList = implode(',', array_map('intval', $ids));

        $range = $pdo->query(
            "SELECT COUNT(*) AS charts, MIN(level) AS min_level, MAX(level) AS max_level
             FROM Charts WHERE folderid IN ($idList)"
        )->fetch(PDO::FETCH_ASSOC);

        $status = $sync[$name] ?? ['status' => 'no_fav', 'only_fav' => 0, 'only_db' => 0, 'missing' => 0];

        $rows[] = [
            'name'      => $name,
            'songs'     => $collection['songs'],
            'charts'    => (int) $range['charts'],
            'min_level' => (int) $range['min_level'],
            'max_level' => (int) $range['max_level'],
            'missing'   => $status['missing'],
            'sync'      => $status['status'],
            'only_fav'  => $status['only_fav'],
            'only_db'   => $status['only_db'],
        ];
    }

    return $rows;
}

// All artists with their song/chart counts, biggest first
function artistsOverview(PDO $pdo): array
{
    $rows = [];
    $sql = 'SELECT artist, COUNT(DISTINCT folderid) AS songs, COUNT(*) AS charts
            FROM Charts GROUP BY artist ORDER BY songs DESC, artist COLLATE NOCASE';
    foreach ($pdo->query($sql) as $row) {
        $rows[] = ['artist' => $row['artist'], 'songs' => (int) $row['songs'], 'charts' => (int) $row['charts']];
    }

    return $rows;
}

// All effectors with their song/chart counts, biggest first (Explorer's
// Effectors tab). Light enough to send the full list; the front paginates it.
function effectorsList(PDO $pdo): array
{
    $rows = [];
    $sql = 'SELECT effector, COUNT(*) AS charts, COUNT(DISTINCT folderid) AS songs
            FROM Charts GROUP BY effector ORDER BY charts DESC, effector COLLATE NOCASE';
    foreach ($pdo->query($sql) as $row) {
        $rows[] = ['effector' => $row['effector'], 'charts' => (int) $row['charts'], 'songs' => (int) $row['songs']];
    }

    return $rows;
}
