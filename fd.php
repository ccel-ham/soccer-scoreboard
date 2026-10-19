<?php
// football-data.org への中継（football-data.org はブラウザから直接呼べないため）
// ・キーはページから X-FD-Key ヘッダーで受け取り、そのまま転送するだけ。保存も記録もしない
//   （URL に入れるとサーバーのアクセスログに残るので、ヘッダーで受け取る）
// ・転送先・使えるパス・パラメータは固定。任意の URL の中継には使えない
// ・同じサイトのページからの呼び出しだけ受け付ける

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const FD_BASE = 'https://api.football-data.org/v4/';

function fail($status, $message) {
    http_response_code($status);
    echo json_encode(['message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET のみ使えます');

// 別のサイトのページからの呼び出しは断る（ブラウザが付ける Origin で判定）
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== ($_SERVER['HTTP_HOST'] ?? '')) {
    fail(403, 'このサイト以外からは使えません');
}

$key = $_SERVER['HTTP_X_FD_KEY'] ?? '';
if (!preg_match('/^[A-Za-z0-9]{16,64}$/', $key)) fail(400, '予備APIのキーの形式が正しくありません');

// 使えるのは「試合の一覧」と「1試合の取得」だけ
$path = $_GET['path'] ?? '';
$query = [];
if ($path === 'matches') {
    $rules = [
        'competitions' => '/^[A-Z0-9]{2,5}(,[A-Z0-9]{2,5}){0,9}$/',
        'dateFrom' => '/^\d{4}-\d{2}-\d{2}$/',
        'dateTo' => '/^\d{4}-\d{2}-\d{2}$/',
        'status' => '/^[A-Z_]{3,12}$/',
    ];
    foreach ($rules as $name => $pattern) {
        if (!isset($_GET[$name])) continue;
        if (!is_string($_GET[$name]) || !preg_match($pattern, $_GET[$name])) fail(400, "パラメータ {$name} が正しくありません");
        $query[$name] = $_GET[$name];
    }
} elseif (!preg_match('#^matches/\d{1,10}$#', $path)) {
    fail(400, 'このデータは中継できません');
}

$url = FD_BASE . $path . ($query ? '?' . http_build_query($query) : '');
$remaining = null;
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['X-Auth-Token: ' . $key],
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$remaining) {
        if (stripos($line, 'X-Requests-Available-Minute:') === 0) {
            $remaining = (int)trim(substr($line, strlen('X-Requests-Available-Minute:')));
        }
        return strlen($line);
    },
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($body === false || $status === 0) fail(502, 'football-data.org と通信できません');

// 1分あたりの残り回数をページに伝える（無料プランは1分10回）
if ($remaining !== null) header('X-FD-Available-Minute: ' . $remaining);
http_response_code($status);
echo $body;
