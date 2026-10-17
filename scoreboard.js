// サッカー配信用スコアボード
// ・タイマーはブラウザ側で1秒ごとに表示を更新（開始時刻を基準に計算するので、再読み込みしてもずれない）
// ・スコアは API-FOOTBALL から、選んだ試合を約80秒に1回取得（タイマーが動いている間だけ）。手動の +1 / -1 も可能
// ・APIキーはこのページを開いている間だけメモリに持ち、どこにも保存しない

const API_BASE = "https://v3.football.api-sports.io";
const SYNC_INTERVAL_SEC = 80;
const DAILY_RESERVE = 2;          // 1日の上限からこの回数を残して自動同期を止める
const STORAGE_KEY = "scoreboard-state"; // キー以外の表示状態だけを保存する

const $ = (id) => document.getElementById(id);

let apiKey = "";
let syncOn = false;
let nextSyncAt = 0;
let requestsUsed = null;
let requestsLimit = null;

let state = {
    homeName: "HOME",
    awayName: "AWAY",
    homeLogo: "",
    awayLogo: "",
    homeScore: 0,
    awayScore: 0,
    half: 1,            // 1 = 前半, 2 = 後半
    baseSeconds: 0,     // 一時停止中の経過秒数
    startedAt: null,    // 動作中なら開始した時刻（ミリ秒）
    lastApiHome: null,  // 最後に API から受け取ったスコア
    lastApiAway: null,
    fixture: null       // 選んだ試合 { id, leagueId, timestamp, home, away }
};

// ==== メニュー・テーマ（既存タイマーと同じ） ====
function toggleMenu() {
    $("menu").classList.toggle("open");
    document.querySelector(".hamburger").classList.toggle("open");
}

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    state.darkMode = document.body.classList.contains("dark-mode");
    saveState();
}

// 下部の操作バー（配信に映したくないときは隠せる）
function toggleBar() {
    state.hideBar = !state.hideBar;
    saveState();
    renderBar();
}

function renderBar() {
    document.body.classList.toggle("hide-bar", !!state.hideBar);
    $("bar-button").textContent = state.hideBar ? "下部の操作バー [ 非表示 ]" : "下部の操作バー [ 表示 ]";
}

function toggleLogo() {
    state.showLogo = !state.showLogo;
    saveState();
    renderLogo();
}

function renderLogo() {
    document.body.classList.toggle("show-logo", !!state.showLogo);
    $("logo-button").textContent = state.showLogo ? "ロゴ表示 [ ON ]" : "ロゴ表示 [ OFF ]";
}

// ==== 保存・読み込み ====
function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { }
}

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) state = Object.assign(state, saved);
    } catch (e) { }
}

// ==== タイマー ====
function parseTimeString(timeStr) {
    const parts = timeStr.split(":").map(Number);
    if (parts.length !== 2 || parts.some(isNaN)) return 0;
    return parts[0] * 60 + parts[1];
}

