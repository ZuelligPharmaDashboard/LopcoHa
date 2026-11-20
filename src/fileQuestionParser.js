import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

// Cấu hình worker nội bộ của pdfjs-dist tương thích Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

function htmlToCleanLinesText(html) {
  if (!html) return '';
  const withNewlines = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '   ');
  const stripped = withNewlines.replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(stripped)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Đọc nội dung văn bản từ file Word (.docx), PDF (.pdf) hoặc Text (.txt)
 * Trả về { plainText, htmlText, pageCount }
 */
export async function extractRawContentFromFile(file) {
  const name = (file.name || '').toLowerCase();

  if (name.endsWith('.docx')) {
    const arrayBuffer = await file.arrayBuffer();
    const [rawRes, htmlRes] = await Promise.all([
      mammoth.extractRawText({ arrayBuffer }),
      mammoth.convertToHtml({ arrayBuffer })
    ]);
    const cleanFromHtml = htmlToCleanLinesText(htmlRes.value || '');
    return {
      plainText: cleanFromHtml || rawRes.value || '',
      htmlText: htmlRes.value || '',
      pageCount: 1
    };
  }

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const pagesText = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      let lastY = null;
      let lineBuf = [];
      const lines = [];

      textContent.items.forEach((item) => {
        const str = item.str || '';
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 5) {
          lines.push(lineBuf.join(' ').replace(/\s+/g, ' ').trim());
          lineBuf = [];
        }
        if (str.trim()) {
          lineBuf.push(str);
        }
        if (y !== null) lastY = y;
      });
      if (lineBuf.length > 0) {
        lines.push(lineBuf.join(' ').replace(/\s+/g, ' ').trim());
      }
      pagesText.push(lines.filter(Boolean).join('\n'));
    }

    return {
      plainText: pagesText.join('\n'),
      htmlText: '',
      pageCount: pdf.numPages
    };
  }

  // Fallback cho .txt / .md / .csv
  const text = await file.text();
  return {
    plainText: text || '',
    htmlText: '',
    pageCount: 1
  };
}

/**
 * Dò đáp án được bôi đậm hoặc gạch chân trong file Word (.docx)
 */
function extractBoldAnswersFromHtml(htmlText) {
  const boldMap = {};
  if (!htmlText) return boldMap;

  const qChunks = htmlText.split(
    /(?=(?:<p[^>]*>\s*(?:<strong>)?\s*(?:Câu|Bài|Question|\d+\s*[.)])\s*))/i
  );
  qChunks.forEach((chunk) => {
    const qMatch =
      chunk.match(/(?:Câu|Bài|Question)\s*(\d+)/i) ||
      chunk.match(/<p[^>]*>\s*(?:<strong>)?\s*(\d+)\s*[.)]/i);
    if (!qMatch) return;
    const qNum = qMatch[1];

    const highlighted = [];
    ['A', 'B', 'C', 'D'].forEach((opt) => {
      // The bold/underlined run must start with the option letter (avoids matching instructions like "Choose A, B, C or D.")
      const pattern = new RegExp(`<(?:strong|b|u)>\\s*\\(?${opt}\\s*[.):]`, 'i');
      if (pattern.test(chunk)) {
        highlighted.push(opt);
      }
    });

    if (highlighted.length === 1) {
      boldMap[qNum] = highlighted[0];
    }
  });

  return boldMap;
}

/**
 * Loose text normalization for comparing answers (case, spaces, punctuation)
 */
