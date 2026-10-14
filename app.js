import { renderTeamCard, makeEventRow } from "./components.js";
import {
  canScore, getCourtPlayerCount, getCurrentLineup, getDecidingSetCourtChangePoint, getEventDescription, getScore, getSetResult, getSetTarget, getSetWins, getServingState, isMatchComplete, usesCourtRotation,
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
  timer: byId("match-timer"),
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
const rallyKinds = ["serve", "reception", "set", "attack", "backAttack", "block", "error", "other"];
const rallyOutcomes = ["success", "point", "error", "touch", "effective", "excellent", "good", "other"];
let pendingScoreTeamId;

let store;
let currentMatch;
let saveTimer;
let dirty = false;
let storageRecoveryRequired = false;
let matchTimerInterval;

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}
for (const [id, teamIndex] of [["team-color-setup-a", 0], ["team-color-setup-b", 1]]) {
  byId(id).addEventListener("input", (event) => updateTeamColor(currentMatch.teams[teamIndex].id, event.target.value));
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

function matchHasStarted() {
  return Boolean(currentMatch.matchInfo.startedAt)
    || currentMatch.sets.some((set) => set.events.length > 0);
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

function getTeamDisplayColor(team) {
  return team?.uniformColor || "#1d4ed8";
}

function applyTeamColors() {
  currentMatch.teams.forEach((team, index) => {
    const preferredColor = getTeamDisplayColor(team);
    const color = /^#[\da-f]{6}$/i.test(preferredColor) ? preferredColor : (index === 0 ? "#1d4ed8" : "#f97316");
    const className = index === 0 ? "team-a" : "team-b";
    document.querySelectorAll(`.${className}`).forEach((element) => {
      element.style.setProperty("--team-accent", color);
    });
  });
}

function updateTeamColor(teamId, color) {
  const team = getTeam(teamId);
  if (!team || !/^#[\da-f]{6}$/i.test(color)) {
    showError("ユニフォーム色を正しく選択してください。");
    return;
  }
  team.uniformColor = color;
  const teamIndex = currentMatch.teams.indexOf(team);
  const setupColor = byId(teamIndex === 0 ? "team-color-setup-a" : "team-color-setup-b");
  if (setupColor) setupColor.value = color;
  document.querySelectorAll("input[data-team-color]").forEach((input) => {
    if (input.dataset.teamColor === teamId) input.value = color;
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
  store = buildStore(store.matches, store.teamProfiles);
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
  currentMatch.rules.rotationEnabled = currentMatch.rules.matchProfile === "six"
    && currentMatch.rules.category !== "小学生"
    && byId("rotation-enabled").checked;
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
  byId("rotation-enabled").checked = usesCourtRotation(currentMatch);
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
  byId("team-color-setup-a").disabled = locked;
  byId("team-color-setup-b").disabled = locked;
  byId("rotation-enabled").disabled = locked || currentMatch.rules.matchProfile === "nine" || currentMatch.rules.category === "小学生";
  byId("team-name-setup-a").value = currentMatch.teams[0].name;
  byId("team-name-setup-b").value = currentMatch.teams[1].name;
  byId("team-color-setup-a").value = currentMatch.teams[0].uniformColor || "#1d4ed8";
  byId("team-color-setup-b").value = currentMatch.teams[1].uniformColor || "#f97316";
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
      option.textContent = `${profile.name} — ${new Date(profile.savedAt).toLocaleString("ja-JP")} (${profile.players.length}名)`;
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
  const name = team.name.trim();
  if (!name || !team.players.length) {
    return showError("チーム名と選手を登録してから履歴に保存してください。");
  }
  store.teamProfiles.unshift({
    id: createId(),
    name,
    savedAt: new Date().toISOString(),
    players: structuredClone(team.players),
    rotationLineup: [...team.rotationLineup],
    uniformColor: team.uniformColor || "#1d4ed8",
    staff: { ...team.staff },
  });
  store = buildStore(store.matches, store.teamProfiles);
  scheduleSave(true);
  renderTeamProfiles();
  clearError();
}

function deleteTeamProfile(teamIndex) {
  const selectId = teamIndex === 0 ? "team-history-a" : "team-history-b";
  const profileId = byId(selectId).value;
  if (!profileId) return;
  store.teamProfiles = store.teamProfiles.filter((profile) => profile.id !== profileId);
  store = buildStore(store.matches, store.teamProfiles);
  scheduleSave(true);
  renderTeamProfiles();
  clearError();
}

function clearTeamHistory() {
  if (!store.teamProfiles.length) return;
  if (!confirm("保存されているチーム履歴をすべて削除しますか？この操作は取り消せません。")) return;
  store.teamProfiles = [];
  store = buildStore(store.matches, store.teamProfiles);
  scheduleSave(true);
  renderTeamProfiles();
  clearError();
}

function clearMatchHistory() {
  if (!store.matches.length) return;
  if (!confirm("保存されている試合履歴をすべて削除しますか？この操作は取り消せません。")) return;
  store.matches = [];
  currentMatch = createEmptyMatch();
  store = buildStore(store.matches, store.teamProfiles);
  scheduleSave(true);
  renderHistory();
  render();
  clearError();
}

function loadTeamProfile(teamIndex) {
  if (matchHasStarted()) return showError("試合開始後はチーム履歴を読み込めません。");
  const selectedProfileId = byId(teamIndex === 0 ? "team-history-a" : "team-history-b").value;
  const profile = store.teamProfiles.find((item) => item.id === selectedProfileId);
  if (!profile) return showError("読み込むチーム履歴を選択してください。");
  const team = currentMatch.teams[teamIndex];
  const ids = new Map();
  team.players = profile.players.map((player) => {
    const id = createId();
    ids.set(player.id, id);
    return { ...player, id, isLibero: Boolean(player.isLibero) };
  });
  team.name = profile.name;
  team.uniformColor = profile.uniformColor || "#1d4ed8";
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
    renderTeamCard(elements.teamCards[index], team, index, currentMatch.rules.rosterLimit, rosterLocked);
    elements.teamCards[index].classList.add(index === 0 ? "team-a" : "team-b");
  });
  for (const id of ["sub-team", "libero-team", "sanction-team", "rally-team", "challenge-team"]) {
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
}

function renderScoreboard() {
  const set = currentSet();
  const [teamA, teamB] = currentMatch.teams;
  const scoreA = getScore(set, teamA.id);
  const scoreB = getScore(set, teamB.id);
  const result = getSetResult(currentMatch, set);
  const target = getSetTarget(currentMatch, set.number);
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
  elements.scoreboard.append(teamScore(teamA, scoreA, 0), middle, teamScore(teamB, scoreB, 1));

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
  const target = getDecidingSetCourtChangePoint(currentMatch, set.number);
  const reached = set.events.some((event) => event.type === "court-change" && event.reason === "points");
  const maximum = Math.max(...currentMatch.teams.map((team) => getScore(set, team.id)));
  const youthStoDue = currentMatch.rules.category === "小学生"
    && currentMatch.rules.bestOf === 3
    && set.number === 3
    && !set.events.some((event) => event.type === "sto");
  const youthStoReached = youthStoDue && maximum >= 11;
  const courtChangeDue = target > 0 && !reached && maximum >= target;
  let status = "コートチェンジは決定セットの規定点で自動記録します。";
  if (set.endedAt) status = "セット終了後のコートチェンジを記録しました。";
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
  const makeSlot = (team, playerId, positionIndex, isServer, side, serviceOrder = false) => {
    const slot = document.createElement(editable ? "label" : "div");
    slot.className = `rotation-slot${isServer ? " server" : ""}${serviceOrder ? " service-order-slot" : ""}`;
    slot.dataset.position = String(positionIndex);
    const position = document.createElement("strong");
    position.textContent = serviceOrder ? `サーブ順 ${positionLabels[positionIndex]}` : `位置 ${positionLabels[positionIndex]}`;
    const selected = team.players.find((player) => player.id === playerId);
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
      team.players.forEach((player) => {
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
        const cell = makeSlot(team, lineup[positionIndex] || "", positionIndex,
          servingState.server === team.id && positionIndex === 0, home ? "home" : "away");
        grid.append(cell);
      });
      section.append(grid);
    } else {
      const order = document.createElement("ol");
      order.className = "service-order-list";
      lineup.forEach((playerId, positionIndex) => {
        order.append(makeSlot(team, playerId, positionIndex,
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
  const firstSet = currentMatch.sets[0];
  const prestartSelect = byId("prestart-initial-server");
  populateServingSelect(prestartSelect, firstSet, !matchHasStarted());
  const prestartState = renderRotationView("prestart-rotation-layout", firstSet, !matchHasStarted());
  const startServer = getTeam(prestartState.server);
  const startLineup = getCurrentLineup(currentMatch, firstSet, prestartState.server);
  const startSlot = usesCourtRotation(currentMatch) ? 0 : Math.max(0, prestartState.serviceTurns[prestartState.server] - 1) % startLineup.length;
  const startPlayer = startServer?.players.find((player) => player.id === startLineup[startSlot]);
  byId("prestart-server-indicator").textContent = `第1サーバー: ${startServer?.name || "未設定"}${startPlayer ? ` #${startPlayer.number} ${startPlayer.name}` : ""}`;

  const liveSet = currentSet();
  populateServingSelect(byId("initial-server"), liveSet, !matchHasStarted() && liveSet.events.length === 0);
  const liveState = renderRotationView("match-rotation-layout", liveSet, false);
  const servingTeam = getTeam(liveState.server);
  const liveLineup = getCurrentLineup(currentMatch, liveSet, liveState.server);
  const liveSlot = usesCourtRotation(currentMatch) ? 0 : Math.max(0, liveState.serviceTurns[liveState.server] - 1) % liveLineup.length;
  const serverPlayer = servingTeam?.players.find((player) => player.id === liveLineup[liveSlot]);
  byId("server-indicator").textContent = `サーバー: ${servingTeam?.name || "未設定"}${serverPlayer ? ` #${serverPlayer.number} ${serverPlayer.name}` : ""}`;

  byId("rotation-mode-note").textContent = usesCourtRotation(currentMatch)
    ? "選手を各位置に割り当ててください。ネットが画面中央にあり、チームAは左側、チームBは右側です。第1サーバーは位置1です。"
    : "この競技形式ではコート上のローテーションは行わず、登録したサーブ順を表示します。順番に選手を割り当ててください。";
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
  const practicalKind = byId("rally-kind")?.value || byId("rally-kind-group")?.querySelector(".mini-select-button.selected")?.dataset.value || "serve";
  const practicalOutcome = byId("rally-outcome")?.value || byId("rally-outcome-group")?.querySelector(".mini-select-button.selected")?.dataset.value || "success";
  const team = getTeam(byId("rally-team").value);
  const playerId = byId("rally-player").value || null;
  const playKind = practicalKind;
  const outcome = practicalOutcome;
  if (!team || (playerId && !getCourtPlayers(team.id).some((player) => player.id === playerId))) {
    showError("プレーをしたコート内の選手を選択してください。");
    return;
  }
  if (!rallyKinds.includes(playKind) || !rallyOutcomes.includes(outcome)) {
    showError("ラリーの動作と結果を選択してください。");
    return;
  }
  addEvent({
    type: "rally-play",
    teamId: team.id,
    playerId,
    playKind,
    outcome,
    note: byId("rally-note").value.trim().slice(0, 120),
  });
  byId("rally-note").value = "";
  clearError();
}

function render() {
  if (!currentMatch) return;
  populateForm();
  const locked = matchHasStarted();
  Object.values(ruleFields).forEach((id) => { byId(id).disabled = locked; });
  renderTeams();
  renderScoreboard();
  renderSetStrip();
  renderEvents();
  renderTimeouts();
  renderChallenges();
  renderCourtChange();
  renderMatchTimer();
  renderRotation();
  applyTeamColors();
  byId("undo-event").disabled = currentSet().events.length === 0;
  renderPageSummaries();
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
    attack: { attempts: 0, points: 0, errors: 0 },
    backAttack: { attempts: 0, points: 0, errors: 0 },
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
  if (outcome === "effective" && "effective" in category) category.effective += 1;
  if (outcome === "excellent" && "excellent" in category) category.excellent += 1;
  if (outcome === "good" && "good" in category) category.good += 1;
  if (outcome === "other" && "other" in category) category.other += 1;
}

function getPlayerSetAppearances(team) {
  const playerSetsPlayed = new Map(team.players.map((player) => [player.id, 0]));
  let teamSetsPlayed = 0;

  for (const set of currentMatch.sets) {
    if (!set.startedAt && set.events.length === 0) continue;
    teamSetsPlayed += 1;

    const appearedPlayers = new Set(set.startingLineups?.[team.id] || []);
    for (const event of set.events) {
      if (event.teamId !== team.id) continue;
      if (["score", "play"].includes(event.type) && event.playerId) {
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

function getPerformanceStats(team) {
  const total = emptyPlayStats();
  const players = new Map(team.players.map((player) => [player.id, emptyPlayStats()]));
  const { teamSetsPlayed, playerSetsPlayed } = getPlayerSetAppearances(team);
  for (const set of currentMatch.sets) {
    const correctedScores = new Set(set.events
      .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
      .map((event) => event.correctionOf));
    for (const event of set.events) {
      let playKind;
      let outcome;
      let playerId;
      if (event.type === "score" && event.delta > 0 && event.teamId === team.id
        && !correctedScores.has(event.id) && event.statPlayKind) {
        playKind = event.statPlayKind;
        outcome = "point";
        playerId = event.playerId;
      } else if (event.type === "play" && event.teamId === team.id) {
        playKind = event.playKind;
        outcome = event.outcome;
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
      headers: ["選手", "打数", "得点", "失点", "決定率", "セット平均"],
      values: (stats, setsPlayed) => [
        stats.attack.attempts,
        stats.attack.points,
        stats.attack.errors,
        formatPercentage(stats.attack.points, stats.attack.attempts),
        formatSetAverage(stats.attack.points, setsPlayed),
      ],
    },
    {
      key: "backAttack",
      title: "バックアタック",
      headers: ["選手", "打数", "得点", "失点", "決定率"],
      values: (stats) => [
        stats.backAttack.attempts,
        stats.backAttack.points,
        stats.backAttack.errors,
        formatPercentage(stats.backAttack.points, stats.backAttack.attempts),
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
  note.textContent = "決定率＝得点÷打数×100、アタック/ブロックセット平均＝得点÷出場セット数、サーブ効果率＝（エース×100＋効果×25－失点×25）÷打数、レシーブ成功率＝（優×100＋良×50）÷受数。サービスエースは効果数にも自動計上します。率は小数第1位、セット平均は小数第2位まで表示し、分母が0の場合は「—」を表示します。";
  container.append(note);
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
  const profileLabels = { six: "6人制", nine: "9人制", beach: "ビーチバレー", soft: "ソフトバレー" };
  format.textContent = `${profileLabels[currentMatch.rules.matchProfile]}・${currentMatch.rules.bestOf}セットマッチ / ${currentMatch.rules.category} ${currentMatch.rules.division}`;
  const tournament = document.createElement("p");
  tournament.textContent = info.tournamentName || "大会名未入力";
  title.append(heading, format, tournament);
  matchDocument.append(title);

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
  matchDocument.append(meta);
  appendPrintSection(matchDocument, "試合結果・セット得点", ["セット", teamA.name, teamB.name, "勝者", "開始", "終了"], currentMatch.sets.map((set) => [
    `第${set.number}セット`, getScore(set, teamA.id), getScore(set, teamB.id),
    getSetResult(currentMatch, set) ? getTeam(getSetResult(currentMatch, set)).name : "進行中",
    set.startedAt ? new Date(set.startedAt).toLocaleTimeString("ja-JP") : "—",
    set.endedAt ? new Date(set.endedAt).toLocaleTimeString("ja-JP") : "—",
  ]));

  appendPrintTeamColumns(matchDocument, "チーム構成・登録選手", currentMatch.teams,
    (team) => team.players.map((player) => [
      player.number, player.name, player.isCaptain ? "キャプテン" : player.isLibero ? "リベロ" : "選手",
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

  const scoreDocument = document.createElement("section");
  scoreDocument.className = "print-document";
  scoreDocument.dataset.printDocument = "score-log";
  appendPrintSection(scoreDocument, "得点・コートチェンジ記録", ["セット", "時刻", "記録内容"],
    currentMatch.sets.flatMap((set) => set.events
      .filter((event) => event.type === "score" || event.type === "court-change")
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

  const manualDocument = document.createElement("section");
  manualDocument.className = "print-document";
  manualDocument.dataset.printDocument = "manual";
  manualDocument.append(byId("manual-document").cloneNode(true));
  root.append(matchDocument, scoreDocument, eventDocument, manualDocument);
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
  const heading = document.createElement("h2");
  heading.textContent = "第1セットのコート配置・サーブ順";
  const layout = document.createElement("div");
  layout.id = "confirmation-rotation-layout";
  layout.className = "rotation-court-layout";
  summary.append(heading, layout);
  const state = renderRotationView("confirmation-rotation-layout", currentMatch.sets[0], false);
  const server = getTeam(state.server);
  const lineup = getCurrentLineup(currentMatch, currentMatch.sets[0], state.server);
  const slotIndex = usesCourtRotation(currentMatch)
    ? 0
    : (state.serviceTurns[state.server] - 1 + lineup.length) % lineup.length;
  const player = server?.players.find((item) => item.id === lineup[slotIndex]);
  const detail = document.createElement("p");
  detail.className = "notice";
  detail.textContent = `最初のサーブ: ${server?.name || "未設定"}${player ? ` #${player.number} ${player.name}` : "（選手未割当）"}`;
  summary.append(detail);
}

function getRequiredStartChecks() {
  const [teamA, teamB] = currentMatch.teams;
  const info = currentMatch.matchInfo;
  const requiredSlots = getCourtPlayerCount(currentMatch);
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
    [`${teamA.name}のローテーション・サーブ順`, teamA.rotationLineup.slice(0, requiredSlots).every(Boolean)],
    [`${teamB.name}のローテーション・サーブ順`, teamB.rotationLineup.slice(0, requiredSlots).every(Boolean)],
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
  ];
  return startChecks;
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
    ["試合形式", `${{ six: "6人制", nine: "9人制", beach: "ビーチバレー", soft: "ソフトバレー" }[currentMatch.rules.matchProfile]} / ${currentMatch.rules.bestOf}セット`],
    ["ラウンド", info.round], ["カテゴリー・種別", `${currentMatch.rules.category} / ${currentMatch.rules.division}`],
    ["ファーストレフェリー", info.officials.firstReferee.name],
    ["スコアラー", info.officials.scorer.name],
  ]) appendSummaryRow(confirmation, label, value);
  for (const team of currentMatch.teams) appendSummaryRow(confirmation, team.name, `${team.players.length}名登録`);
  renderConfirmationRotation();

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

  const checks = getRequiredStartChecks();
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
  const appendEvent = (item) => {
    const scoreFor = (teamId) => getScore(set, teamId)
      + (item.type === "score" && item.teamId === teamId ? item.delta : 0);
    const snapshot = `${scoreFor(currentMatch.teams[0].id)}-${scoreFor(currentMatch.teams[1].id)}`;
    set.events.push({ id: createId(), time: now, currentScore: snapshot, ...item });
  };
  appendEvent(event);
  if (event.type === "score") {
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
    }
    if (getSetResult(currentMatch, set)) {
      set.endedAt = now;
      if (set.number < currentMatch.rules.bestOf
        && !set.events.some((item) => item.type === "court-change" && item.reason === "set-end")) {
        appendEvent({
          type: "court-change",
          teamId: currentMatch.teams[0].id,
          totalPoints: currentMatch.teams.reduce((sum, team) => sum + getScore(set, team.id), 0),
          setNumber: set.number,
          reason: "set-end",
        });
      }
    }
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
  const inputs = form.querySelectorAll('input');
  const number = inputs[0]?.value.trim();
  const name = inputs[1]?.value.trim();
  const captain = inputs[2]?.checked || false;
  const libero = inputs[3]?.checked || false;
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
  if (team.players.some((player) => player.isLibero) && libero) {
    showError("リベロは1人まで登録できます。既存のリベロを解除してから追加してください。");
    return;
  }
  if (captain && libero) {
    showError("キャプテンとリベロは同時に設定できません。");
    return;
  }
  team.players.push({ id: createId(), number, name: name.slice(0, 60), isCaptain: captain, isLibero: libero });
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
    store = buildStore(store.matches, store.teamProfiles);
    currentMatch = structuredClone(validatedMatch);
    storageRecoveryRequired = false;
    render();
    scheduleSave(true);
  });
}

function bindEvents() {
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
    if (matchHasStarted()) return;
    currentMatch.sets[0].initialServiceTeamId = byId("prestart-initial-server").value;
    renderRotation();
    renderPageSummaries();
    scheduleSave(true);
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
    const quickChoice = target.closest("#rally-kind-group [data-value], #rally-outcome-group [data-value]");
    if (quickChoice instanceof HTMLButtonElement) {
      const group = quickChoice.closest("#rally-kind-group, #rally-outcome-group");
      const select = byId(group?.id === "rally-kind-group" ? "rally-kind" : "rally-outcome");
      if (select) select.value = quickChoice.dataset.value;
      group?.querySelectorAll("button[data-value]").forEach((button) => {
        button.classList.toggle("selected", button === quickChoice);
      });
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
    const player = byId("sanction-player").value.trim();
    if (!player) return showError("処置対象者を入力してください。");
    addEvent({ type: "sanction", teamId: byId("sanction-team").value, player: player.slice(0, 20), sanctionType: byId("sanction-type").value });
    byId("sanction-player").value = "";
  });
  byId("rally-team").addEventListener("change", renderRallyEntryForm);
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
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches("[data-rotation-team]")) return;
    const team = getTeam(select.dataset.rotationTeam);
    const count = getCourtPlayerCount(currentMatch);
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
    currentMatch.sets[0].startingLineups[team.id] = [...team.rotationLineup];
    clearError();
    renderRotation();
    renderPageSummaries();
    scheduleSave(true);
  });
  document.addEventListener("input", (event) => {
    const colorInput = event.target;
    if (colorInput instanceof HTMLInputElement && colorInput.matches("[data-team-color]")) {
      updateTeamColor(colorInput.dataset.teamColor, colorInput.value);
    }
  });
  byId("start-match").addEventListener("click", () => {
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
  const validPages = new Set(["home", "manual", "setup", "members", "rotation", "staff", "confirm", "match", "events", "scoresheet", "sets", "result", "verify", "output"]);
  let selected = validPages.has(page) ? page : "home";
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
  if (selected === "confirm" || selected === "scoresheet" || selected === "sets" || selected === "result" || selected === "verify" || selected === "output" || selected === "manual") {
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
      store = { version: 1, matches: [], teamProfiles: [] };
      showError(error.message);
    }
    currentMatch = store.matches[0] ? structuredClone(store.matches[0]) : createEmptyMatch();
    if (!store.matches.length) {
      store.matches = [currentMatch];
      if (!storageRecoveryRequired) writeStore(store);
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
    showError(error.message || "アプリの初期化に失敗しました。");
    elements.teamCards.forEach((card) => { card.textContent = "保存データの読み込みに失敗しました。データを確認してください。"; });
    setSaveStatus("初期化エラー");
  }
}

initialize();
