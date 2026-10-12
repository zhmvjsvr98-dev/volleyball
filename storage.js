const STORAGE_KEY = "jva-electronic-score-sheet";
const MAX_MATCHES = 100;
const MAX_STORAGE_BYTES = 2_000_000;
const MAX_EVENTS_PER_SET = 2_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength;
}

function validatePlayer(player) {
  return isPlainObject(player)
    && isText(player.id, 80)
    && isText(player.number, 3)
    && isText(player.name, 60)
    && typeof player.isCaptain === "boolean";
}

function validateEvent(event, validTeamIds) {
  if (!isPlainObject(event) || !isText(event.id, 80) || !isText(event.time, 40)
    || !validTeamIds.has(event.teamId) || !isText(event.type, 20)) return false;
  if (event.type === "score") return event.delta === 1 || event.delta === -1;
  if (event.type === "timeout") return true;
  if (event.type === "substitution") {
    return isText(event.playerOut, 3) && isText(event.playerIn, 3);
  }
  if (event.type === "sanction") {
    return isText(event.player, 20)
      && ["warning", "penalty", "expulsion", "disqualification"].includes(event.sanctionType);
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
  if (!["tournamentName", "matchDate", "venue", "referee1", "referee2", "scorer"]
    .every((key) => isText(info[key], key === "tournamentName" || key === "venue" ? 80 : 60))) return false;

  const rules = match.rules;
  if (![3, 5].includes(rules.bestOf)
    || !Number.isInteger(rules.regularTarget) || rules.regularTarget < 1 || rules.regularTarget > 99
    || !Number.isInteger(rules.finalTarget) || rules.finalTarget < 1 || rules.finalTarget > 99
    || !Number.isInteger(rules.timeoutLimit) || rules.timeoutLimit < 0 || rules.timeoutLimit > 10) return false;

  // Storageや読み込みファイルの内容は信頼せず、保存するたびに構造から検証します。
  const teamIds = new Set();
  for (const team of match.teams) {
    if (!isPlainObject(team) || !isText(team.id, 80) || !isText(team.name, 60)
      || !Array.isArray(team.players) || team.players.length > 30
      || !team.players.every(validatePlayer)) return false;
    if (teamIds.has(team.id)) return false;
    teamIds.add(team.id);
    const numbers = team.players.map((player) => player.number).filter(Boolean);
    const playerIds = team.players.map((player) => player.id);
    if (new Set(numbers).size !== numbers.length
      || new Set(playerIds).size !== playerIds.length
      || team.players.filter((player) => player.isCaptain).length > 1) return false;
  }

  if (match.sets.length > rules.bestOf) return false;
  return match.sets.every((set, index) => {
    if (!isPlainObject(set) || set.number !== index + 1 || !Array.isArray(set.events)
      || set.events.length > MAX_EVENTS_PER_SET || !set.events.every((event) => validateEvent(event, teamIds))) return false;
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

function validateStore(value) {
  return isPlainObject(value) && value.version === 1
    && Array.isArray(value.matches) && value.matches.length <= MAX_MATCHES
    && value.matches.every(validateMatch);
}

export function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, matches: [] };
    const parsed = JSON.parse(raw);
    if (!validateStore(parsed)) throw new Error("保存データの形式が正しくありません。データ書き出しファイルから復元してください。");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("保存データを読み取れません。ブラウザーの保存領域が破損している可能性があります。");
    }
    throw error;
  }
}

export function writeStore(store) {
  if (!validateStore(store)) throw new Error("入力内容に不正な値があります。保存前の検証に失敗しました。");
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
  return validateMatch(value);
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
  return {
    schemaVersion: 1,
    id,
    createdAt: now,
    updatedAt: now,
    matchInfo: {
      tournamentName: "",
      matchDate: new Date().toISOString().slice(0, 10),
      venue: "",
      referee1: "",
      referee2: "",
      scorer: "",
    },
    rules: { bestOf: 5, regularTarget: 25, finalTarget: 15, timeoutLimit: 2 },
    teams: [
      { id: teamA, name: "チーム A", players: [] },
      { id: teamB, name: "チーム B", players: [] },
    ],
    sets: [{ number: 1, events: [] }],
  };
}

export function buildStore(matches) {
  const unique = new Map();
  for (const match of matches) unique.set(match.id, match);
  return { version: 1, matches: [...unique.values()].slice(0, MAX_MATCHES) };
}
