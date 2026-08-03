<?php
declare(strict_types=1);

// Server-side paginated browse for the Explorer page's Songs and Charts tabs.
// The library is ~14k charts, so these two views page on the server. The
// Artists and Effectors tabs use full lists (artistsOverview/effectorsList),
// light enough to send at once and paginate client-side.

// WHERE clause + params on the Charts table (alias c) from the page filters.
// q is a broad match (title/artist/effector/translit). $withLevels lets the
// level chart ignore the level filter so every bar keeps showing.
// pdo_sqlite won't bind one named placeholder twice, hence the per-column
// suffixes (:xq0..:xq3).
function exploreWhere(array $levels, array $diffs, string $q, bool $withLevels = true): array
{
    $where = [];
    $params = [];

    if ($withLevels && $levels !== []) {
        $where[] = 'c.level IN (' . implode(',', array_map('intval', $levels)) . ')';
    }
    if ($diffs !== []) {
        $placeholders = [];
        foreach (array_values($diffs) as $i => $diff) {
            $placeholders[] = ":xd$i";
            $params["xd$i"] = $diff;
        }
        $where[] = 'c.diff_shortname IN (' . implode(',', $placeholders) . ')';
    }
    if ($q !== '') {
        $like = '%' . escapeLike($q) . '%';
        $or = [];
        foreach (['title', 'artist', 'effector', 'title_translit'] as $i => $col) {
            $or[] = "c.$col LIKE :xq$i ESCAPE '!'";
            $params["xq$i"] = $like;
        }
        $where[] = '(' . implode(' OR ', $or) . ')';
    }

    return [$where === [] ? '' : 'WHERE ' . implode(' AND ', $where), $params];
}

// Charts-by-level distribution honoring q + diffs but NOT the level filter,
// so every bar shows and stays clickable to focus a level. level => count.
function exploreLevels(PDO $pdo, string $q, array $diffs): array
{
    [$where, $params] = exploreWhere([], $diffs, $q, false);
    $stmt = $pdo->prepare("SELECT c.level AS lv, COUNT(*) AS n FROM Charts c $where GROUP BY c.level");
    $stmt->execute($params);

    $levels = [];
    foreach ($stmt as $row) {
        $levels[(int) $row['lv']] = (int) $row['n'];
    }

    return $levels;
}

// One page of the Songs tab: distinct song folders matching the filters, then
// their full chart lists via songsByFolderIds so rows carry previews, jackets
// and score aggregates. Returns ['items' => [...], 'total' => int].
function exploreSongs(PDO $pdo, string $dbRoot, string $q, array $levels, array $diffs, string $sort, int $page, int $per): array
{
    [$where, $params] = exploreWhere($levels, $diffs, $q);

    $count = $pdo->prepare("SELECT COUNT(DISTINCT c.folderid) FROM Charts c $where");
    $count->execute($params);
    $total = (int) $count->fetchColumn();

    $order = match ($sort) {
        'artist' => 'MIN(c.artist) COLLATE NOCASE, MIN(c.title) COLLATE NOCASE',
        'level'  => 'MAX(c.level) DESC, MIN(c.title) COLLATE NOCASE',
        default  => 'MIN(c.title) COLLATE NOCASE',
    };
    $stmt = $pdo->prepare(
        "SELECT c.folderid FROM Charts c $where GROUP BY c.folderid ORDER BY $order LIMIT :per OFFSET :off"
    );
    foreach ($params as $key => $value) {
        $stmt->bindValue(':' . $key, $value);
    }
    $stmt->bindValue(':per', $per, PDO::PARAM_INT);
    $stmt->bindValue(':off', ($page - 1) * $per, PDO::PARAM_INT);
    $stmt->execute();
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    // songsByFolderIds returns songs by ascending folderid; restore page order
    $byId = [];
    foreach (songsByFolderIds($pdo, $dbRoot, $ids) as $song) {
        $byId[$song['folderid']] = $song;
    }
    $items = [];
    foreach ($ids as $id) {
        if (isset($byId[$id])) {
            $items[] = $byId[$id];
        }
    }

    // song_total == total here (a "song" is a distinct folderid); kept for a
    // uniform shape with the Charts scope, where they differ.
    return ['items' => $items, 'total' => $total, 'song_total' => $total];
}