export function normalizeLooseText(str) {
  return String(str ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.,;:!?'"“”‘’`()[\]{}…\-–—_]+/g, '');
}

/**
 * Extract the MCQ letter (A-D) from a raw key such as:
 * "B", "b)", "(B)", "B.", "B (ancient). ancient = ...", "Đáp án: B", or the option text itself ("ancient").
 * Returns { letter, rest } — rest is any trailing explanation text.
 */
export function extractMcqLetter(raw, options = {}) {
  let text = String(raw ?? '').trim();
  if (!text) return { letter: '', rest: '' };
  text = text.replace(/^(?:đáp\s*án(?:\s*đúng)?|đa|answer|ans|key)\s*[:.\-–—]?\s*/i, '').trim();
  if (!text) return { letter: '', rest: '' };

  const optEntries = ['A', 'B', 'C', 'D']
    .map((k) => [k, normalizeLooseText(options?.[k])])
    .filter(([, v]) => v);

  // 1. The whole key equals one option text
  const whole = normalizeLooseText(text);
  const exact = optEntries.filter(([, v]) => v === whole);
  if (exact.length === 1) return { letter: exact[0][0], rest: '' };

  // 2. Leading letter: "B", "B.", "B)", "(B)", "B - ...", "B (ancient)..."
  const m = text.match(/^[([]?\s*([A-Da-d])\s*(?=$|[)\].:,;=\-–—→>]|\s|\()/);
  if (m) {
    const isLower = m[1] === m[1].toLowerCase();
    const after = text.slice(m[0].length);
    // A lowercase letter followed by a plain word ("a book") is text, not a letter key
    const looksLikeWord = isLower && /^\s+[a-zà-ỹ]/i.test(after) && !/^\s*[)\].:]/.test(after);
    if (!looksLikeWord) {
      let rest = after
        .replace(/^\s*[)\]]/, '')
        .replace(/^\s*[.:,;=\-–—→>]+\s*/, '')
        .trim();
      // Drop a leading "(option text)" echo
      const echo = rest.match(/^\(([^)]*)\)\s*[.:,;\-–—]?\s*/);
      if (echo) {
        const echoNorm = normalizeLooseText(echo[1]);
        const optNorm = normalizeLooseText(options?.[m[1].toUpperCase()]);
        if (!optNorm || echoNorm === optNorm) rest = rest.slice(echo[0].length).trim();
      }
      return { letter: m[1].toUpperCase(), rest };
    }
  }

  // 3. Key starts with exactly one option's text ("ancient = cổ đại...")
  const prefix = optEntries.filter(([, v]) => v.length >= 2 && whole.startsWith(v));
  if (prefix.length === 1) return { letter: prefix[0][0], rest: text };

  return { letter: '', rest: text };
}

const KEY_HEADER_REGEX =
  /^[-=*#_.\s]*(?:BẢNG\s*ĐÁP\s*ÁN|ĐÁP\s*ÁN(?:\s*(?:VÀ|&)\s*(?:GIẢI\s*THÍCH|HƯỚNG\s*DẪN))?|KEY\s*ĐÁP\s*ÁN|HƯỚNG\s*DẪN\s*(?:CHẤM|GIẢI)|LỜI\s*GIẢI(?:\s*CHI\s*TIẾT)?|ANSWER\s*KEYS?|ANSWERS|KEYS?)\b(.*)$/i;
const INLINE_ANSWER_REGEX = /^(?:Đáp\s*án(?:\s*đúng)?|ĐA|Answer|Key)\s*[:.\-–—]\s*(.+)$/i;
const EXPLANATION_LINE_REGEX = /^(?:Giải\s*thích|GT|Lời\s*giải|Hướng\s*dẫn|HD|Explanation|Explain)\s*[:.\-–—]\s*(.+)$/i;
const KEY_LINE_EXPLANATION_REGEX =
  /\(?\s*(?:Giải\s*thích|GT|HD|Hướng\s*dẫn|Lời\s*giải|Note|Explanation|Explain)\s*[:\-–—]\s*(.+?)\)?$/i;

/**
 * Is this line an answer-key header (and not an inline answer like "Đáp án: B")?
 */
export function isAnswerKeyHeader(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 80) return false;
  const m = t.match(KEY_HEADER_REGEX);
  if (!m) return false;
  const tail = (m[1] || '').trim();
  // "Đáp án: B" / "Key: C" = inline answer of one question, not a section header
  if (/^[:.\-–—]?\s*\(?[A-Da-d]\)?\s*(?:$|[.,;)\s])/.test(tail)) return false;
  return true;
}

/**
 * Parse an answer-key section into { keyMap (raw answer text), explanationMap }.
 * Supported: "1. B", "1. B (ancient). giải thích", "Câu 1: B - vì...", "1 B" (table cells),
 * "1.A 2.B 3.C" / "1A 2B" (many per line), horizontal tables (row of numbers + row of letters),
 * "8. would join the charity club (Giải thích: ...)".
 */
