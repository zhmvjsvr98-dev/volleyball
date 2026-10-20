const STORAGE_KEY = "jva-electronic-score-sheet";
const MAX_MATCHES = 100;
const MAX_TEAM_PROFILES = 100;
const MAX_STORAGE_BYTES = 2_000_000;
const MAX_EVENTS_PER_SET = 2_000;
const OFFICIAL_ROLES = ["firstReferee", "secondReferee", "scorer", "assistantScorer", "lineJudge1", "lineJudge2", "lineJudge3", "lineJudge4"];

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
    && typeof player.isLibero === "boolean";
}

function validateTeamProfile(profile, requireSavedAt = false) {
  if (
    !isPlainObject(profile)
    || !isText(profile.id, 80)
    || !isText(profile.name, 60)
    || !profile.name.trim()
    || (requireSavedAt && !isText(profile.savedAt, 40))
    || (profile.savedAt !== undefined && !isText(profile.savedAt, 40))
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

function validateEvent(event, validTeamIds) {
  if (!isPlainObject(event) || !isText(event.id, 80) || !isText(event.time, 40)
    || !validTeamIds.has(event.teamId) || !isText(event.type, 20)) return false;
  if (event.type === "score") {
    if (event.delta !== 1 && event.delta !== -1) return false;
    if (event.correctionOf !== undefined && !isText(event.correctionOf, 80)) return false;
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
  if (event.type === "rally-play") {
    return ["serve", "reception", "serveReception", "attackReception", "set", "attack", "backAttack", "block", "error", "other"].includes(event.playKind)
      && ["success", "point", "error", "touch", "effective", "excellent", "good", "other"].includes(event.outcome)
      && (event.playerId === null || isText(event.playerId, 80))
      && isText(event.note || "", 120);
  }
  if (event.type === "substitution") {
    return isText(event.playerOut, 3) && isText(event.playerIn, 3);
  }
  if (event.type === "libero-substitution") {
    return (event.playerOut === null || isText(event.playerOut, 20)) && (event.playerIn === null || isText(event.playerIn, 20));
  }
  if (event.type === "sanction") {
  return isText(event.player, 20)
    && ["warning", "penalty", "expulsion", "disqualification"].includes(event.sanctionType);
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

  const info = match.matchInfo;
  if (!["tournamentName", "matchDate", "venue", "court", "matchNumber", "round", "scheduledTime", "startedAt", "endedAt", "referee1", "referee2", "scorer"]
    .every((key) => isText(info[key], ["tournamentName", "venue"].includes(key) ? 80
      : ["referee1", "referee2", "scorer"].includes(key) ? 60
        : key === "matchDate" ? 10 : key === "round" ? 40 : key === "court" || key === "matchNumber" ? 20 : key === "scheduledTime" ? 5 : 40))) return false;
  if (info.matchDate && (!/^\d{4}-\d{2}-\d{2}$/.test(info.matchDate)
    || new Date(info.matchDate).toISOString().slice(0, 10) !== info.matchDate)) return false;
  if (!isPlainObject(info.officials) || !OFFICIAL_ROLES.every((role) => isPlainObject(info.officials[role])
    && isText(info.officials[role].name, 60) && isText(info.officials[role].area, 40))) return false;

  const rules = match.rules;
  if (![3, 5].includes(rules.bestOf)
    || !["six", "nine", "beach", "soft"].includes(rules.matchProfile)
    || !isText(rules.category, 30) || !isText(rules.division, 20) || !isText(rules.note, 240)
    || !Array.isArray(rules.setTargets) || rules.setTargets.length !== 5
    || !rules.setTargets.every((target) => Number.isInteger(target) && target >= 1 && target <= 99)
    || !Number.isInteger(rules.winBy) || rules.winBy < 1 || rules.winBy > 10
    || !Number.isInteger(rules.timeoutLimit) || rules.timeoutLimit < 0 || rules.timeoutLimit > 10
    || !Number.isInteger(rules.substitutionLimit) || rules.substitutionLimit < 0 || rules.substitutionLimit > 30
    || !Number.isInteger(rules.rosterLimit) || rules.rosterLimit < 1 || rules.rosterLimit > 42
    || !Number.isInteger(rules.courtChangeInterval) || rules.courtChangeInterval < 0 || rules.courtChangeInterval > 99
    || !Number.isInteger(rules.warmupMinutes) || rules.warmupMinutes < 0 || rules.warmupMinutes > 60
    || typeof rules.rotationEnabled !== "boolean") return false;

  // Storageや読み込みファイルの内容は信頼せず、保存するたびに構造から検証します。
  const teamIds = new Set();
  const playerIdsByTeam = new Map();
  for (const team of match.teams) {
    if (!validateTeamProfile(team)) return false;
    if (teamIds.has(team.id)) return false;
    teamIds.add(team.id);
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
  });
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
    uniformColor: isText(team?.uniformColor, 20) ? team.uniformColor : "#1d4ed8",
    liberoUniformColor: isText(team?.liberoUniformColor, 20) ? team.liberoUniformColor : "#facc15",
    staff: isPlainObject(team?.staff) ? team.staff : {},
    players: Array.isArray(team?.players) ? team.players.map((player) => ({
      ...player,
      isCaptain: Boolean(player?.isCaptain),
      isLibero: Boolean(player?.isLibero),
    })) : [],
  }));
  const sets = Array.isArray(match.sets) ? match.sets.map((set, index) => ({
    ...set,
    initialServiceTeamId: teamIds.includes(set.initialServiceTeamId) ? set.initialServiceTeamId : teamIds[0],
    startedAt: typeof set.startedAt === "string" ? set.startedAt : "",
    endedAt: typeof set.endedAt === "string" ? set.endedAt : "",
    startingLineups: isPlainObject(set.startingLineups) ? set.startingLineups : Object.fromEntries((teams || []).map((team) => [team.id, team.rotationLineup])),
  })) : match.sets;
  return {
    ...match,
    matchInfo: {
      ...oldInfo,
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
      matchProfile: ["six", "nine"].includes(rules.matchProfile) ? rules.matchProfile : "six",
      category: typeof rules.category === "string" ? rules.category : "一般",
      division: typeof rules.division === "string" ? rules.division : "男子",
      setTargets: Array.isArray(rules.setTargets) && rules.setTargets.length === 5
        ? rules.setTargets : Array.from({ length: 5 }, (_, index) => index === bestOf - 1 ? finalTarget : regularTarget),
      winBy: Number.isInteger(rules.winBy) ? rules.winBy : 2,
      timeoutLimit: Number.isInteger(rules.timeoutLimit) ? rules.timeoutLimit : 2,
      substitutionLimit: Number.isInteger(rules.substitutionLimit) ? rules.substitutionLimit : 6,
      rosterLimit: Number.isInteger(rules.rosterLimit) ? rules.rosterLimit : 30,
      courtChangeInterval: Number.isInteger(rules.courtChangeInterval) ? rules.courtChangeInterval : 8,
      rotationEnabled: typeof rules.rotationEnabled === "boolean" ? rules.rotationEnabled : true,
      warmupMinutes: Number.isInteger(rules.warmupMinutes) ? rules.warmupMinutes : 10,
      note: typeof rules.note === "string" ? rules.note.slice(0, 240) : "",
    },
    teams: normalizedTeams,
    sets,
  };
}

