import { renderTeamCard, makeEventRow } from "./components.js";
import {
  canScore, getCourtPlayerCount, getCurrentLineup, getDecidingSetCourtChangePoint, getDefaultSetTargets, getEventDescription, getScore, getSetResult, getSetTarget, getSetWins, getServingState, isMatchComplete, usesCourtRotation,
} from "./score.js";
import { buildStore, createEmptyMatch, createId, MAX_MATCHES, readStore, validateImport, writeStore } from "./storage.js";

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
  ["scorer", "スコアラー"],
  ["assistantScorer", "アシスタントスコアラー"],
  ["lineJudge1", "ラインジャッジ1"],
  ["lineJudge2", "ラインジャッジ2"],
  ["lineJudge3", "ラインジャッジ3"],
  ["lineJudge4", "ラインジャッジ4"],
];
const rallyKinds = ["serve", "reception", "serveReception", "attackReception", "set", "attack", "backAttack", "block", "error", "other"];
const rallyOutcomes = ["success", "point", "error", "touch", "effective", "excellent", "good", "other"];
let pendingScoreTeamId;

let store;
let currentMatch;
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

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
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
  store = buildStore(store.matches, store.teamProfiles, store.tournaments);
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
    renderTournamentManagement();
    renderSeasonStats();
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
  if (adjustedBestOf) showError("この競技形式は3セットマッチのみのため、試合方式を3セットマッチにしました。");
  else clearError();
  renderPageSummaries();
  scheduleSave();
}

function populateForm() {
  for (const [key, id] of Object.entries(infoFields)) byId(id).value = currentMatch.matchInfo[key];
  for (const [key, id] of Object.entries(ruleFields)) {
    if (!key.startsWith("technicalTimeoutPoint")) byId(id).value = String(currentMatch.rules[key]);
  }
  byId("technical-timeout-point-1").value = String(currentMatch.rules.technicalTimeoutPoints[0]);
  byId("technical-timeout-point-2").value = String(currentMatch.rules.technicalTimeoutPoints[1]);
  byId("best-of").querySelector('option[value="5"]').disabled =
    ["six-elementary", "nine", "beach", "soft"].includes(currentMatch.rules.matchProfile);
  byId("rotation-enabled").checked = usesCourtRotation(currentMatch);
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
  byId("rotation-enabled").disabled = locked || currentMatch.rules.matchProfile !== "six" || currentMatch.rules.category === "小学生";
  byId("team-name-setup-a").value = currentMatch.teams[0].name;
  byId("team-name-setup-b").value = currentMatch.teams[1].name;
  byId("team-code-a").value = currentMatch.teams[0].code || "";
  byId("team-code-b").value = currentMatch.teams[1].code || "";
  byId("team-color-setup-a").value = currentMatch.teams[0].uniformColor || "#1d4ed8";
  byId("team-color-setup-b").value = currentMatch.teams[1].uniformColor || "#f97316";
  byId("team-libero-color-setup-a").value = currentMatch.teams[0].liberoUniformColor || "#facc15";
  byId("team-libero-color-setup-b").value = currentMatch.teams[1].liberoUniformColor || "#22c55e";
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
    || selected.matchIds.length === 0 && !selected.fixtures?.some((fixture) => fixture.manualResult?.sets.length);
  if (!selected) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = store.tournaments.length ? "管理する大会を選択してください。" : "大会を作成すると、試合を登録できます。";
    list.append(message);
    return;
  }
  const matches = selected.matchIds
    .map((id) => id === currentMatch.id ? currentMatch : store.matches.find((match) => match.id === id))
    .filter(Boolean);
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
  const code = codeInput.value.trim().toUpperCase();
  if (code && !/^[A-Z0-9_-]{1,30}$/.test(code)) {
    return showError("チームコードは半角英数字、ハイフン、アンダースコアで30文字以内にしてください。");
  }
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
  store = buildStore(store.matches, store.teamProfiles, store.tournaments);
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
  store = buildStore(store.matches, store.teamProfiles, store.tournaments);
  scheduleSave(true);
  renderTeamProfiles();
  renderTournamentParticipants();
  clearError();
}

