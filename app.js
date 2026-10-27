import { renderTeamCard, makeEventRow } from "./components.js";
import {
  canScore, getCourtPlayerCount, getCurrentLineup, getDecidingSetCourtChangePoint, getDefaultSetTargets, getEventDescription, getScore, getSetResult, getSetTarget, getSetWins, getServingState, isMatchComplete, usesCourtRotation,
} from "./score.js";
import { parseRosterText, recognizeRosterImage } from "./roster-import.js";
import {
  buildStore, createEmptyMatch, createId, createTeamCode, describePlayerRole, MAX_MATCHES, PLAYER_POSITIONS, readStore, sortPlayersByNumber, UNIFORM_COLOR_PRESETS, validateImport, validateRulePlugin, validateStoreImport, writeStore,
} from "./storage.js";
import {
  createQualityEventMatch, createQualityMatch, createQualityStressRecords, deleteQualityDatabase,
  isQualityMatchValid, openQualityDatabase, readQualityRecords, searchQualityRecords, writeQualityRecords,
} from "./quality-assurance.js";

const byId = (id) => document.getElementById(id);
const MAX_STORE_BACKUP_BYTES = 200_000_000;
const MAX_LIBEROS = 2;
const MAX_ROSTER_PHOTO_BYTES = 25_000_000;
let photoReadInProgress = false;
const elements = {
  saveStatus: byId("save-status"),
  history: byId("match-history"),
  error: byId("error-banner"),
  teamCards: [byId("team-a-card"), byId("team-b-card")],
  scoreboard: byId("scoreboard"),
  setStrip: byId("set-strip"),
  state: byId("match-state"),
  nextSet: byId("next-set"),
  eventLog: byId("event-log"),
  emptyLog: byId("empty-log"),
  timeoutActions: byId("timeout-actions"),
  timer: byId("match-timer"),
  announcer: byId("live-announcer"),
  scoreDialog: byId("score-detail-dialog"),
};
const infoFields = {
  tournamentName: "tournament-name",
  matchDate: "match-date",
  venue: "venue",
  venueAddress: "venue-address",
  court: "court",
  matchNumber: "match-number",
  round: "round",
  scheduledTime: "scheduled-time",
};
const ruleFields = {
  matchProfile: "match-profile",
  category: "category",
  division: "division",
  bestOf: "best-of",
  winBy: "win-by",
  timeoutLimit: "timeout-limit",
  substitutionLimit: "substitution-limit",
  technicalTimeoutPoint1: "technical-timeout-point-1",
  technicalTimeoutPoint2: "technical-timeout-point-2",
  rosterLimit: "roster-limit",
  warmupMinutes: "warmup-minutes",
  note: "rules-note",
};
const setTargetFields = [1, 2, 3, 4, 5].map((number) => `set-target-${number}`);
const courtChangeSetFields = [1, 2, 3, 4].map((number) => `court-change-set-${number}`);
const officialRoles = [
  ["firstReferee", "ファーストレフェリー"],
  ["secondReferee", "セカンドレフェリー"],
  ["thirdReferee", "サードレフェリー"],
  ["challengeReferee", "チャレンジレフェリー"],
  ["scorer", "スコアラー"],
  ["assistantScorer", "アシスタントスコアラー"],
  ["lineJudge1", "ラインジャッジ1"],
  ["lineJudge2", "ラインジャッジ2"],
  ["lineJudge3", "ラインジャッジ3"],
  ["lineJudge4", "ラインジャッジ4"],
];
const rallyKinds = ["serve", "reception", "serveReception", "attackReception", "set", "attack", "backAttack", "block", "error", "other"];
const rallyOutcomes = ["success", "point", "error", "touch", "effective", "excellent", "good", "other"];
const builtInRuleProfiles = {
  standard: { id: "standard", name: "標準（6人制・一般）", settings: { matchProfile: "six", category: "一般", division: "男子", bestOf: 5, regularTarget: 25, finalTarget: 15 } },
  "high-school-boys": { id: "high-school-boys", name: "高校男子", settings: { matchProfile: "six", category: "高校", division: "男子", bestOf: 3, regularTarget: 25, finalTarget: 15, rosterLimit: 18 } },
  "high-school-girls": { id: "high-school-girls", name: "高校女子", settings: { matchProfile: "six", category: "高校", division: "女子", bestOf: 3, regularTarget: 25, finalTarget: 15, rosterLimit: 18 } },
  "middle-school-boys": { id: "middle-school-boys", name: "中学男子", settings: { matchProfile: "six", category: "中学校", division: "男子", bestOf: 3, regularTarget: 25, finalTarget: 15, rosterLimit: 18 } },
  "middle-school-girls": { id: "middle-school-girls", name: "中学女子", settings: { matchProfile: "six", category: "中学校", division: "女子", bestOf: 3, regularTarget: 25, finalTarget: 15, rosterLimit: 18 } },
  beach: { id: "beach", name: "ビーチ", settings: { matchProfile: "beach", category: "一般", division: "混合", bestOf: 3, regularTarget: 21, finalTarget: 15, rosterLimit: 2, rotationEnabled: false } },
};
let pendingScoreTeamId;

let store;
let currentMatch;
let pendingSetSetup = null;
let saveTimer;
let dirty = false;
let saveRevision = 0;
let persistenceQueue = Promise.resolve();
let storageRecoveryRequired = false;
let matchTimerInterval;
let finishChecklistExpanded = false;
let tournamentNotice = "";
let editingTournamentResult = null;
let editingTournamentFixture = null;
let scoreTimelineInterval;
let matchReplayInterval;
let activeVideoFileName = "";
let activeVideoUrl = "";
let videoPlaybackQueue = [];
let videoPlaybackQueueIndex = -1;
let developerModeEnabled = false;
let qualityRunActive = false;
let lastQualityReport = null;
let pendingStoreBackup = null;
const autoPreparedTournamentReports = new Set();
let refereeQuestionOffset = 0;

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function getMatchLabel(match = currentMatch) {
  return `${match.matchInfo.tournamentName || "大会未設定"} / ${match.teams.map((team) => team.name).join(" vs ")}`;
}

function recordAudit(action, entity, details, setNumber, match = currentMatch) {
  if (!store || !match) return;
  const entry = {
    id: createId(),
    time: new Date().toISOString(),
    matchId: match.id,
    matchName: getMatchLabel(match).slice(0, 160),
    action,
    entity,
    details: String(details).slice(0, 240),
    ...(setNumber ? { setNumber } : {}),
  };
  store.auditLog.unshift(entry);
  store.auditLog = store.auditLog.slice(0, 1_000_000);
}

function applyRuleProfile(profile) {
  if (storageRecoveryRequired) {
    populateForm();
    showError("保存データの復旧が必要なため、ルール設定を変更できません。先にバックアップを読み込んでください。");
    return;
  }
  if (matchHasStarted()) {
    populateForm();
    showError("試合開始後はテンプレートやルール設定を変更できません。");
    return;
  }
  const { settings } = profile;
  const rules = currentMatch.rules;
  Object.assign(rules, {
    matchProfile: "six",
    category: "一般",
    division: "男子",
    bestOf: 5,
    regularTarget: 25,
    finalTarget: 15,
    winBy: 2,
    timeoutLimit: 2,
    substitutionLimit: 6,
    rosterLimit: 30,
    rotationEnabled: true,
    warmupMinutes: 10,
    courtChangeInterval: 8,
    technicalTimeoutPoints: [0, 0],
  });
  Object.entries(settings).forEach(([key, value]) => {
    if (key === "technicalTimeoutPoints") rules.technicalTimeoutPoints = [...value];
    else rules[key] = value;
  });
  rules.pluginId = profile.id;
  rules.bestOf = rules.matchProfile === "beach" || ["six-elementary", "nine", "soft"].includes(rules.matchProfile)
    ? 3 : rules.bestOf;
  rules.rotationEnabled = rules.matchProfile === "six"
    && rules.category !== "小学生" && rules.rotationEnabled;
  const defaults = getDefaultSetTargets(rules.matchProfile, rules.bestOf);
  rules.setTargets = defaults.map((value, index) =>
    index === rules.bestOf - 1 ? settings.finalTarget ?? value : settings.regularTarget ?? value);
  rules.regularTarget = rules.setTargets[0];
  rules.finalTarget = rules.setTargets[rules.bestOf - 1];
  rules.courtChangeSets = rules.matchProfile === "beach"
    ? [] : [1, 2, 3, 4].filter((setNumber) => setNumber < rules.bestOf);
  byId("rule-plugin-select").value = profile.id;
  byId("competition-template").value = Object.hasOwn(builtInRuleProfiles, profile.id) ? profile.id : "";
  populateForm();
  render();
  scheduleSave(true);
  clearError();
}

function renderRulePluginOptions() {
  const select = byId("rule-plugin-select");
  const selectedId = currentMatch.rules.pluginId || "standard";
  select.replaceChildren();
  [...Object.values(builtInRuleProfiles), ...store.plugins].forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.append(option);
  });
  if (![...Object.values(builtInRuleProfiles), ...store.plugins].some((profile) => profile.id === selectedId)) {
    const option = document.createElement("option");
    option.value = selectedId;
    option.textContent = "保存済み試合のルール";
    select.append(option);
  }
  select.value = selectedId;
  const selectedPluginIsLocal = store.plugins.some((profile) => profile.id === selectedId);
  byId("delete-rule-plugin").disabled = !selectedPluginIsLocal;
  byId("export-rule-plugin").disabled = !selectedPluginIsLocal;
}

async function importRulePlugin() {
  if (storageRecoveryRequired) {
    showError("保存データの復旧が必要なため、ルール設定を読み込めません。先にバックアップを読み込んでください。");
    return;
  }
  const file = byId("rule-plugin-file").files?.[0];
  if (!file) {
    showError("読み込むルール設定ファイルを選択してください。");
    return;
  }
  if (file.size > 20_000) {
    showError("ルール設定ファイルは20,000バイト以内にしてください。");
    return;
  }
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch (error) {
    showError(`設定ファイルを読み込めません: ${error.message}`);
    return;
  }
  if (!validateRulePlugin(profile) || Object.hasOwn(builtInRuleProfiles, profile.id)) {
    showError("設定ファイルの形式が正しくありません。アプリから出力したローカルルール設定ファイルを選んでください。");
    return;
  }
  if (store.plugins.length >= 100 && !store.plugins.some((item) => item.id === profile.id)) {
    showError("ローカルルールは100件まで登録できます。不要な設定を削除してから読み込んでください。");
    return;
  }
  store.plugins = [...store.plugins.filter((item) => item.id !== profile.id), profile].slice(0, 100);
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  renderRulePluginOptions();
  byId("rule-plugin-file").value = "";
  if (matchHasStarted()) {
    scheduleSave(true);
    showError("ルール設定を読み込みました。進行中の試合には適用されないため、次の試合で選択してください。");
    return;
  }
  applyRuleProfile(profile);
}

function registerRulePluginFromForm() {
  if (storageRecoveryRequired) {
    showError("保存データの復旧が必要なため、ローカルルールを登録できません。先にバックアップを読み込んでください。");
    return;
  }
  if (matchHasStarted()) {
    showError("試合開始後はローカルルールを登録できません。次の試合で登録してください。");
    return;
  }
  const name = byId("rule-plugin-name").value.trim().slice(0, 60);
  if (!name) {
    showError("ローカルルールの設定名を入力してください。");
    byId("rule-plugin-name").focus();
    return;
  }
  const numericSettings = [
    ["regularTarget", "rule-plugin-regular-target"],
    ["finalTarget", "rule-plugin-final-target"],
    ["winBy", "rule-plugin-win-by"],
    ["timeoutLimit", "rule-plugin-timeout-limit"],
    ["substitutionLimit", "rule-plugin-substitution-limit"],
    ["rosterLimit", "rule-plugin-roster-limit"],
    ["warmupMinutes", "rule-plugin-warmup-minutes"],
    ["courtChangeInterval", "rule-plugin-court-change-interval"],
  ];
  const settings = {
    matchProfile: byId("rule-plugin-match-profile").value,
    category: byId("rule-plugin-category").value,
    division: byId("rule-plugin-division").value,
    bestOf: Number(byId("rule-plugin-best-of").value),
    rotationEnabled: byId("rule-plugin-rotation-enabled").checked,
    technicalTimeoutPoints: [
      Number(byId("rule-plugin-technical-timeout-1").value),
      Number(byId("rule-plugin-technical-timeout-2").value),
    ],
  };
  numericSettings.forEach(([key, id]) => {
    settings[key] = Number(byId(id).value);
  });
  let id = `local-${Date.now().toString(36)}`;
  while (store.plugins.some((item) => item.id === id)) id = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const profile = { id, name, settings };
  if (!validateRulePlugin(profile)) {
    showError("入力された設定値に誤りがあります。各項目の範囲を確認してください。");
    return;
  }
  if (store.plugins.length >= 100) {
    showError("ローカルルールは100件まで登録できます。不要な設定を削除してから登録してください。");
    return;
  }
  store.plugins = [...store.plugins, profile];
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  renderRulePluginOptions();
  applyRuleProfile(profile);
  byId("rule-plugin-name").value = "";
  clearError();
}

function deleteRulePlugin() {
  if (storageRecoveryRequired) {
    showError("保存データの復旧が必要なため、ルール設定を削除できません。先にバックアップを読み込んでください。");
    return;
  }
  const pluginId = byId("rule-plugin-select").value;
  const profile = store.plugins.find((item) => item.id === pluginId);
  if (!profile) return;
  store.plugins = store.plugins.filter((item) => item.id !== pluginId);
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  renderRulePluginOptions();
  scheduleSave(true);
}

function exportRulePlugin() {
  const plugin = store.plugins.find((item) => item.id === byId("rule-plugin-select").value);
  if (!plugin) return;
  downloadJsonData(plugin, `${plugin.id}.json`);
}

function renderAuditLog() {
  const container = byId("audit-log-table");
  container.replaceChildren();
  const entries = store.auditLog.slice(0, 1_000);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "監査ログはまだありません。試合イベントや選手の追加・削除が記録されます。";
    container.append(empty);
    return;
  }
  const rows = entries.map((entry) => [
    new Date(entry.time).toLocaleString("ja-JP"),
    entry.matchName,
    entry.action === "add" ? "追加" : entry.action === "edit" ? "訂正" : "削除",
    entry.entity,
    entry.details,
  ]);
  if (store.auditLog.length > entries.length) {
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = `最新1,000件を表示中（全${store.auditLog.length.toLocaleString("ja-JP")}件。全件はJSONで書き出せます）。`;
    container.append(notice);
  }
  container.append(makeTable(["日時", "試合", "操作", "対象", "内容"], rows, "audit-log-table"));
}

function recordNinePlayerServeFault() {
  if (!canScore(currentMatch) || currentMatch.rules.matchProfile !== "nine") return;
  const servingState = getServingState(currentMatch, currentSet());
  const attempt = servingState.serveFaults + 1;
  if (attempt > 2) return;
  addEvent({
    type: "serve-fault",
    teamId: servingState.server,
    attempt,
    playerId: getExpectedServerPlayerId(currentSet(), servingState) || null,
  });
  if (attempt === 2) {
    const receivingTeam = currentMatch.teams.find((team) => team.id !== servingState.server);
    addEvent({
      type: "score",
      teamId: receivingTeam.id,
      delta: 1,
      playType: "other",
      playerId: null,
      faultPlayerId: null,
      note: "9人制サーブ2回目失敗",
      rotationAdvanced: true,
    });
  }
}
for (const [id, teamIndex, role] of [
  ["team-color-setup-a", 0, "players"], ["team-libero-color-setup-a", 0, "libero"],
  ["team-color-setup-b", 1, "players"], ["team-libero-color-setup-b", 1, "libero"],
]) {
  byId(id).addEventListener("input", (event) => updateTeamColor(currentMatch.teams[teamIndex].id, event.target.value, role));
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}

function setSaveStatus(text) {
  elements.saveStatus.textContent = text;
}

function currentSet() {
  return currentMatch.sets.at(-1);
}

function getCourtChangeSets() {
  return currentMatch.rules.courtChangeSets.filter((setNumber) => setNumber < currentMatch.rules.bestOf);
}

function getExpectedServerPlayerId(set, state = getServingState(currentMatch, set)) {
  const lineup = getCurrentLineup(currentMatch, set, state.server);
  if (!lineup.length) return "";
  const slot = usesCourtRotation(currentMatch)
    ? 0
    : Math.max(0, state.serviceTurns[state.server] - 1) % lineup.length;
  return lineup[slot] || "";
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function getElapsed(startedAt, endedAt = "") {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return formatElapsed(end - start);
}

function getSetSubstitutionCount(set, teamId, type) {
  return set.events.filter((event) => event.type === type && event.teamId === teamId).length;
}

function matchHasStarted() {
  return Boolean(currentMatch.matchInfo.startedAt)
    || currentMatch.sets.some((set) => set.events.length > 0);
}

function updateBestOf(selectedBestOf, matchProfile = currentMatch.rules.matchProfile) {
  currentMatch.rules.bestOf = selectedBestOf;
  setTargetFields.forEach((id, index) => {
    byId(id).value = String(getDefaultSetTargets(matchProfile, selectedBestOf)[index]);
  });
  syncSetCountVisibility();
}

function syncSetCountVisibility() {
  courtChangeSetFields.forEach((id, index) => {
    byId(id).closest("label").hidden = index + 1 >= currentMatch.rules.bestOf;
  });
  setTargetFields.forEach((id, index) => {
    byId(id).closest("label").hidden = index >= currentMatch.rules.bestOf;
  });
}

function getTeam(teamId) {
  return currentMatch.teams.find((team) => team.id === teamId);
}

function getTeamDisplayColor(team) {
  return team?.uniformColor || "#1d4ed8";
}

function getLiberoDisplayColor(team) {
  return team?.liberoUniformColor || "#facc15";
}

function applyTeamColors() {
  currentMatch.teams.forEach((team, index) => {
    const regularColor = /^#[\da-f]{6}$/i.test(getTeamDisplayColor(team))
      ? getTeamDisplayColor(team) : (index === 0 ? "#1d4ed8" : "#f97316");
    const liberoColor = /^#[\da-f]{6}$/i.test(getLiberoDisplayColor(team))
      ? getLiberoDisplayColor(team) : (index === 0 ? "#facc15" : "#22c55e");
    const className = index === 0 ? "team-a" : "team-b";
    document.querySelectorAll(`.${className}`).forEach((element) => {
      element.style.setProperty("--team-accent", regularColor);
      element.style.setProperty("--libero-accent", liberoColor);
    });
  });
}

function updateTeamColor(teamId, color, role = "players") {
  const team = getTeam(teamId);
  if (!team || !["players", "libero"].includes(role) || !/^#[\da-f]{6}$/i.test(color)) {
    showError("ユニフォーム色を正しく選択してください。");
    return;
  }
  if (role === "libero") team.liberoUniformColor = color;
  else team.uniformColor = color;
  const teamIndex = currentMatch.teams.indexOf(team);
  const suffix = teamIndex === 0 ? "a" : "b";
  const setupColor = byId(`team-${role === "libero" ? "libero-" : ""}color-setup-${suffix}`);
  if (setupColor) setupColor.value = color;
  document.querySelectorAll("select[data-team-color-preset]").forEach((select) => {
    if (select.dataset.teamColor === teamId && select.dataset.teamColorRole === role) {
      select.value = UNIFORM_COLOR_PRESETS.some(([preset]) => preset === color.toLowerCase())
        ? color.toLowerCase() : "custom";
    }
  });
  document.querySelectorAll("input[data-team-color]").forEach((input) => {
    if (input.dataset.teamColor === teamId && input.dataset.teamColorRole === role) input.value = color;
  });
  renderPrintableScoreSheet();
  applyTeamColors();
  scheduleSave();
}

function getCourtPlayers(teamId) {
  const team = getTeam(teamId);
  if (!team) return [];
  const set = currentSet();
  const lineup = getCurrentLineup(currentMatch, set, teamId);
  const activeIds = lineup.filter(Boolean);
  return team.players.filter((player) => activeIds.includes(player.id));
}

async function persistNow() {
  clearTimeout(saveTimer);
  if (!currentMatch) return;
  if (storageRecoveryRequired) {
    dirty = true;
    setSaveStatus("保存待ち");
    showError("既存の保存データを読み込めないため、自動保存を停止しています。正しいバックアップを読み込むか、新しい試合を作成して保存データを置き換えてください。");
    return;
  }
  currentMatch.updatedAt = new Date().toISOString();
  // 現在の試合を履歴の先頭へ置き、IDが同じ古いコピーは置き換えます。
  store.matches = [currentMatch, ...store.matches.filter((match) => match.id !== currentMatch.id)];
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  if (invalidatedFixtures.length) {
    tournamentNotice = `上位試合の結果・登録変更により、次の対戦試合を大会から外しました（試合履歴は保持されています）。再作成してください: ${invalidatedFixtures.join("、")}`;
  }
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  const snapshot = structuredClone(store);
  const revision = saveRevision;
  const write = persistenceQueue.then(() => writeStore(snapshot));
  persistenceQueue = write.then(() => undefined, () => undefined);
  try {
    await write;
    if (revision === saveRevision) {
      dirty = false;
      clearError();
      setSaveStatus(`保存済み ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
    }
    renderHistory();
    renderVisibleSupplementalViews();
    if (invalidatedFixtures.length) showError(tournamentNotice);
  } catch (error) {
    dirty = true;
    setSaveStatus("保存エラー");
    showError(error.message);
  }
}

function scheduleSave(immediate = false) {
  dirty = true;
  saveRevision += 1;
  setSaveStatus("保存中…");
  clearTimeout(saveTimer);
  if (immediate) persistNow();
  else saveTimer = setTimeout(persistNow, 250);
}

function updateFromForm() {
  const originalRules = JSON.stringify({ ...currentMatch.rules, pluginId: "" });
  for (const [key, id] of Object.entries(infoFields)) {
    const maxLength = key === "tournamentName" || key === "venue" ? 80 : key === "venueAddress" ? 120 : 60;
    currentMatch.matchInfo[key] = byId(id).value.trim().slice(0, maxLength);
  }
  for (const [key, id] of Object.entries(ruleFields)) {
    if (key === "bestOf" || key.startsWith("technicalTimeoutPoint")) continue;
    const input = byId(id);
    if (input.type === "number") {
      const number = Number(input.value);
      const min = Number(input.min);
      const max = Number(input.max);
      if (!Number.isInteger(number) || number < min || number > max) {
        showError(`${input.labels[0]?.textContent.trim() || key}は${min}〜${max}の整数で入力してください。`);
        return;
      }
      currentMatch.rules[key] = number;
    } else {
      currentMatch.rules[key] = input.value;
    }
  }
  currentMatch.rules.technicalTimeoutPoints = [
    byId("technical-timeout-point-1").value,
    byId("technical-timeout-point-2").value,
  ].map(Number);
  if (!currentMatch.rules.technicalTimeoutPoints.every((point) => Number.isInteger(point) && point >= 0 && point <= 99)) {
    showError("テクニカルタイムアウト発生点は0〜99の整数で入力してください。");
    return;
  }
  const restrictedToThreeSets = ["six-elementary", "nine", "beach", "soft"].includes(currentMatch.rules.matchProfile);
  const adjustedBestOf = restrictedToThreeSets && Number(byId("best-of").value) !== 3;
  if (adjustedBestOf) {
    byId("best-of").value = "3";
    updateBestOf(3, currentMatch.rules.matchProfile);
  }
  currentMatch.rules.rotationEnabled = currentMatch.rules.matchProfile === "six"
    && currentMatch.rules.category !== "小学生"
    && byId("rotation-enabled").checked;
  currentMatch.rules.courtChangeSets = courtChangeSetFields
    .map((id, index) => byId(id).checked ? index + 1 : null)
    .filter((setNumber) => setNumber !== null);
  currentMatch.rules.setTargets = setTargetFields.map((id) => Number(byId(id).value));
  const invalidTarget = currentMatch.rules.setTargets.findIndex((target) => !Number.isInteger(target) || target < 1 || target > 99);
  if (invalidTarget >= 0) {
    showError(`第${invalidTarget + 1}セットの目標点を1〜99の整数で入力してください。`);
    return;
  }
  currentMatch.rules.regularTarget = currentMatch.rules.setTargets[0];
  currentMatch.rules.finalTarget = currentMatch.rules.setTargets[currentMatch.rules.bestOf - 1];
  if (JSON.stringify({ ...currentMatch.rules, pluginId: "" }) !== originalRules) {
    currentMatch.rules.pluginId = "custom";
  }
  if (adjustedBestOf) showError("この競技形式は3セットマッチのみのため、試合方式を3セットマッチにしました。");
  else clearError();
  renderCurrentPageSummaries();
  scheduleSave();
}

function populateForm() {
  renderRulePluginOptions();
  byId("competition-template").value = Object.hasOwn(builtInRuleProfiles, currentMatch.rules.pluginId)
    ? currentMatch.rules.pluginId : "";
  for (const [key, id] of Object.entries(infoFields)) byId(id).value = currentMatch.matchInfo[key];
  for (const [key, id] of Object.entries(ruleFields)) {
    if (!key.startsWith("technicalTimeoutPoint")) byId(id).value = String(currentMatch.rules[key]);
  }
  byId("technical-timeout-point-1").value = String(currentMatch.rules.technicalTimeoutPoints[0]);
  byId("technical-timeout-point-2").value = String(currentMatch.rules.technicalTimeoutPoints[1]);
  byId("best-of").querySelector('option[value="5"]').disabled =
    ["six-elementary", "nine", "beach", "soft"].includes(currentMatch.rules.matchProfile);
  byId("rotation-enabled").checked = usesCourtRotation(currentMatch);
  syncSetCountVisibility();
  courtChangeSetFields.forEach((id, index) => {
    byId(id).checked = currentMatch.rules.courtChangeSets.includes(index + 1);
    byId(id).disabled = matchHasStarted() || index + 1 >= currentMatch.rules.bestOf;
  });
  setTargetFields.forEach((id, index) => {
    byId(id).value = String(currentMatch.rules.setTargets[index] ?? (index === currentMatch.rules.bestOf - 1 ? currentMatch.rules.finalTarget : currentMatch.rules.regularTarget));
    byId(id).disabled = index >= currentMatch.rules.bestOf;
  });
  officialRoles.forEach(([role]) => {
    byId(`official-name-${role}`).value = currentMatch.matchInfo.officials[role].name;
    byId(`official-area-${role}`).value = currentMatch.matchInfo.officials[role].area;
  });
  const locked = matchHasStarted();
  Object.values(ruleFields).forEach((id) => { byId(id).disabled = locked; });
  byId("team-name-setup-a").disabled = locked;
  byId("team-name-setup-b").disabled = locked;
  byId("team-code-a").disabled = locked;
  byId("team-code-b").disabled = locked;
  byId("team-color-setup-a").disabled = locked;
  byId("team-color-setup-b").disabled = locked;
  byId("team-libero-color-setup-a").disabled = locked;
  byId("team-libero-color-setup-b").disabled = locked;
  document.querySelectorAll("select[data-team-color-preset]").forEach((select) => {
    const teamIndex = select.id.endsWith("-a") ? 0 : select.id.endsWith("-b") ? 1 : -1;
    const team = teamIndex < 0 ? getTeam(select.dataset.teamColor) : currentMatch.teams[teamIndex];
    if (!team) return;
    const role = select.dataset.teamColorRole;
    const color = role === "libero"
      ? (team.liberoUniformColor || (teamIndex === 0 ? "#facc15" : "#22c55e"))
      : (team.uniformColor || (teamIndex === 0 ? "#1d4ed8" : "#f97316"));
    select.dataset.teamColor = team.id;
    if (!select.options.length) {
      select.append(new Option("色を選択", ""));
      UNIFORM_COLOR_PRESETS.forEach(([preset, name]) => select.append(new Option(name, preset)));
      select.append(new Option("その他（右で選択）", "custom"));
    }
    select.value = UNIFORM_COLOR_PRESETS.some(([preset]) => preset === color.toLowerCase())
      ? color.toLowerCase() : "custom";
    select.disabled = locked;
  });
  byId("rotation-enabled").disabled = locked || currentMatch.rules.matchProfile !== "six" || currentMatch.rules.category === "小学生";
  byId("team-name-setup-a").value = currentMatch.teams[0].name;
  byId("team-name-setup-b").value = currentMatch.teams[1].name;
  currentMatch.teams.forEach((team, index) => {
    if (!team.code) team.code = createTeamCode(team.name);
    byId(index === 0 ? "team-code-a" : "team-code-b").value = team.code;
  });
  byId("team-color-setup-a").value = currentMatch.teams[0].uniformColor || "#1d4ed8";
  byId("team-color-setup-b").value = currentMatch.teams[1].uniformColor || "#f97316";
  byId("team-libero-color-setup-a").value = currentMatch.teams[0].liberoUniformColor || "#facc15";
  byId("team-libero-color-setup-b").value = currentMatch.teams[1].liberoUniformColor || "#22c55e";
  ["a", "b"].forEach((suffix, index) => {
    document.querySelectorAll(`select[data-team-color-preset][id$="-setup-${suffix}"]`).forEach((select) => {
      select.dataset.teamColor = currentMatch.teams[index].id;
    });
  });
}

function renderHistory() {
  const selectedId = currentMatch?.id;
  const signature = JSON.stringify(store.matches.map((match) => [
    match.id,
    match.matchInfo.matchDate,
    match.teams.map((team) => team.name),
  ]));
  if (renderHistory.signature === signature && elements.history.value === (selectedId || "")) return;
  renderHistory.signature = signature;
  elements.history.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "保存済み試合を選択";
  elements.history.append(placeholder);
  for (const match of store.matches) {
    const option = document.createElement("option");
    option.value = match.id;
    const date = match.matchInfo.matchDate || "日付未設定";
    const teams = match.teams.map((team) => team.name || "チーム").join(" vs ");
    option.textContent = `${date} | ${teams}`;
    elements.history.append(option);
  }
  elements.history.value = selectedId || "";
}

function getSelectedTournament() {
  return store.tournaments.find((tournament) => tournament.id === byId("tournament-select").value);
}

function getTournamentTeamProfiles() {
  const profiles = new Map();
  store.teamProfiles.filter((profile) => profile.code).forEach((profile) => {
    const existing = profiles.get(profile.code);
    if (!existing || Date.parse(profile.savedAt) > Date.parse(existing.savedAt)) profiles.set(profile.code, profile);
  });
  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function fillTournamentTeamSelect(select, tournament, allowBye = false) {
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = allowBye ? "未設定（不戦勝）" : "チームを選択";
  select.append(placeholder);
  tournament.participants.forEach((participant) => {
    const option = document.createElement("option");
    option.value = participant.code;
    option.textContent = `${participant.code} / ${participant.name}`;
    select.append(option);
  });
}

function renderTournamentParticipants() {
  const container = byId("tournament-participant-options");
  const selectedCodes = new Set([...container.querySelectorAll("[data-tournament-participant]:checked")]
    .map((checkbox) => checkbox.value));
  container.replaceChildren();
  const profiles = getTournamentTeamProfiles();
  if (!profiles.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "メンバー登録画面でチームコードを入力し、チーム履歴を保存してください。";
    container.append(message);
    return;
  }
  profiles.forEach((profile) => {
    const label = document.createElement("label");
    label.className = "check-setting tournament-participant-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = profile.code;
    checkbox.dataset.tournamentParticipant = profile.code;
    checkbox.checked = selectedCodes.has(profile.code);
    const text = document.createElement("span");
    text.textContent = `${profile.code} / ${profile.name} (${profile.players.length}名)`;
    label.append(checkbox, text);
    container.append(label);
  });
}

function getRoundName(roundIndex, roundCount) {
  const remaining = roundCount - roundIndex;
  if (remaining === 1) return "決勝";
  if (remaining === 2) return "準決勝";
  if (remaining === 3) return "準々決勝";
  return `${remaining}回戦`;
}

function createTournamentFixtures(participants, format) {
  const fixtures = [];
  let matchIndex = 0;
  const addFixture = (fixture) => {
    fixtures.push({ id: createId(), matchIndex: matchIndex++, ...fixture });
    return fixtures.at(-1);
  };
  if (format === "single-elimination" || format === "both") {
    let size = 2;
    while (size < participants.length) size *= 2;
    const roundCount = Math.log2(size);
    const rounds = [];
    for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
      const roundFixtures = [];
      for (let index = 0; index < size / 2 ** (roundIndex + 1); index += 1) {
        if (roundIndex === 0) {
          const fixture = addFixture({
            phase: "bracket",
            roundIndex,
            roundName: getRoundName(roundIndex, roundCount),
            teamACode: "",
            teamAName: "",
            teamBCode: "",
            teamBName: "",
          });
          roundFixtures.push(fixture);
        } else {
          const sourcePair = rounds[roundIndex - 1].slice(index * 2, index * 2 + 2);
          roundFixtures.push(addFixture({
            phase: "bracket",
            roundIndex,
            roundName: getRoundName(roundIndex, roundCount),
            teamACode: "",
            teamAName: "",
            teamBCode: "",
            teamBName: "",
            sourceAId: sourcePair[0].id,
            sourceBId: sourcePair[1].id,
          }));
        }
      }
      rounds.push(roundFixtures);
    }
  }
  return fixtures;
}

function updateTournamentFixtures(match) {
  const invalidatedFixtures = [];
  store.tournaments.forEach((tournament) => {
    tournament.fixtures?.forEach((fixture) => {
      if (fixture.matchId === match.id) {
        const winningSetCount = getSetWins(match)
          .find((item) => item.wins > Math.floor(match.rules.bestOf / 2));
        const winnerTeam = isMatchComplete(match)
          ? match.teams.find((team) => team.id === winningSetCount?.teamId)
          : null;
        if (winnerTeam?.code) fixture.winnerCode = winnerTeam.code;
        else delete fixture.winnerCode;
      }
    });
    const fixtures = tournament.fixtures || [];
    const resolved = new Map();
    const bracketFixtures = fixtures
      .filter((fixture) => fixture.phase === "bracket")
      .sort((a, b) => a.roundIndex - b.roundIndex || a.matchIndex - b.matchIndex);
    bracketFixtures.forEach((fixture) => {
      if (fixture.roundIndex === 0) {
        const fixtureMatch = fixture.matchId === match.id
          ? match : store.matches.find((item) => item.id === fixture.matchId);
        resolved.set(fixture.id, Boolean(getTournamentFixtureWinner(fixture, fixtureMatch)));
        return;
      }
      const sourceA = fixtures.find((item) => item.id === fixture.sourceAId);
      const sourceB = fixtures.find((item) => item.id === fixture.sourceBId);
      const sourceAResolved = Boolean(sourceA && resolved.get(sourceA.id));
      const sourceBResolved = Boolean(sourceB && resolved.get(sourceB.id));
      const winnerA = sourceAResolved ? sourceA?.winnerCode || "" : "";
      const winnerB = sourceBResolved ? sourceB?.winnerCode || "" : "";
      const expectedCodes = [winnerA, winnerB];
      const assignedCodes = [fixture.teamACode || "", fixture.teamBCode || ""];
      const fixtureMatch = fixture.matchId === match.id
        ? match : store.matches.find((item) => item.id === fixture.matchId);
      const actualCodes = fixtureMatch?.teams.map((team) => team.code || "") || assignedCodes;
      const matchupChanged = assignedCodes.some((code, index) => code !== expectedCodes[index])
        || actualCodes.some((code, index) => code && code !== expectedCodes[index]);
      if ((fixture.matchId || fixture.manualResult) && matchupChanged) {
        if (fixture.matchId) tournament.matchIds = tournament.matchIds.filter((id) => id !== fixture.matchId);
        invalidatedFixtures.push(`${fixture.roundName} ${assignedCodes.join(" vs ")}`);
        fixture.matchId = "";
        delete fixture.winnerCode;
        delete fixture.manualResult;
      }
      fixture.teamACode = winnerA;
      fixture.teamBCode = winnerB;
      fixture.teamAName = tournament.participants.find((item) => item.code === winnerA)?.name || "";
      fixture.teamBName = tournament.participants.find((item) => item.code === winnerB)?.name || "";
      if (winnerA && winnerB) {
        const currentFixtureMatch = fixture.matchId === match.id
          ? match : store.matches.find((item) => item.id === fixture.matchId);
        const winnerCode = getTournamentFixtureWinner(fixture, currentFixtureMatch);
        if (winnerCode) fixture.winnerCode = winnerCode;
        else delete fixture.winnerCode;
        resolved.set(fixture.id, Boolean(winnerCode));
      } else if ((winnerA || winnerB) && sourceAResolved && sourceBResolved) {
        fixture.winnerCode = winnerA || winnerB;
        resolved.set(fixture.id, true);
      } else {
        delete fixture.winnerCode;
        resolved.set(fixture.id, false);
      }
    });
  });
  return invalidatedFixtures;
}

function getTournamentFixtureWinner(fixture, match) {
  if (match && isMatchComplete(match)) {
    const winner = getSetWins(match).find((item) => item.wins > Math.floor(match.rules.bestOf / 2));
    return match.teams.find((team) => team.id === winner?.teamId)?.code || "";
  }
  const result = fixture.manualResult;
  if (!result) return fixture.winnerCode || "";
  const wins = { [fixture.teamACode]: 0, [fixture.teamBCode]: 0 };
  for (const set of result.sets) {
    if (set.teamA > set.teamB) wins[fixture.teamACode] += 1;
    else if (set.teamB > set.teamA) wins[fixture.teamBCode] += 1;
  }
  const needed = Math.floor(result.bestOf / 2) + 1;
  return Object.entries(wins).find(([, count]) => count >= needed)?.[0] || "";
}

function getSavedMatchesForAnalysis() {
  const matches = new Map(store.matches.map((match) => [match.id, match]));
  matches.set(currentMatch.id, currentMatch);
  return [...matches.values()].filter(isMatchComplete);
}

function getTeamTendencies(teamCode, teamName, matches) {
  const stats = emptyPlayStats();
  const rotationLosses = Array(9).fill(0);
  const lostPoints = new Map();
  let pointsConceded = 0;
  let latePointsConceded = 0;
  let timeoutPoints = 0;
  let timeoutOpportunities = 0;
  const sameTeam = (team) => teamCode
    ? team.code === teamCode || !team.code && team.name === teamName
    : !team.code && team.name === teamName;
  for (const match of matches) {
    const team = match.teams.find(sameTeam);
    if (!team) continue;
    const matchStats = getPerformanceStats(team, match.sets).total;
    for (const kind of Object.keys(stats)) {
      Object.keys(stats[kind]).forEach((key) => { stats[kind][key] += matchStats[kind][key]; });
    }
    const losses = getLostPointBreakdown(team.id, match.sets);
    for (const [label, count] of losses.breakdown) {
      lostPoints.set(label, (lostPoints.get(label) || 0) + count);
    }
    match.sets.forEach((set) => {
      let server = set.initialServiceTeamId;
      let rotation = 0;
      getEffectivePointEvents(set).forEach((event) => {
        if (event.teamId !== team.id) {
          pointsConceded += 1;
          if (server === team.id) rotationLosses[rotation % getCourtPlayerCount(match)] += 1;
          const scoreParts = (event.currentScore || "").split("-").map(Number);
          if (scoreParts.length === 2 && scoreParts.every(Number.isFinite)) {
            const ownIndex = match.teams[0].id === team.id ? 0 : 1;
            if (scoreParts[ownIndex] >= getSetTarget(match, set.number) - 5) latePointsConceded += 1;
          }
        }
        if (event.teamId !== server) {
          if (event.teamId === team.id) rotation += 1;
          server = event.teamId;
        }
      });
      set.events.forEach((event, index) => {
        if (event.type !== "timeout" || event.teamId !== team.id) return;
        const nextPoints = set.events.slice(index + 1).filter((item) =>
          item.type === "score" && item.delta > 0 && !item.correctionSource).slice(0, 3);
        if (!nextPoints.length) return;
        timeoutOpportunities += nextPoints.length;
        timeoutPoints += nextPoints.filter((item) => item.teamId === team.id).length;
      });
    });
  }
  return {
    stats,
    rotationLosses,
    lostPoints,
    pointsConceded,
    latePointsConceded,
    timeoutPoints,
    timeoutOpportunities,
  };
}

function renderMatchupComparison() {
  const container = byId("matchup-comparison");
  if (!container) return;
  container.replaceChildren();
  const [teamA, teamB] = currentMatch.teams;
  const history = getSavedMatchesForAnalysis().filter((match) => match.id !== currentMatch.id);
  const historicalMatchesFor = (team) => history.filter((match) => match.teams.some((item) =>
    team.code ? item.code === team.code || !item.code && item.name === team.name
      : !item.code && item.name === team.name));
  const summaries = [teamA, teamB].map((team) => ({
    team,
    tendencies: getTeamTendencies(team.code, team.name, historicalMatchesFor(team)),
    matchCount: historicalMatchesFor(team).length,
  }));
  const serveEffectiveness = (stats) => stats.serve.attempts
    ? `${(((stats.serve.points * 100) + ((stats.serve.effective + stats.serve.points) * 25)
      - (stats.serve.errors * 25)) / stats.serve.attempts).toFixed(1)}%`
    : "—";
  const rows = [
    ["分析対象（完了試合）", summaries[0].matchCount, summaries[1].matchCount],
    ["サーブ効果率", serveEffectiveness(summaries[0].tendencies.stats), serveEffectiveness(summaries[1].tendencies.stats)],
    ["レセプション成功率", getReceptionSuccessRate(summaries[0].tendencies.stats) === null
      ? "—" : `${getReceptionSuccessRate(summaries[0].tendencies.stats).toFixed(1)}%`,
    getReceptionSuccessRate(summaries[1].tendencies.stats) === null
      ? "—" : `${getReceptionSuccessRate(summaries[1].tendencies.stats).toFixed(1)}%`],
    ["ブロック得点", summaries[0].tendencies.stats.block.points, summaries[1].tendencies.stats.block.points],
    ["アタック決定率", formatPercentage(summaries[0].tendencies.stats.attack.points, summaries[0].tendencies.stats.attack.attempts),
      formatPercentage(summaries[1].tendencies.stats.attack.points, summaries[1].tendencies.stats.attack.attempts)],
  ];
  container.append(makeTable(["指標", teamA.name, teamB.name], rows, "match-analysis-table"));
}

function isTournamentParticipantTeam(team, participant) {
  if (participant.code && team.code) return team.code === participant.code;
  return team.name.trim().toLocaleLowerCase("ja") === participant.name.trim().toLocaleLowerCase("ja");
}

function matchContainsTournamentTeam(match, participant) {
  return match.teams.some((team) => isTournamentParticipantTeam(team, participant));
}

function fillAnalysisTeamSelect(select, tournament, placeholderText) {
  const previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = placeholderText;
  select.append(placeholder);
  tournament?.participants.forEach((participant) => {
    const option = document.createElement("option");
    option.value = participant.code;
    option.textContent = `${participant.name} (${participant.code})`;
    select.append(option);
  });
  if (tournament?.participants.some((participant) => participant.code === previous)) select.value = previous;
  else if (tournament?.participants[0]) select.value = tournament.participants[0].code;
}

function renderOpponentScouting(tournament) {
  const select = byId("opponent-scouting-team");
  const container = byId("opponent-scouting-results");
  fillAnalysisTeamSelect(select, tournament, "チームを選択");
  container.replaceChildren();
  const participant = tournament?.participants.find((item) => item.code === select.value);
  if (!participant) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "大会を選択すると、保存済み試合から相手チームの傾向を表示します。";
    container.append(empty);
    return;
  }
  const recent = getSavedMatchesForAnalysis().filter((match) => matchContainsTournamentTeam(match, participant))
    .sort((a, b) => (b.matchInfo.matchDate || "").localeCompare(a.matchInfo.matchDate || "")
      || (b.matchInfo.endedAt || "").localeCompare(a.matchInfo.endedAt || "")).slice(0, 10);
  const heading = document.createElement("p");
  heading.className = "stats-note";
  heading.textContent = `${participant.name} — 最近${recent.length}試合（完了試合）`;
  container.append(heading);
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "このチームの完了試合はまだありません。";
    container.append(empty);
    return;
  }
  let servePoints = 0;
  let attackPoints = 0;
  let attackAttempts = 0;
  let receptionExcellent = 0;
  let receptionGood = 0;
  let receptionAttempts = 0;
  let wins = 0;
  const rows = recent.map((match) => {
    const team = match.teams.find((item) => isTournamentParticipantTeam(item, participant));
    const opponent = match.teams.find((item) => item.id !== team.id);
    const stats = getPerformanceStats(team, match.sets).total;
    servePoints += stats.serve.points;
    attackPoints += stats.attack.points;
    attackAttempts += stats.attack.attempts;
    receptionExcellent += stats.reception.excellent;
    receptionGood += stats.reception.good;
    receptionAttempts += stats.reception.attempts;
    const won = getSetWins(match).find((item) => item.teamId === team.id)?.wins
      >= Math.floor(match.rules.bestOf / 2) + 1;
    if (won) wins += 1;
    const score = match.sets.filter((set) => getSetResult(match, set))
      .map((set) => `${getScore(set, team.id)}-${getScore(set, opponent.id)}`).join(" / ");
    return [match.matchInfo.matchDate || "日付不明", opponent.name, won ? "勝" : "敗", score || "—"];
  });
  container.append(makeTable(["日付", "対戦相手", "結果", "セット得点"], rows, "match-analysis-table"));
  const aggregateRows = [[
    "直近試合の勝敗", `${wins}勝${recent.length - wins}敗`,
    "平均サーブ得点", (servePoints / recent.length).toFixed(1),
    "アタック決定率", formatPercentage(attackPoints, attackAttempts),
    "レセプション成功率", receptionAttempts
      ? `${((receptionExcellent * 100 + receptionGood * 50) / receptionAttempts).toFixed(1)}%` : "—",
  ]];
  container.append(makeTable(["指標", "値", "指標", "値", "指標", "値", "指標", "値"], aggregateRows, "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "個人プレー記録がある保存済み完了試合のみ集計します。未記録の試合は傾向に反映されません。";
  container.append(note);
}

function renderHeadToHead(tournament) {
  const teamASelect = byId("head-to-head-team-a");
  const teamBSelect = byId("head-to-head-team-b");
  const container = byId("head-to-head-results");
  fillAnalysisTeamSelect(teamASelect, tournament, "チームAを選択");
  fillAnalysisTeamSelect(teamBSelect, tournament, "チームBを選択");
  if (teamASelect.value === teamBSelect.value && tournament?.participants.length > 1) {
    teamBSelect.value = tournament.participants.find((item) => item.code !== teamASelect.value)?.code || "";
  }
  container.replaceChildren();
  const participantA = tournament?.participants.find((item) => item.code === teamASelect.value);
  const participantB = tournament?.participants.find((item) => item.code === teamBSelect.value);
  if (!participantA || !participantB || participantA.code === participantB.code) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "過去対戦を表示するには、異なる2チームを選択してください。";
    container.append(empty);
    return;
  }
  const meetings = getSavedMatchesForAnalysis().filter((match) =>
    matchContainsTournamentTeam(match, participantA) && matchContainsTournamentTeam(match, participantB))
    .sort((a, b) => (b.matchInfo.matchDate || "").localeCompare(a.matchInfo.matchDate || ""));
  if (!meetings.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "保存済みの過去対戦はありません。";
    container.append(empty);
    return;
  }
  const rows = meetings.map((match) => {
    const teamA = match.teams.find((team) => isTournamentParticipantTeam(team, participantA));
    const teamB = match.teams.find((team) => team.id !== teamA.id);
    const winner = getSetWins(match).find((item) => item.wins >= Math.floor(match.rules.bestOf / 2) + 1);
    return [match.matchInfo.matchDate || "日付不明", `${teamA.name} vs ${teamB.name}`,
      match.sets.filter((set) => getSetResult(match, set))
        .map((set) => `${getScore(set, teamA.id)}-${getScore(set, teamB.id)}`).join(" / "),
      winner ? getTeamNameForMatch(match, winner.teamId) : "進行中"];
  });
  container.append(makeTable(["日付", "対戦", "セット得点", "勝者"], rows, "match-analysis-table"));
}

function getTeamNameForMatch(match, teamId) {
  return match.teams.find((team) => team.id === teamId)?.name || "不明";
}

function renderTournamentManagement() {
  const statusMessage = byId("tournament-status-message");
  statusMessage.textContent = tournamentNotice;
  statusMessage.hidden = !tournamentNotice;
  renderTournamentParticipants();
  const select = byId("tournament-select");
  const previousId = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = store.tournaments.length ? "大会を選択" : "大会はありません";
  select.append(placeholder);
  store.tournaments.forEach((tournament) => {
    const option = document.createElement("option");
    option.value = tournament.id;
    option.textContent = tournament.name;
    select.append(option);
  });
  if (store.tournaments.some((tournament) => tournament.id === previousId)) select.value = previousId;
  const courtSelect = byId("court-board-tournament");
  const previousCourtId = courtSelect.value;
  courtSelect.replaceChildren();
  const courtPlaceholder = document.createElement("option");
  courtPlaceholder.value = "";
  courtPlaceholder.textContent = store.tournaments.length ? "大会を選択" : "大会はありません";
  courtSelect.append(courtPlaceholder);
  store.tournaments.forEach((tournament) => {
    const option = document.createElement("option");
    option.value = tournament.id;
    option.textContent = tournament.name;
    courtSelect.append(option);
  });
  const selectedCourtId = store.tournaments.some((tournament) => tournament.id === previousCourtId)
    ? previousCourtId : select.value;
  courtSelect.value = selectedCourtId || "";
  const selected = getSelectedTournament();
  const list = byId("tournament-match-list");
  list.replaceChildren();
  byId("add-match-to-tournament").disabled = !selected;
  byId("delete-tournament").disabled = !selected;
  const manualLeagueControls = byId("manual-league-fixture-controls");
  const supportsLeagueFixtures = selected && ["round-robin", "both"].includes(selected.format);
  manualLeagueControls.hidden = !supportsLeagueFixtures;
  if (supportsLeagueFixtures) {
    fillTournamentTeamSelect(byId("manual-fixture-team-a"), selected);
    fillTournamentTeamSelect(byId("manual-fixture-team-b"), selected);
  }
  byId("print-tournament-report").disabled = !selected
    || selected.matchIds.length === 0 && !selected.fixtures?.some((fixture) =>
      fixture.matchId || fixture.manualResult?.sets.length);
  if (!selected) {
    byId("tournament-performance-summary").replaceChildren();
    byId("tournament-score-heatmap").replaceChildren();
    byId("gym-court-board").replaceChildren();
    const courtTournament = store.tournaments.find((item) => item.id === selectedCourtId);
    const courtMatches = courtTournament ? getTournamentMatches(courtTournament) : [];
    renderGymCourtBoard(byId("multi-court-board"), courtMatches);
    byId("referee-performance-summary").replaceChildren();
    byId("tournament-report-status").textContent = "";
    renderOpponentScouting(null);
    renderHeadToHead(null);
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = store.tournaments.length ? "管理する大会を選択してください。" : "大会を作成すると、試合を登録できます。";
    list.append(message);
    return;
  }
  const matches = [...new Set([
    ...selected.matchIds,
    ...(selected.fixtures || []).map((fixture) => fixture.matchId).filter(Boolean),
  ])]
    .map((id) => id === currentMatch.id ? currentMatch : store.matches.find((match) => match.id === id))
    .filter(Boolean);
  renderGymCourtBoard(byId("gym-court-board"), matches);
  const courtTournament = store.tournaments.find((item) => item.id === selectedCourtId);
  renderGymCourtBoard(byId("multi-court-board"), courtTournament ? getTournamentMatches(courtTournament) : matches);
  renderRefereePerformance(byId("referee-performance-summary"), matches);
  const reportReady = isTournamentComplete(selected, matches);
  byId("tournament-report-status").textContent = reportReady
    ? "大会終了：参加チーム・順位・全試合結果・個人成績・MVP・ベスト6を含む大会報告書を自動生成しました。印刷 / PDF 保存にはボタンを押してください。"
    : "大会進行中：登録済みの結果から大会報告書を随時作成できます。大会終了後は最終結果を反映して印刷 / PDF 保存してください。";
  if (reportReady && !autoPreparedTournamentReports.has(selected.id)) {
    renderPrintableScoreSheet();
    autoPreparedTournamentReports.add(selected.id);
  } else if (!reportReady) {
    autoPreparedTournamentReports.delete(selected.id);
  }
  if (!matches.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "この大会に登録された試合はありません。";
    list.append(message);
    renderTournamentFixtures(selected);
    return;
  }
  const rows = matches.map((match) => {
    const [teamA, teamB] = match.teams;
    const sets = match.sets.map((set) => `${getScore(set, teamA.id)}-${getScore(set, teamB.id)}`).join(" / ");
    const setWins = getSetWins(match);
    const winsA = setWins.find((item) => item.teamId === teamA.id)?.wins || 0;
    const winsB = setWins.find((item) => item.teamId === teamB.id)?.wins || 0;
    const winner = isMatchComplete(match)
      ? (winsA > winsB ? teamA.name : teamB.name)
      : "—";
    const hasStarted = match.sets.some((set) => set.startedAt || set.events.length > 0);
    const status = isMatchComplete(match) ? "終了" : hasStarted ? "進行中" : "未開始";
    return [
      match.matchInfo.matchDate || "日付未設定",
      match.matchInfo.round || "—",
      match.matchInfo.matchNumber || "—",
      `${teamA.name} vs ${teamB.name}`,
      sets || "—",
      winner,
      status,
      match.id,
    ];
  });
  const table = makeTable(["日付", "ラウンド", "試合番号", "対戦", "セット結果", "勝者", "状態", "操作"], rows, "tournament-match-table");
  table.querySelectorAll("tbody tr").forEach((row, index) => {
    const action = row.lastElementChild;
    action.textContent = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary";
    button.textContent = "登録解除";
    button.dataset.removeTournamentMatch = matches[index].id;
    action.append(button);
  });
  list.append(table);
  renderTournamentFixtures(selected);
}

function getTournamentMatches(tournament) {
  return [...new Set([
    ...tournament.matchIds,
    ...(tournament.fixtures || []).map((fixture) => fixture.matchId).filter(Boolean),
  ])]
    .map((id) => id === currentMatch.id ? currentMatch : store.matches.find((match) => match.id === id))
    .filter(Boolean);
}

function isTournamentComplete(tournament, matches) {
  const fixtures = tournament.fixtures || [];
  if (fixtures.length) {
    return fixtures.every((fixture) => {
      if (fixture.matchId) {
        const match = matches.find((item) => item.id === fixture.matchId)
          || store.matches.find((item) => item.id === fixture.matchId);
        return Boolean(match && isMatchComplete(match));
      }
      if (fixture.manualResult?.sets.length) return Boolean(getTournamentFixtureWinner(fixture, null));
      return Boolean(fixture.winnerCode);
    });
  }
  return matches.length > 0 && matches.every(isMatchComplete);
}

function renderGymCourtBoard(container, matches) {
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "体育館・コート別 試合進行";
  container.append(heading);
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "大会に試合を登録すると、コート別の進行状況を表示します。";
    container.append(empty);
    return;
  }
  const courts = new Map();
  matches.forEach((match) => {
    const venue = match.matchInfo.venue.trim() || "会場未設定";
    const court = match.matchInfo.court.trim() || "コート未設定";
    const key = `${venue}\u0000${court}`;
    if (!courts.has(key)) courts.set(key, { venue, court, matches: [] });
    courts.get(key).matches.push(match);
  });
  [...courts.values()].sort((a, b) => a.venue.localeCompare(b.venue, "ja") || a.court.localeCompare(b.court, "ja"))
    .forEach(({ venue, court, matches: courtMatches }) => {
      const courtHeading = document.createElement("h4");
      courtHeading.textContent = `${venue} / ${court}`;
      const rows = [...courtMatches].sort((a, b) =>
        a.matchInfo.matchNumber.localeCompare(b.matchInfo.matchNumber, "ja", { numeric: true })
        || (a.matchInfo.scheduledTime || "").localeCompare(b.matchInfo.scheduledTime || ""))
        .map((match) => {
          const [teamA, teamB] = match.teams;
          const sets = getSetWins(match);
          const setScore = `${sets.find((item) => item.teamId === teamA.id)?.wins || 0}-${sets.find((item) => item.teamId === teamB.id)?.wins || 0}`;
          const started = match.sets.some((set) => set.startedAt || set.events.length > 0);
          return [
            match.matchInfo.matchNumber || "試合番号未設定",
            `${teamA.name} vs ${teamB.name}`,
            isMatchComplete(match) ? "終了" : started ? "進行中" : "未開始",
            match.matchInfo.scheduledTime || "—",
            setScore,
          ];
        });
      container.append(courtHeading, makeTable(["試合", "対戦", "状態", "予定時刻", "セット"], rows, "gym-court-table"));
    });
}

function getRefereePerformance(matches) {
  const referees = new Map();
  const refereeRoles = officialRoles.filter(([role]) =>
    ["firstReferee", "secondReferee", "thirdReferee", "challengeReferee", "lineJudge1", "lineJudge2", "lineJudge3", "lineJudge4"].includes(role));
  for (const match of matches) {
    const assigned = new Set();
    refereeRoles.forEach(([role]) => {
      const official = match.matchInfo.officials?.[role];
      const name = official?.name?.trim()
        || (role === "firstReferee" ? match.matchInfo.referee1 : role === "secondReferee" ? match.matchInfo.referee2 : "");
      if (name) assigned.add(name);
    });
    const events = match.sets.flatMap((set) => set.events);
    const corrections = events.filter((event) => event.type === "score"
      && (event.correctionSource || event.delta < 0)).length;
    const challengeCorrections = events.filter((event) => event.type === "score"
      && event.correctionSource === "challenge").length;
    const challenges = events.filter((event) => event.type === "challenge").length;
    const serviceOrderViolations = events.filter((event) => event.type === "service-order-violation").length;
    assigned.forEach((name) => {
      const stats = referees.get(name) || {
        name, matches: 0, corrections: 0, serviceOrderViolations: 0, challenges: 0, challengeCorrections: 0,
      };
      stats.matches += 1;
      stats.corrections += corrections;
      stats.challenges += challenges;
      stats.serviceOrderViolations += serviceOrderViolations;
      stats.challengeCorrections += challengeCorrections;
      referees.set(name, stats);
    });
  }
  return [...referees.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function renderRefereePerformance(container, matches) {
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "審判成績";
  container.append(heading);
  const referees = getRefereePerformance(matches);
  if (!referees.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "審判登録のある試合を大会に登録すると、成績を表示します。";
    container.append(empty);
    return;
  }
  container.append(makeTable(
    ["審判", "担当試合数", "得点訂正件数", "サーブ順違反検出数", "チャレンジ件数", "チャレンジ後訂正数"],
    referees.map((item) => [
      item.name, item.matches, item.corrections, item.serviceOrderViolations, item.challenges, item.challengeCorrections,
    ]),
    "referee-performance-table",
  ));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "各件数は担当した大会登録試合で記録された総数です。イベントに個別の入力者IDはないため、担当審判全員に試合単位の件数を表示します。";
  container.append(note);
}

function getTournamentPerformanceSummary(tournament) {
  const participants = new Map(tournament.participants.map((participant) => [participant.code, {
    participant,
    played: 0,
    wins: 0,
    losses: 0,
    setsWon: 0,
    setsLost: 0,
    pointsScored: 0,
    pointsConceded: 0,
  }]));
  const attackRanks = new Map();
  const blockRanks = new Map();
  const individualRanks = new Map();
  const matchIds = new Set([
    ...tournament.matchIds,
    ...(tournament.fixtures || []).map((fixture) => fixture.matchId).filter(Boolean),
  ]);
  const matches = [...matchIds].map((id) => id === currentMatch.id
    ? currentMatch : store.matches.find((match) => match.id === id)).filter(Boolean);
  const countedMatchIds = new Set();
  const participantCodeFor = (team) => team.code
    || tournament.participants.find((participant) => participant.name === team.name)?.code
    || "";
  const recordCompletedMatch = (match) => {
    if (!isMatchComplete(match) || countedMatchIds.has(match.id)) return;
    countedMatchIds.add(match.id);
    const wins = getSetWins(match);
    const winner = wins.find((item) => item.wins >= Math.floor(match.rules.bestOf / 2) + 1);
    match.teams.forEach((team, index) => {
      const code = participantCodeFor(team);
      const record = participants.get(code);
      if (!record) return;
      const ownWins = wins.find((item) => item.teamId === team.id)?.wins || 0;
      const opponent = match.teams[1 - index];
      const opponentWins = wins.find((item) => item.teamId === opponent.id)?.wins || 0;
      record.played += 1;
      record.setsWon += ownWins;
      record.setsLost += opponentWins;
      for (const set of match.sets) {
        if (!getSetResult(match, set)) continue;
        record.pointsScored += getScore(set, team.id);
        record.pointsConceded += getScore(set, opponent.id);
      }
      if (winner?.teamId === team.id) record.wins += 1;
      else record.losses += 1;

      const playerStats = getPerformanceStats(team, match.sets).players;
      team.players.forEach((player) => {
        const stats = playerStats.get(player.id);
        if (!stats) return;
        const key = `${code}:${player.number}`;
        const currentPlayer = {
          code,
          teamName: record.participant.name,
          number: player.number,
          name: player.name,
          points: stats.attack.points,
          blocks: stats.block.points,
        };
        const recordedAttempts = stats.attack.attempts + stats.backAttack.attempts
          + stats.block.attempts + stats.serve.attempts;
        if (!recordedAttempts) return;
        const individualEntry = individualRanks.get(key) || {
          ...currentPlayer,
          points: 0,
          evaluation: 0,
          errors: 0,
        };
        individualEntry.points += stats.attack.points + stats.backAttack.points + stats.block.points + stats.serve.points;
        individualEntry.evaluation += stats.attack.points + stats.backAttack.points
          + stats.block.points * 1.5 + stats.serve.points * 2
          - stats.attack.errors - stats.backAttack.errors - stats.serve.errors;
        individualEntry.errors += stats.attack.errors + stats.backAttack.errors + stats.serve.errors;
        individualRanks.set(key, individualEntry);
        const attackEntry = attackRanks.get(key) || { ...currentPlayer, points: 0 };
        const blockEntry = blockRanks.get(key) || { ...currentPlayer, blocks: 0 };
        attackEntry.points += stats.attack.points;
        blockEntry.blocks += stats.block.points;
        attackRanks.set(key, attackEntry);
        blockRanks.set(key, blockEntry);
      });
    });
  };
  matches.forEach(recordCompletedMatch);

  (tournament.fixtures || []).filter((fixture) => !fixture.matchId && fixture.manualResult?.sets?.length)
    .forEach((fixture) => {
      const winnerCode = getTournamentFixtureWinner(fixture, null);
      if (!winnerCode) return;
      const teamA = participants.get(fixture.teamACode);
      const teamB = participants.get(fixture.teamBCode);
      if (!teamA || !teamB) return;
      const setsWonA = fixture.manualResult.sets.filter((set) => set.teamA > set.teamB).length;
      const setsWonB = fixture.manualResult.sets.filter((set) => set.teamB > set.teamA).length;
      teamA.played += 1;
      teamB.played += 1;
      teamA.setsWon += setsWonA;
      teamA.setsLost += setsWonB;
      teamB.setsWon += setsWonB;
      teamB.setsLost += setsWonA;
      fixture.manualResult.sets.forEach((set) => {
        teamA.pointsScored += set.teamA;
        teamA.pointsConceded += set.teamB;
        teamB.pointsScored += set.teamB;
        teamB.pointsConceded += set.teamA;
      });
      if (winnerCode === fixture.teamACode) {
        teamA.wins += 1;
        teamB.losses += 1;
      } else {
        teamB.wins += 1;
        teamA.losses += 1;
      }
    });

  return {
    teams: [...participants.values()],
    attackLeaders: [...attackRanks.values()].filter((player) => player.points > 0).sort((a, b) => b.points - a.points),
    blockLeaders: [...blockRanks.values()].filter((player) => player.blocks > 0).sort((a, b) => b.blocks - a.blocks),
    individualLeaders: [...individualRanks.values()]
      .sort((a, b) => b.evaluation - a.evaluation || a.name.localeCompare(b.name, "ja")),
  };
}

function rankedRows(players, metric) {
  let previousScore = null;
  let rank = 0;
  return players.map((player, index) => {
    const score = player[metric];
    if (score !== previousScore) rank = index + 1;
    previousScore = score;
    return [
      rank,
      player.teamName,
      `#${player.number} ${player.name}`,
      score,
    ];
  });
}

function renderTournamentPerformanceSummary(container, tournament) {
  container.replaceChildren();
  if (!tournament) return;
  const summary = getTournamentPerformanceSummary(tournament);
  const heading = document.createElement("h3");
  heading.textContent = "大会成績・個人ランキング";
  const teamRows = [...summary.teams].sort((a, b) => b.wins - a.wins
    || (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost)
    || (b.pointsScored - b.pointsConceded) - (a.pointsScored - a.pointsConceded))
    .map((record, index) => [
      index + 1,
      record.participant.name,
      record.played,
      record.wins,
      record.losses,
      record.played ? `${(record.wins / record.played * 100).toFixed(1)}%` : "—",
      record.setsLost ? `${(record.setsWon / record.setsLost * 100).toFixed(1)}%` : "—",
      record.pointsConceded
        ? `${(record.pointsScored / record.pointsConceded * 100).toFixed(1)}%` : "—",
    ]);
  const content = document.createElement("section");
  content.className = "tournament-performance-summary";
  content.append(
    heading,
    makeTable(["順位", "チーム", "試合", "勝", "敗", "勝率", "得セット率", "得失点率"], teamRows, "tournament-standings-table"),
  );
  const attackHeading = document.createElement("h4");
  attackHeading.textContent = "アタック得点ランキング";
  const blockHeading = document.createElement("h4");
  blockHeading.textContent = "ブロックポイントランキング";
  const noStats = document.createElement("p");
  noStats.className = "empty-message";
  noStats.textContent = "個人ランキングは試合終了後、アタック・ブロックの選手記録がある試合から集計します。";
  content.append(attackHeading);
  if (summary.attackLeaders.length) {
    content.append(makeTable(["順位", "チーム", "選手", "得点"], rankedRows(summary.attackLeaders, "points"), "tournament-standings-table"));
  } else content.append(noStats.cloneNode(true));
  content.append(blockHeading);
  if (summary.blockLeaders.length) {
    content.append(makeTable(["順位", "チーム", "選手", "本数"], rankedRows(summary.blockLeaders, "blocks"), "tournament-standings-table"));
  } else content.append(noStats);
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "勝率＝勝数÷試合数、得セット率＝取得セット÷失セット、得失点率＝得点÷失点。完了試合のみ集計し、手入力の外部試合は個人ランキングに含みません。";
  content.append(note);
  container.append(content);
  renderPointSourceBars(byId("tournament-score-heatmap"),
    getPointSourceCounts(getTournamentMatches(tournament)),
    "大会全体ヒートマップ（全登録試合の得点源）",
    "得点訂正を除くアプリ内記録の得点イベントを集計します。外部試合の手入力スコアは得点源を特定できないため含みません。");
}

function renderTournamentFixtures(tournament) {
  const container = byId("tournament-fixture-list");
  container.replaceChildren();
  const fixtures = tournament.fixtures || [];
  const heading = document.createElement("h3");
  heading.textContent = "大会対戦表";
  container.append(heading);
  if (!fixtures.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "対戦カードはまだありません。予選・リーグのカードを追加してください。";
    container.append(message);
  } else {
    const rows = fixtures.map((fixture) => {
      const match = fixture.matchId === currentMatch.id
        ? currentMatch : store.matches.find((item) => item.id === fixture.matchId);
      const manualResult = !match ? fixture.manualResult : null;
      const setScore = match ? match.sets.map((set) =>
        `${getScore(set, match.teams[0].id)}-${getScore(set, match.teams[1].id)}`).join(" / ")
        : manualResult?.sets.map((set) => `${set.teamA}-${set.teamB}`).join(" / ") || "—";
      const manualWinner = !match ? getTournamentFixtureWinner(fixture, null) : "";
      const winnerCode = match
        ? getTournamentFixtureWinner(fixture, match)
        : manualWinner || fixture.winnerCode || "";
      const status = match
        ? isMatchComplete(match) ? "終了（自動）" : match.sets.some((set) => set.startedAt || set.events.length) ? "進行中（自動）" : "未開始"
        : manualResult?.sets.length ? manualWinner ? "終了（手入力）" : "進行中（手入力）"
          : fixture.winnerCode && fixture.roundIndex === 0 && (!fixture.teamACode || !fixture.teamBCode) ? "不戦勝" : "未設定";
      return [
        fixture.phase === "league" ? "予選・リーグ" : "トーナメント",
        fixture.roundName,
        `${fixture.teamAName || "未定"} vs ${fixture.teamBName || "未定"}`,
        setScore,
        winnerCode || "—",
        status,
        fixture.id,
      ];
    });
    const table = makeTable(["区分", "ラウンド", "対戦", "セット結果", "勝者コード", "状態", "操作"], rows, "tournament-match-table");
    table.querySelectorAll("tbody tr").forEach((row, index) => {
      const fixture = fixtures[index];
      const cell = row.lastElementChild;
      cell.textContent = "";
      const ready = fixture.teamACode && fixture.teamBCode;
      const addButton = (text, attribute, value) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-secondary";
        button.textContent = text;
        button.setAttribute(attribute, value);
        cell.append(button);
      };
      if (fixture.phase === "league") {
        if (fixture.matchId) addButton("試合を開く（自動反映）", "data-tournament-fixture", fixture.id);
        else if (ready) {
          addButton("試合を作成（自動反映）", "data-tournament-fixture", fixture.id);
          addButton(fixture.manualResult ? "手入力結果を編集" : "外部試合の結果入力", "data-edit-tournament-result", fixture.id);
        }
        addButton("対戦相手を編集", "data-edit-tournament-fixture", fixture.id);
        addButton("対戦カードを削除", "data-delete-tournament-fixture", fixture.id);
        return;
      }
      if (fixture.roundIndex === 0) {
        addButton(ready || fixture.winnerCode ? "対戦相手を編集" : "対戦相手を設定", "data-edit-tournament-fixture", fixture.id);
      }
      if (fixture.matchId) {
        addButton("試合を開く（自動反映）", "data-tournament-fixture", fixture.id);
      } else if (ready) {
        addButton("試合を作成（自動反映）", "data-tournament-fixture", fixture.id);
        addButton(fixture.manualResult ? "手入力結果を編集" : "外部試合の結果入力", "data-edit-tournament-result", fixture.id);
      } else if (fixture.roundIndex > 0) {
        addButton(fixture.winnerCode ? "勝ち上がり確定" : "勝ち上がり待ち", "data-waiting-tournament-fixture", fixture.id);
        cell.lastElementChild.disabled = true;
      }
    });
    container.append(table);
  }
  const leagueFixtures = fixtures.filter((fixture) => fixture.phase === "league");
  if (["round-robin", "both"].includes(tournament.format)) {
    const standings = new Map(tournament.participants.map((participant) => [participant.code, {
      participant, played: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0,
    }]));
    leagueFixtures.forEach((fixture) => {
      const match = fixture.matchId === currentMatch.id
        ? currentMatch : store.matches.find((item) => item.id === fixture.matchId);
      const winnerCode = match
        ? isMatchComplete(match) ? getTournamentFixtureWinner(fixture, match) : ""
        : getTournamentFixtureWinner(fixture, null);
      if (!winnerCode) return;
      const scoreA = match
        ? getSetWins(match).find((item) => item.teamId === match.teams[0].id)?.wins || 0
        : fixture.manualResult.sets.filter((set) => set.teamA > set.teamB).length;
      const scoreB = match
        ? getSetWins(match).find((item) => item.teamId === match.teams[1].id)?.wins || 0
        : fixture.manualResult.sets.filter((set) => set.teamB > set.teamA).length;
      const standingA = standings.get(fixture.teamACode);
      const standingB = standings.get(fixture.teamBCode);
      if (!standingA || !standingB) return;
      standingA.played += 1;
      standingB.played += 1;
      standingA.setsWon += scoreA;
      standingA.setsLost += scoreB;
      standingB.setsWon += scoreB;
      standingB.setsLost += scoreA;
      if (scoreA > scoreB) {
        standingA.wins += 1;
        standingB.losses += 1;
      } else {
        standingB.wins += 1;
        standingA.losses += 1;
      }
    });
    const standingsHeading = document.createElement("h3");
    standingsHeading.textContent = "リーグ順位";
    const standingsRows = [...standings.values()].sort((a, b) =>
      b.wins - a.wins || (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost))
      .map((item, index) => [
        index + 1, item.participant.code, item.participant.name, item.played,
        item.wins, item.losses, `${item.setsWon}-${item.setsLost}`,
      ]);
    container.append(standingsHeading, makeTable(
      ["順位", "コード", "チーム", "試合", "勝", "敗", "セット得失"],
      standingsRows,
      "tournament-standings-table",
    ));
  }
  renderTournamentPerformanceSummary(byId("tournament-performance-summary"), tournament);
  renderOpponentScouting(tournament);
  renderHeadToHead(tournament);
}

function updateTournamentResultSetVisibility() {
  const bestOf = Number(byId("tournament-result-best-of").value);
  document.querySelectorAll("[data-result-set]").forEach((field) => {
    const visible = Number(field.dataset.resultSet) <= bestOf;
    field.hidden = !visible;
    if (field instanceof HTMLInputElement) field.disabled = !visible;
  });
}

function openTournamentResultDialog(fixtureId) {
  const tournament = getSelectedTournament();
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!fixture) return showError("大会の対戦情報が見つかりません。");
  if (fixture.matchId) return showError("この試合はアプリ内の記録結果を自動反映します。");
  if (!fixture.teamACode || !fixture.teamBCode) return showError("両チームが確定してから結果を入力してください。");
  editingTournamentResult = { tournamentId: tournament.id, fixtureId };
  byId("tournament-result-heading").textContent = `${fixture.roundName} 結果入力`;
  byId("tournament-result-matchup").textContent = `${fixture.teamAName} vs ${fixture.teamBName}`;
  byId("tournament-result-team-a").textContent = fixture.teamAName;
  byId("tournament-result-team-b").textContent = fixture.teamBName;
  byId("tournament-result-best-of").value = String(fixture.manualResult?.bestOf || 3);
  for (let setNumber = 1; setNumber <= 5; setNumber += 1) {
    const set = fixture.manualResult?.sets[setNumber - 1];
    byId(`tournament-result-a-${setNumber}`).value = set ? String(set.teamA) : "";
    byId(`tournament-result-b-${setNumber}`).value = set ? String(set.teamB) : "";
  }
  byId("tournament-result-error").textContent = "";
  byId("tournament-result-error").hidden = true;
  updateTournamentResultSetVisibility();
  byId("tournament-result-dialog").showModal();
}

function readManualTournamentResult() {
  const bestOf = Number(byId("tournament-result-best-of").value);
  if (![3, 5].includes(bestOf)) return { error: "試合方式を選択してください。" };
  const sets = [];
  let foundGap = false;
  const wins = [0, 0];
  const winsNeeded = Math.floor(bestOf / 2) + 1;
  for (let setNumber = 1; setNumber <= bestOf; setNumber += 1) {
    const rawA = byId(`tournament-result-a-${setNumber}`).value.trim();
    const rawB = byId(`tournament-result-b-${setNumber}`).value.trim();
    if (!rawA && !rawB) {
      foundGap = true;
      continue;
    }
    if (!rawA || !rawB) return { error: `第${setNumber}セットは両チームの得点を入力してください。` };
    if (foundGap) return { error: "セット結果は第1セットから順番に入力してください。" };
    if (!/^\d{1,2}$/.test(rawA) || !/^\d{1,2}$/.test(rawB)) {
      return { error: `第${setNumber}セットの得点は0〜99で入力してください。` };
    }
    const teamA = Number(rawA);
    const teamB = Number(rawB);
    if (teamA === teamB) return { error: `第${setNumber}セットの得点が同点です。勝敗が決まった得点を入力してください。` };
    sets.push({ teamA, teamB });
    wins[teamA > teamB ? 0 : 1] += 1;
    if (wins.some((count) => count >= winsNeeded) && setNumber < bestOf) {
      const laterInput = Array.from({ length: bestOf - setNumber }, (_, index) => setNumber + index + 1)
        .some((laterSet) => byId(`tournament-result-a-${laterSet}`).value.trim()
          || byId(`tournament-result-b-${laterSet}`).value.trim());
      if (laterInput) return { error: `第${setNumber}セットで試合結果が確定しています。それ以降のセットは入力できません。` };
      break;
    }
  }
  if (!sets.length) return { error: "少なくとも第1セットの得点を入力してください。結果の削除は「入力結果をクリア」を使用してください。" };
  return { value: { bestOf, sets } };
}

function saveManualTournamentResult() {
  if (!editingTournamentResult) return;
  const { tournamentId, fixtureId } = editingTournamentResult;
  const tournament = store.tournaments.find((item) => item.id === tournamentId);
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!tournament || !fixture || fixture.matchId) {
    return showError("この対戦表は更新できません。大会を選び直してください。");
  }
  const result = readManualTournamentResult();
  if (result.error) {
    const error = byId("tournament-result-error");
    error.textContent = result.error;
    error.hidden = false;
    return;
  }
  clearError();
  fixture.manualResult = result.value;
  const winnerCode = getTournamentFixtureWinner(fixture, null);
  if (winnerCode) fixture.winnerCode = winnerCode;
  else delete fixture.winnerCode;
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  tournamentNotice = invalidatedFixtures.length
    ? `手入力結果の更新により、対戦相手が変わる次ラウンドの試合を大会から外しました（試合履歴は保持されています）。再作成してください: ${invalidatedFixtures.join("、")}`
    : "";
  byId("tournament-result-dialog").close();
  editingTournamentResult = null;
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
  if (invalidatedFixtures.length) showError(tournamentNotice);
}

function clearManualTournamentResult() {
  if (!editingTournamentResult) return;
  const tournament = store.tournaments.find((item) => item.id === editingTournamentResult.tournamentId);
  const fixture = tournament?.fixtures?.find((item) => item.id === editingTournamentResult.fixtureId);
  if (!fixture || fixture.matchId) return showError("この試合の結果は手入力ではありません。");
  delete fixture.manualResult;
  delete fixture.winnerCode;
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  tournamentNotice = invalidatedFixtures.length
    ? `手入力結果の削除により、対戦相手が変わる次ラウンドの試合を大会から外しました（試合履歴は保持されています）。再作成してください: ${invalidatedFixtures.join("、")}`
    : "";
  byId("tournament-result-dialog").close();
  editingTournamentResult = null;
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
  if (invalidatedFixtures.length) showError(tournamentNotice);
}

function createTournament() {
  const name = byId("new-tournament-name").value.trim();
  if (!name) return showError("大会名を入力してください。");
  if (store.tournaments.length >= 100) return showError("大会の保存上限（100件）に達しています。");
  tournamentNotice = "";
  const selectedCodes = [...byId("tournament-participant-options").querySelectorAll("[data-tournament-participant]:checked")]
    .map((checkbox) => checkbox.value);
  const selectedProfiles = getTournamentTeamProfiles().filter((profile) => selectedCodes.includes(profile.code));
  if (selectedProfiles.length < 2) return showError("大会参加チームを2チーム以上選択してください。");
  const format = byId("tournament-format").value;
  clearError();
  const participants = selectedProfiles.map((profile) => ({
    code: profile.code,
    name: profile.name,
    profileId: profile.id,
  }));
  const tournament = {
    id: createId(),
    name: name.slice(0, 80),
    createdAt: new Date().toISOString(),
    matchIds: [],
    format,
    participants,
    fixtures: createTournamentFixtures(participants, format),
  };
  store.tournaments.unshift(tournament);
  updateTournamentFixtures(currentMatch);
  byId("new-tournament-name").value = "";
  renderTournamentManagement();
  byId("tournament-select").value = tournament.id;
  renderTournamentManagement();
  scheduleSave(true);
  renderPrintableScoreSheet();
}

function addManualLeagueFixture() {
  const tournament = getSelectedTournament();
  if (!tournament || !["round-robin", "both"].includes(tournament.format)) {
    return showError("予選・リーグ対戦を追加できる大会を選択してください。");
  }
  const roundName = byId("manual-fixture-round").value.trim();
  const teamACode = byId("manual-fixture-team-a").value;
  const teamBCode = byId("manual-fixture-team-b").value;
  if (!roundName) return showError("ラウンド名を入力してください。");
  if (!teamACode || !teamBCode) return showError("対戦する両チームを選択してください。");
  if (teamACode === teamBCode) return showError("異なるチームを選択してください。");
  if ((tournament.fixtures || []).length >= 4096) return showError("対戦カードの保存上限に達しています。");
  const rounds = [...new Set(tournament.fixtures
    .filter((fixture) => fixture.phase === "league")
    .map((fixture) => fixture.roundName))];
  const roundIndex = rounds.includes(roundName) ? rounds.indexOf(roundName) : rounds.length;
  const roundFixtures = tournament.fixtures.filter((fixture) =>
    fixture.phase === "league" && fixture.roundName === roundName);
  const matchIndex = Math.max(-1, ...roundFixtures.map((fixture) => fixture.matchIndex)) + 1;
  const teamA = tournament.participants.find((participant) => participant.code === teamACode);
  const teamB = tournament.participants.find((participant) => participant.code === teamBCode);
  tournament.fixtures.push({
    id: createId(),
    phase: "league",
    roundIndex,
    roundName: roundName.slice(0, 40),
    matchIndex,
    teamACode,
    teamAName: teamA.name,
    teamBCode,
    teamBName: teamB.name,
  });
  byId("manual-fixture-team-a").value = "";
  byId("manual-fixture-team-b").value = "";
  clearError();
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
}

function deleteManualLeagueFixture(fixtureId) {
  const tournament = getSelectedTournament();
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!tournament || !fixture || fixture.phase !== "league") return showError("削除する予選・リーグ対戦が見つかりません。");
  if ((fixture.matchId || fixture.manualResult) && !confirm("この対戦カードと登録済み結果を大会から削除しますか？試合履歴は残ります。")) return;
  if (fixture.matchId) tournament.matchIds = tournament.matchIds.filter((id) => id !== fixture.matchId);
  tournament.fixtures = tournament.fixtures.filter((item) => item.id !== fixtureId);
  clearError();
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
}

function openTournamentFixtureDialog(fixtureId) {
  const tournament = getSelectedTournament();
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!fixture || fixture.phase === "bracket" && fixture.roundIndex !== 0) {
    return showError("手動で編集できる対戦カードが見つかりません。");
  }
  editingTournamentFixture = { tournamentId: tournament.id, fixtureId };
  byId("tournament-fixture-round-label").textContent = fixture.roundName;
  byId("tournament-fixture-dialog-heading").textContent = fixture.phase === "league"
    ? "予選・リーグの対戦相手を編集" : "トーナメントの対戦相手を設定";
  const allowBye = fixture.phase === "bracket";
  fillTournamentTeamSelect(byId("tournament-fixture-team-a"), tournament, allowBye);
  fillTournamentTeamSelect(byId("tournament-fixture-team-b"), tournament, allowBye);
  byId("tournament-fixture-team-a").value = fixture.teamACode || "";
  byId("tournament-fixture-team-b").value = fixture.teamBCode || "";
  byId("tournament-fixture-error").textContent = "";
  byId("tournament-fixture-error").hidden = true;
  byId("tournament-fixture-dialog").showModal();
}

function saveTournamentFixtureMatchup() {
  if (!editingTournamentFixture) return;
  const { tournamentId, fixtureId } = editingTournamentFixture;
  const tournament = store.tournaments.find((item) => item.id === tournamentId);
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!tournament || !fixture || fixture.phase === "bracket" && fixture.roundIndex !== 0) {
    return showError("対戦カードを更新できません。大会を選び直してください。");
  }
  const isBracketOpening = fixture.phase === "bracket";
  const teamACode = byId("tournament-fixture-team-a").value;
  const teamBCode = byId("tournament-fixture-team-b").value;
  const error = byId("tournament-fixture-error");
  const showDialogError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  if (!teamACode && !teamBCode) return showDialogError("少なくとも1チームを選択してください。");
  if (!isBracketOpening && (!teamACode || !teamBCode)) {
    return showDialogError("予選・リーグでは両チームを選択してください。");
  }
  if (teamACode && teamACode === teamBCode) return showDialogError("異なるチームを選択してください。");
  const duplicatedCodes = [teamACode, teamBCode].filter(Boolean);
  if (isBracketOpening) {
    const otherFirstRoundFixtures = tournament.fixtures.filter((item) =>
      item.id !== fixture.id && item.phase === "bracket" && item.roundIndex === 0);
    if (duplicatedCodes.some((code) => otherFirstRoundFixtures.some((item) =>
      item.teamACode === code || item.teamBCode === code))) {
      return showDialogError("同じチームを複数の初回対戦に登録できません。");
    }
  }
  const matchupChanged = fixture.teamACode !== teamACode || fixture.teamBCode !== teamBCode;
  if (!matchupChanged) {
    byId("tournament-fixture-dialog").close();
    editingTournamentFixture = null;
    return;
  }
  if ((fixture.matchId || fixture.manualResult) && !confirm("対戦相手を変更すると、この対戦の結果は大会から外れます。試合履歴は保持して変更しますか？")) return;
  if (fixture.matchId) tournament.matchIds = tournament.matchIds.filter((id) => id !== fixture.matchId);
  fixture.matchId = "";
  delete fixture.manualResult;
  const teamA = tournament.participants.find((participant) => participant.code === teamACode);
  const teamB = tournament.participants.find((participant) => participant.code === teamBCode);
  fixture.teamACode = teamACode;
  fixture.teamAName = teamA?.name || "";
  fixture.teamBCode = teamBCode;
  fixture.teamBName = teamB?.name || "";
  if (isBracketOpening && teamACode && !teamBCode) fixture.winnerCode = teamACode;
  else if (isBracketOpening && teamBCode && !teamACode) fixture.winnerCode = teamBCode;
  else delete fixture.winnerCode;
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  tournamentNotice = invalidatedFixtures.length
    ? `対戦相手の変更により、後続の試合結果・試合リンクを大会から外しました（試合履歴は保持されています）。再登録してください: ${invalidatedFixtures.join("、")}`
    : "";
  byId("tournament-fixture-dialog").close();
  editingTournamentFixture = null;
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
  if (invalidatedFixtures.length) showError(tournamentNotice);
}

function addCurrentMatchToTournament() {
  const tournament = getSelectedTournament();
  if (!tournament) return showError("大会を選択してください。");
  const otherTournament = store.tournaments.find((item) => item.id !== tournament.id && item.matchIds.includes(currentMatch.id));
  if (otherTournament) return showError(`この試合はすでに「${otherTournament.name}」に登録されています。先に登録を解除してください。`);
  if (tournament.matchIds.includes(currentMatch.id)) return showError("現在の試合はすでにこの大会に登録されています。");
  const tournamentId = tournament.id;
  if (dirty) persistNow();
  if (dirty) return;
  const persistedTournament = store.tournaments.find((item) => item.id === tournamentId);
  if (!persistedTournament) return showError("選択した大会が保存データに見つかりません。");
  clearError();
  persistedTournament.matchIds.push(currentMatch.id);
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
}

function removeMatchFromTournament(matchId) {
  const tournament = getSelectedTournament();
  if (!tournament) return;
  clearError();
  tournament.matchIds = tournament.matchIds.filter((id) => id !== matchId);
  tournament.fixtures?.forEach((fixture) => {
    if (fixture.matchId === matchId) {
      fixture.matchId = "";
      delete fixture.winnerCode;
    }
  });
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  tournamentNotice = invalidatedFixtures.length
    ? `大会試合の登録解除により、次の対戦試合を大会から外しました（試合履歴は保持されています）。再作成してください: ${invalidatedFixtures.join("、")}`
    : "";
  scheduleSave(true);
  renderTournamentManagement();
  renderPrintableScoreSheet();
  if (invalidatedFixtures.length) showError(tournamentNotice);
}

function deleteSelectedTournament() {
  const tournament = getSelectedTournament();
  if (!tournament) return;
  if (!confirm(`「${tournament.name}」を削除しますか？登録試合は削除されません。`)) return;
  clearError();
  store.tournaments = store.tournaments.filter((item) => item.id !== tournament.id);
  tournamentNotice = "";
  renderTournamentManagement();
  scheduleSave(true);
  renderPrintableScoreSheet();
}

function loadTournamentFixture(fixtureId) {
  const tournament = getSelectedTournament();
  const fixture = tournament?.fixtures?.find((item) => item.id === fixtureId);
  if (!tournament || !fixture) return showError("大会の対戦情報が見つかりません。");
  if (fixture.matchId) {
    loadMatch(fixture.matchId);
    navigateTo(matchHasStarted() ? "match" : "setup");
    return;
  }
  if (!fixture.teamACode || !fixture.teamBCode) return showError("両チームの勝ち上がりが確定してから試合を作成してください。");
  if (store.matches.length >= MAX_MATCHES) {
    return showError(`保存できる試合数の上限（${MAX_MATCHES}件）に達しています。試合データを書き出すか、不要な履歴を削除してください。`);
  }
  const profileForCode = (code) => {
    const participant = tournament.participants.find((item) => item.code === code);
    return store.teamProfiles.find((profile) => profile.id === participant?.profileId)
      || store.teamProfiles.find((profile) => profile.code === code);
  };
  const profileA = profileForCode(fixture.teamACode);
  const profileB = profileForCode(fixture.teamBCode);
  if (!profileA || !profileB) return showError("参加チームの保存履歴が見つかりません。チームコードと履歴を確認してください。");
  delete fixture.manualResult;
  delete fixture.winnerCode;
  const invalidatedFixtures = updateTournamentFixtures(currentMatch);
  tournamentNotice = invalidatedFixtures.length
    ? `アプリ内記録に切り替えたため、未確定の対戦相手が変わる次ラウンドの試合を大会から外しました（試合履歴は保持されています）。再作成してください: ${invalidatedFixtures.join("、")}`
    : "";
  const match = createEmptyMatch();
  let lineupNeedsReview = false;
  const remapProfile = (team, profile, expectedName, code) => {
    team.name = expectedName;
    team.code = code;
    const ids = new Map();
    team.players = profile.players.map((player) => {
      const id = createId();
      ids.set(player.id, id);
      return { ...player, id };
    });
    team.uniformColor = profile.uniformColor || team.uniformColor;
    team.liberoUniformColor = profile.liberoUniformColor || team.liberoUniformColor;
    team.staff = { ...(profile.staff || {}) };
    team.rotationLineup = profile.rotationLineup.map((id) => ids.get(id) || "");
  };
  remapProfile(match.teams[0], profileA, fixture.teamAName, fixture.teamACode);
  remapProfile(match.teams[1], profileB, fixture.teamBName, fixture.teamBCode);
  match.matchInfo.tournamentName = tournament.name;
  match.matchInfo.round = fixture.roundName;
  match.matchInfo.matchNumber = `${fixture.phase === "league" ? "L" : "T"}${fixture.roundIndex + 1}-${fixture.matchIndex + 1}`;
  match.sets[0].startingLineups = Object.fromEntries(match.teams.map((team) => [team.id, [...team.rotationLineup]]));
  const targetSlots = getCourtPlayerCount(match);
  if (!match.teams.every((team) => team.rotationLineup.slice(0, targetSlots).every(Boolean))) {
    lineupNeedsReview = true;
  }
  fixture.matchId = match.id;
  tournament.matchIds.push(match.id);
  clearActiveVideo();
  store.matches = [match, ...store.matches];
  currentMatch = match;
  render();
  scheduleSave(true);
  if (invalidatedFixtures.length) showError(tournamentNotice);
  if (lineupNeedsReview) showError("登録履歴にコート内選手のローテーション・サーブ順が不足しています。試合開始前に設定してください。");
  navigateTo("setup");
}

function renderSeasonStats() {
  const teamSelect = byId("season-team");
  const previousTeam = teamSelect.value;
  teamSelect.replaceChildren();
  const matches = currentMatch
    ? [currentMatch, ...store.matches.filter((match) => match.id !== currentMatch.id)]
    : store.matches;
  const teamsByKey = new Map();
  matches.forEach((match) => match.teams.forEach((team) => {
    if (!team.name) return;
    const key = team.code ? `code:${team.code}` : `name:${team.name}`;
    if (!teamsByKey.has(key)) teamsByKey.set(key, team);
  }));
  const teamOptions = [...teamsByKey.entries()].sort(([, a], [, b]) =>
    (a.code || a.name).localeCompare(b.code || b.name, "ja"));
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = teamOptions.length ? "チームを選択" : "対象の試合がありません";
  teamSelect.append(placeholder);
  teamOptions.forEach(([key, team]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `${team.code ? `${team.code} / ` : ""}${team.name}`;
    teamSelect.append(option);
  });
  teamSelect.value = teamsByKey.has(previousTeam) ? previousTeam : "";
  const summary = byId("season-summary");
  summary.replaceChildren();
  byId("year-comparison").replaceChildren();
  const teamKey = teamSelect.value;
  const selectedTeam = teamsByKey.get(teamKey);
  if (!selectedTeam) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "チームを選択してください。";
    summary.append(message);
    return;
  }
  const startDate = byId("season-start").value;
  const endDate = byId("season-end").value;
  if (startDate && endDate && startDate > endDate) {
    const message = document.createElement("p");
    message.className = "notice is-warning";
    message.textContent = "開始日は終了日以前の日付にしてください。";
    summary.append(message);
    return;
  }
  const matchingMatches = matches.filter((match) => {
    const date = match.matchInfo.matchDate;
    return match.teams.some((team) => selectedTeam.code
      ? team.code === selectedTeam.code || (!team.code && team.name === selectedTeam.name)
      : !team.code && team.name === selectedTeam.name)
      && (!startDate || date >= startDate)
      && (!endDate || date <= endDate);
  });
  const allTeamMatches = matches.filter((match) => match.teams.some((team) => selectedTeam.code
    ? team.code === selectedTeam.code || (!team.code && team.name === selectedTeam.name)
    : !team.code && team.name === selectedTeam.name));
  renderYearComparison(byId("year-comparison"), selectedTeam, allTeamMatches);
  const playerTotals = new Map();
  for (const match of matchingMatches) {
    const team = match.teams.find((item) => selectedTeam.code
      ? item.code === selectedTeam.code || (!item.code && item.name === selectedTeam.name)
      : !item.code && item.name === selectedTeam.name);
    if (!team) continue;
    const performance = getPerformanceStats(team, match.sets);
    team.players.forEach((player) => {
      const key = player.number;
      if (!playerTotals.has(key)) {
        playerTotals.set(key, {
          number: player.number,
          name: player.name,
          sets: 0,
          stats: emptyPlayStats(),
        });
      }
      const total = playerTotals.get(key);
      total.sets += performance.playerSetsPlayed.get(player.id) || 0;
      for (const kind of ["attack", "backAttack", "block", "serve", "reception"]) {
        for (const [stat, value] of Object.entries(performance.players.get(player.id)[kind])) {
          total.stats[kind][stat] += value;
        }
      }
    });
  }
  const heading = document.createElement("h2");
  heading.textContent = `${selectedTeam.code ? `${selectedTeam.code} / ` : ""}${selectedTeam.name} — ${matchingMatches.length}試合`;
  summary.append(heading);
  if (!matchingMatches.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "指定した条件に該当する試合はありません。";
    summary.append(message);
    renderTeamDossier(selectedTeam, []);
    return;
  }
  const rows = [...playerTotals.values()].sort((a, b) =>
    Number(a.number) - Number(b.number) || a.name.localeCompare(b.name, "ja")).map(({ number, name, sets, stats }) => {
    const serveEffectiveness = getServeEffectiveness(stats);
    const receptionSuccess = getReceptionSuccessRate(stats);
    return [
      `#${number} ${name}`,
      sets,
      stats.attack.attempts,
      stats.attack.points,
      formatPercentage(stats.attack.points, stats.attack.attempts),
      formatPercentage(stats.attack.blocked, stats.attack.attempts),
      stats.serve.attempts,
      stats.serve.points,
      serveEffectiveness === null ? "—" : `${serveEffectiveness.toFixed(1)}%`,
      receptionSuccess === null ? "—" : `${receptionSuccess.toFixed(1)}%`,
      stats.block.points,
    ];
  });
  summary.append(makeTable(
    ["選手", "出場セット", "アタック打数", "アタック得点", "決定率", "被ブロック率", "サーブ打数", "サーブ得点", "サーブ効果率", "レセプション成功率", "ブロック得点"],
    rows,
    "season-stats-table",
  ));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "チームコードと背番号で選手を集計します。チームコード未設定の旧試合は同名チームを対象に含めます。レセプション成功率は（excellent×100 + good×50）÷受数です。";
  summary.append(note);
  renderTeamDossier(selectedTeam, matchingMatches.filter(isMatchComplete));
}

function renderTeamDossier(team, matches) {
  const container = byId("team-dossier");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = `${team.name} チームカルテ`;
  container.append(heading);
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "完了試合の記録がないため、カルテを作成できません。";
    container.append(empty);
    return;
  }
  const data = getTeamTendencies(team.code, team.name, matches);
  const stats = data.stats;
  const attackRate = stats.attack.attempts ? stats.attack.points / stats.attack.attempts * 100 : null;
  const receptionRate = getReceptionSuccessRate(stats);
  const serveErrorRate = stats.serve.attempts ? stats.serve.errors / stats.serve.attempts * 100 : null;
  const rotationSlots = Math.max(...matches.map((match) => getCourtPlayerCount(match)));
  const rotationEntries = data.rotationLosses.slice(0, rotationSlots).map((count, index) => [`ローテ${index + 1}`, count])
    .sort((a, b) => b[1] - a[1]);
  const observations = [];
  if (attackRate !== null) observations.push({ label: `アタック決定率 ${attackRate.toFixed(1)}%`, value: attackRate });
  if (receptionRate !== null) observations.push({ label: `レセプション成功率 ${receptionRate.toFixed(1)}%`, value: receptionRate });
  if (serveErrorRate !== null) observations.push({ label: `サーブミス率 ${serveErrorRate.toFixed(1)}%`, value: 100 - serveErrorRate });
  observations.sort((a, b) => b.value - a.value);
  const strengths = observations.slice(0, Math.min(2, observations.length)).map((item) => item.label);
  const weaknesses = observations.slice(-Math.min(2, observations.length)).reverse().map((item) => item.label);
  const summary = document.createElement("p");
  summary.textContent = `対象: ${matches.length}試合。得意指標: ${strengths.join("、") || "記録不足"}。改善候補: ${weaknesses.join("、") || "記録不足"}。${data.pointsConceded ? `終盤（相手が目標点の5点前以降）の失点は${data.latePointsConceded}/${data.pointsConceded}点です。` : ""}`;
  container.append(summary);
  const teamDNA = document.createElement("section");
  teamDNA.className = "analysis-panel";
  renderPointSourceBars(teamDNA, getPointSourceCounts(matches, team), "チームDNA分析",
    "得点源の入力分類割合です。未分類の得点や記録漏れは特徴の見え方に影響します。");
  container.append(teamDNA, renderHistoricalLineupRecommendation(team, matches));
  const topRotation = rotationEntries[0];
  if (topRotation?.[1]) {
    const rotation = document.createElement("p");
    rotation.textContent = `失点が最も多いサーブ時ローテーション: ${topRotation[0]}（${topRotation[1]}点）。`;
    container.append(rotation);
  }
  const rows = [
    ["サーブ", stats.serve.attempts, stats.serve.points, stats.serve.errors,
      stats.serve.attempts ? `${(stats.serve.errors / stats.serve.attempts * 100).toFixed(1)}%` : "—"],
    ["アタック", stats.attack.attempts, stats.attack.points, stats.attack.errors,
      formatPercentage(stats.attack.points, stats.attack.attempts)],
    ["レセプション", stats.reception.attempts, stats.reception.excellent + stats.reception.good,
      stats.reception.other, receptionRate === null ? "—" : `${receptionRate.toFixed(1)}%`],
  ];
  container.append(makeTable(["プレー", "試行", "得点 / 成功", "ミス等", "率"], rows, "match-analysis-table"));
  container.append(makeTable(["失点時のサーブローテーション", "失点数"],
    rotationEntries.map(([label, count]) => [label, count]), "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "保存済み完了試合の入力済みデータのみを自動要約しています。得意・改善候補はチーム内の指標比較で、相手チームや競技水準との比較ではありません。ローテーション別失点は記録時のサーブ順を基準に集計します。";
  container.append(note);
}

function renderHistoricalLineupRecommendation(team, matches) {
  const section = document.createElement("section");
  section.className = "analysis-panel";
  const heading = document.createElement("h4");
  heading.textContent = "過去試合に基づくラインナップ提案";
  section.append(heading);
  const profileCounts = new Map();
  matches.forEach((match) => profileCounts.set(match.rules.matchProfile,
    (profileCounts.get(match.rules.matchProfile) || 0) + 1));
  const historicalProfile = [...profileCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const candidateMatches = matches.filter((match) => match.rules.matchProfile === historicalProfile);
  const targetSize = getCourtPlayerCount(candidateMatches[0] || currentMatch);
  const startsByPosition = Array.from({ length: targetSize }, () => new Map());
  const players = new Map();
  let lineupSamples = 0;
  for (const match of candidateMatches) {
    const teamInMatch = match.teams.find((item) => team.code
      ? item.code === team.code || !item.code && item.name === team.name
      : !item.code && item.name === team.name);
    if (!teamInMatch) continue;
    const performance = getPerformanceStats(teamInMatch, match.sets);
    for (const player of teamInMatch.players) {
      const key = player.number;
      const entry = players.get(key) || { player, appearances: 0, rating: 0 };
      entry.appearances += performance.playerSetsPlayed.get(player.id) || 0;
      const stats = performance.players.get(player.id);
      if (stats) {
        entry.rating += stats.attack.points + stats.backAttack.points
          + stats.block.points * 1.5 + stats.serve.points * 2
          - stats.attack.errors - stats.backAttack.errors - stats.serve.errors;
      }
      players.set(key, entry);
    }
    for (const set of match.sets) {
      const lineup = set.startingLineups?.[teamInMatch.id] || [];
      const starters = lineup.slice(0, targetSize);
      if (starters.length !== targetSize || starters.some((id) =>
        !teamInMatch.players.some((player) => player.id === id))
        || new Set(starters).size !== targetSize) continue;
      lineupSamples += 1;
      starters.forEach((id, position) => {
        const player = teamInMatch.players.find((item) => item.id === id);
        const count = startsByPosition[position];
        count.set(player.number, (count.get(player.number) || 0) + 1);
      });
    }
  }
  if (!players.size) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "対象形式の過去試合がありません。";
    section.append(empty);
    return section;
  }
  const chosen = new Set();
  const rows = startsByPosition.map((positionCounts, index) => {
    const candidate = [...players.entries()].filter(([number]) => !chosen.has(number))
      .sort(([numberA, a], [numberB, b]) =>
        ((positionCounts.get(numberB) || 0) * 100 + b.appearances + b.rating)
        - ((positionCounts.get(numberA) || 0) * 100 + a.appearances + a.rating))[0];
    if (!candidate) return [`P${index + 1}`, "記録不足"];
    chosen.add(candidate[0]);
    return [`P${index + 1}`, `#${candidate[0]} ${candidate[1].player.name}`];
  });
  const card = document.createElement("div");
  card.className = "lineup-recommendation-card";
  const cardHeading = document.createElement("strong");
  cardHeading.textContent = `推奨スタメン / 推奨ローテ (${targetSize}人制)`;
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = `同じ競技形式の完了試合 ${candidateMatches.length}試合、開始順を確認できたセット ${lineupSamples}件を参照。起用頻度と記録された個人成績を使った候補で、ポジション適性・戦術効果を判定するものではありません。`;
  card.append(cardHeading, makeTable(["位置 / サーブ順", "推奨選手"], rows, "match-analysis-table"), note);
  section.append(card);
  return section;
}

function renderMedicalEntryOptions() {
  const teamSelect = byId("medical-team");
  const playerSelect = byId("medical-player");
  if (!teamSelect || !playerSelect) return;
  const previousTeam = teamSelect.value;
  teamSelect.replaceChildren();
  currentMatch.teams.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    teamSelect.append(option);
  });
  teamSelect.value = currentMatch.teams.some((team) => team.id === previousTeam)
    ? previousTeam : currentMatch.teams[0].id;
  const team = currentMatch.teams.find((item) => item.id === teamSelect.value);
  const previousPlayer = playerSelect.value;
  playerSelect.replaceChildren();
  (team?.players || []).forEach((player) => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `#${player.number} ${player.name}`;
    playerSelect.append(option);
  });
  playerSelect.value = team?.players.some((player) => player.id === previousPlayer)
    ? previousPlayer : team?.players[0]?.id || "";
  byId("record-medical-event").disabled = !matchHasStarted() || !canScore(currentMatch) || !playerSelect.value;
}

function renderTrainingMatchOptions() {
  const select = byId("training-match");
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  const matches = new Map(store.matches.map((match) => [match.id, match]));
  matches.set(currentMatch.id, currentMatch);
  const saved = [...matches.values()].sort((a, b) =>
    (b.matchInfo.matchDate || "").localeCompare(a.matchInfo.matchDate || ""));
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = saved.length ? "保存済み試合を選択" : "保存済み試合はありません";
  select.append(placeholder);
  saved.forEach((match) => {
    const option = document.createElement("option");
    option.value = match.id;
    option.textContent = `${match.matchInfo.matchDate || "日付未設定"} | ${match.teams.map((team) => team.name).join(" vs ")}`;
    select.append(option);
  });
  if (matches.has(previous)) select.value = previous;
}

function renderRefereeQuestion() {
  const container = byId("referee-training-question");
  container.replaceChildren();
  const matches = new Map(store.matches.map((match) => [match.id, match]));
  matches.set(currentMatch.id, currentMatch);
  const match = matches.get(byId("training-match").value);
  if (!match) {
    container.append(Object.assign(document.createElement("p"), {
      className: "empty-message",
      textContent: "教材にする保存済み試合を選択してください。",
    }));
    return;
  }
  const scenarios = match.sets.flatMap((set) => set.events
    .map((event, index) => ({ event, index, set }))
    .filter(({ event }) => event.type === "timeout")
    .map(({ event, index, set }) => {
      const nextEvents = set.events.slice(index + 1).filter((item) =>
        ["score", "challenge", "service-order-violation", "medical"].includes(item.type)).slice(0, 3);
      return { event, set, nextEvents };
    }).filter((scenario) => scenario.nextEvents.length >= 2));
  if (!scenarios.length) {
    container.append(Object.assign(document.createElement("p"), {
      className: "empty-message",
      textContent: "この試合には、タイムアウト後の記録順を出題できる十分なイベントがありません。別の試合を選んでください。",
    }));
    return;
  }
  const scenario = scenarios[refereeQuestionOffset % scenarios.length];
  refereeQuestionOffset += 1;
  const team = match.teams.find((item) => item.id === scenario.event.teamId);
  const heading = document.createElement("h3");
  heading.textContent = `${match.matchInfo.matchDate || "日付未設定"} / 第${scenario.set.number}セット`;
  const context = document.createElement("p");
  context.textContent = `${scenario.event.currentScore || "スコア不明"}　${team?.name || "チーム"}タイムアウト。その後の実際の記録順はどれですか？`;
  const correct = scenario.nextEvents.map((event) => getEventDescription(match, event));
  const choices = [
    correct,
    [...correct].reverse(),
    correct.length > 2 ? [correct[1], correct[0], ...correct.slice(2)] : [correct[1], correct[0]],
    correct.length > 2 ? [correct[0], ...correct.slice(2), correct[1]] : [correct[0], correct[1]],
  ].filter((items, index, all) => all.findIndex((candidate) => candidate.join("\n") === items.join("\n")) === index);
  choices.sort(() => Math.random() - 0.5);
  const feedback = document.createElement("p");
  feedback.className = "notice";
  feedback.hidden = true;
  const list = document.createElement("div");
  list.className = "referee-training-choices";
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary";
    button.dataset.trainingAnswer = String(choice.join("\n") === correct.join("\n"));
    button.textContent = `${String.fromCharCode(65 + index)}. ${choice.join(" → ")}`;
    button.addEventListener("click", () => {
      list.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      feedback.hidden = false;
      feedback.textContent = button.dataset.trainingAnswer === "true"
        ? "正解です。保存試合に記録された順序と一致します。"
        : `不正解です。実際の記録順は: ${correct.join(" → ")}`;
    });
    list.append(button);
  });
  container.append(heading, context, list, feedback);
}

function renderTeamProfiles() {
  for (const id of ["team-history-a", "team-history-b"]) {
    const select = byId(id);
    const previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = store.teamProfiles.length ? "保存履歴を選択" : "履歴はありません";
    select.append(placeholder);
    store.teamProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.code ? `${profile.code} / ` : ""}${profile.name} — ${new Date(profile.savedAt).toLocaleString("ja-JP")} (${profile.players.length}名)`;
      select.append(option);
    });
    if (store.teamProfiles.some((profile) => profile.id === previous)) select.value = previous;
    select.disabled = matchHasStarted() || store.teamProfiles.length === 0;
  }
  for (const id of ["save-team-history-a", "save-team-history-b", "load-team-history-a", "load-team-history-b", "delete-team-history-a", "delete-team-history-b"]) {
    const disabled = matchHasStarted() || (id.startsWith("load") && store.teamProfiles.length === 0) || (id.startsWith("delete") && store.teamProfiles.length === 0);
    byId(id).disabled = disabled;
  }
}

function saveTeamProfile(teamIndex) {
  if (matchHasStarted()) return showError("試合開始後はチーム履歴を変更できません。");
  const team = currentMatch.teams[teamIndex];
  const codeInput = byId(teamIndex === 0 ? "team-code-a" : "team-code-b");
  const code = team.code || createTeamCode(team.name);
  if (code && currentMatch.teams.some((other, index) => index !== teamIndex && other.code === code)) {
    return showError("同じ試合の両チームに同じチームコードは設定できません。");
  }
  codeInput.value = code;
  team.code = code;
  team.staff = Object.fromEntries(
    [...elements.teamCards[teamIndex].querySelectorAll("[data-team-staff-key]")]
      .map((input) => [input.dataset.teamStaffKey, input.value.trim().slice(0, 40)]),
  );
  const name = team.name.trim();
  if (!name || !team.players.length) {
    return showError("チーム名と選手を登録してから履歴に保存してください。");
  }
  store.teamProfiles.unshift({
    id: createId(),
    name,
    code,
    savedAt: new Date().toISOString(),
    players: structuredClone(team.players),
    rotationLineup: [...team.rotationLineup],
    uniformColor: team.uniformColor || "#1d4ed8",
    liberoUniformColor: team.liberoUniformColor || "#facc15",
    staff: { ...team.staff },
  });
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  scheduleSave(true);
  renderTeamProfiles();
  renderTournamentParticipants();
  clearError();
}

function deleteTeamProfile(teamIndex) {
  const selectId = teamIndex === 0 ? "team-history-a" : "team-history-b";
  const profileId = byId(selectId).value;
  if (!profileId) return;
  store.teamProfiles = store.teamProfiles.filter((profile) => profile.id !== profileId);
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  scheduleSave(true);
  renderTeamProfiles();
  renderTournamentParticipants();
  clearError();
}

function clearTeamHistory() {
  if (!store.teamProfiles.length) return;
  if (!confirm("保存されているチーム履歴をすべて削除しますか？この操作は取り消せません。")) return;
  store.teamProfiles = [];
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  scheduleSave(true);
  renderTeamProfiles();
  renderTournamentParticipants();
  clearError();
}

function clearMatchHistory() {
  if (!store.matches.length) return;
  if (!confirm("保存されている試合履歴をすべて削除しますか？この操作は取り消せません。")) return;
  store.matches.forEach((match) => recordAudit("delete", "試合履歴", "保存履歴から試合を削除", undefined, match));
  clearActiveVideo();
  store.matches = [];
  store.tournaments.forEach((tournament) => {
    tournament.matchIds = [];
    tournament.fixtures?.forEach((fixture) => {
      if (fixture.matchId) {
        fixture.matchId = "";
        delete fixture.winnerCode;
      }
    });
  });
  currentMatch = createEmptyMatch();
  store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
  scheduleSave(true);
  renderHistory();
  render();
  clearError();
}

function loadTeamProfile(teamIndex) {
  if (matchHasStarted()) return showError("試合開始後はチーム履歴を読み込めません。");
  const select = byId(teamIndex === 0 ? "team-history-a" : "team-history-b");
  const codeInput = byId(teamIndex === 0 ? "team-code-a" : "team-code-b");
  const selectedProfileId = select.value;
  const enteredCode = codeInput.value.trim().toUpperCase();
  const profile = store.teamProfiles.find((item) => item.id === selectedProfileId)
    || (enteredCode ? getTournamentTeamProfiles().find((item) => item.code === enteredCode) : null);
  if (!profile) return showError("読み込むチーム履歴を選択してください。");
  const team = currentMatch.teams[teamIndex];
  if (profile.code && currentMatch.teams.some((other, index) => index !== teamIndex && other.code === profile.code)) {
    return showError("同じ試合の両チームに同じチームコードは設定できません。");
  }
  const ids = new Map();
  team.players = profile.players.map((player) => {
    const id = createId();
    ids.set(player.id, id);
    return { ...player, id, isLibero: Boolean(player.isLibero) };
  });
  team.name = profile.name;
  team.code = profile.code || "";
  team.uniformColor = profile.uniformColor || "#1d4ed8";
  team.liberoUniformColor = profile.liberoUniformColor || "#facc15";
  team.staff = { ...(profile.staff || {}) };
  team.rotationLineup = profile.rotationLineup.map((id) => ids.get(id) || "");
  currentMatch.sets.forEach((set) => { set.startingLineups[team.id] = [...team.rotationLineup]; });
  byId(teamIndex === 0 ? "team-name-setup-a" : "team-name-setup-b").value = team.name;
  render();
  scheduleSave(true);
  clearError();
}

function renderTeams() {
  const rosterLocked = matchHasStarted();
  currentMatch.teams.forEach((team, index) => {
    team.players = sortPlayersByNumber(team.players);
    renderTeamCard(elements.teamCards[index], team, index, currentMatch.rules.rosterLimit, rosterLocked);
    elements.teamCards[index].classList.add(index === 0 ? "team-a" : "team-b");
  });
  for (const id of ["sub-team", "libero-team", "sanction-team", "rally-team", "challenge-team", "correction-team"]) {
    const select = byId(id);
    const previous = select.value;
    select.replaceChildren();
    currentMatch.teams.forEach((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = team.name || `チーム ${team.id === currentMatch.teams[0].id ? "A" : "B"}`;
      select.append(option);
    });
    if (currentMatch.teams.some((team) => team.id === previous)) select.value = previous;
  }
  renderRallyEntryForm();
  renderTeamProfiles();
  renderRosterPhotoControls(rosterLocked);
}

function renderRosterPhotoControls(rosterLocked) {
  const select = byId("roster-photo-team");
  const previous = select.value;
  select.replaceChildren();
  currentMatch.teams.forEach((team, index) => {
    select.append(new Option(team.name || `チーム ${index === 0 ? "A" : "B"}`, team.id));
  });
  if (currentMatch.teams.some((team) => team.id === previous)) select.value = previous;
  select.disabled = rosterLocked || photoReadInProgress;
  byId("roster-photo-file").disabled = rosterLocked || photoReadInProgress;
  byId("roster-photo-read").disabled = rosterLocked || photoReadInProgress || !byId("roster-photo-file").files?.length;
  byId("roster-photo-camera").disabled = rosterLocked || photoReadInProgress;
  byId("roster-photo-register").disabled = rosterLocked;
}

function appendPhotoRow(row = {}) {
  const tr = document.createElement("tr");
  const cell = (child) => { const td = document.createElement("td"); td.append(child); tr.append(td); return td; };
  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = true;
  include.setAttribute("aria-label", "この行を登録する");
  include.dataset.photoField = "include";
  const number = document.createElement("input");
  number.type = "text";
  number.inputMode = "numeric";
  number.maxLength = 3;
  number.value = row.number || "";
  number.setAttribute("aria-label", "背番号");
  number.dataset.photoField = "number";
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 60;
  name.value = row.name || "";
  name.setAttribute("aria-label", "氏名");
  name.dataset.photoField = "name";
  const captain = document.createElement("input");
  captain.type = "checkbox";
  captain.checked = Boolean(row.isCaptain);
  captain.setAttribute("aria-label", "キャプテン(C)");
  captain.dataset.photoField = "captain";
  const libero = document.createElement("input");
  libero.type = "checkbox";
  libero.checked = Boolean(row.isLibero);
  libero.setAttribute("aria-label", "リベロ(L)");
  libero.dataset.photoField = "libero";
  const position = document.createElement("select");
  position.setAttribute("aria-label", "ポジション");
  position.dataset.photoField = "position";
  position.append(new Option("未設定", ""));
  for (const [code, label] of PLAYER_POSITIONS) position.append(new Option(`${label}（${code}）`, code));
  position.value = row.position || "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-player";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "この行を削除");
  remove.addEventListener("click", () => tr.remove());
  [include, number, name, captain, libero, position, remove].forEach(cell);
  byId("roster-photo-rows").append(tr);
}

function readPhotoRows() {
  return [...byId("roster-photo-rows").querySelectorAll("tr")].map((tr) => {
    const field = (key) => tr.querySelector(`[data-photo-field="${key}"]`);
    return {
      include: field("include").checked,
      number: field("number").value.trim(),
      name: field("name").value.trim(),
      isCaptain: field("captain").checked,
      isLibero: field("libero").checked,
      position: field("position").value,
    };
  });
}

function resetPhotoImport() {
  byId("roster-photo-rows").replaceChildren();
  byId("roster-photo-result").hidden = true;
  byId("roster-photo-file").value = "";
  byId("roster-photo-read").disabled = true;
}

async function readRosterPhoto(file = byId("roster-photo-file").files?.[0]) {
  const status = byId("roster-photo-status");
  if (!file || photoReadInProgress) return;
  if (!file.type.startsWith("image/") || file.size > MAX_ROSTER_PHOTO_BYTES) {
    status.textContent = "画像ファイル（25MB以下）を選択してください。";
    return;
  }
  photoReadInProgress = true;
  renderRosterPhotoControls(matchHasStarted());
  byId("roster-photo-result").hidden = true;
  status.textContent = "読み取りを準備しています…";
  try {
    const text = await recognizeRosterImage(file, (message) => {
      if (message.status) {
        const percent = typeof message.progress === "number" ? ` ${Math.round(message.progress * 100)}%` : "";
        status.textContent = `${message.status}${percent}`;
      }
    });
    const { rows, skipped } = parseRosterText(text);
    byId("roster-photo-rows").replaceChildren();
    rows.slice(0, 60).forEach(appendPhotoRow);
    if (!rows.length) {
      status.textContent = "選手を読み取れませんでした。明るい場所で、表全体が正面から写るように撮影し直すか、下の「行を追加」で入力してください。";
      appendPhotoRow();
    } else {
      status.textContent = `${rows.length}件を読み取りました${skipped ? `（認識できなかった行 ${skipped}件）` : ""}。内容を確認・修正してから「選択した選手を登録」を押してください。`;
    }
    byId("roster-photo-result").hidden = false;
  } catch (error) {
    console.error(error);
    status.textContent = `読み取りに失敗しました。${error?.message || ""} 手入力でも登録できます。`;
  } finally {
    photoReadInProgress = false;
    renderRosterPhotoControls(matchHasStarted());
  }
}

function registerPhotoPlayers() {
  if (matchHasStarted()) {
    showError("試合記録開始後は選手登録を変更できません。試合開始前に修正してください。");
    return;
  }
  const team = getTeam(byId("roster-photo-team").value);
  const selected = readPhotoRows().filter((row) => row.include);
  const errors = [];
  if (!selected.length) errors.push("登録する行を選択してください。");
  const numbers = new Set(team.players.map((player) => player.number));
  for (const row of selected) {
    const label = row.number ? `#${row.number}` : "背番号なし";
    if (!/^\d{1,3}$/.test(row.number) || !row.name) errors.push(`${label}: 背番号（1〜3桁）と氏名を入力してください。`);
    else if (numbers.has(row.number)) errors.push(`${label}: 背番号が重複しています。`);
    numbers.add(row.number);
  }
  if (team.players.length + selected.length > currentMatch.rules.rosterLimit) {
    errors.push(`登録できる選手数の上限（${currentMatch.rules.rosterLimit}名）を超えます。`);
  }
  if (team.players.filter((player) => player.isLibero).length + selected.filter((row) => row.isLibero).length > MAX_LIBEROS) {
    errors.push(`リベロは${MAX_LIBEROS}人まで登録できます。`);
  }
  if (selected.filter((row) => row.isCaptain).length > 1) errors.push("キャプテンは1人だけ選択してください。");
  if (errors.length) {
    byId("roster-photo-status").textContent = errors.slice(0, 6).join(" / ");
    showError("写真からの登録内容に問題があります。内容を修正してください。");
    return;
  }
  const added = selected.map((row) => ({
    id: createId(),
    number: row.number,
    name: row.name.slice(0, 60),
    isCaptain: row.isCaptain,
    isLibero: row.isLibero,
    position: row.position,
  }));
  if (added.some((player) => player.isCaptain)) team.players.forEach((player) => { player.isCaptain = false; });
  team.players.push(...added);
  recordAudit("add", "選手登録（写真）", `${team.name} ${added.length}名`);
  byId("roster-photo-status").textContent = `${added.length}名を登録しました。`;
  resetPhotoImport();
  clearError();
  render();
  scheduleSave(true);
}

function bindRosterPhotoImport() {
  byId("roster-photo-file").addEventListener("change", () => renderRosterPhotoControls(matchHasStarted()));
  byId("roster-photo-read").addEventListener("click", () => readRosterPhoto());
  const cameraInput = byId("roster-photo-camera-file");
  byId("roster-photo-camera").addEventListener("click", () => cameraInput.click());
  cameraInput.addEventListener("change", () => {
    const file = cameraInput.files?.[0];
    cameraInput.value = "";
    if (file) readRosterPhoto(file);
  });
  byId("roster-photo-add-row").addEventListener("click", () => appendPhotoRow());
  byId("roster-photo-register").addEventListener("click", registerPhotoPlayers);
  byId("roster-photo-discard").addEventListener("click", () => {
    resetPhotoImport();
    byId("roster-photo-status").textContent = "読み取り結果を破棄しました。";
  });
}

function renderScoreboard() {
  const set = currentSet();
  const [teamA, teamB] = currentMatch.teams;
  const scoreA = getScore(set, teamA.id);
  const scoreB = getScore(set, teamB.id);
  const result = getSetResult(currentMatch, set);
  const target = getSetTarget(currentMatch, set.number);
  const setWins = getSetWins(currentMatch);
  const winsNeeded = Math.floor(currentMatch.rules.bestOf / 2) + 1;
  const matchWinner = setWins.find((entry) => entry.wins >= winsNeeded);
  elements.scoreboard.replaceChildren();

  const teamScore = (team, score, teamIndex) => {
    const card = document.createElement("div");
    card.className = `score-team ${teamIndex === 0 ? "team-a" : "team-b"}`;
    const teamLabel = document.createElement("span");
    teamLabel.className = "score-team-label";
    teamLabel.textContent = teamIndex === 0 ? "TEAM A" : "TEAM B";
    const name = document.createElement("span");
    name.className = "score-team-name";
    name.textContent = team.name || "チーム";
    const number = document.createElement("strong");
    number.className = "score-number";
    number.textContent = String(score);
    number.setAttribute("aria-label", `${team.name} ${score}点`);
    const controls = document.createElement("div");
    controls.className = "point-controls";
    for (const [change, label] of [[1, "+1"], [-1, "−1"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `button ${change > 0 ? "button-primary" : "button-secondary"} point-button`;
      button.textContent = label;
      button.dataset.scoreTeam = team.id;
      button.dataset.delta = String(change);
      button.disabled = !canScore(currentMatch) || (change < 0 && score === 0);
      button.setAttribute("aria-label", `${team.name} ${change > 0 ? "に1点加点" : "から1点減点"}`);
      controls.append(button);
    }
    card.append(teamLabel, name, number, controls);
    return card;
  };

  const middle = document.createElement("div");
  middle.className = "score-middle";
  const setTitle = document.createElement("strong");
  setTitle.textContent = `第${set.number}セット`;
  const targetText = document.createElement("span");
  targetText.textContent = `目標 ${target}点`;
  const stateText = document.createElement("span");
  stateText.textContent = result ? "セット終了" : "試合中";
  middle.append(setTitle, targetText, stateText);
  if (matchHasStarted() && !matchWinner) {
    const probabilityA = Math.round(100 / (1 + Math.exp(-(
      (setWins[0].wins - setWins[1].wins) * 1.5
      + (scoreA - scoreB) * 2.5 / Math.max(target, 1)
    ))));
    const probability = document.createElement("div");
    probability.className = "live-win-probability";
    probability.setAttribute("aria-live", "polite");
    probability.append(
      Object.assign(document.createElement("strong"), { textContent: "勝率予測（簡易）" }),
      Object.assign(document.createElement("span"), { textContent: `${teamA.name} ${probabilityA}%` }),
      Object.assign(document.createElement("span"), { textContent: `${teamB.name} ${100 - probabilityA}%` }),
    );
    middle.append(probability);
  }
  elements.scoreboard.append(teamScore(teamA, scoreA, 0), middle, teamScore(teamB, scoreB, 1));

  elements.state.textContent = matchWinner
    ? `試合終了：${getTeam(matchWinner.teamId).name} 勝利`
    : result ? `第${set.number}セット終了` : "試合中";
  elements.nextSet.hidden = !result || Boolean(matchWinner) || currentMatch.sets.length >= currentMatch.rules.bestOf || Boolean(pendingSetSetup);
  elements.nextSet.textContent = `第${currentMatch.sets.length + 1}セットの設定へ`;
  elements.nextSet.disabled = currentMatch.sets.length >= 5;
  elements.teamCards.forEach((card, index) => {
    const mini = card.querySelector("[data-team-score]");
    if (mini) mini.textContent = String(index === 0 ? scoreA : scoreB);
  });
}

function renderSetStrip() {
  elements.setStrip.replaceChildren();
  const wins = getSetWins(currentMatch);
  const winner = wins.find((entry) => entry.wins >= Math.floor(currentMatch.rules.bestOf / 2) + 1);
  for (let i = 1; i <= currentMatch.rules.bestOf; i += 1) {
    const set = currentMatch.sets[i - 1];
    const chip = document.createElement("span");
    chip.className = `set-chip${set ? " current" : ""}${set && getSetResult(currentMatch, set) ? " complete" : ""}`;
    if (set) {
      const a = getScore(set, currentMatch.teams[0].id);
      const b = getScore(set, currentMatch.teams[1].id);
      chip.textContent = `第${i}セット ${a} - ${b}`;
      if (i < currentMatch.sets.length) chip.classList.remove("current");
    } else {
      chip.textContent = `第${i}セット —`;
    }
    elements.setStrip.append(chip);
  }
  if (winner) elements.state.textContent = `試合終了：${getTeam(winner.teamId).name} 勝利`;
}

function renderEvents() {
  const events = currentSet().events;
  const videoEventById = new Map(getAllVideoEvents().map((item) => [item.event.id, item.event]));
  elements.eventLog.replaceChildren();
  elements.emptyLog.hidden = events.length > 0;
  for (const event of [...events].reverse()) {
    const time = new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const description = getEventDescription(currentMatch, event);
    const row = makeEventRow(time, description);
    const videoButton = document.createElement("button");
    videoButton.type = "button";
    videoButton.className = "button button-secondary event-video-button";
    videoButton.dataset.videoEvent = event.id;
    videoButton.textContent = "動画へ移動";
    const videoPosition = getVideoEventPosition(event.id, videoEventById);
    videoButton.disabled = !isVideoReady() || !Number.isFinite(videoPosition) || videoPosition < 0;
    if (videoButton.disabled) videoButton.title = "動画を再選択し、イベントの同期ポイントを登録してください。";
    row.append(videoButton);
    elements.eventLog.append(row);
  }
}

function getAllVideoEvents() {
  return currentMatch.sets.flatMap((set) => set.events.map((event, index) => ({
    event, set, index, setNumber: set.number,
  })));
}

function getVideoEventKind(event) {
  if (event.type === "serve-fault") return "serve";
  if (!["score", "play", "rally-play"].includes(event.type)) return "";
  if (event.type === "score" && (event.delta <= 0 || event.correctionSource)) return "";
  const kind = event.statPlayKind || event.playKind || event.playType;
  if (kind === "back-attack" || kind === "backAttack") return "backAttack";
  if (["serveReception", "reception", "attackReception"].includes(kind)) return "reception";
  return ["attack", "block", "serve", "reception"].includes(kind) ? kind : "";
}

function getVideoEventOutcome(event) {
  if (event.type === "serve-fault") return "error";
  if (event.type === "score" && event.delta > 0) return "point";
  return event.outcome || "";
}

function getVideoEventRotations() {
  const rotationsByEvent = new Map();
  if (!usesCourtRotation(currentMatch)) return rotationsByEvent;
  const count = getCourtPlayerCount(currentMatch);
  for (const set of currentMatch.sets) {
    const rotations = Object.fromEntries(currentMatch.teams.map((team) => [team.id, 0]));
    let server = set.initialServiceTeamId || currentMatch.teams[0].id;
    const corrected = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => event.correctionOf));
    for (const event of set.events) {
      rotationsByEvent.set(event.id, { ...rotations });
      if (event.type !== "score" || event.delta <= 0 || event.correctionSource || corrected.has(event.id)) continue;
      if (server !== event.teamId) rotations[event.teamId] = (rotations[event.teamId] || 0) + 1;
      server = event.teamId;
    }
  }
  return new Map([...rotationsByEvent].map(([eventId, rotations]) => [
    eventId,
    Object.fromEntries(Object.entries(rotations).map(([teamId, count]) => [teamId, count % getCourtPlayerCount(currentMatch) + 1])),
  ]));
}

function getVideoClipItems() {
  const selectedTeamId = byId("video-filter-team").value;
  const playerId = byId("video-filter-player").value;
  const selectedKind = byId("video-filter-kind").value;
  const selectedRotation = byId("video-filter-rotation").value;
  const rotations = getVideoEventRotations();
  return getAllVideoEvents().filter(({ event, set }) => {
    if (event.type === "score" && event.statPlayKind
      && set.events.some((rally) => rally.type === "rally-play" && rally.outcome === "point"
        && rally.teamId === event.teamId && rally.playerId === event.playerId
        && getVideoEventKind(rally) === getVideoEventKind(event))) return false;
    const kind = getVideoEventKind(event);
    const outcome = getVideoEventOutcome(event);
    if (!kind || (selectedTeamId && event.teamId !== selectedTeamId)) return false;
    if (playerId && event.playerId !== playerId) return false;
    if (selectedKind.startsWith("miss-")) {
      return kind === selectedKind.slice(5) && outcome === "error";
    }
    if (selectedKind !== "all" && kind !== selectedKind) return false;
    if (selectedRotation && rotations.get(event.id)?.[selectedTeamId] !== Number(selectedRotation)) return false;
    return true;
  });
}

function isVideoReady() {
  const player = byId("match-video-player");
  return Boolean(activeVideoUrl && player.readyState >= 1 && !player.error);
}

function getPlayableVideoClipItems() {
  const videoEventById = new Map(getAllVideoEvents().map((item) => [item.event.id, item.event]));
  return isVideoReady()
    ? getVideoClipItems().filter(({ event }) => {
      const position = getVideoEventPosition(event.id, videoEventById);
      return Number.isFinite(position) && position >= 0;
    })
    : [];
}

function formatVideoTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 3600)).padStart(2, "0")}:${String(Math.floor(safeSeconds / 60) % 60).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function renderVideoPanel() {
  const { video } = currentMatch;
  byId("match-video-name").textContent = `登録動画: ${video.fileName || "なし"}`;
  byId("match-video-sync-count").textContent = `同期ポイント: ${video.syncPoints.length}件`;
  byId("video-sync-count").textContent = `同期ポイント ${video.syncPoints.length}件`;
  const player = byId("match-video-player");
  if (activeVideoFileName && activeVideoFileName !== video.fileName) clearActiveVideo();
  if (!activeVideoUrl) {
    byId("video-playback-status").textContent = video.fileName
      ? `登録済み動画「${video.fileName}」のファイル本体は保存されていません。再生するには試合設定から動画を再選択してください。`
      : "試合設定から動画ファイルを選択してください。";
  }

  const events = getAllVideoEvents();
  const eventSelect = byId("video-sync-event");
  const previousEventId = eventSelect.value;
  eventSelect.replaceChildren();
  if (events.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "イベントがありません";
    eventSelect.append(option);
  } else {
    for (const { event, setNumber } of events) {
      const option = document.createElement("option");
      option.value = event.id;
      option.textContent = `第${setNumber}セット ${new Date(event.time).toLocaleTimeString("ja-JP")} — ${getEventDescription(currentMatch, event)}`;
      eventSelect.append(option);
    }
  }
  if (events.some(({ event }) => event.id === previousEventId)) eventSelect.value = previousEventId;

  const teamSelect = byId("video-filter-team");
  const previousTeamId = teamSelect.value;
  teamSelect.replaceChildren();
  for (const team of currentMatch.teams) {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    teamSelect.append(option);
  }
  teamSelect.value = currentMatch.teams.some((team) => team.id === previousTeamId)
    ? previousTeamId : currentMatch.teams[0].id;
  const playerSelect = byId("video-filter-player");
  const previousPlayerId = playerSelect.value;
  playerSelect.replaceChildren();
  const allPlayers = document.createElement("option");
  allPlayers.value = "";
  allPlayers.textContent = "全選手";
  playerSelect.append(allPlayers);
  const selectedTeam = currentMatch.teams.find((team) => team.id === teamSelect.value);
  for (const player of selectedTeam?.players || []) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `#${player.number} ${player.name}`;
    playerSelect.append(option);
  }
  playerSelect.value = [...playerSelect.options].some((option) => option.value === previousPlayerId)
    ? previousPlayerId : "";
  const rotationSelect = byId("video-filter-rotation");
  const previousRotation = rotationSelect.value;
  rotationSelect.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "すべて" }));
  if (usesCourtRotation(currentMatch)) {
    for (let rotation = 1; rotation <= getCourtPlayerCount(currentMatch); rotation += 1) {
      const option = document.createElement("option");
      option.value = String(rotation);
      option.textContent = `ローテーション${rotation}`;
      rotationSelect.append(option);
    }
  }
  rotationSelect.value = [...rotationSelect.options].some((option) => option.value === previousRotation)
    ? previousRotation : "";

  const syncList = byId("video-sync-point-list");
  syncList.replaceChildren();
  const indexedEvents = new Map(events.map((item) => [item.event.id, item]));
  for (const point of [...video.syncPoints].sort((a, b) => a.videoTime - b.videoTime)) {
    const item = indexedEvents.get(point.eventId);
    if (!item) continue;
    const row = document.createElement("p");
    row.className = "video-sync-point";
    const seekButton = document.createElement("button");
    seekButton.type = "button";
    seekButton.className = "button button-secondary";
    seekButton.dataset.videoSyncTime = String(point.videoTime);
    seekButton.textContent = `${formatVideoTime(point.videoTime)} — 第${item.setNumber}セット ${getEventDescription(currentMatch, item.event)}`;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "button button-secondary";
    removeButton.dataset.removeVideoSync = point.eventId;
    removeButton.textContent = "削除";
    row.append(seekButton, removeButton);
    syncList.append(row);
  }
  const clips = getVideoClipItems();
  let playableClipCount = 0;
  const clipList = byId("video-event-clips");
  clipList.replaceChildren();
  const rotations = getVideoEventRotations();
  const videoEventById = new Map(events.map((item) => [item.event.id, item.event]));
  for (const { event, setNumber } of clips) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary event-video-button";
    button.dataset.videoEvent = event.id;
    const videoPosition = getVideoEventPosition(event.id, videoEventById);
    button.disabled = !isVideoReady() || !Number.isFinite(videoPosition) || videoPosition < 0;
    if (!button.disabled) playableClipCount += 1;
    else button.title = "動画を再選択し、イベントの同期ポイントを登録してください。";
    const team = currentMatch.teams.find((entry) => entry.id === event.teamId);
    const player = team?.players.find((entry) => entry.id === event.playerId);
    const rotation = rotations.get(event.id)?.[team?.id];
    button.textContent = `第${setNumber}セット ${new Date(event.time).toLocaleTimeString("ja-JP")} — ${team?.name || ""}${player ? ` #${player.number} ${player.name}` : ""} / ${getVideoEventKind(event)}${rotation ? ` / ローテーション${rotation}` : ""} / 動画へ移動`;
    item.append(button);
    clipList.append(item);
  }
  byId("video-filter-summary").textContent = `${clips.length}件のイベントを抽出（再生可能 ${playableClipCount}件）。`;
  byId("play-filtered-video-events").disabled = playableClipCount === 0;
}

function clearActiveVideo() {
  stopVideoPlaybackQueue();
  const player = byId("match-video-player");
  player.pause();
  player.removeAttribute("src");
  player.load();
  if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl = "";
  activeVideoFileName = "";
}

function stopVideoPlaybackQueue() {
  videoPlaybackQueue = [];
  videoPlaybackQueueIndex = -1;
  byId("stop-filtered-video-events").disabled = true;
}

function seekAdjacentSyncPoint(direction) {
  if (!isVideoReady()) {
    showError("同期ポイントへ移動するには、試合設定から動画ファイルを再選択してください。");
    return;
  }
  const player = byId("match-video-player");
  const points = [...currentMatch.video.syncPoints].sort((a, b) => a.videoTime - b.videoTime);
  const candidate = direction < 0
    ? points.filter((point) => point.videoTime < player.currentTime).at(-1)
    : points.find((point) => point.videoTime > player.currentTime);
  if (!candidate) {
    byId("video-playback-status").textContent = direction < 0
      ? "前の同期ポイントはありません。" : "次の同期ポイントはありません。";
    return;
  }
  player.currentTime = candidate.videoTime;
}

function getVideoEventPosition(eventId, eventById = new Map(getAllVideoEvents().map((item) => [item.event.id, item.event]))) {
  const target = eventById.get(eventId);
  if (!target || !Number.isFinite(Date.parse(target.time))) return null;
  const points = currentMatch.video.syncPoints
    .map((point) => ({ point, event: eventById.get(point.eventId) }))
    .filter((item) => item.event && Number.isFinite(Date.parse(item.event.time)));
  if (!points.length) return null;
  const nearest = points.reduce((best, item) =>
    Math.abs(Date.parse(item.event.time) - Date.parse(target.time))
      < Math.abs(Date.parse(best.event.time) - Date.parse(target.time)) ? item : best);
  return nearest.point.videoTime + (Date.parse(target.time) - Date.parse(nearest.event.time)) / 1000;
}

async function jumpToVideoEvent(eventId, autoplay = false) {
  const videoPlayer = byId("match-video-player");
  if (!activeVideoUrl || activeVideoFileName !== currentMatch.video.fileName) {
    byId("video-playback-status").textContent = "動画ファイルを再選択してから動画へ移動してください。";
    showError("動画のファイル本体が読み込まれていません。試合設定で該当動画を再選択してください。");
    return false;
  }
  if (!isVideoReady()) {
    byId("video-playback-status").textContent = "動画を読み込めません。ファイル形式・コーデックを確認してください。";
    showError("動画の読み込みが完了していないか、再生できないファイルです。");
    return false;
  }
  const position = getVideoEventPosition(eventId);
  if (!Number.isFinite(position) || position < 0) {
    byId("video-playback-status").textContent = "このイベントに利用できる同期ポイントがありません。先に同期ポイントを登録してください。";
    showError("選択したイベントへ移動できません。有効な同期ポイントを登録してください。");
    return false;
  }
  if (Number.isFinite(videoPlayer.duration) && position > videoPlayer.duration) {
    byId("video-playback-status").textContent = "計算した動画時刻が動画の長さを超えています。同期ポイントを確認してください。";
    showError("動画時刻がファイルの長さを超えています。同期ポイントを確認してください。");
    return false;
  }
  videoPlayer.currentTime = position;
  byId("video-sync-event").value = eventId;
  byId("video-playback-status").textContent = `動画位置 ${formatVideoTime(position)} に移動しました。`;
  navigateTo("video-sync");
  if (autoplay) {
    try {
      await videoPlayer.play();
      return true;
    } catch (error) {
      stopVideoPlaybackQueue();
      byId("video-playback-status").textContent = `動画を再生できませんでした: ${error.message}`;
      showError(`動画を再生できませんでした: ${error.message}`);
      return false;
    }
  }
  return true;
}

function qualityYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function qualityNow() {
  return performance.now();
}

function qualityProgress(message, completed = 0, total = 0) {
  const status = byId("qa-run-status");
  if (status) status.textContent = message;
  const progress = byId("qa-progress");
  if (progress && total > 0) {
    progress.hidden = false;
    progress.value = Math.min(100, Math.round(completed / total * 100));
  }
}

function renderQualityReport(report = lastQualityReport) {
  if (!report) return;
  const summary = report.summary;
  byId("quality-assurance-summary").replaceChildren(
    Object.assign(document.createElement("h2"), { textContent: "品質保証レポート" }),
    Object.assign(document.createElement("p"), { textContent: `開始: ${report.startedAt} / 終了: ${report.finishedAt || "実行中"}` }),
    Object.assign(document.createElement("p"), { textContent: `総試験数 ${summary.total}　成功 ${summary.passed}　失敗 ${summary.failed}　平均 ${summary.averageProcessingMs.toFixed(1)} ms　最大 ${summary.maxProcessingMs.toFixed(1)} ms` }),
    Object.assign(document.createElement("p"), { textContent: `未処理例外 ${summary.unhandledExceptions}　データ破損 ${summary.dataCorruption}　整合性エラー ${summary.integrityErrors}　集計エラー ${summary.aggregationErrors}　警告 ${summary.warnings}` }),
  );
  const table = document.createElement("table");
  table.className = "match-analysis-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["試験", "結果", "処理時間", "詳細"].forEach((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const test of report.tests) {
    const row = document.createElement("tr");
    const details = Array.isArray(test.details) ? test.details.join(" / ") : test.details || test.error || "";
    [test.name, test.status, `${test.durationMs.toFixed(1)} ms`, details].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    });
    body.append(row);
  }
  table.append(body);
  byId("quality-assurance-results").replaceChildren(table);
  byId("export-quality-report").disabled = false;
}

function updateQualityReportSummary(report) {
  const times = report.tests.map((test) => test.durationMs);
  report.summary = {
    total: report.tests.length,
    passed: report.tests.filter((test) => test.status === "passed").length,
    failed: report.tests.filter((test) => test.status === "failed").length,
    warnings: report.tests.reduce((count, test) => count + (test.warning ? 1 : 0), 0),
    averageProcessingMs: times.length ? times.reduce((total, time) => total + time, 0) / times.length : 0,
    maxProcessingMs: Math.max(0, ...times),
    unhandledExceptions: report.tests.filter((test) => test.category === "exception" && test.status === "failed").length,
    dataCorruption: report.tests.filter((test) => test.category === "corruption" && test.status === "failed").length,
    integrityErrors: report.tests.filter((test) => test.category === "integrity" && test.status === "failed").length,
    aggregationErrors: report.tests.filter((test) => test.category === "aggregation" && test.status === "failed").length,
  };
}

function setQualitySuiteInputs(suite) {
  byId("qa-suite-select").value = suite;
  navigateTo("quality-assurance");
}

async function runQualityAssurance(suite, includeStress = false) {
  if (!developerModeEnabled) {
    showError("品質保証機能は開発者モードでのみ利用できます。URLに ?developer=1 を指定してください。");
    return;
  }
  if (qualityRunActive) return;
  const selectedMatchCount = Number(byId("qa-match-count").value);
  const selectedEventCount = Number(byId("qa-event-count").value);
  const selectedStressEvents = Number(byId("qa-stress-event-count").value);
  const stressEvents = includeStress
    ? selectedStressEvents || (suite === "stress" ? 50_000 : 0)
    : suite === "stress" ? selectedStressEvents || 50_000 : 0;
  if ((selectedMatchCount >= 1000 || stressEvents >= 500_000)
    && !confirm("大規模な試験は時間と一時ストレージを多く使用します。生成データは別の一時DBに保存し、終了時に削除します。続行しますか？")) return;

  qualityRunActive = true;
  byId("run-quality-tests").disabled = true;
  byId("run-all-quality-tests").disabled = true;
  byId("clear-quality-report").disabled = true;
  byId("qa-progress").hidden = false;
  byId("qa-progress").value = 0;
  const originalMatch = currentMatch;
  const report = {
    reportVersion: 1,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    mode: "developer",
    isolatedDatabase: true,
    productionDataModified: false,
    config: { suite, matchCount: selectedMatchCount, eventCount: selectedEventCount, stressEventCount: stressEvents },
    tests: [],
    summary: {},
  };
  lastQualityReport = report;
  let databaseHandle;
  let totalTests = ({
    durability: 7,
    load: 13,
    video: 7,
    integrity: 2,
    analytics: 13,
    stress: 37,
    regression: 38,
  })[suite] || 1;
  if (stressEvents && suite !== "stress") totalTests += 3;
  let completedTests = 0;
  const addTest = async (name, action, category = "general") => {
    qualityProgress(`実行中: ${name}`, completedTests, totalTests);
    const started = qualityNow();
    try {
      const details = await action();
      report.tests.push({
        name,
        category,
        status: "passed",
        durationMs: qualityNow() - started,
        details: typeof details === "string" ? details : details?.details || "",
        ...(details?.warning ? { warning: details.warning } : {}),
      });
    } catch (error) {
      report.tests.push({
        name,
        category: error.qaCategory || category,
        status: "failed",
        durationMs: qualityNow() - started,
        error: error?.message || String(error),
      });
    }
    completedTests += 1;
    updateQualityReportSummary(report);
    renderQualityReport(report);
    await qualityYield();
  };

  try {
    const handle = await openQualityDatabase();
    databaseHandle = handle.database;
    report.temporaryDatabase = handle.databaseName;
    qualityProgress("隔離した試験用データベースを準備中…", completedTests, totalTests);

    const runMatchVolume = async () => {
      let matches = [];
      await addTest("大量試合作成", async () => {
        const started = qualityNow();
        for (let index = 0; index < selectedMatchCount; index += 1) {
          const match = createQualityMatch({ index, eventCount: 221, syncPointCount: 1 });
          if (!isQualityMatchValid(match)) throw new Error(`生成した試合 ${index + 1} 件目の検証に失敗しました。`);
          matches.push(match);
          if ((index + 1) % 25 === 0) {
            qualityProgress(`試合を生成中: ${index + 1}/${selectedMatchCount}`, completedTests, totalTests);
            await qualityYield();
          }
        }
        return `${matches.length}試合を作成・検証 / ${(qualityNow() - started).toFixed(1)} ms / 各5セット / 14選手 / 統計・ローテーション・動画同期情報`;
      }, "corruption");
      if (matches.length !== selectedMatchCount) return;
      await addTest("大量試合の隔離保存", async () => {
        const records = matches.map((match) => ({
          id: match.id,
          kind: "matches",
          teamId: match.teams[0].id,
          seasonId: `season-${Number(match.matchInfo.matchDate.slice(0, 4))}`,
          match,
        }));
        const started = qualityNow();
        const written = await writeQualityRecords(databaseHandle, records, 25);
        if (written !== selectedMatchCount) throw new Error(`保存件数が一致しません: ${written}/${selectedMatchCount}`);
        return `保存 ${written} 件 / ${ (qualityNow() - started).toFixed(1)} ms`;
      }, "corruption");
      await addTest("大量試合の読込", async () => {
        const started = qualityNow();
        const loaded = await readQualityRecords(databaseHandle, "matches");
        if (loaded.length !== selectedMatchCount) throw new Error(`読込件数が一致しません: ${loaded.length}/${selectedMatchCount}`);
        for (let index = 0; index < loaded.length; index += 1) {
          if (!isQualityMatchValid(loaded[index].match)) throw new Error(`読込データ ${index + 1} 件目が破損しています。`);
          if ((index + 1) % 100 === 0) await qualityYield();
        }
        return `読込・全件再検証 ${loaded.length} 件 / ${(qualityNow() - started).toFixed(1)} ms`;
      }, "corruption");
      await addTest("大量試合の検索", async () => {
        const selected = matches.at(-1);
        const started = qualityNow();
        const found = await searchQualityRecords(databaseHandle, "teamId", selected.teams[0].id);
        if (found.length !== 1 || found[0].match.id !== selected.id) throw new Error("チームID検索の結果が一致しません。");
        return `検索1件 / ${(qualityNow() - started).toFixed(1)} ms`;
      });
      matches = [];
    };

    const runEventLoadCases = async () => {
      for (const targetCount of [100, 500, 1000, 2000]) {
        let fixture;
        await addTest(`${targetCount}イベント: 生成・表示・分析`, async () => {
          fixture = createQualityEventMatch(targetCount);
          const events = fixture.sets.flatMap((set) => set.events);
          if (events.length !== targetCount) throw new Error(`イベント件数が一致しません: ${events.length}/${targetCount}`);
          if (!isQualityMatchValid(fixture)) throw new Error("生成したイベント試合データが不正です。");
          const displayStart = qualityNow();
          const fragment = document.createDocumentFragment();
          for (const event of events) fragment.append(makeEventRow(new Date(event.time).toLocaleTimeString("ja-JP"), getEventDescription(fixture, event)));
          const displayMs = qualityNow() - displayStart;
          const previous = currentMatch;
          currentMatch = fixture;
          const analysisStart = qualityNow();
          for (const team of fixture.teams) getPerformanceStats(team);
          getRotationAnalysis();
          const analysisMs = qualityNow() - analysisStart;
          currentMatch = previous;
          return `表示行 ${events.length}: ${displayMs.toFixed(1)} ms / 分析: ${analysisMs.toFixed(1)} ms`;
        }, "aggregation");
        if (!fixture) continue;
        await addTest(`${targetCount}イベント: 保存・読込`, async () => {
          const record = { id: fixture.id, kind: "event-fixture", teamId: fixture.teams[0].id, match: fixture };
          const writeStart = qualityNow();
          await writeQualityRecords(databaseHandle, [record]);
          const writeMs = qualityNow() - writeStart;
          const readStart = qualityNow();
          const loaded = await readQualityRecords(databaseHandle, "event-fixture");
          const readMs = qualityNow() - readStart;
          if (!loaded.some((item) => item.id === fixture.id && isQualityMatchValid(item.match))) throw new Error("保存後のイベントデータを再読込できません。");
          const matchEvents = loaded.find((item) => item.id === fixture.id).match.sets.flatMap((set) => set.events);
          if (matchEvents.length !== targetCount) throw new Error("読込イベント件数が一致しません。");
          return `保存: ${writeMs.toFixed(1)} ms / 読込: ${readMs.toFixed(1)} ms`;
        }, "corruption");
        await addTest(`${targetCount}イベント: 検索`, async () => {
          const found = await searchQualityRecords(databaseHandle, "teamId", fixture.teams[0].id);
          if (!found.some((item) => item.id === fixture.id)) throw new Error("イベント試合の検索に失敗しました。");
          return `検索一致 ${found.length} 件`;
        });
      }
    };

    const runLongDeuce = async () => {
      const match = createQualityMatch({ index: 8800, fullMatch: true, longDeuce: true, eventCount: 300, syncPointCount: 10 });
      currentMatch = match;
      if (!isQualityMatchValid(match)) throw new Error("デュースを含む試合データが不正です。");
      const scores = match.sets.map((set) => [getScore(set, match.teams[0].id), getScore(set, match.teams[1].id)]);
      const expected = [[50, 48], [48, 50], [52, 50], [20, 25], [15, 13]];
      if (JSON.stringify(scores) !== JSON.stringify(expected)) throw new Error("デュース得点の集計が一致しません。");
      if (match.sets.some((set) => !getSetResult(match, set))) throw new Error("デュースセットの終了判定に失敗しました。");
      if (!isMatchComplete(match) || getSetWins(match).find((item) => item.teamId === match.teams[0].id)?.wins !== 3) {
        throw new Error("試合終了または勝敗判定が一致しません。");
      }
      for (const set of match.sets) {
        getServingState(match, set);
        const rotations = getRotationAnalysis();
        if (rotations.size !== 2) throw new Error("ローテーション集計に失敗しました。");
      }
      for (const team of match.teams) getPerformanceStats(team);
      return "50-48 / 48-50 / 52-50 / 20-25 / 15-13、セット終了・3-2勝敗・サーブ順・統計を確認";
    };

    const runVideoSyncCases = async () => {
      const fixture = createQualityEventMatch(1000);
      const original = currentMatch;
      currentMatch = fixture;
      for (const syncCount of [1, 3, 10]) {
        await addTest(`動画同期 ${syncCount}ポイント`, async () => {
          const events = getAllVideoEvents();
          fixture.video.syncPoints = Array.from({ length: syncCount }, (_, index) => {
            const eventIndex = syncCount === 1 ? 0 : Math.floor(index * (events.length - 1) / (syncCount - 1));
            const event = events[eventIndex].event;
            const elapsed = (Date.parse(event.time) - Date.parse(fixture.createdAt)) / 1000;
            return { eventId: event.id, videoTime: elapsed + 8.5 };
          });
          if (!isQualityMatchValid(fixture)) throw new Error("動画同期ポイントの参照検証に失敗しました。");
          const eventById = new Map(events.map((item) => [item.event.id, item.event]));
          let maxError = 0;
          for (const { event } of events) {
            const actual = getVideoEventPosition(event.id, eventById);
            const expected = (Date.parse(event.time) - Date.parse(fixture.createdAt)) / 1000 + 8.5;
            if (!Number.isFinite(actual)) throw new Error(`動画時刻を計算できません: ${event.id}`);
            maxError = Math.max(maxError, Math.abs(actual - expected));
          }
          if (maxError > 1) throw new Error(`動画時刻誤差が±1秒を超えました: ${maxError.toFixed(3)}秒`);
          renderVideoPanel();
          byId("video-filter-team").value = fixture.teams[0].id;
          const playerId = fixture.teams[0].players[0].id;
          byId("video-filter-player").value = playerId;
          const selectedClips = getVideoClipItems();
          if (!selectedClips.some(({ event }) => event.playerId === playerId)) throw new Error("選手別動画抽出に失敗しました。");
          return `対象イベント ${events.length} 件 / 最大誤差 ${maxError.toFixed(3)} 秒 / 選手別抽出 ${selectedClips.length} 件`;
        }, "aggregation");
      }
      currentMatch = original;
    };

    const runVideoLoadCases = async () => {
      const previous = currentMatch;
      for (const eventCount of [100, 500, 1000]) {
        await addTest(`動画連携負荷 ${eventCount}イベント`, async () => {
          const fixture = createQualityEventMatch(eventCount);
          const events = getAllVideoEventsFor(fixture);
          fixture.video.syncPoints = events.filter((_, index) => index % Math.max(1, Math.floor(eventCount / 10)) === 0)
            .slice(0, 10).map(({ event }) => ({
              eventId: event.id,
              videoTime: (Date.parse(event.time) - Date.parse(fixture.createdAt)) / 1000 + 8.5,
            }));
          currentMatch = fixture;
          renderVideoPanel();
          byId("video-filter-team").value = fixture.teams[0].id;
          const indexed = new Map(events.map((item) => [item.event.id, item.event]));
          const jumpStart = qualityNow();
          for (const { event } of events) {
            if (!Number.isFinite(getVideoEventPosition(event.id, indexed))) throw new Error("動画ジャンプ時刻を算出できません。");
          }
          const jumpMs = qualityNow() - jumpStart;
          const extractStart = qualityNow();
          const clips = getVideoClipItems();
          const extractMs = qualityNow() - extractStart;
          const sequentialStart = qualityNow();
          let resolved = 0;
          for (const { event } of clips) {
            if (Number.isFinite(getVideoEventPosition(event.id, indexed))) resolved += 1;
          }
          const sequentialResolveMs = qualityNow() - sequentialStart;
          if (!clips.length || resolved !== clips.length) throw new Error("動画イベント抽出・連続シーク解決に失敗しました。");
          return `ジャンプ ${jumpMs.toFixed(1)} ms / 抽出 ${extractMs.toFixed(1)} ms / 連続シーク解決 ${sequentialResolveMs.toFixed(1)} ms (${resolved}件)`;
        }, "aggregation");
      }
      currentMatch = previous;
    };

    const runAnalytics = async () => {
      const fixture = createQualityMatch({ index: 9900, eventCount: 260, syncPointCount: 10 });
      currentMatch = fixture;
      await addTest("MVP・勝因分析", () => {
        renderMatchAnalysis(null);
        if (!byId("match-mvp-analysis").textContent.trim() || !byId("match-cause-analysis").textContent.trim()) {
          throw new Error("MVPまたは勝因分析の出力が空です。");
        }
        return "MVP候補・得点源別勝因・比較出力を確認";
      }, "aggregation");
      await addTest("チームDNA・ローテーション分析", () => {
        renderTeamDossier(fixture.teams[0], [fixture]);
        const rotations = getRotationAnalysis();
        if (rotations.size !== 2 || !byId("team-dossier").textContent.includes("チームDNA分析")) {
          throw new Error("チームDNAまたはローテーション分析に失敗しました。");
        }
        return "チームDNA・失点ローテーションを確認";
      }, "aggregation");
      await addTest("シーズン分析", () => {
        renderSeasonStats();
        if (!byId("season-summary").textContent.trim()) throw new Error("シーズン分析の出力が空です。");
        return "選手別シーズン集計を確認";
      }, "aggregation");
      await addTest("相手チーム分析", () => {
        const participant = { code: fixture.teams[0].code, name: fixture.teams[0].name };
        renderOpponentScouting({ participants: [participant] });
        if (!byId("opponent-scouting-results").textContent.includes("最近")) throw new Error("相手チーム分析の出力がありません。");
        return "最近の試合・対戦相手指標を確認";
      }, "aggregation");
      await addTest("選手分析", () => {
        for (const team of fixture.teams) {
          const stats = getPerformanceStats(team);
          if (stats.players.size !== 7) throw new Error("選手別集計の人数が一致しません。");
          for (const playerStats of stats.players.values()) {
            if (Object.values(playerStats).some((category) => Object.values(category).some((value) => !Number.isFinite(value)))) {
              throw new Error("選手別集計に数値異常があります。");
            }
          }
        }
        return "全14選手の攻撃・守備・サーブ集計を確認";
      }, "aggregation");
      await addTest("リベロ分析", () => {
        renderLiberoAnalysis();
        return "リベロ分析パネルを例外なく描画";
      }, "aggregation");
      await addTest("サーブ分析", () => {
        renderServeCourseAnalysis();
        for (const team of fixture.teams) getPerformanceStats(team);
        return "サーブ効果・得点集計を確認";
      }, "aggregation");
      await addTest("レシーブ分析", () => {
        renderReceptionCourseAnalysis();
        for (const team of fixture.teams) getPerformanceStats(team);
        return "レセプション指標・コースパネルを確認";
      }, "aggregation");
      await addTest("交代効果分析", () => {
        renderBenchworkAnalysis();
        return "交代・タイムアウト後の指標を描画";
      }, "aggregation");
      await addTest("試合・セット・得点推移分析", () => {
        renderMatchAnalysis(null);
        if (!byId("match-set-comparison").textContent.trim()
          || !byId("match-loss-analysis").textContent.trim()
          || !byId("score-progression-chart").textContent.trim()) throw new Error("試合・セット・得点推移分析の出力が空です。");
        return "試合比較・失点要因・得点チャートを確認";
      }, "aggregation");
      await addTest("年度比較・マッチアップ分析", () => {
        renderMatchupComparison();
        if (!byId("matchup-comparison").textContent.trim()) throw new Error("マッチアップ分析の出力が空です。");
        return "チーム相対指標を確認";
      }, "aggregation");
      await addTest("プレー・イベント履歴分析", () => {
        const descriptions = fixture.sets.flatMap((set) => set.events).map((event) => getEventDescription(fixture, event));
        if (!descriptions.length || descriptions.some((description) => typeof description !== "string")) {
          throw new Error("イベント記述の集計に失敗しました。");
        }
        return `${descriptions.length}件のイベント記述を生成`;
      }, "aggregation");
    };

    const runIntegrityAudit = async () => {
      const matches = new Map(store.matches.map((match) => [match.id, match]));
      if (originalMatch) matches.set(originalMatch.id, originalMatch);
      let issueCount = 0;
      let checkedSets = 0;
      let checkedEvents = 0;
      for (const [index, match] of [...matches.values()].entries()) {
        if (!isQualityMatchValid(match)) throw Object.assign(new Error(`試合 ${match.id} のデータ検証に失敗しました。`), { qaCategory: "integrity" });
        const eventIds = new Set();
        for (const set of match.sets) {
          checkedSets += 1;
          const ids = new Set(set.events.map((event) => event.id));
          for (const event of set.events) {
            checkedEvents += 1;
            if (eventIds.has(event.id)) issueCount += 1;
            eventIds.add(event.id);
            for (const reference of [event.correctionOf, event.rallyEventId, event.scoreEventId]) {
              if (reference && !ids.has(reference)) issueCount += 1;
            }
          }
          issueCount += getIntegrityIssues(match, set).length;
        }
        if (issueCount) throw Object.assign(new Error(`整合性監査で ${issueCount} 件の問題を検出しました。試合: ${match.id}`), { qaCategory: "integrity" });
        if ((index + 1) % 10 === 0) await qualityYield();
      }
      const generated = createQualityMatch({ index: 9910, eventCount: 240 });
      if (!isQualityMatchValid(generated)) throw Object.assign(new Error("生成した試験試合の整合性がありません。"), { qaCategory: "integrity" });
      return `試合 ${matches.size + 1} 件 / セット ${checkedSets + generated.sets.length} / イベント ${checkedEvents + generated.sets.reduce((total, set) => total + set.events.length, 0)} / 問題 ${issueCount}`;
    };

    const runStress = async () => {
      const targetEvents = stressEvents || 50_000;
      const expectedPlayers = 50_000;
      let batch = [];
      let recordsWritten = 0;
      let playersWritten = 0;
      let teamsWritten = 0;
      let seasonsWritten = 0;
      let eventsWritten = 0;
      const writeStart = qualityNow();
      for (const record of createQualityStressRecords({ eventCount: targetEvents })) {
        batch.push(record);
        if (record.kind === "players") playersWritten += record.entities.length;
        if (record.kind === "events") eventsWritten += record.entities.length;
        if (record.kind === "teams") teamsWritten += 1;
        if (record.kind === "seasons") seasonsWritten += 1;
        if (batch.length >= 100) {
          recordsWritten += await writeQualityRecords(databaseHandle, batch, 100);
          batch = [];
          if (recordsWritten % 500 === 0) {
            qualityProgress(`ストレスデータを保存中: ${eventsWritten}/${targetEvents}イベント`, completedTests, totalTests);
            await qualityYield();
          }
        }
      }
      if (batch.length) recordsWritten += await writeQualityRecords(databaseHandle, batch, 100);
      if (playersWritten !== expectedPlayers || teamsWritten !== 500 || seasonsWritten !== 100 || eventsWritten !== targetEvents) {
        throw Object.assign(new Error(`生成数が一致しません（${playersWritten}選手 / ${teamsWritten}チーム / ${seasonsWritten}シーズン / ${eventsWritten}イベント）。`), { qaCategory: "corruption" });
      }
      const saveMs = qualityNow() - writeStart;
      await addTest("最大ストレス試験: 保存", () => `${recordsWritten}レコード / ${playersWritten}選手 / ${teamsWritten}チーム / ${seasonsWritten}シーズン / ${eventsWritten}イベント / ${saveMs.toFixed(1)} ms`, "corruption");
      const readStart = qualityNow();
      const [players, eventBatches, teams, seasons] = await Promise.all([
        readQualityRecords(databaseHandle, "players"),
        readQualityRecords(databaseHandle, "events"),
        readQualityRecords(databaseHandle, "teams"),
        readQualityRecords(databaseHandle, "seasons"),
      ]);
      const loadedPlayerCount = players.reduce((total, record) => total + record.entities.length, 0);
      const loadedEventCount = eventBatches.reduce((total, record) => total + record.entities.length, 0);
      const readMs = qualityNow() - readStart;
      if (loadedPlayerCount !== expectedPlayers || loadedEventCount !== targetEvents || teams.length !== 500 || seasons.length !== 100) {
        throw Object.assign(new Error("ストレスデータの読込件数が一致しません。"), { qaCategory: "corruption" });
      }
      await addTest("最大ストレス試験: 読込", () => `${loadedPlayerCount}選手・${loadedEventCount}イベントを読込 / ${readMs.toFixed(1)} ms`, "corruption");
      const searchStart = qualityNow();
      const found = await searchQualityRecords(databaseHandle, "teamId", "team-499");
      const queryEvents = found.filter((record) => record.kind === "events")
        .reduce((total, record) => total + record.entities.length, 0);
      const searchMs = qualityNow() - searchStart;
      if (!found.some((record) => record.kind === "teams") || !queryEvents) {
        throw Object.assign(new Error("ストレスデータのチーム検索に失敗しました。"), { qaCategory: "integrity" });
      }
      await addTest("最大ストレス試験: 検索・集計", () => `team-499 検索 ${found.length}レコード / ${queryEvents}イベント / ${searchMs.toFixed(1)} ms`, "aggregation");
    };

    const runMemoryTrial = async () => {
      const fixture = createQualityMatch({ index: 9920, eventCount: 240 });
      const initialHeap = performance.memory?.usedJSHeapSize;
      const start = qualityNow();
      for (let index = 0; index < 1_000; index += 1) {
        const switched = structuredClone(fixture);
        if (switched.id !== fixture.id || switched.sets.length !== 5) throw new Error("試合切替用コピーの内容が一致しません。");
        if ((index + 1) % 100 === 0) {
          qualityProgress(`試合切替リーク試験: ${index + 1}/1,000`, completedTests, totalTests);
          await qualityYield();
        }
      }
      const duration = qualityNow() - start;
      const finalHeap = performance.memory?.usedJSHeapSize;
      const heapDelta = Number.isFinite(initialHeap) && Number.isFinite(finalHeap) ? finalHeap - initialHeap : null;
      if (heapDelta !== null && heapDelta > 64 * 1024 * 1024) throw new Error(`ヒープ増加量が64MiBを超えました: ${(heapDelta / 1024 / 1024).toFixed(1)} MiB`);
      return {
        details: `試合の独立コピーを1,000回生成・解放 / ${duration.toFixed(1)} ms${heapDelta === null ? "" : ` / ヒープ差 ${(heapDelta / 1024 / 1024).toFixed(1)} MiB`}`,
        ...(!Number.isFinite(initialHeap) || !Number.isFinite(finalHeap)
          ? { warning: "このブラウザーはJSヒープ統計を公開していません。メモリ増加量は計測不可です。" }
          : {}),
      };
    };

    const plans = {
      durability: [runMatchVolume, runLongDeuce, runMemoryTrial],
      load: [runEventLoadCases],
      video: [runVideoSyncCases, runVideoLoadCases],
      integrity: [runIntegrityAudit],
      analytics: [runAnalytics],
      stress: [runMatchVolume, runEventLoadCases, runVideoSyncCases, runAnalytics, runIntegrityAudit, runStress, runMemoryTrial],
      regression: [runMatchVolume, runEventLoadCases, runLongDeuce, runVideoSyncCases, runVideoLoadCases, runAnalytics, runIntegrityAudit, runMemoryTrial],
    };
    if (stressEvents && suite !== "stress") plans[suite]?.push(runStress);
    if (!plans[suite]) throw new Error(`不明な品質保証試験です: ${suite}`);
    for (const testGroup of plans[suite]) {
      if (testGroup === runMatchVolume) await runMatchVolume();
      else if (testGroup === runEventLoadCases) await runEventLoadCases();
      else if (testGroup === runLongDeuce) await addTest("長時間試合・フルデュース", runLongDeuce, "aggregation");
      else if (testGroup === runVideoSyncCases) await runVideoSyncCases();
      else if (testGroup === runVideoLoadCases) await runVideoLoadCases();
      else if (testGroup === runAnalytics) await runAnalytics();
      else if (testGroup === runIntegrityAudit) await addTest("全試合データ整合性監査", runIntegrityAudit, "integrity");
      else if (testGroup === runStress) await runStress();
      else if (testGroup === runMemoryTrial) await addTest("メモリリーク・1,000回切替", runMemoryTrial, "exception");
    }
    if (!report.tests.length) {
      await addTest("品質保証起動確認", () => "隔離DBを作成しました。", "general");
    }
  } catch (error) {
    report.tests.push({
      name: "品質保証ランナー",
      category: "exception",
      status: "failed",
      durationMs: 0,
      error: error?.message || String(error),
    });
  } finally {
    currentMatch = originalMatch;
    try {
      if (databaseHandle) {
        const databaseName = report.temporaryDatabase;
        databaseHandle.close();
        await deleteQualityDatabase(databaseName);
        report.tests.push({
          name: "試験データ自動削除",
          category: "cleanup",
          status: "passed",
          durationMs: 0,
          details: "隔離した一時IndexedDBを削除しました。",
        });
      }
    } catch (error) {
      report.tests.push({
        name: "試験データ自動削除",
        category: "corruption",
        status: "failed",
        durationMs: 0,
        error: `試験用データベースの削除に失敗しました: ${error.message}`,
      });
    }
    report.finishedAt = new Date().toISOString();
    updateQualityReportSummary(report);
    renderQualityReport(report);
    render();
    if (developerModeEnabled) navigateTo("quality-assurance", false);
    qualityProgress(`試験完了: 成功 ${report.summary.passed} / 失敗 ${report.summary.failed} / 警告 ${report.summary.warnings}`, totalTests, totalTests);
    byId("run-quality-tests").disabled = false;
    byId("run-all-quality-tests").disabled = false;
    byId("clear-quality-report").disabled = false;
    qualityRunActive = false;
  }
}

function getAllVideoEventsFor(match) {
  return match.sets.flatMap((set) => set.events.map((event, index) => ({
    event, set, index, setNumber: set.number,
  })));
}

function initializeDeveloperMode() {
  developerModeEnabled = new URLSearchParams(location.search).get("developer") === "1";
  byId("developer-quality-nav").hidden = !developerModeEnabled;
}

function renderTimeouts() {
  elements.timeoutActions.replaceChildren();
  for (const team of currentMatch.teams) {
    const count = currentSet().events.filter((event) => event.type === "timeout" && event.teamId === team.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary";
    button.dataset.timeoutTeam = team.id;
    button.textContent = `${team.name || "チーム"} (${count}/${currentMatch.rules.timeoutLimit})`;
    button.disabled = !canScore(currentMatch) || count >= currentMatch.rules.timeoutLimit;
    elements.timeoutActions.append(button);
  }
}

function renderSubstitutionMonitors() {
  const standardLines = [];
  const liberoLines = [];
  for (const team of currentMatch.teams) {
    const substitutions = getSetSubstitutionCount(currentSet(), team.id, "substitution");
    const remaining = Math.max(0, currentMatch.rules.substitutionLimit - substitutions);
    const warning = remaining === 0 ? "（上限）" : remaining === 1 ? "（残り1回）" : "";
    standardLines.push(`${team.name}: ${substitutions}/${currentMatch.rules.substitutionLimit}回 ${warning}`);
    const liberoSubs = getSetSubstitutionCount(currentSet(), team.id, "libero-substitution");
    const liberos = team.players.filter((player) => player.isLibero);
    const lineup = getCurrentLineup(currentMatch, currentSet(), team.id);
    const liberoText = liberos.length
      ? liberos.map((libero) => `${libero.name}${lineup.includes(libero.id) ? "（コート内）" : "（コート外）"}`).join("、")
      : "リベロ未登録";
    const last = [...currentSet().events].reverse().find((event) => event.type === "libero-substitution" && event.teamId === team.id);
    const lastLine = last ? ` / 直近: ${last.playerOut || "—"} → ${last.playerIn || "—"}` : "";
    liberoLines.push(`${team.name}: ${liberoSubs}回 / ${liberoText}${lastLine}`);
  }
  byId("substitution-monitor").textContent = standardLines.join("　・　");
  byId("substitution-monitor").classList.toggle("is-warning", currentMatch.teams.some((team) =>
    currentMatch.rules.substitutionLimit - getSetSubstitutionCount(currentSet(), team.id, "substitution") <= 1));
  byId("libero-monitor").textContent = liberoLines.join("\n");
  byId("record-substitution").disabled = !canScore(currentMatch)
    || currentMatch.teams.every((team) => getSetSubstitutionCount(currentSet(), team.id, "substitution") >= currentMatch.rules.substitutionLimit);
  byId("record-libero-substitution").disabled = !canScore(currentMatch);
  byId("record-score-correction").disabled = !matchHasStarted();
}

function renderTechnicalTimeoutStatus() {
  const configuredPoints = currentMatch.rules.technicalTimeoutPoints.filter((point) => point > 0);
  const recorded = currentSet().events.filter((event) => event.type === "technical-timeout");
  const manualButton = byId("record-technical-timeout");
  manualButton.disabled = !matchHasStarted() || !canScore(currentMatch);
  byId("technical-timeout-status").textContent = configuredPoints.length
    ? `自動発生点: ${configuredPoints.map((point) => `${point}点`).join("・")} / 記録: ${recorded.length}回`
    : `自動発生点は未設定です / 記録: ${recorded.length}回`;
}

function renderDurationStatus() {
  byId("match-duration-live").textContent = `試合時間: ${getElapsed(currentMatch.matchInfo.startedAt, currentMatch.matchInfo.endedAt)}`;
  byId("set-duration-live").textContent = `第${currentSet().number}セット時間: ${getElapsed(currentSet().startedAt, currentSet().endedAt)}`;
}

function renderChallenges() {
  const status = byId("challenge-status");
  if (!status) return;
  const summary = currentMatch.teams.map((team) => {
    const failures = currentSet().events.filter((event) =>
      event.type === "challenge" && event.teamId === team.id && event.result === "failed").length;
    return `${team.name}: 失敗 ${failures}/2`;
  });
  status.textContent = `${summary.join(" / ")}（成功は回数を消費しません）`;
  byId("record-challenge").disabled = !canScore(currentMatch);
}

function renderMatchTimer() {
  if (!elements.timer || !currentMatch) return;
  renderDurationStatus();
  const timedEvents = currentMatch.sets.flatMap((set) => [
    ...set.events.filter((event) => ["timeout", "sto"].includes(event.type))
      .map((event) => ({ time: event.time, duration: 30, label: event.type === "sto" ? "STO" : "タイムアウト" })),
    ...(set.endedAt ? [{ time: set.endedAt, duration: 180, label: "セット間" }] : []),
  ]).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const latest = timedEvents[0];
  if (!latest) {
    elements.timer.hidden = true;
    elements.timer.textContent = "";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(latest.time) + latest.duration * 1000 - Date.now()) / 1000));
  elements.timer.hidden = seconds === 0;
  elements.timer.textContent = seconds
    ? `${latest.label} 残り ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : "";
}

function renderCourtChange() {
  const set = currentSet();
  const servingState = getServingState(currentMatch, set);
  const serveFaultButton = byId("nine-serve-fault");
  serveFaultButton.hidden = currentMatch.rules.matchProfile !== "nine";
  serveFaultButton.disabled = !canScore(currentMatch) || servingState.serveFaults >= 2;
  serveFaultButton.textContent = servingState.serveFaults === 0
    ? "9人制: 1回目のサーブ失敗を記録"
    : "9人制: 2回目のサーブ失敗を記録（相手に1点）";
  serveFaultButton.setAttribute("aria-label", `${getTeam(servingState.server)?.name || "サーブ側"}の${Math.min(servingState.serveFaults + 1, 2)}回目サーブ失敗を記録`);
  serveFaultButton.dataset.serveTeam = servingState.server;
  serveFaultButton.dataset.serveAttempt = String(Math.min(servingState.serveFaults + 1, 2));
  const target = getDecidingSetCourtChangePoint(currentMatch, set.number);
  const reached = set.events.some((event) => event.type === "court-change" && event.reason === "points");
  const maximum = Math.max(...currentMatch.teams.map((team) => getScore(set, team.id)));
  const youthStoDue = currentMatch.rules.category === "小学生"
    && currentMatch.rules.bestOf === 3
    && set.number === 3
    && !set.events.some((event) => event.type === "sto");
  const youthStoReached = youthStoDue && maximum >= 11;
  const courtChangeDue = target > 0 && !reached && maximum >= target;
  let status = "セット終了後のコートチェンジは大会設定に従います。";
  if (set.endedAt) {
    status = set.events.some((event) => event.type === "court-change" && event.reason === "set-end")
      ? "セット終了後のコートチェンジを記録しました。"
      : "このセット終了後のコートチェンジ設定はありません。";
  }
  else if (courtChangeDue) status = `コートチェンジ（${target}点）を記録しました。`;
  else if (target > 0) status = `決定セットのコートチェンジ: いずれかのチームが${target}点に到達したとき`;
  if (youthStoReached) status += " / STOを自動記録しました。";
  else if (youthStoDue) status += " / 小学生STOは11点で自動記録します。";
  byId("court-change-status").textContent = status;
  byId("court-change-status").classList.toggle("is-due", courtChangeDue || youthStoReached);
  byId("sto-status").textContent = youthStoDue
    ? youthStoReached ? "第3セットの11点STOは記録済みです（通常タイムアウト回数外）。" : "第3セットの11点到達時に自動記録します。"
    : "小学生3セットマッチの第3セットでのみ発生します。";
}

function renderRotationView(containerId, set, editable) {
  const container = byId(containerId);
  container.replaceChildren();
  const courtRotation = usesCourtRotation(currentMatch);
  const servingState = getServingState(currentMatch, set);
  const slots = getCourtPlayerCount(currentMatch);
  const serviceIndex = (team) => (servingState.serviceTurns[team.id] - 1 + slots) % slots;
  const positionLabels = currentMatch.rules.matchProfile === "nine"
    ? ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ"]
    : ["1", "2", "3", "4", "5", "6"];
  const makeSlot = (team, lineup, playerId, positionIndex, isServer, side, serviceOrder = false) => {
    const slot = document.createElement(editable ? "label" : "div");
    const selected = team.players.find((player) => player.id === playerId);
    slot.className = `rotation-slot${isServer ? " server" : ""}${serviceOrder ? " service-order-slot" : ""}${selected?.isLibero ? " libero-player" : ""}`;
    slot.style.setProperty("--player-accent", selected?.isLibero ? getLiberoDisplayColor(team) : getTeamDisplayColor(team));
    slot.dataset.position = String(positionIndex);
    const position = document.createElement("strong");
    position.textContent = serviceOrder ? `サーブ順 ${positionLabels[positionIndex]}` : `位置 ${positionLabels[positionIndex]}`;
    const person = document.createElement("span");
    person.textContent = selected ? `#${selected.number} ${selected.name}` : "未設定";
    slot.append(position, person);
    if (editable) {
      const select = document.createElement("select");
      select.dataset.rotationTeam = team.id;
      select.dataset.currentPosition = String(positionIndex);
      select.setAttribute("aria-label", `${team.name} ${position.textContent}の選手`);
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "選手を割当";
      select.append(empty);
      const assignedPlayerIds = new Set(lineup.filter((id) => id && id !== playerId));
      team.players
        .filter((player) => !assignedPlayerIds.has(player.id))
        .forEach((player) => {
          const option = document.createElement("option");
          option.value = player.id;
          option.textContent = `#${player.number} ${player.name}`;
          select.append(option);
        });
      select.value = playerId;

      slot.append(select);
    }
    return slot;
  };

  const makeSide = (teamIndex) => {
    const team = currentMatch.teams[teamIndex];
    const home = teamIndex === 0;
    const section = document.createElement("section");
    section.className = `rotation-side ${home ? "side-home team-a" : "side-away team-b"}`;
    const heading = document.createElement("h2");
    const turns = servingState.rotations[team.id] || 0;
    heading.textContent = `${team.name || `チーム ${home ? "A" : "B"}`} — ${courtRotation ? `ローテーション ${turns}回` : "サーブ順"}`;
    section.append(heading);

    const lineup = getCurrentLineup(currentMatch, set, team.id);
    if (courtRotation) {
      const grid = document.createElement("div");
      grid.className = `rotation-court ${slots === 9 ? "nine-player-court" : "six-player-court"}`;
      const order = slots === 6 ? [0, 1, 2, 3, 4, 5] : home
        ? [4, 5, 0, 3, 2, 1]
        : [1, 2, 3, 0, 5, 4];
      order.forEach((positionIndex) => {
        const cell = makeSlot(team, lineup, lineup[positionIndex] || "", positionIndex,
          servingState.server === team.id && positionIndex === 0, home ? "home" : "away");
        grid.append(cell);
      });
      section.append(grid);
    } else {
      const order = document.createElement("ol");
      order.className = "service-order-list";
      lineup.forEach((playerId, positionIndex) => {
        order.append(makeSlot(team, lineup, playerId, positionIndex,
          servingState.server === team.id && positionIndex === serviceIndex(team), home ? "home" : "away", true));
      });
      section.append(order);
    }
    return section;
  };

  const net = document.createElement("div");
  net.className = "court-net";
  net.setAttribute("aria-label", "ネット");
  net.textContent = "NET";
  container.append(makeSide(0), net, makeSide(1));
  return servingState;
}

function populateServingSelect(select, set, editable) {
  select.replaceChildren();
  currentMatch.teams.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name || "チーム";
    select.append(option);
  });
  select.value = set.initialServiceTeamId || currentMatch.teams[0].id;
  select.disabled = !editable;
}

function renderRotation() {
  const setupSet = pendingSetSetup || currentMatch.sets[0];
  const setupSetNumber = setupSet.number;
  const setupEditable = !matchHasStarted() || Boolean(pendingSetSetup);
  byId("rotation-page-title").textContent = pendingSetSetup
    ? `第${setupSetNumber}セット ローテーション・サーブ順設定`
    : "ローテーション・サーブ順設定";
  byId("rotation-page-description").textContent = pendingSetSetup
    ? `第${setupSetNumber}セットのコート配置と最初のサーブを設定し、開始確認へ進みます。`
    : "試合開始前に両チームの選手位置と第1サーバーを登録します。コート中央のネットをはさんで表示します。";
  byId("rotation-next-confirm").hidden = !pendingSetSetup;
  byId("rotation-cancel-setup").hidden = !pendingSetSetup;
  byId("rotation-next-staff").hidden = Boolean(pendingSetSetup);
  byId("prestart-server-label-text").textContent = `第${setupSetNumber}セットの最初のサーブ`;
  const prestartSelect = byId("prestart-initial-server");
  populateServingSelect(prestartSelect, setupSet, setupEditable);
  const prestartState = renderRotationView("prestart-rotation-layout", setupSet, setupEditable);
  const startServer = getTeam(prestartState.server);
  const startLineup = getCurrentLineup(currentMatch, setupSet, prestartState.server);
  const startSlot = usesCourtRotation(currentMatch) ? 0 : Math.max(0, prestartState.serviceTurns[prestartState.server] - 1) % startLineup.length;
  const startPlayer = startServer?.players.find((player) => player.id === startLineup[startSlot]);
  byId("prestart-server-indicator").textContent = `第${setupSetNumber}サーバー: ${startServer?.name || "未設定"}${startPlayer ? ` #${startPlayer.number} ${startPlayer.name}` : ""}`;

  const liveSet = currentSet();
  populateServingSelect(byId("initial-server"), liveSet, !matchHasStarted() && liveSet.events.length === 0);
  const liveState = renderRotationView("match-rotation-layout", liveSet, false);
  const servingTeam = getTeam(liveState.server);
  const liveLineup = getCurrentLineup(currentMatch, liveSet, liveState.server);
  const liveSlot = usesCourtRotation(currentMatch) ? 0 : Math.max(0, liveState.serviceTurns[liveState.server] - 1) % liveLineup.length;
  const serverPlayer = servingTeam?.players.find((player) => player.id === liveLineup[liveSlot]);
  byId("server-indicator").textContent = `サーバー: ${servingTeam?.name || "未設定"}${serverPlayer ? ` #${serverPlayer.number} ${serverPlayer.name}` : ""}`;

  const expectedServerId = getExpectedServerPlayerId(liveSet, liveState);
  const actualServerSelect = byId("actual-server-player");
  const previousActualServerId = actualServerSelect.value;
  actualServerSelect.replaceChildren();
  const unselected = document.createElement("option");
  unselected.value = "";
  unselected.textContent = "実際のサーバーを選択";
  actualServerSelect.append(unselected);
  currentMatch.teams.forEach((team) => team.players.forEach((player) => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `${team.name} #${player.number} ${player.name}`;
    actualServerSelect.append(option);
  }));
  actualServerSelect.value = currentMatch.teams.some((team) =>
    team.players.some((player) => player.id === previousActualServerId))
    ? previousActualServerId : "";
  renderServiceOrderStatus(expectedServerId);

  byId("rotation-mode-note").textContent = usesCourtRotation(currentMatch)
    ? "選手を各位置に割り当ててください。ネットが画面中央にあり、チームAは左側、チームBは右側です。第1サーバーは位置1です。"
    : "この競技形式ではコート上のローテーションは行わず、登録したサーブ順を表示します。順番に選手を割り当ててください。";
}

function renderServiceOrderStatus(expectedPlayerId = getExpectedServerPlayerId(currentSet())) {
  const actualPlayerId = byId("actual-server-player").value;
  const expected = currentMatch.teams.flatMap((team) => team.players).find((player) => player.id === expectedPlayerId);
  const actual = currentMatch.teams.flatMap((team) => team.players).find((player) => player.id === actualPlayerId);
  const status = byId("service-order-status");
  if (!actual || !expected) {
    status.textContent = "サーブ順確認のため、実際のサーバーを選択してください。";
    status.classList.remove("is-warning");
    return;
  }
  const matches = actual.id === expected.id;
  status.textContent = matches
    ? `登録順どおり: #${expected.number} ${expected.name}`
    : `サーブ順違反の可能性: #${actual.number} ${actual.name} / 登録順 #${expected.number} ${expected.name}`;
  status.classList.toggle("is-warning", !matches);
}

function fillPlayerSelect(select, players, selectedValue = "") {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "選手を選択（任意）";
  select.append(empty);
  players.forEach((player) => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `#${player.number} ${player.name}`;
    select.append(option);
  });
  select.value = selectedValue;
}

function renderRallyEntryForm() {
  const teamSelect = byId("rally-team");
  if (!teamSelect) return;
  const selectedTeamId = currentMatch.teams.some((team) => team.id === teamSelect.value)
    ? teamSelect.value : currentMatch.teams[0].id;
  teamSelect.value = selectedTeamId;
  const teamGroup = byId("rally-team-group");
  teamGroup?.replaceChildren();
  currentMatch.teams.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mini-select-button${item.id === selectedTeamId ? " selected" : ""}`;
    button.dataset.rallyTeam = item.id;
    button.textContent = item.name || `チーム ${index === 0 ? "A" : "B"}`;
    button.addEventListener("click", () => {
      teamSelect.value = item.id;
      renderRallyEntryForm();
    });
    teamGroup?.append(button);
  });

  const team = getTeam(selectedTeamId);
  const activePlayers = getCourtPlayers(selectedTeamId);
  const playerSelect = byId("rally-player");
  const previousPlayerId = playerSelect?.value;
  const playerGroup = byId("rally-player-group");
  if (playerGroup) {
    playerGroup.replaceChildren();
    if (activePlayers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "コートに入る選手をローテーションまたはサーブ順で設定してください。";
      playerGroup.append(empty);
    } else {
      activePlayers.forEach((player) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `mini-select-button${(previousPlayerId === player.id || (!activePlayers.some((item) => item.id === previousPlayerId) && activePlayers[0]?.id === player.id)) ? " selected" : ""}`;
        button.textContent = `#${player.number} ${player.name}`;
        button.dataset.playerId = player.id;
        button.dataset.teamId = team.id;
        button.dataset.playerRole = player.isLibero ? "libero" : "player";
        button.style.setProperty("--player-accent", player.isLibero ? getLiberoDisplayColor(team) : getTeamDisplayColor(team));
        button.addEventListener("click", () => {
          playerGroup.querySelectorAll(".mini-select-button[data-team-id]").forEach((node) => node.classList.toggle("selected", node === button));
          const playerSelect = byId("rally-player");
          if (playerSelect) playerSelect.value = player.id;
        });
        playerGroup.append(button);
      });
    }
  }
  if (playerSelect) {
    playerSelect.replaceChildren();
    activePlayers.forEach((player) => {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = `#${player.number} ${player.name}`;
      playerSelect.append(option);
    });
    playerSelect.value = activePlayers.some((player) => player.id === previousPlayerId)
      ? previousPlayerId : activePlayers[0]?.id || "";
  }

  const kindSelect = byId("rally-kind");
  const kindGroup = byId("rally-kind-group");
  kindGroup?.querySelectorAll("button").forEach((button) => {
    const selected = (kindSelect ? kindSelect.value : button.dataset.value) === button.dataset.value;
    button.classList.toggle("selected", selected);
  });

  const outcomeSelect = byId("rally-outcome");
  const outcomeGroup = byId("rally-outcome-group");
  outcomeGroup?.querySelectorAll("button").forEach((button) => {
    const selected = (outcomeSelect ? outcomeSelect.value : button.dataset.value) === button.dataset.value;
    button.classList.toggle("selected", selected);
  });
  const attackZoneField = byId("rally-attack-zone-field");
  const attackZoneSelect = byId("rally-attack-zone");
  const attackZoneVisible = ["attack", "backAttack"].includes(kindSelect?.value);
  if (attackZoneField) attackZoneField.hidden = !attackZoneVisible;
  if (attackZoneSelect && !attackZoneVisible) attackZoneSelect.value = "";
  const courseZoneField = byId("rally-course-zone-field");
  const courseZoneSelect = byId("rally-course-zone");
  const courseZoneLabel = byId("rally-course-zone-label");
  const courseClearButton = byId("rally-course-clear");
  const serveCourse = kindSelect?.value === "serve";
  const receptionCourse = ["reception", "serveReception", "attackReception"].includes(kindSelect?.value);
  if (courseZoneField) courseZoneField.hidden = !serveCourse && !receptionCourse;
  if (courseZoneLabel) courseZoneLabel.textContent = `5 ${serveCourse ? "サーブコース（狙った先）" : "レシーブコース（受けた位置）"}`;
  if (courseZoneSelect && !serveCourse && !receptionCourse) courseZoneSelect.value = "";
  if (courseClearButton) {
    const courseNotRecorded = !courseZoneSelect?.value;
    courseClearButton.classList.toggle("selected", courseNotRecorded);
    courseClearButton.setAttribute("aria-pressed", String(courseNotRecorded));
  }
  const courseCourt = byId("rally-course-court");
  if (courseCourt) {
    courseCourt.replaceChildren();
    const oppositeHalf = document.createElement("div");
    oppositeHalf.className = `rally-course-half${serveCourse ? " active" : ""}`;
    oppositeHalf.setAttribute("aria-label", serveCourse ? "サーブの狙い先コート" : "相手コート");
    const nearHalf = document.createElement("div");
    nearHalf.className = `rally-course-half${receptionCourse ? " active" : ""}`;
    nearHalf.setAttribute("aria-label", receptionCourse ? "レシーブ位置" : "自チームコート");
    const appendZones = (half, zones, enabled) => {
      zones.forEach((zone) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rally-course-zone-button${courseZoneSelect?.value === String(zone) ? " selected" : ""}`;
        button.textContent = String(zone);
        button.setAttribute("aria-label", `ゾーン${zone}${enabled ? "を選択" : ""}`);
        button.setAttribute("aria-pressed", String(courseZoneSelect?.value === String(zone)));
        button.disabled = !enabled;
        if (enabled) {
          button.addEventListener("click", () => {
            courseZoneSelect.value = String(zone);
            courseCourt.querySelectorAll(".rally-course-zone-button").forEach((zoneButton) => {
              const selected = zoneButton === button;
              zoneButton.classList.toggle("selected", selected);
              zoneButton.setAttribute("aria-pressed", String(selected));
            });
            courseClearButton?.classList.remove("selected");
            courseClearButton?.setAttribute("aria-pressed", "false");
          });
        }
        half.append(button);
      });
    };
    appendZones(oppositeHalf, [5, 6, 1, 4, 3, 2], serveCourse);
    const net = document.createElement("div");
    net.className = "rally-course-net";
    net.textContent = "ネット";
    appendZones(nearHalf, [1, 6, 5, 2, 3, 4], receptionCourse);
    courseCourt.append(oppositeHalf, net, nearHalf);
  }

  const recordButton = byId("record-rally-play");
  if (recordButton) recordButton.disabled = !matchHasStarted() || !canScore(currentMatch) || activePlayers.length === 0;
}

function showScoreDialog(teamId) {
  if (!canScore(currentMatch)) return;
  pendingScoreTeamId = teamId;
  const team = getTeam(teamId);
  const opponent = currentMatch.teams.find((item) => item.id !== teamId);
  byId("scoring-team-label").textContent = `得点チーム: ${team.name}`;
  const scoringPlayers = getCourtPlayers(team.id);
  const opposingPlayers = getCourtPlayers(opponent.id);
  fillPlayerSelect(byId("score-player"), scoringPlayers, scoringPlayers[0]?.id || "");
  fillPlayerSelect(byId("fault-player"), opposingPlayers, opposingPlayers[0]?.id || "");
  byId("score-play-type").value = "attack";
  byId("score-player").disabled = false;
  byId("score-note").value = "";
  byId("fault-player-field").hidden = true;
  elements.scoreDialog.showModal();
}

function addDetailedScore() {
  if (!pendingScoreTeamId || !canScore(currentMatch)) return;
  const team = getTeam(pendingScoreTeamId);
  const opponent = currentMatch.teams.find((item) => item.id !== pendingScoreTeamId);
  const playType = byId("score-play-type").value;
  const playerId = byId("score-player").value || null;
  const faultPlayerId = byId("fault-player").value || null;
  if (["serve", "attack", "back-attack", "block"].includes(playType) && team.players.length && !playerId) {
    byId("score-dialog-error").textContent = "この得点のプレーをした選手を選択してください。";
    byId("score-dialog-error").hidden = false;
    return;
  }
  if (["opponent-error", "penalty"].includes(playType) && opponent.players.length && !faultPlayerId) {
    byId("score-dialog-error").textContent = "相手側でミス・反則をした選手を選択してください。";
    byId("score-dialog-error").hidden = false;
    return;
  }
  const servingState = getServingState(currentMatch, currentSet());
  addEvent({
    type: "score",
    teamId: team.id,
    delta: 1,
    playType,
    ...(playerId && ["serve", "attack", "back-attack", "block"].includes(playType)
      ? { statPlayKind: playType === "back-attack" ? "backAttack" : playType }
      : {}),
    playerId: ["opponent-error", "penalty"].includes(playType) ? null : playerId,
    faultPlayerId,
    note: byId("score-note").value.trim().slice(0, 120),
    rotationAdvanced: servingState.server !== team.id,
  });
  pendingScoreTeamId = null;
  elements.scoreDialog.close();
  byId("score-dialog-error").textContent = "";
  byId("score-dialog-error").hidden = true;
  clearError();
}

function recordRallyPlay() {
  if (!matchHasStarted() || !canScore(currentMatch)) return;

  const practicalKind =
    byId("rally-kind")?.value ||
    byId("rally-kind-group")
      ?.querySelector(".mini-select-button.selected")
      ?.dataset.value ||
    "serve";

  const practicalOutcome =
    byId("rally-outcome")?.value ||
    byId("rally-outcome-group")
      ?.querySelector(".mini-select-button.selected")
      ?.dataset.value ||
    "success";

  const team = getTeam(byId("rally-team").value);

  const playerId =
    byId("rally-player").value || null;

  const playKind = practicalKind;
  const outcome = practicalOutcome;

  if (
    !team ||
    (
      playerId &&
      !getCourtPlayers(team.id).some(
        (player) => player.id === playerId
      )
    )
  ) {
    showError(
      "プレーをしたコート内の選手を選択してください。"
    );
    return;
  }

  if (
    !rallyKinds.includes(playKind) ||
    !rallyOutcomes.includes(outcome)
  ) {
    showError(
      "ラリーの動作と結果を選択してください。"
    );
    return;
  }

  const note =
    byId("rally-note").value
      .trim()
      .slice(0, 120);
  const attackZone = ["attack", "backAttack"].includes(playKind)
    ? Number(byId("rally-attack-zone").value) || null
    : null;
  const courseZone = ["serve", "reception", "serveReception", "attackReception"].includes(playKind)
    ? Number(byId("rally-course-zone").value) || null
    : null;

  const rallyEvent = addEvent({
    type: "rally-play",
    teamId: team.id,
    playerId,
    playKind,
    outcome,
    note,
    ...(attackZone ? { attackZone } : {}),
    ...(courseZone ? { courseZone } : {}),
  });

  // 得点 → 自チームへ加点
  if (outcome === "point") {

    addEvent({
      type: "score",
      teamId: team.id,
      delta: 1,
      playType: "other",
      playerId,
      faultPlayerId: null,
      note: `ラリー記録: ${playKind}`,
      rallyEventId: rallyEvent.id,
    });

  }

  // 失点 → 相手チームへ加点
  else if (outcome === "error") {

    const opponent =
      currentMatch.teams.find(
        (item) => item.id !== team.id
      );

    if (opponent) {

      addEvent({
        type: "score",
        teamId: opponent.id,
        delta: 1,
        playType: "other",
        playerId: null,
        faultPlayerId: playerId,
        note: `相手得点（${team.name}の失点）`,
        rallyEventId: rallyEvent.id,
      });

    }
  }

  byId("rally-note").value = "";
  byId("rally-attack-zone").value = "";
  byId("rally-course-zone").value = "";

  clearError();
}

function render() {
  if (!currentMatch) return;
  const matchPageActive = getActivePage() === "match";
  populateForm();
  const locked = matchHasStarted();
  Object.values(ruleFields).forEach((id) => { byId(id).disabled = locked; });
  renderTeams();
  renderScoreboard();
  renderSetStrip();
  if (matchPageActive) {
    renderEvents();
    renderTimeouts();
    renderChallenges();
    renderCourtChange();
    renderSubstitutionMonitors();
    renderTechnicalTimeoutStatus();
    renderDurationStatus();
    renderLivePerformanceMetrics();
    renderIntegrityAlerts();
    renderCurrentSetReport();
  }
  renderMatchTimer();
  renderRotation();
  applyTeamColors();
  byId("undo-event").disabled = currentSet().events.length === 0;
  renderVisibleSupplementalViews();
  renderHomeSummary();
}

function getActivePage() {
  return document.querySelector(".app-page.active[data-page-panel]")?.dataset.pagePanel || "home";
}

function renderHomeSummary() {
  if (!currentMatch) return;
  const [teamA, teamB] = currentMatch.teams;
  const current = currentSet();
  byId("roster-count").textContent = `${teamA.name}: ${teamA.players.length}名　/　${teamB.name}: ${teamB.players.length}名`;
  byId("home-score-a").textContent = String(getScore(current, teamA.id));
  byId("home-score-b").textContent = String(getScore(current, teamB.id));
  byId("home-set-label").textContent = `SET ${current.number}`;
  byId("live-match-meta").textContent = [
    currentMatch.matchInfo.tournamentName,
    currentMatch.matchInfo.matchDate,
    currentMatch.matchInfo.matchNumber,
  ].filter(Boolean).join(" · ") || "リアルタイムスコア記録";
}

function renderVisibleSupplementalViews() {
  const page = getActivePage();
  if (page === "setup") renderMatchupComparison();
  if (page === "tournaments" || page === "courts") renderTournamentManagement();
  if (page === "season") renderSeasonStats();
  if (page === "referee-training") renderTrainingMatchOptions();
  if (page === "video-sync") renderVideoPanel();
}

function renderCurrentPageSummaries() {
  if (["confirm", "scoresheet", "sets", "result", "verify", "output"].includes(getActivePage())) {
    renderPageSummaries();
  } else {
    renderHomeSummary();
  }
}

function getIntegrityIssues(match, set = match.sets.at(-1)) {
  const issues = [];
  if (!set) return issues;
  const targetSet = set;
  const maxCourts = getCourtPlayerCount(match);
  const rosterIds = match.teams.flatMap((team) => team.players.map((player) => player.id));
  if (new Set(rosterIds).size !== rosterIds.length) {
    issues.push("同一選手IDが複数チームの登録名簿で重複しています。");
  }
  for (const team of match.teams) {
    const openingLineup = targetSet.startingLineups?.[team.id] || [];
    const openingPlayers = openingLineup.filter(Boolean);
    const setHasStarted = Boolean(targetSet.startedAt) || targetSet.events.some((event) => event.type === "score" && event.delta > 0);
    if (setHasStarted && openingPlayers.length !== maxCourts) {
      issues.push(`${team.name}: 開始時ラインアップが${maxCourts}名分登録されていません。`);
    }
    if (new Set(openingPlayers).size !== openingPlayers.length) {
      issues.push(`${team.name}: 開始時のローテーション・サーブ順に同一選手が重複しています。`);
    }
    if (openingPlayers.some((playerId) => !team.players.some((player) => player.id === playerId))) {
      issues.push(`${team.name}: 開始時のラインアップに登録名簿外の選手がいます。`);
    }
    const lineup = getCurrentLineup(match, targetSet, team.id);
    const assigned = lineup.filter(Boolean);
    if (new Set(assigned).size !== assigned.length) {
      issues.push(`${team.name}: 同一選手が複数のコート位置に登録されています。`);
    }
    if (assigned.some((playerId) => !team.players.some((player) => player.id === playerId))) {
      issues.push(`${team.name}: 登録名簿に存在しない選手がラインアップに含まれています。`);
    }
    if (assigned.length > maxCourts) issues.push(`${team.name}: コート内選手数が競技形式の人数を超えています。`);
    const substitutions = targetSet.events.filter((event) => event.type === "substitution" && event.teamId === team.id).length;
    if (substitutions > match.rules.substitutionLimit) {
      issues.push(`${team.name}: 通常交代が上限（${match.rules.substitutionLimit}回）を超えています。`);
    }
    const timeouts = targetSet.events.filter((event) => event.type === "timeout" && event.teamId === team.id).length;
    if (timeouts > match.rules.timeoutLimit) {
      issues.push(`${team.name}: タイムアウトが上限（${match.rules.timeoutLimit}回）を超えています。`);
    }

    const pairWasSubstituted = new Map();
    const pairHadRally = new Map();
    for (const event of targetSet.events) {
      if (event.type === "score" && event.delta > 0 && !event.correctionSource) {
        pairHadRally.forEach((_, key) => pairHadRally.set(key, true));
        continue;
      }
      if (event.type !== "libero-substitution" || event.teamId !== team.id) continue;
      const outgoing = team.players.find((player) => player.number === event.playerOut);
      const incoming = team.players.find((player) => player.number === event.playerIn);
      const libero = outgoing?.isLibero ? outgoing : incoming?.isLibero ? incoming : null;
      const replaced = outgoing?.isLibero ? incoming : incoming?.isLibero ? outgoing : null;
      if (!libero || !replaced) continue;
      const key = `${libero.id}:${replaced.id}`;
      if (pairWasSubstituted.has(key) && !pairHadRally.get(key)) {
        issues.push(`${team.name}: リベロ #${libero.number} と #${replaced.number} の再入場前にラリーが確認できません。`);
      }
      pairWasSubstituted.set(key, true);
      pairHadRally.set(key, false);
    }
  }
  let servingTeamId = targetSet.initialServiceTeamId;
  const correctedScoreIds = new Set(targetSet.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => event.correctionOf));
  for (let index = 0; index < targetSet.events.length; index += 1) {
    const event = targetSet.events[index];
    if (event.type !== "score" || event.delta <= 0 || event.correctionSource || correctedScoreIds.has(event.id)) continue;
    const expectedRotation = servingTeamId !== event.teamId;
    if (event.rotationAdvanced !== undefined && event.rotationAdvanced !== expectedRotation) {
      issues.push(`第${targetSet.number}セット: 得点記録とサーブ権から算出したローテーションが一致しません。`);
    }
    servingTeamId = event.teamId;
  }
  return [...new Set(issues)];
}

function renderIntegrityAlerts() {
  const container = byId("integrity-alerts");
  if (!container) return;
  const issues = getIntegrityIssues(currentMatch);
  container.replaceChildren();
  container.hidden = issues.length === 0;
  if (!issues.length) return;
  const heading = document.createElement("h2");
  heading.textContent = "🔴 不正状態の可能性";
  const list = document.createElement("ul");
  issues.forEach((issue) => {
    const item = document.createElement("li");
    item.textContent = issue;
    list.append(item);
  });
  container.append(heading, list);
}

function placeLiveEventEntry() {
  const panel = byId("live-event-entry-panel");
  const matchPanel = document.querySelector('[data-page-panel="match"] .scoring-panel');
  if (!panel || !matchPanel || panel.parentElement === matchPanel) return;
  const details = document.createElement("details");
  details.id = "live-event-entry";
  details.className = "live-event-entry";
  const summary = document.createElement("summary");
  summary.textContent = "ラリー・イベント・交代などを記録";
  details.append(summary, panel);
  matchPanel.append(details);
}

function appendSummaryRow(container, label, value) {
  const row = document.createElement("div");
  row.className = "summary-row";
  const key = document.createElement("span");
  key.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value || "未入力";
  row.append(key, content);
  container.append(row);
}

function makeTable(headers, rows, className = "data-table") {
  const table = document.createElement("table");
  table.className = className;
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  rows.forEach((values) => {
    const row = document.createElement("tr");
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
  return table;
}

function appendPrintSection(container, title, headers, rows) {
  const section = document.createElement("section");
  section.className = "score-sheet-block";
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  section.append(makeTable(headers, rows, "score-sheet-table"));
  container.append(section);
}

function emptyPlayStats() {
  return {
    attack: { attempts: 0, points: 0, errors: 0, blocked: 0 },
    backAttack: { attempts: 0, points: 0, errors: 0, blocked: 0 },
    block: { attempts: 0, points: 0 },
    serve: { attempts: 0, points: 0, errors: 0, effective: 0 },
    reception: { attempts: 0, excellent: 0, good: 0, other: 0 },
  };
}

function recordPlayStat(stats, playKind, outcome) {
  const category = stats[playKind];
  if (!category) return;
  category.attempts += 1;
  if (outcome === "point") category.points += 1;
  if (outcome === "error" && "errors" in category) category.errors += 1;
  if (outcome === "blocked" && "blocked" in category) category.blocked += 1;
  if (outcome === "effective" && "effective" in category) category.effective += 1;
  if (outcome === "excellent" && "excellent" in category) category.excellent += 1;
  if (outcome === "good" && "good" in category) category.good += 1;
  if (outcome === "other" && "other" in category) category.other += 1;
}

function getPlayerSetAppearances(team, sets = currentMatch.sets) {
  const playerSetsPlayed = new Map(team.players.map((player) => [player.id, 0]));
  let teamSetsPlayed = 0;

  for (const set of sets) {
    if (!set.startedAt && set.events.length === 0) continue;
    teamSetsPlayed += 1;

    const appearedPlayers = new Set(set.startingLineups?.[team.id] || []);
    for (const event of set.events) {
      if (event.teamId !== team.id) continue;
      if (["score", "play", "rally-play"].includes(event.type) && event.playerId) {
        appearedPlayers.add(event.playerId);
      }
      if (event.type === "substitution") {
        const playerIn = team.players.find((player) => player.number === event.playerIn);
        if (playerIn) appearedPlayers.add(playerIn.id);
      }
    }

    for (const playerId of appearedPlayers) {
      if (playerSetsPlayed.has(playerId)) {
        playerSetsPlayed.set(playerId, playerSetsPlayed.get(playerId) + 1);
      }
    }
  }

  return { teamSetsPlayed, playerSetsPlayed };
}

function getPerformanceStats(team, sets = currentMatch.sets) {
  const total = emptyPlayStats();
  const players = new Map(team.players.map((player) => [player.id, emptyPlayStats()]));
  const { teamSetsPlayed, playerSetsPlayed } = getPlayerSetAppearances(team, sets);
  for (const set of sets) {
    const blockedAttackIds = getBlockedAttackEventIds(set);
    const correctedScores = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => event.correctionOf));
    const correctedRallyEvents = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => set.events.find((original) => original.id === event.correctionOf)?.rallyEventId)
      .filter(Boolean));
    const scoreEvents = set.events.filter((event) => event.type === "score" && event.delta > 0
      && !event.correctionSource
      && event.statPlayKind && !correctedScores.has(event.id));
    const linkedScoreEvents = new Set();
    for (const rallyEvent of set.events.filter((event) => event.type === "rally-play"
      && event.teamId === team.id && event.outcome === "point")) {
      const rallyKind = getPerformanceKind(rallyEvent);
      const match = scoreEvents.find((event) => event.teamId === team.id
        && event.statPlayKind === rallyKind
        && event.playerId === rallyEvent.playerId
        && !linkedScoreEvents.has(event.id));
      if (match) linkedScoreEvents.add(match.id);
    }
    for (const event of set.events) {
      let playKind;
      let outcome;
      let playerId;
      if (event.type === "score" && event.delta > 0 && !event.correctionSource && event.teamId === team.id
        && !correctedScores.has(event.id) && event.statPlayKind && !linkedScoreEvents.has(event.id)) {
        playKind = event.statPlayKind;
        outcome = "point";
        playerId = event.playerId;
      } else if (event.type === "play" && event.teamId === team.id && !correctedRallyEvents.has(event.id)) {
        playKind = event.playKind;
        outcome = event.outcome;
        if (["attack", "backAttack"].includes(playKind) && blockedAttackIds.has(event.id)) outcome = "blocked";
        playerId = event.playerId;
      } else if (event.type === "rally-play" && event.teamId === team.id && !correctedRallyEvents.has(event.id)) {
        playKind = getPerformanceKind(event);
        outcome = playKind === "reception"
          ? ["excellent", "good"].includes(event.outcome) ? event.outcome : "other"
          : event.outcome;
        if (playKind === "attack" && blockedAttackIds.has(event.id)) outcome = "blocked";
        playerId = event.playerId;
      } else if (event.type === "serve-fault" && event.teamId === team.id) {
        playKind = "serve";
        outcome = "error";
        playerId = event.playerId || null;
      } else if (event.type === "score" && event.delta > 0 && !event.correctionSource
        && event.teamId === team.id && !correctedScores.has(event.id)
        && event.playType === "serve" && !event.statPlayKind) {
        playKind = "serve";
        outcome = "point";
        playerId = event.playerId;
      } else {
        continue;
      }
      recordPlayStat(total, playKind, outcome);
      if (players.has(playerId)) recordPlayStat(players.get(playerId), playKind, outcome);
    }
  }
  return { total, players, teamSetsPlayed, playerSetsPlayed };
}

function getPerformanceKind(event) {
  if (["serveReception", "reception", "attackReception"].includes(event.playKind)) return "reception";
  return event.playKind;
}

function getEffectivePointEvents(set) {
  const correctedScores = new Set(set.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => event.correctionOf));
  return set.events.filter((event) =>
    event.type === "score" && event.delta > 0 && !event.correctionSource && !correctedScores.has(event.id));
}

function getPointSource(event) {
  const kind = event.statPlayKind || event.playType;
  if (["serve"].includes(kind)) return "サーブ";
  if (["attack", "backAttack", "back-attack"].includes(kind)) return "アタック";
  if (kind === "block") return "ブロック";
  if (["opponent-error", "penalty"].includes(kind)) return "相手ミス";
  return "その他";
}

function getPointSourceCounts(matches, teamIdentity) {
  const counts = new Map([["サーブ", 0], ["アタック", 0], ["ブロック", 0], ["相手ミス", 0], ["その他", 0]]);
  for (const match of matches) {
    const team = teamIdentity ? match.teams.find((item) => teamIdentity.code
      ? item.code === teamIdentity.code || !item.code && item.name === teamIdentity.name
      : !item.code && item.name === teamIdentity.name) : null;
    for (const set of match.sets) {
      for (const event of getEffectivePointEvents(set)) {
        if (team && event.teamId !== team.id) continue;
        const source = getPointSource(event);
        counts.set(source, counts.get(source) + 1);
      }
    }
  }
  return counts;
}

function renderPointSourceBars(container, counts, title, note) {
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  container.append(heading);
  if (!total) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "得点源を分類できる記録がありません。";
    container.append(empty);
    return;
  }
  const bars = document.createElement("div");
  bars.className = "heatmap-bars";
  bars.setAttribute("role", "img");
  bars.setAttribute("aria-label", title);
  [...counts.entries()].forEach(([label, count]) => {
    const percentage = count / total * 100;
    const row = document.createElement("div");
    row.className = "heatmap-row";
    const name = document.createElement("span");
    name.textContent = `${label} (${count})`;
    const track = document.createElement("div");
    track.className = "heatmap-track";
    const fill = document.createElement("div");
    fill.className = "heatmap-fill";
    fill.style.width = `${percentage}%`;
    track.append(fill);
    const value = document.createElement("strong");
    value.textContent = `${percentage.toFixed(1)}%`;
    row.append(name, track, value);
    bars.append(row);
  });
  container.append(bars);
  if (note) {
    const description = document.createElement("p");
    description.className = "stats-note";
    description.textContent = note;
    container.append(description);
  }
}

function getMatchDataQuality(match) {
  const events = match.sets.flatMap((set) => set.events);
  const corrections = events.filter((event) => event.type === "score"
    && (event.delta < 0 || event.correctionSource)).length;
  const serviceWarnings = events.filter((event) => event.type === "service-order-violation").length;
  const rotationCorrections = match.auditLog?.filter((entry) => entry.action === "edit"
    && /ローテーション|サーブ順/.test(`${entry.entity} ${entry.details}`)).length || 0;
  let rotationMismatches = 0;
  for (const set of match.sets) {
    let servingTeamId = set.initialServiceTeamId;
    const correctedIds = new Set(set.events.filter((event) => event.type === "score" && event.delta < 0)
      .map((event) => event.correctionOf).filter(Boolean));
    for (const event of set.events) {
      if (event.type !== "score" || event.delta <= 0 || event.correctionSource || correctedIds.has(event.id)) continue;
      if (event.rotationAdvanced !== undefined && event.rotationAdvanced !== (servingTeamId !== event.teamId)) {
        rotationMismatches += 1;
      }
      servingTeamId = event.teamId;
    }
  }
  const rotationIssues = rotationCorrections + rotationMismatches;
  const integrityIssues = match.sets.reduce((sum, set) => sum + getIntegrityIssues(match, set).length, 0);
  const penalty = corrections * 0.5 + rotationIssues + serviceWarnings * 0.5 + integrityIssues * 0.5;
  return {
    score: Math.max(0, Math.round(100 - penalty)),
    corrections,
    rotationIssues,
    serviceWarnings,
    integrityIssues,
  };
}

function renderMatchDataQuality(match) {
  const container = byId("match-data-quality");
  const quality = getMatchDataQuality(match);
  const heading = document.createElement("h3");
  heading.textContent = "データ品質スコア";
  const score = document.createElement("p");
  score.className = "data-quality-score";
  score.textContent = `${quality.score}/100`;
  const rows = [
    ["得点訂正", quality.corrections, "0.5点 / 件"],
    ["ローテーション修正・整合性警告", quality.rotationIssues, "1点 / 件"],
    ["サーブ順警告", quality.serviceWarnings, "0.5点 / 件"],
    ["記録状態チェック", quality.integrityIssues, "0.5点 / 件"],
  ];
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "参考指標です。訂正・警告件数から独自の固定ルールで減点しており、試合結果や分析精度を統計的に保証するものではありません。";
  container.replaceChildren(heading, score,
    makeTable(["減点要因", "件数", "減点基準"], rows, "match-analysis-table"), note);
}

function renderYearComparison(container, team, matches) {
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "年度比較";
  container.append(heading);
  const years = new Map();
  for (const match of matches.filter(isMatchComplete)) {
    const year = match.matchInfo.matchDate.slice(0, 4);
    if (!/^\d{4}$/.test(year)) continue;
    const teamInMatch = match.teams.find((item) => team.code
      ? item.code === team.code || !item.code && item.name === team.name
      : !item.code && item.name === team.name);
    if (!teamInMatch) continue;
    const record = years.get(year) || { wins: 0, played: 0 };
    record.played += 1;
    if (getSetWins(match).find((item) => item.teamId === teamInMatch.id)?.wins
      >= Math.floor(match.rules.bestOf / 2) + 1) record.wins += 1;
    years.set(year, record);
  }
  const entries = [...years.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "年度別の勝率を算出できる完了試合がありません。";
    container.append(empty);
    return;
  }
  const rows = entries.map(([year, record]) => [
    year, record.played, record.wins, record.played - record.wins,
    `${(record.wins / record.played * 100).toFixed(1)}%`,
  ]);
  container.append(makeTable(["年度", "完了試合", "勝", "敗", "勝率"], rows, "match-analysis-table"));
  if (entries.length > 1) {
    const [previousYear, previous] = entries.at(-2);
    const [latestYear, latest] = entries.at(-1);
    const change = (latest.wins / latest.played - previous.wins / previous.played) * 100;
    const trend = document.createElement("p");
    trend.className = "notice";
    trend.textContent = `${previousYear}年から${latestYear}年の勝率変化: ${change >= 0 ? "+" : ""}${change.toFixed(1)}ポイント`;
    container.append(trend);
  }
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "日付が登録された完了試合を年度別に集計します。開始日・終了日の絞り込みとは独立しています。";
  container.append(note);
}

function getBlockedAttackEventIds(set) {
  const blockedAttacks = new Set();
  let rallyEvents = [];
  const canceledScores = new Set(set.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => event.correctionOf));
  for (const event of set.events) {
    if (event.type !== "score") {
      rallyEvents.push(event);
      continue;
    }
    if (event.delta > 0 && !event.correctionSource && !canceledScores.has(event.id)) {
      const scoringTeamBlocks = rallyEvents.filter((item) =>
        ["play", "rally-play"].includes(item.type)
        && item.teamId === event.teamId
        && item.playKind === "block"
        && item.outcome === "point");
      const lastBlock = scoringTeamBlocks.at(-1);
      const attack = lastBlock && rallyEvents.slice(0, rallyEvents.indexOf(lastBlock)).reverse().find((item) =>
        ["play", "rally-play"].includes(item.type)
        && item.teamId !== event.teamId
        && ["attack", "backAttack"].includes(item.playKind)
        && item.playerId);
      if (attack) blockedAttacks.add(attack.id);
    }
    if (event.delta > 0 && !event.correctionSource) rallyEvents = [];
  }
  return blockedAttacks;
}

function getSideoutBreakStats(teamId) {
  let sideoutOpportunities = 0;
  let sideoutPoints = 0;
  let breakOpportunities = 0;
  let breakPoints = 0;
  for (const set of currentMatch.sets) {
    let servingTeamId = set.initialServiceTeamId;
    for (const event of getEffectivePointEvents(set)) {
      if (servingTeamId === teamId) {
        breakOpportunities += 1;
        if (event.teamId === teamId) breakPoints += 1;
      } else {
        sideoutOpportunities += 1;
        if (event.teamId === teamId) sideoutPoints += 1;
      }
      servingTeamId = event.teamId;
    }
  }
  return { sideoutOpportunities, sideoutPoints, breakOpportunities, breakPoints };
}

function getServeTeamStats(teamId, sets = currentMatch.sets) {
  const stats = { attempts: 0, points: 0, errors: 0 };
  for (const set of sets) {
    const correctedScores = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => event.correctionOf));
    const correctedRallyEvents = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => set.events.find((original) => original.id === event.correctionOf)?.rallyEventId)
      .filter(Boolean));
    for (const event of set.events) {
      if (event.teamId !== teamId) continue;
      if (event.type === "rally-play" && event.playKind === "serve" && !correctedRallyEvents.has(event.id)) {
        stats.attempts += 1;
        if (event.outcome === "point") stats.points += 1;
        if (event.outcome === "error") stats.errors += 1;
      } else if (event.type === "play" && event.playKind === "serve" && !correctedRallyEvents.has(event.id)) {
        stats.attempts += 1;
        if (event.outcome === "error") stats.errors += 1;
      } else if (event.type === "serve-fault") {
        stats.attempts += 1;
        stats.errors += 1;
      } else if (event.type === "score" && event.delta > 0 && !event.correctionSource
        && !correctedScores.has(event.id) && event.playType === "serve") {
        stats.attempts += 1;
        stats.points += 1;
      }
    }
  }
  return stats;
}

function getTeamMatchAnalysis(teamId) {
  const service = getSideoutBreakStats(teamId);
  const serve = getServeTeamStats(teamId);
  const opponentId = currentMatch.teams.find((team) => team.id !== teamId)?.id;
  const opposingServe = opponentId ? getServeTeamStats(opponentId) : { attempts: 0, points: 0, errors: 0 };
  const receptionAttempts = getPerformanceStats(getTeam(teamId)).total.reception.attempts;
  return {
    sideout: formatPercentage(service.sideoutPoints, service.sideoutOpportunities),
    break: formatPercentage(service.breakPoints, service.breakOpportunities),
    servePoint: formatPercentage(serve.points, serve.attempts),
    serveError: formatPercentage(serve.errors, serve.attempts),
    aceAgainst: formatPercentage(opposingServe.points, receptionAttempts),
  };
}

function getRotationAnalysis() {
  const positionsByTeam = new Map(currentMatch.teams.map((team) => [
    team.id,
    Array.from({ length: getCourtPlayerCount(currentMatch) }, (_, index) => ({
      position: index + 1, points: 0, conceded: 0,
    })),
  ]));
  for (const set of currentMatch.sets) {
    const rotations = Object.fromEntries(currentMatch.teams.map((team) => [team.id, 0]));
    const serviceTurns = Object.fromEntries(currentMatch.teams.map((team) => [
      team.id, team.id === set.initialServiceTeamId ? 1 : 0,
    ]));
    let servingTeamId = set.initialServiceTeamId;
    for (const event of getEffectivePointEvents(set)) {
      currentMatch.teams.forEach((team) => {
        const position = usesCourtRotation(currentMatch)
          ? rotations[team.id] % getCourtPlayerCount(currentMatch)
          : Math.max(0, serviceTurns[team.id] - 1) % getCourtPlayerCount(currentMatch);
        const rotation = positionsByTeam.get(team.id)[position];
        if (event.teamId === team.id) rotation.points += 1;
        else rotation.conceded += 1;
      });
      if (servingTeamId !== event.teamId) {
        rotations[event.teamId] += 1;
        serviceTurns[event.teamId] += 1;
      }
      servingTeamId = event.teamId;
    }
  }
  return positionsByTeam;
}

function getCurrentServeStreak() {
  let latest = null;
  for (const set of currentMatch.sets) {
    let servingTeamId = set.initialServiceTeamId;
    let streak = 0;
    for (const event of getEffectivePointEvents(set)) {
      if (event.teamId === servingTeamId) streak += 1;
      else {
        servingTeamId = event.teamId;
        streak = 1;
      }
    }
    latest = { set, servingTeamId, streak };
  }
  if (!latest?.streak) return "";
  const state = getServingState(currentMatch, latest.set);
  const serverId = getExpectedServerPlayerId(latest.set, state);
  const server = currentMatch.teams.flatMap((team) => team.players).find((player) => player.id === serverId);
  return `${server ? `サーバー #${server.number} ${server.name}（${getTeam(latest.servingTeamId)?.name}）` : getTeam(latest.servingTeamId)?.name || "サーバー"} / ${latest.streak}連続得点`;
}

function renderRotationAnalysis() {
  const container = byId("rotation-analysis-live");
  if (!container) return;
  container.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = usesCourtRotation(currentMatch) ? "ローテーション別得失点" : "サーブ順別得失点";
  container.append(title);
  const analysis = getRotationAnalysis();
  currentMatch.teams.forEach((team, index) => {
    const section = document.createElement("section");
    section.className = `rotation-analysis-team ${index === 0 ? "team-a" : "team-b"}`;
    const heading = document.createElement("h4");
    heading.textContent = team.name;
    const rows = analysis.get(team.id).map((item) => [
      `P${item.position}`, `+${item.points}`, `-${item.conceded}`, `P${item.points - item.conceded}`,
    ]);
    section.append(heading, makeTable(["順番", "得点", "失点", "得失点"], rows, "rotation-analysis-table"));
    container.append(section);
  });
  const streak = document.createElement("p");
  streak.className = "current-serve-streak";
  streak.textContent = getCurrentServeStreak() || "連続得点: —";
  container.append(streak);
}

function getServeEffectiveness(stats) {
  return stats.serve.attempts > 0
    ? ((stats.serve.points * 100
      + (stats.serve.effective + stats.serve.points) * 25
      - stats.serve.errors * 25) / stats.serve.attempts)
    : null;
}

function getReceptionSuccessRate(stats) {
  return stats.reception.attempts > 0
    ? ((stats.reception.excellent * 100 + stats.reception.good * 50) / stats.reception.attempts)
    : null;
}

function renderLivePerformanceMetrics() {
  const container = byId("live-performance-metrics");
  if (!container) return;
  container.replaceChildren();
  currentMatch.teams.forEach((team, index) => {
    const performance = getPerformanceStats(team);
    const stats = performance.total;
    const service = getSideoutBreakStats(team.id);
    const teamAnalysis = getTeamMatchAnalysis(team.id);
    const card = document.createElement("section");
    card.className = `live-team-metrics ${index === 0 ? "team-a" : "team-b"}`;
    const heading = document.createElement("h3");
    heading.textContent = team.name;
    card.append(heading);
    const metrics = [
      ["サイドアウト率", formatPercentage(service.sideoutPoints, service.sideoutOpportunities)],
      ["ブレイク率", formatPercentage(service.breakPoints, service.breakOpportunities)],
      ["サーブ得点率", teamAnalysis.servePoint],
      ["サーブミス率", teamAnalysis.serveError],
      ["被サービスエース率", teamAnalysis.aceAgainst],
      ["サーブ効果率", getServeEffectiveness(stats) === null ? "—" : `${getServeEffectiveness(stats).toFixed(1)}%`],
      ["アタック決定率", formatPercentage(stats.attack.points, stats.attack.attempts)],
      ["レセプション成功率", getReceptionSuccessRate(stats) === null ? "—" : `${getReceptionSuccessRate(stats).toFixed(1)}%`],
    ];
    const list = document.createElement("dl");
    metrics.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const result = document.createElement("dd");
      result.textContent = value;
      row.append(term, result);
      list.append(row);
    });
    card.append(list);
    const playerRows = team.players.map((player) => {
      const playerStats = performance.players.get(player.id) || emptyPlayStats();
      const serveEffectiveness = getServeEffectiveness(playerStats);
      const receptionSuccess = getReceptionSuccessRate(playerStats);
      return [
        `#${player.number} ${player.name}`,
        formatPercentage(playerStats.attack.points, playerStats.attack.attempts),
        formatPercentage(playerStats.attack.blocked, playerStats.attack.attempts),
        serveEffectiveness === null ? "—" : `${serveEffectiveness.toFixed(1)}%`,
        receptionSuccess === null ? "—" : `${receptionSuccess.toFixed(1)}%`,
        playerStats.block.points,
      ];
    });
    const playerHeading = document.createElement("h4");
    playerHeading.textContent = "個人分析";
    const playerTable = makeTable(
      ["選手", "アタック決定率", "被ブロック率", "サーブ効果率", "レセプション成功率", "ブロック得点"],
      playerRows,
      "live-player-analysis-table",
    );
    const playerTableScroll = document.createElement("div");
    playerTableScroll.className = "live-player-analysis";
    playerTableScroll.append(playerTable);
    card.append(playerHeading, playerTableScroll);
    container.append(card);
  });
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "サイドアウト率・ブレイク率は得点履歴上のサーブ側から算出します。サーブ得点率はサービスエース÷サーブ試行、サーブミス率は記録したサーブミス÷サーブ試行、被サービスエース率は相手のサービスエース÷レセプション記録数です。プレーまたは得点の選手・結果を記録していない場合、そのプレーに依存する分析には含まれません。";
  container.append(note);
  renderRotationAnalysis();
}

function formatPercentage(numerator, denominator) {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—";
}

function formatSetAverage(points, setsPlayed) {
  return setsPlayed > 0 ? (points / setsPlayed).toFixed(2) : "—";
}

function appendPerformanceStats(container) {
  const categoryDefinitions = [
    {
      key: "attack",
      title: "アタック",
      headers: ["選手", "打数", "得点", "失点", "被ブロック", "決定率", "被ブロック率", "セット平均"],
      values: (stats, setsPlayed) => [
        stats.attack.attempts,
        stats.attack.points,
        stats.attack.errors,
        stats.attack.blocked,
        formatPercentage(stats.attack.points, stats.attack.attempts),
        formatPercentage(stats.attack.blocked, stats.attack.attempts),
        formatSetAverage(stats.attack.points, setsPlayed),
      ],
    },
    {
      key: "backAttack",
      title: "バックアタック",
      headers: ["選手", "打数", "得点", "失点", "被ブロック", "決定率", "被ブロック率"],
      values: (stats) => [
        stats.backAttack.attempts,
        stats.backAttack.points,
        stats.backAttack.errors,
        stats.backAttack.blocked,
        formatPercentage(stats.backAttack.points, stats.backAttack.attempts),
        formatPercentage(stats.backAttack.blocked, stats.backAttack.attempts),
      ],
    },
    {
      key: "block",
      title: "ブロック",
      headers: ["選手", "得点", "セット平均"],
      values: (stats, setsPlayed) => [stats.block.points, formatSetAverage(stats.block.points, setsPlayed)],
    },
    {
      key: "serve",
      title: "サーブ",
      headers: ["選手", "打数", "得点", "失点", "効果", "効果率"],
      values: (stats) => [
        stats.serve.attempts,
        stats.serve.points,
        stats.serve.errors,
        stats.serve.effective + stats.serve.points,
        stats.serve.attempts > 0
          ? `${(((stats.serve.points * 100)
            + ((stats.serve.effective + stats.serve.points) * 25)
            - (stats.serve.errors * 25))
            / stats.serve.attempts).toFixed(1)}%`
          : "—",
      ],
    },
    {
      key: "reception",
      title: "サーブレシーブ",
      headers: ["選手", "受数", "成功（優）", "成功（良）", "成功率"],
      values: (stats) => [
        stats.reception.attempts,
        stats.reception.excellent,
        stats.reception.good,
        stats.reception.attempts > 0
          ? `${(((stats.reception.excellent * 100) + (stats.reception.good * 50))
            / stats.reception.attempts).toFixed(1)}%`
          : "—",
      ],
    },
  ];

  currentMatch.teams.forEach((team, teamIndex) => {
    const className = teamIndex === 0 ? "team-a" : "team-b";
    const stats = getPerformanceStats(team);
    const teamSection = document.createElement("section");
    teamSection.className = `stats-team-section ${className}`;
    const heading = document.createElement("h2");
    heading.textContent = team.name;
    teamSection.append(heading);
    categoryDefinitions.forEach((definition) => {
      const category = document.createElement("section");
      category.className = "stats-category";
      const title = document.createElement("h3");
      title.textContent = definition.title;
      const rows = [
        [`チーム合計 / ${team.name}`, ...definition.values(stats.total, stats.teamSetsPlayed)],
        ...team.players.map((player) => [
          `#${player.number} ${player.name}`,
          ...definition.values(
            stats.players.get(player.id) || emptyPlayStats(),
            stats.playerSetsPlayed.get(player.id) || 0,
          ),
        ]),
      ];
      const table = makeTable(definition.headers, rows, `stats-table ${className}`);
      table.querySelector("tbody tr")?.classList.add("stats-team-total");
      const scroll = document.createElement("div");
      scroll.className = "table-scroll";
      scroll.append(table);
      category.append(title, scroll);
      teamSection.append(category);
    });
    container.append(teamSection);
  });

  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "決定率＝得点÷打数×100、被ブロック率＝相手ブロック得点に結び付けられた攻撃÷打数、アタック/ブロックセット平均＝得点÷出場セット数、サーブ効果率＝（エース×100＋効果×25－失点×25）÷打数、レシーブ成功率＝（優×100＋良×50）÷受数。被ブロックは同一ラリー内のブロック得点と攻撃記録を対応できた場合のみ数えます。率は小数第1位、セット平均は小数第2位まで表示し、分母が0の場合は「—」を表示します。";
  container.append(note);
}

function appendCompletedSetReports(container, sets = currentMatch.sets) {
  const completedSets = sets.filter((set) => getSetResult(currentMatch, set));
  if (!completedSets.length) return;
  const section = document.createElement("section");
  section.className = "completed-set-reports";
  const heading = document.createElement("h2");
  heading.textContent = "セット終了レポート";
  section.append(heading);
  completedSets.forEach((set) => {
    const [teamA, teamB] = currentMatch.teams;
    const statsA = getPerformanceStats(teamA, [set]).total;
    const statsB = getPerformanceStats(teamB, [set]).total;
    const report = document.createElement("section");
    report.className = "completed-set-report";
    const title = document.createElement("h3");
    title.textContent = `第${set.number}セット　${getScore(set, teamA.id)} - ${getScore(set, teamB.id)}`;
    report.append(title, makeTable(
      ["項目", teamA.name, teamB.name],
      [
        ["アタック得点", statsA.attack.points, statsB.attack.points],
        ["ブロックポイント", statsA.block.points, statsB.block.points],
        ["サービスエース", statsA.serve.points, statsB.serve.points],
        ["サーブミス", statsA.serve.errors, statsB.serve.errors],
        ["アタックミス", statsA.attack.errors, statsB.attack.errors],
      ],
      "set-report-table",
    ));
    section.append(report);
  });
  container.append(section);
}

function renderCurrentSetReport() {
  const container = byId("set-end-report-live");
  if (!container) return;
  container.replaceChildren();
  appendCompletedSetReports(container, [currentSet()]);
  container.hidden = !getSetResult(currentMatch, currentSet());
}

function appendPrintTeamColumns(container, title, teams, makeRows, headers) {
  const section = document.createElement("section");
  section.className = "score-sheet-block";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const columns = document.createElement("div");
  columns.className = "score-sheet-team-columns";
  teams.forEach((team, index) => {
    const teamSection = document.createElement("section");
    teamSection.className = `score-sheet-team-column ${index === 0 ? "team-a" : "team-b"}`;
    const teamHeading = document.createElement("h3");
    teamHeading.textContent = team.name;
    teamSection.append(teamHeading, makeTable(headers, makeRows(team, index), "score-sheet-table"));
    columns.append(teamSection);
  });
  section.append(heading, columns);
  container.append(section);
}

function renderPrintableScoreSheet() {
  const root = byId("printable-score-sheet");
  root.replaceChildren();
  const [teamA, teamB] = currentMatch.teams;
  const info = currentMatch.matchInfo;
  const matchDocument = document.createElement("section");
  matchDocument.className = "print-document";
  matchDocument.dataset.printDocument = "match";
  const title = document.createElement("header");
  title.className = "score-sheet-title";
  const heading = document.createElement("h1");
  heading.textContent = "バレーボール公式記録票";
  const format = document.createElement("p");
  const profileLabels = { six: "6人制", "six-elementary": "小学生6人制（ローテーションなし）", nine: "9人制", beach: "ビーチバレー", soft: "ソフトバレー" };
  format.textContent = `${profileLabels[currentMatch.rules.matchProfile]}・${currentMatch.rules.bestOf}セットマッチ / ${currentMatch.rules.category} ${currentMatch.rules.division}`;
  const tournament = document.createElement("p");
  tournament.textContent = info.tournamentName || "大会名未入力";
  title.append(heading, format, tournament);
  matchDocument.append(title);

  const meta = document.createElement("div");
  meta.className = "score-sheet-meta score-sheet-block";
  for (const value of [
    `開催日: ${info.matchDate || "—"}`, `会場: ${info.venue || "—"}`,
    `会場住所: ${info.venueAddress || "—"}`,
    `セット終了後のコートチェンジ: ${getCourtChangeSets().length
      ? getCourtChangeSets().map((setNumber) => `第${setNumber}セット後`).join("・") : "なし"}`,
    `コート: ${info.court || "—"}`, `試合番号: ${info.matchNumber || "—"}`,
    `ラウンド: ${info.round || "—"}`, `設定時刻: ${info.scheduledTime || "—"}`,
    `試合開始: ${info.startedAt ? new Date(info.startedAt).toLocaleTimeString("ja-JP") : "—"}`,
    `試合終了: ${info.endedAt ? new Date(info.endedAt).toLocaleTimeString("ja-JP") : "—"}`,
    `試合時間: ${getElapsed(info.startedAt, info.endedAt)}`,
    `適用メモ: ${currentMatch.rules.note || "—"}`,
  ]) {
    const cell = document.createElement("span");
    cell.textContent = value;
    meta.append(cell);
  }
  matchDocument.append(meta);
  appendPrintSection(matchDocument, "試合結果・セット得点", ["セット", teamA.name, teamB.name, "勝者", "開始", "終了", "セット時間"], currentMatch.sets.map((set) => [
    `第${set.number}セット`, getScore(set, teamA.id), getScore(set, teamB.id),
    getSetResult(currentMatch, set) ? getTeam(getSetResult(currentMatch, set)).name : "進行中",
    set.startedAt ? new Date(set.startedAt).toLocaleTimeString("ja-JP") : "—",
    set.endedAt ? new Date(set.endedAt).toLocaleTimeString("ja-JP") : "—",
    getElapsed(set.startedAt, set.endedAt),
  ]));
  appendCompletedSetReports(matchDocument);

  appendPrintTeamColumns(matchDocument, "チーム構成・登録選手", currentMatch.teams,
    (team) => sortPlayersByNumber(team.players).map((player) => [
      player.number, player.name, describePlayerRole(player),
    ]), ["背番号", "氏名", "役割"]);

  const statsHeading = document.createElement("h2");
  statsHeading.className = "score-sheet-section-title";
  statsHeading.textContent = "チーム別・選手別プレー記録";
  matchDocument.append(statsHeading);
  appendPerformanceStats(matchDocument);

  const positionNames = currentMatch.rules.matchProfile === "nine"
    ? ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ"]
    : ["1", "2", "3", "4", "5", "6"];
  currentMatch.sets.forEach((set) => {
    appendPrintTeamColumns(matchDocument, `第${set.number}セット開始時のサービス順・ローテーション`,
      currentMatch.teams, (team) => positionNames.map((position, index) => {
        const player = team.players.find((item) => item.id === set.startingLineups[team.id]?.[index]);
        return [position, player?.number || "—", player?.name || "—"];
      }).slice(0, getCourtPlayerCount(currentMatch)), ["位置 / 順番", "背番号", "氏名"]);
  });

  appendPrintSection(matchDocument, "審判員・記録員", ["役割", "氏名", "都道府県 / 国名"], officialRoles.map(([role, label]) => [
    label, info.officials[role].name || "—", info.officials[role].area || "—",
  ]));
  const footer = document.createElement("footer");
  footer.className = "score-sheet-footer";
  footer.textContent = `タイムアウト上限: ${currentMatch.rules.timeoutLimit}回 / 交代上限: ${currentMatch.rules.substitutionLimit}回 / セット勝利点差: ${currentMatch.rules.winBy}点`;
  matchDocument.append(footer);

  const resultDocument = document.createElement("section");
  resultDocument.className = "print-document";
  resultDocument.dataset.printDocument = "result";
  const matchWinner = getSetWins(currentMatch)
    .find((entry) => entry.wins >= Math.floor(currentMatch.rules.bestOf / 2) + 1);
  appendPrintSection(resultDocument, "試合結果", ["項目", "内容"], [
    ["試合", `${teamA.name} ${getSetWins(currentMatch)[0].wins} - ${getSetWins(currentMatch)[1].wins} ${teamB.name}`],
    ["勝者", matchWinner ? getTeam(matchWinner.teamId).name : "試合進行中"],
    ["開始", info.startedAt ? new Date(info.startedAt).toLocaleString("ja-JP") : "—"],
    ["終了", info.endedAt ? new Date(info.endedAt).toLocaleString("ja-JP") : "—"],
    ["試合時間", getElapsed(info.startedAt, info.endedAt)],
  ]);
  appendPrintSection(resultDocument, "セット別結果", ["セット", teamA.name, teamB.name, "勝者", "セット時間"], currentMatch.sets.map((set) => [
    `第${set.number}セット`, getScore(set, teamA.id), getScore(set, teamB.id),
    getSetResult(currentMatch, set) ? getTeam(getSetResult(currentMatch, set)).name : "進行中",
    getElapsed(set.startedAt, set.endedAt),
  ]));
  resultDocument.append(byId("match-review").cloneNode(true));
  const lossRows = currentMatch.teams.map((team) => {
    const loss = getLostPointBreakdown(team.id);
    return [team.name, loss.total, ...["サーブミス", "アタックミス", "レシーブミス", "ブロックミス", "反則・ペナルティ", "相手のサーブ得点", "相手のアタック得点", "相手のブロック得点", "その他"]
      .map((label) => loss.breakdown.get(label))];
  });
  appendPrintSection(resultDocument, "失点要因分析", ["チーム", "失点合計", "サーブミス", "アタックミス", "レシーブミス", "ブロックミス", "反則・ペナルティ", "相手サーブ", "相手アタック", "相手ブロック", "その他"], lossRows);
  appendPrintSection(resultDocument, "異常イベント・訂正履歴", ["項目", "件数"], getAnomalySummary(currentMatch));
  appendPrintSection(resultDocument, "選手出場時間", ["チーム", "選手", "出場時間"], currentMatch.teams.flatMap((team) => {
    const timeByPlayer = getPlayerCourtTime(currentMatch, team);
    return team.players.map((player) => [
      team.name,
      `#${player.number} ${player.name}`,
      `${Math.round((timeByPlayer.get(player.id) || 0) / 60_000)}分`,
    ]);
  }));
  appendPrintSection(resultDocument, "アタックゾーン分析", ["チーム", "ゾーン", "打数", "得点", "決定率", "ミス", "被ブロック"], currentMatch.teams.flatMap((team) =>
    [...getAttackZoneStats(team)].map(([zone, stats]) => [
      team.name, `ゾーン${zone}`, stats.attempts, stats.points, formatPercentage(stats.points, stats.attempts), stats.errors, stats.blocked,
    ])));
  [
    "match-set-comparison",
    "match-benchwork-analysis",
    "serve-course-analysis",
    "reception-course-analysis",
    "libero-analysis",
  ].forEach((id) => resultDocument.append(byId(id).cloneNode(true)));

  const rosterDocument = document.createElement("section");
  rosterDocument.className = "print-document";
  rosterDocument.dataset.printDocument = "roster";
  appendPrintTeamColumns(rosterDocument, "メンバー表", currentMatch.teams,
    (team) => sortPlayersByNumber(team.players).map((player) => [
      player.number, player.name, describePlayerRole(player),
    ]), ["背番号", "氏名", "役割"]);

  const setsDocument = document.createElement("section");
  setsDocument.className = "print-document";
  setsDocument.dataset.printDocument = "sets";
  appendPrintSection(setsDocument, "セット結果", ["セット", teamA.name, teamB.name, "勝者", "開始", "終了", "所要時間"],
    currentMatch.sets.map((set) => [
      `第${set.number}セット`, getScore(set, teamA.id), getScore(set, teamB.id),
      getSetResult(currentMatch, set) ? getTeam(getSetResult(currentMatch, set)).name : "進行中",
      set.startedAt ? new Date(set.startedAt).toLocaleTimeString("ja-JP") : "—",
      set.endedAt ? new Date(set.endedAt).toLocaleTimeString("ja-JP") : "—",
      getElapsed(set.startedAt, set.endedAt),
    ]));
  appendCompletedSetReports(setsDocument);

  const playerStatsDocument = document.createElement("section");
  playerStatsDocument.className = "print-document";
  playerStatsDocument.dataset.printDocument = "player-stats";
  const playerStatsHeading = document.createElement("h1");
  playerStatsHeading.className = "score-sheet-section-title";
  playerStatsHeading.textContent = "個人成績・チーム成績";
  playerStatsDocument.append(playerStatsHeading);
  appendPerformanceStats(playerStatsDocument);

  const scoreDocument = document.createElement("section");
  scoreDocument.className = "print-document";
  scoreDocument.dataset.printDocument = "score-log";
  appendPrintSection(scoreDocument, "得点・コートチェンジ記録", ["セット", "時刻", "記録内容"],
    currentMatch.sets.flatMap((set) => set.events
      .filter((event) => ["score", "court-change", "serve-fault"].includes(event.type))
      .map((event) => [
        `第${set.number}セット`,
        new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        getEventDescription(currentMatch, event),
      ])));

  const eventDocument = document.createElement("section");
  eventDocument.className = "print-document";
  eventDocument.dataset.printDocument = "event-log";
  appendPrintSection(eventDocument, "ラリー・イベント時系列記録", ["セット", "時刻", "記録内容"],
    currentMatch.sets.flatMap((set) => set.events.map((event) => [
      `第${set.number}セット`,
      new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      getEventDescription(currentMatch, event),
    ])));

  const tournamentDocument = document.createElement("section");
  tournamentDocument.className = "print-document";
  tournamentDocument.dataset.printDocument = "tournament-report";
  const selectedTournament = getSelectedTournament();
  const tournamentMatches = selectedTournament
    ? [...new Set([
      ...selectedTournament.matchIds,
      ...(selectedTournament.fixtures || []).map((fixture) => fixture.matchId).filter(Boolean),
    ])].map((id) => id === currentMatch.id
      ? currentMatch : store.matches.find((match) => match.id === id)).filter(Boolean)
    : [];
  const tournamentRows = tournamentMatches.map((match) => {
    const [first, second] = match.teams;
    const wins = getSetWins(match);
    const winner = isMatchComplete(match)
    ? match.teams.find((team) => wins.find((item) => item.teamId === team.id)?.wins === Math.max(...wins.map((item) => item.wins)))?.name || "—"
    : "—";
    return [
    match.matchInfo.matchDate || "—",
    match.matchInfo.round || "—",
    match.matchInfo.matchNumber || "—",
    `${first.name} vs ${second.name}`,
    match.sets.map((set) => `${getScore(set, first.id)}-${getScore(set, second.id)}`).join(" / "),
    winner,
    isMatchComplete(match) ? "終了" : match.sets.some((set) => set.startedAt || set.events.length) ? "進行中" : "未開始",
    ];
  });
  if (selectedTournament?.fixtures) {
    selectedTournament.fixtures.filter((fixture) => !fixture.matchId && fixture.manualResult?.sets.length)
      .forEach((fixture) => {
        const winnerCode = getTournamentFixtureWinner(fixture, null);
        tournamentRows.push([
          "—",
          fixture.roundName,
          `${fixture.phase === "league" ? "L" : "T"}${fixture.roundIndex + 1}-${fixture.matchIndex + 1}`,
          `${fixture.teamAName} vs ${fixture.teamBName}`,
          fixture.manualResult.sets.map((set) => `${set.teamA}-${set.teamB}`).join(" / "),
          selectedTournament.participants.find((participant) => participant.code === winnerCode)?.name || "進行中",
          winnerCode ? "終了（手入力）" : "進行中（手入力）",
        ]);
      });
  }
  const tournamentTitle = document.createElement("h1");
  tournamentTitle.className = "score-sheet-section-title";
  tournamentTitle.textContent = selectedTournament ? `${selectedTournament.name} 大会報告書` : "大会報告書";
  tournamentDocument.append(tournamentTitle);
  if (selectedTournament) {
    appendPrintSection(tournamentDocument, "参加チーム", ["コード", "チーム"],
      selectedTournament.participants.map((participant) => [participant.code, participant.name]));
  }
  appendPrintSection(tournamentDocument, "大会試合一覧・結果", ["日付", "ラウンド", "試合番号", "対戦", "セット結果", "勝者", "状態"], tournamentRows);
  if (selectedTournament) {
    const tournamentSummary = getTournamentPerformanceSummary(selectedTournament);
    appendPrintSection(tournamentDocument, "大会成績", ["順位", "チーム", "試合", "勝", "敗", "勝率", "得セット率", "得失点率"],
      [...tournamentSummary.teams].sort((a, b) => b.wins - a.wins
        || (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost)
        || (b.pointsScored - b.pointsConceded) - (a.pointsScored - a.pointsConceded))
        .map((record, index) => [
          index + 1, record.participant.name, record.played, record.wins, record.losses,
          record.played ? `${(record.wins / record.played * 100).toFixed(1)}%` : "—",
          record.setsLost ? `${(record.setsWon / record.setsLost * 100).toFixed(1)}%` : "—",
          record.pointsConceded
            ? `${(record.pointsScored / record.pointsConceded * 100).toFixed(1)}%` : "—",
        ]));
    appendPrintSection(tournamentDocument, "アタック得点ランキング", ["順位", "チーム", "選手", "得点"],
      rankedRows(tournamentSummary.attackLeaders, "points"));
    appendPrintSection(tournamentDocument, "ブロックポイントランキング", ["順位", "チーム", "選手", "本数"],
      rankedRows(tournamentSummary.blockLeaders, "blocks"));
    const individualRows = (players) => players.map((player, index) => [
      index + 1, player.teamName, `#${player.number} ${player.name}`, player.points, player.errors,
      player.evaluation.toFixed(1),
    ]);
    appendPrintSection(tournamentDocument, "MVP", ["順位", "チーム", "選手", "得点", "ミス", "評価値"],
      individualRows(tournamentSummary.individualLeaders.slice(0, 1)));
    appendPrintSection(tournamentDocument, "ベスト6", ["順位", "チーム", "選手", "得点", "ミス", "評価値"],
      individualRows(tournamentSummary.individualLeaders.slice(0, 6)));
    appendPrintSection(tournamentDocument, "審判成績", ["審判", "担当試合数", "得点訂正件数", "サーブ順違反検出数", "チャレンジ件数", "チャレンジ後訂正数"],
      getRefereePerformance(tournamentMatches).map((item) => [
        item.name, item.matches, item.corrections, item.serviceOrderViolations, item.challenges, item.challengeCorrections,
      ]));
    const mvpNote = document.createElement("p");
    mvpNote.className = "stats-note";
    mvpNote.textContent = "MVP・ベスト6はアプリ内で記録された個人プレーの評価値（アタック得点＋バックアタック得点＋ブロック得点×1.5＋サービスエース×2－各ミス）順です。ポジション別選考ではありません。外部試合の手入力結果は個人成績に含まれません。";
    tournamentDocument.append(mvpNote);
  }

  const manualDocument = document.createElement("section");
  manualDocument.className = "print-document";
  manualDocument.dataset.printDocument = "manual";
  manualDocument.append(byId("manual-document").cloneNode(true));
  root.append(matchDocument, resultDocument, rosterDocument, setsDocument, playerStatsDocument, tournamentDocument, scoreDocument, eventDocument, manualDocument);
  updatePrintDocumentSelection();

  const preview = byId("score-sheet-preview");
  if (preview) {
    const page = document.createElement("div");
    page.className = "score-sheet-preview-page";
    [...root.children].forEach((child) => page.append(child.cloneNode(true)));
    preview.replaceChildren(page);
    updatePrintDocumentSelection();
  }
}

function updatePrintDocumentSelection() {
  const selected = byId("print-document-type").value;
  [byId("printable-score-sheet"), byId("score-sheet-preview")].forEach((container) => {
    container?.querySelectorAll("[data-print-document]").forEach((documentSection) => {
      documentSection.classList.toggle("print-document-active", documentSection.dataset.printDocument === selected);
    });
  });
}

function renderConfirmationRotation() {
  const summary = byId("confirmation-rotation");
  summary.replaceChildren();
  const set = pendingSetSetup || currentMatch.sets[0];
  const heading = document.createElement("h2");
  heading.textContent = `第${set.number}セットのコート配置・サーブ順`;
  const layout = document.createElement("div");
  layout.id = "confirmation-rotation-layout";
  layout.className = "rotation-court-layout";
  summary.append(heading, layout);
  const state = renderRotationView("confirmation-rotation-layout", set, false);
  const server = getTeam(state.server);
  const lineup = getCurrentLineup(currentMatch, set, state.server);
  const slotIndex = usesCourtRotation(currentMatch)
    ? 0
    : (state.serviceTurns[state.server] - 1 + lineup.length) % lineup.length;
  const player = server?.players.find((item) => item.id === lineup[slotIndex]);
  const detail = document.createElement("p");
  detail.className = "notice";
  detail.textContent = `最初のサーブ: ${server?.name || "未設定"}${player ? ` #${player.number} ${player.name}` : "（選手未割当）"}`;
  summary.append(detail);
  currentMatch.teams.forEach((team) => {
    const liberoNumbers = team.players.filter((member) => member.isLibero)
      .map((member) => `#${member.number} ${member.name}`)
      .join("、") || "登録なし";
    const libero = document.createElement("p");
    libero.className = "notice";
    libero.textContent = `${team.name} リベロ背番号: ${liberoNumbers}`;
    summary.append(libero);
  });
}

function getRequiredStartChecks() {
  const [teamA, teamB] = currentMatch.teams;
  const info = currentMatch.matchInfo;
  const requiredSlots = getCourtPlayerCount(currentMatch);
  if (pendingSetSetup) {
    const set = pendingSetSetup;
    return [
      ["最初のサーブ", Boolean(getExpectedServerPlayerId(set, getServingState(currentMatch, set)))],
      ...currentMatch.teams.flatMap((team) => {
        const lineup = set.startingLineups[team.id] || [];
        const assigned = lineup.slice(0, requiredSlots);
        const liberoNumbers = team.players.filter((player) => player.isLibero)
          .map((player) => `#${player.number}`)
          .join("、") || "登録なし";
        return [
          [`${team.name}の第${set.number}セット配置`, assigned.length === requiredSlots
            && assigned.every(Boolean)
            && new Set(assigned).size === requiredSlots
            && assigned.every((playerId) => team.players.some((player) => player.id === playerId))],
          [`${team.name}のリベロ背番号（${liberoNumbers}）`, true],
        ];
      }),
    ];
  }
  const startChecks = [
    ["大会名", Boolean(info.tournamentName.trim())],
    ["試合日", Boolean(info.matchDate)],
    ["会場", Boolean(info.venue.trim())],
    ["コート", Boolean(info.court.trim())],
    ["試合番号", Boolean(info.matchNumber.trim())],
    ["ラウンド", Boolean(info.round.trim())],
    ["試合形式", currentMatch.rules.matchProfile === "beach" || currentMatch.rules.matchProfile === "soft" || Boolean(currentMatch.rules.matchProfile)],
    ["カテゴリー・種別", Boolean(currentMatch.rules.category) && Boolean(currentMatch.rules.division)],
    ["チームA名", Boolean(teamA.name.trim())],
    ["チームB名", Boolean(teamB.name.trim())],
    [`${teamA.name}の選手登録`, teamA.players.length >= requiredSlots],
    [`${teamB.name}の選手登録`, teamB.players.length >= requiredSlots],
    [`${teamA.name}のキャプテン登録`, teamA.players.some((player) => player.isCaptain)],
    [`${teamB.name}のキャプテン登録`, teamB.players.some((player) => player.isCaptain)],
    [`${teamA.name}のローテーション・サーブ順`, teamA.rotationLineup.slice(0, requiredSlots).every(Boolean)],
    [`${teamB.name}のローテーション・サーブ順`, teamB.rotationLineup.slice(0, requiredSlots).every(Boolean)],
    ["第1サーバー設定", Boolean(getExpectedServerPlayerId(currentMatch.sets[0], getServingState(currentMatch, currentMatch.sets[0])))],
    ["ファーストレフェリー", Boolean(info.officials.firstReferee.name.trim())],
    ["セカンドレフェリー", Boolean(info.officials.secondReferee.name.trim())],
    ["スコアラー", Boolean(info.officials.scorer.name.trim())],
    ["ラインジャッジ1", Boolean(info.officials.lineJudge1.name.trim())],
    ["ラインジャッジ2", Boolean(info.officials.lineJudge2.name.trim())],
    ["ラインジャッジ3", Boolean(info.officials.lineJudge3.name.trim())],
    ["ラインジャッジ4", Boolean(info.officials.lineJudge4.name.trim())],
    ["第1セットのコート配置・サーブ順", (() => {
      const set = currentMatch.sets[0];
      if (!set) return false;
      return currentMatch.teams.every((team) => team.rotationLineup.slice(0, requiredSlots).every(Boolean));
    })()],
    ...currentMatch.teams.map((team) => {
      const liberoNumbers = team.players.filter((player) => player.isLibero)
        .map((player) => `#${player.number}`)
        .join("、") || "登録なし";
      return [`${team.name}のリベロ背番号（${liberoNumbers}）`, true];
    }),
  ];
  return startChecks;
}

function renderPrestartChecklist() {
  const checklist = byId("prestart-checklist");
  const checks = getRequiredStartChecks();
  const missing = checks.filter(([, complete]) => !complete);
  const isNextSet = Boolean(pendingSetSetup);
  byId("confirm-page-title").textContent = isNextSet
    ? `第${pendingSetSetup.number}セット 開始確認`
    : "試合開始確認";
  byId("confirm-page-description").textContent = isNextSet
    ? `第${pendingSetSetup.number}セットのローテーション・サーブ順・リベロ背番号を確認して開始します。`
    : "大会情報、チーム、審判、ローテーションを確認して試合を始めます。";
  byId("prestart-check-title").textContent = isNextSet
    ? `第${pendingSetSetup.number}セット開始前チェック`
    : "試合開始前チェック";
  byId("start-match").textContent = isNextSet
    ? `第${pendingSetSetup.number}セットを開始する`
    : "試合を開始する";
  checklist.replaceChildren();
  checks.forEach(([label, complete]) => {
    const item = document.createElement("li");
    item.className = complete ? "check-complete" : "check-pending";
    const icon = document.createElement("span");
    icon.textContent = complete ? "✓" : "□";
    const text = document.createElement("span");
    text.textContent = `${label}: ${complete ? "確認済み" : "未入力"}`;
    item.append(icon, text);
    checklist.append(item);
  });
  byId("start-match").disabled = missing.length > 0 && (!matchHasStarted() || isNextSet);
}

function getMissingStartRequirements() {
  return getRequiredStartChecks().filter(([, complete]) => !complete).map(([label]) => label);
}

function getRequiredScoreSheetChecks() {
  const [teamA, teamB] = currentMatch.teams;
  const info = currentMatch.matchInfo;
  const winningSet = currentMatch.sets.some((set) => getSetResult(currentMatch, set));
  return [
    ["大会名", Boolean(info.tournamentName.trim())],
    ["試合日", Boolean(info.matchDate)],
    ["会場", Boolean(info.venue.trim())],
    [`${teamA.name}の名前`, Boolean(teamA.name.trim())],
    [`${teamB.name}の名前`, Boolean(teamB.name.trim())],
    [`${teamA.name}の登録選手とキャプテン`, teamA.players.length > 0 && teamA.players.some((player) => player.isCaptain)],
    [`${teamB.name}の登録選手とキャプテン`, teamB.players.length > 0 && teamB.players.some((player) => player.isCaptain)],
    ["ファーストレフェリー", Boolean(info.officials.firstReferee.name.trim())],
    ["セカンドレフェリー", Boolean(info.officials.secondReferee.name.trim())],
    ["スコアラー", Boolean(info.officials.scorer.name.trim())],
    ["ラインジャッジ1", Boolean(info.officials.lineJudge1.name.trim())],
    ["ラインジャッジ2", Boolean(info.officials.lineJudge2.name.trim())],
    ["ラインジャッジ3", Boolean(info.officials.lineJudge3.name.trim())],
    ["ラインジャッジ4", Boolean(info.officials.lineJudge4.name.trim())],
    ["試合終了状態", winningSet || Boolean(info.endedAt)],
  ];
}

function getMissingScoreSheetRequirements() {
  return getRequiredScoreSheetChecks().filter(([, complete]) => !complete).map(([label]) => label);
}

function getLongestPointRuns(set) {
  const [teamA, teamB] = currentMatch.teams;
  const runs = new Map(currentMatch.teams.map((team) => [team.id, { current: 0, maximum: 0 }]));
  let lastTeamId = "";
  for (const event of getEffectivePointEvents(set)) {
    if (event.teamId !== lastTeamId) {
      lastTeamId = event.teamId;
      runs.forEach((run, teamId) => { run.current = teamId === lastTeamId ? 1 : 0; });
    } else {
      runs.get(event.teamId).current += 1;
    }
    const run = runs.get(event.teamId);
    run.maximum = Math.max(run.maximum, run.current);
  }
  return { teamA, teamB, runs };
}

function renderScoreChart() {
  const select = byId("score-chart-set");
  const previous = select.value;
  select.replaceChildren();
  currentMatch.sets.forEach((set) => {
    const option = document.createElement("option");
    option.value = String(set.number);
    option.textContent = `第${set.number}セット`;
    select.append(option);
  });
  const selectedNumber = currentMatch.sets.some((set) => String(set.number) === previous)
    ? Number(previous) : currentSet().number;
  select.value = String(selectedNumber);
  const set = currentMatch.sets.find((item) => item.number === selectedNumber);
  const chart = byId("score-progression-chart");
  const controls = byId("score-timeline-controls");
  chart.replaceChildren();
  const points = getEffectivePointEvents(set);
  window.clearInterval(scoreTimelineInterval);
  controls.replaceChildren();
  if (!points.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "このセットに有効な得点記録はありません。";
    chart.append(empty);
    controls.hidden = true;
    return;
  }
  const scores = new Map(currentMatch.teams.map((team) => [team.id, [0]]));
  const currentScores = new Map(currentMatch.teams.map((team) => [team.id, 0]));
  points.forEach((event) => {
    currentScores.set(event.teamId, currentScores.get(event.teamId) + 1);
    currentMatch.teams.forEach((team) => scores.get(team.id).push(currentScores.get(team.id)));
  });
  const width = 760;
  const height = 280;
  const padding = { left: 42, right: 20, top: 18, bottom: 34 };
  const maxScore = Math.max(...currentMatch.teams.flatMap((team) => scores.get(team.id)), 1);
  const x = (index) => padding.left + index / Math.max(points.length, 1) * (width - padding.left - padding.right);
  const y = (score) => height - padding.bottom - score / maxScore * (height - padding.top - padding.bottom);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(points.length);
  slider.value = String(points.length);
  slider.setAttribute("aria-label", "得点タイムライン");
  slider.className = "score-timeline-slider";
  const status = document.createElement("output");
  status.className = "score-timeline-status";
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "button button-secondary";
  playButton.textContent = "再生";
  controls.hidden = false;
  controls.append(playButton, slider, status);

  const draw = () => {
    const visibleCount = Number(slider.value);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `第${set.number}セットの得点推移`);
    svg.classList.add("score-progression-svg");
    const axis = document.createElementNS(svg.namespaceURI, "path");
    axis.setAttribute("d", `M${padding.left} ${padding.top} V${height - padding.bottom} H${width - padding.right}`);
    axis.setAttribute("class", "score-chart-axis");
    svg.append(axis);
    currentMatch.teams.forEach((team, teamIndex) => {
      const visibleScores = scores.get(team.id).slice(0, visibleCount + 1);
      const line = document.createElementNS(svg.namespaceURI, "polyline");
      line.setAttribute("points", visibleScores.map((score, index) => `${x(index)},${y(score)}`).join(" "));
      line.setAttribute("class", `score-chart-line ${teamIndex === 0 ? "team-a" : "team-b"}`);
      line.setAttribute("fill", "none");
      svg.append(line);
      const label = document.createElementNS(svg.namespaceURI, "text");
      label.setAttribute("x", String(padding.left));
      label.setAttribute("y", String(padding.top + 16 + teamIndex * 18));
      label.setAttribute("class", `score-chart-label ${teamIndex === 0 ? "team-a" : "team-b"}`);
      label.textContent = team.name;
      svg.append(label);
    });
    chart.replaceChildren(svg);
    status.textContent = `${visibleCount} / ${points.length}点　${currentMatch.teams[0].name} ${scores.get(currentMatch.teams[0].id)[visibleCount]} - ${scores.get(currentMatch.teams[1].id)[visibleCount]} ${currentMatch.teams[1].name}`;
  };
  slider.addEventListener("input", draw);
  playButton.addEventListener("click", () => {
    if (scoreTimelineInterval) {
      window.clearInterval(scoreTimelineInterval);
      scoreTimelineInterval = undefined;
      playButton.textContent = "再生";
      return;
    }
    if (Number(slider.value) >= points.length) slider.value = "0";
    playButton.textContent = "一時停止";
    draw();
    scoreTimelineInterval = window.setInterval(() => {
      const next = Number(slider.value) + 1;
      slider.value = String(next);
      draw();
      if (next >= points.length) {
        window.clearInterval(scoreTimelineInterval);
        scoreTimelineInterval = undefined;
        playButton.textContent = "もう一度再生";
      }
    }, 550);
  });
  draw();
}

function getLostPointBreakdown(teamId, sets = currentMatch.sets) {
  const labels = ["サーブミス", "アタックミス", "レシーブミス", "ブロックミス", "反則・ペナルティ", "相手のサーブ得点", "相手のアタック得点", "相手のブロック得点", "その他"];
  const breakdown = new Map(labels.map((label) => [label, 0]));
  let total = 0;
  for (const set of sets) {
    const rallyEvents = new Map(set.events.filter((event) => ["rally-play", "play"].includes(event.type))
      .map((event) => [event.id, event]));
    for (const score of getEffectivePointEvents(set)) {
      if (score.teamId === teamId) continue;
      total += 1;
      const rally = rallyEvents.get(score.rallyEventId);
      let category = "その他";
      if (rally?.teamId === teamId && rally.outcome === "error") {
        const kind = getPerformanceKind(rally);
        if (kind === "serve") category = "サーブミス";
        else if (["attack", "backAttack"].includes(kind)) category = "アタックミス";
        else if (kind === "reception") category = "レシーブミス";
        else if (kind === "block") category = "ブロックミス";
        else category = "その他";
      } else if (rally && rally.teamId !== teamId) {
        const kind = getPerformanceKind(rally);
        if (kind === "serve") category = "相手のサーブ得点";
        else if (["attack", "backAttack"].includes(kind)) category = "相手のアタック得点";
        else if (kind === "block") category = "相手のブロック得点";
      } else if (score.playType === "opponent-error") category = "その他";
      else if (score.playType === "penalty") category = "反則・ペナルティ";
      else if (score.playType === "serve" || score.note?.includes("サーブ2回目失敗")) category = "サーブミス";
      else if (score.playType === "attack" || score.playType === "back-attack") category = "アタックミス";
      else if (score.playType === "block") category = "ブロックミス";
      else if (score.faultPlayerId) category = "その他";
      breakdown.set(category, breakdown.get(category) + 1);
    }
  }
  return { total, breakdown };
}

function getSetSideoutBreakStats(teamId, set) {
  let server = set.initialServiceTeamId;
  let sideoutOpportunities = 0;
  let sideoutPoints = 0;
  let breakOpportunities = 0;
  let breakPoints = 0;
  for (const event of getEffectivePointEvents(set)) {
    if (server === teamId) {
      breakOpportunities += 1;
      if (event.teamId === teamId) breakPoints += 1;
    } else {
      sideoutOpportunities += 1;
      if (event.teamId === teamId) sideoutPoints += 1;
    }
    server = event.teamId;
  }
  return { sideoutOpportunities, sideoutPoints, breakOpportunities, breakPoints };
}

function getPlayerCourtTime(match, team) {
  const durations = new Map(team.players.map((player) => [player.id, 0]));
  for (const set of match.sets) {
    const events = [...set.events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const times = events.map((event) => Date.parse(event.time)).filter(Number.isFinite);
    if (!set.startedAt && times.length === 0) continue;
    const start = Date.parse(set.startedAt);
    const startAt = Number.isFinite(start) ? start : Math.min(...times);
    const end = Date.parse(set.endedAt);
    const matchEnd = Date.parse(match.matchInfo.endedAt);
    const latestEvent = times.length ? Math.max(...times) : startAt;
    const endAt = Number.isFinite(end) && end >= startAt
      ? end
      : isMatchComplete(match) && Number.isFinite(matchEnd) ? Math.max(latestEvent, matchEnd) : Math.max(latestEvent, Date.now());
    let cursor = startAt;
    const lineup = new Set((set.startingLineups?.[team.id]?.length
      ? set.startingLineups[team.id] : team.rotationLineup).filter((id) => durations.has(id)));
    const addInterval = (until) => {
      const duration = Math.max(0, until - cursor);
      lineup.forEach((playerId) => durations.set(playerId, durations.get(playerId) + duration));
      cursor = until;
    };
    for (const event of events) {
      if (event.teamId !== team.id || !["substitution", "libero-substitution"].includes(event.type)) continue;
      const eventTime = Date.parse(event.time);
      if (!Number.isFinite(eventTime) || eventTime < cursor || eventTime > endAt) continue;
      addInterval(eventTime);
      const outgoing = team.players.find((player) => player.number === event.playerOut || player.name === event.playerOut);
      const incoming = team.players.find((player) => player.number === event.playerIn || player.name === event.playerIn);
      if (outgoing && incoming && lineup.has(outgoing.id)) {
        lineup.delete(outgoing.id);
        lineup.add(incoming.id);
      }
    }
    addInterval(endAt);
  }
  return durations;
}

function getAnomalySummary(match) {
  const allEvents = match.sets.flatMap((set) => set.events);
  const corrections = allEvents.filter((event) => event.type === "score"
    && (event.correctionSource || event.delta < 0 && event.correctionOf)).length;
  const rows = [
    ["サーブ順違反の可能性", allEvents.filter((event) => event.type === "service-order-violation").length],
    ["得点訂正", corrections],
    ["チャレンジ後訂正", allEvents.filter((event) => event.type === "score" && event.correctionSource === "challenge").length],
    ["チャレンジ", allEvents.filter((event) => event.type === "challenge").length],
    ["メディカル記録", allEvents.filter((event) => event.type === "medical").length],
    ["罰則・遅延行為", allEvents.filter((event) => event.type === "sanction").length],
    ["状態チェック警告", match.sets.reduce((count, set) => count + getIntegrityIssues(match, set).length, 0)],
  ];
  return rows;
}

function renderMatchReview(winner, statsA, statsB, receptionA, receptionB) {
  const container = byId("match-review");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "試合総評";
  container.append(heading);
  const [teamA, teamB] = currentMatch.teams;
  const winnerTeam = winner ? getTeam(winner.teamId) : null;
  const summary = document.createElement("p");
  if (!winnerTeam) {
    summary.textContent = "試合進行中のため、現在の記録から暫定評価を表示しています。";
    container.append(summary);
  } else {
    const winStats = winnerTeam.id === teamA.id ? statsA : statsB;
    const loseStats = winnerTeam.id === teamA.id ? statsB : statsA;
    const winReception = winnerTeam.id === teamA.id ? receptionA : receptionB;
    const loseReception = winnerTeam.id === teamA.id ? receptionB : receptionA;
    const winnerSideout = getSideoutBreakStats(winnerTeam.id);
    const loserSideout = getSideoutBreakStats(winnerTeam.id === teamA.id ? teamB.id : teamA.id);
    const winnerSideoutRate = winnerSideout.sideoutOpportunities
      ? winnerSideout.sideoutPoints / winnerSideout.sideoutOpportunities * 100 : null;
    const loserSideoutRate = loserSideout.sideoutOpportunities
      ? loserSideout.sideoutPoints / loserSideout.sideoutOpportunities * 100 : null;
    const advantages = [
      [`サービスエース ${winStats.serve.points}本`, winStats.serve.points - loseStats.serve.points],
      [`ブロックポイント ${winStats.block.points}本`, winStats.block.points - loseStats.block.points],
      [`アタック得点 ${winStats.attack.points}本`, winStats.attack.points - loseStats.attack.points],
      [`サイドアウト率 ${formatPercentage(winnerSideout.sideoutPoints, winnerSideout.sideoutOpportunities)}`,
        winnerSideoutRate !== null && loserSideoutRate !== null ? winnerSideoutRate - loserSideoutRate : 0],
      [`レセプション成功率 ${winReception === null ? "—" : `${winReception.toFixed(1)}%`}`,
        winReception !== null && loseReception !== null ? winReception - loseReception : 0],
    ].filter(([, difference]) => difference > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const winLoss = getLostPointBreakdown(winnerTeam.id);
    const weaknesses = [
      ["サーブミス", winLoss.breakdown.get("サーブミス")],
      ["アタックミス", winLoss.breakdown.get("アタックミス")],
      ["レシーブミス", winLoss.breakdown.get("レシーブミス")],
    ].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const strengthsText = advantages.length
      ? `勝因の候補: ${advantages.map(([label]) => label).join("、")}。`
      : "記録された指標では明確な優位差を判定できませんでした。";
    const weaknessText = weaknesses.length
      ? `課題の候補: ${weaknesses.map(([label, count]) => `${label}${count}本`).join("、")}。`
      : "記録上、主なサーブ・アタック・レシーブミスはありません。";
    summary.textContent = `${winnerTeam.name}が勝利。${strengthsText} ${weaknessText}`;
    container.append(summary);
  }
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "記録された得点・プレーのみから作成した自動要約です。未入力のプレーは評価に含まれません。";
  const coachingHeading = document.createElement("h3");
  coachingHeading.textContent = "AIコーチング（記録ベース）";
  const advice = document.createElement("ul");
  [teamA, teamB].forEach((team) => {
    const tendencies = getTeamTendencies(team.code, team.name, [currentMatch]);
    const teamLosses = [...tendencies.lostPoints.values()].reduce((sum, count) => sum + count, 0);
    const serveErrors = tendencies.lostPoints.get("サーブミス") || 0;
    if (teamLosses && serveErrors) {
      const item = document.createElement("li");
      item.textContent = `${team.name}: サーブミスが失点の${(serveErrors / teamLosses * 100).toFixed(1)}%（${serveErrors}/${teamLosses}点）。サーブのリスク管理を確認してください。`;
      advice.append(item);
    }
    const weakRotation = tendencies.rotationLosses
      .map((count, index) => ({ count, index })).sort((a, b) => b.count - a.count)[0];
    if (weakRotation?.count >= 2) {
      const item = document.createElement("li");
      item.textContent = `${team.name}: ローテーション${weakRotation.index + 1}時に${weakRotation.count}失点しています。サーブ時の配置と連続失点を確認してください。`;
      advice.append(item);
    }
    if (tendencies.timeoutOpportunities) {
      const rate = tendencies.timeoutPoints / tendencies.timeoutOpportunities * 100;
      const item = document.createElement("li");
      item.textContent = `${team.name}: タイムアウト後に記録された次の最大3得点の獲得率は${rate.toFixed(1)}%（${tendencies.timeoutPoints}/${tendencies.timeoutOpportunities}点）です。`;
      advice.append(item);
    }
  });
  const coachingNote = document.createElement("p");
  coachingNote.className = "stats-note";
  coachingNote.textContent = "外部AIには送信せず、ローカルの試合記録に対するルールベースの参考提案です。プレー未記録や誤記があれば結果も変わります。";
  container.append(note, coachingHeading);
  if (advice.children.length) container.append(advice);
  else container.append(Object.assign(document.createElement("p"), {
    className: "empty-message",
    textContent: "改善提案に必要な得点・タイムアウト記録がありません。",
  }));
  container.append(coachingNote);
}

function renderSetComparison() {
  const container = byId("match-set-comparison");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "セット別比較";
  const [teamA, teamB] = currentMatch.teams;
  const rows = currentMatch.sets.filter((set) =>
    set.startedAt || set.events.some((event) => event.type === "score" && event.delta > 0))
    .flatMap((set) => currentMatch.teams.map((team) => {
      const stats = getPerformanceStats(team, [set]).total;
      const service = getSetSideoutBreakStats(team.id, set);
      return [
        `第${set.number}セット`,
        team.name,
        `${getScore(set, teamA.id)}-${getScore(set, teamB.id)}`,
        formatPercentage(service.sideoutPoints, service.sideoutOpportunities),
        formatPercentage(service.breakPoints, service.breakOpportunities),
        stats.serve.points,
        formatPercentage(stats.attack.points, stats.attack.attempts),
      ];
    }));
  const table = rows.length
    ? makeTable(["セット", "チーム", "得点", "サイドアウト率", "ブレイク率", "サービスエース", "アタック決定率"], rows, "match-analysis-table")
    : null;
  container.append(heading);
  if (table) container.append(table);
  else {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "セットの得点記録後に比較を表示します。";
    container.append(empty);
  }
}

function renderLostPointAnalysis() {
  const container = byId("match-loss-analysis");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "失点要因分析";
  const labels = ["サーブミス", "アタックミス", "レシーブミス", "ブロックミス", "反則・ペナルティ", "相手のサーブ得点", "相手のアタック得点", "相手のブロック得点", "その他"];
  const losses = currentMatch.teams.map((team) => ({ team, ...getLostPointBreakdown(team.id) }));
  const rows = losses.map(({ team, total, breakdown }) => [
    team.name,
    total,
    ...labels.map((label) => breakdown.get(label)),
  ]);
  container.append(heading, makeTable(["チーム", "失点合計", ...labels], rows, "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "得点に紐づいたラリー記録や得点内容から分類します。ラリー詳細を記録していない得点は「その他」になることがあります。";
  container.append(note);
}

function renderAnomalyHistory() {
  const container = byId("match-anomaly-history");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "異常イベント・訂正履歴";
  const rows = getAnomalySummary(currentMatch);
  container.append(heading, makeTable(["項目", "件数"], rows, "match-analysis-table"));
}

function renderPlayerPlayingTime() {
  const container = byId("player-playing-time");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "選手出場時間";
  const rows = currentMatch.teams.flatMap((team) => {
    const timeByPlayer = getPlayerCourtTime(currentMatch, team);
    const appearances = getPlayerSetAppearances(team);
    return team.players.map((player) => [
      team.name,
      `#${player.number} ${player.name}`,
      appearances.playerSetsPlayed.get(player.id) || 0,
      `${Math.round((timeByPlayer.get(player.id) || 0) / 60_000)}分`,
    ]);
  });
  container.append(heading, makeTable(["チーム", "選手", "出場セット", "出場時間"], rows, "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "セット開始・終了時刻と登録済みの通常交代・リベロ交代から算出した概算です。交代記録がない場合、正確な出場時間にならないことがあります。";
  container.append(note);
}

function getAttackZoneStats(team, sets = currentMatch.sets) {
  const zones = new Map(Array.from({ length: 6 }, (_, index) => [String(index + 1), {
    attempts: 0, points: 0, errors: 0, blocked: 0,
  }]));
  for (const set of sets) {
    const blockedAttackIds = getBlockedAttackEventIds(set);
    const correctedRallyEvents = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => set.events.find((original) => original.id === event.correctionOf)?.rallyEventId)
      .filter(Boolean));
    for (const event of set.events) {
      if (event.type !== "rally-play" || event.teamId !== team.id
        || !["attack", "backAttack"].includes(event.playKind)
        || correctedRallyEvents.has(event.id) || !zones.has(String(event.attackZone))) continue;
      const zone = zones.get(String(event.attackZone));
      zone.attempts += 1;
      if (event.outcome === "point") zone.points += 1;
      if (event.outcome === "error") zone.errors += 1;
      if (blockedAttackIds.has(event.id)) zone.blocked += 1;
    }
  }
  return zones;
}

function renderAttackZoneAnalysis() {
  const container = byId("attack-zone-analysis");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "アタックゾーン分析";
  container.append(heading);
  const rows = currentMatch.teams.flatMap((team) => [...getAttackZoneStats(team)].map(([zone, stats]) => [
    team.name,
    `ゾーン${zone}`,
    stats.attempts,
    stats.points,
    formatPercentage(stats.points, stats.attempts),
    stats.errors,
    stats.blocked,
  ]));
  container.append(makeTable(["チーム", "ゾーン", "打数", "得点", "決定率", "ミス", "被ブロック"], rows, "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "プレー記録でアタックまたはバックを選んだ際にゾーンを指定した記録のみ集計します。サーブコース分析は対象外です。";
  container.append(note);
}

function getUncorrectedRallyEvents(set) {
  const eventsById = new Map(set.events.map((event) => [event.id, event]));
  const correctedRallyIds = new Set(set.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => eventsById.get(event.correctionOf)?.rallyEventId)
    .filter(Boolean));
  return set.events.filter((event) => event.type === "rally-play" && !correctedRallyIds.has(event.id));
}

function renderServeCourseAnalysis() {
  const container = byId("serve-course-analysis");
  container.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "サーブコース分析" }));
  const rows = currentMatch.teams.flatMap((team) => team.players.flatMap((player) => {
    const serves = currentMatch.sets.flatMap(getUncorrectedRallyEvents)
      .filter((event) => event.teamId === team.id && event.playerId === player.id
        && event.playKind === "serve" && event.courseZone);
    if (!serves.length) return [];
    const counts = Array.from({ length: 6 }, (_, index) => serves.filter((event) => event.courseZone === index + 1).length);
    return [[team.name, `#${player.number} ${player.name}`, serves.length,
      ...counts.map((count) => formatPercentage(count, serves.length)),
      serves.filter((event) => event.outcome === "point").length,
      serves.filter((event) => event.outcome === "error").length]];
  }));
  if (rows.length) {
    container.append(makeTable(["チーム", "選手", "記録数", "ゾーン1", "ゾーン2", "ゾーン3", "ゾーン4", "ゾーン5", "ゾーン6", "得点", "ミス"],
      rows, "match-analysis-table"));
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "サーブ時に狙ったコースを記録すると、選手別のコース割合を表示します。";
    container.append(empty);
  }
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "ゾーン割合は、コースを入力したサーブ記録を分母に算出します。未指定のサーブは含まれません。";
  container.append(note);
}

function renderReceptionCourseAnalysis() {
  const container = byId("reception-course-analysis");
  container.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "レシーブコース分析" }));
  const rows = currentMatch.teams.flatMap((team) => {
    const receptions = currentMatch.sets.flatMap(getUncorrectedRallyEvents)
      .filter((event) => event.teamId === team.id
        && ["reception", "serveReception", "attackReception"].includes(event.playKind)
        && event.courseZone);
    return Array.from({ length: 6 }, (_, index) => {
      const zone = index + 1;
      const zoneEvents = receptions.filter((event) => event.courseZone === zone);
      if (!zoneEvents.length) return null;
      const points = zoneEvents.filter((event) => ["excellent", "good"].includes(event.outcome)).length;
      const failures = zoneEvents.filter((event) => ["error", "other"].includes(event.outcome)).length;
      return [team.name, `ゾーン${zone}`, zoneEvents.length,
        formatPercentage(points, zoneEvents.length), formatPercentage(failures, zoneEvents.length)];
    }).filter(Boolean);
  });
  if (rows.length) container.append(makeTable(["チーム", "受けたコース", "本数", "成功率（優・良）", "失点/その他率"], rows, "match-analysis-table"));
  else {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "レシーブ時に受けたコースを記録すると、コース別成功率を表示します。";
    container.append(empty);
  }
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "成功率は「優」または「良」の割合です。";
  container.append(note);
}

function renderLiberoAnalysis() {
  const container = byId("libero-analysis");
  container.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "リベロ分析" }));
  const rows = currentMatch.teams.flatMap((team) => team.players.filter((player) => player.isLibero).map((player) => {
    const receptions = currentMatch.sets.flatMap(getUncorrectedRallyEvents)
      .filter((event) => event.teamId === team.id && event.playerId === player.id
        && ["reception", "serveReception", "attackReception"].includes(event.playKind));
    const successful = receptions.filter((event) => ["excellent", "good"].includes(event.outcome)).length;
    const failures = receptions.filter((event) => ["error", "other"].includes(event.outcome)).length;
    const substitutions = currentMatch.sets.flatMap((set) => set.events)
      .filter((event) => event.type === "libero-substitution" && event.teamId === team.id
        && ([player.number, player.name].includes(event.playerIn)
          || [player.number, player.name].includes(event.playerOut))).length;
    return [team.name, `#${player.number} ${player.name}`, receptions.length,
      formatPercentage(successful, receptions.length), formatPercentage(failures, receptions.length), substitutions];
  }));
  if (rows.length) container.append(makeTable(["チーム", "リベロ", "レセプション", "成功率（優・良）", "失点/その他率", "交代記録数"],
    rows, "match-analysis-table"));
  else {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "リベロが登録されていません。";
    container.append(empty);
  }
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "交代記録数はリベロ交代イベントで出入りした回数です。レセプションは該当選手を指定したラリー記録のみを集計します。";
  container.append(note);
}

function getNextPointsAfterEvent(set, eventIndex, teamId, limit = 3) {
  const pointIds = new Set(getEffectivePointEvents(set).map((event) => event.id));
  const nextPoints = set.events.slice(eventIndex + 1).filter((event) => pointIds.has(event.id)).slice(0, limit);
  return {
    own: nextPoints.filter((event) => event.teamId === teamId).length,
    against: nextPoints.filter((event) => event.teamId !== teamId).length,
    total: nextPoints.length,
  };
}

function renderBenchworkAnalysis() {
  const container = byId("match-benchwork-analysis");
  container.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "交代効果・ベンチワーク分析" }));
  const interventionRows = currentMatch.sets.flatMap((set) => set.events.flatMap((event, index) => {
    if (!["substitution", "timeout"].includes(event.type)) return [];
    const team = getTeam(event.teamId);
    if (!team) return [];
    const result = getNextPointsAfterEvent(set, index, team.id);
    if (!result.total) return [];
    const playerText = event.type === "substitution"
      ? `${event.playerOut} → ${event.playerIn}` : "タイムアウト後";
    return [[`第${set.number}セット`, team.name, event.type === "timeout" ? "タイムアウト" : "選手交代",
      playerText, `${result.own}-${result.against}`, result.own - result.against]];
  }));
  const interventionHeading = document.createElement("h4");
  interventionHeading.textContent = "交代・タイムアウト後の次の3得点";
  container.append(interventionHeading);
  if (interventionRows.length) {
    container.append(makeTable(["セット", "チーム", "介入", "選手", "得点-失点", "差"], interventionRows, "match-analysis-table"));
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "交代・タイムアウト後に記録された得点がありません。";
    container.append(empty);
  }
  const pointDifferentials = new Map(currentMatch.teams.flatMap((team) =>
    team.players.map((player) => [player.id, { team, player, for: 0, against: 0 }])));
  for (const set of currentMatch.sets) {
    const lineups = new Map(currentMatch.teams.map((team) => [team.id, new Set(
      (set.startingLineups?.[team.id]?.length ? set.startingLineups[team.id] : team.rotationLineup).filter(Boolean),
    )]));
    const effectiveScores = new Set(getEffectivePointEvents(set).map((event) => event.id));
    for (const event of set.events) {
      if (event.type === "score" && effectiveScores.has(event.id)) {
        for (const team of currentMatch.teams) {
          const isPoint = event.teamId === team.id;
          for (const playerId of lineups.get(team.id)) {
            const stats = pointDifferentials.get(playerId);
            if (!stats) continue;
            if (isPoint) stats.for += 1;
            else stats.against += 1;
          }
        }
      }
      if (!["substitution", "libero-substitution"].includes(event.type)) continue;
      const team = getTeam(event.teamId);
      if (!team) continue;
      const byIdentifier = (value) => team.players.find((player) => player.number === value || player.name === value);
      const outgoing = byIdentifier(event.playerOut);
      const incoming = byIdentifier(event.playerIn);
      if (outgoing && incoming && lineups.get(team.id).has(outgoing.id)) {
        lineups.get(team.id).delete(outgoing.id);
        lineups.get(team.id).add(incoming.id);
      }
    }
  }
  const onCourt = [...pointDifferentials.values()].filter((item) => item.for + item.against > 0)
    .sort((a, b) => (b.for - b.against) - (a.for - a.against));
  const onCourtHeading = document.createElement("h4");
  onCourtHeading.textContent = "コート上の得失点";
  container.append(onCourtHeading);
  if (onCourt.length) container.append(makeTable(["チーム", "選手", "出場中の得点", "失点", "得失点差"],
    onCourt.map(({ team, player, for: own, against }) => [team.name, `#${player.number} ${player.name}`, own, against, own - against]),
    "match-analysis-table"));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "交代・タイムアウト後は直後の最大3得点を集計します。コート上の得失点は登録されたスタメンと交代記録に基づく参考値で、因果関係を示すものではありません。";
  container.append(note);
}

function renderMatchEventReplay() {
  const container = byId("match-event-replay");
  window.clearInterval(matchReplayInterval);
  matchReplayInterval = undefined;
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "試合リプレイ（イベント単位）";
  const events = currentMatch.sets.flatMap((set) => set.events
    .filter((event) => !["match-start", "set-start"].includes(event.type))
    .map((event) => ({ setNumber: set.number, event })));
  container.append(heading);
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "リプレイできるイベントがありません。";
    container.append(empty);
    return;
  }
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(events.length);
  slider.value = String(events.length);
  slider.className = "score-timeline-slider";
  slider.setAttribute("aria-label", "試合リプレイのイベント位置");
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "button button-secondary";
  playButton.textContent = "リプレイ再生";
  const status = document.createElement("output");
  status.className = "score-timeline-status";
  const detail = document.createElement("p");
  detail.className = "score-timeline-status";
  container.append(playButton, slider, status, detail);
  const renderFrame = () => {
    const visible = Number(slider.value);
    const scores = new Map(currentMatch.teams.map((team) => [team.id, 0]));
    let activeSetNumber = events[0]?.setNumber || currentMatch.sets[0].number;
    for (const { setNumber, event } of events.slice(0, visible)) {
      if (setNumber !== activeSetNumber) {
        activeSetNumber = setNumber;
        scores.forEach((_, teamId) => scores.set(teamId, 0));
      }
      if (event.type === "score") scores.set(event.teamId, Math.max(0, scores.get(event.teamId) + event.delta));
    }
    const frame = events[visible - 1];
    if (frame) activeSetNumber = frame.setNumber;
    status.textContent = `第${activeSetNumber}セット / ${visible} / ${events.length} イベント　${currentMatch.teams[0].name} ${scores.get(currentMatch.teams[0].id)} - ${scores.get(currentMatch.teams[1].id)} ${currentMatch.teams[1].name}`;
    detail.textContent = frame
      ? `${new Date(frame.event.time).toLocaleTimeString("ja-JP")} — ${getEventDescription(currentMatch, frame.event)}`
      : "再生開始前";
  };
  slider.addEventListener("input", renderFrame);
  playButton.addEventListener("click", () => {
    if (matchReplayInterval) {
      window.clearInterval(matchReplayInterval);
      matchReplayInterval = undefined;
      playButton.textContent = "リプレイ再生";
      return;
    }
    if (Number(slider.value) >= events.length) slider.value = "0";
    playButton.textContent = "一時停止";
    renderFrame();
    matchReplayInterval = window.setInterval(() => {
      slider.value = String(Number(slider.value) + 1);
      renderFrame();
      if (Number(slider.value) >= events.length) {
        window.clearInterval(matchReplayInterval);
        matchReplayInterval = undefined;
        playButton.textContent = "もう一度再生";
      }
    }, 700);
  });
  renderFrame();
}

function renderMatchAnalysis(winner) {
  renderMatchDataQuality(currentMatch);
  renderScoreChart();
  const setRuns = currentMatch.sets.map((set) => {
    const { teamA, teamB, runs } = getLongestPointRuns(set);
    return [`第${set.number}セット`, runs.get(teamA.id).maximum, runs.get(teamB.id).maximum];
  });
  const matchMaxRuns = currentMatch.teams.map((team) =>
    Math.max(0, ...setRuns.map((row, index) => row[index + 1])));
  setRuns.unshift(["試合最大", matchMaxRuns[0], matchMaxRuns[1]]);
  byId("match-run-analysis").replaceChildren(
    Object.assign(document.createElement("h3"), { textContent: "最大連続得点" }),
    makeTable(["セット", currentMatch.teams[0].name, currentMatch.teams[1].name], setRuns, "match-analysis-table"),
  );
  const [teamA, teamB] = currentMatch.teams;
  const statsA = getPerformanceStats(teamA).total;
  const statsB = getPerformanceStats(teamB).total;
  const receptionA = getReceptionSuccessRate(statsA);
  const receptionB = getReceptionSuccessRate(statsB);
  const causes = [
    ["サービスエース差", statsA.serve.points, statsB.serve.points, statsA.serve.points - statsB.serve.points],
    ["ブロック得点差", statsA.block.points, statsB.block.points, statsA.block.points - statsB.block.points],
    ["アタック得点差", statsA.attack.points, statsB.attack.points, statsA.attack.points - statsB.attack.points],
    ["レセプション成功率", receptionA === null ? "—" : `${receptionA.toFixed(1)}%`, receptionB === null ? "—" : `${receptionB.toFixed(1)}%`,
      receptionA === null || receptionB === null ? "比較不可" : `${(receptionA - receptionB).toFixed(1)}pt`],
  ];
  const causeContainer = byId("match-cause-analysis");
  causeContainer.replaceChildren(Object.assign(document.createElement("h3"), { textContent: winner ? `${getTeam(winner.teamId).name}の勝因分析` : "試合内容の比較" }));
  causeContainer.append(makeTable(["指標", teamA.name, teamB.name, "差（A-B）"], causes, "match-analysis-table"));
  renderMatchReview(winner, statsA, statsB, receptionA, receptionB);
  renderSetComparison();
  renderLostPointAnalysis();
  renderAnomalyHistory();
  renderPlayerPlayingTime();
  renderAttackZoneAnalysis();
  renderServeCourseAnalysis();
  renderReceptionCourseAnalysis();
  renderLiberoAnalysis();
  renderBenchworkAnalysis();
  renderMatchEventReplay();
  const playerRows = currentMatch.teams.flatMap((team) => {
    const stats = getPerformanceStats(team).players;
    return team.players.map((player) => {
      const playerStats = stats.get(player.id) || emptyPlayStats();
      const rating = playerStats.attack.points
        + playerStats.block.points * 1.5
        + playerStats.serve.points * 2
        - playerStats.attack.errors
        - playerStats.backAttack.errors
        - playerStats.serve.errors;
      return { teamName: team.name, player, rating, playerStats };
    });
  }).sort((a, b) => b.rating - a.rating);
  const mvp = byId("match-mvp-analysis");
  mvp.replaceChildren(Object.assign(document.createElement("h3"), { textContent: "MVP候補" }));
  const topPlayer = playerRows.find((item) => item.rating > 0);
  if (!topPlayer) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "個人プレーの記録がないため算出できません。";
    mvp.append(empty);
    return;
  }
  const rating = document.createElement("p");
  rating.className = "mvp-score";
  rating.textContent = `${topPlayer.teamName} #${topPlayer.player.number} ${topPlayer.player.name} — 評価値 ${topPlayer.rating.toFixed(1)}`;
  mvp.append(rating, makeTable(
    ["選手", "アタック得点", "ブロック得点", "サービスエース", "攻撃・サーブミス", "評価値"],
    playerRows.filter((item) => item.rating > 0).map(({ teamName, player, rating: score, playerStats }) => [
      `${teamName} #${player.number} ${player.name}`,
      playerStats.attack.points,
      playerStats.block.points,
      playerStats.serve.points,
      playerStats.attack.errors + playerStats.backAttack.errors + playerStats.serve.errors,
      score.toFixed(1),
    ]),
    "match-analysis-table",
  ));
  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "MVP評価値＝アタック得点×1 + ブロック得点×1.5 + サービスエース×2 − アタック/バックアタック/サーブミス×1。記録された個人プレーのみで算出します。";
  mvp.append(note);
}

function renderMatchFinishChecklist() {
  const winner = getSetWins(currentMatch).find((item) => item.wins >= Math.floor(currentMatch.rules.bestOf / 2) + 1);
  const button = byId("finish-match-check");
  const checklist = byId("match-finish-checklist");
  button.hidden = !winner;
  if (!winner) {
    checklist.hidden = true;
    return;
  }
  const issues = [...new Set(currentMatch.sets.flatMap((set) => getIntegrityIssues(currentMatch, set)))];
  const scoreValid = currentMatch.sets.every((set) =>
    currentMatch.teams.every((team) => getScore(set, team.id) >= 0));
  const setResultsValid = currentMatch.sets.every((set) => {
    const resultTeamId = getSetResult(currentMatch, set);
    const recordedEnd = set.events.some((event) => event.type === "set-end" && event.winnerTeamId === resultTeamId);
    return resultTeamId ? recordedEnd : !set.events.some((event) => event.type === "set-end");
  });
  const playersValid = currentMatch.sets.every((set) => {
    return currentMatch.teams.every((team) => {
      const teamPlayerIds = new Set(team.players.map((player) => player.id));
      const starters = set.startingLineups?.[team.id] || [];
      return starters.every((playerId) => !playerId || teamPlayerIds.has(playerId))
        && set.events.every((event) => event.teamId !== team.id
          || !["score", "rally-play", "play"].includes(event.type)
          || !event.playerId || teamPlayerIds.has(event.playerId));
    });
  }) && issues.length === 0;
  const checks = [
    ["主審登録済", Boolean(currentMatch.matchInfo.officials.firstReferee.name.trim())],
    ["副審登録済", Boolean(currentMatch.matchInfo.officials.secondReferee.name.trim())],
    ["得点整合OK", scoreValid],
    ["セット結果整合OK", setResultsValid],
    ["出場選手確認済", playersValid],
  ];
  checklist.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "試合終了前チェック";
  checklist.append(heading, makeTable(["確認項目", "状態"], checks.map(([label, complete]) => [label, complete ? "✓ OK" : "要確認"]), "finish-check-table"));
  if (issues.length) {
    const details = document.createElement("ul");
    issues.forEach((issue) => {
      const item = document.createElement("li");
      item.textContent = issue;
      details.append(item);
    });
    checklist.append(details);
  }
  checklist.hidden = !finishChecklistExpanded;
}

function renderPageSummaries() {
  const [teamA, teamB] = currentMatch.teams;
  const current = currentSet();
  byId("roster-count").textContent = `${teamA.name}: ${teamA.players.length}名　/　${teamB.name}: ${teamB.players.length}名`;
  byId("home-score-a").textContent = String(getScore(current, teamA.id));
  byId("home-score-b").textContent = String(getScore(current, teamB.id));
  byId("home-set-label").textContent = `SET ${current.number}`;
  byId("live-match-meta").textContent = [
    currentMatch.matchInfo.tournamentName,
    currentMatch.matchInfo.matchDate,
    currentMatch.matchInfo.matchNumber,
  ].filter(Boolean).join(" · ") || "リアルタイムスコア記録";

  const confirmation = byId("confirmation-summary");
  confirmation.replaceChildren();
  const info = currentMatch.matchInfo;
  for (const [label, value] of [
    ["大会名", info.tournamentName], ["試合日", info.matchDate], ["会場", info.venue],
    ["会場住所", info.venueAddress],
    ["コート・試合番号", [info.court, info.matchNumber].filter(Boolean).join(" / ")],
    ["試合形式", `${{ six: "6人制", "six-elementary": "小学生6人制（ローテーションなし）", nine: "9人制", beach: "ビーチバレー", soft: "ソフトバレー" }[currentMatch.rules.matchProfile]} / ${currentMatch.rules.bestOf}セット`],
    ["セット終了後のコートチェンジ", getCourtChangeSets().length
      ? getCourtChangeSets().map((setNumber) => `第${setNumber}セット後`).join("・") : "なし"],
    ["ラウンド", info.round], ["カテゴリー・種別", `${currentMatch.rules.category} / ${currentMatch.rules.division}`],
    ["ファーストレフェリー", info.officials.firstReferee.name],
    ["スコアラー", info.officials.scorer.name],
  ]) appendSummaryRow(confirmation, label, value);
  for (const team of currentMatch.teams) appendSummaryRow(confirmation, team.name, `${team.players.length}名登録`);
  renderConfirmationRotation();
  renderPrestartChecklist();

  const setRows = currentMatch.sets.map((set) => {
    const result = getSetResult(currentMatch, set);
    return [
      `第${set.number}セット`,
      String(getScore(set, teamA.id)),
      String(getScore(set, teamB.id)),
      result ? getTeam(result).name : "進行中",
    ];
  });
  const wins = getSetWins(currentMatch);
  const setSummary = document.createElement("div");
  setSummary.className = "table-scroll";
  setSummary.append(makeTable(["セット", teamA.name, teamB.name, "結果"], setRows));
  byId("score-sheet-summary").replaceChildren(setSummary);
  appendCompletedSetReports(byId("score-sheet-summary"));
  const historyTable = document.createElement("div");
  historyTable.className = "table-scroll";
  historyTable.append(makeTable(["セット", teamA.name, teamB.name, "勝者", "記録件数"], setRows.map((row, index) => [
    ...row.slice(0, 3), row[3], `${currentMatch.sets[index].events.length}件`,
  ])));
  byId("set-history-table").replaceChildren(historyTable);

  const winner = wins.find((entry) => entry.wins >= Math.floor(currentMatch.rules.bestOf / 2) + 1);
  const result = byId("match-result-summary");
  result.replaceChildren();
  const resultTitle = document.createElement("h2");
  resultTitle.className = "result-title";
  resultTitle.textContent = winner ? `${getTeam(winner.teamId).name} 勝利` : "試合進行中";
  result.append(resultTitle);
  appendSummaryRow(result, "セットカウント", `${wins[0].wins} - ${wins[1].wins}`);
  appendSummaryRow(result, "試合状態", winner ? "終了" : "進行中");
  result.append(makeTable(["セット", teamA.name, teamB.name], setRows.map((row) => row.slice(0, 3))));
  renderMatchAnalysis(winner);
  renderMatchFinishChecklist();

  const eventRows = currentMatch.sets.flatMap((set) => set.events.map((event) => [
    `第${set.number}セット`,
    new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    getEventDescription(currentMatch, event),
  ]));
  const sheet = byId("score-sheet-summary");
  const eventTable = document.createElement("div");
  eventTable.className = "table-scroll";
  eventTable.append(makeTable(["セット", "時刻", "得点 / 記録内容"], eventRows));
  sheet.append(eventTable);
  renderPrintableScoreSheet();

  const missingChecks = getRequiredStartChecks().filter(([, complete]) => !complete);
  const checklist = byId("verification-list");
  checklist.replaceChildren();
  missingChecks.forEach(([label]) => {
    const item = document.createElement("li");
    item.className = "check-pending";
    const icon = document.createElement("span");
    icon.textContent = "!";
    const text = document.createElement("span");
    text.textContent = `${label}: 未入力`;
    item.append(icon, text);
    checklist.append(item);
  });
  if (missingChecks.length === 0) {
    const item = document.createElement("li");
    item.className = "check-complete";
    const text = document.createElement("span");
    text.textContent = "未入力の項目はありません。";
    item.append(text);
    checklist.append(item);
  }
}

function addEvent(event) {
  // 得点・交代などを共通の時系列イベントとして保存するため、取り消しと監査が容易です。
  const now = new Date().toISOString();
  const set = currentSet();
  const previousServingState = event.type === "score" && event.delta > 0 && !event.correctionSource
    ? getServingState(currentMatch, set) : null;
  const expectedServerPlayerId = previousServingState ? getExpectedServerPlayerId(set, previousServingState) : "";
  const selectedServerPlayerId = previousServingState ? byId("actual-server-player").value : "";
  const enrichedEvent = previousServingState ? {
    ...event,
    ...(selectedServerPlayerId ? { serverPlayerId: selectedServerPlayerId } : {}),
    ...(expectedServerPlayerId ? { expectedServerPlayerId } : {}),
  } : event;
  const appendEvent = (item) => {
    const scoreFor = (teamId) => getScore(set, teamId)
      + (item.type === "score" && item.teamId === teamId ? item.delta : 0);
    const snapshot = `${scoreFor(currentMatch.teams[0].id)}-${scoreFor(currentMatch.teams[1].id)}`;
    const savedEvent = { id: createId(), time: now, currentScore: snapshot, ...item };
    set.events.push(savedEvent);
    const correction = savedEvent.type === "score" && savedEvent.delta < 0;
    recordAudit(correction ? "edit" : "add", "試合イベント",
      `第${set.number}セット ${getEventDescription(currentMatch, savedEvent)}`, set.number);
    return savedEvent;
  };
  const savedEvent = appendEvent(enrichedEvent);
  if (previousServingState && expectedServerPlayerId && selectedServerPlayerId
    && selectedServerPlayerId !== expectedServerPlayerId) {
    appendEvent({
      type: "service-order-violation",
      teamId: previousServingState.server,
      actualServerPlayerId: selectedServerPlayerId,
      expectedServerPlayerId,
      scoreEventId: savedEvent.id,
    });
  }
  if (event.type === "serve-fault") {
    set.startedAt ||= now;
    currentMatch.matchInfo.startedAt ||= now;
  }
  if (event.type === "score") {
    byId("actual-server-player").value = "";
    set.startedAt ||= now;
    currentMatch.matchInfo.startedAt ||= now;
    if (event.delta > 0) {
      const decidingPoint = getDecidingSetCourtChangePoint(currentMatch, set.number);
      const reachedScore = getScore(set, event.teamId);
      const isElementaryDecidingSet = currentMatch.rules.category === "小学生"
        && currentMatch.rules.bestOf === 3 && set.number === 3;
      if (isElementaryDecidingSet && reachedScore >= 11
        && !set.events.some((item) => item.type === "sto")) {
        appendEvent({ type: "sto", teamId: event.teamId });
      }
      if (decidingPoint > 0 && reachedScore >= decidingPoint
        && !set.events.some((item) => item.type === "court-change" && item.reason === "points")) {
        appendEvent({
          type: "court-change",
          teamId: event.teamId,
          totalPoints: currentMatch.teams.reduce((sum, team) => sum + getScore(set, team.id), 0),
          setNumber: set.number,
          triggerScore: reachedScore,
          reason: "points",
        });
      }
      for (const triggerPoint of currentMatch.rules.technicalTimeoutPoints.filter((point) => point > 0)) {
        if (reachedScore >= triggerPoint && !set.events.some((item) =>
          item.type === "technical-timeout" && item.triggerPoint === triggerPoint)) {
          appendEvent({ type: "technical-timeout", teamId: event.teamId, triggerPoint });
        }
      }
    }

    const winnerTeamId = getSetResult(currentMatch, set);
    const setScore = `${getScore(set, currentMatch.teams[0].id)}-${getScore(set, currentMatch.teams[1].id)}`;
    if (event.correctionSource) {
      set.endedAt = winnerTeamId ? (set.endedAt || now) : "";
      currentMatch.matchInfo.endedAt = isMatchComplete(currentMatch)
        ? (currentMatch.matchInfo.endedAt || now) : "";
    } else if (winnerTeamId) {
      set.endedAt ||= now;
    }
    if (winnerTeamId) {
      const lastSetEnd = [...set.events].reverse().find((item) => item.type === "set-end");
      if (event.correctionSource || !lastSetEnd || lastSetEnd.currentScore !== setScore) {
        appendEvent({
          type: "set-end",
          teamId: winnerTeamId,
          setNumber: set.number,
          winnerTeamId,
        });
      }
      if (!isMatchComplete(currentMatch) && getCourtChangeSets().includes(set.number)
        && !set.events.some((item) => item.type === "court-change" && item.reason === "set-end")) {
        appendEvent({
          type: "court-change",
          teamId: winnerTeamId,
          totalPoints: currentMatch.teams.reduce((sum, team) => sum + getScore(set, team.id), 0),
          setNumber: set.number,
          reason: "set-end",
        });
      }
      if (isMatchComplete(currentMatch)) {
        currentMatch.matchInfo.endedAt ||= now;
        const lastMatchEnd = [...set.events].reverse().find((item) => item.type === "match-end");
        if (event.correctionSource || !lastMatchEnd || lastMatchEnd.teamId !== winnerTeamId || lastMatchEnd.currentScore !== setScore) {
          appendEvent({ type: "match-end", teamId: winnerTeamId });
        }
      }
    }
  }
  render();
  scheduleSave(true);
  elements.announcer.textContent = getEventDescription(currentMatch, event);
  return savedEvent;
}

function addScore(teamId, delta) {
  if (!canScore(currentMatch)) return;
  const newScore = getScore(currentSet(), teamId) + delta;
  if (newScore < 0) return;
  if (delta < 0) {
    const events = currentSet().events;
    const corrected = new Set(events.filter((event) => event.type === "score" && event.delta < 0).map((event) => event.correctionOf).filter(Boolean));
    const original = [...events].reverse().find((event) =>
      event.type === "score" && event.delta === 1 && event.teamId === teamId && !corrected.has(event.id));
    addEvent({ type: "score", teamId, delta, ...(original ? { correctionOf: original.id } : {}) });
    return;
  }
  addEvent({ type: "score", teamId, delta });
}

function startNextSet() {
  if (!getSetResult(currentMatch, currentSet()) || isMatchComplete(currentMatch)) return;
  if (currentMatch.sets.length >= currentMatch.rules.bestOf || currentMatch.sets.length >= 5) return;
  if (pendingSetSetup) {
    navigateTo("rotation");
    return;
  }
  const previousServer = currentSet().initialServiceTeamId;
  const initialServiceTeamId = currentMatch.teams.find((team) => team.id !== previousServer)?.id || currentMatch.teams[0].id;
  const startingLineups = Object.fromEntries(currentMatch.teams.map((team) => [
    team.id, [...team.rotationLineup],
  ]));
  pendingSetSetup = {
    number: currentMatch.sets.length + 1,
    initialServiceTeamId,
    startingLineups,
    startedAt: "",
    endedAt: "",
    events: [],
  };
  renderRotation();
  renderPageSummaries();
  navigateTo("rotation");
}

function startPreparedSet() {
  if (!pendingSetSetup) return;
  if (!getSetResult(currentMatch, currentSet()) || isMatchComplete(currentMatch)
    || pendingSetSetup.number !== currentMatch.sets.length + 1
    || currentMatch.sets.length >= currentMatch.rules.bestOf
    || currentMatch.sets.length >= 5) {
    showError("次のセットを開始できる状態ではありません。現在のセット結果を確認してください。");
    pendingSetSetup = null;
    render();
    return;
  }
  const missing = getMissingStartRequirements();
  if (missing.length) {
    showError(`セット開始前に確認してください: ${missing.join("、")}`);
    return;
  }
  const startedAt = new Date().toISOString();
  const newSet = {
    ...pendingSetSetup,
    startedAt,
    endedAt: "",
    events: [{
      id: createId(),
      time: startedAt,
      teamId: currentMatch.teams[0].id,
      type: "set-start",
      setNumber: pendingSetSetup.number,
    }],
  };

  currentMatch.sets.push(newSet);
  pendingSetSetup = null;
  recordAudit("add", "試合イベント", `第${newSet.number}セットを開始`, newSet.number);
  render();
  scheduleSave(true);
  navigateTo("match");
}

function undoLastEvent() {
  const set = currentSet();
  if (!set.events.length) return;
  const removedEvents = [];
  const removeLast = () => {
    const event = set.events.pop();
    if (event) removedEvents.push(event);
    return event;
  };
  let removed = removeLast();
  const scoreDerivedTypes = new Set(["sto", "court-change", "set-end", "match-end"]);
  if (scoreDerivedTypes.has(removed.type)) {
    while (scoreDerivedTypes.has(set.events.at(-1)?.type)) removeLast();
    if (set.events.at(-1)?.type === "score") removed = removeLast();
  }
  if (removed.type === "score") {
    if (set.events.at(-1)?.type === "serve-fault" && set.events.at(-1).attempt === 2) {
      removed = removeLast();
    }
    const rally = set.events.at(-1);
    if (rally?.type === "rally-play" && ["point", "error"].includes(rally.outcome)) removeLast();
  }
  removedEvents.forEach((event) => recordAudit("delete", "試合イベント",
    `第${set.number}セット ${getEventDescription(currentMatch, event)}`, set.number));
  if (!getSetResult(currentMatch, set)) set.endedAt = "";
  if (!isMatchComplete(currentMatch)) currentMatch.matchInfo.endedAt = "";
  render();
  scheduleSave(true);
  elements.announcer.textContent = `${getEventDescription(currentMatch, removed)}を取り消しました`;
}

function addPlayer(form) {
  if (currentMatch.sets.some((set) => set.events.length > 0)) {
    showError("試合記録開始後は選手登録を変更できません。試合開始前に修正してください。");
    return;
  }
  const team = getTeam(form.dataset.addPlayer);
  const number = form.querySelector('input[type="number"]')?.value.trim();
  const surname = form.elements.namedItem("surname")?.value.trim();
  const givenName = form.elements.namedItem("givenName")?.value.trim();
  const name = [surname, givenName].filter(Boolean).join(" ");
  const captain = form.elements.namedItem("captain")?.checked || false;
  const libero = form.elements.namedItem("libero")?.checked || false;
  const position = form.querySelector('select[name="position"]')?.value || "";
  if (!surname || !givenName || name.length > 60 || !/^\d{1,3}$/.test(number)) {
    showError("背番号（1〜3桁）、苗字、名前を入力してください。");
    return;
  }
  if (team.players.some((player) => player.number === number)) {
    showError("同じチームに重複した背番号があります。");
    return;
  }
  if (team.players.length >= currentMatch.rules.rosterLimit) {
    showError(`1チームに登録できる選手数の上限（${currentMatch.rules.rosterLimit}名）に達しています。`);
    return;
  }
  if (libero && team.players.filter((player) => player.isLibero).length >= MAX_LIBEROS) {
    showError(`リベロは${MAX_LIBEROS}人まで登録できます。`);
    return;
  }
  const player = { id: createId(), number, name: name.slice(0, 60), isCaptain: captain, isLibero: libero, position };
  team.players.push(player);
  if (captain) team.players.filter((player) => player.id !== team.players.at(-1).id).forEach((player) => { player.isCaptain = false; });
  recordAudit("add", "選手登録", `${team.name} #${player.number} ${player.name}`);
  clearError();
  render();
  scheduleSave(true);
}

function createNewMatch() {
  if (!storageRecoveryRequired && store.matches.length >= MAX_MATCHES) {
    showError(`保存できる試合数の上限（${MAX_MATCHES}件）に達しています。試合データを書き出すか、不要な履歴を削除してください。`);
    return;
  }
  if (storageRecoveryRequired) {
    store.matches = [];
    dirty = false;
  } else if (dirty) {
    persistNow();
  }
  clearActiveVideo();
  storageRecoveryRequired = false;
  finishChecklistExpanded = false;
  currentMatch = createEmptyMatch();
  recordAudit("add", "試合作成", "新しい試合を作成");
  render();
  scheduleSave(true);
}

function loadMatch(matchId) {
  if (dirty) persistNow();
  const match = store.matches.find((item) => item.id === matchId);
  if (!match) return;
  clearActiveVideo();
  currentMatch = structuredClone(match);
  finishChecklistExpanded = false;
  clearError();
  render();
  setSaveStatus("保存済みデータを表示中");
  renderHistory();
}

function downloadJsonData(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadJson(match) {
  downloadJsonData(match, `jva-score-${match.matchInfo.matchDate || "match"}.json`);
}

async function prepareStoreForBackup() {
  if (storageRecoveryRequired) {
    throw new Error("既存の保存データを読み込めないため、空のバックアップは作成できません。正しい一括バックアップを復元してください。");
  }
  clearTimeout(saveTimer);
  if (dirty) await persistNow();
  await persistenceQueue;
  if (dirty) throw new Error("最新の試合データを保存できませんでした。保存状態を確認してからバックアップしてください。");
}

async function exportStoreBackup() {
  await prepareStoreForBackup();
  const backup = {
    format: "jva-volleyball-score-backup",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    selectedMatchId: currentMatch.id,
    store: structuredClone(store),
  };
  if (new Blob([JSON.stringify(backup, null, 2)]).size > MAX_STORE_BACKUP_BYTES) {
    throw new Error("一括バックアップが200MBを超えるため書き出せません。試合履歴や監査ログを分けて保存してください。");
  }
  downloadJsonData(backup, `jva-volleyball-backup-${new Date().toISOString().slice(0, 10)}.json`);
  byId("store-backup-status").textContent =
    `大会 ${store.tournaments.length}件・試合 ${store.matches.length}件・チーム履歴 ${store.teamProfiles.length}件をバックアップしました。`;
}

function getBackupSummary(backup, normalizedStore) {
  const selectedMatchExists = normalizedStore.matches.some((match) => match.id === backup.selectedMatchId);
  return {
    exportedAt: backup.exportedAt,
    selectedMatchId: selectedMatchExists ? backup.selectedMatchId : normalizedStore.matches[0]?.id || "",
    matchCount: normalizedStore.matches.length,
    tournamentCount: normalizedStore.tournaments.length,
    teamProfileCount: normalizedStore.teamProfiles.length,
    auditCount: normalizedStore.auditLog.length,
    pluginCount: normalizedStore.plugins.length,
  };
}

function validateStoreBackup(backup) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)
    || backup.format !== "jva-volleyball-score-backup" || backup.formatVersion !== 1
    || typeof backup.exportedAt !== "string" || !Number.isFinite(Date.parse(backup.exportedAt))
    || typeof backup.selectedMatchId !== "string" || !("store" in backup)
    || Object.keys(backup).some((key) =>
      !["format", "formatVersion", "exportedAt", "selectedMatchId", "store"].includes(key))) {
    throw new Error("大会一括バックアップの形式またはバージョンが正しくありません。");
  }
  const normalizedStore = validateStoreImport(backup.store);
  return { normalizedStore, summary: getBackupSummary(backup, normalizedStore) };
}

async function readStoreBackupFile(file) {
  const status = byId("store-backup-status");
  pendingStoreBackup = null;
  byId("restore-store-backup").disabled = true;
  byId("store-backup-overwrite").checked = false;
  if (file.size > MAX_STORE_BACKUP_BYTES) {
    throw new Error("バックアップファイルが大きすぎます（上限200MB）。");
  }
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    throw new Error("バックアップJSONを読み取れません。ファイルが破損していないか確認してください。");
  }
  const { normalizedStore, summary } = validateStoreBackup(backup);
  pendingStoreBackup = { store: normalizedStore, summary };
  status.textContent = [
    `検証成功（書き出し日時: ${new Date(summary.exportedAt).toLocaleString("ja-JP")}）`,
    `大会 ${summary.tournamentCount}件 / 試合 ${summary.matchCount}件 / チーム履歴 ${summary.teamProfileCount}件`,
    `監査ログ ${summary.auditCount}件 / ローカルルール ${summary.pluginCount}件`,
    "内容を確認し、上書き確認にチェックすると復元できます。",
  ].join("　");
  byId("restore-store-backup").disabled = false;
}

async function restoreStoreBackup() {
  if (!pendingStoreBackup || !byId("store-backup-overwrite").checked) {
    throw new Error("バックアップを検証し、現在の端末データを上書きする確認にチェックしてください。");
  }
  const { store: restoredStore, summary } = pendingStoreBackup;
  const confirmed = confirm(
    `この端末の保存データをバックアップ内容で置き換えます。\n\n`
    + `大会 ${summary.tournamentCount}件 / 試合 ${summary.matchCount}件 / チーム履歴 ${summary.teamProfileCount}件\n\n`
    + "現在の端末データは上書きされます。必要なデータを別途バックアップしたことを確認してください。",
  );
  if (!confirmed) return;
  clearTimeout(saveTimer);
  if (dirty) await persistNow();
  await persistenceQueue;
  const snapshot = structuredClone(restoredStore);
  const write = persistenceQueue.then(() => writeStore(snapshot));
  persistenceQueue = write.then(() => undefined, () => undefined);
  await write;
  store = snapshot;
  currentMatch = structuredClone(
    store.matches.find((match) => match.id === summary.selectedMatchId)
      || store.matches[0]
      || createEmptyMatch(),
  );
  pendingStoreBackup = null;
  byId("store-backup-file").value = "";
  byId("store-backup-overwrite").checked = false;
  byId("restore-store-backup").disabled = true;
  storageRecoveryRequired = false;
  dirty = false;
  clearActiveVideo();
  render();
  setSaveStatus("復元済み");
  byId("store-backup-status").textContent =
    `復元しました（大会 ${summary.tournamentCount}件 / 試合 ${summary.matchCount}件 / チーム履歴 ${summary.teamProfileCount}件）。動画ファイル本体は含まれません。`;
}

function importMatchFile(file) {
  if (file.size > 20_000_000) throw new Error("ファイルが大きすぎます（上限20MB）。");
  return file.text().then((text) => {
    let imported;
    try { imported = JSON.parse(text); } catch { throw new Error("JSONファイルを解析できません。"); }
    const validatedMatch = validateImport(imported);
    if (!validatedMatch) throw new Error("試合データの形式または入力値が正しくありません。読み込みを中止しました。");
    const duplicate = store.matches.some((match) => match.id === validatedMatch.id);
    if (!duplicate && store.matches.length >= MAX_MATCHES) {
      throw new Error(`保存できる試合数の上限（${MAX_MATCHES}件）に達しています。試合データを書き出すか、不要な履歴を削除してください。`);
    }
    if (duplicate && !confirm("同じIDの試合データがすでにあります。読み込んだデータで置き換えますか？")) return;
    recordAudit(duplicate ? "edit" : "add", "試合データ", "JSONバックアップから試合を読み込み", undefined, validatedMatch);
    store.matches = [validatedMatch, ...store.matches.filter((match) => match.id !== validatedMatch.id)];
    store = buildStore(store.matches, store.teamProfiles, store.tournaments, store.auditLog, store.plugins);
    currentMatch = structuredClone(validatedMatch);
    clearActiveVideo();
    storageRecoveryRequired = false;
    render();
    scheduleSave(true);
  });
}

function bindEvents() {
  byId("match-video-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const acceptedExtensions = new Set(["mp4", "m4v", "mov", "webm", "ogv", "ogg", "avi", "mkv"]);
    if (!file.type.startsWith("video/") && !acceptedExtensions.has(extension)) {
      showError("動画ファイルを選択してください。ブラウザーが再生できる形式は動画のコーデックに依存します。");
      event.target.value = "";
      return;
    }
    if (file.name.length > 255) {
      showError("動画ファイル名が長すぎます（255文字以内にしてください）。");
      event.target.value = "";
      return;
    }
    if (file.name !== currentMatch.video.fileName && currentMatch.video.syncPoints.length > 0
      && !confirm("別の動画を登録すると、現在の同期ポイントはすべて削除されます。続けますか？")) {
      event.target.value = "";
      return;
    }
    const shouldClearSyncPoints = file.name !== currentMatch.video.fileName;
    let objectUrl;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch (error) {
      showError(`動画を一時再生用に読み込めませんでした: ${error.message}`);
      event.target.value = "";
      return;
    }
    clearActiveVideo();
    activeVideoUrl = objectUrl;
    activeVideoFileName = file.name;
    currentMatch.video.fileName = file.name;
    if (shouldClearSyncPoints) currentMatch.video.syncPoints = [];
    const player = byId("match-video-player");
    player.src = activeVideoUrl;
    player.load();
    byId("video-playback-status").textContent = `動画「${currentMatch.video.fileName}」を一時再生用に読み込みました。動画本体は保存されません。`;
    recordAudit("edit", "試合動画", `動画ファイルを登録: ${currentMatch.video.fileName}`);
    render();
    scheduleSave(true);
    clearError();
  });
  byId("match-video-player").addEventListener("loadedmetadata", () => {
    const duration = byId("match-video-player").duration;
    byId("video-playback-status").textContent = Number.isFinite(duration)
      ? `動画を再生できます（${formatVideoTime(duration)}）。`
      : "動画を再生できます。";
    renderVideoPanel();
  });
  byId("match-video-player").addEventListener("error", () => {
    byId("video-playback-status").textContent = "動画を再生できませんでした。ファイル形式またはコーデックがこのブラウザーに対応しているか確認してください。";
    renderVideoPanel();
  });
  byId("match-video-player").addEventListener("ended", async () => {
    if (videoPlaybackQueueIndex < 0) return;
    videoPlaybackQueueIndex += 1;
    const nextEventId = videoPlaybackQueue[videoPlaybackQueueIndex];
    if (!nextEventId) {
      stopVideoPlaybackQueue();
      byId("video-playback-status").textContent = "抽出した動画イベントの連続再生が終了しました。";
      return;
    }
    await jumpToVideoEvent(nextEventId, true);
  });
  byId("add-video-sync-point").addEventListener("click", () => {
    const eventId = byId("video-sync-event").value;
    const videoTime = byId("match-video-player").currentTime;
    if (!isVideoReady() || !eventId || !Number.isFinite(videoTime) || videoTime < 0 || videoTime > 604_800) {
      showError("有効なイベントと動画時刻を選択してください。");
      return;
    }
    const event = getAllVideoEvents().find((item) => item.event.id === eventId)?.event;
    if (!event) {
      showError("同期対象のイベントが見つかりません。");
      return;
    }
    const oldPoint = currentMatch.video.syncPoints.find((point) => point.eventId === eventId);
    if (!oldPoint && currentMatch.video.syncPoints.length >= 10_000) {
      showError("同期ポイントの上限（10,000件）に達しています。");
      return;
    }
    currentMatch.video.syncPoints = currentMatch.video.syncPoints
      .filter((point) => point.eventId !== eventId);
    currentMatch.video.syncPoints.push({ eventId, videoTime });
    recordAudit("edit", "動画同期ポイント", `${oldPoint ? "更新" : "登録"}: 第${getAllVideoEvents().find((item) => item.event.id === eventId).setNumber}セット`);
    renderVideoPanel();
    scheduleSave(true);
    clearError();
  });
  byId("previous-video-sync-point").addEventListener("click", () => seekAdjacentSyncPoint(-1));
  byId("next-video-sync-point").addEventListener("click", () => seekAdjacentSyncPoint(1));
  byId("video-filter-team").addEventListener("change", renderVideoPanel);
  byId("video-filter-player").addEventListener("change", renderVideoPanel);
  byId("video-filter-kind").addEventListener("change", renderVideoPanel);
  byId("video-filter-rotation").addEventListener("change", renderVideoPanel);
  byId("play-filtered-video-events").addEventListener("click", async () => {
    const clips = getPlayableVideoClipItems();
    if (!clips.length) return;
    videoPlaybackQueue = clips.map(({ event }) => event.id);
    videoPlaybackQueueIndex = 0;
    byId("stop-filtered-video-events").disabled = false;
    const started = await jumpToVideoEvent(videoPlaybackQueue[0], true);
    if (!started) {
      stopVideoPlaybackQueue();
      byId("stop-filtered-video-events").disabled = true;
    }
  });
  byId("stop-filtered-video-events").addEventListener("click", () => {
    stopVideoPlaybackQueue();
    byId("match-video-player").pause();
    byId("stop-filtered-video-events").disabled = true;
    byId("video-playback-status").textContent = "連続再生を停止しました。";
  });
  byId("run-quality-tests").addEventListener("click", () => {
    void runQualityAssurance(byId("qa-suite-select").value);
  });
  byId("run-all-quality-tests").addEventListener("click", () => {
    void runQualityAssurance("regression", true);
  });
  byId("export-quality-report").addEventListener("click", () => {
    if (!lastQualityReport) return;
    downloadJsonData(lastQualityReport, `jva-quality-report-${lastQualityReport.startedAt.slice(0, 10)}.json`);
  });
  byId("clear-quality-report").addEventListener("click", () => {
    if (qualityRunActive) return;
    lastQualityReport = null;
    byId("quality-assurance-summary").replaceChildren(
      Object.assign(document.createElement("h2"), { textContent: "品質保証レポート" }),
      Object.assign(document.createElement("p"), { textContent: "まだ試験を実行していません。" }),
    );
    byId("quality-assurance-results").replaceChildren();
    byId("export-quality-report").disabled = true;
    byId("qa-progress").hidden = true;
    byId("qa-run-status").textContent = "試験データは実行後に自動削除されます。";
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const videoEventButton = target.closest("[data-video-event]");
    if (videoEventButton) {
      const eventId = videoEventButton.dataset.videoEvent;
      byId("video-sync-event").value = eventId;
      void jumpToVideoEvent(eventId);
      return;
    }
    const seekButton = target.closest("[data-video-sync-time]");
    if (seekButton) {
      if (!isVideoReady()) return showError("動画を再選択してから同期ポイントへ移動してください。");
      byId("match-video-player").currentTime = Number(seekButton.dataset.videoSyncTime);
      return;
    }
    const removePoint = target.closest("[data-remove-video-sync]");
    if (removePoint) {
      const eventId = removePoint.dataset.removeVideoSync;
      currentMatch.video.syncPoints = currentMatch.video.syncPoints.filter((point) => point.eventId !== eventId);
      recordAudit("delete", "動画同期ポイント", "同期ポイントを削除");
      renderVideoPanel();
      scheduleSave(true);
    }
  });

  byId("start-record").addEventListener("click", () => {
    clearError();
    navigateTo("setup");
  });

  [...Object.values(infoFields), ...Object.values(ruleFields)].filter((id) => id !== "best-of").forEach((id) => {
    const input = byId(id);
    input.addEventListener("change", updateFromForm);
    if (input.tagName === "INPUT" && input.type !== "date") input.addEventListener("input", updateFromForm);
  });
  setTargetFields.forEach((id) => {
    byId(id).addEventListener("change", updateFromForm);
    byId(id).addEventListener("input", updateFromForm);
  });
  courtChangeSetFields.forEach((id) => byId(id).addEventListener("change", updateFromForm));
  byId("rotation-enabled").addEventListener("change", updateFromForm);
  byId("competition-template").addEventListener("change", () => {
    const profile = builtInRuleProfiles[byId("competition-template").value];
    if (profile) applyRuleProfile(profile);
  });
  byId("rule-plugin-select").addEventListener("change", () => {
    const profile = [...Object.values(builtInRuleProfiles), ...store.plugins]
      .find((item) => item.id === byId("rule-plugin-select").value);
    if (profile) applyRuleProfile(profile);
  });
  byId("save-rule-plugin-form").addEventListener("click", registerRulePluginFromForm);
  byId("import-rule-plugin").addEventListener("click", importRulePlugin);
  byId("delete-rule-plugin").addEventListener("click", deleteRulePlugin);
  byId("export-rule-plugin").addEventListener("click", exportRulePlugin);
  byId("court-board-tournament").addEventListener("change", renderTournamentManagement);
  byId("export-audit-log").addEventListener("click", () =>
    downloadJsonData({ version: 1, auditLog: store.auditLog }, "jva-audit-log.json"));

  byId("match-profile").addEventListener("change", () => {
    const profile = byId("match-profile").value;
    const ninePlayer = profile === "nine";
    const threeSetsOnly = ["six-elementary", "nine", "beach", "soft"].includes(profile);
    byId("best-of").querySelector('option[value="5"]').disabled = threeSetsOnly;
    if (threeSetsOnly) byId("best-of").value = "3";
    if (ninePlayer) {
      byId("roster-limit").value = "42";
    } else {
      byId("roster-limit").value = "30";
    }
    updateBestOf(Number(byId("best-of").value), profile);
    updateFromForm();
    render();
  });

  byId("category").addEventListener("change", () => {
    updateFromForm();
    render();
  });

  byId("save-team-history-a").addEventListener("click", () => saveTeamProfile(0));
  byId("save-team-history-b").addEventListener("click", () => saveTeamProfile(1));
  byId("load-team-history-a").addEventListener("click", () => loadTeamProfile(0));
  byId("load-team-history-b").addEventListener("click", () => loadTeamProfile(1));
  byId("delete-team-history-a").addEventListener("click", () => deleteTeamProfile(0));
  byId("delete-team-history-b").addEventListener("click", () => deleteTeamProfile(1));
  byId("clear-team-history").addEventListener("click", clearTeamHistory);
  byId("clear-match-history").addEventListener("click", clearMatchHistory);
  byId("prestart-initial-server").addEventListener("change", () => {
    if (matchHasStarted() && !pendingSetSetup) return;
    const setupSet = pendingSetSetup || currentMatch.sets[0];
    setupSet.initialServiceTeamId = byId("prestart-initial-server").value;
    renderRotation();
    renderCurrentPageSummaries();
    scheduleSave(true);
  });
  byId("rotation-next-confirm").addEventListener("click", () => {
    if (!pendingSetSetup) return;
    navigateTo("confirm");
  });
  byId("rotation-cancel-setup").addEventListener("click", () => {
    if (!pendingSetSetup) return;
    pendingSetSetup = null;
    renderRotation();
    navigateTo("match");
  });

  byId("best-of").addEventListener("change", () => {
    const selectedBestOf = Number(byId("best-of").value);
    updateBestOf(selectedBestOf);
    updateFromForm();
    render();
  });
  byId("nine-serve-fault").addEventListener("click", recordNinePlayerServeFault);

  officialRoles.forEach(([role]) => {
    for (const [part, field] of [["name", "name"], ["area", "area"]]) {
      const input = byId(`official-${part}-${role}`);
      const updateOfficial = () => {
        currentMatch.matchInfo.officials[role][field] = input.value.trim().slice(0, part === "name" ? 60 : 40);
        if (role === "firstReferee") currentMatch.matchInfo.referee1 = currentMatch.matchInfo.officials[role].name;
        if (role === "secondReferee") currentMatch.matchInfo.referee2 = currentMatch.matchInfo.officials[role].name;
        if (role === "scorer") currentMatch.matchInfo.scorer = currentMatch.matchInfo.officials[role].name;
        renderCurrentPageSummaries();
        scheduleSave();
      };
      input.addEventListener("input", updateOfficial);
      input.addEventListener("change", updateOfficial);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const quickChoice = target.closest("#rally-kind-group [data-value], #rally-outcome-group [data-value]");
    if (quickChoice instanceof HTMLButtonElement) {
      const group = quickChoice.closest("#rally-kind-group, #rally-outcome-group");
      const select = byId(group?.id === "rally-kind-group" ? "rally-kind" : "rally-outcome");
      if (select) select.value = quickChoice.dataset.value;
      group?.querySelectorAll("button[data-value]").forEach((button) => {
        button.classList.toggle("selected", button === quickChoice);
      });
      if (group?.id === "rally-kind-group") renderRallyEntryForm();
      return;
    }
    const scoreButton = target.closest("[data-score-team]");
    if (scoreButton) {
      const delta = Number(scoreButton.dataset.delta);
      if (delta > 0) return showScoreDialog(scoreButton.dataset.scoreTeam);
      return addScore(scoreButton.dataset.scoreTeam, delta);
    }
    const timeoutButton = target.closest("[data-timeout-team]");
    if (timeoutButton && canScore(currentMatch)) return addEvent({ type: "timeout", teamId: timeoutButton.dataset.timeoutTeam });
    const removeButton = target.closest("[data-remove-player]");
    if (removeButton) {
      const team = getTeam(removeButton.dataset.teamId);
      const player = team?.players.find((item) => item.id === removeButton.dataset.removePlayer);
      if (!team || !player) return;
      team.players = team.players.filter((player) => player.id !== removeButton.dataset.removePlayer);
      recordAudit("delete", "選手登録", `${team.name} #${player.number} ${player.name}`);
      render();
      scheduleSave(true);
    }
  });

  bindRosterPhotoImport();
  byId("app-version").textContent = self.APP_VERSION || "不明";
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-add-player]")) return;
    event.preventDefault();
    addPlayer(form);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const destination = target.closest("[data-go]");
    if (destination) navigateTo(destination.dataset.go);
    const navigation = target.closest(".nav-item[data-page]");
    const qaPreset = target.closest("[data-qa-preset]");
    if (qaPreset) {
      if (!developerModeEnabled) return;
      byId("qa-suite-select").value = qaPreset.dataset.qaPreset;
    }
    if (navigation) navigateTo(navigation.dataset.page);
    const removeMatch = target.closest("[data-remove-tournament-match]");
    if (removeMatch) removeMatchFromTournament(removeMatch.dataset.removeTournamentMatch);
    const removeFixture = target.closest("[data-delete-tournament-fixture]");
    if (removeFixture) deleteManualLeagueFixture(removeFixture.dataset.deleteTournamentFixture);
    const editTournamentResult = target.closest("[data-edit-tournament-result]");
    if (editTournamentResult) openTournamentResultDialog(editTournamentResult.dataset.editTournamentResult);
    const editTournamentFixture = target.closest("[data-edit-tournament-fixture]");
    if (editTournamentFixture) openTournamentFixtureDialog(editTournamentFixture.dataset.editTournamentFixture);
    const fixtureButton = target.closest("[data-tournament-fixture]");
    if (fixtureButton) loadTournamentFixture(fixtureButton.dataset.tournamentFixture);
    if (target.closest("[data-print]")) window.print();
  });
  window.addEventListener("hashchange", () => navigateTo(location.hash.slice(1), false));

  for (const [id, index] of [["team-name-setup-a", 0], ["team-name-setup-b", 1]]) {
    byId(id).addEventListener("input", (event) => {
      const team = currentMatch.teams[index];
      team.name = event.target.value.slice(0, 60);
      team.code = createTeamCode(team.name);
      byId(index === 0 ? "team-code-a" : "team-code-b").value = team.code;
      renderTeams();
      renderScoreboard();
      renderTimeouts();
      renderCurrentPageSummaries();
      scheduleSave();
    });
  }

  for (const card of elements.teamCards) {
    card.addEventListener("change", (event) => {
      const input = event.target.closest("[data-team-name]");
      if (!input) return;
      const team = getTeam(input.dataset.teamName);
      team.name = input.value.trim().slice(0, 60) || "チーム";
      team.code = createTeamCode(team.name);
      input.value = team.name;
      const teamIndex = currentMatch.teams.indexOf(team);
      byId(teamIndex === 0 ? "team-name-setup-a" : "team-name-setup-b").value = team.name;
      byId(teamIndex === 0 ? "team-code-a" : "team-code-b").value = team.code;
      renderScoreboard();
      renderTimeouts();
      renderSetStrip();
      renderHistory();
      scheduleSave();
    });
  }

  byId("new-match").addEventListener("click", () => {
    const message = storageRecoveryRequired
      ? "現在読み込めない保存データを置き換えて、新しい試合を作成しますか？バックアップが必要な場合は先に読み込んでください。"
      : "新しい試合を作成しますか？現在の試合は履歴に保存されます。";
    if (confirm(message)) createNewMatch();
  });
  byId("delete-match").addEventListener("click", () => {
    if (!confirm("この試合を履歴とこの端末から削除しますか？削除後は元に戻せません。")) return;
    const deletedMatchId = currentMatch.id;
    recordAudit("delete", "試合履歴", "試合を履歴から削除");
    clearActiveVideo();
    store.matches = store.matches.filter((match) => match.id !== currentMatch.id);
    store.tournaments.forEach((tournament) => {
      tournament.matchIds = tournament.matchIds.filter((id) => id !== deletedMatchId);
      tournament.fixtures?.forEach((fixture) => {
        if (fixture.matchId === deletedMatchId) {
          fixture.matchId = "";
          delete fixture.winnerCode;
        }
      });
    });
    currentMatch = store.matches[0] ? structuredClone(store.matches[0]) : createEmptyMatch();
    storageRecoveryRequired = false;
    render();
    scheduleSave(true);
  });
  elements.history.addEventListener("change", () => {
    if (elements.history.value) loadMatch(elements.history.value);
  });
  byId("next-set").addEventListener("click", startNextSet);
  byId("undo-event").addEventListener("click", undoLastEvent);
  byId("print-match").addEventListener("click", () => {
    const missing = getMissingScoreSheetRequirements();
    if (missing.length > 0) {
      showError(`記録票PDFを表示するには以下の項目が必要です: ${missing.join("、")}`);
      navigateTo("verify");
      return;
    }
    navigateTo("output");
  });
  byId("print-manual").addEventListener("click", () => {
    byId("print-document-type").value = "manual";
    renderPrintableScoreSheet();
    updatePrintDocumentSelection();
    window.print();
  });
  byId("print-document-type").addEventListener("change", updatePrintDocumentSelection);
  byId("score-chart-set").addEventListener("change", () => {
    renderScoreChart();
    renderMatchEventReplay();
  });
  byId("finish-match-check").addEventListener("click", () => {
    finishChecklistExpanded = true;
    renderMatchFinishChecklist();
  });
  byId("create-tournament").addEventListener("click", createTournament);
  byId("tournament-select").addEventListener("change", () => {
    tournamentNotice = "";
    renderTournamentManagement();
    renderPrintableScoreSheet();
    updatePrintDocumentSelection();
  });
  byId("generate-referee-question").addEventListener("click", renderRefereeQuestion);
  byId("training-match").addEventListener("change", () => { refereeQuestionOffset = 0; });
  byId("opponent-scouting-team").addEventListener("change", () => renderOpponentScouting(getSelectedTournament()));
  byId("head-to-head-team-a").addEventListener("change", () => renderHeadToHead(getSelectedTournament()));
  byId("head-to-head-team-b").addEventListener("change", () => renderHeadToHead(getSelectedTournament()));
  byId("add-match-to-tournament").addEventListener("click", addCurrentMatchToTournament);
  byId("add-manual-league-fixture").addEventListener("click", addManualLeagueFixture);
  byId("delete-tournament").addEventListener("click", deleteSelectedTournament);
  byId("tournament-fixture-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveTournamentFixtureMatchup();
  });
  byId("cancel-tournament-fixture").addEventListener("click", () => {
    byId("tournament-fixture-dialog").close();
    editingTournamentFixture = null;
  });
  byId("tournament-fixture-dialog").addEventListener("close", () => {
    editingTournamentFixture = null;
  });
  byId("tournament-result-best-of").addEventListener("change", updateTournamentResultSetVisibility);
  byId("tournament-result-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveManualTournamentResult();
  });
  byId("clear-tournament-result").addEventListener("click", clearManualTournamentResult);
  byId("cancel-tournament-result").addEventListener("click", () => {
    byId("tournament-result-dialog").close();
    editingTournamentResult = null;
  });
  byId("tournament-result-dialog").addEventListener("close", () => {
    editingTournamentResult = null;
  });
  byId("print-tournament-report").addEventListener("click", () => {
    const tournament = getSelectedTournament();
    const hasFixtureResults = tournament?.fixtures?.some((fixture) =>
      fixture.matchId || fixture.manualResult?.sets.length);
    if (!tournament || (!tournament.matchIds.length && !hasFixtureResults)) return;
    renderPrintableScoreSheet();
    byId("print-document-type").value = "tournament-report";
    updatePrintDocumentSelection();
    window.print();
  });
  for (const id of ["season-team", "season-start", "season-end"]) {
    byId(id).addEventListener("input", renderSeasonStats);
    byId(id).addEventListener("change", renderSeasonStats);
  }
  byId("export-match").addEventListener("click", () => downloadJson(currentMatch));
  byId("import-match").addEventListener("click", () => byId("import-file").click());
  byId("export-store-backup").addEventListener("click", () => {
    exportStoreBackup().then(clearError).catch((error) => showError(error.message));
  });
  byId("store-backup-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    byId("store-backup-status").textContent = "バックアップを検証しています…";
    readStoreBackupFile(file)
      .then(clearError)
      .catch((error) => {
        pendingStoreBackup = null;
        byId("restore-store-backup").disabled = true;
        byId("store-backup-status").textContent = "バックアップを検証できませんでした。";
        showError(error.message);
      });
  });
  byId("store-backup-overwrite").addEventListener("change", (event) => {
    if (!pendingStoreBackup) return;
    const confirmationMessage = " 上書き確認済みです。復元ボタンを押すと最終確認が表示されます。";
    const status = byId("store-backup-status");
    status.textContent = status.textContent.replace(confirmationMessage, "");
    if (event.target.checked) status.textContent += confirmationMessage;
  });
  byId("restore-store-backup").addEventListener("click", () => {
    restoreStoreBackup().then(clearError).catch((error) => showError(error.message));
  });
  byId("import-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    importMatchFile(file).catch((error) => showError(error.message)).finally(() => { event.target.value = ""; });
  });
  byId("record-substitution").addEventListener("click", () => {
    if (!canScore(currentMatch)) return;
    const teamId = byId("sub-team").value;
    const team = getTeam(teamId);
    const playerOut = byId("sub-out").value.trim();
    const playerIn = byId("sub-in").value.trim();
    const outgoing = team.players.find((player) => player.number === playerOut);
    const incoming = team.players.find((player) => player.number === playerIn);
    const lineup = getCurrentLineup(currentMatch, currentSet(), teamId);
    if (!/^\d{1,3}$/.test(playerOut) || !/^\d{1,3}$/.test(playerIn)
      || !outgoing || !incoming || outgoing.id === incoming.id
      || outgoing.isLibero || incoming.isLibero
      || !lineup.includes(outgoing.id) || lineup.includes(incoming.id)) {
      showError("交代は、コート内の選手から登録済みの控え選手へ指定してください。リベロ交代は専用欄を使用してください。");
      return;
    }
    const substitutions = currentSet().events.filter((event) => event.type === "substitution" && event.teamId === teamId).length;
    if (substitutions >= currentMatch.rules.substitutionLimit) {
      showError(`このセットの交代上限（${currentMatch.rules.substitutionLimit}回）に達しています。`);
      return;
    }
    addEvent({ type: "substitution", teamId, playerOut, playerIn });
    byId("sub-out").value = "";
    byId("sub-in").value = "";
  });
  byId("record-libero-substitution").addEventListener("click", () => {
    if (!canScore(currentMatch)) return;
    const teamId = byId("libero-team").value;
    const team = getTeam(teamId);
    const playerOut = byId("libero-out").value.trim();
    const playerIn = byId("libero-in").value.trim();
    const outgoing = team.players.find((player) => player.number === playerOut || player.name === playerOut);
    const incoming = team.players.find((player) => player.number === playerIn || player.name === playerIn);
    const lineup = getCurrentLineup(currentMatch, currentSet(), teamId);
    if (!outgoing || !incoming) {
      showError("入力された背番号または氏名がチーム登録にありません。");
      return;
    }
    if (outgoing.id === incoming.id) {
      showError("退く選手と入る選手は別の選手を指定してください。");
      return;
    }
    if (outgoing.isLibero === incoming.isLibero) {
      showError("リベロ交代では、リベロ選手と交代対象選手を1名ずつ指定してください。");
      return;
    }
    if (!lineup.includes(outgoing.id)) {
      showError("退く選手は現在コート内にいる選手を指定してください。");
      return;
    }
    if (lineup.includes(incoming.id)) {
      showError("入る選手は現在コート外にいる選手を指定してください。");
      return;
    }
    if (incoming.isLibero && team.players.some((player) => player.isLibero && player.id !== outgoing.id && lineup.includes(player.id))) {
      showError("コート内にリベロは1名までです。");
      return;
    }
    addEvent({
      type: "libero-substitution",
      teamId,
      playerOut: outgoing.number,
      playerIn: incoming.number,
    });
    byId("libero-out").value = "";
    byId("libero-in").value = "";
  });
  byId("record-sanction").addEventListener("click", () => {
    if (!canScore(currentMatch)) return;
    const team = getTeam(byId("sanction-team").value);
    const subjectType = byId("sanction-subject-type").value;
    const player = byId("sanction-player").value.trim() || (subjectType === "team" ? team.name : "");
    if (!player) return showError("処置対象者を入力してください。");
    addEvent({
      type: "sanction",
      teamId: team.id,
      player: player.slice(0, 40),
      subjectType,
      sanctionType: byId("sanction-type").value,
    });
    byId("sanction-player").value = "";
  });
  byId("medical-team").addEventListener("change", renderMedicalEntryOptions);
  byId("record-medical-event").addEventListener("click", () => {
    if (!matchHasStarted() || !canScore(currentMatch)) return;
    const team = getTeam(byId("medical-team").value);
    const player = team?.players.find((item) => item.id === byId("medical-player").value);
    if (!team || !player) return showError("メディカル記録の対象選手を選択してください。");
    addEvent({
      type: "medical",
      teamId: team.id,
      playerId: player.id,
      bodyArea: byId("medical-area").value,
      status: byId("medical-status").value,
      note: byId("medical-note").value.trim().slice(0, 120),
    });
    byId("medical-note").value = "";
    clearError();
  });
  byId("rally-team").addEventListener("change", renderRallyEntryForm);
  byId("rally-course-clear").addEventListener("click", () => {
    byId("rally-course-zone").value = "";
    renderRallyEntryForm();
  });
  byId("record-rally-play").addEventListener("click", recordRallyPlay);
  byId("record-challenge").addEventListener("click", () => {
    if (!canScore(currentMatch)) return;
    const teamId = byId("challenge-team").value;
    const result = byId("challenge-result").value;
    const failures = currentSet().events.filter((event) =>
      event.type === "challenge" && event.teamId === teamId && event.result === "failed").length;
    if (result === "failed" && failures >= 2) {
      showError("このチームはこのセットでチャレンジ失敗の上限（2回）に達しています。");
      return;
    }
    addEvent({
      type: "challenge",
      teamId,
      challengeType: byId("challenge-type").value,
      result,
      note: byId("challenge-note").value.trim().slice(0, 120),
    });
    byId("challenge-note").value = "";
    clearError();
  });
  byId("record-technical-timeout").addEventListener("click", () => {
    if (!matchHasStarted() || !canScore(currentMatch)) return showError("試合中にTTOを記録してください。");
    addEvent({ type: "technical-timeout", teamId: getServingState(currentMatch, currentSet()).server });
  });
  byId("record-score-correction").addEventListener("click", () => {
    if (!matchHasStarted()) return showError("試合開始後に得点訂正を記録してください。");
    const teamId = byId("correction-team").value;
    const delta = Number(byId("correction-delta").value);
    const source = byId("correction-source").value;
    const reason = byId("correction-note").value.trim().slice(0, 120);
    if (!reason) return showError("点数訂正の内容を入力してください。");
    const corrected = new Set(currentSet().events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => event.correctionOf));
    const original = [...currentSet().events].reverse().find((event) =>
      event.type === "score" && event.delta > 0 && event.teamId === teamId && !corrected.has(event.id));
    if (delta < 0 && !original) return showError("訂正できる未訂正の得点がありません。");
    const servingState = getServingState(currentMatch, currentSet());
    addEvent({
      type: "score",
      teamId,
      delta,
      playType: "other",
      playerId: null,
      faultPlayerId: null,
      note: reason,
      correctionSource: source,
      correctionReason: reason,
      ...(delta < 0 && original ? { correctionOf: original.id } : {}),
      rotationAdvanced: servingState.server !== teamId,
    });
    byId("correction-note").value = "";
    clearError();
  });
  byId("score-play-type").addEventListener("change", () => {
    const type = byId("score-play-type").value;
    const showFaultPlayer = type === "opponent-error" || type === "penalty";
    byId("fault-player-field").hidden = !showFaultPlayer;
    byId("score-player").disabled = showFaultPlayer;
  });
  elements.scoreDialog.addEventListener("close", () => {
    byId("score-dialog-error").textContent = "";
    byId("score-dialog-error").hidden = true;
  });
  byId("score-detail-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addDetailedScore();
  });
  byId("cancel-score-detail").addEventListener("click", () => elements.scoreDialog.close());
  byId("toggle-match-event-entry").addEventListener("click", () => {
    const details = byId("live-event-entry");
    if (!details) return showError("試合中のイベント入力欄を読み込めませんでした。");
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  byId("initial-server").addEventListener("change", () => {
    if (matchHasStarted()) return;
    currentSet().initialServiceTeamId = byId("initial-server").value;
    renderRotation();
    scheduleSave(true);
  });
  byId("actual-server-player").addEventListener("change", () => renderServiceOrderStatus());
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement && select.matches("select[data-team-color-preset]")) {
      if (select.value && select.value !== "custom") {
        updateTeamColor(select.dataset.teamColor, select.value, select.dataset.teamColorRole);
      }
      return;
    }
    if (!(select instanceof HTMLSelectElement) || !select.matches("[data-rotation-team]")) return;
    const team = getTeam(select.dataset.rotationTeam);
    const count = getCourtPlayerCount(currentMatch);
    const position = Number(select.dataset.currentPosition);
    const setupSet = pendingSetSetup || currentMatch.sets[0];
    const { rotations } = getServingState(currentMatch, setupSet);
    const openingPosition = (position + (rotations[team.id] || 0)) % count;
    setupSet.startingLineups ||= {};
    const lineup = [...(setupSet.startingLineups[team.id] || team.rotationLineup)];
    while (lineup.length < count) lineup.push("");
    const previous = lineup[openingPosition];
    if (select.value && lineup.some((playerId, index) => index !== openingPosition && playerId === select.value)) {
      showError("同じ選手を複数のローテーション位置に登録できません。");
      select.value = previous;
      return;
    }
    lineup[openingPosition] = select.value;
    team.rotationLineup = [...lineup];
    setupSet.startingLineups[team.id] = [...lineup];
    clearError();
    renderRotation();
    renderCurrentPageSummaries();
    scheduleSave(true);
  });
 document.addEventListener("input", (event) => {
  const target = event.target;

  // ユニフォーム色
  if (
    target instanceof HTMLInputElement &&
    target.matches("[data-team-color]")
  ) {
    updateTeamColor(
      target.dataset.teamColor,
      target.value,
      target.dataset.teamColorRole
    );
    return;
  }

  // スタッフ情報
  if (
    target instanceof HTMLInputElement &&
    target.matches("[data-team-staff-key]")
  ) {
    const team = getTeam(target.dataset.teamId);

    if (!team) return;

    team.staff ||= {};

    team.staff[target.dataset.teamStaffKey] =
      target.value.trim().slice(0, 40);

    scheduleSave();

    return;
  }
});
  byId("start-match").addEventListener("click", () => {
    if (pendingSetSetup) return startPreparedSet();
    if (matchHasStarted()) return navigateTo("match");
    const missing = getMissingStartRequirements();
    if (missing.length > 0) {
      showError(`試合開始には以下の項目が必要です: ${missing.join("、")}`);
      navigateTo("confirm");
      return;
    }
    const startedAt = new Date().toISOString();
    currentMatch.sets[0].startingLineups = Object.fromEntries(currentMatch.teams.map((team) => [
      team.id, [...team.rotationLineup],
    ]));
    currentMatch.matchInfo.startedAt = startedAt;
    currentMatch.matchInfo.endedAt = "";
    currentSet().startedAt = startedAt;
    currentSet().events.push(
      {
        id: createId(),
        time: startedAt,
        currentScore: "0-0",
        teamId: currentMatch.teams[0].id,
        type: "match-start",
      },
      {
        id: createId(),
        time: startedAt,
        currentScore: "0-0",
        teamId: currentMatch.teams[0].id,
        type: "set-start",
        setNumber: 1,
      },
    );
    recordAudit("add", "試合イベント", "試合・第1セットを開始", 1);

    render();
    scheduleSave(true);
    navigateTo("match");
  });
  byId("sidebar-toggle").addEventListener("click", toggleSidebar);
  byId("device-preset").addEventListener("change", () => applyDevicePreset(byId("device-preset").value, true));
  document.body.addEventListener("click", (event) => {
    if (event.target === document.body && document.body.classList.contains("sidebar-open")) {
      document.body.classList.remove("sidebar-open");
      byId("sidebar-toggle").setAttribute("aria-expanded", "false");
    }
  });
  byId("theme-toggle").addEventListener("click", toggleTheme);
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      persistNow();
      if (dirty) event.preventDefault();
    }
  });
}

function isCompactViewport() {
  return byId("device-preset").value === "phone" || (byId("device-preset").value === "auto" && matchMedia("(max-width: 820px)").matches);
}

function toggleSidebar() {
  if (isCompactViewport()) {
    document.body.classList.toggle("sidebar-open");
    byId("sidebar-toggle").setAttribute("aria-expanded", String(document.body.classList.contains("sidebar-open")));
    return;
  }
  document.body.classList.toggle("sidebar-collapsed");
  const expanded = !document.body.classList.contains("sidebar-collapsed");
  byId("sidebar-toggle").setAttribute("aria-expanded", String(expanded));
  try { localStorage.setItem("jva-sidebar-collapsed", String(!expanded)); } catch { /* Optional layout preference. */ }
}

function applyDevicePreset(preset, save = false) {
  const allowed = ["auto", "phone", "tablet", "desktop"];
  const selected = allowed.includes(preset) ? preset : "auto";
  document.body.dataset.device = selected === "auto" ? "" : selected;
  document.body.classList.remove("sidebar-open");
  const compactLayout = selected === "phone" || (selected === "auto" && matchMedia("(max-width: 820px)").matches);
  const expanded = !compactLayout && !document.body.classList.contains("sidebar-collapsed");
  byId("sidebar-toggle").setAttribute("aria-expanded", String(expanded));
  if (save) {
    try { localStorage.setItem("jva-device-preset", selected); } catch { /* Optional layout preference. */ }
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("jva-score-theme", next); } catch { /* Theme preference is optional. */ }
  byId("theme-toggle").textContent = next === "dark" ? "ライトモード" : "ダークモード";
}

function initializeTheme() {
  let theme = "light";
  try {
    theme = localStorage.getItem("jva-score-theme") || "dark";
  } catch { /* The app remains usable if theme preference storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  byId("theme-toggle").textContent = theme === "dark" ? "ライトモード" : "ダークモード";
}

function initializeDeviceSettings() {
  try {
    const selected = localStorage.getItem("jva-device-preset") || "auto";
    byId("device-preset").value = ["auto", "phone", "tablet", "desktop"].includes(selected) ? selected : "auto";
    applyDevicePreset(byId("device-preset").value);
    const collapsed = localStorage.getItem("jva-sidebar-collapsed") === "true";
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    byId("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  } catch {
    applyDevicePreset("auto");
  }
}

function navigateTo(page, updateAddress = true) {
  const validPages = new Set(["home", "manual", "setup", "members", "rotation", "staff", "confirm", "match", "tournaments", "courts", "audit", "data-management", "season", "referee-training", "events", "video-sync", "scoresheet", "sets", "result", "verify", "output", "quality-assurance"]);
  let selected = validPages.has(page) ? page : "home";
  if (selected === "quality-assurance" && !developerModeEnabled) {
    showError("品質保証機能は開発者モードでのみ利用できます。URLに ?developer=1 を指定してください。");
    selected = "home";
  }
  if (selected === "match" && !matchHasStarted()) {
    showError("試合画面へ進む前にローテーション設定と開始確認を完了し、「試合を開始する」を押してください。");
    selected = "confirm";
  }
  if (selected === "output") {
    const missing = getMissingScoreSheetRequirements();
    if (missing.length > 0) {
      showError(`記録票PDFを表示するには以下の項目が必要です: ${missing.join("、")}`);
      selected = "verify";
    }
  }
  if (selected === "confirm") {
    const missing = getMissingStartRequirements();
    if (missing.length > 0) {
      showError(`開始確認の未入力項目: ${missing.join("、")}`);
    }
  }
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    const active = panel.dataset.pagePanel === selected;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-item[data-page]").forEach((button) => {
    const active = button.dataset.page === selected
      && (!button.dataset.qaPreset || button.dataset.qaPreset === byId("qa-suite-select").value);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (isCompactViewport()) document.body.classList.remove("sidebar-open");
  byId("sidebar-toggle").setAttribute("aria-expanded", String(!isCompactViewport() && !document.body.classList.contains("sidebar-collapsed")));
  if (updateAddress && location.hash !== `#${selected}`) history.pushState(null, "", `#${selected}`);
  const activeNavigation = document.querySelector(`.nav-item[data-page="${selected}"].active`);
  if (activeNavigation) document.title = `${activeNavigation.textContent.trim()} | JVA Volleyball Official Electronic Score Sheet`;
  if (selected === "match") {
    render();
    renderMedicalEntryOptions();
  }
  else if (selected === "rotation") renderRotation();
  else renderVisibleSupplementalViews();
  if (selected === "confirm" || selected === "scoresheet" || selected === "sets" || selected === "result" || selected === "verify" || selected === "output") {
    renderPageSummaries();
  }
  if (selected === "audit") renderAuditLog();
  if (selected === "quality-assurance") renderQualityReport();
}

async function initialize() {
  try {
    initializeDeveloperMode();
    try {
      store = await readStore();
    } catch (error) {
      // Keep the UI available for backup import instead of overwriting unreadable local data.
      storageRecoveryRequired = true;
      store = { version: 1, matches: [], teamProfiles: [], tournaments: [], auditLog: [], plugins: [] };
      showError(error.message);
    }
    currentMatch = store.matches[0] ? structuredClone(store.matches[0]) : createEmptyMatch();
    if (!store.matches.length) {
      store.matches = [currentMatch];
      if (!storageRecoveryRequired) await writeStore(store);
    }
    placeLiveEventEntry();
    renderHistory();
    render();
    bindEvents();
    matchTimerInterval = window.setInterval(renderMatchTimer, 1000);
    initializeTheme();
    initializeDeviceSettings();
    navigateTo(location.hash.slice(1) || "home", false);
    setSaveStatus(storageRecoveryRequired ? "保存データの復旧が必要" : "自動保存有効");
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.error("Service Worker registration failed:", error);
        setSaveStatus("オフライン設定に失敗");
      });
    }
  } catch (error) {
    console.error("App initialization failed:", error);
    showError(error.message || "アプリの初期化に失敗しました。");
    elements.teamCards.forEach((card) => { card.textContent = "保存データの読み込みに失敗しました。データを確認してください。"; });
    setSaveStatus("初期化エラー");
  }
}

initialize();
