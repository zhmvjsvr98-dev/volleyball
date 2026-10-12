import { renderTeamCard, makeEventRow } from "./components.js";
import {
  canScore, getCurrentLineup, getEventDescription, getScore, getSetResult, getSetTarget, getSetWins, getServingState, isMatchComplete,
} from "./score.js";
import { buildStore, createEmptyMatch, createId, readStore, validateImport, writeStore } from "./storage.js";

const byId = (id) => document.getElementById(id);
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
  announcer: byId("live-announcer"),
  scoreDialog: byId("score-detail-dialog"),
};
const infoFields = {
  tournamentName: "tournament-name",
  matchDate: "match-date",
  venue: "venue",
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
  rosterLimit: "roster-limit",
  courtChangeInterval: "court-change-interval",
  warmupMinutes: "warmup-minutes",
  note: "rules-note",
};
const setTargetFields = [1, 2, 3, 4, 5].map((number) => `set-target-${number}`);
const officialRoles = [
  ["firstReferee", "ファーストレフェリー"],
  ["secondReferee", "セカンドレフェリー"],
  ["scorer", "スコアラー"],
  ["assistantScorer", "アシスタントスコアラー"],
  ["lineJudge1", "ラインジャッジ1"],
  ["lineJudge2", "ラインジャッジ2"],
  ["lineJudge3", "ラインジャッジ3"],
  ["lineJudge4", "ラインジャッジ4"],
];
let pendingScoreTeamId;

let store;
let currentMatch;
let saveTimer;
let dirty = false;
let storageRecoveryRequired = false;

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
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

function updateBestOf(selectedBestOf) {
  const previousBestOf = currentMatch.rules.bestOf;
  if (selectedBestOf > previousBestOf) {
    for (let setNumber = previousBestOf; setNumber < selectedBestOf; setNumber += 1) {
      byId(setTargetFields[setNumber - 1]).value = String(currentMatch.rules.regularTarget);
    }
  }
  byId(setTargetFields[selectedBestOf - 1]).value = String(currentMatch.rules.finalTarget);
  currentMatch.rules.bestOf = selectedBestOf;
}

function getTeam(teamId) {
  return currentMatch.teams.find((team) => team.id === teamId);
}