function formatTime(seconds) {
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${m}:${s}`;
}

function isRunning() {
    return state.startedAt !== null;
}

function currentSeconds() {
    if (!isRunning()) return state.baseSeconds;
    return state.baseSeconds + Math.floor((Date.now() - state.startedAt) / 1000);
}

function setSeconds(seconds) {
    state.baseSeconds = Math.max(0, seconds);
    if (isRunning()) state.startedAt = Date.now();
    saveState();
    renderTimer();
}

function renderTimer() {
    const timerEl = $("timer");
    if (document.activeElement !== timerEl) {
        timerEl.textContent = formatTime(currentSeconds());
    }
    $("half-label").textContent = state.half === 2 ? "後半" : "前半";

    const pauseBtn = $("pause-button");
    const started = isRunning() || state.baseSeconds > 0;
    pauseBtn.disabled = !started;
    pauseBtn.textContent = (isRunning() || !started) ? "一時停止" : "再開";
}

$("start-button").addEventListener("click", () => {
    state.baseSeconds = currentSeconds();
    state.startedAt = Date.now();
    scheduleSyncAfterStart();
    saveState();
    renderTimer();
});

$("pause-button").addEventListener("click", () => {
    if (isRunning()) {
        state.baseSeconds = currentSeconds();
        state.startedAt = null;
    } else {
        state.startedAt = Date.now();
        scheduleSyncAfterStart();
    }
    saveState();
    renderTimer();
});

$("reset-button").addEventListener("click", () => {
    state.baseSeconds = 0;
    state.startedAt = null;
    state.half = 1;
    saveState();
    renderTimer();
});

$("second-half-button").addEventListener("click", () => {
    state.half = 2;
    setSeconds(45 * 60);
});

document.querySelectorAll("[data-add]").forEach(btn => {
    btn.addEventListener("click", () => {
        setSeconds(currentSeconds() + Number(btn.dataset.add));
    });
});

// 「✎ 時間を入力」: タイマーの数字を選択した状態にして、そのまま打ち込めるようにする
$("edit-time-button").addEventListener("click", () => {
    const timerEl = $("timer");
    timerEl.focus();
    const range = document.createRange();
    range.selectNodeContents(timerEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showTimeHint(true);
});

// 入力中は操作バーの説明を目立たせる（text を省略すると通常の案内に戻す）
const DEFAULT_HINT = "タイマー・チーム名は直接入力もできます";
const TIME_HINT = "時間を入力中: 「分:秒」で入力して Enter（例: 23:30）";
const NAME_HINT = "チーム名を入力中: 入力して Enter";

function showInputHint(text) {
    const hint = $("bar-hint");
    hint.classList.toggle("active", !!text);
    hint.textContent = text || DEFAULT_HINT;
}

function showTimeHint(editing) {
    showInputHint(editing ? TIME_HINT : null);
}

$("timer").addEventListener("focus", () => showTimeHint(true));

// タイマーを直接書き換えたとき（Enter でもフォーカスが外れたときでも確定）
function commitTimeInput() {
    showTimeHint(false);
    setSeconds(parseTimeString($("timer").textContent.trim()));
}

$("timer").addEventListener("blur", commitTimeInput);

$("timer").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        commitTimeInput();
        $("timer").blur();
    }
});

// ==== スコア・チーム表示 ====
function renderBoard() {
    $("home-name").textContent = state.homeName;
    $("away-name").textContent = state.awayName;
    $("home-score").textContent = state.homeScore;
    $("away-score").textContent = state.awayScore;
    setLogo($("home-logo"), state.homeLogo);
    setLogo($("away-logo"), state.awayLogo);
    renderBarTeams();
}

// 下部バーのスコアボタンの見出し: ロゴがあればロゴ、なければ画面に出ているチーム名
function renderBarTeams() {
    [["bar-home", state.homeLogo, state.homeName], ["bar-away", state.awayLogo, state.awayName]].forEach(([id, logo, name]) => {
        const el = $(id);
        el.innerHTML = "";
        el.title = name;
        if (logo) {
            const img = document.createElement("img");
            img.className = "bar-logo";
            img.src = logo;
            img.alt = name;
            // ロゴが読み込めなかったときはチーム名に切り替える
            img.onerror = () => { el.textContent = name; };
            el.appendChild(img);
        } else {
            el.textContent = name;
        }
    });
}

function setLogo(img, url) {
    if (url) {
        img.src = url;
    } else {
        img.removeAttribute("src");
    }
}

document.querySelectorAll("[data-score]").forEach(btn => {
    btn.addEventListener("click", () => {
        const key = btn.dataset.score === "home" ? "homeScore" : "awayScore";
        state[key] = Math.max(0, state[key] + Number(btn.dataset.delta));
        saveState();
        renderBoard();
    });
});

$("score-reset-button").addEventListener("click", () => {
    state.homeScore = 0;
    state.awayScore = 0;
    saveState();
    renderBoard();
});

// チーム名を直接書き換えたとき（タイマーと同じく、入力中は下部の案内を強調）
["home-name", "away-name"].forEach(id => {
    const el = $(id);
    const commitName = () => {
        showInputHint(null);
        el.textContent = el.textContent.trim();
        state[id === "home-name" ? "homeName" : "awayName"] = el.textContent;
        saveState();
        renderBarTeams();
    };
    el.addEventListener("focus", () => showInputHint(NAME_HINT));
    el.addEventListener("blur", commitName);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commitName();
            el.blur();
        }
    });
});

// ==== API 自動同期 ====
function setStatus(text, isError) {
    const el = $("api-status");
    el.textContent = text;
    el.classList.toggle("error", !!isError);
}

function usageText() {
    if (requestsUsed === null) return "";
    return `本日の使用 ${requestsUsed}/${requestsLimit}回`;
}

function errorMessage(errors) {
    if (!errors) return "";
    if (Array.isArray(errors)) return errors.join(" / ");
    return Object.values(errors).join(" / ");
}

async function callApi(path) {
    let res;
    try {
        res = await fetch(API_BASE + path, {
            headers: { "x-apisports-key": apiKey }
        });
    } catch (e) {
        // キーが間違っていると API が拒否し、ブラウザでは通信エラーとしか分からない
        throw new Error("キーが正しくないか、通信できません");
    }
    const data = await res.json();
    const err = errorMessage(data.errors);
    if (err) throw new Error(err);
    return data;
}

// 使用回数の確認（API-FOOTBALL の /status は回数に数えられない）
async function checkStatus() {
    const data = await callApi("/status");
    const req = data.response && data.response.requests;
    if (req) {
        requestsUsed = req.current;
        requestsLimit = req.limit_day;
    }
}

function readApiKey() {
    apiKey = $("api-key").value.trim();
    return apiKey !== "";
}

function nearDailyLimit() {
    return requestsLimit !== null && requestsUsed >= requestsLimit - DAILY_RESERVE;
}

// ==== 試合選択（プレミアリーグ・ラ・リーガ・チャンピオンズリーグ） ====
// 無料プランでは「日付指定でその日の全試合」だけが取れるので、取得後に3大会に絞る
// 無料プランで指定できる日付は「世界標準時(UTC)の今日の前後1日」だけ。
// 日本時間の日付で取ると、0〜9時は「明日」が範囲外になって一覧全体が取れなくなるため、
// 「これから24時間」は UTC の日付で取る（今日・明日の2日分で必ず24時間先まで入る）
const LEAGUES = { 39: "プレミアリーグ", 140: "ラ・リーガ", 2: "チャンピオンズリーグ" };
const JST_OFFSET_MS = 9 * 3600 * 1000;
const PAST_WINDOW_SEC = 3 * 3600;     // 「これから24時間」に、3時間前までに始まった試合も含める
const NEXT_WINDOW_SEC = 24 * 3600;
const STATUS_LABEL = {
    TBD: "時間未定", NS: "開始前", "1H": "前半", HT: "ハーフタイム", "2H": "後半",
    ET: "延長", BT: "延長前", P: "PK戦", SUSP: "中断", INT: "中断", LIVE: "試合中",
    FT: "終了", AET: "終了(延長)", PEN: "終了(PK)", PST: "延期", CANC: "中止", ABD: "中止", AWD: "没収", WO: "不戦"
};
const LIVE_STATUSES = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"];

const dayCache = {};          // 日付ごとの取得結果（ページを開いている間だけ）
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分たったら取り直す（「開始前」のまま古い状態が残らないように）
let pickerMode = "next24";    // "next24" または "YYYY-MM-DD"
let pickerLeague = "all";
let pickerFixtures = [];

function jstDate(ms) {
    return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function formatDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]})`;
}