export function parseAnswerKeyLines(keyLines) {
  const keyMap = {};
  const explanationMap = {};
  const multiPairRegex = /(?:Câu\s*)?(\d{1,3})\s*[:.\-)]?\s*([A-D])(?=\s|$|,|;|\||\.)/g;

  keyLines.forEach((kl) => {
    const line = String(kl || '').trim();
    if (!line) return;

    // Many pairs on one line: "1.A 2.B 3.C" or "1A  2B  3C" or "1-A | 2-B"
    const pairs = [...line.matchAll(multiPairRegex)];
    if (pairs.length >= 2) {
      const covered = pairs.map((p) => p[0]).join('').replace(/\s+/g, '').length;
      if (covered >= line.replace(/[\s,;|]+/g, '').length * 0.8) {
        pairs.forEach((p) => {
          keyMap[p[1]] = p[2];
        });
        return;
      }
    }

    // One answer per line (optional separator so table rows "1   B   ..." work)
    const lineMatch = line.match(/^(?:Câu\s*|Question\s*|Q\s*)?(\d{1,3})\s*(?:[:.\-)–—]\s*|\s+)(.+)$/i);
    if (lineMatch) {
      const qNum = lineMatch[1];
      let rest = lineMatch[2].trim();
      const expMatch = rest.match(KEY_LINE_EXPLANATION_REGEX);
      if (expMatch) {
        explanationMap[qNum] = expMatch[1].trim();
        rest = rest.slice(0, rest.indexOf(expMatch[0])).trim();
      }
      if (rest) keyMap[qNum] = rest;
    }
  });

  // Horizontal table: a row of numbers followed by a row of letters
  for (let i = 0; i < keyLines.length - 1; i += 1) {
    const nums = String(keyLines[i]).match(/\b\d{1,3}\b/g);
    const letterRow = String(keyLines[i + 1]).trim();
    const letters = letterRow.match(/\b[A-Da-d]\b/g);
    const onlyLetters = /^[A-Da-d\s|,;]+$/.test(letterRow);
    if (nums && letters && onlyLetters && nums.length >= 2 && nums.length === letters.length) {
      nums.forEach((n, idx) => {
        keyMap[n] = letters[idx].toUpperCase();
      });
    }
  }

  return { keyMap, explanationMap };
}

/**
 * Tách bảng đáp án & giải thích ở cuối đề (nếu có)
 * - Có tiêu đề (ĐÁP ÁN / ANSWER KEY / LỜI GIẢI...) -> phần sau tiêu đề là key
 * - Không có tiêu đề nhưng cuối file là dãy "1.A 2.B..." -> tự nhận là key, không coi là câu hỏi
 */
function extractAnswerKeySection(fullText) {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim());
  let keyStartIdx = -1;
  let keyFirstLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (isAnswerKeyHeader(lines[i])) {
      keyStartIdx = i;
      keyFirstLine = i + 1;
      break;
    }
  }

  // No header: detect a trailing block of pure key lines (e.g. "1.A 2.B 3.C" or "1. B" x many)
  if (keyStartIdx < 0) {
    const pureKeyLine = /^(?:(?:Câu\s*)?\d{1,3}\s*[:.\-)]?\s*[A-D]\b[\s,;|.]*)+$/;
    let i = lines.length - 1;
    while (i >= 0 && !lines[i]) i -= 1;
    let j = i;
    while (j >= 0 && (pureKeyLine.test(lines[j]) || !lines[j])) j -= 1;
    const tailCount = lines.slice(j + 1, i + 1).filter(Boolean).length;
    const pairCount = lines
      .slice(j + 1, i + 1)
      .join(' ')
      .match(/\d{1,3}\s*[:.\-)]?\s*[A-D]\b/g);
    if (tailCount > 0 && pairCount && pairCount.length >= 3) {
      keyStartIdx = j + 1;
      keyFirstLine = j + 1;
    }
  }

  const bodyLines = keyStartIdx >= 0 ? lines.slice(0, keyStartIdx) : lines;
  const keyLines = keyStartIdx >= 0 ? lines.slice(keyFirstLine) : [];
  const { keyMap, explanationMap } = parseAnswerKeyLines(keyLines);

  return {
    bodyText: bodyLines.join('\n'),
    keyMap,
    explanationMap
  };
}

/**
 * Bộ phân tích Rule-Based 100% nguyên văn từ nội dung trích xuất (Không cần AI)
 * - Tự nhận diện bài đọc dài (Reading / Cloze test) dùng chung cho nhóm 5-7 câu bên dưới
 * - Gộp phân loại thành 2 nhóm duy nhất:
 *    1. 'mcq': Trắc nghiệm (A/B/C/D)
 *    2. 'open': Điền đáp án / Tự luận
 */
