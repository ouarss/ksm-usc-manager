<?php
declare(strict_types=1);

// Nested tree of the directories between the songs root and the song folders
// themselves (song folders are leaves, browsed as songs, not tree nodes).
// Node: ['name' => ..., 'rel' => 'SDVX IV', 'songs' => 12, 'children' => [...]]
function folderTree(PDO $pdo, string $songsRoot): array
{
    $rootLen = strlen($songsRoot) + 1;
    $tree = ['children' => [], 'songs' => 0];

    foreach ($pdo->query('SELECT rowid, path FROM Folders ORDER BY path') as $row) {
        $rel = str_replace('\\', '/', $row['path']);
        if (strlen($rel) <= $rootLen) {
            continue;
        }
        $rel = substr($rel, $rootLen);
        $parts = explode('/', $rel);
        array_pop($parts); // the song folder itself

        $node = &$tree;
        $node['songs']++;
        $relSoFar = '';
        foreach ($parts as $part) {
            $relSoFar = ($relSoFar === '') ? $part : $relSoFar . '/' . $part;
            if (!isset($node['children'][$part])) {
                $node['children'][$part] = ['name' => $part, 'rel' => $relSoFar, 'songs' => 0, 'children' => []];
            }
            $node = &$node['children'][$part];
            $node['songs']++;
        }
        unset($node);
    }

    return treeToList($tree['children']);
}

function treeToList(array $children): array
{
    $list = [];
    foreach ($children as $child) {
        $child['children'] = treeToList($child['children']);
        $list[] = $child;
    }
    usort($list, fn(array $a, array $b) => strnatcasecmp($a['name'], $b['name']));

    return $list;
}

// Charts grouped by song (folderid), with per-chart score aggregates.
// $where filters the Charts/Folders join. Media paths are returned relative to
// the songs root so the front can build media.php URLs.
function songList(PDO $pdo, string $songsRoot, string $where, array $params): array
{
    $sql = "SELECT c.folderid, c.title, c.artist, c.effector, c.bpm, c.level,
                   c.diff_index, c.diff_name, c.diff_shortname, c.hash,
                   c.jacket_path, c.preview_file, c.preview_offset, c.preview_length,
                   f.path AS folder_path
            FROM Charts c
            JOIN Folders f ON f.rowid = c.folderid
            $where
            ORDER BY c.folderid, c.diff_index";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $scoreAgg = scoreAggregates($pdo);
    $rootLen = strlen($songsRoot) + 1;
    $songs = [];

    // Row-by-row on purpose: the full library is ~14k charts and fetchAll
    // doubles the peak memory for nothing
    while ($chart = $stmt->fetch()) {
        $id = (int) $chart['folderid'];
        $folderRel = substr(str_replace('\\', '/', $chart['folder_path']), $rootLen);

        if (!isset($songs[$id])) {
            $songs[$id] = [
                'folderid'       => $id,
                'title'          => $chart['title'],
                'artist'         => $chart['artist'],
                'effector'       => $chart['effector'],
                'bpm'            => $chart['bpm'],
                'folder'         => $folderRel,
                'jacket'         => null,
                'preview'        => null,
                'preview_offset' => 0,
                'preview_length' => 0,
                'charts'         => [],
            ];
        }

        // Some charts carry an empty title/artist — keep the first non-empty
        // one the song's charts provide
        if (trim((string) $songs[$id]['title']) === '' && trim((string) $chart['title']) !== '') {
            $songs[$id]['title'] = $chart['title'];
        }
        if (trim((string) $songs[$id]['artist']) === '' && trim((string) $chart['artist']) !== '') {
            $songs[$id]['artist'] = $chart['artist'];
        }

        if ($songs[$id]['jacket'] === null && $chart['jacket_path'] !== '' && $chart['jacket_path'] !== null) {
            $songs[$id]['jacket'] = $folderRel . '/' . str_replace('\\', '/', $chart['jacket_path']);
        }
        if ($songs[$id]['preview'] === null && $chart['preview_file'] !== '' && $chart['preview_file'] !== null) {
            $songs[$id]['preview'] = $folderRel . '/' . str_replace('\\', '/', $chart['preview_file']);
            $songs[$id]['preview_offset'] = (int) $chart['preview_offset'];
            $songs[$id]['preview_length'] = (int) $chart['preview_length'];
        }

        $agg = $scoreAgg[$chart['hash']] ?? null;
        $songs[$id]['charts'][] = [
            'hash'  => $chart['hash'],
            'diff'  => $chart['diff_shortname'],
            'name'  => $chart['diff_name'],
            'level' => (int) $chart['level'],
            'plays' => $agg['plays'] ?? 0,
            'best'  => $agg['best'] ?? null,
        ];
    }

    return array_values($songs);
}

// One pass over Scores: hash => [plays, best]
function scoreAggregates(PDO $pdo): array
{
    $agg = [];
    foreach ($pdo->query('SELECT chart_hash, COUNT(*) AS plays, MAX(score) AS best FROM Scores GROUP BY chart_hash') as $row) {
        $agg[$row['chart_hash']] = ['plays' => (int) $row['plays'], 'best' => (int) $row['best']];
    }

    return $agg;
}

function songsInFolder(PDO $pdo, string $songsRoot, string $folderRel): array
{
    if ($folderRel === '') {
        return songList($pdo, $songsRoot, '', []);
    }
    $prefix = str_replace('/', '\\', $songsRoot . '/' . $folderRel);

    return songList(
        $pdo,
        $songsRoot,
        "WHERE f.path LIKE :prefix ESCAPE '!'",
        ['prefix' => escapeLike($prefix) . '\\%']
    );
}

function songsByFolderIds(PDO $pdo, string $songsRoot, array $folderIds): array
{
    if ($folderIds === []) {
        return [];
    }
    $ids = implode(',', array_map('intval', $folderIds));

    return songList($pdo, $songsRoot, "WHERE c.folderid IN ($ids)", []);
}

// Full score history of one song, keyed by chart hash
function songScores(PDO $pdo, int $folderId): array
{
    $stmt = $pdo->prepare(
        'SELECT s.chart_hash, s.score, s.crit, s.near, s.miss, s.early, s.late, s.combo,
                s.gauge, s.timestamp, s.user_name
         FROM Scores s
         JOIN Charts c ON c.hash = s.chart_hash
         WHERE c.folderid = :id
         ORDER BY s.score DESC'
    );
    $stmt->execute(['id' => $folderId]);

    $byChart = [];
    foreach ($stmt->fetchAll() as $row) {
        $byChart[$row['chart_hash']][] = [
            'score'     => (int) $row['score'],
            'crit'      => (int) $row['crit'],
            'near'      => (int) $row['near'],
            'miss'      => (int) $row['miss'],
            'early'     => (int) $row['early'],
            'late'      => (int) $row['late'],
            'combo'     => (int) $row['combo'],
            'gauge'     => round((float) $row['gauge'] * 100, 2),
            'timestamp' => (int) $row['timestamp'],
            'user_name' => $row['user_name'],
        ];
    }

    return $byChart;
}
