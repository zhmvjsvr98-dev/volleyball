// 得点イベントからセットの状態を計算します。画面側に得点計算を分散させません。
export function getSetTarget(match, setNumber) {
  // 3セット/5セットのどちらでも、その試合形式の最終セットだけ別の目標点を使います。
  return setNumber === match.rules.bestOf ? match.rules.finalTarget : match.rules.regularTarget;
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
  if (Math.max(scoreA, scoreB) < target || Math.abs(scoreA - scoreB) < 2) return null;
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

export function getEventDescription(match, event) {
  const team = match.teams.find((item) => item.id === event.teamId);
  const teamName = team?.name || "チーム";
  if (event.type === "score") return `${teamName} ${event.delta > 0 ? "+1 得点" : "-1 得点"}`;
  if (event.type === "timeout") return `${teamName} タイムアウト`;
  if (event.type === "substitution") return `${teamName} 選手交代 ${event.playerOut} → ${event.playerIn}`;
  if (event.type === "sanction") {
    const labels = { warning: "警告", penalty: "ペナルティ", expulsion: "退場", disqualification: "失格" };
    return `${teamName} ${labels[event.sanctionType] || "処置"}（${event.player}）`;
  }
  return "記録";
}
