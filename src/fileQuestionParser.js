import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

// Cấu hình worker nội bộ của pdfjs-dist tương thích Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

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
    return {
      plainText: rawRes.value || '',
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
 * VD: <strong>A.</strong> hoặc <u>B. Nội dung</u>
 */
function extractBoldAnswersFromHtml(htmlText) {
  const boldMap = {};
  if (!htmlText) return boldMap;

  const qChunks = htmlText.split(/(?=(?:<p[^>]*>\s*(?:<strong>)?\s*(?:Câu|Bài|Question)\s*\d+))/i);
  qChunks.forEach((chunk) => {
    const qMatch = chunk.match(/(?:Câu|Bài|Question)\s*(\d+)/i);
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
 * Tách bảng đáp án ở cuối đề (hỗ trợ cả dạng danh sách 1.A 2.B và dạng bảng ngang 1 2 3 / A B C)
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

  if (keyLines.length > 0) {
    const keyBlob = keyLines.join('\n');

    // Dạng 1: 1.A | 1: A | 1-A | 1) A | Câu 1: A | Câu 1: 12.5
    const pairRegex = /(?:Câu\s*)?(\d+)\s*[:.\-)]\s*([^\s,;\|\t]+(?:\s+[^\s,;\|\t]+)?)/gi;
    let m;
    while ((m = pairRegex.exec(keyBlob)) !== null) {
      const qNum = m[1];
      const val = m[2].trim();
      if (/^[A-Da-d]$/.test(val)) {
        keyMap[qNum] = val.toUpperCase();
      } else if (val.length <= 40 && !/^câu$/i.test(val)) {
        keyMap[qNum] = val;
      }
    }

    // Dạng 2: Bảng ngang trên Word/PDF (Dòng 1: 1 2 3 4 5, Dòng 2: A C B D A)
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
    keyMap
  };
}

/**
 * Bộ phân tích Rule-Based 100% nguyên văn từ nội dung trích xuất (Không cần AI)
 */
export function parseQuestionsFromExtractedContent({ plainText, htmlText = '' }) {
  const boldMap = extractBoldAnswersFromHtml(htmlText);
  const { bodyText, keyMap } = extractAnswerKeySection(plainText);
  const combinedKeyMap = { ...boldMap, ...keyMap };

  const lines = bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let currentBlock = null;

  const qStartRegex = /^(?:Câu|Bài|Question)\s*(\d+)\s*[:.\-)]\s*(.*)$/i;
  const numStartRegex = /^(\d+)\s*[.)]\s+(.*)$/;

  lines.forEach((line) => {
    const m1 = line.match(qStartRegex);
    const m2 = !m1 ? line.match(numStartRegex) : null;

    if (m1 || m2) {
      if (currentBlock) blocks.push(currentBlock);
      const qNum = (m1 ? m1[1] : m2[1]).trim();
      const firstText = (m1 ? m1[2] : m2[2]).trim();
      currentBlock = {
        number: qNum,
        rawLines: firstText ? [firstText] : []
      };
    } else if (currentBlock) {
      currentBlock.rawLines.push(line);
    }
  });
  if (currentBlock) blocks.push(currentBlock);

  // Nếu file không đánh số "Câu 1 / 1.", coi toàn bộ văn bản là 1 đề tự luận tổng hợp
  if (blocks.length === 0 && bodyText.trim()) {
    return [
      {
        id: 'q-1',
        number: 1,
        type: 'essay',
        text: bodyText.trim(),
        options: { A: '', B: '', C: '', D: '' },
        correctAnswer: combinedKeyMap['1'] || ''
      }
    ];
  }

  const parsedQuestions = blocks.map((blk, idx) => {
    const qNum = blk.number || String(idx + 1);
    const questionStem = [];
    const options = { A: '', B: '', C: '', D: '' };
    let activeOpt = null;

    blk.rawLines.forEach((line) => {
      // Kiểm tra nhiều đáp án nằm cùng 1 hàng: "A. 10   B. 20   C. 30   D. 40"
      const inlineMatches = [
        ...line.matchAll(/(?:^|\s+)([A-D])\s*[.):]\s*(.*?)(?=(?:\s+[A-D]\s*[.):])|$)/g)
      ];

      if (inlineMatches.length >= 2) {
        inlineMatches.forEach((im) => {
          const letter = im[1].toUpperCase();
          options[letter] = im[2].trim();
          activeOpt = letter;
        });
        return;
      }

      // Kiểm tra đáp án bắt đầu đầu dòng: "A. Nội dung..."
      const singleOptMatch = line.match(/^([A-D])\s*[.):]\s*(.*)$/);
      if (singleOptMatch) {
        const letter = singleOptMatch[1].toUpperCase();
        options[letter] = singleOptMatch[2].trim();
        activeOpt = letter;
        return;
      }

      if (activeOpt) {
        options[activeOpt] = `${options[activeOpt]} ${line}`.trim();
      } else {
        questionStem.push(line);
      }
    });

    const hasOptions = Boolean(options.A || options.B || options.C || options.D);
    const detectedAnswer = combinedKeyMap[qNum] || '';

    let qType = 'essay';
    if (hasOptions) {
      qType = 'mcq';
    } else if (detectedAnswer && detectedAnswer.length <= 50) {
      qType = 'short';
    }

    return {
      id: `q-${qNum}-${idx}`,
      number: Number(qNum) || idx + 1,
      type: qType,
      text: questionStem.join('\n').trim() || `Câu hỏi số ${qNum}`,
      options,
      correctAnswer: detectedAnswer
    };
  });

  return parsedQuestions;
}

/**
 * Tùy chọn: Quét đề bằng Gemini AI khi file có định dạng phức tạp / không chuẩn
 */
export async function parseQuestionsWithGeminiAI(rawText, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey.trim()
  )}`;

  const prompt = `Bạn là công cụ trích xuất đề thi chính xác 100% nguyên văn.
Hãy đọc nội dung tài liệu bên dưới và trích xuất thành mảng JSON các câu hỏi.
TUYỆT ĐỐI KHÔNG tự ý sửa đổi, bịa thêm hay tóm tắt nội dung câu hỏi và các phương án A, B, C, D. Giữ nguyên văn 100%.
Nếu tài liệu có phần đáp án ở cuối hoặc đánh dấu đáp án đúng, hãy điền vào "correctAnswer" (ví dụ "A", "B", "C", "D" hoặc đáp án ngắn). Nếu không có đáp án trong tài liệu, để "correctAnswer": "".

Trả về DUY NHẤT JSON hợp lệ theo cấu trúc sau (không bọc markdown):
[
  {
    "number": 1,
    "type": "mcq",
    "text": "Nội dung câu hỏi nguyên văn",
    "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
    "correctAnswer": "A"
  }
]
Lưu ý: "type" nhận một trong 3 giá trị: "mcq" (trắc nghiệm A/B/C/D), "short" (điền đáp án ngắn), hoặc "essay" (tự luận).

NỘI DUNG TÀI LIỆU:
${rawText.slice(0, 28000)}`;

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
    type: ['mcq', 'short', 'essay'].includes(item.type) ? item.type : 'mcq',
    text: String(item.text || '').trim(),
    options: {
      A: String(item.options?.A || '').trim(),
      B: String(item.options?.B || '').trim(),
      C: String(item.options?.C || '').trim(),
      D: String(item.options?.D || '').trim()
    },
    correctAnswer: String(item.correctAnswer || '').trim()
  }));
}