function formatKickoff(timestamp) {
    const d = new Date(timestamp * 1000 + JST_OFFSET_MS);
    const time = `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    return `${formatDate(d.toISOString().slice(0, 10))} ${time}`;
}

function utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

// tz は "Asia/Tokyo"（日付を選んだとき）か "UTC"（これから24時間）
function cacheKey(dateStr, tz) {
    return `${dateStr}|${tz}`;
}

function isCached(dateStr, tz) {
    const c = dayCache[cacheKey(dateStr, tz)];
    return !!c && Date.now() - c.at < CACHE_TTL_MS;
}

async function fetchDay(dateStr, tz) {
    const key = cacheKey(dateStr, tz);
    if (isCached(dateStr, tz)) return dayCache[key].list;
    let data;
    try {
        data = await callApi(`/fixtures?date=${dateStr}&timezone=${tz}`);
    } catch (e) {
        // 無料プランの日付の範囲外（英語のメッセージを分かりやすく言い換える）
        if (/access to this date/i.test(e.message)) {
            throw new Error("無料プランで見られるのは、前日〜翌日の試合までです");
        }
        throw e;
    }
    if (requestsUsed !== null) requestsUsed++;
    const list = (data.response || [])
        .filter(f => LEAGUES[f.league.id])
        .map(f => ({
            id: f.fixture.id,
            timestamp: f.fixture.timestamp,
            status: f.fixture.status.short,
            leagueId: f.league.id,
            home: f.teams.home.name,
            away: f.teams.away.name,
            homeId: f.teams.home.id,
            awayId: f.teams.away.id,
            homeLogo: f.teams.home.logo,
            awayLogo: f.teams.away.logo
        }));
    dayCache[key] = { at: Date.now(), list };
    return list;
}

function setPickerMessage(text, isError) {
    const el = $("picker-message");
    el.textContent = text;
    el.classList.toggle("error", !!isError);
}

function openPicker() {
    $("picker").classList.add("open");
    if (!readApiKey()) {
        $("picker-list").innerHTML = "";
        setPickerMessage("先にサイドバーで APIキーを入力してください。", true);
        return;
    }
    loadPicker();
}

function closePicker() {
    $("picker").classList.remove("open");
}

function setPickerMode(mode) {
    pickerMode = mode;
    loadPicker();
}

function movePickerDay(n) {
    const base = pickerMode === "next24" ? jstDate(Date.now()) : pickerMode;
    pickerMode = addDays(base, n);
    loadPicker();
}

async function loadPicker() {
    $("picker-next24").classList.toggle("selected", pickerMode === "next24");
    $("picker-date").textContent = pickerMode === "next24" ? "" : formatDate(pickerMode);
    if (!readApiKey()) return;

    const now = Date.now();
    let dates, tz;
    if (pickerMode === "next24") {
        tz = "UTC";
        const today = utcDate(now);
        dates = [today, addDays(today, 1)];
        // UTC 0〜3時（日本時間 9〜12時）は、3時間前までに始まった試合も入るよう前日分も取る
        if (new Date(now).getUTCHours() < 3) dates.unshift(addDays(today, -1));
    } else {
        tz = "Asia/Tokyo";
        dates = [pickerMode];
    }

    const needed = dates.filter(d => !isCached(d, tz)).length;
    setPickerMessage(needed ? `読み込み中…（API を ${needed}回 使います）` : "");
    try {
        if (requestsUsed === null) await checkStatus();
        let list = [];
        for (const d of dates) list = list.concat(await fetchDay(d, tz));

        const nowSec = Math.floor(now / 1000);
        if (pickerMode === "next24") {
            list = list.filter(f => f.timestamp >= nowSec - PAST_WINDOW_SEC && f.timestamp < nowSec + NEXT_WINDOW_SEC);
        } else {
            list = list.filter(f => jstDate(f.timestamp * 1000) === pickerMode);
        }
        // 同じ試合が2日分に重複しないように
        const seen = new Set();
        pickerFixtures = list.filter(f => !seen.has(f.id) && seen.add(f.id))
            .sort((a, b) => a.timestamp - b.timestamp);
        setPickerMessage(usageText());
        renderPickerList();
    } catch (e) {
        // 前に表示していた別の日の一覧が残らないように消す
        pickerFixtures = [];
        $("picker-list").innerHTML = "";
        setPickerMessage(`試合一覧を取得できませんでした（${e.message}）`, true);
    }
}

function renderPickerList() {
    document.querySelectorAll("#picker-leagues button").forEach(b =>
        b.classList.toggle("selected", b.dataset.league === pickerLeague));

    const word = $("picker-search").value.trim().toLowerCase();
    const items = pickerFixtures.filter(f =>
        (pickerLeague === "all" || String(f.leagueId) === pickerLeague) &&
        (!word || f.home.toLowerCase().includes(word) || f.away.toLowerCase().includes(word)));

    const listEl = $("picker-list");
    listEl.innerHTML = "";
    if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "picker-message";
        empty.textContent = "該当する試合がありません。";
        listEl.appendChild(empty);
        return;
    }

    items.forEach(f => {
        const btn = document.createElement("button");
        btn.className = "picker-item";
        if (state.fixture && state.fixture.id === f.id) btn.classList.add("current");

        const time = document.createElement("span");
        time.textContent = formatKickoff(f.timestamp);
        const league = document.createElement("span");
        league.className = "picker-league";
        league.textContent = LEAGUES[f.leagueId];
        const teams = document.createElement("span");
        teams.textContent = `${f.home} vs ${f.away}`;
        const status = document.createElement("span");
        status.className = "picker-status";
        status.classList.toggle("live", LIVE_STATUSES.includes(f.status));
        status.textContent = STATUS_LABEL[f.status] || f.status;

        btn.append(time, league, teams, status);
        btn.addEventListener("click", () => selectFixture(f));
        listEl.appendChild(btn);
    });
}

document.querySelectorAll("#picker-leagues button").forEach(b => {
    b.addEventListener("click", () => {
        pickerLeague = b.dataset.league;
        renderPickerList();
    });
});

$("picker-search").addEventListener("input", renderPickerList);

// チーム名の3文字表記（例: Fulham → FUL）。取得済みのチームはブラウザに覚えておき、API を使わない
function fallbackCode(name) {
    return (name.replace(/[^A-Za-z]/g, "").slice(0, 3) || name.slice(0, 3)).toUpperCase();
}

async function fetchTeamCode(id, name) {
    if (!state.teamCodes) state.teamCodes = {};
    if (state.teamCodes[id]) return state.teamCodes[id];
    try {
        const data = await callApi(`/teams?id=${id}`);
        if (requestsUsed !== null) requestsUsed++;
        // 3文字表記が登録されていないチームは、頭3文字を覚えておく（毎回 API を使わないため）
        const code = (data.response && data.response[0] && data.response[0].team.code) || fallbackCode(name);
        state.teamCodes[id] = code;
        return code;
    } catch (e) {
        // 通信エラーのときは覚えずに、次の機会にもう一度取得する
        return fallbackCode(name);
    }
}

// 試合を選んだら、チーム名（3文字）とロゴを一度だけ入れる（チーム名はあとから自由に書き換えられる）
async function selectFixture(f) {
    state.fixture = {
        id: f.id, leagueId: f.leagueId, timestamp: f.timestamp,
        home: f.home, away: f.away, homeLogo: f.homeLogo, awayLogo: f.awayLogo
    };
    const known = state.teamCodes || {};
    state.homeName = known[f.homeId] || fallbackCode(f.home);
    state.awayName = known[f.awayId] || fallbackCode(f.away);
    state.homeLogo = f.homeLogo;
    state.awayLogo = f.awayLogo;
    state.homeScore = 0;
    state.awayScore = 0;
    state.lastApiHome = null;
    state.lastApiAway = null;
    saveState();
    renderBoard();
    renderSelectedMatch();
    renderMatchBox($("api-match"), "API: 未取得");
    closePicker();

    // 正式な3文字表記を取得して差し替える（その間に配信者が名前を書き換えていたら上書きしない）
    const tempHome = state.homeName;
    const tempAway = state.awayName;
    const [homeCode, awayCode] = [await fetchTeamCode(f.homeId, f.home), await fetchTeamCode(f.awayId, f.away)];
    if (state.fixture && state.fixture.id === f.id) {
        if (state.homeName === tempHome) state.homeName = homeCode;
        if (state.awayName === tempAway) state.awayName = awayCode;
        saveState();
        renderBoard();
    }
}

// サイドバー用の簡単な表示: [ロゴ] 中央の文字 [ロゴ] と、その下に小さく補足（チーム名はロゴにマウスを乗せると出る）
function renderMatchBox(el, emptyText, m) {
    el.innerHTML = "";
    if (!m) {
        el.textContent = emptyText;
        return;
    }
    const line = document.createElement("div");
    line.className = "match-line";
    const logo = (src, name) => {
        const img = document.createElement("img");
        img.className = "match-logo";
        img.src = src || "";
        img.alt = name;
        img.title = name;
        return img;
    };
    const center = document.createElement("span");
    center.className = "match-center";
    center.textContent = m.center;
    line.append(logo(m.homeLogo, m.home), center, logo(m.awayLogo, m.away));
    const sub = document.createElement("div");
    sub.className = "match-sub";
    sub.textContent = m.sub;
    el.append(line, sub);
}

function renderSelectedMatch() {
    const f = state.fixture;
    renderMatchBox($("selected-match"), "試合: 未選択", f && {
        home: f.home, away: f.away,
        homeLogo: f.homeLogo || state.homeLogo, awayLogo: f.awayLogo || state.awayLogo,
        center: "vs",
        sub: `${formatKickoff(f.timestamp)}・${LEAGUES[f.leagueId] || ""}`
    });
}

// ==== スコアの自動同期（選んだ試合を、タイマーが動いている間だけ取得） ====
async function syncScore() {
    if (nearDailyLimit()) {
        stopSync();
        setStatus(`本日の上限に近いため自動同期を止めました（${usageText()}）。手動で調整してください。`, true);
        return;
    }

    // 試合中の全試合を1回で取得し、その中から選んだ試合を探す
    const data = await callApi("/fixtures?live=all");
    if (requestsUsed !== null) requestsUsed++;

    const match = (data.response || []).find(f => f.fixture.id === state.fixture.id);

    if (!match) {
        renderMatchBox($("api-match"), "API: 試合中データなし（開始前・終了・中断）");
        setStatus(usageText());
        return;
    }

    // チーム名は配信者が編集するので上書きしない。取得中の試合はメニューに簡単に表示して確認できるようにする
    const st = match.fixture.status;
    const apiMinute = st.elapsed !== null ? ` ${st.elapsed}分` : "";
    renderMatchBox($("api-match"), "", {
        home: match.teams.home.name, away: match.teams.away.name,
        homeLogo: match.teams.home.logo, awayLogo: match.teams.away.logo,
        center: `${match.goals.home ?? 0} - ${match.goals.away ?? 0}`,
        sub: `API: ${STATUS_LABEL[st.short] || st.long}${apiMinute}`
    });

    state.homeLogo = match.teams.home.logo;
    state.awayLogo = match.teams.away.logo;

    // API のスコアが変わったときだけ反映（手動で直した値を、古い API の値で戻さないため）
    const apiHome = match.goals.home ?? 0;
    const apiAway = match.goals.away ?? 0;
    if (apiHome !== state.lastApiHome || apiAway !== state.lastApiAway) {
        state.homeScore = apiHome;
        state.awayScore = apiAway;
        state.lastApiHome = apiHome;
        state.lastApiAway = apiAway;
    }
    saveState();
    renderBoard();

    setStatus(usageText());
}

async function runSync() {
    try {
        await syncScore();
    } catch (e) {
        stopSync();
        setStatus(`エラーのため自動同期を止めました: ${e.message}`, true);
        return;
    }
    if (syncOn) nextSyncAt = Date.now() + SYNC_INTERVAL_SEC * 1000;
}

async function startSync() {
    if (!readApiKey()) {
        setStatus("APIキーを入力してください。", true);
        return;
    }
    if (!state.fixture) {
        setStatus("先に「試合を選ぶ」で試合を選んでください。", true);
        return;
    }

    try {
        await checkStatus();
    } catch (e) {
        setStatus(`キーを確認できませんでした（${e.message}）`, true);
        return;
    }

    syncOn = true;
    nextSyncAt = 0;   // タイマーが動いていればすぐ1回取得する
    setStatus(usageText());
    renderSyncButton();
}

function stopSync() {
    syncOn = false;
    renderSyncButton();
}

// タイマーを動かし始めたとき（キックオフ・後半開始・再開）は、80秒後から取得を始める
function scheduleSyncAfterStart() {
    if (syncOn && isFinite(nextSyncAt)) {
        nextSyncAt = Math.max(nextSyncAt, Date.now() + SYNC_INTERVAL_SEC * 1000);
    }
}

// 1秒ごとに呼ぶ: 自動同期 ON かつタイマーが動いている間だけ取得する
function syncTick() {
    if (!syncOn) return;
    if (!isRunning()) {
        $("bar-sync").textContent = "API: 待機中（タイマー停止中は取得しません）";
        return;
    }
    if (Date.now() >= nextSyncAt) {
        nextSyncAt = Infinity; // 取得中は二重に呼ばない
        runSync();
    }
}

function renderSyncButton() {
    $("sync-button").textContent = syncOn ? "自動同期 [ ON ]" : "自動同期 [ OFF ]";
    if (!syncOn) $("bar-sync").textContent = "API: OFF";
}

$("sync-button").addEventListener("click", () => {
    if (syncOn) {
        stopSync();
        setStatus("自動同期 OFF" + (usageText() ? `\n${usageText()}` : ""));
    } else {
        startSync();
    }
});

// 次回更新までの秒数を表示
function renderCountdown() {
    if (!syncOn || !isRunning() || !isFinite(nextSyncAt) || nextSyncAt === 0) return;
    const sec = Math.max(0, Math.ceil((nextSyncAt - Date.now()) / 1000));
    setStatus([usageText(), `次回 ${sec}秒`].filter(Boolean).join("・"));
    $("bar-sync").textContent = `API: ON（次回 ${sec}秒）`;
}

// ==== パーツの配置（移動・大きさ変更・保存） ====
const PART_IDS = ["part-timer", "part-half", "part-score"];

// 初期配置の基準にする画面サイズと文字の大きさ
const DEFAULT_BASE = { w: 1280, h: 720 };
const DEFAULT_FONT = { "part-timer": 120, "part-half": 28, "part-score": 48 };
const DEFAULT_TOP = 70;

// 配置を決めたときの画面サイズ(base)から今の画面サイズへの倍率。
// 縦横どちらかが小さくなったら、はみ出さないよう小さいほうに合わせる
function layoutScale(base) {
    return Math.min(window.innerWidth / base.w, window.innerHeight / base.h);
}

// 1つでも動かしたら、ほかのパーツがつられて動かないよう3つとも保存する。
// 今の画面サイズも一緒に保存し、画面の大きさが変わったら同じ比率で拡大・縮小する
function saveParts() {
    state.layoutBase = { w: window.innerWidth, h: window.innerHeight };
    state.parts = {};
    PART_IDS.forEach(id => {
        const el = $(id);
        state.parts[id] = {
            left: el.offsetLeft,
            top: el.offsetTop,
            fontSize: parseFloat(el.style.fontSize || window.getComputedStyle(el).fontSize)
        };
    });
    saveState();
}

function hasSavedLayout() {
    const saved = state.parts || {};
    return PART_IDS.every(id => saved[id]);
}

// 保存された配置を今の画面サイズに合わせて反映（左右は中央を保つ）。
// 保存がなければ、上からタイマー・前後半・スコアの順に中央へ並べる
function applyLayout() {
    if (hasSavedLayout()) {
        const base = state.layoutBase || { w: window.innerWidth, h: window.innerHeight };
        const s = layoutScale(base);
        const offsetX = (window.innerWidth - base.w * s) / 2;
        PART_IDS.forEach(id => {
            const el = $(id);
            const p = state.parts[id];
            el.style.fontSize = (parseFloat(p.fontSize) * s) + "px";
            el.style.left = (offsetX + p.left * s) + "px";
            el.style.top = (p.top * s) + "px";
        });
        return;
    }

    const s = layoutScale(DEFAULT_BASE);
    let nextTop = DEFAULT_TOP * s;
    PART_IDS.forEach(id => {
        const el = $(id);
        el.style.fontSize = (DEFAULT_FONT[id] * s) + "px";
        el.style.left = Math.max(0, (window.innerWidth - el.offsetWidth) / 2) + "px";
        el.style.top = nextTop + "px";
        nextTop = el.offsetTop + el.offsetHeight;
    });
}

// 画面（ブラウザや OBS のソース）の大きさが変わったら配置を合わせ直す
let resizeFrame = null;
window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(applyLayout);
});

// 大きさを変えた後などに、3つのパーツを左右の中央にそろえる。
// 上下は今の並び順のまま、いちばん上のパーツを基準に、すき間なく詰めて並べる
const CENTER_GAP = 0;

function centerParts() {
    const parts = PART_IDS.map(id => $(id)).sort((a, b) => a.offsetTop - b.offsetTop);
    let prevBottom = null;
    parts.forEach(el => {
        el.style.left = Math.max(0, (window.innerWidth - el.offsetWidth) / 2) + "px";
        if (prevBottom !== null) {
            el.style.top = (prevBottom + CENTER_GAP) + "px";
        }
        prevBottom = el.offsetTop + el.offsetHeight;
    });
    saveParts();
}

function resetLayout() {
    state.parts = {};
    state.layoutBase = null;
    saveState();
    applyLayout();
}

// ==== 配置編集モード ====
// サイドバーを閉じた状態で、パーツ全体をドラッグして移動できるようにする
const EDITABLE_IDS = ["timer", "home-name", "away-name"];

function isLayoutEdit() {
    return document.body.classList.contains("layout-edit");
}

function startLayoutEdit() {
    if ($("menu").classList.contains("open")) toggleMenu();
    if (document.activeElement) document.activeElement.blur();
    // 編集中はドラッグで文字が選択・入力されないよう、直接入力を止める
    EDITABLE_IDS.forEach(id => $(id).setAttribute("contenteditable", "false"));
    document.body.classList.add("layout-edit");
}

function endLayoutEdit() {
    EDITABLE_IDS.forEach(id => $(id).setAttribute("contenteditable", "true"));
    document.body.classList.remove("layout-edit");
}

// 移動（パーツ全体）と大きさ変更（右下の四角。既存タイマーと同じ操作）
let dragMode = null;   // "move" または "resize"
let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;
let startFontSize = 0;
let targetElement = null;

PART_IDS.forEach(id => {
    $(id).addEventListener("mousedown", (e) => {
        if (!isLayoutEdit() || e.target.closest(".resizer")) return;
        dragMode = "move";
        targetElement = $(id);
        startX = e.clientX;
        startY = e.clientY;
        startLeft = targetElement.offsetLeft;
        startTop = targetElement.offsetTop;
        e.preventDefault();
    });
});

document.querySelectorAll('.resizer').forEach(resizerEl => {
    resizerEl.addEventListener("mousedown", (e) => {
        dragMode = "resize";
        targetElement = document.getElementById(resizerEl.dataset.target);
        startX = e.clientX;
        startY = e.clientY;
        startFontSize = parseFloat(window.getComputedStyle(targetElement).fontSize);
        e.preventDefault();
    });
});

document.addEventListener("mousemove", (e) => {
    if (!dragMode || !targetElement) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dragMode === "move") {
        // 画面の外に出して見失わないよう、少なくとも一部は画面内に残す
        const maxLeft = window.innerWidth - 40;
        const maxTop = window.innerHeight - 40;
        targetElement.style.left = Math.min(maxLeft, Math.max(0, startLeft + dx)) + "px";
        targetElement.style.top = Math.min(maxTop, Math.max(0, startTop + dy)) + "px";
    } else {
        const newSize = Math.max(12, startFontSize + (dx + dy) / 2);
        targetElement.style.fontSize = newSize + "px";
    }
});

document.addEventListener("mouseup", () => {
    if (dragMode && targetElement) saveParts();
    dragMode = null;
    targetElement = null;
});

// ==== 起動 ====
loadState();
if (state.darkMode) document.body.classList.add("dark-mode");
renderSelectedMatch();
renderLogo();
renderBar();
renderBoard();
renderTimer();
applyLayout();

setInterval(() => {
    renderTimer();
    syncTick();
    renderCountdown();
}, 1000);
