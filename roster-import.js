// 写真の文字認識（端末内処理）と、読み取った文字列から選手候補を作る処理。
const OCR_DIRECTORY = new URL("./vendor/ocr/", import.meta.url);
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
  const line = rawLine.normalize("NFKC")
    .replace(/^([|｜!Il])(?=\s|[A-Za-z\u3040-\u30ff\u3400-\u9fff])/, "1")
    .replace(/[|｜]/g, " ")
    .trim();
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
    const name = cleanName(line);
    if (
      /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(name)
      && name.length >= 2
      && name.length <= 30
      && !/(氏名|背番号|選手|チーム|登録|一覧)/.test(name)
    ) {
      return { number: "", name, isCaptain: false, isLibero: false, position: "" };
    }
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

let ocrScriptPromise = null;
function loadOcrScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!ocrScriptPromise) {
    ocrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("tesseract.min.js", OCR_DIRECTORY).href;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        ocrScriptPromise = null;
        reject(new Error("OCRエンジンを読み込めませんでした。ページを再読み込みし、アプリのファイルがすべてそろっていることと通信状態を確認してください。"));
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
  const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(width, height));
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

function createHighContrastCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  const grayValues = new Uint8Array(canvas.width * canvas.height);
  for (let pixel = 0; pixel < grayValues.length; pixel += 1) {
    const offset = pixel * 4;
    const gray = Math.round(
      image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114,
    );
    grayValues[pixel] = gray;
    histogram[gray] += 1;
  }

  const pixelCount = grayValues.length;
  const percentile = (fraction) => {
    const target = pixelCount * fraction;
    let total = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      total += histogram[value];
      if (total >= target) return value;
    }
    return 255;
  };
  const low = percentile(0.02);
  const high = percentile(0.98);
  if (high <= low) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }

  const stretchedHistogram = new Uint32Array(256);
  const stretched = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const value = Math.max(0, Math.min(255, Math.round(((grayValues[pixel] - low) * 255) / (high - low))));
    stretched[pixel] = value;
    stretchedHistogram[value] += 1;
  }
  let totalIntensity = 0;
  for (let value = 0; value < 256; value += 1) totalIntensity += value * stretchedHistogram[value];
  let backgroundWeight = 0;
  let backgroundIntensity = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += stretchedHistogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = pixelCount - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundIntensity += value * stretchedHistogram[value];
    const backgroundMean = backgroundIntensity / backgroundWeight;
    const foregroundMean = (totalIntensity - backgroundIntensity) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const value = stretched[pixel] <= threshold ? 0 : 255;
    const offset = pixel * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function createGrayscaleCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const values = new Uint8Array(canvas.width * canvas.height);
  let low = 255;
  let high = 0;
  for (let pixel = 0; pixel < values.length; pixel += 1) {
    const offset = pixel * 4;
    const gray = Math.round(
      image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114,
    );
    values[pixel] = gray;
    low = Math.min(low, gray);
    high = Math.max(high, gray);
  }
  if (high <= low) return null;
  for (let pixel = 0; pixel < values.length; pixel += 1) {
    const value = Math.max(0, Math.min(255, Math.round(((values[pixel] - low) * 255) / (high - low))));
    const offset = pixel * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function rosterTextScore(text) {
  const { rows } = parseRosterText(text);
  const numbers = rows.map(({ number }) => number).filter(Boolean);
  const validNames = rows.filter(({ name }) => /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(name)).length;
  const uniqueNumbers = new Set(numbers).size;
  return validNames * 20 + uniqueNumbers * 4 - (numbers.length - uniqueNumbers) * 5 - (rows.length - validNames) * 10;
}

function rosterTextFromBlocks(blocks, imageWidth, imageHeight) {
  const numbers = [];
  const nameGroups = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || []).filter((word) => word.text?.trim());
        for (const word of words) {
          const text = word.text.normalize("NFKC").trim();
          const number = text.match(/^[#＃]?(\d{1,3})[.)、:]?$/)?.[1]
            || (/^[|｜!Il]$/.test(text) ? "1" : "");
          if (number) numbers.push({ number, bbox: word.bbox });
        }

        const nameWords = words.filter((word) => /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(word.text));
        let group = null;
        for (const word of nameWords) {
          if (group && word.bbox.x0 - group.bbox.x1 <= Math.max(18, (word.bbox.y1 - word.bbox.y0) * 1.4)) {
            group.words.push(word.text);
            group.bbox.x1 = word.bbox.x1;
            group.bbox.y0 = Math.min(group.bbox.y0, word.bbox.y0);
            group.bbox.y1 = Math.max(group.bbox.y1, word.bbox.y1);
          } else {
            group = { words: [word.text], bbox: { ...word.bbox } };
            nameGroups.push(group);
          }
        }
      }
    }
  }

  const availableNames = new Set(nameGroups.keys());
  const rows = [];
  for (const candidate of numbers) {
    const numberX = (candidate.bbox.x0 + candidate.bbox.x1) / 2;
    const numberY = (candidate.bbox.y0 + candidate.bbox.y1) / 2;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (const index of availableNames) {
      const name = nameGroups[index];
      const nameX = (name.bbox.x0 + name.bbox.x1) / 2;
      const nameY = (name.bbox.y0 + name.bbox.y1) / 2;
      const dx = Math.abs(numberX - nameX) / imageWidth;
      const dy = Math.abs(numberY - nameY) / imageHeight;
      if (dx > 0.35 || dy > 0.2) continue;
      const distance = Math.hypot(dx, dy * 1.5);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) continue;
    availableNames.delete(bestIndex);
    rows.push(`${candidate.number} ${nameGroups[bestIndex].words.join(" ")}`);
  }
  return rows.join("\n");
}

