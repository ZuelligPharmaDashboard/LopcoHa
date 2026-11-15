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
      const pattern = new RegExp(
        `<(?:strong|b|u)>[^<]*\\b${opt}\\s*[.):][^<]*<\/(?:strong|b|u)>`,
        'i'
      );
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
 * Tách bảng đáp án & giải thích ở cuối đề (nếu có)
 */
function extractAnswerKeySection(fullText) {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim());
  let keyStartIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (
      /^(?:---\s*)?(?:ĐÁP\s*ÁN|BẢNG\s*ĐÁP\s*ÁN|HƯỚNG\s*DẪN\s*CHẤM|ANSWER\s*KEY|KEY\s*ĐÁP\s*ÁN)\b/i.test(
        lines[i]
      )
    ) {
      keyStartIdx = i;
      break;
    }
  }

  const bodyLines = keyStartIdx >= 0 ? lines.slice(0, keyStartIdx) : lines;
  const keyLines = keyStartIdx >= 0 ? lines.slice(keyStartIdx + 1) : [];
  const keyMap = {};
  const explanationMap = {};

  if (keyLines.length > 0) {
    // 1. Dạng từng dòng: "1. B (Giải thích: ...)" hoặc "8. would join the charity club"
    keyLines.forEach((kl) => {
      const lineMatch = kl.match(/^(?:Câu\s*)?(\d+)\s*[:.\-)]\s*(.+)$/i);
      if (lineMatch) {
        const qNum = lineMatch[1];
        let rest = lineMatch[2].trim();
        const expMatch = rest.match(
          /\(?\s*(?:Giải\s*thích|HD|Hướng\s*dẫn|Note)\s*[:\-]\s*(.+?)\)?$/i
        );
        if (expMatch) {
          explanationMap[qNum] = expMatch[1].trim();
          rest = rest.slice(0, expMatch.start ?? rest.indexOf(expMatch[0])).trim();
        }
        // Nếu dòng chỉ chứa 1 cặp câu-đáp án
        if (rest && !/\b\d+\s*[:.\-)]\s*[A-Da-d]\b/.test(rest)) {
          keyMap[qNum] = /^[A-Da-d]$/.test(rest) ? rest.toUpperCase() : rest;
        }
      }
    });

    // 2. Dạng nhiều cặp trên 1 dòng: "1.A  2.B  3.C  4.D"
    const keyBlob = keyLines.join('\n');
    const pairRegex = /(?:Câu\s*)?(\d+)\s*[:.\-)]\s*([A-Da-d])(?=\s|$|,|;|\|)/gi;
    let m;
    while ((m = pairRegex.exec(keyBlob)) !== null) {
      if (!keyMap[m[1]]) {
        keyMap[m[1]] = m[2].toUpperCase();
      }
    }

    // 3. Dạng bảng ngang trên Word/PDF (Dòng 1: 1 2 3 4 5, Dòng 2: A C B D A)
    for (let i = 0; i < keyLines.length - 1; i++) {
      const nums = keyLines[i].match(/\b\d+\b/g);
      const letters = keyLines[i + 1].match(/\b[A-Da-d]\b/g);
      if (nums && letters && nums.length >= 2 && nums.length === letters.length) {
        nums.forEach((n, idx) => {
          keyMap[n] = letters[idx].toUpperCase();
        });
      }
    }
  }

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
      currentBlock.rawLines.push(line);
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

  const optMarkerRegex = /(?:^|[\s.?!…”"')…:;])([A-D])\s*[.)]\s*/g;
  const expectedOrder = ['A', 'B', 'C', 'D'];

  const parsedQuestions = blocks.map((blk, idx) => {
    const qNum = blk.number || String(idx + 1);
    const fullBlock = blk.rawLines.join('\n').trim();

    const allMatches = [...fullBlock.matchAll(optMarkerRegex)];
    const seqMatches = [];
    let expIdx = 0;

    for (const m of allMatches) {
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
    const detectedAnswer = combinedKeyMap[qNum] || '';
    const detectedExplanation = explanationMap[qNum] || '';

    return {
      id: `q-${qNum}-${idx}`,
      number: Number(qNum) || idx + 1,
      type: hasOptions ? 'mcq' : 'open',
      passage: blk.passage || '',
      text: stemText || `Câu hỏi số ${qNum}`,
      options,
      correctAnswer: detectedAnswer,
      explanation: detectedExplanation
    };
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

  return (Array.isArray(arr) ? arr : []).map((item, idx) => ({
    id: `ai-q-${idx + 1}`,
    number: Number(item.number) || idx + 1,
    type: item.type === 'mcq' ? 'mcq' : 'open',
    passage: String(item.passage || '').trim(),
    text: String(item.text || '').trim(),
    options: {
      A: String(item.options?.A || '').trim(),
      B: String(item.options?.B || '').trim(),
      C: String(item.options?.C || '').trim(),
      D: String(item.options?.D || '').trim()
    },
    correctAnswer: String(item.correctAnswer || '').trim(),
    explanation: String(item.explanation || '').trim()
  }));
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