// Distinct song folders matching the filters — the id list behind the
// Explorer's "select all across pages".
function exploreFolderIds(PDO $pdo, string $q, array $levels, array $diffs): array
{
    [$where, $params] = exploreWhere($levels, $diffs, $q);
    $stmt = $pdo->prepare("SELECT DISTINCT c.folderid FROM Charts c $where");
    $stmt->execute($params);

    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

// One page of the Charts tab: one row per chart, shaped like a single-chart
// song so the front reuses its song row (previews, collect, score dot).
function exploreCharts(PDO $pdo, string $dbRoot, string $q, array $levels, array $diffs, string $sort, int $page, int $per): array
{
    [$where, $params] = exploreWhere($levels, $diffs, $q);

    $count = $pdo->prepare("SELECT COUNT(*) AS charts, COUNT(DISTINCT c.folderid) AS songs FROM Charts c $where");
    $count->execute($params);
    $totals = $count->fetch(PDO::FETCH_ASSOC);
    $total = (int) $totals['charts'];
    $songTotal = (int) $totals['songs'];

    $order = match ($sort) {
        'artist' => 'c.artist COLLATE NOCASE, c.title COLLATE NOCASE',
        'level'  => 'c.level DESC, c.title COLLATE NOCASE',
        default  => 'c.title COLLATE NOCASE',
    };
    // A few charts carry an empty title/artist while their song folder has
    // proper ones on its other charts — fall back to a sibling's value.
    $stmt = $pdo->prepare(
        "SELECT c.folderid,
                CASE WHEN TRIM(c.title) = '' THEN COALESCE((SELECT s.title FROM Charts s WHERE s.folderid = c.folderid AND TRIM(s.title) <> '' ORDER BY s.diff_index LIMIT 1), c.title) ELSE c.title END AS title,
                CASE WHEN TRIM(c.artist) = '' THEN COALESCE((SELECT s.artist FROM Charts s WHERE s.folderid = c.folderid AND TRIM(s.artist) <> '' ORDER BY s.diff_index LIMIT 1), c.artist) ELSE c.artist END AS artist,
                c.effector, c.bpm, c.level,
                c.diff_index, c.diff_name, c.diff_shortname, c.hash,
                c.jacket_path, c.preview_file, c.preview_offset, c.preview_length,
                f.path AS folder_path
         FROM Charts c JOIN Folders f ON f.rowid = c.folderid
         $where
         ORDER BY $order, c.folderid, c.diff_index
         LIMIT :per OFFSET :off"
    );
    foreach ($params as $key => $value) {
        $stmt->bindValue(':' . $key, $value);
    }
    $stmt->bindValue(':per', $per, PDO::PARAM_INT);
    $stmt->bindValue(':off', ($page - 1) * $per, PDO::PARAM_INT);
    $stmt->execute();

    $scoreAgg = scoreAggregates($pdo);
    $rootLen = strlen($dbRoot) + 1;
    $items = [];
    while ($chart = $stmt->fetch()) {
        $folderRel = substr(str_replace('\\', '/', $chart['folder_path']), $rootLen);
        $agg = $scoreAgg[$chart['hash']] ?? null;
        $hasJacket = ($chart['jacket_path'] ?? '') !== '';
        $hasPreview = ($chart['preview_file'] ?? '') !== '';
        $items[] = [
            'folderid'       => (int) $chart['folderid'],
            'title'          => $chart['title'],
            'artist'         => $chart['artist'],
            'effector'       => $chart['effector'],
            'bpm'            => $chart['bpm'],
            'folder'         => $folderRel,
            'jacket'         => $hasJacket ? $folderRel . '/' . str_replace('\\', '/', $chart['jacket_path']) : null,
            'preview'        => $hasPreview ? $folderRel . '/' . str_replace('\\', '/', $chart['preview_file']) : null,
            'preview_offset' => (int) $chart['preview_offset'],
            'preview_length' => (int) $chart['preview_length'],
            'charts'         => [[
                'hash'  => $chart['hash'],
                'diff'  => $chart['diff_shortname'],
                'name'  => $chart['diff_name'],
                'level' => (int) $chart['level'],
                'plays' => $agg['plays'] ?? 0,
                'best'  => $agg['best'] ?? null,
            ]],
        ];
    }

    return ['items' => $items, 'total' => $total, 'song_total' => $songTotal];
}