function validateStore(value) {
  return isPlainObject(value) && value.version === 1
    && Array.isArray(value.matches) && value.matches.length <= MAX_MATCHES
    && value.matches.every(validateMatch)
    && Array.isArray(value.teamProfiles) && value.teamProfiles.length <= MAX_TEAM_PROFILES
    && value.teamProfiles.every((profile) => validateTeamProfile(profile, true));
}

export function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, matches: [], teamProfiles: [] };
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.matches)) {
      throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
    }
    const upgraded = {
      ...parsed,
      matches: parsed.matches.map(upgradeMatch),
      teamProfiles: Array.isArray(parsed.teamProfiles) ? parsed.teamProfiles : [],
    };
    if (!validateStore(upgraded)) throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
    return upgraded;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("保存データを読み取れません。ブラウザーの保存領域が破損している可能性があります。");
    }
    throw error;
  }
}

export function writeStore(store) {

  const valid = validateStore(store);

  if (!valid) {
    console.log("STORE ERROR", structuredClone(store));
    throw new Error("入力内容に不正な値があります。保存前の検証に失敗しました。");
  }

  const serialized = JSON.stringify(store);
  if (serialized.length > MAX_STORAGE_BYTES) throw new Error("保存できるデータ量の上限を超えました。試合データを書き出してください。");
  // localStorageは容量不足やブラウザー設定で例外を投げることがあります。
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
      throw new Error("ブラウザーの保存容量が不足しています。試合データを書き出してから不要な履歴を削除してください。");
    }
    throw new Error(`自動保存に失敗しました: ${error.message}`);
  }
}

export function validateImport(value) {
  const upgraded = upgradeMatch(value);
  return validateMatch(upgraded) ? upgraded : null;
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
      substitutionLimit: 6, rosterLimit: 30, courtChangeInterval: 8, rotationEnabled: true,
      warmupMinutes: 10, note: "",
    },
    teams: [
      { id: teamA, name: "チーム A", uniformColor: "#1d4ed8", liberoUniformColor: "#facc15", staff: teamStaffDefaults(), players: [], rotationLineup: [] },
      { id: teamB, name: "チーム B", uniformColor: "#f97316", liberoUniformColor: "#22c55e", staff: teamStaffDefaults(), players: [], rotationLineup: [] },
    ],
    sets: [{ number: 1, initialServiceTeamId: teamA, startingLineups: { [teamA]: [], [teamB]: [] }, events: [] }],
  };
}

export function buildStore(matches, teamProfiles = []) {
  const unique = new Map();
  for (const match of matches) unique.set(match.id, match);
  return {
    version: 1,
    matches: [...unique.values()].slice(0, MAX_MATCHES),
    teamProfiles: teamProfiles.slice(0, MAX_TEAM_PROFILES),
  };
}
