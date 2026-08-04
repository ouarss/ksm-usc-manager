<?php
declare(strict_types=1);

// A "game root" is the folder containing maps.db (usually next to Main.cfg).
// Priority: explicit setting, then auto-detection around the repo.
function resolveGameRoot(): ?string
{
    $settings = loadSettings();
    if (!empty($settings['game_root'])) {
        $root = normalizePath($settings['game_root']);
        if (is_file($root . '/maps.db')) {
            return $root;
        }
    }

    $candidates = [
        normalizePath(dirname(APP_ROOT)),           // repo root
        normalizePath(dirname(APP_ROOT)) . '/bin',  // game working dir in the repo
    ];
    foreach ($candidates as $candidate) {
        if (is_file($candidate . '/maps.db')) {
            return $candidate;
        }
    }

    return null;
}

// Everything the front needs to know about the environment.
// The configured game root is the single source of truth: the songs folder
// comes from Main.cfg (default "songs"), NOT from the database — a restored
// backup may carry paths from another machine. `db_songs_root` is what the
// database currently believes; when it differs, the UI offers a path fix.
function gamePaths(): array
{
    $root = resolveGameRoot();
    $paths = [
        'game_root'               => $root,
        'mapsdb_path'             => null,
        'config_path'             => null,
        'config_song_folder'      => null,
        'config_song_folder_gone' => false,
        'songs_root'              => null,
        'songs_root_exists'       => false,
        'db_songs_root'           => null,
        'paths_mismatch'          => false,
    ];
    if ($root === null) {
        return $paths;
    }

    $paths['mapsdb_path'] = $root . '/maps.db';

    foreach ([$root . '/Main.cfg', dirname($root) . '/Main.cfg'] as $cfg) {
        if (is_file($cfg)) {
            $paths['config_path'] = $cfg;
            $paths['config_song_folder'] = parseSongFolder($cfg, $root);
            break;
        }
    }

    // A Main.cfg carried over from another machine (or an installation that
    // moved drive) can point SongFolder at a folder that no longer exists.
    // The configured game root is the source of truth, so a dead SongFolder
    // never wins over an existing <root>/songs.
    $configured = $paths['config_song_folder'];
    $default = $root . '/songs';
    if ($configured !== null && !is_dir($configured) && is_dir($default)) {
        $paths['config_song_folder_gone'] = true;
        $paths['songs_root'] = $default;
    } else {
        $paths['songs_root'] = $configured ?? $default;
    }
    $paths['songs_root_exists'] = is_dir($paths['songs_root']);

    $pdo = openDb($paths['mapsdb_path']);
    $paths['db_songs_root'] = dbSongsRoot($pdo);
    $paths['paths_mismatch'] = $paths['db_songs_root'] !== null
        && strcasecmp($paths['db_songs_root'], $paths['songs_root']) !== 0;

    return $paths;
}

function parseSongFolder(string $configPath, string $gameRoot): ?string
{
    $lines = file($configPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return null;
    }
    foreach ($lines as $line) {
        $parts = explode('=', $line, 2);
        if (count($parts) === 2 && trim($parts[0]) === 'SongFolder') {
            $value = trim(trim($parts[1]), '"');
            $value = normalizePath($value);
            // Relative values resolve against the game root (the game's working dir)
            if (!preg_match('#^([a-zA-Z]:/|/)#', $value)) {
                $value = $gameRoot . '/' . $value;
            }

            return $value;
        }
    }

    return null;
}

// The songs root actually referenced by the database: common prefix of all
// folder paths, cut at the last path separator. Ground truth for serving media.
function dbSongsRoot(PDO $pdo): ?string
{
    $row = $pdo->query('SELECT MIN(path) AS a, MAX(path) AS b FROM Folders')->fetch();
    if (!$row || $row['a'] === null) {
        return null;
    }

    $a = normalizePath($row['a']);
    $b = normalizePath($row['b']);
    $len = min(strlen($a), strlen($b));
    $common = 0;
    while ($common < $len && $a[$common] === $b[$common]) {
        $common++;
    }
    $prefix = substr($a, 0, $common);
    $cut = strrpos($prefix, '/');

    return $cut === false ? null : substr($prefix, 0, $cut);
}

// The native Windows folder picker can only appear on the machine running
// the server, so it is offered only to a localhost client on Windows.
function canBrowseNatively(): bool
{
    return PHP_OS_FAMILY === 'Windows'
        && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
}

// In-app folder picker: lists the server's directories (names only) so the
// client can navigate to the game folder. Replaces a native Windows dialog,
// which could open invisibly depending on how the server process runs.
function listFolders(string $path): array
{
    if ($path === '') {
        // Entry point: one entry per existing drive (Windows) or the root (else)
        if (PHP_OS_FAMILY === 'Windows') {
            $drives = [];
            foreach (range('A', 'Z') as $letter) {
                if (is_dir($letter . ':/')) {
                    $drives[] = ['name' => $letter . ':', 'mapsdb' => is_file($letter . ':/maps.db')];
                }
            }

            return ['path' => '', 'parent' => null, 'dirs' => $drives, 'has_mapsdb' => false];
        }
        $path = '/';
    }
    if (preg_match('/^[A-Za-z]:$/', $path)) {
        $path .= '/'; // realpath('C:') would resolve to that drive's CWD
    }
    $real = realpath($path);
    if ($real === false || !is_dir($real)) {
        jsonError('Folder not found: ' . $path);
    }
    $real = normalizePath($real);

    $dirs = [];
    foreach (scandir($real) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..' || $entry[0] === '.') {
            continue;
        }
        if (is_dir($real . '/' . $entry)) {
            // The mapsdb flag lets the picker highlight candidate folders
            $dirs[] = ['name' => $entry, 'mapsdb' => is_file($real . '/' . $entry . '/maps.db')];
        }
    }
    usort($dirs, static fn (array $a, array $b) => strnatcasecmp($a['name'], $b['name']));

    $parent = normalizePath(dirname($real));

    return [
        'path'       => $real,
        // A drive root is its own dirname: go back to the drive list instead
        'parent'     => $parent === $real ? '' : $parent,
        'dirs'       => $dirs,
        'has_mapsdb' => is_file($real . '/maps.db'),
    ];
}

function dbStats(PDO $pdo): array
{
    $charts = $pdo->query(
        'SELECT COUNT(*) AS nb_charts, COUNT(DISTINCT folderid) AS nb_songs,
                COUNT(DISTINCT artist) AS nb_artists, COUNT(DISTINCT effector) AS nb_effectors
         FROM Charts'
    )->fetch();
    $collections = $pdo->query('SELECT COUNT(DISTINCT collection) FROM Collections')->fetchColumn();
    $scores = $pdo->query('SELECT COUNT(*) FROM Scores')->fetchColumn();

    return [
        'songs'       => (int) $charts['nb_songs'],
        'charts'      => (int) $charts['nb_charts'],
        'artists'     => (int) $charts['nb_artists'],
        'effectors'   => (int) $charts['nb_effectors'],
        'collections' => (int) $collections,
        'scores'      => (int) $scores,
    ];
}