function persistNow() {
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
  store = buildStore(store.matches);
  try {
    writeStore(store);
    dirty = false;
    clearError();
    setSaveStatus(`保存済み ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
    renderHistory();
  } catch (error) {
    dirty = true;
    setSaveStatus("保存エラー");
    showError(error.message);
  }
}

function scheduleSave(immediate = false) {
  dirty = true;
  setSaveStatus("保存中…");
  clearTimeout(saveTimer);
  if (immediate) persistNow();
  else saveTimer = setTimeout(persistNow, 250);
}

function updateFromForm() {
  for (const [key, id] of Object.entries(infoFields)) {
    currentMatch.matchInfo[key] = byId(id).value.trim().slice(0, key === "tournamentName" || key === "venue" ? 80 : 60);
  }
  for (const [key, id] of Object.entries(ruleFields)) {
    if (key === "bestOf") continue;
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
  currentMatch.rules.rotationEnabled = byId("rotation-enabled").checked;
  currentMatch.rules.setTargets = setTargetFields.map((id) => Number(byId(id).value));
  const invalidTarget = currentMatch.rules.setTargets.findIndex((target) => !Number.isInteger(target) || target < 1 || target > 99);
  if (invalidTarget >= 0) {
    showError(`第${invalidTarget + 1}セットの目標点を1〜99の整数で入力してください。`);
    return;
  }
  currentMatch.rules.regularTarget = currentMatch.rules.setTargets[0];
  currentMatch.rules.finalTarget = currentMatch.rules.setTargets[currentMatch.rules.bestOf - 1];
  if (currentMatch.rules.matchProfile === "nine" && currentMatch.rules.bestOf !== 3) {
    currentMatch.rules.bestOf = 3;
    byId("best-of").value = "3";
    showError("添付された9人制記録票に合わせ、試合形式を3セットマッチにしました。大会要項をご確認ください。");
  } else {
    clearError();
  }
  renderPageSummaries();
  scheduleSave();
}

function populateForm() {
  for (const [key, id] of Object.entries(infoFields)) byId(id).value = currentMatch.matchInfo[key];
  for (const [key, id] of Object.entries(ruleFields)) byId(id).value = String(currentMatch.rules[key]);
  byId("rotation-enabled").checked = currentMatch.rules.rotationEnabled;
  setTargetFields.forEach((id, index) => {
    byId(id).value = String(currentMatch.rules.setTargets[index] ?? (index === currentMatch.rules.bestOf - 1 ? currentMatch.rules.finalTarget : currentMatch.rules.regularTarget));
    byId(id).disabled = index >= currentMatch.rules.bestOf;
  });
  officialRoles.forEach(([role]) => {
    byId(`official-name-${role}`).value = currentMatch.matchInfo.officials[role].name;
    byId(`official-area-${role}`).value = currentMatch.matchInfo.officials[role].area;
  });
  const hasEvents = currentMatch.sets.some((set) => set.events.length > 0);
  Object.values(ruleFields).forEach((id) => { byId(id).disabled = hasEvents; });
  byId("rotation-enabled").disabled = hasEvents;
  byId("team-name-setup-a").value = currentMatch.teams[0].name;
  byId("team-name-setup-b").value = currentMatch.teams[1].name;
}

function renderHistory() {
  const selectedId = currentMatch?.id;
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

function renderTeams() {
  const rosterLocked = currentMatch.sets.some((set) => set.events.length > 0);
  currentMatch.teams.forEach((team, index) => renderTeamCard(elements.teamCards[index], team, index, currentMatch.rules.rosterLimit, rosterLocked));
  for (const id of ["sub-team", "sanction-team"]) {
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
}

function renderScoreboard() {
  const set = currentSet();
  const [teamA, teamB] = currentMatch.teams;
  const scoreA = getScore(set, teamA.id);
  const scoreB = getScore(set, teamB.id);
  const result = getSetResult(currentMatch, set);
  const target = getSetTarget(currentMatch, set.number);
  elements.scoreboard.replaceChildren();

  const teamScore = (team, score) => {
    const card = document.createElement("div");
    card.className = "score-team";
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
    card.append(name, number, controls);
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
  elements.scoreboard.append(teamScore(teamA, scoreA), middle, teamScore(teamB, scoreB));

  const setWins = getSetWins(currentMatch);
  const winsNeeded = Math.floor(currentMatch.rules.bestOf / 2) + 1;
  const winner = setWins.find((entry) => entry.wins >= winsNeeded);
  elements.state.textContent = winner
    ? `試合終了：${getTeam(winner.teamId).name} 勝利`
    : result ? `第${set.number}セット終了` : "試合中";
  elements.nextSet.hidden = !result || Boolean(winner) || currentMatch.sets.length >= currentMatch.rules.bestOf;
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
  elements.eventLog.replaceChildren();
  elements.emptyLog.hidden = events.length > 0;
  for (const event of [...events].reverse()) {
    const time = new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const description = getEventDescription(currentMatch, event);
    elements.eventLog.append(makeEventRow(time, description));
  }
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

function renderCourtChange() {
  const interval = currentMatch.rules.courtChangeInterval;
  const set = currentSet();
  const total = currentMatch.teams.reduce((sum, team) => sum + getScore(set, team.id), 0);
  const lastRecorded = set.events.filter((event) => event.type === "court-change")
    .reduce((last, event) => Math.max(last, event.totalPoints), 0);
  const nextAt = interval > 0 ? Math.floor(lastRecorded / interval) * interval + interval : 0;
  const due = interval > 0 && total >= nextAt;
  byId("court-change-status").textContent = interval > 0
    ? due ? `コートチェンジ: 合計 ${nextAt} 点に到達` : `コートチェンジ: 合計 ${nextAt} 点で記録`
    : "コートチェンジ: 設定なし";
  byId("court-change-status").classList.toggle("is-due", due);
  byId("record-court-change").hidden = !due;
  byId("record-court-change").disabled = !canScore(currentMatch);
}

function renderRotation() {
  const set = currentSet();
  const serveSelect = byId("initial-server");
  serveSelect.replaceChildren();
  currentMatch.teams.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    serveSelect.append(option);
  });
  serveSelect.value = set.initialServiceTeamId || currentMatch.teams[0].id;
  serveSelect.disabled = set.events.length > 0;
  const { server, rotations } = getServingState(currentMatch, set);
  const servingTeam = getTeam(server);
  const servingLineup = getCurrentLineup(currentMatch, set, server);
  const serverPlayer = servingTeam?.players.find((player) => player.id === servingLineup.at(-1));
  byId("server-indicator").textContent = `サーバー: ${servingTeam?.name || "未設定"}${serverPlayer ? ` #${serverPlayer.number} ${serverPlayer.name}` : ""}`;
  byId("rotation-team-a-name").textContent = `${currentMatch.teams[0].name} ローテーション (${rotations[currentMatch.teams[0].id] || 0}回転)`;
  byId("rotation-team-b-name").textContent = `${currentMatch.teams[1].name} ローテーション (${rotations[currentMatch.teams[1].id] || 0}回転)`;
  const count = currentMatch.rules.matchProfile === "nine" ? 9 : 6;
  currentMatch.teams.forEach((team, teamIndex) => {
    const container = byId(teamIndex === 0 ? "rotation-team-a" : "rotation-team-b");
    container.replaceChildren();
    const lineup = getCurrentLineup(currentMatch, set, team.id);
    const turns = (rotations[team.id] || 0) % count;
    lineup.forEach((playerId, positionIndex) => {
      const slot = document.createElement("label");
      slot.className = `rotation-slot${server === team.id && positionIndex === count - 1 ? " server" : ""}`;
      const position = document.createElement("strong");
      position.textContent = currentMatch.rules.matchProfile === "nine" ? `位置 ${["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ"][positionIndex]}` : `位置 ${positionIndex + 1}`;
      const selected = team.players.find((player) => player.id === playerId);
      const person = document.createElement("span");
      person.textContent = selected ? `#${selected.number} ${selected.name}` : "未設定";
      const select = document.createElement("select");
      select.dataset.rotationTeam = team.id;
      select.dataset.currentPosition = String(positionIndex);
      select.setAttribute("aria-label", `${team.name} ${position.textContent}の選手`);
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "選手を割当";
      select.append(empty);
      team.players.forEach((player) => {
        const option = document.createElement("option");
        option.value = player.id;
        option.textContent = `#${player.number} ${player.name}`;
        select.append(option);
      });
      select.value = playerId;
      slot.append(position, person, select);
      container.append(slot);
    });
  });
  document.querySelector(".rotation-panels").hidden = !currentMatch.rules.rotationEnabled;
  document.querySelector(".rotation-controls").hidden = !currentMatch.rules.rotationEnabled;
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

