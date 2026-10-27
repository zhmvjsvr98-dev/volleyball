// 得点イベントからセットの状態を計算します。画面側に得点計算を分散させません。
export function getSetTarget(match, setNumber) {
  return match.rules.setTargets?.[setNumber - 1]
    ?? (setNumber === match.rules.bestOf ? match.rules.finalTarget : match.rules.regularTarget);
}

export function getDefaultSetTargets(matchProfile, bestOf) {
  if (matchProfile === "six" && bestOf === 5) return [25, 25, 25, 25, 15];
  if (matchProfile === "six") return [25, 25, 15, 25, 15];
  if (matchProfile === "soft") return [15, 15, 15, 15, 15];
  return [21, 21, 15, 21, 15];
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
  if (match.rules.matchProfile === "soft") {
    if (scoreA === scoreB) return null;
    if (Math.max(scoreA, scoreB) < 17
      && (Math.max(scoreA, scoreB) < target || Math.abs(scoreA - scoreB) < 2)) return null;
    return scoreA > scoreB ? match.teams[0].id : match.teams[1].id;
  }
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

export function getCourtPlayerCount(match) {
  if (match.rules.matchProfile === "beach") return 2;
  return match.rules.matchProfile === "nine" ? 9 : 6;
}

function getServingStateAndSubstitutions(match, set, lineupTeamId) {
  let server = set.initialServiceTeamId || match.teams[0].id;
  const rotations = Object.fromEntries(match.teams.map((team) => [team.id, 0]));
  const serviceTurns = Object.fromEntries(match.teams.map((team) => [team.id, team.id === server ? 1 : 0]));
  let serveFaults = 0;
  const substitutions = [];
  const correctedEvents = new Set();
  for (const event of set.events) {
    if (event.type === "score" && event.delta < 0 && event.correctionOf) {
      correctedEvents.add(event.correctionOf);
    }
  }
  for (const event of set.events) {
    if (event.teamId === lineupTeamId && ["substitution", "libero-substitution"].includes(event.type)) {
      substitutions.push(event);
    }
    if (event.type === "serve-fault" && event.teamId === server) {
      serveFaults = event.attempt;
      continue;
    }
    if (event.type !== "score" || event.delta < 0 || correctedEvents.has(event.id)) continue;
    if (server !== event.teamId) {
      rotations[event.teamId] += 1;
      serviceTurns[event.teamId] += 1;
    }
    server = event.teamId;
    serveFaults = 0;
  }
  return { server, rotations, serviceTurns, serveFaults, substitutions };
}

export function getServingState(match, set) {
  const { server, rotations, serviceTurns, serveFaults } = getServingStateAndSubstitutions(match, set);
  return { server, rotations, serviceTurns, serveFaults };
}

export function getCurrentLineup(match, set, teamId) {
  const team = match.teams.find((item) => item.id === teamId);
  const lineup = set.startingLineups?.[teamId]?.length ? set.startingLineups[teamId] : team?.rotationLineup || [];
  const { rotations, substitutions } = getServingStateAndSubstitutions(match, set, teamId);
  const count = getCourtPlayerCount(match);
  const normalized = Array.from({ length: count }, (_, index) => lineup[index] || "");
  if (usesCourtRotation(match)) {
    const turns = (rotations[teamId] || 0) % count;
    if (turns) normalized.push(...normalized.splice(0, turns));
  }

  const playersByNumber = new Map();
  const playersByName = new Map();
  const playerOrder = new Map();
  team?.players.forEach((player, index) => {
    if (!playersByNumber.has(player.number)) playersByNumber.set(player.number, player);
    if (!playersByName.has(player.name.trim())) playersByName.set(player.name.trim(), player);
    playerOrder.set(player.id, index);
  });
  const findPlayer = (label) => {
    const value = String(label);
    const byNumber = playersByNumber.get(value);
    const byName = playersByName.get(value.trim());
    if (!byNumber) return byName;
    if (!byName) return byNumber;
    return playerOrder.get(byNumber.id) <= playerOrder.get(byName.id) ? byNumber : byName;
  };
  for (const event of substitutions) {
    const outgoing = findPlayer(event.playerOut);
    const incoming = findPlayer(event.playerIn);
    if (!outgoing || !incoming || normalized.includes(incoming.id)) continue;
    const position = normalized.indexOf(outgoing.id);
    if (position >= 0) normalized[position] = incoming.id;
  }
  return normalized;
}

export function getEventDescription(match, event) {
  const team = match.teams.find((item) => item.id === event.teamId);
  const teamName = team?.name || "チーム";
  const scoreSuffix = event.currentScore ? ` [現在 ${event.currentScore}]` : "";
  if (event.type === "score") {
    if (event.delta < 0) {
      const sourceLabels = { challenge: "チャレンジ判定", scorer: "記録訂正", other: "その他" };
      const correction = event.correctionReason
        ? `（${sourceLabels[event.correctionSource] || "訂正"}: ${event.correctionReason}）`
        : "";
      return `${teamName} 得点訂正 -1${correction}${scoreSuffix}`;
    }
    if (event.correctionSource) {
      const sourceLabels = { challenge: "チャレンジ判定", scorer: "記録訂正", other: "その他" };
      return `${teamName} 得点訂正 +1（${sourceLabels[event.correctionSource] || "訂正"}: ${event.correctionReason || "得点を追加"}）${scoreSuffix}`;
    }
    const plays = { serve: "サービスエース", attack: "アタック", "back-attack": "バックアタック", block: "ブロック", "opponent-error": "相手のミス", penalty: "反則・ペナルティ", other: "その他" };
    const player = match.teams.flatMap((item) => item.players).find((item) => item.id === event.playerId);
    const faultPlayer = match.teams.flatMap((item) => item.players).find((item) => item.id === event.faultPlayerId);
    const detail = [
      plays[event.playType] || "プレー未選択",
      player ? `#${player.number} ${player.name}` : "",
      faultPlayer ? `相手 #${faultPlayer.number} ${faultPlayer.name}` : "",
      event.note || "",
    ].filter(Boolean).join(" / ");
    return `${teamName} +1 得点 (${detail})${scoreSuffix}`;
  }
    if (event.type === "timeout") {
    return `${teamName} タイムアウト${scoreSuffix}`;
  }

  if (event.type === "serve-fault") {
    return `${teamName} サーブ失敗（${event.attempt}回目${event.attempt === 1 ? "・再試行" : "・相手に1点"}）${scoreSuffix}`;
  }

  if (event.type === "sto") {
    return `${teamName} STO（セーフティタイムアウト・タイムアウト回数には含めない）${scoreSuffix}`;
  }

  if (event.type === "technical-timeout") {
    return `テクニカルタイムアウト（TTO${event.triggerPoint ? `・${event.triggerPoint}点` : "・手動記録"}）${scoreSuffix}`;
  }

  if (event.type === "service-order-violation") {
    const actual = match.teams.flatMap((item) => item.players).find((player) => player.id === event.actualServerPlayerId);
    const expected = match.teams.flatMap((item) => item.players).find((player) => player.id === event.expectedServerPlayerId);
    return `サーブ順違反の可能性: 実サーバー #${actual?.number || "?"} ${actual?.name || ""} / 登録順 #${expected?.number || "?"} ${expected?.name || ""}${scoreSuffix}`;
  }

  if (event.type === "match-start") {
    return `試合開始${scoreSuffix}`;
  }

  if (event.type === "set-start") {
    return `第${event.setNumber}セット開始${scoreSuffix}`;
  }

  if (event.type === "set-end") {
    const winner = match.teams.find(
      (item) => item.id === event.winnerTeamId
    );

    return `第${event.setNumber}セット終了（${winner?.name || "チーム"} 勝利）${scoreSuffix}`;
  }

  if (event.type === "match-end") {
    return `試合終了${scoreSuffix}`;
  }

  if (event.type === "court-change") {
    return `${event.reason === "set-end"
      ? `第${event.setNumber || ""}セット終了後のコートチェンジ`
      : `コートチェンジ（第${event.setNumber || ""}セット ${event.triggerScore || event.totalPoints}点）`
      }${scoreSuffix}`;
  }
  if (event.type === "challenge") {
    const challenges = {
      "net-touch": "ネットタッチ", "block-touch": "ブロックタッチ",
      antenna: "アンテナ接触", "ball-in-out": "イン / アウト",
      "foot-fault": "フットフォルト", other: "その他",
    };
    return `${teamName} チャレンジ: ${challenges[event.challengeType] || "その他"} / ${event.result === "success" ? "成功" : "失敗"}${event.note ? ` / ${event.note}` : ""}${scoreSuffix}`;
  }
  if (event.type === "medical") {
    const player = team?.players.find((item) => item.id === event.playerId);
    const statuses = { play: "プレー続行", substituted: "交代", stopped: "一時中断", withdrawn: "出場中止" };
    return `メディカル記録: ${teamName} ${player ? `#${player.number} ${player.name}` : "選手未特定"} / ${event.bodyArea} / ${statuses[event.status] || "対応未設定"}${event.note ? ` / ${event.note}` : ""}${scoreSuffix}`;
  }
  if (event.type === "rally-play") {
    const player = team?.players.find((item) => item.id === event.playerId);
    const kinds = {
      serve: "サーブ", reception: "サーブレシーブ", serveReception: "サーブレシーブ",
      attackReception: "アタックレシーブ", set: "トス",
      attack: "アタック", backAttack: "バックアタック", block: "ブロック", feint: "フェイント",
      error: "ミス", other: "その他",
    };
    const outcomes = {
      success: "成功・継続", point: "得点", error: "失点・ミス",
      touch: "タッチ・継続", effective: "効果あり", excellent: "レシーブ優",
      good: "レシーブ良", other: "その他",
    };
    const zone = event.attackZone
      ? ` / アタックゾーン${event.attackZone}`
      : event.courseZone
        ? ` / ${event.playKind === "serve" ? "サーブコース" : "受球ゾーン"}${event.courseZone}`
        : "";
    return `${teamName} ${player ? `#${player.number} ${player.name} ` : ""}${kinds[event.playKind] || "プレー"}: ${outcomes[event.outcome] || ""}${zone}${event.note ? ` / ${event.note}` : ""}${scoreSuffix}`.trim();
  }
  if (event.type === "substitution") return `${teamName} 選手交代 ${event.playerOut} → ${event.playerIn}${scoreSuffix}`;
  if (event.type === "libero-substitution") return `${teamName} リベロ交代 ${event.playerOut || ""} → ${event.playerIn || ""}${scoreSuffix}`;
  if (event.type === "sanction") {
    const labels = {
      warning: "警告", penalty: "ペナルティ", expulsion: "退場", disqualification: "失格",
      "delay-warning": "遅延警告", "delay-penalty": "遅延ペナルティ",
    };
    const subjects = { player: "選手", bench: "ベンチ", staff: "スタッフ", team: "チーム" };
    return `${teamName} ${labels[event.sanctionType] || "処置"}（${subjects[event.subjectType] || ""}${event.player ? `: ${event.player}` : ""}）${scoreSuffix}`;
  }
  if (event.type === "play") {
    const player = team?.players.find((item) => item.id === event.playerId);
    const kinds = { attack: "アタック", backAttack: "バックアタック", block: "ブロック", serve: "サーブ", reception: "サーブレシーブ" };
    const outcomes = {
      point: "得点", error: "失点", continued: "ラリー継続", touch: "タッチ / 継続",
      effective: "効果あり", excellent: "成功（優）", good: "成功（良）", other: "その他 / 失敗",
    };
    return `${teamName} ${kinds[event.playKind] || "プレー"} ${player ? `#${player.number} ${player.name}` : ""} ${outcomes[event.outcome] || "記録"}${event.note ? ` / ${event.note}` : ""}${scoreSuffix}`.trim();
  }
  return `記録${scoreSuffix}`;
}
