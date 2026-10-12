// 得点イベントからセットの状態を計算します。画面側に得点計算を分散させません。
export function getSetTarget(match, setNumber) {
  // 3セット/5セットのどちらでも、その試合形式の最終セットだけ別の目標点を使います。
  return match.rules.setTargets?.[setNumber - 1]
    ?? (setNumber === match.rules.bestOf ? match.rules.finalTarget : match.rules.regularTarget);
}

export function getDecidingSetCourtChangePoint(match, setNumber) {
  if (setNumber !== match.rules.bestOf) return 0;
  if (match.rules.category === "小学生" && match.rules.bestOf === 3) return 8;
  const target = getSetTarget(match, setNumber);
  if (target === 25) return 13;
  if (target === 21) return 8;
  return Math.ceil(target / 2);
}

export function getScore(set, teamId) {
  return set.events.reduce((score, event) => {
    if (event.type === "score" && event.teamId === teamId) return score + event.delta;
    return score;
  }, 0);
}

export function getSetResult(match, set) {
  const scoreA = getScore(set, match.teams[0].id);
  const scoreB = getScore(set, match.teams[1].id);
  const target = getSetTarget(match, set.number);
  // セット獲得は目標点到達だけでなく2点差も必要です。
  if (Math.max(scoreA, scoreB) < target || Math.abs(scoreA - scoreB) < match.rules.winBy) return null;
  return scoreA > scoreB ? match.teams[0].id : match.teams[1].id;
}

export function getSetWins(match) {
  return match.teams.map((team) => ({
    teamId: team.id,
    wins: match.sets.filter((set) => getSetResult(match, set) === team.id).length,
  }));
}

export function isMatchComplete(match) {
  const winsNeeded = Math.floor(match.rules.bestOf / 2) + 1;
  return getSetWins(match).some((entry) => entry.wins >= winsNeeded);
}

export function canScore(match) {
  const current = match.sets.at(-1);
  return Boolean(current) && !isMatchComplete(match) && !getSetResult(match, current);
}

export function usesCourtRotation(match) {
  return match.rules.matchProfile === "six"
    && match.rules.category !== "小学生"
    && match.rules.rotationEnabled;
}

export function getServingState(match, set) {
  let server = set.initialServiceTeamId || match.teams[0].id;
  const rotations = Object.fromEntries(match.teams.map((team) => [team.id, 0]));
  const serviceTurns = Object.fromEntries(match.teams.map((team) => [team.id, team.id === server ? 1 : 0]));
  const correctedEvents = new Set(set.events
    .filter((event) => event.type === "score" && event.delta < 0 && event.correctionOf)
    .map((event) => event.correctionOf));
  for (const event of set.events) {
    if (event.type !== "score" || event.delta < 0 || correctedEvents.has(event.id)) continue;
    if (server !== event.teamId) {
      rotations[event.teamId] += 1;
      serviceTurns[event.teamId] += 1;
    }
    server = event.teamId;
  }
  return { server, rotations, serviceTurns };
}

export function getCurrentLineup(match, set, teamId) {
  const team = match.teams.find((item) => item.id === teamId);
  const lineup = set.startingLineups?.[teamId]?.length ? set.startingLineups[teamId] : team?.rotationLineup || [];
  const { rotations } = getServingState(match, set);
  if (!usesCourtRotation(match)) {
    return Array.from({ length: match.rules.matchProfile === "nine" ? 9 : 6 }, (_, index) => lineup[index] || "");
  }
  const count = match.rules.matchProfile === "nine" ? 9 : 6;
  const normalized = Array.from({ length: count }, (_, index) => lineup[index] || "");
  const turns = (rotations[teamId] || 0) % count;
  return turns ? [...normalized.slice(turns), ...normalized.slice(0, turns)] : normalized;
}

export function getEventDescription(match, event) {
  const team = match.teams.find((item) => item.id === event.teamId);
  const teamName = team?.name || "チーム";
  if (event.type === "score") {
    if (event.delta < 0) return `${teamName} 得点訂正 -1`;
    const plays = { serve: "サービスエース", attack: "アタック", "back-attack": "バックアタック", block: "ブロック", "opponent-error": "相手のミス", penalty: "反則・ペナルティ", other: "その他" };
    const player = match.teams.flatMap((item) => item.players).find((item) => item.id === event.playerId);
    const faultPlayer = match.teams.flatMap((item) => item.players).find((item) => item.id === event.faultPlayerId);
    const detail = [
      plays[event.playType] || "プレー未選択",
      player ? `#${player.number} ${player.name}` : "",
      faultPlayer ? `相手 #${faultPlayer.number} ${faultPlayer.name}` : "",
      event.note || "",
    ].filter(Boolean).join(" / ");
    return `${teamName} +1 得点 (${detail})`;
  }
  if (event.type === "timeout") return `${teamName} タイムアウト`;
  if (event.type === "sto") return `${teamName} STO（セーフティタイムアウト・タイムアウト回数には含めない）`;
  if (event.type === "court-change") {
    return event.reason === "set-end"
      ? `第${event.setNumber || ""}セット終了後のコートチェンジ`
      : `コートチェンジ（第${event.setNumber || ""}セット ${event.triggerScore || event.totalPoints}点）`;
  }
  if (event.type === "challenge") {
    const challenges = {
      "net-touch": "ネットタッチ", "block-touch": "ブロックタッチ",
      antenna: "アンテナ接触", "ball-in-out": "イン / アウト",
      "foot-fault": "フットフォルト", other: "その他",
    };
    return `${teamName} チャレンジ: ${challenges[event.challengeType] || "その他"} / ${event.result === "success" ? "成功" : "失敗"}${event.note ? ` / ${event.note}` : ""}`;
  }
  if (event.type === "rally-play") {
    const player = team?.players.find((item) => item.id === event.playerId);
    const kinds = {
      serve: "サーブ", reception: "サーブレシーブ", set: "トス",
      attack: "アタック", backAttack: "バックアタック", block: "ブロック",
      error: "ミス", other: "その他",
    };
    const outcomes = {
      success: "成功・継続", point: "得点", error: "失点・ミス",
      touch: "タッチ・継続", effective: "効果あり", excellent: "レシーブ優",
      good: "レシーブ良", other: "その他",
    };
    return `${teamName} ${player ? `#${player.number} ${player.name} ` : ""}${kinds[event.playKind] || "プレー"}: ${outcomes[event.outcome] || ""}${event.note ? ` / ${event.note}` : ""}`.trim();
  }
  if (event.type === "substitution") return `${teamName} 選手交代 ${event.playerOut} → ${event.playerIn}`;
  if (event.type === "sanction") {
    const labels = { warning: "警告", penalty: "ペナルティ", expulsion: "退場", disqualification: "失格" };
    return `${teamName} ${labels[event.sanctionType] || "処置"}（${event.player}）`;
  }
  if (event.type === "play") {
    const player = team?.players.find((item) => item.id === event.playerId);
    const kinds = { attack: "アタック", backAttack: "バックアタック", block: "ブロック", serve: "サーブ", reception: "サーブレシーブ" };
    const outcomes = {
      point: "得点", error: "失点", continued: "ラリー継続", touch: "タッチ / 継続",
      effective: "効果あり", excellent: "成功（優）", good: "成功（良）", other: "その他 / 失敗",
    };
    return `${teamName} ${kinds[event.playKind] || "プレー"} ${player ? `#${player.number} ${player.name}` : ""} ${outcomes[event.outcome] || "記録"}${event.note ? ` / ${event.note}` : ""}`.trim();
  }
  return "記録";
}
