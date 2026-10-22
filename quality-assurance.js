import { createEmptyMatch, createId, validateMatch } from "./storage.js";

const TEAM_EVENT_TYPES = [
  "score",
  "substitution",
  "libero-substitution",
  "timeout",
  "technical-timeout",
  "challenge",
  "sanction",
  "service-order-violation",
];
const DATABASE_PREFIX = "jva-quality-assurance-";

function makeEvent(match, set, teamId, type, counter, details = {}) {
  return {
    id: createId(),
    time: new Date(Date.parse(match.createdAt) + counter * 1000).toISOString(),
    teamId,
    type,
    ...details,
  };
}

function addPoint(match, set, teamId, pointNumber, counter, serverState) {
  const opponent = match.teams.find((team) => team.id !== teamId);
  const playKinds = ["attack", "back-attack", "block", "serve"];
  const playType = playKinds[pointNumber % playKinds.length];
  const statPlayKind = playType === "back-attack" ? "backAttack" : playType;
  const player = match.teams.find((team) => team.id === teamId).players[pointNumber % 7];
  const event = makeEvent(match, set, teamId, "score", counter, {
    delta: 1,
    playType,
    statPlayKind,
    playerId: player.id,
    faultPlayerId: null,
    note: "",
    rotationAdvanced: serverState.teamId !== teamId,
  });
  set.events.push(event);
  if (serverState.teamId !== teamId) serverState.rotations[teamId] += 1;
  serverState.teamId = teamId;
  return event;
}

function addMixedEvent(match, set, index, counter, scoreEvent) {
  const team = match.teams[index % 2];
  const player = team.players[index % team.players.length];
  const otherPlayer = match.teams[1 - (index % 2)].players[index % match.teams[1 - (index % 2)].players.length];
  switch (TEAM_EVENT_TYPES[index % TEAM_EVENT_TYPES.length]) {
    case "score":
      return makeEvent(match, set, team.id, "rally-play", counter, {
        playKind: "attack",
        outcome: index % 3 === 0 ? "error" : "success",
        playerId: player.id,
        note: "",
      });
    case "substitution":
      return makeEvent(match, set, team.id, "substitution", counter, {
        playerOut: String(player.number).padStart(2, "0"),
        playerIn: String(team.players[(index + 1) % team.players.length].number).padStart(2, "0"),
      });
    case "libero-substitution":
      return makeEvent(match, set, team.id, "libero-substitution", counter, {
        playerOut: null,
        playerIn: null,
      });
    case "timeout":
      return makeEvent(match, set, team.id, "timeout", counter);
    case "technical-timeout":
      return makeEvent(match, set, team.id, "technical-timeout", counter, { triggerPoint: index % 25 });
    case "challenge":
      return makeEvent(match, set, team.id, "challenge", counter, {
        challengeType: "net-touch",
        result: index % 2 ? "failed" : "success",
        note: "",
      });
    case "sanction":
      return makeEvent(match, set, team.id, "sanction", counter, {
        player: String(player.number),
        sanctionType: "warning",
        subjectType: "player",
      });
    case "service-order-violation":
      return makeEvent(match, set, team.id, "service-order-violation", counter, {
        actualServerPlayerId: player.id,
        expectedServerPlayerId: otherPlayer.id,
        scoreEventId: scoreEvent.id,
      });
    default:
      throw new Error("Unsupported synthetic event type.");
  }
}

function addSyntheticRosters(match, matchIndex) {
  match.teams.forEach((team, teamIndex) => {
    team.name = `QA-Team-${matchIndex}-${teamIndex + 1}`;
    team.code = `QA${String(matchIndex).padStart(4, "0")}${teamIndex + 1}`;
    team.players = Array.from({ length: 7 }, (_, playerIndex) => ({
      id: createId(),
      number: String(playerIndex + 1),
      name: `QA Player ${playerIndex + 1}`,
      isCaptain: playerIndex === 0,
      isLibero: playerIndex === 6,
    }));
    team.rotationLineup = team.players.slice(0, 6).map((player) => player.id);
  });
  match.sets.forEach((set) => {
    set.startingLineups = Object.fromEntries(match.teams.map((team) => [team.id, [...team.rotationLineup]]));
  });
}

