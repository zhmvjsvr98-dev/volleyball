// 写真の文字認識（端末内処理）と、読み取った文字列から選手候補を作る処理。
const OCR_DIRECTORY = "./vendor/ocr/";
const MAX_IMAGE_SIDE = 2200;
const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uff66-\\uff9f";

const POSITION_PATTERNS = [
  ["OH", /アウトサイド(?:ヒッター)?|(?<![A-Za-z])OH(?![A-Za-z])/i],
  ["MB", /ミドル(?:ブロッカー)?|(?<![A-Za-z])MB(?![A-Za-z])/i],
  ["OP", /オポジット|(?<![A-Za-z])OPP?(?![A-Za-z])/i],
  ["S", /セッター|(?<![A-Za-z])S(?![A-Za-z])/],
];
const CAPTAIN_PATTERN = /[(（\[]\s*C\s*[)）\]]|キャプテン|主将|ゲームキャプテン|(?<![A-Za-z])C(?![A-Za-z])/;
const LIBERO_PATTERN = /[(（\[]\s*L\s*[)）\]]|リベロ|(?<![A-Za-z])Lib(?:ero)?(?![A-Za-z])|(?<![A-Za-z])L(?![A-Za-z])/i;

function cleanName(text) {
  return text
    .replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g"), "")
    .replace(/[|｜_]+/g, " ")
    .replace(/[()（）\[\]「」,，、.。:：]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function parseLine(rawLine) {
  const line = rawLine.normalize("NFKC").replace(/[|｜]/g, " ").trim();
  if (!line) return null;
  let number = "";
  let rest = "";
  const leading = line.match(/^[#＃No.\s]*?(\d{1,3})(?!\d)\s*[.)、:,]?\s*(.*)$/i);
  const anywhere = line.match(/(?:^|\s)(\d{1,3})(?=\s|$)/);
  if (leading) {
    number = leading[1];
    rest = leading[2];
  } else if (anywhere) {
    number = anywhere[1];
    rest = line.replace(anywhere[0], " ");
  } else {
    return null;
  }

  let isCaptain = false;
  let isLibero = false;
  let position = "";
  if (CAPTAIN_PATTERN.test(rest)) {
    isCaptain = true;
    rest = rest.replace(CAPTAIN_PATTERN, " ");
  }
  if (LIBERO_PATTERN.test(rest)) {
    isLibero = true;
    rest = rest.replace(LIBERO_PATTERN, " ");
  }
  for (const [code, pattern] of POSITION_PATTERNS) {
    if (pattern.test(rest)) {
      position = code;
      rest = rest.replace(pattern, " ");
      break;
    }
  }
  const name = cleanName(rest);
  if (!name && !isLibero && !isCaptain && !position) return null;
  return { number, name, isCaptain, isLibero, position };
}

export function parseRosterText(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseLine(line);
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

function absoluteUrl(path) {
  return new URL(path, document.baseURI).href;
}

let ocrScriptPromise = null;
function loadOcrScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!ocrScriptPromise) {
    ocrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${OCR_DIRECTORY}tesseract.min.js`;
      script.onload = () => resolve();
      script.onerror = () => {
        ocrScriptPromise = null;
        reject(new Error("読み取り用のファイルを読み込めませんでした。通信状態を確認して再度お試しください。"));
      };
      document.head.append(script);
    });
  }
  return ocrScriptPromise;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("画像ファイルを読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}

async function loadImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // 一部ブラウザーでは対応形式が限られるため、下の方法で再試行します。
    }
  }
  const image = new Image();
  const url = await readAsDataUrl(file);
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("この画像形式は読み取れません。JPEGまたはPNGの写真を選んでください。"));
    image.src = url;
  });
  return image;
}

async function imageToCanvas(file) {
  const source = await loadImageSource(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") source.close();
  return canvas;
}

export async function recognizeRosterImage(file, onProgress = () => {}) {
  await loadOcrScript();
  const canvas = await imageToCanvas(file);
  const worker = await window.Tesseract.createWorker("jpn", 1, {
    workerPath: absoluteUrl(`${OCR_DIRECTORY}worker.min.js`),
    corePath: absoluteUrl(`${OCR_DIRECTORY}tesseract-core-simd-lstm.wasm.js`),
    langPath: absoluteUrl(OCR_DIRECTORY.replace(/\/$/, "")),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: "none",
    logger: (message) => onProgress(message),
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: window.Tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(canvas);
    return data.text || "";
  } finally {
    await worker.terminate();
    canvas.width = 0;
    canvas.height = 0;
  }
}
