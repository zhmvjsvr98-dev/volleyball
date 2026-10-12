import { renderTeamCard, makeEventRow } from "./components.js";
import {
  canScore, getEventDescription, getScore, getSetResult, getSetTarget, getSetWins, isMatchComplete,
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
};
const infoFields = {
  tournamentName: "tournament-name",
  matchDate: "match-date",
  venue: "venue",
  referee1: "referee-1",
  referee2: "referee-2",
  scorer: "scorer",
};
const ruleFields = {
  bestOf: "best-of",
  regularTarget: "regular-target",
  finalTarget: "final-target",
  timeoutLimit: "timeout-limit",
};

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
  currentMatch.rules.bestOf = Number(byId(ruleFields.bestOf).value);
  currentMatch.rules.regularTarget = Number(byId(ruleFields.regularTarget).value);
  currentMatch.rules.finalTarget = Number(byId(ruleFields.finalTarget).value);
  currentMatch.rules.timeoutLimit = Number(byId(ruleFields.timeoutLimit).value);
  scheduleSave();
}

function populateForm() {
  for (const [key, id] of Object.entries(infoFields)) byId(id).value = currentMatch.matchInfo[key];
  for (const [key, id] of Object.entries(ruleFields)) byId(id).value = String(currentMatch.rules[key]);
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
  currentMatch.teams.forEach((team, index) => renderTeamCard(elements.teamCards[index], team, index));
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
  byId("undo-event").disabled = currentSet().events.length === 0;
}

function addEvent(event) {
  // 得点・交代などを共通の時系列イベントとして保存するため、取り消しと監査が容易です。
  currentSet().events.push({ id: createId(), time: new Date().toISOString(), ...event });
  render();
  scheduleSave(true);
  elements.announcer.textContent = getEventDescription(currentMatch, event);
}

function addScore(teamId, delta) {
  if (!canScore(currentMatch)) return;
  const newScore = getScore(currentSet(), teamId) + delta;
  if (newScore < 0) return;
  addEvent({ type: "score", teamId, delta });
}

function startNextSet() {
  if (!getSetResult(currentMatch, currentSet()) || isMatchComplete(currentMatch)) return;
  if (currentMatch.sets.length >= currentMatch.rules.bestOf || currentMatch.sets.length >= 5) return;
  currentMatch.sets.push({ number: currentMatch.sets.length + 1, events: [] });
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
    if (!validateImport(imported)) throw new Error("試合データの形式または入力値が正しくありません。読み込みを中止しました。");
    const duplicate = store.matches.some((match) => match.id === imported.id);
    if (duplicate && !confirm("同じIDの試合データがすでにあります。読み込んだデータで置き換えますか？")) return;
    store.matches = [imported, ...store.matches.filter((match) => match.id !== imported.id)];
    store = buildStore(store.matches);
    currentMatch = structuredClone(imported);
    storageRecoveryRequired = false;
    render();
    scheduleSave(true);
  });
}

function bindEvents() {
  [...Object.values(infoFields), ...Object.values(ruleFields)].forEach((id) => {
    const input = byId(id);
    input.addEventListener("change", updateFromForm);
    if (input.tagName === "INPUT" && input.type !== "date") input.addEventListener("input", updateFromForm);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const scoreButton = target.closest("[data-score-team]");
    if (scoreButton) return addScore(scoreButton.dataset.scoreTeam, Number(scoreButton.dataset.delta));
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

  for (const card of elements.teamCards) {
    card.addEventListener("change", (event) => {
      const input = event.target.closest("[data-team-name]");
      if (!input) return;
      const team = getTeam(input.dataset.teamName);
      team.name = input.value.trim().slice(0, 60) || "チーム";
      input.value = team.name;
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
  byId("theme-toggle").addEventListener("click", toggleTheme);
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      persistNow();
      if (dirty) event.preventDefault();
    }
  });
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
    theme = localStorage.getItem("jva-score-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch { /* The app remains usable if theme preference storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  byId("theme-toggle").textContent = theme === "dark" ? "ライトモード" : "ダークモード";
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
