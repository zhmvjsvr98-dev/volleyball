const STORAGE_KEY = "jva-electronic-score-sheet";
const DATABASE_NAME = "jva-volleyball-score";
const DATABASE_VERSION = 2;
const DATABASE_STORE = "records";
const METADATA_KEY = "metadata";
const MATCH_KEY_PREFIX = "match:";
const AUDIT_KEY_PREFIX = "audit:";
export const MAX_MATCHES = 1_000;
export function sortPlayersByNumber(players) {
  const value = (player) => (/^\d+$/.test(player.number) ? Number(player.number) : Infinity);
  return [...players].sort((a, b) => value(a) - value(b));
}

export const PLAYER_POSITIONS = [
  ["OH", "アウトサイドヒッター"],
  ["MB", "ミドルブロッカー"],
  ["S", "セッター"],
  ["OP", "オポジット"],
];

export function describePlayerRole(player) {
  const parts = [];
  if (player.isCaptain) parts.push("キャプテン(C)");
  if (player.isLibero) parts.push("リベロ(L)");
  const position = PLAYER_POSITIONS.find(([code]) => code === player.position);
  if (position) parts.push(`${position[1]}(${position[0]})`);
  return parts.length ? parts.join(" / ") : "選手";
}
const MAX_TEAM_PROFILES = 100;
const MAX_TOURNAMENTS = 100;
const MAX_AUDIT_ENTRIES = 1_000_000;
const MAX_RULE_PLUGINS = 100;
const MAX_EVENTS_PER_SET = 2_000;
const OFFICIAL_ROLES = ["firstReferee", "secondReferee", "thirdReferee", "challengeReferee", "scorer", "assistantScorer", "lineJudge1", "lineJudge2", "lineJudge3", "lineJudge4"];
let databasePromise;
let persistedMatches = new Map();
let persistedAuditEntries = new Map();

function validateVideo(video, sets) {
  if (video === undefined) return true;
  if (!isPlainObject(video) || video.version !== 1 || !isText(video.fileName, 255)
    || !Array.isArray(video.syncPoints) || video.syncPoints.length > 10_000) return false;
  const events = new Map(sets.flatMap((set) => set.events.map((event) => [event.id, event])));
  return video.syncPoints.every((point) => isPlainObject(point)
    && isText(point.eventId, 80) && events.has(point.eventId)
    && typeof point.videoTime === "number" && Number.isFinite(point.videoTime)
    && point.videoTime >= 0 && point.videoTime <= 604_800)
    && new Set(video.syncPoints.map((point) => point.eventId)).size === video.syncPoints.length;
}

function openDatabase() {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("このブラウザーはIndexedDBに対応していません。対応ブラウザーで開いてください。"));
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DATABASE_STORE)) {
          request.result.createObjectStore(DATABASE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("保存領域を開けませんでした。"));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("別のタブが保存領域を更新中です。ほかのアプリタブを閉じて再読み込みしてください。"));
      };
    }).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

function emptyStore() {
  return { version: 1, matches: [], teamProfiles: [], tournaments: [], auditLog: [], plugins: [] };
}

function upgradeStore(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.matches)) {
    throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
  }
  const upgraded = {
    ...value,
    matches: value.matches.map(upgradeMatch),
    teamProfiles: Array.isArray(value.teamProfiles) ? value.teamProfiles : [],
    tournaments: Array.isArray(value.tournaments) ? value.tournaments : [],
    auditLog: Array.isArray(value.auditLog) ? value.auditLog : [],
    plugins: Array.isArray(value.plugins) ? value.plugins : [],
  };
  if (!validateStore(upgraded)) {
    throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
  }
  upgraded.auditLog.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return upgraded;
}

function rememberPersistedMatches(matches) {
  persistedMatches = new Map(matches.map((match) => [match.id, JSON.stringify(match)]));
}

function rememberPersistedAuditEntries(entries) {
  persistedAuditEntries = new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]));
}

function storeFromRecords(records) {
  const metadata = records.find((record) => record.key === METADATA_KEY)?.value;
  if (!isPlainObject(metadata) || !Array.isArray(metadata.matchIds)) {
    throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
  }
  const matchesById = new Map(records
    .filter((record) => typeof record.key === "string" && record.key.startsWith(MATCH_KEY_PREFIX))
    .map((record) => [record.key.slice(MATCH_KEY_PREFIX.length), record.value]));
  const matches = metadata.matchIds.map((id) => matchesById.get(id));
  if (matches.length !== matchesById.size || matches.some((match) => !match)) {
    throw new Error("保存データの試合一覧が一致しません。データ書き出しファイルから復元してください。");
  }
  const auditLog = records
    .filter((record) => typeof record.key === "string" && record.key.startsWith(AUDIT_KEY_PREFIX))
    .map((record) => record.value);
  return upgradeStore({
    version: metadata.version,
    matches,
    teamProfiles: metadata.teamProfiles,
    tournaments: metadata.tournaments,
    auditLog: auditLog.length ? auditLog : metadata.auditLog,
    plugins: metadata.plugins,
  });
}

function addStoreToTransaction(objectStore, store) {
  objectStore.put({
    key: METADATA_KEY,
    value: {
      version: store.version,
      matchIds: store.matches.map((match) => match.id),
      teamProfiles: store.teamProfiles,
      tournaments: store.tournaments,
      plugins: store.plugins,
    },
  });
  store.matches.forEach((match) => objectStore.put({ key: `${MATCH_KEY_PREFIX}${match.id}`, value: match }));
  store.auditLog.forEach((entry) => objectStore.put({ key: `${AUDIT_KEY_PREFIX}${entry.id}`, value: entry }));
}