export function parseQuestionsFromExtractedContent({ plainText, htmlText = '' }) {
  const boldMap = extractBoldAnswersFromHtml(htmlText);
  const { bodyText, keyMap, explanationMap } = extractAnswerKeySection(plainText);
  const combinedKeyMap = { ...boldMap, ...keyMap };

  const lines = bodyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const blocks = [];
  let currentBlock = null;
  let activePassageLines = [];
  let inReadingZone = false;

  const qStartRegex = /^(?:Câu|Bài|Question)\s*(\d+)\s*[:.\-)]\s*(.*)$/i;
  const numStartRegex = /^(\d+)\s*[.)]\s+(.*)$/;
  const sectionHeaderRegex =
    /^(?:Part|Phần|Section|PHẦN|CHUYÊN\s*ĐỀ)\s+[A-Z0-9IVX]+\b/i;
  const readingIntroRegex =
    /^(?:Read\s+the\s+(?:following\s+)?passage|Read\s+the\s+text|Đọc\s+đoạn\s+văn|Đọc\s+bài\s+đọc)/i;
  const nonReadingInstructionRegex =
    /^(?:Mark\s+the\s+letter|Choose\s+the\s+(?:best|correct)|Rewrite\s+the|Complete\s+the|Chọn\s+đáp\s+án|Viết\s+lại\s+câu)/i;

  lines.forEach((line) => {
    // Ngắt block & reset đoạn văn khi gặp tiêu đề Part mới
    if (sectionHeaderRegex.test(line)) {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      activePassageLines = [];
      inReadingZone = /(?:reading|đọc\s*hiểu|điền\s*từ|cloze)/i.test(line);
      return;
    }

    // Bắt đầu vùng bài đọc hiểu / điền từ
    if (readingIntroRegex.test(line)) {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      activePassageLines = [line];
      inReadingZone = true;
      return;
    }

    // Lệnh bài tập mới không phải bài đọc -> xóa đoạn văn cũ để không dính sang phần sau
    if (nonReadingInstructionRegex.test(line) && !inReadingZone) {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      activePassageLines = [];
      return;
    }

    const m1 = line.match(qStartRegex);
    const m2 = !m1 ? line.match(numStartRegex) : null;

    if (m1 || m2) {
      if (currentBlock) blocks.push(currentBlock);
      const qNum = (m1 ? m1[1] : m2[1]).trim();
      const firstText = (m1 ? m1[2] : m2[2]).trim();
      const passageText =
        activePassageLines.length > 0 ? activePassageLines.join('\n\n').trim() : '';

      currentBlock = {
        number: qNum,
        sectionTitle: '',
        passage: passageText,
        rawLines: firstText ? [firstText] : []
      };
    } else if (currentBlock) {
      const inlineAns = line.match(INLINE_ANSWER_REGEX);
      const inlineExp = line.match(EXPLANATION_LINE_REGEX);
      if (inlineAns) {
        currentBlock.inlineAnswer = inlineAns[1].trim();
      } else if (inlineExp) {
        currentBlock.inlineExplanation = inlineExp[1].trim();
      } else {
        currentBlock.rawLines.push(line);
      }
    } else if (inReadingZone || line.length >= 130) {
      // Đoạn văn dài xuất hiện trước nhóm câu hỏi -> gom làm bài đọc chung
      activePassageLines.push(line);
    }
  });
  if (currentBlock) blocks.push(currentBlock);

  // Nếu file không đánh số "Câu 1 / 1.", coi toàn bộ văn bản là 1 đề điền đáp án / tự luận
  if (blocks.length === 0 && bodyText.trim()) {
    return [
      {
        id: 'q-1',
        number: 1,
        type: 'open',
        passage: '',
        text: bodyText.trim(),
        options: { A: '', B: '', C: '', D: '' },
        correctAnswer: combinedKeyMap['1'] || '',
        explanation: explanationMap['1'] || ''
      }
    ];
  }

  const optMarkerRegex = /(?:^|[\s.?!…”"')…:;])([A-Da-d])\s*[.)]\s*/g;
  const expectedOrder = ['A', 'B', 'C', 'D'];

  const parsedQuestions = blocks.map((blk, idx) => {
    const qNum = blk.number || String(idx + 1);
    const fullBlock = blk.rawLines.join('\n').trim();

    const allMatches = [...fullBlock.matchAll(optMarkerRegex)];
    const seqMatches = [];
    let expIdx = 0;

    // Use uppercase markers when present; lowercase a) b) c) only as a fallback
    const upperOnly = allMatches.filter((m) => m[1] === m[1].toUpperCase());
    const lowerOnly = allMatches.filter((m) => m[1] !== m[1].toUpperCase());
    const countSeq = (list) => {
      let k = 0;
      list.forEach((m) => {
        if (k < 4 && m[1].toUpperCase() === expectedOrder[k]) k += 1;
      });
      return k;
    };
    const markerList =
      countSeq(upperOnly) >= 2 ? upperOnly : countSeq(lowerOnly) >= 3 ? lowerOnly : [];

    for (const m of markerList) {
      const letter = m[1].toUpperCase();
      if (expIdx < 4 && letter === expectedOrder[expIdx]) {
        const letterRelIdx = m[0].search(/[A-D]/i);
        const markerStart = m.index + (letterRelIdx >= 0 ? letterRelIdx : 0);
        const contentStart = m.index + m[0].length;
        seqMatches.push({ letter, markerStart, contentStart });
        expIdx += 1;
      }
    }

    const options = { A: '', B: '', C: '', D: '' };
    let stemText = fullBlock;

    if (seqMatches.length >= 2) {
      stemText = fullBlock.slice(0, seqMatches[0].markerStart).trim();
      for (let i = 0; i < seqMatches.length; i++) {
        const cur = seqMatches[i];
        const nextStart =
          i + 1 < seqMatches.length ? seqMatches[i + 1].markerStart : fullBlock.length;
        options[cur.letter] = fullBlock
          .slice(cur.contentStart, nextStart)
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    const hasOptions = Boolean(options.A || options.B || options.C || options.D);
    const rawKey = blk.inlineAnswer || keyMap[qNum] || boldMap[qNum] || '';
    let explanation = blk.inlineExplanation || explanationMap[qNum] || '';
    let correctAnswer = rawKey;
    let keyIssue = '';

    if (hasOptions && rawKey) {
      const { letter, rest } = extractMcqLetter(rawKey, options);
      if (letter) {
        correctAnswer = letter;
        if (!explanation && rest) explanation = rest;
        const boldLetter = boldMap[qNum];
        if (boldLetter && boldLetter !== letter) keyIssue = `Bảng đáp án ghi ${letter} nhưng file bôi đậm ${boldLetter}`;
      } else {
        correctAnswer = '';
        if (!explanation) explanation = rawKey;
        keyIssue = `Không đọc được đáp án A–D từ "${rawKey.slice(0, 40)}" → để GV chấm tay`;
      }
    } else if (!hasOptions && /^[A-Da-d]$/.test(String(rawKey).trim())) {
      keyIssue = `Đáp án là "${rawKey}" nhưng không tách được phương án A–D của câu này`;
    }

    return {
      id: `q-${qNum}-${idx}`,
      number: Number(qNum) || idx + 1,
      sourceNumber: qNum,
      type: hasOptions ? 'mcq' : 'open',
      passage: blk.passage || '',
      text: stemText || `Câu hỏi số ${qNum}`,
      options,
      correctAnswer,
      explanation,
      keyIssue
    };
  });

  // Flag duplicated question numbers (e.g. each Part restarts at 1) — answer keys may collide
  const numCount = {};
  parsedQuestions.forEach((q) => {
    numCount[q.sourceNumber] = (numCount[q.sourceNumber] || 0) + 1;
  });
  parsedQuestions.forEach((q) => {
    if (numCount[q.sourceNumber] > 1 && !q.keyIssue) {
      q.keyIssue = `Số câu ${q.sourceNumber} bị trùng trong file (mỗi Part đánh lại từ 1?) — kiểm tra lại đáp án`;
    }
  });

  return parsedQuestions;
}

/**
 * Tùy chọn: Quét đề bằng Gemini AI (Hỗ trợ cả bài đọc hiểu dài + tự động viết giải thích ngắn gọn)
 */
export async function parseQuestionsWithGeminiAI(rawText, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey.trim()
  )}`;

  const prompt = `Bạn là công cụ trích xuất đề thi chính xác 100% nguyên văn.
Hãy đọc nội dung tài liệu bên dưới và trích xuất thành mảng JSON các câu hỏi theo đúng trình tự từ đầu đến cuối.
QUY TẮC BẮT BUỘC:
1. Giữ nguyên văn 100% nội dung câu hỏi và phương án A, B, C, D.
2. "type" chỉ nhận 1 trong 2 giá trị:
   - "mcq": Câu trắc nghiệm có phương án A, B, C, D.
   - "open": Tất cả các câu còn lại (điền từ, viết lại câu, trả lời ngắn, tự luận).
3. Nếu có đoạn văn đọc hiểu / điền từ dùng chung cho một nhóm câu hỏi, hãy điền nguyên văn đoạn văn đó vào trường "passage" của từng câu trong nhóm; câu nào không thuộc bài đọc thì để "passage": "".
4. Nếu tài liệu có đáp án hoặc em xác định chắc chắn đáp án đúng, điền vào "correctAnswer" (VD: "A" hoặc đáp án ngắn) và giải thích ngắn gọn 1-2 câu bằng tiếng Việt vào "explanation".

Trả về DUY NHẤT JSON hợp lệ (không bọc markdown):
[
  {
    "number": 1,
    "type": "mcq",
    "passage": "",
    "text": "Nội dung câu hỏi nguyên văn",
    "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
    "correctAnswer": "B",
    "explanation": "Giải thích ngắn gọn tại sao chọn B."
  }
]

NỘI DUNG TÀI LIỆU:
${rawText.slice(0, 30000)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Lỗi Gemini API (${res.status}): ${errText.slice(0, 150)}`);
  }

  const json = await res.json();
  const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const cleaned = rawOutput.replace(/^```json\s*|```$/g, '').trim();
  const arr = JSON.parse(cleaned);

  return (Array.isArray(arr) ? arr : []).map((item, idx) => {
    const options = {
      A: String(item.options?.A || '').trim(),
      B: String(item.options?.B || '').trim(),
      C: String(item.options?.C || '').trim(),
      D: String(item.options?.D || '').trim()
    };
    const type = item.type === 'mcq' ? 'mcq' : 'open';
    let correctAnswer = String(item.correctAnswer || '').trim();
    let explanation = String(item.explanation || '').trim();
    if (type === 'mcq' && correctAnswer) {
      const { letter, rest } = extractMcqLetter(correctAnswer, options);
      correctAnswer = letter;
      if (!explanation && rest) explanation = rest;
    }
    return {
      id: `ai-q-${idx + 1}`,
      number: Number(item.number) || idx + 1,
      type,
      passage: String(item.passage || '').trim(),
      text: String(item.text || '').trim(),
      options,
      correctAnswer,
      explanation
    };
  });
}

/**
 * Dùng Gemini AI tự động giải thích đáp án & lỗi sai cho danh sách câu hỏi
 */
export async function generateExplanationsWithGeminiAI(questionsToExplain, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey.trim()
  )}`;

  const compactInput = questionsToExplain.map((q) => ({
    number: q.number,
    text: q.text,
    options: q.options || {},
    correctAnswer: q.correctAnswer || '',
    studentAnswer: q.studentAnswer || ''
  }));

  const prompt = `Bạn là giáo viên giỏi. Với mỗi câu hỏi trong danh sách JSON dưới đây, hãy viết lời giải thích ngắn gọn, dễ hiểu bằng tiếng Việt (1-3 câu) giải thích đáp án đúng là gì và tại sao đúng (nếu có studentAnswer sai thì chỉ ra lỗi sai của học sinh).
Nếu câu hỏi chưa có correctAnswer, hãy tự xác định đáp án đúng nhất và điền vào "correctAnswer".

Trả về DUY NHẤT mảng JSON:
[
  {
    "number": 1,
    "correctAnswer": "B",
    "explanation": "Giải thích ngắn gọn bằng tiếng Việt..."
  }
]

DANH SÁCH CÂU HỎI:
${JSON.stringify(compactInput).slice(0, 28000)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Lỗi Gemini API (${res.status}): ${errText.slice(0, 150)}`);
  }

  const json = await res.json();
  const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const cleaned = rawOutput.replace(/^```json\s*|```$/g, '').trim();
  const arr = JSON.parse(cleaned);
  const map = {};
  (Array.isArray(arr) ? arr : []).forEach((item) => {
    map[String(item.number)] = {
      correctAnswer: String(item.correctAnswer || '').trim(),
      explanation: String(item.explanation || '').trim()
    };
  });
  return map;
}