export async function recognizeRosterImage(file, onProgress = () => {}) {
  await loadOcrScript();
  const canvas = await imageToCanvas(file);
  let enhancedCanvas;
  let grayscaleCanvas;
  let worker;
  try {
    onProgress({ status: "画像の明るさとコントラストを調整しています" });
    enhancedCanvas = createHighContrastCanvas(canvas);
    grayscaleCanvas = createGrayscaleCanvas(canvas);
    worker = await window.Tesseract.createWorker("jpn", 1, {
      workerPath: new URL("worker.min.js", OCR_DIRECTORY).href,
      corePath: new URL("tesseract-core-simd-lstm.wasm.js", OCR_DIRECTORY).href,
      langPath: OCR_DIRECTORY.href,
      gzip: true,
      workerBlobURL: false,
      cacheMethod: "write",
      logger: (message) => onProgress(message),
    });
    const candidates = [
      { canvas, mode: window.Tesseract.PSM.AUTO, label: "元画像を読み取っています" },
      { canvas, mode: window.Tesseract.PSM.SINGLE_BLOCK, label: "名簿全体を一つの表として読み取っています" },
      { canvas, mode: window.Tesseract.PSM.SPARSE_TEXT, label: "表内の文字を探しています" },
      ...(enhancedCanvas ? [
        { canvas: enhancedCanvas, mode: window.Tesseract.PSM.AUTO, label: "明るさ補正画像を読み取っています" },
        { canvas: enhancedCanvas, mode: window.Tesseract.PSM.SINGLE_BLOCK, label: "補正画像を一つの表として読み取っています" },
        { canvas: enhancedCanvas, mode: window.Tesseract.PSM.SPARSE_TEXT, label: "補正画像から表内の文字を探しています" },
      ] : []),
      ...(grayscaleCanvas ? [
        { canvas: grayscaleCanvas, mode: window.Tesseract.PSM.SINGLE_BLOCK, label: "写真や色付き背景を抑えた画像を読み取っています" },
        { canvas: grayscaleCanvas, mode: window.Tesseract.PSM.SPARSE_TEXT, label: "写真付き紙面から文字を探しています" },
      ] : []),
    ];
    let bestText = "";
    let bestScore = -1;
    let bestConfidence = -1;
    for (const [index, candidate] of candidates.entries()) {
      onProgress({ status: `${candidate.label}（${index + 1}/${candidates.length}）` });
      await worker.setParameters({
        tessedit_pageseg_mode: candidate.mode,
        preserve_interword_spaces: "1",
      });
      const { data } = await worker.recognize(candidate.canvas, {}, { blocks: true });
      const texts = [
        data.text || "",
        rosterTextFromBlocks(data.blocks, candidate.canvas.width, candidate.canvas.height),
      ];
      const confidence = Number(data.confidence) || 0;
      for (const text of texts) {
        const score = rosterTextScore(text);
        if (score > bestScore || (score === bestScore && confidence > bestConfidence)) {
          bestText = text;
          bestScore = score;
          bestConfidence = confidence;
        }
      }
    }
    return bestText;
  } finally {
    if (worker) await worker.terminate();
    canvas.width = 0;
    canvas.height = 0;
    if (enhancedCanvas) {
      enhancedCanvas.width = 0;
      enhancedCanvas.height = 0;
    }
    if (grayscaleCanvas) {
      grayscaleCanvas.width = 0;
      grayscaleCanvas.height = 0;
    }
  }
}