export function createQualityMatch({
  index = 0,
  eventCount = 221,
  fullMatch = true,
  syncPointCount = 10,
  longDeuce = false,
} = {}) {
  const match = createEmptyMatch();
  addSyntheticRosters(match, index);
  match.matchInfo.tournamentName = "Quality Assurance Synthetic Tournament";
  match.matchInfo.matchNumber = `QA-${index}`;
  match.matchInfo.startedAt = match.createdAt;
  match.matchInfo.endedAt = new Date(Date.parse(match.createdAt) + 90 * 60 * 1000).toISOString();
  match.sets = Array.from({ length: 5 }, (_, setIndex) => ({
    number: setIndex + 1,
    initialServiceTeamId: match.teams[setIndex % 2].id,
    startingLineups: Object.fromEntries(match.teams.map((team) => [team.id, [...team.rotationLineup]])),
    events: [],
    startedAt: match.createdAt,
    endedAt: "",
  }));
  match.rules.bestOf = 5;
  match.rules.setTargets = [25, 25, 25, 25, 15];
  match.rules.rotationEnabled = true;
  match.rules.timeoutLimit = 10;
  match.rules.substitutionLimit = 30;

  let eventCounter = 0;
  const scoredEvents = [];
  const targetScores = longDeuce
    ? [[50, 48], [48, 50], [52, 50], [20, 25], [15, 13]]
    : [[25, 22], [22, 25], [25, 22], [22, 25], [15, 13]];
  if (fullMatch) {
    match.sets.forEach((set, setIndex) => {
      const [scoreA, scoreB] = targetScores[setIndex];
      const pointTotals = [scoreA, scoreB];
      const serverState = { teamId: set.initialServiceTeamId, rotations: Object.fromEntries(match.teams.map((team) => [team.id, 0])) };
      for (let point = 0; point < Math.max(...pointTotals); point += 1) {
        for (let teamIndex = 0; teamIndex < 2; teamIndex += 1) {
          if (point >= pointTotals[teamIndex]) continue;
          const event = addPoint(match, set, match.teams[teamIndex].id, point, eventCounter++, serverState);
          scoredEvents.push({ event, set });
        }
      }
    });
  } else {
    const set = match.sets[0];
    const serverState = { teamId: set.initialServiceTeamId, rotations: Object.fromEntries(match.teams.map((team) => [team.id, 0])) };
    scoredEvents.push({
      event: addPoint(match, set, match.teams[0].id, 0, eventCounter++, serverState),
      set,
    });
  }

  const existingEventCount = match.sets.reduce((total, set) => total + set.events.length, 0);
  const extraCount = Math.max(0, eventCount - existingEventCount);
  const mixedSet = match.sets[0];
  const scoreEvent = scoredEvents[0]?.event;
  for (let indexInExtra = 0; indexInExtra < extraCount; indexInExtra += 1) {
    if (mixedSet.events.length >= 2_000) {
      const destination = match.sets.find((set) => set.events.length < 2_000);
      if (!destination) throw new Error("Synthetic event count exceeds the five-set limit.");
      destination.events.push(addMixedEvent(match, destination, indexInExtra, eventCounter++, scoreEvent));
    } else {
      mixedSet.events.push(addMixedEvent(match, mixedSet, indexInExtra, eventCounter++, scoreEvent));
    }
  }

  const orderedEvents = match.sets.flatMap((set) => set.events);
  const pointCount = Math.min(10_000, Math.max(0, Math.floor(syncPointCount)));
  match.video = {
    fileName: `quality-match-${index}.mp4`,
    version: 1,
    syncPoints: Array.from({ length: Math.min(pointCount, orderedEvents.length) }, (_, pointIndex) => {
      const eventIndex = pointCount <= 1
        ? 0
        : Math.floor(pointIndex * (orderedEvents.length - 1) / (Math.min(pointCount, orderedEvents.length) - 1));
      const event = orderedEvents[eventIndex];
      return {
        eventId: event.id,
        videoTime: (Date.parse(event.time) - Date.parse(match.createdAt)) / 1000 + 8.5,
      };
    }),
  };
  return match;
}

export function createQualityEventMatch(eventCount) {
  return createQualityMatch({ eventCount, fullMatch: false, syncPointCount: 10 });
}

export function isQualityMatchValid(match) {
  return validateMatch(match);
}