function clearTeamHistory() {
  if (!store.teamProfiles.length) return;
  if (!confirm("保存されているチーム履歴をすべて削除しますか？この操作は取り消せません。")) return;
  store.teamProfiles = [];
  store = buildStore(store.matches, store.teamProfiles, store.tournaments);
  scheduleSave(true);
  renderTeamProfiles();
  renderTournamentParticipants();
  clearError();
}

function clearMatchHistory() {
  if (!store.matches.length) return;
  if (!confirm("保存されている試合履歴をすべて削除しますか？この操作は取り消せません。")) return;
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
  store = buildStore(store.matches, store.teamProfiles, store.tournaments);
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

function renderSubstitutionMonitors() {
  const standardLines = [];
  const liberoLines = [];
  for (const team of currentMatch.teams) {
    const substitutions = getSetSubstitutionCount(currentSet(), team.id, "substitution");
    const remaining = Math.max(0, currentMatch.rules.substitutionLimit - substitutions);
    const warning = remaining === 0 ? "（上限）" : remaining === 1 ? "（残り1回）" : "";
    standardLines.push(`${team.name}: ${substitutions}/${currentMatch.rules.substitutionLimit}回 ${warning}`);
    const liberoSubs = getSetSubstitutionCount(currentSet(), team.id, "libero-substitution");
    const libero = team.players.find((player) => player.isLibero);
    const active = libero && getCurrentLineup(currentMatch, currentSet(), team.id).includes(libero.id);
    const last = [...currentSet().events].reverse().find((event) => event.type === "libero-substitution" && event.teamId === team.id);
    const lastLine = last ? ` / 直近: ${last.playerOut || "—"} → ${last.playerIn || "—"}` : "";
    liberoLines.push(`${team.name}: ${liberoSubs}回${libero ? ` / ${libero.name}${active ? "（コート内）" : "（コート外）"}` : " / リベロ未登録"}${lastLine}`);
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

  const rallyEvent = addEvent({
    type: "rally-play",
    teamId: team.id,
    playerId,
    playKind,
    outcome,
    note,
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
  renderSubstitutionMonitors();
  renderTechnicalTimeoutStatus();
  renderDurationStatus();
  renderLivePerformanceMetrics();
  renderIntegrityAlerts();
  renderCurrentSetReport();
  renderMatchTimer();
  renderRotation();
  applyTeamColors();
  byId("undo-event").disabled = currentSet().events.length === 0;
  renderTournamentManagement();
  renderSeasonStats();
  renderPageSummaries();
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
  if (["serveReception", "reception"].includes(event.playKind)) return "reception";
  return event.playKind;
}

function getEffectivePointEvents(set) {
  const correctedScores = new Set(set.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => event.correctionOf));
  return set.events.filter((event) =>
    event.type === "score" && event.delta > 0 && !event.correctionSource && !correctedScores.has(event.id));
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

  const rosterDocument = document.createElement("section");
  rosterDocument.className = "print-document";
  rosterDocument.dataset.printDocument = "roster";
  appendPrintTeamColumns(rosterDocument, "メンバー表", currentMatch.teams,
    (team) => team.players.map((player) => [
      player.number, player.name, player.isCaptain ? "キャプテン" : player.isLibero ? "リベロ" : "選手",
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
    ? selectedTournament.matchIds.map((id) => id === currentMatch.id
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
  tournamentTitle.textContent = selectedTournament ? `${selectedTournament.name} 大会試合一覧・結果` : "大会試合一覧・結果";
  tournamentDocument.append(tournamentTitle);
  appendPrintSection(tournamentDocument, "大会試合一覧・結果", ["日付", "ラウンド", "試合番号", "対戦", "セット結果", "勝者", "状態"], tournamentRows);

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
  chart.replaceChildren();
  const points = getEffectivePointEvents(set);
  if (!points.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "このセットに有効な得点記録はありません。";
    chart.append(empty);
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
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", scores.get(team.id).map((score, index) => `${x(index)},${y(score)}`).join(" "));
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
  chart.append(svg);
}

function renderMatchAnalysis(winner) {
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
  const previousServer = currentSet().initialServiceTeamId;
  const initialServiceTeamId = currentMatch.teams.find((team) => team.id !== previousServer)?.id || currentMatch.teams[0].id;
  const startingLineups = Object.fromEntries(currentMatch.teams.map((team) => [team.id, [...team.rotationLineup]]));
  const startedAt = new Date().toISOString();
  const newSet = {
    number: currentMatch.sets.length + 1,
    initialServiceTeamId,
    startingLineups,
    startedAt,
    endedAt: "",
    events: [{
      id: createId(),
      time: startedAt,
      teamId: currentMatch.teams[0].id,
      type: "set-start",
      setNumber: currentMatch.sets.length + 1,
    }],
  };

  currentMatch.sets.push(newSet);
  render();
  scheduleSave(true);
}

function undoLastEvent() {
  const set = currentSet();
  if (!set.events.length) return;
  let removed = set.events.pop();
  const scoreDerivedTypes = new Set(["sto", "court-change", "set-end", "match-end"]);
  if (scoreDerivedTypes.has(removed.type)) {
    while (scoreDerivedTypes.has(set.events.at(-1)?.type)) set.events.pop();
    if (set.events.at(-1)?.type === "score") removed = set.events.pop();
  }
  if (removed.type === "score") {
    if (set.events.at(-1)?.type === "serve-fault" && set.events.at(-1).attempt === 2) {
      removed = set.events.pop();
    }
    const rally = set.events.at(-1);
    if (rally?.type === "rally-play" && ["point", "error"].includes(rally.outcome)) set.events.pop();
  }
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
  storageRecoveryRequired = false;
  finishChecklistExpanded = false;
  currentMatch = createEmptyMatch();
  render();
  scheduleSave(true);
}

function loadMatch(matchId) {
  if (dirty) persistNow();
  const match = store.matches.find((item) => item.id === matchId);
  if (!match) return;
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
    store.matches = [validatedMatch, ...store.matches.filter((match) => match.id !== validatedMatch.id)];
    store = buildStore(store.matches, store.teamProfiles, store.tournaments);
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
  courtChangeSetFields.forEach((id) => byId(id).addEventListener("change", updateFromForm));
  byId("rotation-enabled").addEventListener("change", updateFromForm);

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
  for (const [id, teamIndex] of [["team-code-a", 0], ["team-code-b", 1]]) {
    byId(id).addEventListener("change", (event) => {
      if (matchHasStarted()) return showError("試合開始後はチームコードを変更できません。");
      const code = event.target.value.trim().toUpperCase();
      if (code && !/^[A-Z0-9_-]{1,30}$/.test(code)) {
        showError("チームコードは半角英数字、ハイフン、アンダースコアで30文字以内にしてください。");
        event.target.value = currentMatch.teams[teamIndex].code || "";
        return;
      }
      if (code && currentMatch.teams.some((team, index) => index !== teamIndex && team.code === code)) {
        showError("同じ試合の両チームに同じチームコードは設定できません。");
        event.target.value = currentMatch.teams[teamIndex].code || "";
        return;
      }
      event.target.value = code;
      currentMatch.teams[teamIndex].code = code;
      clearError();
      renderSeasonStats();
      scheduleSave(true);
    });
  }
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
  byId("nine-serve-fault").addEventListener("click", recordNinePlayerServeFault);

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
    const deletedMatchId = currentMatch.id;
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
  byId("score-chart-set").addEventListener("change", renderScoreChart);
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
    const hasManualResults = tournament?.fixtures?.some((fixture) => !fixture.matchId && fixture.manualResult?.sets.length);
    if (!tournament || (!tournament.matchIds.length && !hasManualResults)) return;
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
  const validPages = new Set(["home", "manual", "setup", "members", "rotation", "staff", "confirm", "match", "tournaments", "season", "events", "scoresheet", "sets", "result", "verify", "output"]);
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

async function initialize() {
  try {
    try {
      store = await readStore();
    } catch (error) {
      // Keep the UI available for backup import instead of overwriting unreadable local data.
      storageRecoveryRequired = true;
      store = { version: 1, matches: [], teamProfiles: [], tournaments: [] };
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
    showError(error.message || "アプリの初期化に失敗しました。");
    elements.teamCards.forEach((card) => { card.textContent = "保存データの読み込みに失敗しました。データを確認してください。"; });
    setSaveStatus("初期化エラー");
  }
}

initialize();
