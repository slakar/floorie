<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function valid_id(string $id): bool
{
    return (bool) preg_match('/^[a-zA-Z0-9-]{8,64}$/', $id);
}

$dataDir = getenv('GRIDLINE_DATA_DIR') ?: __DIR__ . DIRECTORY_SEPARATOR . 'data';
if (!is_dir($dataDir)) respond(200, ['plans' => []]);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET') {
    header('Allow: GET');
    respond(405, ['error' => 'Method not allowed.']);
}

$id = isset($_GET['id']) ? (string) $_GET['id'] : '';
if ($id !== '') {
    if (!valid_id($id)) respond(400, ['error' => 'Invalid plan identifier.']);
    $path = $dataDir . DIRECTORY_SEPARATOR . $id . '.json';
    if (!is_file($path)) respond(404, ['error' => 'Plan not found.']);
    $stored = json_decode((string) file_get_contents($path), true);
    if (!is_array($stored) || !isset($stored['id'], $stored['name'], $stored['plan']) || !is_array($stored['plan'])) {
        respond(500, ['error' => 'The stored plan is invalid.']);
    }
    respond(200, [
        'id' => $stored['id'],
        'name' => $stored['name'],
        'updatedAt' => $stored['updatedAt'] ?? null,
        'plan' => $stored['plan'],
    ]);
}

$plans = [];
foreach (glob($dataDir . DIRECTORY_SEPARATOR . '*.json') ?: [] as $path) {
    $stored = json_decode((string) @file_get_contents($path), true);
    if (!is_array($stored) || !isset($stored['id'], $stored['name'])) continue;
    $plan = is_array($stored['plan'] ?? null) ? $stored['plan'] : [];
    $plans[] = [
        'id' => $stored['id'],
        'name' => $stored['name'],
        'updatedAt' => $stored['updatedAt'] ?? '',
        'viewCount' => is_array($plan['views'] ?? null) ? count($plan['views']) : 0,
    ];
}
usort($plans, static function (array $a, array $b): int { return strcmp((string) $b['updatedAt'], (string) $a['updatedAt']); });
respond(200, ['plans' => $plans]);