export function openQualityDatabase() {
  if (!globalThis.indexedDB) throw new Error("このブラウザーはIndexedDBに対応していません。");
  const databaseName = `${DATABASE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const objectStore = request.result.createObjectStore("records", { keyPath: "id" });
      objectStore.createIndex("kind", "kind", { unique: false });
      objectStore.createIndex("teamId", "teamId", { unique: false });
      objectStore.createIndex("seasonId", "seasonId", { unique: false });
    };
    request.onsuccess = () => resolve({ databaseName, database: request.result });
    request.onerror = () => reject(request.error || new Error("試験用DBを作成できませんでした。"));
    request.onblocked = () => reject(new Error("別のタブが試験用DBの削除を妨げています。"));
  });
}

function runTransaction(database, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("records", "readwrite");
    const store = transaction.objectStore("records");
    let result;
    try {
      result = operation(store);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("試験用DB transaction が中断されました。"));
    transaction.onerror = () => reject(transaction.error || new Error("試験用DB transaction に失敗しました。"));
  });
}

export async function writeQualityRecords(database, records, batchSize = 250) {
  let written = 0;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    await runTransaction(database, (store) => batch.forEach((record) => store.put(record)));
    written += batch.length;
  }
  return written;
}

export function readQualityRecords(database, kind) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("records", "readonly");
    const request = kind
      ? transaction.objectStore("records").index("kind").getAll(IDBKeyRange.only(kind))
      : transaction.objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("試験用DBの読込に失敗しました。"));
  });
}

export function searchQualityRecords(database, indexName, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("records", "readonly");
    const request = transaction.objectStore("records").index(indexName).getAll(IDBKeyRange.only(key));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("試験用DBの検索に失敗しました。"));
  });
}

export function deleteQualityDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("試験用DBを削除できませんでした。"));
    request.onblocked = () => reject(new Error("試験用DBの削除が別タブによりブロックされました。"));
  });
}

export function* createQualityStressRecords({ teamCount = 500, seasonCount = 100, playerCount = 50_000, eventCount = 500_000 } = {}) {
  const playerCountPerTeam = Math.ceil(playerCount / teamCount);
  const playersPerRecord = 500;
  for (let teamIndex = 0; teamIndex < teamCount; teamIndex += 1) {
    const players = Array.from({ length: playerCountPerTeam }, (_, playerIndex) => [
      `player-${teamIndex}-${playerIndex}`,
      (teamIndex + playerIndex) % seasonCount,
    ]);
    for (let offset = 0; offset < players.length; offset += playersPerRecord) {
      yield {
        id: `players-${teamIndex}-${offset}`,
        kind: "players",
        teamId: `team-${teamIndex}`,
        seasonId: `season-${teamIndex % seasonCount}`,
        entities: players.slice(offset, offset + playersPerRecord),
      };
    }
  }
  const eventsPerRecord = 500;
  const eventTypes = ["score", "substitution", "libero-substitution", "timeout",
    "technical-timeout", "challenge", "sanction", "service-order-violation"];
  const eventRecordCount = Math.ceil(eventCount / eventsPerRecord);
  for (let offset = 0; offset < eventCount; offset += eventsPerRecord) {
    const eventRecordIndex = offset / eventsPerRecord;
    const teamIndex = eventRecordCount <= 1
      ? 0
      : Math.floor(eventRecordIndex * (teamCount - 1) / (eventRecordCount - 1));
    const length = Math.min(eventsPerRecord, eventCount - offset);
    yield {
      id: `events-${offset}`,
      kind: "events",
      teamId: `team-${teamIndex}`,
      seasonId: `season-${teamIndex % seasonCount}`,
      entities: Array.from({ length }, (_, index) => [
        offset + index,
        eventTypes[(offset + index) % eventTypes.length],
      ]),
    };
  }
  for (let teamIndex = 0; teamIndex < teamCount; teamIndex += 1) {
    yield {
      id: `team-${teamIndex}`,
      kind: "teams",
      teamId: `team-${teamIndex}`,
      seasonId: `season-${teamIndex % seasonCount}`,
    };
  }
  for (let seasonIndex = 0; seasonIndex < seasonCount; seasonIndex += 1) {
    yield {
      id: `season-${seasonIndex}`,
      kind: "seasons",
      teamId: "",
      seasonId: `season-${seasonIndex}`,
    };
  }
}
