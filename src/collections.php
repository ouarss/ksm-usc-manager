<?php
declare(strict_types=1);

// Every collection with its song count (the sidebar nav)
function collectionsList(PDO $pdo): array
{
    $sql = 'SELECT collection, COUNT(*) AS songs FROM Collections GROUP BY collection ORDER BY collection COLLATE NOCASE';

    $list = [];
    foreach ($pdo->query($sql) as $row) {
        $list[] = ['name' => $row['collection'], 'songs' => (int) $row['songs']];
    }

    return $list;
}

function collectionFolderIds(PDO $pdo, string $name): array
{
    $stmt = $pdo->prepare('SELECT folderid FROM Collections WHERE collection = :name');
    $stmt->execute(['name' => $name]);

    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

// Collections containing a given song (for the add-to-collection popup)
function songCollections(PDO $pdo, int $folderId): array
{
    $stmt = $pdo->prepare('SELECT collection FROM Collections WHERE folderid = :id');
    $stmt->execute(['id' => $folderId]);

    return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

// Add the song if absent, remove it otherwise. Returns true when added.
function collectionToggle(PDO $pdo, int $folderId, string $name): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM Collections WHERE folderid = :id AND collection = :name');
    $stmt->execute(['id' => $folderId, 'name' => $name]);

    if ($stmt->fetchColumn()) {
        $del = $pdo->prepare('DELETE FROM Collections WHERE folderid = :id AND collection = :name');
        $del->execute(['id' => $folderId, 'name' => $name]);

        return false;
    }

    $ins = $pdo->prepare('INSERT INTO Collections (collection, folderid) VALUES (:name, :id)');
    $ins->execute(['name' => $name, 'id' => $folderId]);

    return true;
}

// Replace a collection's rows wholesale (a .fav resync: the file wins).
function replaceCollection(PDO $pdo, string $name, array $folderIds): void
{
    $pdo->beginTransaction();
    $del = $pdo->prepare('DELETE FROM Collections WHERE collection = :name');
    $del->execute(['name' => $name]);
    $ins = $pdo->prepare('INSERT OR IGNORE INTO Collections (collection, folderid) VALUES (:name, :id)');
    foreach ($folderIds as $folderId) {
        $ins->execute(['name' => $name, 'id' => (int) $folderId]);
    }
    $pdo->commit();
}

// Renaming onto an existing collection merges them (UNIQUE constraint
// would reject the straight UPDATE for songs present in both).
function collectionRename(PDO $pdo, string $oldName, string $newName): void
{
    $pdo->beginTransaction();
    $upd = $pdo->prepare('UPDATE OR IGNORE Collections SET collection = :new WHERE collection = :old');
    $upd->execute(['new' => $newName, 'old' => $oldName]);
    $del = $pdo->prepare('DELETE FROM Collections WHERE collection = :old');
    $del->execute(['old' => $oldName]);
    $pdo->commit();
}

function collectionDelete(PDO $pdo, string $name): int
{
    $stmt = $pdo->prepare('DELETE FROM Collections WHERE collection = :name');
    $stmt->execute(['name' => $name]);

    return $stmt->rowCount();
}
