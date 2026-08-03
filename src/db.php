<?php
declare(strict_types=1);

// The game may hold the database while running: keep a busy timeout
// so short locks do not turn into hard failures.
function openDb(string $mapsDbPath): PDO
{
    if (!is_file($mapsDbPath)) {
        throw new RuntimeException('maps.db not found: ' . $mapsDbPath);
    }

    $pdo = new PDO('sqlite:' . $mapsDbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA busy_timeout = 3000');

    return $pdo;
}

// Escape LIKE wildcards in user-provided values (used with ESCAPE '!')
function escapeLike(string $value): string
{
    return str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $value);
}
