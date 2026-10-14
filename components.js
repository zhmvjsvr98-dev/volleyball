function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// チームカードはDOM APIだけで組み立て、利用者が入力した文字列をHTMLとして解釈させません。
export function renderTeamCard(container, team, index, rosterLimit = 30, rosterLocked = false) {
  container.replaceChildren();
  const head = element("div", "team-card-head");
  const title = element("div");
  title.append(element("span", "eyebrow", index === 0 ? "HOME / TEAM A" : "VISITOR / TEAM B"));
  const heading = element("h2", "", "チーム情報・選手登録");
  title.append(heading);
  const score = element("span", "team-score-mini", "0");
  score.dataset.teamScore = team.id;
  head.append(title, score);

  const topFields = element("div", "team-top-fields");
  const nameLabel = element("label", "field");
  nameLabel.append(document.createTextNode("チーム名"));
  const nameInput = element("input", "team-name-input");
  nameInput.value = team.name;
  nameInput.maxLength = 60;
  nameInput.autocomplete = "off";
  nameInput.dataset.teamName = team.id;
  nameInput.disabled = rosterLocked;
  nameLabel.append(nameInput);

  const colorLabel = element("label", "field");
  colorLabel.append(document.createTextNode("ユニフォーム色"));
  const colorInput = element("input");
  colorInput.type = "color";
  colorInput.value = team.uniformColor || "#1d4ed8";
  colorInput.dataset.teamColor = team.id;
  colorInput.title = "チームのユニフォーム色";
  colorInput.setAttribute("aria-label", `${team.name}のユニフォーム色`);
  colorInput.disabled = rosterLocked;
  colorLabel.append(colorInput);

  topFields.append(nameLabel, colorLabel);
  head.append(topFields);
  container.append(head);

  const staffWrap = element("div", "team-staff-grid");
  const staffRoles = [
    ["gm", "GM"], ["headCoach", "ヘッドコーチ"], ["coach1", "コーチ1"], ["coach2", "コーチ2"],
    ["swingCoach", "スイングコーチ"], ["performanceAnalyst", "パフォーマンスアナリスト"],
    ["trainer1", "トレーナー1"], ["trainer2", "トレーナー2"], ["manager1", "マネージャー1"],
    ["manager2", "マネージャー2"], ["doctor1", "ドクター1"], ["doctor2", "ドクター2"],
  ];
  staffRoles.forEach(([key, label]) => {
    const field = element("label", "field team-staff-item");
    field.append(document.createTextNode(label));
    const input = element("input");
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = label;
    input.value = team.staff?.[key] || "";
    input.dataset.teamStaffKey = key;
    input.dataset.teamId = team.id;
    input.disabled = rosterLocked;
    field.append(input);
    staffWrap.append(field);
  });
  container.append(staffWrap);

  const tableWrap = element("div", "roster-table-wrap");
  const table = element("table", "roster-table");
  const thead = element("thead");
  const headerRow = element("tr");
  for (const label of ["背番号", "氏名", "役割", ""]) headerRow.append(element("th", "", label));
  thead.append(headerRow);
  const tbody = element("tbody");

  for (const player of team.players) {
    const row = element("tr");
    row.append(element("td", "", player.number || "—"));
    const nameCell = element("td", "", player.name);
    if (player.isCaptain) nameCell.append(element("span", "captain-tag", "C"));
    if (player.isLibero) nameCell.append(element("span", "captain-tag", "L"));
    row.append(nameCell);
    row.append(element("td", "", player.isCaptain ? "キャプテン" : player.isLibero ? "リベロ" : "選手"));
    const removeCell = element("td");
    const remove = element("button", "remove-player", "×");
    remove.type = "button";
    remove.dataset.removePlayer = player.id;
    remove.dataset.teamId = team.id;
    remove.setAttribute("aria-label", `${player.name}を選手一覧から削除`);
    remove.disabled = rosterLocked;
    removeCell.append(remove);
    row.append(removeCell);
    tbody.append(row);
  }
  table.append(thead, tbody);
  tableWrap.append(table);
  container.append(tableWrap);
  if (!team.players.length) container.append(element("p", "empty-message", "選手が登録されていません。"));

  const form = element("form", "add-player-form");
  form.dataset.addPlayer = team.id;
  const numberLabel = makeField("背番号", "number", "3", "背番号");
  numberLabel.querySelector("input").inputMode = "numeric";
  const namePlayerLabel = makeField("氏名", "text", "60", "選手氏名");
  const captainLabel = element("label", "check-field");
  const captainCheck = element("input");
  captainCheck.type = "checkbox";
  captainCheck.name = "captain";
  captainLabel.append(captainCheck, document.createTextNode("キャプテン"));
  const liberoLabel = element("label", "check-field");
  const liberoCheck = element("input");
  liberoCheck.type = "checkbox";
  liberoCheck.name = "libero";
  liberoLabel.append(liberoCheck, document.createTextNode("リベロ"));
  const addButton = element("button", "button button-secondary", "選手を追加");
  addButton.type = "submit";
  addButton.disabled = rosterLocked || team.players.length >= rosterLimit;
  form.querySelectorAll("input").forEach((input) => { input.disabled = rosterLocked; });
  form.append(numberLabel, namePlayerLabel, captainLabel, liberoLabel, addButton);
  container.append(form);
}

function makeField(label, type, maxLength, placeholder) {
  const wrapper = element("label", "field");
  wrapper.append(document.createTextNode(label));
  const input = element("input");
  input.type = type;
  input.maxLength = Number(maxLength);
  input.placeholder = placeholder;
  input.required = true;
  wrapper.append(input);
  return wrapper;
}

export function makeEventRow(time, description) {
  const row = element("li");
  row.append(element("span", "event-time", time));
  row.append(element("span", "", description));
  return row;
}
