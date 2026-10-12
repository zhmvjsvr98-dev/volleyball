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

  const nameLabel = element("label", "field");
  nameLabel.append(document.createTextNode("チーム名"));
  const nameInput = element("input", "team-name-input");
  nameInput.value = team.name;
  nameInput.maxLength = 60;
  nameInput.autocomplete = "off";
  nameInput.dataset.teamName = team.id;
  nameLabel.append(nameInput);
  head.append(nameLabel);
  container.append(head);

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
    row.append(nameCell);
    row.append(element("td", "", player.isCaptain ? "キャプテン" : "選手"));
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
  const addButton = element("button", "button button-secondary", "選手を追加");
  addButton.type = "submit";
  addButton.disabled = rosterLocked || team.players.length >= rosterLimit;
  form.querySelectorAll("input").forEach((input) => { input.disabled = rosterLocked; });
  form.append(numberLabel, namePlayerLabel, captainLabel, addButton);
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