function showScoreDialog(teamId) {
  if (!canScore(currentMatch)) return;
  pendingScoreTeamId = teamId;
  const team = getTeam(teamId);
  const opponent = currentMatch.teams.find((item) => item.id !== teamId);
  byId("scoring-team-label").textContent = `得点チーム: ${team.name}`;
  fillPlayerSelect(byId("score-player"), team.players);
  fillPlayerSelect(byId("fault-player"), opponent.players);
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
  if (["serve", "attack", "block"].includes(playType) && team.players.length && !playerId) {
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

function render() {
  if (!currentMatch) return;
  populateForm();
  const hasEvents = currentMatch.sets.some((set) => set.events.length > 0);
  Object.values(ruleFields).forEach((id) => { byId(id).disabled = hasEvents; });
  renderTeams();
  renderScoreboard();
  renderSetStrip();
  renderEvents();
  renderTimeouts();
  renderCourtChange();
  renderRotation();
  byId("undo-event").disabled = currentSet().events.length === 0;
  renderPageSummaries();
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

function renderPrintableScoreSheet() {
  const root = byId("printable-score-sheet");
  root.replaceChildren();
  const [teamA, teamB] = currentMatch.teams;
  const title = document.createElement("header");
  title.className = "score-sheet-title";
  const heading = document.createElement("h1");
  heading.textContent = "バレーボール公式記録票";
  const format = document.createElement("p");
  format.textContent = `${currentMatch.rules.matchProfile === "nine" ? "9人制" : "6人制"}・${currentMatch.rules.bestOf}セットマッチ / ${currentMatch.rules.category} ${currentMatch.rules.division}`;
  const tournament = document.createElement("p");
  tournament.textContent = currentMatch.matchInfo.tournamentName || "大会名未入力";
  title.append(heading, format, tournament);
  root.append(title);

  const info = currentMatch.matchInfo;
  const meta = document.createElement("div");
  meta.className = "score-sheet-meta score-sheet-block";
  for (const value of [
    `開催日: ${info.matchDate || "—"}`, `会場: ${info.venue || "—"}`,
    `コート: ${info.court || "—"}`, `試合番号: ${info.matchNumber || "—"}`,
    `ラウンド: ${info.round || "—"}`, `設定時刻: ${info.scheduledTime || "—"}`,
    `試合開始: ${info.startedAt ? new Date(info.startedAt).toLocaleTimeString("ja-JP") : "—"}`,
    `試合終了: ${info.endedAt ? new Date(info.endedAt).toLocaleTimeString("ja-JP") : "—"}`,
    `適用メモ: ${currentMatch.rules.note || "—"}`,
  ]) {
    const cell = document.createElement("span");
    cell.textContent = value;
    meta.append(cell);
  }
  root.append(meta);

  appendPrintSection(root, "試合結果・セット得点", ["セット", teamA.name, teamB.name, "勝者", "開始", "終了"], currentMatch.sets.map((set) => [
    `第${set.number}セット`,
    getScore(set, teamA.id),
    getScore(set, teamB.id),
    getSetResult(currentMatch, set) ? getTeam(getSetResult(currentMatch, set)).name : "進行中",
    set.startedAt ? new Date(set.startedAt).toLocaleTimeString("ja-JP") : "—",
    set.endedAt ? new Date(set.endedAt).toLocaleTimeString("ja-JP") : "—",
  ]));

  appendPrintSection(root, "チーム構成・登録選手", ["チーム", "背番号", "氏名", "役割"], currentMatch.teams.flatMap((team) => team.players.map((player) => [
    team.name, player.number, player.name, player.isCaptain ? "キャプテン" : "選手",
  ])));

  const positionNames = currentMatch.rules.matchProfile === "nine"
    ? ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ"]
    : ["1", "2", "3", "4", "5", "6"];
  appendPrintSection(root, "セット開始時のサービス順・ローテーション", ["セット", "チーム", "位置", "背番号", "氏名"], currentMatch.sets.flatMap((set) =>
    currentMatch.teams.flatMap((team) => positionNames.map((position, index) => {
      const playerId = set.startingLineups[team.id]?.[index];
      const player = team.players.find((item) => item.id === playerId);
      return [`第${set.number}セット`, team.name, position, player?.number || "—", player?.name || "—"];
    }))));

  appendPrintSection(root, "審判員・記録員", ["役割", "氏名", "都道府県 / 国名"], officialRoles.map(([role, label]) => [
    label, info.officials[role].name || "—", info.officials[role].area || "—",
  ]));

  const scoreRows = currentMatch.sets.flatMap((set) => set.events
    .filter((event) => event.type === "score" || event.type === "court-change")
    .map((event) => [
    `第${set.number}セット`,
    new Date(event.time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    getEventDescription(currentMatch, event),
  ]));
  appendPrintSection(root, "得点・コートチェンジ記録", ["セット", "時刻", "記録内容"], scoreRows);
  const nonScoreEvents = currentMatch.sets.flatMap((set) => set.events
    .filter((event) => ["timeout", "substitution", "sanction"].includes(event.type))
    .map((event) => [`第${set.number}セット`, new Date(event.time).toLocaleTimeString("ja-JP"), getEventDescription(currentMatch, event)]));
  appendPrintSection(root, "タイムアウト・選手交代・反則記録", ["セット", "時刻", "記録内容"], nonScoreEvents);

  const footer = document.createElement("footer");
  footer.className = "score-sheet-footer";
  footer.textContent = `タイムアウト上限: ${currentMatch.rules.timeoutLimit}回 / 交代上限: ${currentMatch.rules.substitutionLimit}回 / セット勝利点差: ${currentMatch.rules.winBy}点`;
  root.append(footer);
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
    ["コート・試合番号", [info.court, info.matchNumber].filter(Boolean).join(" / ")],
    ["試合形式", `${currentMatch.rules.matchProfile === "nine" ? "9人制" : "6人制"} / ${currentMatch.rules.bestOf}セット`],
    ["ラウンド", info.round], ["カテゴリー・種別", `${currentMatch.rules.category} / ${currentMatch.rules.division}`],
    ["ファーストレフェリー", info.officials.firstReferee.name],
    ["スコアラー", info.officials.scorer.name],
  ]) appendSummaryRow(confirmation, label, value);
  for (const team of currentMatch.teams) appendSummaryRow(confirmation, team.name, `${team.players.length}名登録`);

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

  const checks = [
    ["大会名", Boolean(info.tournamentName)],
    ["会場", Boolean(info.venue)],
    [`${teamA.name}の選手登録`, teamA.players.length > 0],
    [`${teamB.name}の選手登録`, teamB.players.length > 0],
    ["ファーストレフェリー", Boolean(info.officials.firstReferee.name)],
    ["スコアラー", Boolean(info.officials.scorer.name)],
  ];
  const checklist = byId("verification-list");
  checklist.replaceChildren();
  checks.forEach(([label, done]) => {
    const item = document.createElement("li");
    item.className = done ? "check-complete" : "check-pending";
    const icon = document.createElement("span");
    icon.textContent = done ? "✓" : "!";
    const text = document.createElement("span");
    text.textContent = `${label}: ${done ? "登録済み" : "未入力"}`;
    item.append(icon, text);
    checklist.append(item);
  });
}

function addEvent(event) {
  // 得点・交代などを共通の時系列イベントとして保存するため、取り消しと監査が容易です。
  const now = new Date().toISOString();
  const set = currentSet();
  set.events.push({ id: createId(), time: now, ...event });
  if (event.type === "score") {
    set.startedAt ||= now;
    currentMatch.matchInfo.startedAt ||= now;
    if (getSetResult(currentMatch, set)) set.endedAt = now;
    if (isMatchComplete(currentMatch)) {
      currentMatch.matchInfo.endedAt = now;
    }
  }
  render();
  scheduleSave(true);
  elements.announcer.textContent = getEventDescription(currentMatch, event);
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
  const previousServer = currentSet().initialServiceTeamId;
  const initialServiceTeamId = currentMatch.teams.find((team) => team.id !== previousServer)?.id || currentMatch.teams[0].id;
  const startingLineups = Object.fromEntries(currentMatch.teams.map((team) => [team.id, [...team.rotationLineup]]));
  currentMatch.sets.push({ number: currentMatch.sets.length + 1, initialServiceTeamId, startingLineups, startedAt: "", endedAt: "", events: [] });
  render();
  scheduleSave(true);
}

function undoLastEvent() {
  const set = currentSet();
  if (!set.events.length) return;
  // 派生得点はイベント列から再計算するため、直前イベントを取り除くだけで状態も戻ります。
  const removed = set.events.pop();
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
  const number = form.querySelector('input[type="number"]').value.trim();
  const nameInput = form.querySelector('input[type="text"]');
  const name = nameInput.value.trim();
  const captain = form.querySelector('input[type="checkbox"]').checked;
  if (!name || !/^\d{1,3}$/.test(number)) {
    showError("選手の背番号（1〜3桁）と氏名を入力してください。");
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
  team.players.push({ id: createId(), number, name: name.slice(0, 60), isCaptain: captain });
  if (captain) team.players.filter((player) => player.id !== team.players.at(-1).id).forEach((player) => { player.isCaptain = false; });
  clearError();
  render();
  scheduleSave(true);
}

function createNewMatch() {
  if (storageRecoveryRequired) {
    store.matches = [];
    dirty = false;
  } else if (dirty) {
    persistNow();
  }
  storageRecoveryRequired = false;
  currentMatch = createEmptyMatch();
  render();
  scheduleSave(true);
}

function loadMatch(matchId) {
  if (dirty) persistNow();
  const match = store.matches.find((item) => item.id === matchId);
  if (!match) return;
  currentMatch = structuredClone(match);
  clearError();
  render();
  setSaveStatus("保存済みデータを表示中");
  renderHistory();
}

function downloadJson(match) {
  const blob = new Blob([JSON.stringify(match, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `jva-score-${match.matchInfo.matchDate || "match"}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importMatchFile(file) {
  if (file.size > 2_000_000) throw new Error("ファイルが大きすぎます（上限2MB）。");
  return file.text().then((text) => {
    let imported;
    try { imported = JSON.parse(text); } catch { throw new Error("JSONファイルを解析できません。"); }
    const validatedMatch = validateImport(imported);
    if (!validatedMatch) throw new Error("試合データの形式または入力値が正しくありません。読み込みを中止しました。");
    const duplicate = store.matches.some((match) => match.id === validatedMatch.id);
    if (duplicate && !confirm("同じIDの試合データがすでにあります。読み込んだデータで置き換えますか？")) return;
    store.matches = [validatedMatch, ...store.matches.filter((match) => match.id !== validatedMatch.id)];
    store = buildStore(store.matches);
    currentMatch = structuredClone(validatedMatch);
    storageRecoveryRequired = false;
    render();
    scheduleSave(true);
  });
}

function bindEvents() {
  [...Object.values(infoFields), ...Object.values(ruleFields)].filter((id) => id !== "best-of").forEach((id) => {
    const input = byId(id);
    input.addEventListener("change", updateFromForm);
    if (input.tagName === "INPUT" && input.type !== "date") input.addEventListener("input", updateFromForm);
  });
  setTargetFields.forEach((id) => {
    byId(id).addEventListener("change", updateFromForm);
    byId(id).addEventListener("input", updateFromForm);
  });
  byId("rotation-enabled").addEventListener("change", updateFromForm);

  byId("match-profile").addEventListener("change", () => {
    const ninePlayer = byId("match-profile").value === "nine";
    if (ninePlayer) {
      byId("best-of").value = "3";
      byId("roster-limit").value = "42";
      updateBestOf(3);
    } else {
      byId("roster-limit").value = "30";
    }
    updateFromForm();
    render();
  });

  byId("best-of").addEventListener("change", () => {
    const selectedBestOf = Number(byId("best-of").value);
    updateBestOf(selectedBestOf);
    updateFromForm();
    render();
  });

  officialRoles.forEach(([role]) => {
    for (const [part, field] of [["name", "name"], ["area", "area"]]) {
      const input = byId(`official-${part}-${role}`);
      const updateOfficial = () => {
        currentMatch.matchInfo.officials[role][field] = input.value.trim().slice(0, part === "name" ? 60 : 40);
        if (role === "firstReferee") currentMatch.matchInfo.referee1 = currentMatch.matchInfo.officials[role].name;
        if (role === "secondReferee") currentMatch.matchInfo.referee2 = currentMatch.matchInfo.officials[role].name;
        if (role === "scorer") currentMatch.matchInfo.scorer = currentMatch.matchInfo.officials[role].name;
        renderPageSummaries();
        scheduleSave();
      };
      input.addEventListener("input", updateOfficial);
      input.addEventListener("change", updateOfficial);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
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
      team.players = team.players.filter((player) => player.id !== removeButton.dataset.removePlayer);
      render();
      scheduleSave(true);
    }
  });

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
    if (navigation) navigateTo(navigation.dataset.page);
    if (target.closest("[data-print]")) window.print();
  });
  window.addEventListener("hashchange", () => navigateTo(location.hash.slice(1), false));

  for (const [id, index] of [["team-name-setup-a", 0], ["team-name-setup-b", 1]]) {
    byId(id).addEventListener("input", (event) => {
      currentMatch.teams[index].name = event.target.value.slice(0, 60);
      renderTeams();
      renderScoreboard();
      renderTimeouts();
      renderPageSummaries();
      scheduleSave();
    });
  }

  for (const card of elements.teamCards) {
    card.addEventListener("change", (event) => {
      const input = event.target.closest("[data-team-name]");
      if (!input) return;
      const team = getTeam(input.dataset.teamName);
      team.name = input.value.trim().slice(0, 60) || "チーム";
      input.value = team.name;
      byId(team === currentMatch.teams[0] ? "team-name-setup-a" : "team-name-setup-b").value = team.name;
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
    store.matches = store.matches.filter((match) => match.id !== currentMatch.id);
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
  byId("print-match").addEventListener("click", () => window.print());
  byId("export-match").addEventListener("click", () => downloadJson(currentMatch));
  byId("import-match").addEventListener("click", () => byId("import-file").click());
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
    if (!/^\d{1,3}$/.test(playerOut) || !/^\d{1,3}$/.test(playerIn)
      || !team.players.some((player) => player.number === playerOut)
      || !team.players.some((player) => player.number === playerIn)) {
      showError("交代する選手の背番号を登録済み選手から指定してください。");
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
  byId("record-sanction").addEventListener("click", () => {
    if (!canScore(currentMatch)) return;
    const player = byId("sanction-player").value.trim();
    if (!player) return showError("処置対象者を入力してください。");
    addEvent({ type: "sanction", teamId: byId("sanction-team").value, player: player.slice(0, 20), sanctionType: byId("sanction-type").value });
    byId("sanction-player").value = "";
  });
  byId("record-court-change").addEventListener("click", () => {
    const total = currentMatch.teams.reduce((sum, team) => sum + getScore(currentSet(), team.id), 0);
    const teamId = currentMatch.teams[0].id;
    addEvent({ type: "court-change", teamId, totalPoints: total });
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
  byId("initial-server").addEventListener("change", () => {
    if (currentSet().events.length) return;
    currentSet().initialServiceTeamId = byId("initial-server").value;
    renderRotation();
    scheduleSave(true);
  });
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches("[data-rotation-team]")) return;
    const team = getTeam(select.dataset.rotationTeam);
    const count = currentMatch.rules.matchProfile === "nine" ? 9 : 6;
    const position = Number(select.dataset.currentPosition);
    const { rotations } = getServingState(currentMatch, currentSet());
    const openingPosition = (position + (rotations[team.id] || 0)) % count;
    while (team.rotationLineup.length < count) team.rotationLineup.push("");
    const previous = team.rotationLineup[openingPosition];
    if (select.value && team.rotationLineup.some((playerId, index) => index !== openingPosition && playerId === select.value)) {
      showError("同じ選手を複数のローテーション位置に登録できません。");
      select.value = previous;
      return;
    }
    team.rotationLineup[openingPosition] = select.value;
    currentSet().startingLineups[team.id] = [...team.rotationLineup];
    clearError();
    renderRotation();
    renderPageSummaries();
    scheduleSave(true);
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
  byId("sidebar-toggle").setAttribute("aria-expanded", "false");
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
  const validPages = new Set(["home", "setup", "members", "staff", "confirm", "match", "events", "scoresheet", "sets", "result", "verify", "output"]);
  const selected = validPages.has(page) ? page : "home";
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    const active = panel.dataset.pagePanel === selected;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-item[data-page]").forEach((button) => {
    const active = button.dataset.page === selected;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (isCompactViewport()) document.body.classList.remove("sidebar-open");
  byId("sidebar-toggle").setAttribute("aria-expanded", String(!isCompactViewport() && !document.body.classList.contains("sidebar-collapsed")));
  if (updateAddress && location.hash !== `#${selected}`) history.pushState(null, "", `#${selected}`);
  const activeNavigation = document.querySelector(`.nav-item[data-page="${selected}"]`);
  if (activeNavigation) document.title = `${activeNavigation.textContent.trim()} | JVA Volleyball Official Electronic Score Sheet`;
  if (selected === "confirm" || selected === "scoresheet" || selected === "sets" || selected === "result" || selected === "verify") {
    renderPageSummaries();
  }
}

function initialize() {
  try {
    try {
      store = readStore();
    } catch (error) {
      // Keep the UI available for backup import instead of overwriting unreadable local data.
      storageRecoveryRequired = true;
      store = { version: 1, matches: [] };
      showError(error.message);
    }
    currentMatch = store.matches[0] ? structuredClone(store.matches[0]) : createEmptyMatch();
    if (!store.matches.length) {
      store.matches = [currentMatch];
      if (!storageRecoveryRequired) writeStore(store);
    }
    renderHistory();
    render();
    bindEvents();
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
    showError(error.message || "アプリの初期化に失敗しました。");
    elements.teamCards.forEach((card) => { card.textContent = "保存データの読み込みに失敗しました。データを確認してください。"; });
    setSaveStatus("初期化エラー");
  }
}

initialize();