function storageError(error) {
  if (error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return new Error("ブラウザーの保存容量が不足しています。試合データを書き出してから不要な履歴を削除してください。");
  }
  return new Error(`保存領域へのアクセスに失敗しました: ${error?.message || "不明なエラー"}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength;
}

function isColor(value) {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function validatePlayer(player) {
  return isPlainObject(player)
    && isText(player.id, 80)
    && typeof player.number === "string"
    && /^\d{1,3}$/.test(player.number)
    && typeof player.name === "string"
    && player.name.trim().length > 0
    && player.name.length <= 60
    && typeof player.isCaptain === "boolean"
    && typeof player.isLibero === "boolean"
    && (player.position === undefined || player.position === "" || PLAYER_POSITIONS.some(([code]) => code === player.position));
}

function validateTeamProfile(profile, requireSavedAt = false) {
  if (
    !isPlainObject(profile)
    || !isText(profile.id, 80)
    || !isText(profile.name, 60)
    || !profile.name.trim()
    || (requireSavedAt && !isText(profile.savedAt, 40))
    || (profile.savedAt !== undefined && !isText(profile.savedAt, 40))
    || (profile.code !== undefined && profile.code !== "" && !/^[\w-]{1,30}$/.test(profile.code))
    || !Array.isArray(profile.players)
    || profile.players.length > 42
    || !profile.players.every(validatePlayer)
    || !Array.isArray(profile.rotationLineup)
    || profile.rotationLineup.length > 9
    || !isColor(profile.uniformColor || "#1d4ed8")
    || !isColor(profile.liberoUniformColor || "#facc15")
  ) {
    return false;
  }

  if (profile.staff !== undefined && !isPlainObject(profile.staff)) {
    return false;
  }

  const playerIds = profile.players.map((player) => player.id);
  const numbers = profile.players.map((player) => player.number);
  const lineup = profile.rotationLineup.filter(Boolean);

  return (
    new Set(playerIds).size === playerIds.length
    && new Set(numbers).size === numbers.length
    && profile.players.filter((player) => player.isCaptain).length <= 1
    && new Set(lineup).size === lineup.length
    && lineup.every((id) => playerIds.includes(id))
  );
}

function validateTournament(tournament, matchIds) {
  const baseIsValid = isPlainObject(tournament)
    && isText(tournament.id, 80)
    && isText(tournament.name, 80)
    && tournament.name.trim().length > 0
    && isText(tournament.createdAt, 40)
    && Array.isArray(tournament.matchIds)
    && tournament.matchIds.length <= MAX_MATCHES
    && tournament.matchIds.every((id) => isText(id, 80) && matchIds.has(id))
    && new Set(tournament.matchIds).size === tournament.matchIds.length;
  if (!baseIsValid) return false;
  if (tournament.format === undefined) return true;
  if (!["round-robin", "single-elimination", "both"].includes(tournament.format)
    || !Array.isArray(tournament.participants)
    || tournament.participants.length < 2
    || tournament.participants.length > 64
    || !tournament.participants.every((participant) => isPlainObject(participant)
      && isText(participant.code, 30) && /^[A-Z0-9_-]+$/.test(participant.code)
      && isText(participant.name, 60) && participant.name.trim()
      && isText(participant.profileId, 80))
    || new Set(tournament.participants.map((participant) => participant.code)).size !== tournament.participants.length
    || !Array.isArray(tournament.fixtures)
    || tournament.fixtures.length > 4096) return false;
  const fixtureIds = new Set(tournament.fixtures.map((fixture) => fixture?.id));
  return tournament.fixtures.every((fixture) => isPlainObject(fixture)
    && isText(fixture.id, 80)
    && ["league", "bracket"].includes(fixture.phase)
    && Number.isInteger(fixture.roundIndex) && fixture.roundIndex >= 0 && fixture.roundIndex <= 10
    && isText(fixture.roundName, 40)
    && Number.isInteger(fixture.matchIndex) && fixture.matchIndex >= 0 && fixture.matchIndex <= 4095
    && ["teamACode", "teamBCode", "winnerCode"].every((key) => fixture[key] === undefined
      || fixture[key] === "" || tournament.participants.some((participant) => participant.code === fixture[key]))
    && ["teamAName", "teamBName"].every((key) => fixture[key] === undefined || isText(fixture[key], 60))
    && ["sourceAId", "sourceBId"].every((key) => fixture[key] === undefined
      || fixture[key] === "" || isText(fixture[key], 80) && fixtureIds.has(fixture[key]))
    && (fixture.manualResult === undefined || !fixture.matchId
      && validateManualTournamentResult(fixture.manualResult, fixture.teamACode, fixture.teamBCode, fixture.winnerCode))
    && (fixture.matchId === undefined || fixture.matchId === "" || isText(fixture.matchId, 80) && matchIds.has(fixture.matchId)))
    && new Set(tournament.fixtures.map((fixture) => fixture.id)).size === tournament.fixtures.length;
}

function validateManualTournamentResult(result, teamACode, teamBCode, winnerCode) {
  if (!isPlainObject(result) || ![3, 5].includes(result.bestOf)
    || !Array.isArray(result.sets) || result.sets.length < 1 || result.sets.length > result.bestOf
    || !teamACode || !teamBCode || teamACode === teamBCode) return false;
  const wins = { [teamACode]: 0, [teamBCode]: 0 };
  const winsNeeded = Math.floor(result.bestOf / 2) + 1;
  for (const [index, set] of result.sets.entries()) {
    if (!isPlainObject(set) || !Number.isInteger(set.teamA) || set.teamA < 0 || set.teamA > 99
      || !Number.isInteger(set.teamB) || set.teamB < 0 || set.teamB > 99 || set.teamA === set.teamB
      || Object.values(wins).some((count) => count >= winsNeeded)) return false;
    wins[set.teamA > set.teamB ? teamACode : teamBCode] += 1;
    if (Object.values(wins).some((count) => count >= winsNeeded) && index !== result.sets.length - 1) return false;
  }
  const computedWinner = Object.entries(wins).find(([, count]) => count >= winsNeeded)?.[0] || "";
  return computedWinner ? winnerCode === computedWinner : !winnerCode;
}

function validateEvent(event, validTeamIds) {
  if (!isPlainObject(event) || !isText(event.id, 80) || !isText(event.time, 40)
    || !validTeamIds.has(event.teamId) || !isText(event.type, 40)) return false;
  if (event.type === "score") {
    if (event.delta !== 1 && event.delta !== -1) return false;
    if (event.correctionOf !== undefined && !isText(event.correctionOf, 80)) return false;
    if (event.rallyEventId !== undefined && !isText(event.rallyEventId, 80)) return false;
    if (event.correctionSource !== undefined && !["challenge", "scorer", "other"].includes(event.correctionSource)) return false;
    if (event.correctionReason !== undefined && !isText(event.correctionReason, 120)) return false;
    if (event.serverPlayerId !== undefined && !isText(event.serverPlayerId, 80)) return false;
    if (event.expectedServerPlayerId !== undefined && !isText(event.expectedServerPlayerId, 80)) return false;
    if (event.rotationAdvanced !== undefined && typeof event.rotationAdvanced !== "boolean") return false;
    if (event.statPlayKind !== undefined && !["attack", "backAttack", "block", "serve"].includes(event.statPlayKind)) return false;
    if (event.delta < 0 || event.playType === undefined) return true;
    return ["serve", "attack", "back-attack", "block", "opponent-error", "penalty", "other"].includes(event.playType)
      && (event.playerId === null || isText(event.playerId, 80))
      && (event.faultPlayerId === null || isText(event.faultPlayerId, 80))
      && isText(event.note || "", 120);
  }
  if (event.type === "play") {
    if (!["attack", "backAttack", "block", "serve", "reception"].includes(event.playKind)
      || !(event.playerId === null || isText(event.playerId, 80))
      || !isText(event.note || "", 120)) return false;
    const allowedOutcomes = {
      attack: ["error", "continued"],
      backAttack: ["error", "continued"],
      block: ["error", "touch"],
      serve: ["error", "effective", "continued"],
      reception: ["excellent", "good", "other"],
    };
    return allowedOutcomes[event.playKind].includes(event.outcome);
  }
  if (event.type === "timeout") return true;
  if (event.type === "sto") return true;
  if (event.type === "technical-timeout") {
    return event.triggerPoint === undefined || Number.isInteger(event.triggerPoint) && event.triggerPoint >= 0 && event.triggerPoint <= 99;
  }
  if (event.type === "service-order-violation") {
    return isText(event.actualServerPlayerId, 80)
      && isText(event.expectedServerPlayerId, 80)
      && isText(event.scoreEventId, 80);
  }
  if (event.type === "serve-fault") {
    return Number.isInteger(event.attempt) && [1, 2].includes(event.attempt)
      && (event.playerId === undefined || event.playerId === null || isText(event.playerId, 80));
  }
  if (event.type === "court-change") {
    return Number.isInteger(event.totalPoints) && event.totalPoints >= 0 && event.totalPoints <= 198
      && (event.reason === undefined || ["points", "set-end"].includes(event.reason))
      && (event.setNumber === undefined || Number.isInteger(event.setNumber) && event.setNumber >= 1 && event.setNumber <= 5)
      && (event.triggerScore === undefined || Number.isInteger(event.triggerScore) && event.triggerScore >= 0 && event.triggerScore <= 99);
  }
  if (event.type === "challenge") {
    return ["net-touch", "block-touch", "antenna", "ball-in-out", "foot-fault", "other"].includes(event.challengeType)
      && ["success", "failed"].includes(event.result)
      && isText(event.note || "", 120);
  }
  if (event.type === "medical") {
    return isText(event.playerId, 80)
      && ["足首", "膝", "太もも", "ふくらはぎ", "肩", "指・手", "腰", "その他"].includes(event.bodyArea)
      && ["play", "substituted", "stopped", "withdrawn"].includes(event.status)
      && isText(event.note || "", 120);
  }
  if (event.type === "rally-play") {
    return ["serve", "reception", "serveReception", "attackReception", "set", "attack", "backAttack", "block", "error", "other"].includes(event.playKind)
      && ["success", "point", "error", "touch", "effective", "excellent", "good", "other"].includes(event.outcome)
      && (event.playerId === null || isText(event.playerId, 80))
      && (event.attackZone === undefined
        || ["attack", "backAttack"].includes(event.playKind) && Number.isInteger(event.attackZone) && event.attackZone >= 1 && event.attackZone <= 6)
      && (event.courseZone === undefined
        || ["serve", "reception", "serveReception", "attackReception"].includes(event.playKind)
          && Number.isInteger(event.courseZone) && event.courseZone >= 1 && event.courseZone <= 6)
      && isText(event.note || "", 120);
  }
  if (event.type === "substitution") {
    return isText(event.playerOut, 3) && isText(event.playerIn, 3);
  }
  if (event.type === "libero-substitution") {
    return (event.playerOut === null || isText(event.playerOut, 20)) && (event.playerIn === null || isText(event.playerIn, 20));
  }
  if (event.type === "sanction") {
    return isText(event.player, 40)
      && ["warning", "penalty", "expulsion", "disqualification", "delay-warning", "delay-penalty"].includes(event.sanctionType)
      && (event.subjectType === undefined || ["player", "bench", "staff", "team"].includes(event.subjectType));
}

if (event.type === "match-start") {
  return true;
}

if (event.type === "set-start") {
  return Number.isInteger(event.setNumber)
    && event.setNumber >= 1
    && event.setNumber <= 5;
}

if (event.type === "set-end") {
  return Number.isInteger(event.setNumber)
    && event.setNumber >= 1
    && event.setNumber <= 5
    && (
      event.winnerTeamId === undefined
      || validTeamIds.has(event.winnerTeamId)
    );
}

if (event.type === "match-end") {
  return true;
}

return false;
}

export function validateMatch(match) {
  if (!isPlainObject(match) || match.schemaVersion !== 1
    || !isText(match.id, 80) || !isText(match.createdAt, 40) || !isText(match.updatedAt, 40)
    || !isPlainObject(match.matchInfo) || !isPlainObject(match.rules)
    || !Array.isArray(match.teams) || match.teams.length !== 2
    || !Array.isArray(match.sets) || match.sets.length < 1 || match.sets.length > 5) return false;
  if (match.auditLog !== undefined && (!Array.isArray(match.auditLog) || match.auditLog.length > MAX_AUDIT_ENTRIES
    || !match.auditLog.every(validateAuditEntry))) return false;

  const info = match.matchInfo;
  if (!["tournamentName", "matchDate", "venue", "venueAddress", "court", "matchNumber", "round", "scheduledTime", "startedAt", "endedAt", "referee1", "referee2", "scorer"]
    .every((key) => isText(info[key], ["tournamentName", "venue"].includes(key) ? 80
      : key === "venueAddress" ? 120
      : ["referee1", "referee2", "scorer"].includes(key) ? 60
        : key === "matchDate" ? 10 : key === "round" ? 40 : key === "court" || key === "matchNumber" ? 20 : key === "scheduledTime" ? 5 : 40))) return false;
  if (info.matchDate && (!/^\d{4}-\d{2}-\d{2}$/.test(info.matchDate)
    || new Date(info.matchDate).toISOString().slice(0, 10) !== info.matchDate)) return false;
  if (!isPlainObject(info.officials) || !OFFICIAL_ROLES.every((role) => isPlainObject(info.officials[role])
    && isText(info.officials[role].name, 60) && isText(info.officials[role].area, 40))) return false;

  const rules = match.rules;
  if (![3, 5].includes(rules.bestOf)
    || !["six", "six-elementary", "nine", "beach", "soft"].includes(rules.matchProfile)
    || !isText(rules.category, 30) || !isText(rules.division, 20) || !isText(rules.note, 240)
    || !Array.isArray(rules.setTargets) || rules.setTargets.length !== 5
    || !rules.setTargets.every((target) => Number.isInteger(target) && target >= 1 && target <= 99)
    || !Number.isInteger(rules.winBy) || rules.winBy < 1 || rules.winBy > 10
    || !Number.isInteger(rules.timeoutLimit) || rules.timeoutLimit < 0 || rules.timeoutLimit > 10
    || !Number.isInteger(rules.substitutionLimit) || rules.substitutionLimit < 0 || rules.substitutionLimit > 30
    || !Array.isArray(rules.technicalTimeoutPoints) || rules.technicalTimeoutPoints.length !== 2
    || !rules.technicalTimeoutPoints.every((point) => Number.isInteger(point) && point >= 0 && point <= 99)
    || !Number.isInteger(rules.rosterLimit) || rules.rosterLimit < 1 || rules.rosterLimit > 42
    || !Number.isInteger(rules.courtChangeInterval) || rules.courtChangeInterval < 0 || rules.courtChangeInterval > 99
    || !Array.isArray(rules.courtChangeSets) || rules.courtChangeSets.length > 4
    || rules.courtChangeSets.some((setNumber) => !Number.isInteger(setNumber) || setNumber < 1 || setNumber > 4)
    || new Set(rules.courtChangeSets).size !== rules.courtChangeSets.length
    || !Number.isInteger(rules.warmupMinutes) || rules.warmupMinutes < 0 || rules.warmupMinutes > 60
    || typeof rules.rotationEnabled !== "boolean"
    || rules.pluginId !== undefined && !isText(rules.pluginId, 40)) return false;

  // Storageや読み込みファイルの内容は信頼せず、保存するたびに構造から検証します。
  const teamIds = new Set();
  const teamCodes = new Set();
  const playerIdsByTeam = new Map();
  for (const team of match.teams) {
    if (!validateTeamProfile(team)) return false;
    if (teamIds.has(team.id)) return false;
    if (team.code && teamCodes.has(team.code)) return false;
    teamIds.add(team.id);
    if (team.code) teamCodes.add(team.code);
    const numbers = team.players.map((player) => player.number).filter(Boolean);
    const playerIds = team.players.map((player) => player.id);
    playerIdsByTeam.set(team.id, new Set(playerIds));
    if (new Set(numbers).size !== numbers.length
      || new Set(playerIds).size !== playerIds.length
      || team.players.filter((player) => player.isCaptain).length > 1) return false;
    const assignedLineup = (team.rotationLineup || []).filter(Boolean);
    if (!Array.isArray(team.rotationLineup) || team.rotationLineup.length > 9
      || new Set(assignedLineup).size !== assignedLineup.length
      || assignedLineup.some((playerId) => !playerIds.includes(playerId))) return false;
  }

  if (match.sets.length > rules.bestOf) return false;
  const allPlayerIds = new Set(match.teams.flatMap((team) => team.players.map((player) => player.id)));
  return match.sets.every((set, index) => {
    if (!isPlainObject(set) || set.number !== index + 1 || !teamIds.has(set.initialServiceTeamId)
      || !isPlainObject(set.startingLineups) || !Array.isArray(set.startingLineups[match.teams[0].id])
      || !Array.isArray(set.startingLineups[match.teams[1].id]) || !Array.isArray(set.events)
      || set.events.length > MAX_EVENTS_PER_SET || !set.events.every((event) => validateEvent(event, teamIds))) return false;
    for (const team of match.teams) {
      const lineup = set.startingLineups[team.id];
      const playerIds = team.players.map((player) => player.id);
      const assigned = lineup.filter(Boolean);
      if (lineup.length > 9 || new Set(assigned).size !== assigned.length || assigned.some((id) => !playerIds.includes(id))) return false;
    }
    for (const event of set.events) {
      if (event.type === "score"
        && ((event.serverPlayerId !== undefined && !allPlayerIds.has(event.serverPlayerId))
          || (event.expectedServerPlayerId !== undefined && !allPlayerIds.has(event.expectedServerPlayerId)))) return false;
      if (event.type === "score" && event.rallyEventId !== undefined
        && !set.events.slice(0, set.events.indexOf(event)).some((prior) =>
          prior.id === event.rallyEventId && prior.type === "rally-play")) return false;
      if (event.type === "service-order-violation"
        && (!allPlayerIds.has(event.actualServerPlayerId) || !allPlayerIds.has(event.expectedServerPlayerId))) return false;
      if (event.type === "serve-fault" && event.playerId && !allPlayerIds.has(event.playerId)) return false;
      if (event.type === "medical" && !playerIdsByTeam.get(event.teamId).has(event.playerId)) return false;
      if (["play", "rally-play"].includes(event.type) && event.playerId && !playerIdsByTeam.get(event.teamId).has(event.playerId)) return false;
      if (event.type !== "score" || event.delta < 0) continue;
      const scoringPlayers = playerIdsByTeam.get(event.teamId);
      const opponentPlayers = new Set([...playerIdsByTeam.entries()]
        .filter(([id]) => id !== event.teamId).flatMap(([, ids]) => [...ids]));
      if (event.playerId && !scoringPlayers.has(event.playerId)) return false;
      if (event.faultPlayerId && !opponentPlayers.has(event.faultPlayerId)) return false;
    }
    const correctedEventIds = new Set();
    for (let eventIndex = 0; eventIndex < set.events.length; eventIndex += 1) {
      const correction = set.events[eventIndex];
      if (correction.type !== "score" || correction.delta !== -1 || correction.correctionOf === undefined) continue;
      const original = set.events.slice(0, eventIndex).find((event) => event.id === correction.correctionOf);
      if (!original || original.type !== "score" || original.delta !== 1 || original.teamId !== correction.teamId
        || correctedEventIds.has(original.id)) return false;
      correctedEventIds.add(original.id);
    }
    const scores = new Map([...teamIds].map((id) => [id, 0]));
    for (const event of set.events) {
      if (event.type !== "score") continue;
      const nextScore = scores.get(event.teamId) + event.delta;
      if (nextScore < 0) return false;
      scores.set(event.teamId, nextScore);
    }
    return true;
  }) && validateVideo(match.video, match.sets);
}

function upgradeMatch(match) {
  if (!isPlainObject(match) || !isPlainObject(match.matchInfo)) return match;
  const oldInfo = match.matchInfo;
  const officials = isPlainObject(oldInfo.officials) ? oldInfo.officials : {};
  const defaultOfficial = (name) => ({ name: typeof name === "string" ? name.slice(0, 60) : "", area: "" });
  const rules = isPlainObject(match.rules) ? match.rules : {};
  const bestOf = [3, 5].includes(rules.bestOf) ? rules.bestOf : 5;
  const regularTarget = Number.isInteger(rules.regularTarget) ? rules.regularTarget : 25;
  const finalTarget = Number.isInteger(rules.finalTarget) ? rules.finalTarget : 15;
  const teams = Array.isArray(match.teams) ? match.teams.map((team) => ({
    ...team,
    rotationLineup: Array.isArray(team.rotationLineup) ? team.rotationLineup : [],
  })) : match.teams;
  const officialData = Object.fromEntries(OFFICIAL_ROLES.map((role) => {
    const oldName = role === "firstReferee" ? oldInfo.referee1 : role === "secondReferee" ? oldInfo.referee2 : role === "scorer" ? oldInfo.scorer : "";
    const value = officials[role];
    return [role, {
      name: typeof value?.name === "string" ? value.name.slice(0, 60) : defaultOfficial(oldName).name,
      area: typeof value?.area === "string" ? value.area.slice(0, 40) : "",
    }];
  }));
  const teamIds = teams?.map((team) => team.id) || [];
  const normalizedTeams = (Array.isArray(teams) ? teams : []).map((team) => ({
    ...team,
    code: typeof team?.code === "string" && /^[\w-]{1,30}$/.test(team.code) ? team.code : "",
    uniformColor: isText(team?.uniformColor, 20) ? team.uniformColor : "#1d4ed8",
    liberoUniformColor: isText(team?.liberoUniformColor, 20) ? team.liberoUniformColor : "#facc15",
    staff: isPlainObject(team?.staff) ? team.staff : {},
    players: Array.isArray(team?.players) ? sortPlayersByNumber(team.players.map((player) => ({
      ...player,
      isCaptain: Boolean(player?.isCaptain),
      isLibero: Boolean(player?.isLibero),
      position: PLAYER_POSITIONS.some(([code]) => code === player?.position) ? player.position : "",
    }))) : [],
  }));
  const sets = Array.isArray(match.sets) ? match.sets.map((set, index) => ({
    ...set,
    initialServiceTeamId: teamIds.includes(set.initialServiceTeamId) ? set.initialServiceTeamId : teamIds[0],
    startedAt: typeof set.startedAt === "string" ? set.startedAt : "",
    endedAt: typeof set.endedAt === "string" ? set.endedAt : "",
    startingLineups: isPlainObject(set.startingLineups) ? set.startingLineups : Object.fromEntries((teams || []).map((team) => [team.id, team.rotationLineup])),
  })) : match.sets;
  const videoPoints = [];
  const eventIds = new Set(sets.flatMap((set) => set.events.map((event) => event.id)));
  if (Array.isArray(match.video?.syncPoints)) {
    const seen = new Set();
    for (const point of match.video.syncPoints.slice(0, 10_000)) {
      if (isPlainObject(point) && isText(point.eventId, 80) && eventIds.has(point.eventId)
        && typeof point.videoTime === "number" && Number.isFinite(point.videoTime)
        && point.videoTime >= 0 && point.videoTime <= 604_800 && !seen.has(point.eventId)) {
        videoPoints.push({ eventId: point.eventId, videoTime: point.videoTime });
        seen.add(point.eventId);
      }
    }
  }
  return {
    ...match,
    matchInfo: {
      ...oldInfo,
      venueAddress: typeof oldInfo.venueAddress === "string" ? oldInfo.venueAddress.slice(0, 120) : "",
      court: typeof oldInfo.court === "string" ? oldInfo.court : "",
      matchNumber: typeof oldInfo.matchNumber === "string" ? oldInfo.matchNumber : "",
      round: typeof oldInfo.round === "string" ? oldInfo.round : "",
      scheduledTime: typeof oldInfo.scheduledTime === "string" ? oldInfo.scheduledTime : "",
      startedAt: typeof oldInfo.startedAt === "string" ? oldInfo.startedAt : "",
      endedAt: typeof oldInfo.endedAt === "string" ? oldInfo.endedAt : "",
      officials: officialData,
    },
    rules: {
      ...rules,
      bestOf,
      matchProfile: ["six", "six-elementary", "nine", "beach", "soft"].includes(rules.matchProfile) ? rules.matchProfile : "six",
      category: typeof rules.category === "string" ? rules.category : "一般",
      division: typeof rules.division === "string" ? rules.division : "男子",
      setTargets: Array.isArray(rules.setTargets) && rules.setTargets.length === 5
        ? rules.setTargets : Array.from({ length: 5 }, (_, index) => index === bestOf - 1 ? finalTarget : regularTarget),
      winBy: Number.isInteger(rules.winBy) ? rules.winBy : 2,
      timeoutLimit: Number.isInteger(rules.timeoutLimit) ? rules.timeoutLimit : 2,
      substitutionLimit: Number.isInteger(rules.substitutionLimit) ? rules.substitutionLimit : 6,
      rosterLimit: Number.isInteger(rules.rosterLimit) ? rules.rosterLimit : 30,
      courtChangeInterval: Number.isInteger(rules.courtChangeInterval) ? rules.courtChangeInterval : 8,
      courtChangeSets: Array.isArray(rules.courtChangeSets)
        && rules.courtChangeSets.length <= 4
        && rules.courtChangeSets.every((setNumber) => Number.isInteger(setNumber) && setNumber >= 1 && setNumber <= 4)
        && new Set(rules.courtChangeSets).size === rules.courtChangeSets.length
        ? rules.courtChangeSets : [1, 2, 3, 4],
      technicalTimeoutPoints: Array.isArray(rules.technicalTimeoutPoints)
        && rules.technicalTimeoutPoints.length === 2
        && rules.technicalTimeoutPoints.every((point) => Number.isInteger(point) && point >= 0 && point <= 99)
        ? rules.technicalTimeoutPoints : [0, 0],
      rotationEnabled: typeof rules.rotationEnabled === "boolean" ? rules.rotationEnabled : true,
      warmupMinutes: Number.isInteger(rules.warmupMinutes) ? rules.warmupMinutes : 10,
      note: typeof rules.note === "string" ? rules.note.slice(0, 240) : "",
      pluginId: typeof rules.pluginId === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(rules.pluginId)
        ? rules.pluginId : "standard",
    },
    teams: normalizedTeams,
    sets,
    auditLog: Array.isArray(match.auditLog) ? match.auditLog : [],
    video: {
      fileName: isText(match.video?.fileName, 255) && !/[\\/]/.test(match.video.fileName) ? match.video.fileName : "",
      syncPoints: videoPoints,
      version: 1,
    },
  };
}

function validateStore(value) {
  if (!isPlainObject(value) || value.version !== 1
    || !Array.isArray(value.matches) || value.matches.length > MAX_MATCHES
    || !value.matches.every(validateMatch)
    || !Array.isArray(value.teamProfiles) || value.teamProfiles.length > MAX_TEAM_PROFILES
    || !value.teamProfiles.every((profile) => validateTeamProfile(profile, true))
    || !Array.isArray(value.tournaments) || value.tournaments.length > MAX_TOURNAMENTS
    || !Array.isArray(value.auditLog) || value.auditLog.length > MAX_AUDIT_ENTRIES
    || !value.auditLog.every(validateAuditEntry)
    || new Set(value.auditLog.map((entry) => entry.id)).size !== value.auditLog.length
    || !Array.isArray(value.plugins) || value.plugins.length > MAX_RULE_PLUGINS
    || !value.plugins.every(validateRulePlugin)
    || new Set(value.plugins.map((plugin) => plugin.id)).size !== value.plugins.length) return false;
  const matchIds = new Set(value.matches.map((match) => match.id));
  const tournamentMatchIds = value.tournaments.flatMap((tournament) => tournament.matchIds);
  return value.tournaments.every((tournament) => validateTournament(tournament, matchIds))
    && new Set(value.tournaments.map((tournament) => tournament.id)).size === value.tournaments.length
    && new Set(tournamentMatchIds).size === tournamentMatchIds.length;
}

function validateAuditEntry(entry) {
  return isPlainObject(entry)
    && isText(entry.id, 80)
    && isText(entry.time, 40)
    && isText(entry.matchId, 80)
    && isText(entry.matchName, 160)
    && ["add", "edit", "delete"].includes(entry.action)
    && isText(entry.entity, 40)
    && isText(entry.details, 240)
    && (entry.setNumber === undefined || Number.isInteger(entry.setNumber) && entry.setNumber >= 1 && entry.setNumber <= 5);
}

export function validateRulePlugin(plugin) {
  if (!isPlainObject(plugin) || !isText(plugin.id, 40) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(plugin.id)
    || !isText(plugin.name, 60) || !plugin.name.trim() || !isPlainObject(plugin.settings)
    || !Object.keys(plugin).every((key) => ["id", "name", "settings"].includes(key))) return false;
  const settings = plugin.settings;
  const profiles = ["six", "six-elementary", "nine", "beach", "soft"];
  const categories = ["一般", "大学", "高校", "中学校", "小学生", "マスターズ", "その他"];
  const divisions = ["男子", "女子", "混合", "その他"];
  const numericLimits = {
    winBy: [1, 10], timeoutLimit: [0, 10], substitutionLimit: [0, 30],
    rosterLimit: [1, 42], warmupMinutes: [0, 60], courtChangeInterval: [0, 99],
  };
  return Object.keys(settings).every((key) => [
    "matchProfile", "category", "division", "bestOf", "regularTarget", "finalTarget",
    ...Object.keys(numericLimits), "rotationEnabled", "technicalTimeoutPoints",
  ].includes(key))
    && (settings.matchProfile === undefined || profiles.includes(settings.matchProfile))
    && (settings.category === undefined || categories.includes(settings.category))
    && (settings.division === undefined || divisions.includes(settings.division))
    && (settings.bestOf === undefined || [3, 5].includes(settings.bestOf))
    && ["regularTarget", "finalTarget"].every((key) => settings[key] === undefined
      || Number.isInteger(settings[key]) && settings[key] >= 1 && settings[key] <= 99)
    && Object.entries(numericLimits).every(([key, [min, max]]) => settings[key] === undefined
      || Number.isInteger(settings[key]) && settings[key] >= min && settings[key] <= max)
    && (settings.rotationEnabled === undefined || typeof settings.rotationEnabled === "boolean")
    && (settings.technicalTimeoutPoints === undefined
      || Array.isArray(settings.technicalTimeoutPoints) && settings.technicalTimeoutPoints.length === 2
        && settings.technicalTimeoutPoints.every((point) => Number.isInteger(point) && point >= 0 && point <= 99));
}

export async function readStore() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    const objectStore = transaction.objectStore(DATABASE_STORE);
    let loadedStore;
    let migrated = false;
    let failure;
    const request = objectStore.getAll();
    request.onsuccess = () => {
      try {
        if (request.result.length) {
          loadedStore = storeFromRecords(request.result);
        } else {
          let legacyData;
          try {
            legacyData = localStorage.getItem(STORAGE_KEY);
          } catch (error) {
            throw new Error(`旧形式の保存データにアクセスできません: ${error.message}`);
          }
          if (legacyData) {
            let parsed;
            try {
              parsed = JSON.parse(legacyData);
            } catch {
              throw new Error("保存データを読み取れません。ブラウザーの保存領域が破損している可能性があります。");
            }
            loadedStore = upgradeStore(parsed);
            addStoreToTransaction(objectStore, loadedStore);
            migrated = true;
          } else {
            loadedStore = emptyStore();
          }
        }
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    request.onerror = () => {
      failure = request.error;
      transaction.abort();
    };
    transaction.oncomplete = () => {
      rememberPersistedMatches(loadedStore.matches);
      rememberPersistedAuditEntries(loadedStore.auditLog);
      if (migrated) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
          console.warn("Legacy score data remains in LocalStorage after migration:", error);
        }
      }
      resolve(loadedStore);
    };
    transaction.onabort = () => reject(failure || storageError(transaction.error));
    transaction.onerror = () => { failure ||= transaction.error; };
  });
}

export async function writeStore(store) {
  if (!validateStore(store)) {
    throw new Error("入力内容に不正な値があります。保存前の検証に失敗しました。");
  }

  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    const objectStore = transaction.objectStore(DATABASE_STORE);
    const matchKeys = new Set(store.matches.map((match) => `${MATCH_KEY_PREFIX}${match.id}`));
    const auditKeys = new Set(store.auditLog.map((entry) => `${AUDIT_KEY_PREFIX}${entry.id}`));
    let failure;
    const keysRequest = objectStore.getAllKeys();
    keysRequest.onsuccess = () => {
      try {
        keysRequest.result.forEach((key) => {
          if (typeof key === "string" && key.startsWith(MATCH_KEY_PREFIX) && !matchKeys.has(key)) {
            objectStore.delete(key);
          }
          if (typeof key === "string" && key.startsWith(AUDIT_KEY_PREFIX) && !auditKeys.has(key)) {
            objectStore.delete(key);
          }
        });
        objectStore.put({
          key: METADATA_KEY,
          value: {
            version: store.version,
            matchIds: store.matches.map((match) => match.id),
            teamProfiles: store.teamProfiles,
            tournaments: store.tournaments,
            plugins: store.plugins,
          },
        });
        store.matches.forEach((match) => {
          const serialized = JSON.stringify(match);
          if (persistedMatches.get(match.id) !== serialized) {
            objectStore.put({ key: `${MATCH_KEY_PREFIX}${match.id}`, value: match });
          }
        });
        store.auditLog.forEach((entry) => {
          const serialized = JSON.stringify(entry);
          if (persistedAuditEntries.get(entry.id) !== serialized) {
            objectStore.put({ key: `${AUDIT_KEY_PREFIX}${entry.id}`, value: entry });
          }
        });
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    keysRequest.onerror = () => {
      failure = keysRequest.error;
      transaction.abort();
    };
    transaction.oncomplete = () => {
      rememberPersistedMatches(store.matches);
      rememberPersistedAuditEntries(store.auditLog);
      resolve();
    };
    transaction.onabort = () => reject(storageError(failure || transaction.error));
    transaction.onerror = () => { failure ||= transaction.error; };
  });
}

export function validateImport(value) {
  const upgraded = upgradeMatch(value);
  return validateMatch(upgraded) ? upgraded : null;
}

export function validateStoreImport(value) {
  return upgradeStore(value);
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `match-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyMatch() {
  const now = new Date().toISOString();
  const id = createId();
  const teamA = createId();
  const teamB = createId();
  const teamStaffDefaults = () => ({
    gm: "",
    headCoach: "",
    coach1: "",
    coach2: "",
    swingCoach: "",
    performanceAnalyst: "",
    trainer1: "",
    trainer2: "",
    manager1: "",
    manager2: "",
    doctor1: "",
    doctor2: "",
  });
  return {
    schemaVersion: 1,
    id,
    createdAt: now,
    updatedAt: now,
    matchInfo: {
      tournamentName: "",
      matchDate: new Date().toISOString().slice(0, 10),
      venue: "",
      venueAddress: "",
      court: "",
      matchNumber: "",
      round: "",
      scheduledTime: "",
      startedAt: "",
      endedAt: "",
      referee1: "",
      referee2: "",
      scorer: "",
      officials: Object.fromEntries(OFFICIAL_ROLES.map((role) => [role, { name: "", area: "" }])),
    },
    rules: {
      bestOf: 5, regularTarget: 25, finalTarget: 15, setTargets: [25, 25, 25, 25, 15],
      matchProfile: "six", category: "一般", division: "男子", winBy: 2, timeoutLimit: 2,
      substitutionLimit: 6, technicalTimeoutPoints: [0, 0], rosterLimit: 30, courtChangeInterval: 8, courtChangeSets: [1, 2, 3, 4], rotationEnabled: true,
      warmupMinutes: 10, note: "", pluginId: "standard",
    },
    teams: [
      { id: teamA, name: "チーム A", uniformColor: "#1d4ed8", liberoUniformColor: "#facc15", staff: teamStaffDefaults(), players: [], rotationLineup: [] },
      { id: teamB, name: "チーム B", uniformColor: "#f97316", liberoUniformColor: "#22c55e", staff: teamStaffDefaults(), players: [], rotationLineup: [] },
    ],
    sets: [{ number: 1, initialServiceTeamId: teamA, startingLineups: { [teamA]: [], [teamB]: [] }, events: [] }],
    auditLog: [],
    video: { fileName: "", syncPoints: [], version: 1 },
  };
}

export function buildStore(matches, teamProfiles = [], tournaments = [], auditLog = [], plugins = []) {
  const unique = new Map();
  for (const match of matches) unique.set(match.id, match);
  const savedMatches = [...unique.values()].slice(0, MAX_MATCHES);
  const matchIds = new Set(savedMatches.map((match) => match.id));
  return {
    version: 1,
    matches: savedMatches,
    teamProfiles: teamProfiles.slice(0, MAX_TEAM_PROFILES),
    tournaments: tournaments.slice(0, MAX_TOURNAMENTS).map((tournament) => ({
      ...tournament,
      matchIds: tournament.matchIds.filter((id) => matchIds.has(id)),
      ...(Array.isArray(tournament.fixtures) ? {
        fixtures: tournament.fixtures.map((fixture) => ({
          ...fixture,
          ...(fixture.matchId && !matchIds.has(fixture.matchId) ? { matchId: "" } : {}),
        })),
      } : {}),
    })),
    auditLog: auditLog.slice(0, MAX_AUDIT_ENTRIES),
    plugins: plugins.slice(0, MAX_RULE_PLUGINS),
  };
}
