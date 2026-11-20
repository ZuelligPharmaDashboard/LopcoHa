import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Users,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Send,
  FileText,
  Upload,
  Plus,
  Bell,
  TrendingUp,
  LogOut,
  X,
  Database,
  RefreshCw,
  Eye,
  Check,
  Filter,
  Copy,
  Wand2,
  FileUp,
  Trash2,
  Sparkles,
  BookOpen,
  ExternalLink,
  BarChart3,
  Edit3,
  Timer,
  UserCheck,
  UserX,
  Award,
  RotateCcw,
  Shuffle,
  Lock,
  Unlock,
  CalendarDays,
  Wallet,
  Download,
  QrCode,
  ClipboardList,
  Search
} from 'lucide-react';
import {
  getSupabaseClient,
  getStoredConfig,
  saveLocalConfig,
  hasEnvConfig
} from './supabaseClient';
import {
  extractRawContentFromFile,
  parseQuestionsFromExtractedContent,
  parseQuestionsWithGeminiAI,
  generateExplanationsWithGeminiAI
} from './fileQuestionParser';

const TEACHER_PASSCODE = import.meta.env.VITE_TEACHER_PASSCODE || '2026';

function deriveClassPrefix(className, fallbackId = '') {
  if (!className) return 'HS';
  const cleaned = className
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim();

  const codeMatch = cleaned.match(/\b([0-9]{1,2}[A-Za-z]{1,3}[0-9]{0,2}|[A-Za-z]{2,6}[0-9]{1,3})\b/);
  if (codeMatch) {
    return codeMatch[1].toUpperCase();
  }

  const words = cleaned
    .replace(/^lop\s+/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return words
      .slice(0, 4)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 5).toUpperCase();
  }
  return (fallbackId || 'CLS').slice(0, 4).toUpperCase();
}

function generateRandomPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ============================================================================
// ANSWER-KEY NORMALIZATION (single source of truth for grading, review & stats)
// Keys like "B (ancient). ancient = cổ đại" / "(b)" / "Đáp án: B" / option text -> "B"
// ============================================================================
/**
 * Loose text normalization for comparing answers (case, spaces, punctuation)
 */
function normalizeLooseText(str) {
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
function extractMcqLetter(raw, options = {}) {
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


// Accepted alternatives for open answers: "lived / had lived" or "lived | had lived"
function splitAcceptedAnswers(expected) {
  return String(expected ?? '')
    .split(/\s*\|\s*/)
    .filter(Boolean)
    .flatMap((part) => {
      const sub = part.split('/').map((x) => x.trim()).filter(Boolean);
      return sub.length > 1 && sub.every((x) => /[a-zà-ỹ]/i.test(x)) ? sub : [part];
    });
}

function hasGradableKey(q) {
  if (!q) return false;
  if (q.type === 'mcq') return Boolean(extractMcqLetter(q.correctAnswer, q.options).letter);
  return String(q.correctAnswer ?? '').trim() !== '';
}

function getKeyLetterOrText(q) {
  if (!q) return '';
  if (q.type === 'mcq') return extractMcqLetter(q.correctAnswer, q.options).letter;
  return String(q.correctAnswer ?? '').trim();
}

function isAnswerCorrect(q, actualRaw) {
  const actual = String(actualRaw ?? '').trim();
  if (!q || !actual || actual === '(Bỏ trống)') return false;
  if (q.type === 'mcq') {
    const key = extractMcqLetter(q.correctAnswer, q.options).letter;
    const act = extractMcqLetter(actual, q.options).letter;
    return Boolean(key) && key === act;
  }
  const expected = String(q.correctAnswer ?? '').trim();
  if (!expected) return false;
  const actNorm = normalizeLooseText(actual);
  return splitAcceptedAnswers(expected).some((alt) => normalizeLooseText(alt) === actNorm);
}

function formatKeyForDisplay(q, fallback = '') {
  if (q?.type === 'mcq') {
    const letter = extractMcqLetter(q.correctAnswer || fallback, q.options).letter;
    if (letter) return q.options?.[letter] ? `${letter}. ${q.options[letter]}` : letter;
  }
  return String(q?.correctAnswer || fallback || '').trim();
}

// Clean one question: MCQ key -> single letter, leftover text -> explanation, unreadable key -> teacher grading
function sanitizeQuestion(q) {
  if (!q) return q;
  const type = q.type === 'mcq' ? 'mcq' : 'open';
  const raw = String(q.correctAnswer ?? '').trim();
  let correctAnswer = raw;
  let explanation = q.explanation || '';
  let keyIssue = q.keyIssue || '';
  if (type === 'mcq' && raw) {
    const { letter, rest } = extractMcqLetter(raw, q.options);
    if (letter) {
      correctAnswer = letter;
      if (!explanation && rest) explanation = rest;
    } else {
      correctAnswer = '';
      if (!explanation) explanation = raw;
      keyIssue = keyIssue || `Không đọc được đáp án A–D từ "${raw.slice(0, 40)}" → chờ GV chấm tay`;
    }
  }
  return { ...q, type, correctAnswer, explanation, keyIssue };
}

// Trích xuất danh sách câu hỏi từ cột questions_json hoặc chuỗi nhúng trong rubric
function getAssignmentQuestions(asg) {
  if (!asg) return [];
  let rawList = [];
  if (Array.isArray(asg.questions_json) && asg.questions_json.length > 0) {
    rawList = asg.questions_json;
  } else if (typeof asg.rubric === 'string' && asg.rubric.includes('__SC_QUESTIONS__:')) {
    try {
      const jsonPart = asg.rubric.split('__SC_QUESTIONS__:')[1];
      const parsed = JSON.parse(jsonPart);
      if (Array.isArray(parsed)) rawList = parsed;
    } catch {
      rawList = [];
    }
  }
  // Chuẩn hóa loại câu hỏi về 2 nhóm duy nhất: 'mcq' và 'open'
  return rawList.map((q, idx) =>
    sanitizeQuestion({
      ...q,
      number: Number(q.number) || idx + 1,
      type: q.type === 'mcq' ? 'mcq' : 'open',
      passage: q.passage || '',
      explanation: q.explanation || ''
    })
  );
}

// Trích xuất cấu hình bổ sung của đề (thời gian, loại bài, số lần làm, đảo câu...) từ rubric
function getAssignmentMeta(asg) {
  const defaults = {
    timeLimitMinutes: 0,
    assignmentType: 'homework', // 'homework' | 'practice' | 'exam'
    maxAttempts: 1, // 0 = không giới hạn (chỉ áp dụng cho practice)
    shuffleQuestions: false,
    hideAnswersUntilGraded: false
  };
  if (!asg || typeof asg.rubric !== 'string') {
    return defaults;
  }
  const match = asg.rubric.match(/__SC_META__:(\{.*?\})(?:\n|$)/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      const assignmentType = ['homework', 'practice', 'exam'].includes(parsed.assignmentType)
        ? parsed.assignmentType
        : 'homework';
      const defaultMax = assignmentType === 'practice' ? 3 : 1;
      const maxAttempts =
        parsed.maxAttempts !== undefined && parsed.maxAttempts !== null
          ? Math.max(0, Number(parsed.maxAttempts) || 0)
          : defaultMax;
      return {
        timeLimitMinutes: Number(parsed.timeLimitMinutes) || 0,
        assignmentType,
        maxAttempts,
        shuffleQuestions: Boolean(parsed.shuffleQuestions),
        hideAnswersUntilGraded: Boolean(parsed.hideAnswersUntilGraded)
      };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

// Đảo thứ tự câu hỏi theo mã học sinh (gom nhóm các câu chung 1 bài đọc hiểu để không tách rời đoạn văn)
function getOrderedQuestionsForStudent(questions, studentCode, assignmentId, shouldShuffle) {
  if (!shouldShuffle || !Array.isArray(questions) || questions.length <= 1) {
    return questions;
  }

  // Group consecutive questions sharing the same passage into intact blocks
  const blocks = [];
  questions.forEach((q) => {
    const p = (q.passage || '').trim();
    const lastBlock = blocks[blocks.length - 1];
    if (p && lastBlock && lastBlock.passage === p) {
      lastBlock.items.push(q);
    } else {
      blocks.push({ passage: p, items: [q] });
    }
  });

  if (blocks.length <= 1) {
    return questions;
  }

  const seedStr = `${studentCode || 'HS'}_${assignmentId || 'ASG'}`;
  let seed = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    seed ^= seedStr.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const nextRand = () => {
    seed += 0x6d2b79f5;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = blocks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRand() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  return blocks.flatMap((b) => b.items);
}

function getCleanRubricText(asg) {
  if (!asg?.rubric) return '';
  return asg.rubric
    .split('__SC_QUESTIONS__:')[0]
    .replace(/__SC_META__:\{.*?\}(\n|$)/g, '')
    .trim();
}

// Tính cảnh báo hạn nộp còn mấy ngày
function getDeadlineBadgeInfo(dueDateStr) {
  if (!dueDateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDateStr + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return null;

  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) {
    return {
      diffDays,
      urgent: true,
      label: `Quá hạn ${Math.abs(diffDays)} ngày`,
      badgeClass: 'bg-rose-50 text-rose-700 border-rose-200'
    };
  }
  if (diffDays === 0) {
    return {
      diffDays: 0,
      urgent: true,
      label: 'Hết hạn HÔM NAY',
      badgeClass: 'bg-rose-600 text-white border-rose-600 animate-pulse'
    };
  }
  if (diffDays === 1) {
    return {
      diffDays: 1,
      urgent: true,
      label: 'Còn 1 ngày (Hạn ngày mai)',
      badgeClass: 'bg-amber-50 text-amber-800 border-amber-300'
    };
  }
  if (diffDays <= 3) {
    return {
      diffDays,
      urgent: true,
      label: `Còn ${diffDays} ngày nữa hết hạn`,
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200'
    };
  }
  return {
    diffDays,
    urgent: false,
    label: `Còn ${diffDays} ngày (${due.toLocaleDateString('vi-VN')})`,
    badgeClass: 'bg-slate-100 text-slate-600 border-slate-200'
  };
}

function formatSecondsMMSS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Chấm điểm tự động 100% + tạo nhận xét chi tiết từng câu sai & giải thích
function gradeInteractiveQuestions(questions, studentAnswersMap, topic) {
  const gradableQuestions = questions.filter(
    (q) => hasGradableKey(q)
  );

  if (gradableQuestions.length === 0) {
    return null;
  }

  let correctCount = 0;
  const wrongDetails = [];
  const breakdown = [];
  const wrongNumbers = [];

  gradableQuestions.forEach((q) => {
    const key = String(q.number);
    const expected = getKeyLetterOrText(q);
    const actual = String(studentAnswersMap[key] || '').trim();
    const isRight = isAnswerCorrect(q, actual);

    const expText =
      q.type === 'mcq' && q.options?.[expected.toUpperCase()]
        ? `${expected.toUpperCase()}. ${q.options[expected.toUpperCase()]}`
        : expected;
    const actText =
      actual === ''
        ? 'Bỏ trống'
        : q.type === 'mcq' && q.options?.[actual.toUpperCase()]
        ? `${actual.toUpperCase()}. ${q.options[actual.toUpperCase()]}`
        : actual;

    if (isRight) {
      correctCount += 1;
      breakdown.push({
        question: key,
        status: 'correct',
        expected,
        actual: actual || '(Bỏ trống)',
        explanation: q.explanation || ''
      });
    } else {
      wrongNumbers.push(`Câu ${key}`);
      const line = q.explanation
        ? `Câu ${key}: Em chọn "${actText}" — Đáp án đúng: "${expText}". 💡 Giải thích: ${q.explanation}`
        : `Câu ${key}: Em chọn "${actText}" — Đáp án đúng: "${expText}"`;
      wrongDetails.push(line);
      breakdown.push({
        question: key,
        status: 'wrong',
        expected,
        actual: actual || '(Bỏ trống)',
        explanation: q.explanation || ''
      });
    }
  });

  const hasUngradedOpen = questions.some(
    (q) => !hasGradableKey(q)
  );

  const score = Number(((correctCount / gradableQuestions.length) * 10).toFixed(2));
  const weakTopics = score < 8 && topic ? [topic] : [];

  const autoComment = hasUngradedOpen
    ? `Phần tự động chấm đúng ${correctCount}/${gradableQuestions.length} câu (${score}/10). Các câu tự luận chưa có đáp án mẫu đang chờ giáo viên chấm bổ sung.`
    : wrongNumbers.length === 0
    ? `Xuất sắc! Em làm đúng trọn vẹn ${correctCount}/${gradableQuestions.length} câu, nắm rất chắc kiến thức chuyên đề ${topic || 'bài học'}.`
    : score >= 8
    ? `Làm bài tốt (${correctCount}/${gradableQuestions.length} câu đúng). Em chỉ cần rà soát lại ${wrongNumbers.join(', ')} bên dưới để đạt điểm tối đa.`
    : score >= 6.5
    ? `Mức khá (${correctCount}/${gradableQuestions.length} câu đúng). Em còn nhầm ở ${wrongNumbers.slice(0, 8).join(', ')}${wrongNumbers.length > 8 ? '...' : ''} — xem kỹ đáp án đúng và giải thích bên dưới để củng cố phần ${topic || 'trọng tâm'}.`
    : `Cần ôn tập thêm (${correctCount}/${gradableQuestions.length} câu đúng). Em mất điểm nhiều ở ${wrongNumbers.slice(0, 8).join(', ')}${wrongNumbers.length > 8 ? '...' : ''}. Hãy xem lại từng câu sai và làm bài ôn bổ trợ nhé!`;

  return {
    score,
    hasUngradedOpen,
    weakTopics,
    feedbackJson: {
      correctCount,
      totalCount: gradableQuestions.length,
      wrongDetails,
      breakdown,
      summary: autoComment
    }
  };
}

function autoGradeLegacyTextAnswers(answerKeyRaw, studentAnswerRaw, topic) {
  if (!answerKeyRaw || !answerKeyRaw.trim()) return null;
  const parsePairs = (raw) => {
    const map = {};
    const parts = raw
      .split(/[,\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    parts.forEach((part, idx) => {
      const match = part.match(/^(?:câu\s*)?([^:=\-]+)[:=\-]\s*(.+)$/i);
      const toValue = (v) => {
        const letter = extractMcqLetter(v).letter;
        return (letter || v).toLowerCase();
      };
      if (match) {
        map[match[1].trim().toLowerCase()] = toValue(match[2].trim());
      } else {
        map[String(idx + 1)] = toValue(part);
      }
    });
    return map;
  };

  const keyMap = parsePairs(answerKeyRaw);
  const stuMap = parsePairs(studentAnswerRaw || '');
  const keys = Object.keys(keyMap);
  if (keys.length === 0) return null;

  let correct = 0;
  const wrongDetails = [];
  const breakdown = [];
  keys.forEach((k) => {
    const expected = keyMap[k];
    const actual = stuMap[k] || '(Bỏ trống)';
    if (actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '')) {
      correct += 1;
      breakdown.push({ question: k.toUpperCase(), status: 'correct', expected, actual, explanation: '' });
    } else {
      wrongDetails.push(`Câu ${k.toUpperCase()}: Em chọn "${actual}" — Đáp án đúng là "${expected}"`);
      breakdown.push({ question: k.toUpperCase(), status: 'wrong', expected, actual, explanation: '' });
    }
  });

  const score = Number(((correct / keys.length) * 10).toFixed(2));
  return {
    score,
    weakTopics: score < 8 && topic ? [topic] : [],
    feedbackJson: {
      correctCount: correct,
      totalCount: keys.length,
      wrongDetails,
      breakdown,
      summary: `Em làm đúng ${correct}/${keys.length} câu.`
    }
  };
}

// ============================================================================
// SỔ ĐIỂM (VOCAB + CHẤM TAY), ĐIỂM DANH & HỌC PHÍ, VIETQR — HELPERS
// ============================================================================

// Metadata tags stored as rows in `announcements` (one row per tag per class, class_id = class)
const SC_TAG_VOCAB = '__SC_VOCAB_SCORES__:';
const SC_TAG_MANUAL = '__SC_MANUAL_GRADES__:';
const SC_TAG_CLASS_CFG = '__SC_CLASS_CFG__:';
const SC_TAG_ATTENDANCE = '__SC_ATTENDANCE__:';
const SC_TAG_PRACTICE = '__SC_PRACTICE__:';
// classCfg/vocab/manual/attendance rows are keyed by class_id; practice rows by target_student_id
const SC_CLASS_META_TAGS = {
  vocab: SC_TAG_VOCAB,
  manual: SC_TAG_MANUAL,
  classCfg: SC_TAG_CLASS_CFG,
  attendance: SC_TAG_ATTENDANCE,
  practice: SC_TAG_PRACTICE
};

// Payment account (Vietcombank)
const SC_BANK = {
  bin: '970436',
  bankName: 'Vietcombank',
  accountNo: '1032715226',
  accountName: 'THAI THANH HA'
};

const SC_WEEKDAYS = [
  { key: '1', short: 'T2', long: 'Thứ 2' },
  { key: '2', short: 'T3', long: 'Thứ 3' },
  { key: '3', short: 'T4', long: 'Thứ 4' },
  { key: '4', short: 'T5', long: 'Thứ 5' },
  { key: '5', short: 'T6', long: 'Thứ 6' },
  { key: '6', short: 'T7', long: 'Thứ 7' },
  { key: '7', short: 'CN', long: 'Chủ nhật' }
];

function scUid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatVnd(amount) {
  const n = Math.round(Number(amount) || 0);
  return `${n.toLocaleString('vi-VN')}đ`;
}

function stripVietnamese(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function getCurrentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatYmLabel(ym) {
  const [y, m] = String(ym || '').split('-');
  return y && m ? `${m}/${y}` : ym;
}

function getWeekdayKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const js = d.getDay();
  return String(js === 0 ? 7 : js);
}

function formatSessionDate(dateStr) {
  const wd = SC_WEEKDAYS.find((w) => w.key === getWeekdayKey(dateStr));
  const [, m, d] = String(dateStr).split('-');
  return `${wd ? wd.short : ''} ${d}/${m}`;
}

// "9.5" -> 9.5 ; "18/20" -> 9 ; with column total (e.g. 20): "18" -> 9
// Returns { value } | { missing: true } | null (blank / invalid)
function parseScoreInput(raw, total = 0, allowMissing = false) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const lower = stripVietnamese(text).toLowerCase().replace(/\s+/g, '');
  if (allowMissing && ['cn', 'x', 'chuanop', 'missing'].includes(lower)) {
    return { missing: true };
  }
  const normalized = text.replace(/,/g, '.').replace(/\s+/g, '');
  const frac = normalized.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (!b || a > b) return null;
    return { value: Number(((a / b) * 10).toFixed(2)) };
  }
  const num = Number(normalized.replace(/đ$/i, ''));
  if (Number.isNaN(num) || num < 0) return null;
  const t = Number(total) || 0;
  if (t > 0) {
    if (num > t) return null;
    return { value: Number(((num / t) * 10).toFixed(2)) };
  }
  if (num > 10) return null;
  return { value: Number(num.toFixed(2)) };
}

// Resolve a stored grid cell into a scoring status
function resolveGridCell(cell, column, allowMissing) {
  if (!cell) return { status: 'blank' };
  if (allowMissing && cell.status === 'missing') return { status: 'missing', value: 0 };
  const parsed = parseScoreInput(cell.raw, column?.total, false);
  if (!parsed || parsed.missing) return { status: 'blank' };
  return { status: 'graded', value: parsed.value };
}

function normalizeGridData(data, kind) {
  const columns = Array.isArray(data?.columns) ? data.columns : [];
  const cells = data?.cells && typeof data.cells === 'object' ? data.cells : {};
  return {
    columns: columns.map((c, idx) => ({
      id: c.id || `${kind}_${idx}`,
      label: c.label || (kind === 'vocab' ? `Tuần ${c.week || idx + 1}` : `Cột điểm ${idx + 1}`),
      week: Number(c.week) || idx + 1,
      total: Number(c.total) || 0,
      date: c.date || new Date().toISOString().slice(0, 10)
    })),
    cells
  };
}

// Build regular sessions of a month from the fixed weekly schedule
function generateMonthSessions(schedule, ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m || !schedule) return [];
  const daysInMonth = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const key = getWeekdayKey(dateStr);
    if (Object.prototype.hasOwnProperty.call(schedule, key)) {
      out.push({ id: dateStr, date: dateStr, time: schedule[key] || '', kind: 'regular' });
    }
  }
  return out;
}

function resolveMonthData(attendanceData, classCfg, ym) {
  const stored = attendanceData?.months?.[ym];
  if (stored && Array.isArray(stored.sessions)) {
    return {
      sessions: [...stored.sessions].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
      absent: stored.absent || {},
      paid: stored.paid || {},
      generated: false
    };
  }
  return {
    sessions: generateMonthSessions(classCfg?.schedule || {}, ym),
    absent: {},
    paid: {},
    generated: true
  };
}

function getStudentUnitPrice(studentMeta, classCfg) {
  const custom = Number(studentMeta?.customPrice);
  if (custom > 0) return { price: custom, isCustom: true };
  return { price: Number(classCfg?.unitPrice) || 0, isCustom: false };
}

function computeStudentMonthTuition(student, monthData, classCfg, studentMeta) {
  const sessionRows = monthData.sessions.map((sess) => {
    const absentList = monthData.absent?.[sess.id] || [];
    const present = !absentList.includes(student.id);
    return { ...sess, present };
  });
  const presentCount = sessionRows.filter((s) => s.present).length;
  const { price, isCustom } = getStudentUnitPrice(studentMeta, classCfg);
  const paidInfo = monthData.paid?.[student.id] || null;
  return {
    sessionRows,
    presentCount,
    absentCount: sessionRows.length - presentCount,
    unitPrice: price,
    isCustomPrice: isCustom,
    amount: presentCount * price,
    paid: Boolean(paidInfo),
    paidAt: typeof paidInfo === 'string' ? paidInfo : null
  };
}

function buildTransferNote(student, className, ym) {
  const raw = `${student?.full_name || ''} ${className || ''} T${formatYmLabel(ym).replace('/', ' ')}`;
  return stripVietnamese(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// VietQR (EMVCo) payload + self-contained QR encoder (byte mode, ECC level M)
// ---------------------------------------------------------------------------
function emvTlv(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

function crc16Ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i += 1) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildVietQrPayload({ amount = 0, addInfo = '' } = {}) {
  const beneficiary = emvTlv('00', SC_BANK.bin) + emvTlv('01', SC_BANK.accountNo);
  const merchantInfo =
    emvTlv('00', 'A000000727') + emvTlv('01', beneficiary) + emvTlv('02', 'QRIBFTTA');
  const amt = Math.round(Number(amount) || 0);
  let payload =
    emvTlv('00', '01') +
    emvTlv('01', amt > 0 ? '12' : '11') +
    emvTlv('38', merchantInfo) +
    emvTlv('53', '704') +
    (amt > 0 ? emvTlv('54', String(amt)) : '') +
    emvTlv('58', 'VN');
  const note = stripVietnamese(addInfo).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (note) payload += emvTlv('62', emvTlv('08', note.slice(0, 50)));
  payload += '6304';
  return payload + crc16Ccitt(payload);
}

const QR_M_ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28
];
const QR_M_NUM_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49
];

function qrRawModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function qrDataCodewords(ver) {
  return Math.floor(qrRawModules(ver) / 8) - QR_M_ECC_PER_BLOCK[ver] * QR_M_NUM_BLOCKS[ver];
}

function qrGfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function qrRsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = qrGfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = qrGfMul(root, 0x02);
  }
  return result;
}

function qrRsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  data.forEach((b) => {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= qrGfMul(coef, factor);
    });
  });
  return result;
}

function encodeQrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 40; ver += 1) {
    const used = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (used <= qrDataCodewords(ver) * 8) break;
  }
  if (ver > 40) throw new Error('QR data too long');

  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
  };
  put(0x4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const capacity = qrDataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    dataCw.push(v);
  }

  const numBlocks = QR_M_NUM_BLOCKS[ver];
  const eccLen = QR_M_ECC_PER_BLOCK[ver];
  const rawCw = Math.floor(qrRawModules(ver) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const divisor = qrRsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = dataCw.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = qrRsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const allCw = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) allCw.push(block[i]);
    });
  }

  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  if (ver > 1) {
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < numAlign; p -= step) pos.splice(1, 0, p);
    pos.forEach((ax, i) =>
      pos.forEach((ay, j) => {
        const last = pos.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      })
    );
  }

  const drawFormat = (mask) => {
    const data = (0 << 3) | mask; // ECC level M = 0b00
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((fbits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const b = ((vbits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      setFn(a, c, b);
      setFn(c, a, b);
    }
  }
  drawFormat(0);

  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bitIdx < allCw.length * 8) {
          mod[y][x] = ((allCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx += 1;
        }
      }
    }
  }

  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x];
      }
    }
  };
  const penalty = () => {
    let score = 0;
    for (let y = 0; y < size; y += 1) {
      let runX = 1;
      let runY = 1;
      for (let x = 1; x < size; x += 1) {
        if (mod[y][x] === mod[y][x - 1]) {
          runX += 1;
          if (runX === 5) score += 3;
          else if (runX > 5) score += 1;
        } else runX = 1;
        if (mod[x][y] === mod[x - 1][y]) {
          runY += 1;
          if (runY === 5) score += 3;
          else if (runY > 5) score += 1;
        } else runY = 1;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (mod[y][x]) dark += 1;
        if (
          x < size - 1 &&
          y < size - 1 &&
          mod[y][x] === mod[y][x + 1] &&
          mod[y][x] === mod[y + 1][x] &&
          mod[y][x] === mod[y + 1][x + 1]
        ) {
          score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  };

  let bestMask = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m += 1) {
    applyMask(m);
    drawFormat(m);
    const p = penalty();
    if (p < bestScore) {
      bestScore = p;
      bestMask = m;
    }
    applyMask(m);
  }
  applyMask(bestMask);
  drawFormat(bestMask);
  return mod;
}

function drawQrOnContext(ctx, matrix, x, y, sizePx) {
  const n = matrix.length;
  const quiet = 4;
  const cell = sizePx / (n + quiet * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, sizePx, sizePx);
  ctx.fillStyle = '#0f172a';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (matrix[r][c]) {
        ctx.fillRect(
          Math.floor(x + (c + quiet) * cell),
          Math.floor(y + (r + quiet) * cell),
          Math.ceil(cell),
          Math.ceil(cell)
        );
      }
    }
  }
}

function VietQrCanvas({ amount, addInfo, size = 220 }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(2, window.devicePixelRatio || 1);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    const ctx = canvas.getContext('2d');
    try {
      const matrix = encodeQrMatrix(buildVietQrPayload({ amount, addInfo }));
      drawQrOnContext(ctx, matrix, 0, 0, size * ratio);
    } catch (err) {
      console.error('QR error', err);
    }
  }, [amount, addInfo, size]);
  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className="rounded-xl border border-slate-200 bg-white"
    />
  );
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').split(' ');
  const lines = [];
  let line = '';
  words.forEach((w) => {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Render tuition receipt to a high-resolution canvas (PNG for Zalo)
function renderTuitionReceiptCanvas(receipt) {
  const SCALE = 3;
  const W = 720;
  const font = '"Segoe UI", Roboto, Arial, sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `15px ${font}`;
  const presentText = receipt.sessionRows
    .filter((s) => s.present)
    .map((s) => `${formatSessionDate(s.date)}${s.kind === 'makeup' ? ' (bù)' : ''}`)
    .join(', ');
  const absentText = receipt.sessionRows
    .filter((s) => !s.present)
    .map((s) => formatSessionDate(s.date))
    .join(', ');
  const presentLines = wrapCanvasText(measure, presentText || 'Chưa có buổi học', W - 96);
  const absentLines = absentText ? wrapCanvasText(measure, absentText, W - 96) : [];
  const showQr = !receipt.paid && receipt.amount > 0;
  const H =
    330 + presentLines.length * 22 + (absentLines.length ? 34 + absentLines.length * 22 : 0) + 150 + (showQr ? 330 : 90) + 70;

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#fff1f6';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  roundRectPath(ctx, 16, 16, W - 32, H - 32, 24);
  ctx.fill();
  ctx.strokeStyle = '#fbcfe8';
  ctx.lineWidth = 2;
  ctx.stroke();

  const grad = ctx.createLinearGradient(16, 16, W - 16, 16);
  grad.addColorStop(0, '#ec4899');
  grad.addColorStop(1, '#f43f5e');
  ctx.fillStyle = grad;
  roundRectPath(ctx, 16, 16, W - 32, 112, 24);
  ctx.fill();
  ctx.fillRect(16, 100, W - 32, 28);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 30px ${font}`;
  ctx.fillText('LỚP CÔ HÀ', 48, 66);
  ctx.font = `600 17px ${font}`;
  ctx.fillText(`PHIẾU BÁO HỌC PHÍ THÁNG ${formatYmLabel(receipt.ym)}`, 48, 98);

  let y = 170;
  const label = (k, v, yy) => {
    ctx.font = `15px ${font}`;
    ctx.fillStyle = '#64748b';
    ctx.fillText(k, 48, yy);
    ctx.font = `bold 16px ${font}`;
    ctx.fillStyle = '#0f172a';
    ctx.fillText(v, 200, yy);
  };
  label('Học sinh', receipt.studentName, y);
  y += 30;
  label('Mã học sinh', receipt.studentCode, y);
  y += 30;
  label('Lớp', receipt.className, y);
  y += 30;
  label('Lịch học', receipt.scheduleText || '—', y);
  y += 40;

  ctx.font = `bold 15px ${font}`;
  ctx.fillStyle = '#be185d';
  ctx.fillText(`Các buổi có mặt (${receipt.presentCount} buổi):`, 48, y);
  y += 24;
  ctx.font = `15px ${font}`;
  ctx.fillStyle = '#334155';
  presentLines.forEach((ln) => {
    ctx.fillText(ln, 48, y);
    y += 22;
  });
  if (absentLines.length) {
    y += 12;
    ctx.font = `bold 15px ${font}`;
    ctx.fillStyle = '#b45309';
    ctx.fillText(`Buổi vắng (${receipt.absentCount} buổi — không tính phí):`, 48, y);
    y += 24;
    ctx.font = `15px ${font}`;
    ctx.fillStyle = '#334155';
    absentLines.forEach((ln) => {
      ctx.fillText(ln, 48, y);
      y += 22;
    });
  }

  y += 16;
  ctx.fillStyle = '#fdf2f8';
  roundRectPath(ctx, 40, y, W - 80, 120, 16);
  ctx.fill();
  ctx.font = `15px ${font}`;
  ctx.fillStyle = '#475569';
  ctx.fillText(
    `${receipt.presentCount} buổi × ${formatVnd(receipt.unitPrice)}${receipt.isCustomPrice ? ' (đơn giá riêng)' : ''}`,
    60,
    y + 34
  );
  ctx.font = `bold 15px ${font}`;
  ctx.fillText('TỔNG HỌC PHÍ', 60, y + 90);
  ctx.font = `bold 34px ${font}`;
  ctx.fillStyle = '#db2777';
  ctx.textAlign = 'right';
  ctx.fillText(formatVnd(receipt.amount), W - 60, y + 94);
  ctx.textAlign = 'left';

  y += 140;
  if (receipt.paid) {
    ctx.fillStyle = '#ecfdf5';
    roundRectPath(ctx, 40, y, W - 80, 64, 16);
    ctx.fill();
    ctx.fillStyle = '#047857';
    ctx.font = `bold 20px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText(
      `✓ ĐÃ ĐÓNG HỌC PHÍ${receipt.paidAt ? ` (${new Date(receipt.paidAt).toLocaleDateString('vi-VN')})` : ''}`,
      W / 2,
      y + 40
    );
    ctx.textAlign = 'left';
    y += 90;
  } else if (showQr) {
    const qrSize = 260;
    const matrix = encodeQrMatrix(buildVietQrPayload({ amount: receipt.amount, addInfo: receipt.transferNote }));
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, 40, y, W - 80, qrSize + 40, 16);
    ctx.stroke();
    drawQrOnContext(ctx, matrix, 56, y + 20, qrSize);
    const tx = 56 + qrSize + 24;
    let ty = y + 50;
    const info = (k, v, big) => {
      ctx.font = `14px ${font}`;
      ctx.fillStyle = '#64748b';
      ctx.fillText(k, tx, ty);
      ty += big ? 30 : 24;
      ctx.font = `bold ${big ? 22 : 16}px ${font}`;
      ctx.fillStyle = big ? '#db2777' : '#0f172a';
      wrapCanvasText(ctx, v, W - tx - 56).forEach((ln) => {
        ctx.fillText(ln, tx, ty);
        ty += big ? 30 : 22;
      });
      ty += 14;
    };
    info('Ngân hàng', `${SC_BANK.bankName}`);
    info('Số tài khoản', SC_BANK.accountNo, true);
    info('Chủ tài khoản', SC_BANK.accountName);
    info('Nội dung chuyển khoản', receipt.transferNote);
    y += qrSize + 60;
  } else {
    y += 10;
  }

  ctx.font = `italic 14px ${font}`;
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.fillText('Quét mã bằng app ngân hàng — số tiền & nội dung đã điền sẵn. Cảm ơn quý phụ huynh!', W / 2, y + 14);
  ctx.textAlign = 'left';

  return canvas;
}

function describeSchedule(schedule) {
  if (!schedule || Object.keys(schedule).length === 0) return '';
  return SC_WEEKDAYS.filter((w) => Object.prototype.hasOwnProperty.call(schedule, w.key))
    .map((w) => `${w.short}${schedule[w.key] ? ` ${schedule[w.key]}` : ''}`)
    .join(' • ');
}

// ---------------------------------------------------------------------------
// Score grid (Vocab weekly + Manual multi-column gradebook) — Excel-like input
// ---------------------------------------------------------------------------
function ScoreGridSection({
  kind,
  anchorId,
  title,
  subtitle,
  classObj,
  gridStudents,
  data,
  onUpdate,
  allowMissing,
  setConfirmDialog
}) {
  const grid = normalizeGridData(data, kind);
  const gridKey = `${kind}-${classObj?.id || 'none'}`;

  const focusCell = (colIdx, rowIdx) => {
    const el = document.querySelector(`[data-grid="${gridKey}"][data-col="${colIdx}"][data-row="${rowIdx}"]`);
    if (el) {
      el.focus();
      el.select?.();
    }
  };

  const commitCell = (col, stuId, rawValue) => {
    const text = String(rawValue ?? '').trim();
    onUpdate((prev) => {
      const g = normalizeGridData(prev, kind);
      const colCells = { ...(g.cells[col.id] || {}) };
      if (!text) {
        delete colCells[stuId];
      } else {
        const parsed = parseScoreInput(text, col.total, allowMissing);
        if (parsed?.missing) colCells[stuId] = { status: 'missing' };
        else colCells[stuId] = { raw: text, status: 'graded' };
      }
      return { ...g, cells: { ...g.cells, [col.id]: colCells } };
    });
  };

  const updateColumn = (colId, patch) => {
    onUpdate((prev) => {
      const g = normalizeGridData(prev, kind);
      return { ...g, columns: g.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)) };
    });
  };

  const addColumn = () => {
    onUpdate((prev) => {
      const g = normalizeGridData(prev, kind);
      const nextWeek = g.columns.reduce((mx, c) => Math.max(mx, Number(c.week) || 0), 0) + 1;
      const col = {
        id: scUid(kind),
        label: kind === 'vocab' ? `Tuần ${nextWeek}` : `Cột điểm ${g.columns.length + 1}`,
        week: nextWeek,
        total: 0,
        date: new Date().toISOString().slice(0, 10)
      };
      return { ...g, columns: [...g.columns, col] };
    });
  };

  const removeColumn = (col) => {
    setConfirmDialog({
      title: `Xóa cột "${col.label}"?`,
      message: 'Toàn bộ điểm đã nhập trong cột này sẽ bị xóa và không thể hoàn tác.',
      confirmText: 'Xóa cột',
      onConfirm: async () => {
        onUpdate((prev) => {
          const g = normalizeGridData(prev, kind);
          const nextCells = { ...g.cells };
          delete nextCells[col.id];
          return { columns: g.columns.filter((c) => c.id !== col.id), cells: nextCells };
        });
      }
    });
  };

  const markBlankAsMissing = (col) => {
    onUpdate((prev) => {
      const g = normalizeGridData(prev, kind);
      const colCells = { ...(g.cells[col.id] || {}) };
      gridStudents.forEach((s) => {
        if (!colCells[s.id]) colCells[s.id] = { status: 'missing' };
      });
      return { ...g, cells: { ...g.cells, [col.id]: colCells } };
    });
  };

  const accentBtn = kind === 'vocab' ? 'bg-violet-600 hover:bg-violet-700' : 'bg-sky-600 hover:bg-sky-700';
  const accentText = kind === 'vocab' ? 'text-violet-700' : 'text-sky-700';
  const accentBorder = kind === 'vocab' ? 'border-violet-200' : 'border-sky-200';

  return (
    <div id={anchorId} className={`bg-white rounded-3xl border ${accentBorder} shadow-sm overflow-hidden scroll-mt-6`}>
      <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className={`font-bold flex items-center gap-2 ${accentText}`}>
            {kind === 'vocab' ? <BookOpen className="w-4 h-4" /> : <ClipboardList className="w-4 h-4" />}
            <span>{title}</span>
            {classObj && <span className="text-slate-500 font-semibold">— {classObj.name}</span>}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={addColumn}
          disabled={!classObj}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-white text-xs font-bold shadow-sm disabled:opacity-50 ${accentBtn}`}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{kind === 'vocab' ? 'Thêm tuần Vocab' : 'Thêm cột điểm'}</span>
        </button>
      </div>

      {!classObj ? (
        <div className="p-6 text-sm text-slate-400 text-center">Anh chọn một lớp để nhập điểm.</div>
      ) : grid.columns.length === 0 ? (
        <div className="p-6 text-sm text-slate-400 text-center">
          Chưa có cột nào — bấm “{kind === 'vocab' ? '+ Thêm tuần Vocab' : '+ Thêm cột điểm'}” để bắt đầu.
        </div>
      ) : gridStudents.length === 0 ? (
        <div className="p-6 text-sm text-slate-400 text-center">Lớp này chưa có học sinh đang học.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-left border-collapse min-w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <th className="py-2 px-3 sticky left-0 bg-slate-50 z-10 min-w-[180px] font-semibold">Học sinh</th>
                {grid.columns.map((col) => (
                  <th key={col.id} className="py-2 px-2 align-top min-w-[132px] border-l border-slate-200">
                    <div className="flex items-start gap-1">
                      <input
                        key={`lbl-${col.id}-${col.label}`}
                        defaultValue={col.label}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== col.label) updateColumn(col.id, { label: v });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        title="Bấm để đổi tên cột"
                        className="w-full px-1.5 py-1 text-xs font-bold text-slate-900 bg-white border border-transparent hover:border-slate-300 focus:border-pink-400 rounded-md outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => removeColumn(col)}
                        title="Xóa cột"
                        className="p-1 text-slate-300 hover:text-rose-600 shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-1 mt-1 text-[10px] font-medium text-slate-500">
                      <select
                        value={col.week}
                        onChange={(e) => updateColumn(col.id, { week: Number(e.target.value) })}
                        title="Tuần tương ứng (lên biểu đồ Tab 1)"
                        className="px-1 py-0.5 bg-white border border-slate-200 rounded"
                      >
                        {Array.from({ length: 52 }, (_, i) => i + 1).map((w) => (
                          <option key={w} value={w}>
                            Tuần {w}
                          </option>
                        ))}
                      </select>
                      <input
                        key={`tot-${col.id}-${col.total}`}
                        type="number"
                        min="0"
                        defaultValue={col.total || ''}
                        placeholder="Tổng câu"
                        title="Tổng số câu (để trống = nhập thang 10). Có tổng câu thì gõ số câu đúng, VD 18"
                        onBlur={(e) => {
                          const v = Math.max(0, Number(e.target.value) || 0);
                          if (v !== col.total) updateColumn(col.id, { total: v });
                        }}
                        className="w-16 px-1 py-0.5 bg-white border border-slate-200 rounded"
                      />
                    </div>
                    {allowMissing && (
                      <button
                        type="button"
                        onClick={() => markBlankAsMissing(col)}
                        className="mt-1 text-[10px] font-semibold text-rose-600 hover:underline"
                      >
                        Ô trống → Chưa nộp
                      </button>
                    )}
                  </th>
                ))}
                <th className="py-2 px-3 border-l border-slate-200 text-center font-semibold">TB</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {gridStudents.map((stu, rowIdx) => {
                let sum = 0;
                let cnt = 0;
                return (
                  <tr key={stu.id} className="hover:bg-slate-50/70">
                    <td className="py-1.5 px-3 sticky left-0 bg-white z-10">
                      <div className="font-semibold text-slate-900 text-xs">{stu.full_name}</div>
                      <div className="font-mono text-[10px] text-pink-600">{stu.student_code}</div>
                    </td>
                    {grid.columns.map((col, colIdx) => {
                      const cell = grid.cells[col.id]?.[stu.id];
                      const resolved = resolveGridCell(cell, col, allowMissing);
                      if (resolved.status !== 'blank') {
                        sum += resolved.value;
                        cnt += 1;
                      }
                      const rawShown = resolved.status === 'missing' ? 'CN' : cell?.raw || '';
                      const showConverted =
                        resolved.status === 'graded' && String(cell?.raw || '').trim() !== String(resolved.value);
                      return (
                        <td key={col.id} className="py-1 px-2 border-l border-slate-100">
                          <div className="relative">
                            <input
                              key={`${col.id}-${stu.id}-${rawShown}`}
                              defaultValue={rawShown}
                              data-grid={gridKey}
                              data-col={colIdx}
                              data-row={rowIdx}
                              onFocus={(e) => e.target.select()}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v === rawShown) return;
                                commitCell(col, stu.id, v);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  if (rowIdx + 1 < gridStudents.length) focusCell(colIdx, rowIdx + 1);
                                  else e.currentTarget.blur();
                                } else if (e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  focusCell(colIdx, rowIdx + 1);
                                } else if (e.key === 'ArrowUp') {
                                  e.preventDefault();
                                  focusCell(colIdx, rowIdx - 1);
                                }
                              }}
                              placeholder="—"
                              className={`w-full px-2 py-1.5 text-xs font-semibold rounded-lg border outline-none focus:ring-2 focus:ring-pink-300 ${
                                resolved.status === 'missing'
                                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                                  : resolved.status === 'graded'
                                  ? 'bg-emerald-50/60 border-emerald-200 text-slate-900'
                                  : cell
                                  ? 'bg-amber-50 border-amber-300 text-amber-800'
                                  : 'bg-white border-slate-200 text-slate-900'
                              }`}
                            />
                            {showConverted && (
                              <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-700 pointer-events-none">
                                ={resolved.value.toFixed(1)}
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                    <td className="py-1 px-3 border-l border-slate-100 text-center text-xs font-bold text-pink-700">
                      {cnt > 0 ? (sum / cnt).toFixed(1) : '—'}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <td className="py-2 px-3 sticky left-0 bg-slate-50 z-10">TB cả lớp</td>
                {grid.columns.map((col) => {
                  let s = 0;
                  let c = 0;
                  let miss = 0;
                  gridStudents.forEach((stu) => {
                    const r = resolveGridCell(grid.cells[col.id]?.[stu.id], col, allowMissing);
                    if (r.status !== 'blank') {
                      s += r.value;
                      c += 1;
                    }
                    if (r.status === 'missing') miss += 1;
                  });
                  return (
                    <td key={col.id} className="py-2 px-2 border-l border-slate-200">
                      {c > 0 ? (s / c).toFixed(1) : '—'}
                      {miss > 0 && <span className="ml-1 text-rose-600">({miss} CN)</span>}
                    </td>
                  );
                })}
                <td className="border-l border-slate-200" />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="px-4 py-2.5 bg-slate-50/70 border-t border-slate-100 text-[11px] text-slate-500 leading-relaxed">
        Gõ <strong>9.5</strong> (thang 10) hoặc <strong>18/20</strong> (tự đổi = 9.0đ). Nếu cột có “Tổng câu”, chỉ cần gõ số câu
        đúng. <strong>Enter</strong> nhảy xuống học sinh bên dưới. Ô trống = không tính vào điểm TB
        {allowMissing && (
          <>
            {' '}• Gõ <strong>CN</strong> = <span className="text-rose-600 font-semibold">Chưa nộp</span> (tính 0đ & đưa vào
            nhắc nhở gửi Phụ huynh)
          </>
        )}
        . Ô màu vàng = giá trị không hợp lệ (không được tính).
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Class tuition price & weekly schedule settings
// ---------------------------------------------------------------------------
function ClassBillingSettingsCard({ classes, classCfgMap, onUpdateClassCfg }) {
  if (classes.length === 0) return null;
  return (
    <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-4">
      <div>
        <h2 className="font-bold text-slate-900 flex items-center gap-2">
          <Wallet className="w-4 h-4 text-pink-600" />
          <span>Học phí & Lịch học cố định theo lớp</span>
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Tab 4 tự sinh các buổi học trong tháng theo lịch này. Đơn giá riêng từng học sinh chỉnh ở danh sách bên dưới.
        </p>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        {classes.map((cls) => {
          const cfg = classCfgMap[cls.id] || {};
          const schedule = cfg.schedule || {};
          return (
            <div key={cls.id} className="p-3.5 rounded-2xl border border-slate-200 bg-slate-50/60 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="font-bold text-sm text-slate-900">{cls.name}</div>
                <span className="text-[11px] text-slate-500">{cls.group_name}</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <span className="font-semibold whitespace-nowrap">Đơn giá chuẩn / buổi</span>
                <input
                  key={`price-${cls.id}-${cfg.unitPrice || 0}`}
                  type="number"
                  min="0"
                  step="1000"
                  defaultValue={cfg.unitPrice || ''}
                  placeholder="VD 150000"
                  onBlur={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 0);
                    if (v !== (Number(cfg.unitPrice) || 0)) {
                      onUpdateClassCfg(cls.id, (prev) => ({ ...prev, unitPrice: v }));
                    }
                  }}
                  className="flex-1 min-w-0 px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-semibold"
                />
                <span className="text-slate-400">VNĐ</span>
              </label>
              <div className="space-y-1.5">
                {SC_WEEKDAYS.map((wd) => {
                  const on = Object.prototype.hasOwnProperty.call(schedule, wd.key);
                  return (
                    <div key={wd.key} className="flex items-center gap-2 text-xs">
                      <label className="inline-flex items-center gap-1.5 w-24 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            onUpdateClassCfg(cls.id, (prev) => {
                              const next = { ...(prev.schedule || {}) };
                              if (e.target.checked) next[wd.key] = next[wd.key] || '18:00-19:30';
                              else delete next[wd.key];
                              return { ...prev, schedule: next };
                            });
                          }}
                          className="rounded text-pink-600"
                        />
                        <span className={on ? 'font-bold text-slate-900' : 'text-slate-500'}>{wd.long}</span>
                      </label>
                      {on && (
                        <input
                          key={`time-${cls.id}-${wd.key}-${schedule[wd.key]}`}
                          defaultValue={schedule[wd.key]}
                          placeholder="18:00-19:30"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v !== schedule[wd.key]) {
                              onUpdateClassCfg(cls.id, (prev) => ({
                                ...prev,
                                schedule: { ...(prev.schedule || {}), [wd.key]: v }
                              }));
                            }
                          }}
                          className="w-32 px-2 py-1 border border-slate-300 rounded-lg bg-white font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receipt preview modal (PNG export + copy image for Zalo)
// ---------------------------------------------------------------------------
function TuitionReceiptModal({ receipt, onClose, notify }) {
  const [dataUrl, setDataUrl] = useState('');
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!receipt) return;
    try {
      const canvas = renderTuitionReceiptCanvas(receipt);
      canvasRef.current = canvas;
      setDataUrl(canvas.toDataURL('image/png'));
    } catch (err) {
      notify('Lỗi tạo phiếu: ' + err.message, 'error');
    }
  }, [receipt, notify]);

  if (!receipt) return null;
  const fileName = `PhieuHocPhi_${stripVietnamese(receipt.studentCode || receipt.studentName).replace(/[^A-Za-z0-9-]/g, '')}_${receipt.ym}.png`;

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };

  const handleCopyImage = () => {
    const canvas = canvasRef.current;
    if (!canvas || !navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
      notify('Trình duyệt chưa hỗ trợ copy ảnh — anh bấm Tải PNG nhé!', 'error');
      return;
    }
    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        notify('Đã copy ảnh phiếu — mở Zalo và Ctrl+V để gửi!');
      } catch {
        notify('Không copy được ảnh — anh bấm Tải PNG nhé!', 'error');
      }
    }, 'image/png');
  };

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-3xl max-w-lg w-full max-h-[92vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div className="font-bold text-slate-900 text-sm">
            Phiếu báo học phí — {receipt.studentName} ({formatYmLabel(receipt.ym)})
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto bg-slate-100 p-3">
          {dataUrl ? (
            <img src={dataUrl} alt="Phiếu báo học phí" className="w-full rounded-xl shadow" />
          ) : (
            <div className="p-10 text-center text-sm text-slate-400">Đang tạo phiếu...</div>
          )}
        </div>
        <div className="p-3 border-t border-slate-200 flex flex-wrap justify-end gap-2">
          <button
            onClick={handleCopyImage}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copy ảnh (dán Zalo)</span>
          </button>
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-xs font-bold"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Tải phiếu .PNG</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Attendance & tuition
// ---------------------------------------------------------------------------
function AttendanceTuitionPanel({
  classes,
  students,
  studentMetaMap,
  classCfgMap,
  attendanceMap,
  onUpdateAttendance,
  includeInactive,
  defaultClassId,
  setConfirmDialog,
  notify,
  onOpenReceipt
}) {
  const [ym, setYm] = useState(getCurrentYm());
  const [classId, setClassId] = useState(
    defaultClassId && defaultClassId !== 'all' ? defaultClassId : classes[0]?.id || ''
  );
  const [makeupDate, setMakeupDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [makeupTime, setMakeupTime] = useState('');

  useEffect(() => {
    if (!classId && classes[0]) setClassId(classes[0].id);
  }, [classes, classId]);

  const cls = classes.find((c) => c.id === classId) || null;
  const cfg = (cls && classCfgMap[cls.id]) || {};
  const monthData = cls ? resolveMonthData(attendanceMap[cls.id], cfg, ym) : null;

  const isActive = (s) => (studentMetaMap[s.id]?.status || 'active') === 'active';
  const roster = cls
    ? students
        .filter((s) => s.class_id === cls.id && (includeInactive || isActive(s)))
        .sort((a, b) => String(a.student_code).localeCompare(String(b.student_code)))
    : [];

  // Write a month (materializing generated sessions on first edit)
  const updateMonth = (updater) => {
    if (!cls) return;
    onUpdateAttendance(cls.id, (prev) => {
      const base = resolveMonthData(prev, classCfgMap[cls.id] || {}, ym);
      const current = { sessions: base.sessions, absent: base.absent, paid: base.paid };
      const next = updater(current);
      return { ...(prev || {}), months: { ...((prev && prev.months) || {}), [ym]: next } };
    });
  };

  const togglePresent = (sessId, stuId) => {
    updateMonth((m) => {
      const list = new Set(m.absent[sessId] || []);
      if (list.has(stuId)) list.delete(stuId);
      else list.add(stuId);
      return { ...m, absent: { ...m.absent, [sessId]: Array.from(list) } };
    });
  };

  const setSessionAll = (sessId, present) => {
    updateMonth((m) => ({
      ...m,
      absent: { ...m.absent, [sessId]: present ? [] : roster.map((s) => s.id) }
    }));
  };

  const togglePaid = (stuId) => {
    updateMonth((m) => {
      const paid = { ...m.paid };
      if (paid[stuId]) delete paid[stuId];
      else paid[stuId] = new Date().toISOString().slice(0, 10);
      return { ...m, paid };
    });
  };

  const addMakeup = () => {
    if (!makeupDate || !makeupDate.startsWith(ym)) {
      notify(`Ngày buổi bù phải nằm trong tháng ${formatYmLabel(ym)}!`, 'error');
      return;
    }
    updateMonth((m) => ({
      ...m,
      sessions: [...m.sessions, { id: scUid('bu'), date: makeupDate, time: makeupTime.trim(), kind: 'makeup' }]
    }));
    notify(`Đã thêm buổi bù ${formatSessionDate(makeupDate)}!`);
  };

  const removeSession = (sess) => {
    setConfirmDialog({
      title: `Xóa buổi ${formatSessionDate(sess.date)}?`,
      message: 'Buổi này sẽ không tính học phí (dùng cho ngày nghỉ lễ / nghỉ đột xuất).',
      confirmText: 'Xóa buổi',
      onConfirm: async () => {
        updateMonth((m) => {
          const absent = { ...m.absent };
          delete absent[sess.id];
          return { ...m, sessions: m.sessions.filter((s) => s.id !== sess.id), absent };
        });
      }
    });
  };

  const regenerateFromSchedule = () => {
    setConfirmDialog({
      title: 'Sinh lại buổi học theo lịch cố định?',
      message:
        'Các buổi thường trong tháng sẽ được sinh lại theo lịch ở Tab 3 (giữ nguyên buổi bù, điểm danh của ngày trùng và trạng thái đóng tiền).',
      confirmText: 'Sinh lại',
      onConfirm: async () => {
        updateMonth((m) => {
          const regular = generateMonthSessions((classCfgMap[cls.id] || {}).schedule || {}, ym);
          const makeups = m.sessions.filter((s) => s.kind === 'makeup');
          return { ...m, sessions: [...regular, ...makeups] };
        });
      }
    });
  };

  const rows = monthData
    ? roster.map((stu) => ({
        stu,
        t: computeStudentMonthTuition(stu, monthData, cfg, studentMetaMap[stu.id])
      }))
    : [];

  const financeSummary = classes.map((c) => {
    const ccfg = classCfgMap[c.id] || {};
    const md = resolveMonthData(attendanceMap[c.id], ccfg, ym);
    const list = students.filter((s) => s.class_id === c.id && isActive(s));
    let expected = 0;
    let collected = 0;
    let paidCount = 0;
    list.forEach((s) => {
      const t = computeStudentMonthTuition(s, md, ccfg, studentMetaMap[s.id]);
      expected += t.amount;
      if (t.paid) {
        collected += t.amount;
        paidCount += 1;
      }
    });
    return { cls: c, studentCount: list.length, sessions: md.sessions.length, expected, collected, paidCount };
  });
  const totals = financeSummary.reduce(
    (acc, r) => ({
      studentCount: acc.studentCount + r.studentCount,
      expected: acc.expected + r.expected,
      collected: acc.collected + r.collected,
      paidCount: acc.paidCount + r.paidCount
    }),
    { studentCount: 0, expected: 0, collected: 0, paidCount: 0 }
  );

  const classTotals = rows.reduce(
    (acc, r) => ({
      expected: acc.expected + r.t.amount,
      collected: acc.collected + (r.t.paid ? r.t.amount : 0)
    }),
    { expected: 0, collected: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarDays className="w-5 h-5 text-pink-600" />
          <input
            type="month"
            value={ym}
            onChange={(e) => e.target.value && setYm(e.target.value)}
            className="px-3 py-2 text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl"
          />
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="px-3 py-2 text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {cls && (
            <span className="text-xs text-slate-600">
              Đơn giá chuẩn: <strong className="text-pink-700">{formatVnd(cfg.unitPrice)}</strong>/buổi • Lịch:{' '}
              <strong>{describeSchedule(cfg.schedule) || 'Chưa cài (Tab 3)'}</strong>
            </span>
          )}
        </div>
        {cls && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={makeupDate}
              onChange={(e) => setMakeupDate(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
            <input
              value={makeupTime}
              onChange={(e) => setMakeupTime(e.target.value)}
              placeholder="Giờ (tùy chọn)"
              className="w-28 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
            <button
              type="button"
              onClick={addMakeup}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-700 text-white text-xs font-bold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Thêm buổi bù</span>
            </button>
            <button
              type="button"
              onClick={regenerateFromSchedule}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sinh lại theo lịch</span>
            </button>
          </div>
        )}
      </div>

      {!cls ? (
        <div className="bg-white p-8 rounded-3xl border border-slate-200 text-center text-sm text-slate-400">
          Chưa có lớp nào — anh tạo lớp ở Tab 3 trước nhé.
        </div>
      ) : (
        <div className="bg-white rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-slate-900">
                Điểm danh & Học phí {cls.name} — Tháng {formatYmLabel(ym)}
              </h2>
              <p className="text-xs text-slate-500">
                {monthData.sessions.length} buổi • Mặc định tick <strong>Có mặt</strong> cho học sinh đang học — bỏ tick nếu
                vắng. {monthData.generated && 'Lịch tháng đang sinh tự động, sẽ lưu khi anh chỉnh lần đầu.'}
              </p>
            </div>
            <div className="text-xs text-slate-600">
              Dự thu <strong className="text-slate-900">{formatVnd(classTotals.expected)}</strong> • Đã thu{' '}
              <strong className="text-emerald-700">{formatVnd(classTotals.collected)}</strong> • Còn nợ{' '}
              <strong className="text-rose-700">{formatVnd(classTotals.expected - classTotals.collected)}</strong>
            </div>
          </div>

          {monthData.sessions.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              Tháng này chưa có buổi học nào. Anh cài lịch cố định ở Tab 3 hoặc bấm “+ Thêm buổi bù”.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-left border-collapse min-w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                    <th className="py-2 px-3 sticky left-0 bg-slate-50 z-10 min-w-[170px] font-semibold">Học sinh</th>
                    {monthData.sessions.map((sess) => (
                      <th key={sess.id} className="py-2 px-1.5 text-center border-l border-slate-200 min-w-[58px]">
                        <div className={`font-bold ${sess.kind === 'makeup' ? 'text-violet-700' : 'text-slate-800'}`}>
                          {formatSessionDate(sess.date)}
                        </div>
                        <div className="text-[10px] text-slate-400">{sess.kind === 'makeup' ? 'Buổi bù' : sess.time}</div>
                        <div className="flex items-center justify-center gap-1 mt-0.5">
                          <button
                            type="button"
                            title="Cả lớp có mặt"
                            onClick={() => setSessionAll(sess.id, true)}
                            className="text-emerald-600 hover:text-emerald-800"
                          >
                            <Check className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            title="Xóa buổi (nghỉ)"
                            onClick={() => removeSession(sess)}
                            className="text-slate-300 hover:text-rose-600"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="py-2 px-2 border-l border-slate-200 text-center font-semibold">Có mặt</th>
                    <th className="py-2 px-2 text-right font-semibold">Đơn giá</th>
                    <th className="py-2 px-2 text-right font-semibold">Thành tiền</th>
                    <th className="py-2 px-2 text-center font-semibold">Thanh toán</th>
                    <th className="py-2 px-2 text-center font-semibold">Phiếu</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {rows.map(({ stu, t }) => (
                    <tr key={stu.id} className="hover:bg-slate-50/70">
                      <td className="py-1.5 px-3 sticky left-0 bg-white z-10">
                        <div className="font-semibold text-slate-900">{stu.full_name}</div>
                        <div className="font-mono text-[10px] text-pink-600">{stu.student_code}</div>
                      </td>
                      {t.sessionRows.map((sess) => (
                        <td key={sess.id} className="py-1 px-1 text-center border-l border-slate-100">
                          <input
                            type="checkbox"
                            checked={sess.present}
                            onChange={() => togglePresent(sess.id, stu.id)}
                            className="w-4 h-4 rounded text-emerald-600 cursor-pointer"
                          />
                        </td>
                      ))}
                      <td className="py-1 px-2 text-center font-bold border-l border-slate-100">
                        {t.presentCount}/{t.sessionRows.length}
                      </td>
                      <td className="py-1 px-2 text-right whitespace-nowrap">
                        {formatVnd(t.unitPrice)}
                        {t.isCustomPrice && <div className="text-[10px] text-violet-600 font-semibold">giá riêng</div>}
                      </td>
                      <td className="py-1 px-2 text-right font-bold text-slate-900 whitespace-nowrap">{formatVnd(t.amount)}</td>
                      <td className="py-1 px-2 text-center">
                        <button
                          type="button"
                          onClick={() => togglePaid(stu.id)}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-bold border whitespace-nowrap ${
                            t.paid
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-rose-50 text-rose-700 border-rose-200'
                          }`}
                        >
                          {t.paid ? '✓ Đã đóng' : 'Chưa đóng'}
                        </button>
                      </td>
                      <td className="py-1 px-2 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            onOpenReceipt({
                              ym,
                              studentName: stu.full_name,
                              studentCode: stu.student_code,
                              className: cls.name,
                              scheduleText: describeSchedule(cfg.schedule),
                              transferNote: buildTransferNote(stu, cls.name, ym),
                              ...t
                            })
                          }
                          title="Xuất phiếu báo học phí .PNG kèm VietQR"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-pink-50 hover:bg-pink-100 text-pink-700 border border-pink-200 font-bold"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span>PNG</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 overflow-hidden">
        <div className="p-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-pink-600" />
            <span>Tổng hợp tài chính toàn bộ các lớp — Tháng {formatYmLabel(ym)}</span>
          </h2>
          <p className="text-xs text-slate-500">Chỉ tính học sinh đang học. Học phí = số buổi có mặt × đơn giá (ưu tiên giá riêng).</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <th className="py-2.5 px-4 font-semibold">Lớp</th>
                <th className="py-2.5 px-4 font-semibold text-center">Sĩ số</th>
                <th className="py-2.5 px-4 font-semibold text-center">Số buổi</th>
                <th className="py-2.5 px-4 font-semibold text-right">Dự thu</th>
                <th className="py-2.5 px-4 font-semibold text-right">Đã thu</th>
                <th className="py-2.5 px-4 font-semibold text-right">Công nợ</th>
                <th className="py-2.5 px-4 font-semibold text-center">Đã đóng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {financeSummary.map((r) => (
                <tr key={r.cls.id} className="hover:bg-slate-50/70">
                  <td className="py-2 px-4 font-semibold text-slate-900">{r.cls.name}</td>
                  <td className="py-2 px-4 text-center">{r.studentCount}</td>
                  <td className="py-2 px-4 text-center">{r.sessions}</td>
                  <td className="py-2 px-4 text-right">{formatVnd(r.expected)}</td>
                  <td className="py-2 px-4 text-right text-emerald-700 font-semibold">{formatVnd(r.collected)}</td>
                  <td className="py-2 px-4 text-right text-rose-700 font-semibold">{formatVnd(r.expected - r.collected)}</td>
                  <td className="py-2 px-4 text-center">
                    {r.paidCount}/{r.studentCount}
                  </td>
                </tr>
              ))}
              <tr className="bg-pink-50/60 font-bold text-slate-900">
                <td className="py-2.5 px-4">TỔNG</td>
                <td className="py-2.5 px-4 text-center">{totals.studentCount}</td>
                <td className="py-2.5 px-4" />
                <td className="py-2.5 px-4 text-right">{formatVnd(totals.expected)}</td>
                <td className="py-2.5 px-4 text-right text-emerald-700">{formatVnd(totals.collected)}</td>
                <td className="py-2.5 px-4 text-right text-rose-700">{formatVnd(totals.expected - totals.collected)}</td>
                <td className="py-2.5 px-4 text-center">
                  {totals.paidCount}/{totals.studentCount}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Student portal tab 3: attendance history + tuition + VietQR
// ---------------------------------------------------------------------------
function StudentTuitionView({ student, classObj, classCfg, attendanceData, studentMeta, notify }) {
  const [ym, setYm] = useState(getCurrentYm());
  const monthData = resolveMonthData(attendanceData, classCfg || {}, ym);
  const t = computeStudentMonthTuition(student, monthData, classCfg || {}, studentMeta);
  const className = classObj?.name || student.class_name || '';
  const transferNote = buildTransferNote(student, className, ym);

  const copyText = (text, msg) => {
    navigator.clipboard?.writeText(text);
    notify(msg);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900 flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-pink-600" />
              <span>Điểm danh & Học phí tháng {formatYmLabel(ym)}</span>
            </h2>
            <p className="text-xs text-slate-500">
              Lịch học: {describeSchedule(classCfg?.schedule) || 'Cô Hà chưa cập nhật lịch cố định'}
            </p>
          </div>
          <input
            type="month"
            value={ym}
            onChange={(e) => e.target.value && setYm(e.target.value)}
            className="px-3 py-2 text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl"
          />
        </div>

        {t.sessionRows.length === 0 ? (
          <p className="text-sm text-slate-400">Tháng này chưa có buổi học nào được ghi nhận.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {t.sessionRows.map((s) => (
              <div
                key={s.id}
                className={`p-2 rounded-xl border text-center ${
                  !s.present
                    ? 'bg-amber-50 border-amber-200'
                    : s.kind === 'makeup'
                    ? 'bg-violet-50 border-violet-200'
                    : 'bg-emerald-50 border-emerald-200'
                }`}
              >
                <div className="text-xs font-bold text-slate-900">{formatSessionDate(s.date)}</div>
                <div
                  className={`text-[11px] font-semibold ${
                    !s.present ? 'text-amber-700' : s.kind === 'makeup' ? 'text-violet-700' : 'text-emerald-700'
                  }`}
                >
                  {!s.present ? 'Vắng' : s.kind === 'makeup' ? 'Buổi bù' : 'Có mặt'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
        <div className="grid md:grid-cols-2 gap-5 items-start">
          <div className="space-y-3">
            <h3 className="font-bold text-slate-900 text-sm">Bảng kê học phí</h3>
            <div className="text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-500">Số buổi có mặt</span>
                <strong>
                  {t.presentCount}/{t.sessionRows.length} buổi
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Đơn giá / buổi</span>
                <strong>{formatVnd(t.unitPrice)}</strong>
              </div>
              <div className="flex justify-between pt-2 border-t border-slate-200">
                <span className="font-bold text-slate-900">Tổng học phí</span>
                <strong className="text-lg text-pink-600">{formatVnd(t.amount)}</strong>
              </div>
            </div>
            <div
              className={`px-3 py-2 rounded-xl text-sm font-bold text-center border ${
                t.paid ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
              }`}
            >
              {t.paid
                ? `✓ Đã đóng học phí${t.paidAt ? ` (${new Date(t.paidAt).toLocaleDateString('vi-VN')})` : ''}`
                : 'Chưa đóng học phí'}
            </div>
          </div>

          {!t.paid && t.amount > 0 ? (
            <div className="flex flex-col items-center gap-3 p-4 rounded-2xl bg-pink-50/60 border border-pink-200">
              <VietQrCanvas amount={t.amount} addInfo={transferNote} size={210} />
              <div className="text-xs text-center space-y-1 w-full">
                <div>
                  {SC_BANK.bankName} • <strong>{SC_BANK.accountName}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => copyText(SC_BANK.accountNo, 'Đã copy số tài khoản!')}
                  className="font-mono text-base font-bold text-pink-700 hover:underline"
                >
                  {SC_BANK.accountNo} 📋
                </button>
                <button
                  type="button"
                  onClick={() => copyText(transferNote, 'Đã copy nội dung chuyển khoản!')}
                  className="block w-full text-slate-600 hover:text-pink-700"
                >
                  Nội dung: <strong className="font-mono">{transferNote}</strong> 📋
                </button>
                <p className="text-[11px] text-slate-500">Quét mã bằng app ngân hàng — số tiền & nội dung đã điền sẵn.</p>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-sm text-slate-500 text-center">
              {t.paid ? 'Cảm ơn phụ huynh đã hoàn thành học phí tháng này 🌸' : 'Chưa có học phí cần đóng trong tháng này.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Re-grade one submission with the assignment's CURRENT key (uses saved student answers)
function regradeSubmission(sub, asg) {
  if (!sub || !asg) return null;
  const qList = getAssignmentQuestions(asg);
  const fb = sub.ai_feedback_json || {};
  if (qList.length > 0) {
    const ansMap = sub.answers_json || fb.studentAnswersMap || null;
    if (!ansMap) return null;
    return gradeInteractiveQuestions(qList, ansMap, asg.topic);
  }
  if (asg.answer_key_text && sub.answer_text && !sub.file_url) {
    return autoGradeLegacyTextAnswers(asg.answer_key_text, sub.answer_text, asg.topic);
  }
  return null;
}

// ============================================================================
// STUDENT VIEWS: Bảng điểm 3 nguồn • Kho đề ôn tập (tự chấm) • Sổ tay câu sai
// Practice results are stored per student in localStorage (never counted in official scores)
// ============================================================================
function scReadLocalJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}


// Wrong-answer state of one official submission question (null = not judgeable)
function getOfficialQuestionStatus(q, sub) {
  const fb = sub?.ai_feedback_json || {};
  const ansMap = sub?.answers_json || fb.studentAnswersMap || {};
  const k = String(q.number);
  const actual = String(ansMap[k] || '').trim();
  if (q.type === 'mcq' && hasGradableKey(q)) {
    return { status: isAnswerCorrect(q, actual) ? 'correct' : 'wrong', actual };
  }
  const b = (fb.breakdown || []).find((x) => String(x.question) === k);
  if (b && (b.status === 'correct' || b.status === 'wrong')) {
    return { status: b.status, actual: actual || b.actual || '' };
  }
  if (hasGradableKey(q)) {
    return { status: isAnswerCorrect(q, actual) ? 'correct' : 'wrong', actual };
  }
  return null;
}

function isAnswersLockedForStudent(asg) {
  const meta = getAssignmentMeta(asg);
  return meta.assignmentType === 'exam' && meta.hideAnswersUntilGraded;
}

// ---------------------------------------------------------------------------
// Practice runner: do questions directly in the app and auto-grade instantly
// items: [{ uid, q, sourceLabel }]
// ---------------------------------------------------------------------------
function PracticeRunner({ title, subtitle, items, onClose, onFinish }) {
  const [activeItems, setActiveItems] = useState(items);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [warnUnanswered, setWarnUnanswered] = useState(false);

  const answeredCount = activeItems.filter((it) => String(answers[it.uid] || '').trim()).length;

  const grade = () => {
    const unanswered = activeItems.length - answeredCount;
    if (unanswered > 0 && !warnUnanswered) {
      setWarnUnanswered(true);
      return;
    }
    const perItem = {};
    let gradable = 0;
    let correct = 0;
    activeItems.forEach((it) => {
      if (!hasGradableKey(it.q)) {
        perItem[it.uid] = 'self';
        return;
      }
      gradable += 1;
      const ok = isAnswerCorrect(it.q, answers[it.uid]);
      if (ok) correct += 1;
      perItem[it.uid] = ok ? 'correct' : 'wrong';
    });
    const score = gradable > 0 ? Number(((correct / gradable) * 10).toFixed(1)) : null;
    const res = { perItem, gradable, correct, score };
    setResult(res);
    setWarnUnanswered(false);
    onFinish?.(res, activeItems, answers);
  };

  const restart = (onlyWrong) => {
    if (onlyWrong && result) {
      setActiveItems(activeItems.filter((it) => result.perItem[it.uid] === 'wrong'));
    } else {
      setActiveItems(items);
    }
    setAnswers({});
    setResult(null);
    setWarnUnanswered(false);
  };

  const wrongCount = result ? Object.values(result.perItem).filter((v) => v === 'wrong').length : 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="bg-white rounded-2xl max-w-3xl lg:max-w-5xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3 shrink-0">
          <div>
            <h3 className="font-bold text-base sm:text-lg text-slate-900">{title}</h3>
            <div className="text-xs text-slate-500 mt-0.5">
              {subtitle} • <span className="font-semibold text-violet-700">Luyện tập — không tính vào điểm</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div
            className={`p-3.5 rounded-xl border shrink-0 flex flex-wrap items-center justify-between gap-2 ${
              result.score !== null && result.score >= 8
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-amber-50 border-amber-200'
            }`}
          >
            <div className="text-sm">
              <strong className="text-lg">{result.score !== null ? `${result.score}/10` : '—'}</strong>
              <span className="ml-2 text-slate-700">
                Đúng {result.correct}/{result.gradable} câu tự chấm
                {result.score !== null && result.score >= 8 ? ' — Giỏi lắm! 🌟' : ' — Xem lại câu sai bên dưới nhé!'}
              </span>
            </div>
            <div className="flex gap-2">
              {wrongCount > 0 && (
                <button
                  type="button"
                  onClick={() => restart(true)}
                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
                >
                  Làm lại {wrongCount} câu sai
                </button>
              )}
              <button
                type="button"
                onClick={() => restart(false)}
                className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-bold"
              >
                <RotateCcw className="w-3.5 h-3.5 inline mr-1" />
                Làm lại từ đầu
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-violet-500 to-pink-500 transition-all"
                style={{ width: `${activeItems.length ? Math.round((answeredCount / activeItems.length) * 100) : 0}%` }}
              />
            </div>
            <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">
              {answeredCount}/{activeItems.length} câu
            </span>
          </div>
        )}

        <div className="overflow-y-auto space-y-4 pr-1 flex-1">
          {activeItems.map((it, idx) => {
            const { q } = it;
            const chosen = String(answers[it.uid] || '');
            const st = result ? result.perItem[it.uid] : null;
            const prevPassage = idx > 0 ? activeItems[idx - 1].q.passage : '';
            const showPassage = q.passage && q.passage !== prevPassage;
            const keyLetter = q.type === 'mcq' ? extractMcqLetter(q.correctAnswer, q.options).letter : '';
            return (
              <React.Fragment key={it.uid}>
                {showPassage && (
                  <div className="p-4 rounded-2xl bg-pink-50/70 border border-pink-200 text-xs sm:text-sm text-slate-800 whitespace-pre-line leading-relaxed">
                    <div className="text-xs font-bold text-pink-900 mb-1.5">📖 Đoạn văn đọc hiểu</div>
                    {q.passage}
                  </div>
                )}
                <div
                  className={`p-4 rounded-2xl border space-y-3 ${
                    st === 'correct'
                      ? 'bg-emerald-50/50 border-emerald-300'
                      : st === 'wrong'
                      ? 'bg-rose-50/50 border-rose-300'
                      : 'bg-slate-50/70 border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-900 whitespace-pre-line">
                      <span className="inline-block px-2 py-0.5 rounded-md bg-violet-600 text-white text-xs font-bold mr-2">
                        Câu {idx + 1}
                      </span>
                      {it.sourceLabel && (
                        <span className="inline-block px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 text-[10px] font-semibold mr-2">
                          {it.sourceLabel}
                        </span>
                      )}
                      {q.text}
                    </div>
                    {st && st !== 'self' && (
                      <span
                        className={`px-2 py-0.5 rounded-md text-[11px] font-bold shrink-0 ${
                          st === 'correct' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                        }`}
                      >
                        {st === 'correct' ? '✓ Đúng' : '✗ Sai'}
                      </span>
                    )}
                  </div>

                  {q.type === 'mcq' ? (
                    <div className="grid sm:grid-cols-2 gap-2">
                      {['A', 'B', 'C', 'D']
                        .filter((opt) => q.options?.[opt])
                        .map((opt) => {
                          const active = chosen.toUpperCase() === opt;
                          let style = 'bg-white text-slate-800 border-slate-200 hover:border-violet-400';
                          if (result) {
                            if (opt === keyLetter) style = 'bg-emerald-600 text-white border-emerald-600';
                            else if (active) style = 'bg-rose-600 text-white border-rose-600';
                            else style = 'bg-white text-slate-500 border-slate-200 opacity-80';
                          } else if (active) {
                            style = 'bg-violet-600 text-white border-violet-600 shadow-sm';
                          }
                          return (
                            <button
                              key={opt}
                              type="button"
                              disabled={Boolean(result)}
                              onClick={() => setAnswers((prev) => ({ ...prev, [it.uid]: opt }))}
                              className={`text-left p-2.5 rounded-xl border text-xs flex items-start gap-2.5 transition ${style}`}
                            >
                              <span className="w-5 h-5 rounded-md font-bold flex items-center justify-center shrink-0 bg-white/90 text-slate-900 border border-slate-200">
                                {opt}
                              </span>
                              <span className="pt-0.5">{q.options[opt]}</span>
                            </button>
                          );
                        })}
                    </div>
                  ) : (
                    <input
                      type="text"
                      disabled={Boolean(result)}
                      value={chosen}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [it.uid]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      placeholder="Nhập câu trả lời của em..."
                      className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-400 outline-none disabled:bg-slate-100"
                    />
                  )}

                  {result && (formatKeyForDisplay(q) || q.explanation) && (
                    <div className="p-2.5 rounded-xl bg-white border border-slate-200 text-xs space-y-1">
                      {formatKeyForDisplay(q) && (
                        <div className="text-emerald-700 font-bold">✓ Đáp án: {formatKeyForDisplay(q)}</div>
                      )}
                      {st === 'self' && (
                        <div className="text-amber-700 font-semibold">Câu tự luận — em tự đối chiếu với gợi ý nhé.</div>
                      )}
                      {q.explanation && (
                        <div className="text-slate-700">
                          💡 <strong>Giải thích:</strong> {q.explanation}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <div className="pt-2 border-t border-slate-100 shrink-0 space-y-2">
          {warnUnanswered && !result && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 font-semibold">
              Em còn {activeItems.length - answeredCount} câu chưa làm. Bấm “Chấm điểm” lần nữa nếu vẫn muốn chấm luôn.
            </div>
          )}
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-semibold text-sm"
            >
              Đóng
            </button>
          ) : (
            <button
              type="button"
              onClick={grade}
              disabled={activeItems.length === 0}
              className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-semibold text-sm"
            >
              Chấm điểm ngay
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1) Bảng điểm đủ 3 nguồn (Web • Vocab • Chấm tay)
// ---------------------------------------------------------------------------
function StudentGradebookView({ student, unified, vocabData, manualData, mySubs, assignments }) {
  const vocab = normalizeGridData(vocabData, 'vocab');
  const manual = normalizeGridData(manualData, 'manual');
  const fmt = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1));
  const scoreClass = (v) =>
    v === null || v === undefined
      ? 'bg-slate-100 text-slate-500'
      : v >= 8
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : v >= 6.5
      ? 'bg-pink-50 text-pink-700 border-pink-200'
      : 'bg-rose-50 text-rose-700 border-rose-200';

  const webRows = mySubs
    .map((sub) => ({ sub, asg: assignments.find((a) => a.id === sub.assignment_id) }))
    .filter((r) => r.asg);

  return (
    <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-4">
      <div>
        <h2 className="font-bold text-slate-900">Bảng điểm của em (đủ 3 nguồn)</h2>
        <p className="text-xs text-slate-500">Điểm trung bình = trung bình tất cả đầu điểm: bài trên web, Vocab hàng tuần và điểm cô chấm tay.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Điểm TB tổng hợp', v: unified?.avg, n: unified?.items.length },
          { label: 'Bài web', v: unified?.webAvg, n: unified?.webCount },
          { label: 'Vocab', v: unified?.vocabAvg, n: unified?.vocabCount },
          { label: 'Chấm tay', v: unified?.manualAvg, n: unified?.manualCount }
        ].map((card, i) => (
          <div key={card.label} className={`p-3 rounded-2xl border ${i === 0 ? 'border-pink-300 bg-pink-50/60' : 'border-slate-200 bg-slate-50/60'}`}>
            <div className="text-[11px] font-semibold text-slate-500">{card.label}</div>
            <div className={`text-2xl font-extrabold ${i === 0 ? 'text-pink-600' : 'text-slate-900'}`}>{fmt(card.v)}</div>
            <div className="text-[10px] text-slate-400">{card.n || 0} đầu điểm</div>
          </div>
        ))}
      </div>

      {unified?.missingManual.length > 0 && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
          <strong>⚠️ Em còn {unified.missingManual.length} bài chưa nộp (đang tính 0đ):</strong> {unified.missingManual.join(', ')}. Nộp bổ
          sung cho cô để được chấm lại nhé!
        </div>
      )}

      {vocab.columns.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-violet-700">📘 Vocab hàng tuần</h3>
          <div className="flex flex-wrap gap-2">
            {vocab.columns.map((col) => {
              const r = resolveGridCell(vocab.cells[col.id]?.[student.id], col, false);
              return (
                <div key={col.id} className={`px-3 py-2 rounded-xl border text-center min-w-[84px] ${scoreClass(r.status === 'graded' ? r.value : null)}`}>
                  <div className="text-[10px] font-semibold opacity-80">{col.label}</div>
                  <div className="text-sm font-bold">{r.status === 'graded' ? r.value.toFixed(1) : '—'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {manual.columns.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-sky-700">📝 Điểm cô chấm tay</h3>
          <div className="flex flex-wrap gap-2">
            {manual.columns.map((col) => {
              const r = resolveGridCell(manual.cells[col.id]?.[student.id], col, true);
              return (
                <div
                  key={col.id}
                  className={`px-3 py-2 rounded-xl border text-center min-w-[110px] ${
                    r.status === 'missing' ? 'bg-rose-600 text-white border-rose-600' : scoreClass(r.status === 'graded' ? r.value : null)
                  }`}
                >
                  <div className="text-[10px] font-semibold opacity-80">{col.label}</div>
                  <div className="text-sm font-bold">
                    {r.status === 'missing' ? 'Chưa nộp' : r.status === 'graded' ? r.value.toFixed(1) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {webRows.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-pink-700">💻 Bài làm trên web</h3>
          <div className="flex flex-wrap gap-2">
            {webRows.map(({ sub, asg }) => {
              const v = sub.score === null || sub.score === undefined ? null : Number(sub.score);
              return (
                <div key={sub.id} className={`px-3 py-2 rounded-xl border text-center min-w-[110px] max-w-[200px] ${scoreClass(v)}`}>
                  <div className="text-[10px] font-semibold opacity-80 truncate">{asg.title}</div>
                  <div className="text-sm font-bold">{v === null ? 'Chờ chấm' : v.toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2) Kho đề ôn tập: practice any submitted assignment again, auto-graded
// ---------------------------------------------------------------------------
function PracticeLibraryView({ student, assignments, subByAsg, practiceData, onUpdatePractice }) {
  const history = practiceData?.runs || {};
  const [runner, setRunner] = useState(null);
  const [search, setSearch] = useState('');

  const myTasks = assignments.filter(
    (a) =>
      (a.is_remedial && a.target_student_id === student.id) ||
      (!a.is_remedial && (!a.class_id || a.class_id === student.class_id))
  );
  const eligible = myTasks.filter((a) => getAssignmentQuestions(a).length > 0 && subByAsg[a.id] && !isAnswersLockedForStudent(a));
  const waiting = myTasks.filter((a) => getAssignmentQuestions(a).length > 0 && !subByAsg[a.id]);
  const term = search.trim().toLowerCase();
  const shown = eligible.filter(
    (a) => !term || `${a.title} ${a.topic || ''}`.toLowerCase().includes(term)
  );

  const startPractice = (asg) => {
    const qs = getAssignmentQuestions(asg);
    setRunner({
      asg,
      items: qs.map((q) => ({ uid: `${asg.id}__${q.number}`, q }))
    });
  };

  const handleFinish = (res, items, answers) => {
    if (!runner) return;
    const asgId = runner.asg.id;
    onUpdatePractice((prev) => {
      const runs = { ...(prev.runs || {}) };
      const list = Array.isArray(runs[asgId]) ? runs[asgId] : [];
      runs[asgId] = [...list, { score: res.score, at: new Date().toISOString() }].slice(-30);
      // feed the mistake notebook
      const nb = { ...(prev.notebook || {}) };
      items.forEach((it) => {
        const st = res.perItem[it.uid];
        if (st === 'wrong') {
          nb[it.uid] = {
            ...(nb[it.uid] || {}),
            mastered: false,
            practiceWrong: (nb[it.uid]?.practiceWrong || 0) + 1,
            lastAnswer: answers[it.uid] || ''
          };
        } else if (st === 'correct' && nb[it.uid]) {
          nb[it.uid] = { ...nb[it.uid], mastered: true };
        }
      });
      return { ...prev, runs, notebook: nb };
    });
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-5 rounded-3xl border border-violet-200 shadow-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900">📚 Kho đề ôn tập</h2>
            <p className="text-xs text-slate-500">
              Làm lại bất kỳ đề nào em đã nộp, tự chấm ngay — <strong>không tính vào điểm</strong>, luyện bao nhiêu lần cũng được.
            </p>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm theo tên đề / Unit..."
              className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl w-full sm:w-64"
            />
          </div>
        </div>
        {waiting.length > 0 && (
          <p className="text-[11px] text-slate-500">
            {waiting.length} đề em chưa nộp chính thức sẽ tự vào kho sau khi em nộp bài.
          </p>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="bg-white p-8 rounded-3xl border border-slate-200 text-center text-sm text-slate-400">
          {eligible.length === 0 ? 'Kho đề sẽ có đề sau khi em nộp bài đầu tiên.' : 'Không có đề nào khớp từ khóa.'}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {shown.map((a) => {
            const qs = getAssignmentQuestions(a);
            const runs = Array.isArray(history[a.id]) ? history[a.id] : [];
            const best = runs.reduce((m, r) => (r.score !== null && r.score > m ? r.score : m), -1);
            const official = subByAsg[a.id]?.score;
            return (
              <div key={a.id} className="bg-white p-4 rounded-3xl border border-violet-200/80 shadow-sm flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                  {a.is_remedial ? (
                    <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700">Ôn bổ trợ</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-md bg-pink-50 text-pink-700">Tuần {a.week_number}</span>
                  )}
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">{qs.length} câu</span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 leading-snug">{a.title}</h3>
                  <div className="text-xs text-slate-500">Chuyên đề: {a.topic || 'Tổng hợp'}</div>
                </div>
                <div className="text-xs text-slate-600 space-y-0.5">
                  <div>
                    Điểm chính thức:{' '}
                    <strong>{official === null || official === undefined ? 'Chờ chấm' : `${official}/10`}</strong>
                  </div>
                  <div>
                    Luyện tập: <strong>{runs.length} lần</strong>
                    {best >= 0 && (
                      <>
                        {' '}• Cao nhất <strong className="text-violet-700">{best}/10</strong>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => startPractice(a)}
                  className="mt-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{runs.length > 0 ? 'Luyện lại' : 'Luyện ngay'}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {runner && (
        <PracticeRunner
          title={runner.asg.title}
          subtitle={`${runner.items.length} câu • ${runner.asg.topic || 'Tổng hợp'}`}
          items={runner.items}
          onClose={() => setRunner(null)}
          onFinish={handleFinish}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3) Sổ tay câu sai: wrong questions from official work + practice
// ---------------------------------------------------------------------------
// Collect wrong questions: official submissions + practice wrongs recorded in the notebook
function computeNotebookEntries(assignments, mySubs, notebook) {
  const asgById = {};
  assignments.forEach((a) => {
    asgById[a.id] = a;
  });
  const entries = new Map();
  mySubs.forEach((sub) => {
    const asg = asgById[sub.assignment_id];
    if (!asg || isAnswersLockedForStudent(asg)) return;
    getAssignmentQuestions(asg).forEach((q) => {
      const st = getOfficialQuestionStatus(q, sub);
      if (!st || st.status !== 'wrong') return;
      const uid = `${asg.id}__${q.number}`;
      entries.set(uid, { uid, asg, q, officialAnswer: st.actual || '(Bỏ trống)' });
    });
  });
  Object.entries(notebook).forEach(([uid, info]) => {
    if (entries.has(uid) || !info) return;
    const [asgId, num] = uid.split('__');
    const asg = asgById[asgId];
    if (!asg || isAnswersLockedForStudent(asg)) return;
    const q = getAssignmentQuestions(asg).find((x) => String(x.number) === String(num));
    if (q) entries.set(uid, { uid, asg, q, officialAnswer: info.lastAnswer || '' });
  });
  return Array.from(entries.values()).map((e) => ({ ...e, mastered: Boolean(notebook[e.uid]?.mastered) }));
}

function MistakeNotebookView({ student, assignments, mySubs, practiceData, onUpdatePractice }) {
  const notebook = practiceData?.notebook || {};
  const [showMastered, setShowMastered] = useState(false);
  const [runner, setRunner] = useState(null);

  const all = computeNotebookEntries(assignments, mySubs, notebook);
  const pending = all.filter((e) => !e.mastered);
  const shown = showMastered ? all : pending;

  const groups = {};
  shown.forEach((e) => {
    if (!groups[e.asg.id]) groups[e.asg.id] = { asg: e.asg, list: [] };
    groups[e.asg.id].list.push(e);
  });

  const toggleMastered = (uid) => {
    onUpdatePractice((prev) => {
      const nb = { ...(prev.notebook || {}) };
      nb[uid] = { ...(nb[uid] || {}), mastered: !nb[uid]?.mastered };
      return { ...prev, notebook: nb };
    });
  };

  const practiceList = (list) => {
    if (list.length === 0) return;
    setRunner(list.map((e) => ({ uid: e.uid, q: e.q, sourceLabel: e.asg.title })));
  };

  const handleFinish = (res, items) => {
    onUpdatePractice((prev) => {
      const nb = { ...(prev.notebook || {}) };
      items.forEach((it) => {
        const st = res.perItem[it.uid];
        if (st === 'correct') nb[it.uid] = { ...(nb[it.uid] || {}), mastered: true };
        if (st === 'wrong') nb[it.uid] = { ...(nb[it.uid] || {}), mastered: false, practiceWrong: (nb[it.uid]?.practiceWrong || 0) + 1 };
      });
      return { ...prev, notebook: nb };
    });
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-5 rounded-3xl border border-rose-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-900">📒 Sổ tay câu sai</h2>
          <p className="text-xs text-slate-500">
            Tự gom mọi câu em từng làm sai. Luyện lại đúng là câu đó được đánh dấu <strong>Đã thuộc</strong>.
          </p>
          <div className="text-xs mt-1">
            Còn <strong className="text-rose-600">{pending.length}</strong> câu cần ôn • Đã thuộc{' '}
            <strong className="text-emerald-600">{all.length - pending.length}</strong> câu
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={showMastered} onChange={(e) => setShowMastered(e.target.checked)} className="rounded" />
            <span>Hiện cả câu đã thuộc</span>
          </label>
          <button
            type="button"
            disabled={pending.length === 0}
            onClick={() => practiceList(pending)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Luyện tất cả {pending.length} câu</span>
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="bg-white p-8 rounded-3xl border border-slate-200 text-center text-sm text-slate-400">
          {all.length === 0 ? 'Chưa có câu sai nào — em làm tốt lắm! 🌟' : 'Em đã thuộc hết các câu sai rồi! 🎉'}
        </div>
      ) : (
        Object.values(groups).map(({ asg, list }) => (
          <div key={asg.id} className="bg-white p-4 rounded-3xl border border-slate-200 shadow-sm space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">{asg.title}</h3>
                <div className="text-[11px] text-slate-500">
                  {list.length} câu • {asg.topic || 'Tổng hợp'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => practiceList(list.filter((e) => !e.mastered))}
                disabled={list.every((e) => e.mastered)}
                className="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold disabled:opacity-50"
              >
                Luyện các câu này
              </button>
            </div>
            <div className="space-y-2">
              {list.map((e) => (
                <div
                  key={e.uid}
                  className={`p-3 rounded-xl border text-xs space-y-1 ${e.mastered ? 'bg-emerald-50/50 border-emerald-200' : 'bg-rose-50/40 border-rose-200'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-slate-900">
                      <span className="inline-block px-1.5 py-0.5 rounded bg-slate-800 text-white text-[10px] mr-1.5">Câu {e.q.number}</span>
                      {e.q.text}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleMastered(e.uid)}
                      className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                        e.mastered ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-500 border-slate-300'
                      }`}
                    >
                      {e.mastered ? '✓ Đã thuộc' : 'Đánh dấu đã thuộc'}
                    </button>
                  </div>
                  {e.officialAnswer && (
                    <div className="text-rose-700">
                      Em đã chọn: <span className="line-through">{e.officialAnswer}</span>
                    </div>
                  )}
                  {formatKeyForDisplay(e.q) && <div className="text-emerald-700 font-bold">✓ Đáp án: {formatKeyForDisplay(e.q)}</div>}
                  {e.q.explanation && <div className="text-slate-700">💡 {e.q.explanation}</div>}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {runner && (
        <PracticeRunner
          title="Luyện lại câu sai"
          subtitle={`${runner.length} câu từ sổ tay`}
          items={runner}
          onClose={() => setRunner(null)}
          onFinish={handleFinish}
        />
      )}
    </div>
  );
}

function TrendLineChart({ points, labelKey = 'label', valueKey = 'score', color = '#ec4899' }) {
  if (!points || points.length === 0) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
        Chưa có dữ liệu điểm để vẽ biểu đồ
      </div>
    );
  }

  const width = 640;
  const height = 210;
  const padLeft = 36;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 34;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const coords = points.map((pt, i) => {
    const x =
      points.length === 1
        ? padLeft + innerW / 2
        : padLeft + (i / (points.length - 1)) * innerW;
    const val = Math.max(0, Math.min(10, Number(pt[valueKey] || 0)));
    const y = padTop + innerH - (val / 10) * innerH;
    return { x, y, val, label: pt[labelKey] };
  });

  const pathD = coords
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');

  const areaD =
    coords.length > 1
      ? `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${padTop + innerH} L ${coords[0].x.toFixed(1)} ${padTop + innerH} Z`
      : '';

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-52 select-none">
        {[0, 2.5, 5, 7.5, 10].map((tick) => {
          const y = padTop + innerH - (tick / 10) * innerH;
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#fbcfe8"
                strokeDasharray="4 4"
              />
              <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#64748b">
                {tick}
              </text>
            </g>
          );
        })}

        {areaD && <path d={areaD} fill={color} fillOpacity="0.08" />}

        {coords.length > 1 && (
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {coords.map((c, idx) => (
          <g key={idx}>
            <circle cx={c.x} cy={c.y} r="5.5" fill="#ffffff" stroke={color} strokeWidth="3" />
            <text
              x={c.x}
              y={c.y - 10}
              textAnchor="middle"
              fontSize="11"
              fontWeight="700"
              fill="#1e293b"
            >
              {c.val}
            </text>
            <text x={c.x} y={height - 10} textAnchor="middle" fontSize="11" fill="#475569">
              {c.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function App() {
  const [supabase, setSupabase] = useState(() => getSupabaseClient());
  const [showSetupModal, setShowSetupModal] = useState(() => !getStoredConfig());
  const [cfgUrl, setCfgUrl] = useState(() => getStoredConfig()?.url || '');
  const [cfgKey, setCfgKey] = useState(() => getStoredConfig()?.key || '');

  const [role, setRole] = useState(() => localStorage.getItem('sc_role') || 'login');
  const [currentStudent, setCurrentStudent] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sc_student') || 'null');
    } catch {
      return null;
    }
  });

  const [loginTab, setLoginTab] = useState('student');
  const [stuCodeInput, setStuCodeInput] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').toUpperCase();
  });
  const [stuPinInput, setStuPinInput] = useState('');
  const [teacherPassInput, setTeacherPassInput] = useState('');
  const [loginError, setLoginError] = useState('');

  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentMetaMap, setStudentMetaMap] = useState({});
  const [studentMetaAnnId, setStudentMetaAnnId] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [toast, setToast] = useState(null);

  // Hộp thoại xác nhận xóa an toàn
  const [confirmDialog, setConfirmDialog] = useState(null);

  // Bộ lọc & Báo cáo giáo viên
  const [teacherTab, setTeacherTab] = useState('overview');
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [includeInactiveInStats, setIncludeInactiveInStats] = useState(false);
  const [reportScope, setReportScope] = useState('week'); // 'week' | 'all'
  const [customTeacherOverviewNote, setCustomTeacherOverviewNote] = useState('');
  const [chartTimeMode, setChartTimeMode] = useState('week');
  const [chartStudentFilter, setChartStudentFilter] = useState('all');
  const [deepDiveStudent, setDeepDiveStudent] = useState(null);
  const [editingStudentStatus, setEditingStudentStatus] = useState(null);
  const [stuStatusDraft, setStuStatusDraft] = useState('active');
  const [stuNoteDraft, setStuNoteDraft] = useState('');
  const [reviewingSubmission, setReviewingSubmission] = useState(null);
  const [analyticsAssignment, setAnalyticsAssignment] = useState(null);

  // Modal Generate nhanh ID & PIN
  const [showQuickGenModal, setShowQuickGenModal] = useState(false);
  const [genClassMode, setGenClassMode] = useState('existing');
  const [genSelectedClassId, setGenSelectedClassId] = useState('');
  const [genNewClassName, setGenNewClassName] = useState('');
  const [genNewClassGroup, setGenNewClassGroup] = useState('Khối 10');
  const [genStudentNames, setGenStudentNames] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCredentials, setGeneratedCredentials] = useState([]);

  // Form tạo bài tập & tách câu hỏi tự động từ Word/PDF
  const [asgTitle, setAsgTitle] = useState('');
  const [asgClassId, setAsgClassId] = useState('');
  const [asgWeek, setAsgWeek] = useState(1);
  const [asgDueDate, setAsgDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [asgTopic, setAsgTopic] = useState('');
  const [asgTimePreset, setAsgTimePreset] = useState('0'); // '0' | '15' | '30' | '45' | '60' | 'custom'
  const [asgCustomMinutes, setAsgCustomMinutes] = useState('25');
  const [asgType, setAsgType] = useState('homework'); // 'homework' | 'practice' | 'exam'
  const [asgMaxAttempts, setAsgMaxAttempts] = useState('3'); // '2' | '3' | '5' | '0' (unlimited)
  const [asgShuffleQuestions, setAsgShuffleQuestions] = useState(true);
  const [asgHideAnswersOnExam, setAsgHideAnswersOnExam] = useState(false);
  const [asgAnswerKey, setAsgAnswerKey] = useState('');
  const [asgRubric, setAsgRubric] = useState('');
  const [sourceFile, setSourceFile] = useState(null);
  const [rawExtractedText, setRawExtractedText] = useState('');
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [isExplainingAi, setIsExplainingAi] = useState(false);
  const [isPublishingAsg, setIsPublishingAsg] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('sc_gemini_key') || '');
  const [showAiKeyInput, setShowAiKeyInput] = useState(false);

  // Bài ôn bổ trợ riêng (Tự động gom câu đã sai + đính kèm file Word/PDF tùy chọn)
  const [remTitle, setRemTitle] = useState('');
  const [remTopic, setRemTopic] = useState('');
  const [remAnswerKey, setRemAnswerKey] = useState('');
  const [remNote, setRemNote] = useState('');
  const [selectedWrongUids, setSelectedWrongUids] = useState([]);
  const [remSourceFile, setRemSourceFile] = useState(null);
  const [isAssigningRemedial, setIsAssigningRemedial] = useState(false);

  // Chấm bài thủ công & sửa điểm
  const [gradeScore, setGradeScore] = useState('8.5');
  const [gradeWeakTopic, setGradeWeakTopic] = useState('');
  const [gradeComment, setGradeComment] = useState('');
  const [gradeQuestionMarks, setGradeQuestionMarks] = useState({});
  const [gradeQuestionNotes, setGradeQuestionNotes] = useState({});

  // Cổng học sinh làm bài trực tiếp + Auto-save + Timer
  const [studentTab, setStudentTab] = useState('tasks');
  const [submittingAsg, setSubmittingAsg] = useState(null);
  const [isRetryingPractice, setIsRetryingPractice] = useState(false);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [reviewWrongOnly, setReviewWrongOnly] = useState(false);
  const [stuInteractiveAnswers, setStuInteractiveAnswers] = useState({});
  const [stuAnswerInput, setStuAnswerInput] = useState('');
  const [stuPdfFile, setStuPdfFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftRestoredBanner, setDraftRestoredBanner] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  // Class-level metadata (vocab / manual grades / tuition config / attendance) stored as announcement rows
  const [classMeta, setClassMeta] = useState({ vocab: {}, manual: {}, classCfg: {}, attendance: {}, practice: {} });
  const classMetaRef = useRef({ vocab: {}, manual: {}, classCfg: {}, attendance: {}, practice: {} });
  const [dataReady, setDataReady] = useState(false);
  const classMetaRowIds = useRef({});
  const classMetaTimers = useRef({});
  const classMetaInFlight = useRef({});
  const [gradebookClassId, setGradebookClassId] = useState('');
  const [receiptPreview, setReceiptPreview] = useState(null);

  const [dismissedAnnIds, setDismissedAnnIds] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sc_dismissed_anns') || '[]');
    } catch {
      return [];
    }
  });

  const notify = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchAllData = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const [clsRes, stuRes, asgRes, subRes, annRes] = await Promise.all([
        supabase.from('classes').select('*').order('created_at', { ascending: true }).limit(2000),
        supabase.from('students').select('*').order('student_code', { ascending: true }).limit(5000),
        supabase.from('assignments').select('*').order('created_at', { ascending: false }).limit(5000),
        supabase.from('submissions').select('*').order('submitted_at', { ascending: false }).limit(10000),
        supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(5000)
      ]);

      if (clsRes.data) {
        setClasses(clsRes.data);
        if (clsRes.data.length > 0 && !genSelectedClassId) {
          setGenSelectedClassId(clsRes.data[0].id);
        }
      }
      if (stuRes.data) {
        setStudents(stuRes.data);
        if (currentStudent) {
          const fresh = stuRes.data.find((s) => s.id === currentStudent.id);
          if (fresh) setCurrentStudent(fresh);
        }
      }
      if (asgRes.data) setAssignments(asgRes.data);
      if (subRes.data) setSubmissions(subRes.data);
      if (annRes.data) {
        const metaRow = annRes.data.find((a) =>
          String(a.message || '').startsWith('__SC_STUDENT_META__:')
        );
        if (metaRow) {
          setStudentMetaAnnId(metaRow.id);
          try {
            const parsed = JSON.parse(metaRow.message.replace('__SC_STUDENT_META__:', ''));
            setStudentMetaMap(parsed || {});
          } catch {
            setStudentMetaMap({});
          }
        } else {
          setStudentMetaAnnId(null);
          setStudentMetaMap({});
        }
        // Parse class-level metadata rows (newest first -> keep the first row per type & class)
        const nextMeta = { vocab: {}, manual: {}, classCfg: {}, attendance: {}, practice: {} };
        annRes.data.forEach((a) => {
          const msg = String(a.message || '');
          Object.entries(SC_CLASS_META_TAGS).forEach(([type, tag]) => {
            const ownerId = type === 'practice' ? a.target_student_id : a.class_id;
            if (!ownerId || !msg.startsWith(tag) || nextMeta[type][ownerId]) return;
            try {
              nextMeta[type][ownerId] = JSON.parse(msg.slice(tag.length)) || {};
              classMetaRowIds.current[`${type}|${ownerId}`] = a.id;
            } catch {
              // ignore corrupted metadata row
            }
          });
        });
        // Keep local edits that are still waiting to be synced
        [...Object.keys(classMetaTimers.current), ...Object.keys(classMetaInFlight.current)].forEach((key) => {
          const [type, clsId] = key.split('|');
          const localData = classMetaRef.current[type]?.[clsId];
          if (localData) nextMeta[type][clsId] = localData;
        });
        classMetaRef.current = nextMeta;
        setClassMeta(nextMeta);
        setDataReady(true);

        setAnnouncements(
          annRes.data.filter((a) => !String(a.message || '').startsWith('__SC_'))
        );
      }
    } catch (err) {
      console.error('Lỗi tải dữ liệu Supabase:', err);
    } finally {
      setLoading(false);
    }
  }, [supabase, currentStudent, genSelectedClassId]);

  useEffect(() => {
    if (!supabase) return;
    fetchAllData();

    const channel = supabase
      .channel('smartclass-live-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, () => fetchAllData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, () => fetchAllData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => fetchAllData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => fetchAllData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, () => fetchAllData())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setRealtimeStatus('live');
        else setRealtimeStatus('connecting');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, fetchAllData]);

  // Persist one class-level metadata row (serialized per key, coalescing rapid edits)
  const flushClassMeta = useCallback(
    async (key) => {
      if (!supabase) return;
      if (classMetaInFlight.current[key]) {
        classMetaInFlight.current[key] = 'dirty';
        return;
      }
      classMetaInFlight.current[key] = true;
      const [type, clsId] = key.split('|');
      try {
        do {
          classMetaInFlight.current[key] = true;
          const payload = `${SC_CLASS_META_TAGS[type]}${JSON.stringify(classMetaRef.current[type]?.[clsId] || {})}`;
          const rowId = classMetaRowIds.current[key];
          if (rowId) {
            const { error } = await supabase.from('announcements').update({ message: payload }).eq('id', rowId);
            if (error) throw error;
          } else {
            const { data, error } = await supabase
              .from('announcements')
              .insert([
                type === 'practice'
                  ? { class_id: null, target_student_id: clsId, message: payload }
                  : { class_id: clsId, target_student_id: null, message: payload }
              ])
              .select()
              .single();
            if (error) throw error;
            if (data?.id) classMetaRowIds.current[key] = data.id;
          }
        } while (classMetaInFlight.current[key] === 'dirty');
      } catch (err) {
        notify('Lỗi lưu dữ liệu lên Supabase: ' + err.message, 'error');
      } finally {
        delete classMetaInFlight.current[key];
      }
    },
    [supabase, notify]
  );

  const updateClassMeta = useCallback(
    (type, clsId, updater) => {
      if (!clsId) return;
      const key = `${type}|${clsId}`;
      const prevData = classMetaRef.current[type]?.[clsId] || {};
      const nextData = updater(prevData) || {};
      const next = {
        ...classMetaRef.current,
        [type]: { ...classMetaRef.current[type], [clsId]: nextData }
      };
      classMetaRef.current = next;
      setClassMeta(next);
      clearTimeout(classMetaTimers.current[key]);
      classMetaTimers.current[key] = setTimeout(() => {
        delete classMetaTimers.current[key];
        flushClassMeta(key);
      }, 500);
    },
    [flushClassMeta]
  );

  // One-time move of practice history saved in this browser (v3) into the student's account
  useEffect(() => {
    if (!dataReady || role !== 'student' || !currentStudent) return;
    const code = currentStudent.student_code;
    const localRuns = scReadLocalJson(`sc_practice_${code}`, null);
    const localNb = scReadLocalJson(`sc_notebook_${code}`, null);
    if (!localRuns && !localNb) return;
    updateClassMeta('practice', currentStudent.id, (prev) => {
      const runs = { ...(prev.runs || {}) };
      Object.entries(localRuns || {}).forEach(([asgId, list]) => {
        const seen = new Set((runs[asgId] || []).map((r) => r.at));
        runs[asgId] = [...(runs[asgId] || []), ...(list || []).filter((r) => !seen.has(r.at))].slice(-30);
      });
      return { ...prev, runs, notebook: { ...(localNb || {}), ...(prev.notebook || {}) } };
    });
    try {
      localStorage.removeItem(`sc_practice_${code}`);
      localStorage.removeItem(`sc_notebook_${code}`);
    } catch {
      // ignore
    }
  }, [dataReady, role, currentStudent, updateClassMeta]);

  // Save the whole student meta map (status / note / custom tuition price)
  const persistStudentMetaMap = async (nextMap) => {
    const payloadMsg = `__SC_STUDENT_META__:${JSON.stringify(nextMap)}`;
    if (studentMetaAnnId) {
      const { error } = await supabase
        .from('announcements')
        .update({ message: payloadMsg })
        .eq('id', studentMetaAnnId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase
        .from('announcements')
        .insert([{ target_student_id: null, message: payloadMsg }])
        .select()
        .single();
      if (error) throw error;
      if (data?.id) setStudentMetaAnnId(data.id);
    }
    setStudentMetaMap(nextMap);
  };

  const handleSaveStudentCustomPrice = async (stu, rawValue) => {
    if (!supabase) return;
    const price = Math.max(0, Number(rawValue) || 0);
    const current = studentMetaMap[stu.id] || { status: 'active', note: '' };
    if ((Number(current.customPrice) || 0) === price) return;
    const nextEntry = { ...current };
    if (price > 0) nextEntry.customPrice = price;
    else delete nextEntry.customPrice;
    try {
      await persistStudentMetaMap({ ...studentMetaMap, [stu.id]: nextEntry });
      notify(
        price > 0
          ? `Đã gắn đơn giá riêng ${formatVnd(price)}/buổi cho ${stu.full_name}!`
          : `${stu.full_name} dùng lại đơn giá chuẩn của lớp.`
      );
    } catch (err) {
      notify('Lỗi lưu đơn giá riêng: ' + err.message, 'error');
    }
  };

  // Lưu trạng thái Đang học / Nghỉ học + ghi chú của học sinh
  const handleSaveStudentStatus = async (e) => {
    e.preventDefault();
    if (!editingStudentStatus || !supabase) return;
    const nextMap = {
      ...studentMetaMap,
      [editingStudentStatus.id]: {
        ...(studentMetaMap[editingStudentStatus.id] || {}),
        status: stuStatusDraft,
        note: stuNoteDraft.trim()
      }
    };
    const payloadMsg = `__SC_STUDENT_META__:${JSON.stringify(nextMap)}`;

    try {
      if (studentMetaAnnId) {
        const { error } = await supabase
          .from('announcements')
          .update({ message: payloadMsg })
          .eq('id', studentMetaAnnId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('announcements')
          .insert([{ target_student_id: null, message: payloadMsg }]);
        if (error) throw error;
      }
      setStudentMetaMap(nextMap);
      setEditingStudentStatus(null);
      notify(`Đã cập nhật trạng thái của ${editingStudentStatus.full_name}!`);
      fetchAllData();
    } catch (err) {
      notify('Lỗi lưu trạng thái: ' + err.message, 'error');
    }
  };

  // Các hàm Xóa có hộp thoại xác nhận an toàn
  const requestDeleteAssignment = (asg) => {
    setConfirmDialog({
      title: 'Xác nhận xóa bài tập',
      message: `Anh có chắc chắn muốn xóa bài "${asg.title}" và toàn bộ lượt nộp liên quan không? Thao tác này không thể hoàn tác.`,
      confirmText: 'Xóa bài tập',
      onConfirm: async () => {
        await supabase.from('submissions').delete().eq('assignment_id', asg.id);
        const { error } = await supabase.from('assignments').delete().eq('id', asg.id);
        if (error) notify(error.message, 'error');
        else {
          notify(`Đã xóa bài tập "${asg.title}"!`);
          fetchAllData();
        }
      }
    });
  };

  // Re-grade submissions with the current key (fixes scores graded with a badly-read key)
  const applyRegrade = async (items) => {
    if (!supabase || items.length === 0) return;
    let ok = 0;
    let failed = 0;
    for (const { sub, asg } of items) {
      const g = regradeSubmission(sub, asg);
      if (!g) continue;
      const fb = sub.ai_feedback_json || {};
      const history =
        Array.isArray(fb.attemptHistory) && fb.attemptHistory.length > 0
          ? fb.attemptHistory.map((h, i, arr) => (i === arr.length - 1 ? { ...h, score: g.score } : h))
          : fb.attemptHistory;
      const nextFb = {
        ...fb,
        ...g.feedbackJson,
        attemptHistory: history,
        latestScore: g.score,
        bestScore: g.score,
        regradedAt: new Date().toISOString()
      };
      if (fb.studentAnswersMap) nextFb.studentAnswersMap = fb.studentAnswersMap;
      if (fb.teacherNote) nextFb.summary = `${fb.teacherNote} (${g.feedbackJson.summary})`;
      const { error } = await supabase
        .from('submissions')
        .update({
          score: g.score,
          status: g.hasUngradedOpen ? 'pending_review' : 'graded',
          weak_topics: g.weakTopics,
          ai_feedback_json: nextFb
        })
        .eq('id', sub.id);
      if (error) failed += 1;
      else ok += 1;
    }
    notify(
      failed > 0
        ? `Đã chấm lại ${ok} bài, ${failed} bài bị lỗi khi lưu.`
        : `Đã chấm lại ${ok} bài nộp theo đáp án hiện tại!`,
      failed > 0 ? 'error' : 'success'
    );
    fetchAllData();
  };

  const requestRegradeAssignment = (asg) => {
    const items = submissions.filter((s) => s.assignment_id === asg.id).map((sub) => ({ sub, asg }));
    if (items.length === 0) {
      notify('Đề này chưa có bài nộp nào để chấm lại.', 'error');
      return;
    }
    setConfirmDialog({
      title: `Chấm lại ${items.length} bài nộp của "${asg.title}"?`,
      message:
        'Hệ thống chấm lại theo đáp án hiện tại của đề và đáp án các em đã chọn (không cần học sinh làm lại). Với câu trắc nghiệm, kết quả Đúng/Sai chỉnh tay trước đó sẽ được thay bằng kết quả chấm lại.',
      confirmText: 'Chấm lại',
      onConfirm: () => applyRegrade(items)
    });
  };

  const requestDeleteSubmission = (sub, studentName = '') => {
    setConfirmDialog({
      title: 'Xóa lượt nộp & cho học sinh làm lại?',
      message: `Xóa lượt nộp của ${studentName || sub.student_code}? Em ấy sẽ làm lại bài từ đầu. (Nếu chỉ bị chấm sai do đáp án, anh dùng nút "Chấm lại" thay vì xóa.)`,
      confirmText: 'Xóa & cho làm lại',
      onConfirm: async () => {
        const { error } = await supabase.from('submissions').delete().eq('id', sub.id);
        if (error) notify(error.message, 'error');
        else {
          setReviewingSubmission(null);
          notify('Đã xóa lượt nộp bài!');
          fetchAllData();
        }
      }
    });
  };

  const requestDeleteStudent = (stu) => {
    setConfirmDialog({
      title: 'Xóa tài khoản học sinh test?',
      message: `Xóa vĩnh viễn "${stu.full_name}" (${stu.student_code}) khỏi hệ thống? (Lưu ý: Nếu là học sinh thật đã nghỉ học, anh nên đổi trạng thái sang "Nghỉ học" để giữ lại lịch sử điểm nhé!)`,
      confirmText: 'Xóa vĩnh viễn',
      onConfirm: async () => {
        await supabase.from('submissions').delete().eq('student_id', stu.id);
        const { error } = await supabase.from('students').delete().eq('id', stu.id);
        if (error) notify(error.message, 'error');
        else {
          notify(`Đã xóa tài khoản ${stu.full_name}!`);
          fetchAllData();
        }
      }
    });
  };

  const requestClearAllTestData = () => {
    setConfirmDialog({
      title: 'Dọn sạch toàn bộ bài tập & bài nộp test?',
      message:
        'Hệ thống sẽ xóa toàn bộ Bài tập, Bài nộp và Thông báo hiện có, nhưng GIỮ NGUYÊN danh sách Lớp học và Tài khoản Học sinh. Anh chắc chắn muốn dọn sạch chứ?',
      confirmText: 'Dọn sạch bài test',
      onConfirm: async () => {
        await supabase.from('submissions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('assignments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase
          .from('announcements')
          .delete()
          .not('message', 'like', '__SC_%');
        notify('Đã dọn sạch toàn bộ bài tập & bài nộp test!');
        fetchAllData();
      }
    });
  };

  // Xử lý khi Giáo viên tải file Word (.docx) / PDF (.pdf) / Text lên
  const handleTeacherFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSourceFile(file);
    if (!asgTitle.trim()) {
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setAsgTitle(baseName);
    }

    setIsParsingFile(true);
    try {
      const extracted = await extractRawContentFromFile(file);
      setRawExtractedText(extracted.plainText);

      const questions = parseQuestionsFromExtractedContent(extracted);
      setParsedQuestions(questions.map(sanitizeQuestion));

      const autoKeys = questions
        .filter((q) => q.correctAnswer)
        .map((q) => `${q.number}:${q.correctAnswer}`)
        .join(', ');
      if (autoKeys) setAsgAnswerKey(autoKeys);

      const readingCount = questions.filter((q) => Boolean(q.passage)).length;
      notify(
        readingCount > 0
          ? `Đã tách ${questions.length} câu hỏi (gồm ${readingCount} câu bài đọc hiểu)!`
          : `Đã trích xuất nguyên văn ${questions.length} câu hỏi từ "${file.name}"!`
      );
    } catch (err) {
      notify('Không thể đọc file: ' + err.message, 'error');
    } finally {
      setIsParsingFile(false);
    }
  };

  const handleAiParseQuestions = async () => {
    if (!rawExtractedText.trim()) {
      notify('Anh vui lòng tải file đề lên trước khi dùng AI quét!', 'error');
      return;
    }
    if (!geminiApiKey.trim()) {
      setShowAiKeyInput(true);
      notify('Anh nhập Gemini API Key (miễn phí) để kích hoạt quét AI nhé!', 'error');
      return;
    }

    localStorage.setItem('sc_gemini_key', geminiApiKey.trim());
    setIsParsingFile(true);
    try {
      const aiQuestions = await parseQuestionsWithGeminiAI(rawExtractedText, geminiApiKey);
      if (aiQuestions.length > 0) {
        setParsedQuestions(aiQuestions.map(sanitizeQuestion));
        const autoKeys = aiQuestions
          .filter((q) => q.correctAnswer)
          .map((q) => `${q.number}:${q.correctAnswer}`)
          .join(', ');
        setAsgAnswerKey(autoKeys);
        notify(`Gemini AI đã tách chuẩn ${aiQuestions.length} câu hỏi & kèm giải thích!`);
      }
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setIsParsingFile(false);
    }
  };

  const handleAiGenerateExplanationsForDraft = async () => {
    if (parsedQuestions.length === 0) return;
    if (!geminiApiKey.trim()) {
      setShowAiKeyInput(true);
      notify('Anh nhập Gemini API Key để AI tự sinh đáp án & giải thích chi tiết nhé!', 'error');
      return;
    }

    localStorage.setItem('sc_gemini_key', geminiApiKey.trim());
    setIsExplainingAi(true);
    try {
      const expMap = await generateExplanationsWithGeminiAI(parsedQuestions, geminiApiKey);
      setParsedQuestions((prev) => {
        const next = prev.map((q) => {
          const item = expMap[String(q.number)];
          if (!item) return q;
          return {
            ...q,
            correctAnswer: q.correctAnswer || item.correctAnswer || '',
            explanation: item.explanation || q.explanation || ''
          };
        });
        const autoKeys = next
          .filter((q) => q.correctAnswer)
          .map((q) => `${q.number}:${q.correctAnswer}`)
          .join(', ');
        setAsgAnswerKey(autoKeys);
        return next;
      });
      notify('AI đã tự động điền đáp án & lời giải thích cho từng câu!');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setIsExplainingAi(false);
    }
  };

  const updateParsedQuestion = (idx, patch) => {
    setParsedQuestions((prev) => {
      const next = prev.map((q, i) =>
        i === idx ? { ...q, ...patch, ...('correctAnswer' in patch ? { keyIssue: '' } : {}) } : q
      );
      const autoKeys = next
        .filter((q) => q.correctAnswer)
        .map((q) => `${q.number}:${q.correctAnswer}`)
        .join(', ');
      setAsgAnswerKey(autoKeys);
      return next;
    });
  };

  const handleAddManualQuestion = () => {
    setParsedQuestions((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        number: prev.length + 1,
        type: 'mcq',
        passage: '',
        text: '',
        options: { A: '', B: '', C: '', D: '' },
        correctAnswer: '',
        explanation: ''
      }
    ]);
  };

  const handleSaveConfig = (e) => {
    e.preventDefault();
    if (!cfgUrl.trim() || !cfgKey.trim()) return;
    saveLocalConfig(cfgUrl, cfgKey);
    const client = getSupabaseClient();
    setSupabase(client);
    setShowSetupModal(false);
    notify('Đã kết nối Supabase Realtime!');
  };

  const handleGenerateStudentCredentials = async (e) => {
    e.preventDefault();
    if (!supabase) return;
    setIsGenerating(true);
    try {
      let targetClass = null;
      if (genClassMode === 'new' || classes.length === 0) {
        if (!genNewClassName.trim()) {
          notify('Anh vui lòng nhập tên lớp mới!', 'error');
          setIsGenerating(false);
          return;
        }
        const { data: createdCls, error: clsErr } = await supabase
          .from('classes')
          .insert([{ name: genNewClassName.trim(), group_name: genNewClassGroup.trim() || 'Khối chung' }])
          .select()
          .single();
        if (clsErr) throw clsErr;
        targetClass = createdCls;
        setGenSelectedClassId(createdCls.id);
        setGenClassMode('existing');
        setGenNewClassName('');
      } else {
        targetClass = classes.find((c) => c.id === genSelectedClassId) || classes[0];
      }

      const prefix = deriveClassPrefix(targetClass.name, targetClass.id);
      const existingInClass = students.filter(
        (s) => s.class_id === targetClass.id || s.student_code?.startsWith(`${prefix}-`)
      );

      let maxSeq = 0;
      existingInClass.forEach((s) => {
        const m = s.student_code?.match(/-(\d+)$/);
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
      });
      if (maxSeq === 0 && existingInClass.length > 0) maxSeq = existingInClass.length;

      const rawLines = genStudentNames
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const namesToCreate = rawLines.length > 0 ? rawLines : [`Học sinh ${maxSeq + 1}`];

      const rowsToInsert = namesToCreate.map((fullName, idx) => ({
        student_code: `${prefix}-${String(maxSeq + idx + 1).padStart(2, '0')}`,
        pin_code: generateRandomPin(),
        full_name: fullName,
        class_id: targetClass.id,
        class_name: targetClass.name
      }));

      const { data: insertedStudents, error: insertErr } = await supabase
        .from('students')
        .insert(rowsToInsert)
        .select();
      if (insertErr) throw insertErr;

      setGeneratedCredentials(insertedStudents || rowsToInsert);
      setGenStudentNames('');
      await fetchAllData();
      notify(`Đã tạo ${rowsToInsert.length} tài khoản học sinh lớp ${targetClass.name}!`);
    } catch (err) {
      notify('Lỗi tạo mã học sinh: ' + err.message, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyInviteMessage = (stu) => {
    const directLink = `${window.location.origin}/?id=${encodeURIComponent(stu.student_code)}`;
    const text = [
      `🌸 Thông tin đăng nhập Lớp cô Hà — Lớp ${stu.class_name || ''}:`,
      `• Học sinh: ${stu.full_name}`,
      `• Mã ID: ${stu.student_code}`,
      `• Mật khẩu (PIN): ${stu.pin_code}`,
      `👉 Vào góc học tập của lớp tại: ${directLink}`
    ].join('\n');
    navigator.clipboard.writeText(text);
    notify(`Đã copy thông tin đăng nhập của ${stu.full_name}!`);
  };

  const handleStudentLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!supabase) return;
    const code = stuCodeInput.trim().toUpperCase();
    const pin = stuPinInput.trim();
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('student_code', code)
      .eq('pin_code', pin)
      .maybeSingle();

    if (error || !data) {
      setLoginError('Sai Mã học sinh hoặc Mật khẩu PIN. Vui lòng kiểm tra lại!');
      return;
    }
    setCurrentStudent(data);
    setRole('student');
    localStorage.setItem('sc_role', 'student');
    localStorage.setItem('sc_student', JSON.stringify(data));
  };

  const handleTeacherLogin = (e) => {
    e.preventDefault();
    setLoginError('');
    if (teacherPassInput.trim() !== TEACHER_PASSCODE) {
      setLoginError('Mật khẩu giáo viên chưa đúng. Vui lòng thử lại!');
      return;
    }
    setRole('teacher');
    localStorage.setItem('sc_role', 'teacher');
  };

  const handleLogout = () => {
    setRole('login');
    setCurrentStudent(null);
    localStorage.removeItem('sc_role');
    localStorage.removeItem('sc_student');
  };

  // Đăng bài tập mới (kèm thời gian làm bài + bộ câu hỏi)
  const handleCreateAssignment = async (e) => {
    e.preventDefault();
    if (!asgTitle.trim() || !supabase) return;
    setIsPublishingAsg(true);

    try {
      let sourceFileUrl = null;
      let sourceFileName = null;

      if (sourceFile) {
        const cleanName = sourceFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `assignments/${Date.now()}_${cleanName}`;
        const { error: upErr } = await supabase.storage
          .from('homework-files')
          .upload(path, sourceFile, { upsert: true });
        if (!upErr) {
          const { data: pub } = supabase.storage.from('homework-files').getPublicUrl(path);
          sourceFileUrl = pub?.publicUrl || null;
          sourceFileName = sourceFile.name;
        }
      }

      const cls = classes.find((c) => c.id === asgClassId) || null;
      const cleanQuestions = parsedQuestions.map(sanitizeQuestion).map((q, idx) => ({
        ...q,
        type: q.type === 'mcq' ? 'mcq' : 'open',
        number: idx + 1
      }));

      const finalAnswerKey =
        cleanQuestions.length > 0
          ? cleanQuestions
              .filter((q) => q.correctAnswer)
              .map((q) => `${q.number}:${q.correctAnswer}`)
              .join(', ')
          : asgAnswerKey.trim();

      const timeLimitMinutes =
        asgTimePreset === 'custom'
          ? Math.max(0, Number(asgCustomMinutes) || 0)
          : Number(asgTimePreset) || 0;

      const metaPayload = {
        timeLimitMinutes,
        assignmentType: asgType,
        maxAttempts: asgType === 'practice' ? Math.max(0, Number(asgMaxAttempts) || 0) : 1,
        shuffleQuestions: asgType === 'exam' ? Boolean(asgShuffleQuestions) : false,
        hideAnswersUntilGraded: asgType === 'exam' ? Boolean(asgHideAnswersOnExam) : false
      };

      const metaTag = `__SC_META__:${JSON.stringify(metaPayload)}`;
      const embeddedRubric =
        cleanQuestions.length > 0
          ? `${asgRubric.trim()}\n${metaTag}\n__SC_QUESTIONS__:${JSON.stringify(cleanQuestions)}`
          : `${asgRubric.trim()}\n${metaTag}`;

      const fullPayload = {
        title: asgTitle.trim(),
        class_id: cls ? cls.id : null,
        class_name: cls ? cls.name : 'Tất cả các lớp',
        week_number: Number(asgWeek) || 1,
        due_date: asgDueDate || null,
        topic: asgTopic.trim() || 'Tổng hợp',
        answer_key_text: finalAnswerKey,
        answer_key_url: sourceFileUrl,
        rubric: embeddedRubric,
        is_remedial: false,
        questions_json: cleanQuestions,
        source_file_url: sourceFileUrl,
        source_file_name: sourceFileName
      };

      let { error } = await supabase.from('assignments').insert([fullPayload]);

      if (error && error.message?.includes('column')) {
        const fallbackPayload = {
          title: fullPayload.title,
          class_id: fullPayload.class_id,
          class_name: fullPayload.class_name,
          week_number: fullPayload.week_number,
          due_date: fullPayload.due_date,
          topic: fullPayload.topic,
          answer_key_text: fullPayload.answer_key_text,
          answer_key_url: sourceFileUrl,
          rubric: embeddedRubric,
          is_remedial: false
        };
        const retry = await supabase.from('assignments').insert([fallbackPayload]);
        error = retry.error;
      }

      if (error) throw error;

      setAsgTitle('');
      setAsgAnswerKey('');
      setAsgRubric('');
      setSourceFile(null);
      setRawExtractedText('');
      setParsedQuestions([]);
      notify(
        asgType === 'practice'
          ? 'Đã đăng bài Luyện tập nhiều lần lên web!'
          : asgType === 'exam'
          ? 'Đã đăng đề Kiểm tra / Thi thử lên web!'
          : 'Đã xuất bản bài tập lên web! Học sinh có thể làm trực tiếp ngay.'
      );
      fetchAllData();
    } catch (err) {
      notify('Lỗi đăng bài: ' + err.message, 'error');
    } finally {
      setIsPublishingAsg(false);
    }
  };

  // Mở khóa / Khóa lại đáp án chi tiết của bài kiểm tra
  const handleToggleExamAnswerLock = async (asg) => {
    if (!supabase || !asg) return;
    const currentMeta = getAssignmentMeta(asg);
    const nextMeta = {
      ...currentMeta,
      hideAnswersUntilGraded: !currentMeta.hideAnswersUntilGraded
    };
    const nextMetaTag = `__SC_META__:${JSON.stringify(nextMeta)}`;
    const rawRubric = typeof asg.rubric === 'string' ? asg.rubric : '';
    const updatedRubric = rawRubric.match(/__SC_META__:\{.*?\}/)
      ? rawRubric.replace(/__SC_META__:\{.*?\}/, nextMetaTag)
      : `${nextMetaTag}
${rawRubric}`;

    const { error } = await supabase
      .from('assignments')
      .update({ rubric: updatedRubric })
      .eq('id', asg.id);

    if (error) {
      notify('Lỗi cập nhật trạng thái đáp án: ' + error.message, 'error');
    } else {
      notify(
        nextMeta.hideAnswersUntilGraded
          ? 'Đã khóa đáp án bài kiểm tra!'
          : 'Đã mở khóa đáp án & giải thích chi tiết cho học sinh xem!'
      );
      fetchAllData();
    }
  };



  const handleSendReminder = async (student, customMsg = '') => {
    if (!supabase) return;
    const msg =
      customMsg ||
      `Nhắc nhở: Em ${student.full_name} (${student.student_code}) vui lòng kiểm tra và hoàn thành bài tập đúng hạn nhé!`;
    const { error } = await supabase.from('announcements').insert([
      {
        target_student_id: student.id,
        message: msg
      }
    ]);
    if (error) notify('Lỗi gửi nhắc nhở: ' + error.message, 'error');
    else {
      notify(`Đã gửi thông báo nhắc nhở tới ${student.full_name}!`);
      fetchAllData();
    }
  };

  // Mở popup chấm bài / sửa điểm cho bất kỳ bài nộp nào
  const openManualReviewModal = (sub) => {
    const targetAsg = assignments.find((a) => a.id === sub.assignment_id);
    const qList = getAssignmentQuestions(targetAsg);
    const ansMap = sub.answers_json || sub.ai_feedback_json?.studentAnswersMap || {};
    const existingBreakdown = sub.ai_feedback_json?.breakdown || [];

    const initialMarks = {};
    const initialNotes = {};

    existingBreakdown.forEach((b) => {
      if (b.question) {
        initialMarks[String(b.question)] = b.status;
        if (b.explanation || b.expected) {
          initialNotes[String(b.question)] = b.explanation || b.expected;
        }
      }
    });

    qList.forEach((q) => {
      const k = String(q.number);
      // MCQ with a valid key: always recompute (fixes old wrong breakdowns); open questions keep teacher marks
      if (hasGradableKey(q) && (q.type === 'mcq' || !initialMarks[k])) {
        initialMarks[k] = isAnswerCorrect(q, ansMap[k]) ? 'correct' : 'wrong';
        if (initialMarks[k] === 'wrong') {
          initialNotes[k] = q.explanation || formatKeyForDisplay(q);
        } else {
          delete initialNotes[k];
        }
      }
    });

    setReviewingSubmission(sub);
    setGradeQuestionMarks(initialMarks);
    setGradeQuestionNotes(initialNotes);

    if (sub.score !== null && sub.score !== undefined) {
      setGradeScore(String(sub.score));
    } else if (qList.length > 0 && Object.keys(initialMarks).length > 0) {
      const correctCnt = Object.values(initialMarks).filter((v) => v === 'correct').length;
      setGradeScore(String(Number(((correctCnt / qList.length) * 10).toFixed(2))));
    } else {
      setGradeScore('8.5');
    }

    setGradeWeakTopic((sub.weak_topics || []).join(', ') || targetAsg?.topic || '');
    setGradeComment(sub.ai_feedback_json?.teacherNote || '');
  };

  const handleToggleQuestionMark = (qKey, status, totalCount) => {
    setGradeQuestionMarks((prev) => {
      const next = { ...prev };
      if (next[qKey] === status) {
        delete next[qKey];
      } else {
        next[qKey] = status;
      }

      if (totalCount > 0) {
        const correctCnt = Object.values(next).filter((v) => v === 'correct').length;
        const autoScore = Number(((correctCnt / totalCount) * 10).toFixed(2));
        setGradeScore(String(autoScore));
      }
      return next;
    });
  };

  const handleMarkAllQuestions = (qList, status) => {
    const next = {};
    qList.forEach((q) => {
      next[String(q.number)] = status;
    });
    setGradeQuestionMarks(next);
    if (qList.length > 0) {
      setGradeScore(status === 'correct' ? '10' : '0');
    }
  };

  const handleSaveManualGrade = async (e) => {
    e.preventDefault();
    if (!reviewingSubmission || !supabase) return;
    const scoreNum = Math.max(0, Math.min(10, Number(gradeScore) || 0));
    const weakArr = gradeWeakTopic
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const targetAsg = assignments.find((a) => a.id === reviewingSubmission.assignment_id);
    const asgQuestions = getAssignmentQuestions(targetAsg);
    const ansMap =
      reviewingSubmission.answers_json ||
      reviewingSubmission.ai_feedback_json?.studentAnswersMap ||
      {};

    const breakdown = [];
    const wrongDetails = [];
    let correctCount = 0;

    asgQuestions.forEach((q) => {
      const k = String(q.number);
      const mark = gradeQuestionMarks[k];
      const stuAns = String(ansMap[k] || '(Bỏ trống)').trim();
      const noteText = String(gradeQuestionNotes[k] || q.explanation || q.correctAnswer || '').trim();

      if (mark === 'correct') {
        correctCount += 1;
        breakdown.push({
          question: k,
          status: 'correct',
          expected: q.correctAnswer || noteText,
          actual: stuAns,
          explanation: q.explanation || ''
        });
      } else if (mark === 'wrong') {
        breakdown.push({
          question: k,
          status: 'wrong',
          expected: q.correctAnswer || '',
          actual: stuAns,
          explanation: noteText
        });
        wrongDetails.push(
          noteText
            ? `Câu ${k}: Em trả lời "${stuAns}" — Đáp án / Giải thích: ${noteText}`
            : `Câu ${k}: Chưa chính xác (Bài làm của em: "${stuAns}")`
        );
      }
    });

    if (wrongDetails.length === 0 && weakArr.length > 0) {
      wrongDetails.push(`Cần ôn lại chuyên đề: ${weakArr.join(', ')}`);
    }

    const autoSummary =
      breakdown.length > 0
        ? `Kết quả chấm: Đúng ${correctCount}/${breakdown.length} câu (${scoreNum}/10 điểm).`
        : 'Giáo viên đã chấm điểm và nhận xét bài làm.';

    const { error } = await supabase
      .from('submissions')
      .update({
        status: 'graded',
        score: scoreNum,
        weak_topics: weakArr,
        ai_feedback_json: {
          ...(reviewingSubmission.ai_feedback_json || {}),
          correctCount,
          totalCount: breakdown.length || asgQuestions.length,
          breakdown,
          wrongDetails,
          teacherNote: gradeComment.trim(),
          summary: gradeComment.trim()
            ? `${gradeComment.trim()} (${autoSummary})`
            : autoSummary
        }
      })
      .eq('id', reviewingSubmission.id);

    if (error) {
      notify(error.message, 'error');
    } else {
      setReviewingSubmission(null);
      notify('Đã lưu điểm & kết quả từng câu — Học sinh xem được ngay!');
      fetchAllData();
    }
  };

  // Unified grading engine: Web submissions + weekly Vocab + manual gradebook
  const unifiedScoresByStudent = useMemo(() => {
    const asgById = {};
    assignments.forEach((a) => {
      asgById[a.id] = a;
    });
    const subsByStudent = {};
    submissions.forEach((sub) => {
      if (sub.score === null || sub.score === undefined) return;
      if (!subsByStudent[sub.student_id]) subsByStudent[sub.student_id] = [];
      subsByStudent[sub.student_id].push(sub);
    });
    const avgOf = (arr) =>
      arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null;

    const map = {};
    students.forEach((stu) => {
      const items = [];
      const missingManual = [];
      (subsByStudent[stu.id] || []).forEach((sub) => {
        const asg = asgById[sub.assignment_id];
        items.push({
          source: 'web',
          score: Number(sub.score),
          week: Number(asg?.week_number) || 1,
          date: String(sub.submitted_at || '').slice(0, 10),
          label: asg?.title || 'Bài web'
        });
      });
      const vocabGrid = normalizeGridData(classMeta.vocab[stu.class_id], 'vocab');
      vocabGrid.columns.forEach((col) => {
        const r = resolveGridCell(vocabGrid.cells[col.id]?.[stu.id], col, false);
        if (r.status === 'graded') {
          items.push({ source: 'vocab', score: r.value, week: col.week, date: col.date, label: col.label });
        }
      });
      const manualGrid = normalizeGridData(classMeta.manual[stu.class_id], 'manual');
      manualGrid.columns.forEach((col) => {
        const r = resolveGridCell(manualGrid.cells[col.id]?.[stu.id], col, true);
        if (r.status === 'blank') return;
        items.push({ source: 'manual', score: r.value, week: col.week, date: col.date, label: col.label });
        if (r.status === 'missing') missingManual.push(col.label);
      });
      const pick = (src) => items.filter((i) => i.source === src).map((i) => i.score);
      map[stu.id] = {
        items,
        avg: avgOf(items.map((i) => i.score)),
        webAvg: avgOf(pick('web')),
        vocabAvg: avgOf(pick('vocab')),
        manualAvg: avgOf(pick('manual')),
        webCount: pick('web').length,
        vocabCount: pick('vocab').length,
        manualCount: pick('manual').length,
        missingManual
      };
    });
    return map;
  }, [students, submissions, assignments, classMeta]);

  const formatSourceBreakdown = (u) => {
    if (!u) return 'Web — • Vocab — • Chấm tay —';
    const f = (v) => (v === null || v === undefined ? '—' : v.toFixed(1));
    return `Web ${f(u.webAvg)} • Vocab ${f(u.vocabAvg)} • Chấm tay ${f(u.manualAvg)}`;
  };

  // Attendance summary of a student for a month (sessions up to today, used in parent report)
  const getStudentAttendanceSummary = useCallback(
    (stu, ym = getCurrentYm()) => {
      const cfg = classMeta.classCfg[stu.class_id] || {};
      const md = resolveMonthData(classMeta.attendance[stu.class_id], cfg, ym);
      const today = new Date().toISOString().slice(0, 10);
      const pastOnly = { ...md, sessions: md.sessions.filter((x) => x.date <= today) };
      if (pastOnly.sessions.length === 0) return null;
      const t = computeStudentMonthTuition(stu, pastOnly, cfg, studentMetaMap[stu.id]);
      return { ym, presentCount: t.presentCount, total: t.sessionRows.length };
    },
    [classMeta, studentMetaMap]
  );

  const openGradebookForClass = (clsId) => {
    if (clsId && clsId !== 'all') setGradebookClassId(clsId);
    setTeacherTab('assignments');
    setTimeout(() => {
      document.getElementById('sc-vocab-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  };

  // Submissions whose stored score differs from a re-grade with the current key
  const regradeCandidates = useMemo(() => {
    const asgById = {};
    assignments.forEach((a) => {
      asgById[a.id] = a;
    });
    const out = [];
    submissions.forEach((sub) => {
      const asg = asgById[sub.assignment_id];
      if (!asg) return;
      const g = regradeSubmission(sub, asg);
      if (!g || g.hasUngradedOpen) return;
      const fb = sub.ai_feedback_json || {};
      const storedRaw =
        fb.latestScore !== undefined && fb.latestScore !== null ? fb.latestScore : sub.score;
      const stored = storedRaw === null || storedRaw === undefined ? null : Number(storedRaw);
      if (stored === null || Math.abs(stored - g.score) > 0.001) {
        out.push({ sub, asg, oldScore: stored, newScore: g.score });
      }
    });
    return out;
  }, [submissions, assignments]);

  const studentPortalData = useMemo(() => {
    if (!currentStudent) return null;
    const mySubs = submissions.filter((s) => s.student_id === currentStudent.id);
    const subByAsg = {};
    mySubs.forEach((s) => {
      if (!subByAsg[s.assignment_id]) subByAsg[s.assignment_id] = s;
    });

    const remedialTasks = assignments.filter(
      (a) => a.is_remedial && a.target_student_id === currentStudent.id
    );
    const classTasks = assignments.filter(
      (a) => !a.is_remedial && (!a.class_id || a.class_id === currentStudent.class_id)
    );

    const urgentTasks = [...remedialTasks, ...classTasks].filter((t) => {
      if (subByAsg[t.id]) return false;
      const info = getDeadlineBadgeInfo(t.due_date);
      return info && info.urgent;
    });

    const graded = mySubs.filter((s) => s.score !== null && s.score !== undefined);
    const unifiedMine = unifiedScoresByStudent[currentStudent.id];
    const avgScore =
      unifiedMine && unifiedMine.avg !== null ? unifiedMine.avg.toFixed(1) : '—';

    const trend = [...graded].reverse().map((sub, idx) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      return {
        label: asg ? `Tuần ${asg.week_number || idx + 1}` : `Bài ${idx + 1}`,
        score: Number(sub.score)
      };
    });

    const weakSet = new Set();
    mySubs.forEach((s) => (s.weak_topics || []).forEach((t) => weakSet.add(t)));

    const myAnnouncements = announcements.filter(
      (ann) =>
        (!ann.target_student_id || ann.target_student_id === currentStudent.id) &&
        !dismissedAnnIds.includes(ann.id)
    );

    return {
      mySubs,
      subByAsg,
      remedialTasks,
      classTasks,
      urgentTasks,
      avgScore,
      trend,
      weakTopics: Array.from(weakSet),
      myAnnouncements
    };
  }, [currentStudent, submissions, assignments, announcements, dismissedAnnIds, unifiedScoresByStudent]);


  // Mở bài làm cho học sinh (Hỗ trợ xem lại, làm lại bài luyện tập, khôi phục nháp & đồng hồ)
  const handleOpenStudentAssignment = (task, forceRetry = false) => {
    setSubmittingAsg(task);
    setShowSubmitConfirm(false);
    setReviewWrongOnly(false);
    setStuPdfFile(null);
    setDraftRestoredBanner(false);

    const existingSub = studentPortalData?.subByAsg?.[task.id];
    const meta = getAssignmentMeta(task);
    const attemptCount = Number(existingSub?.ai_feedback_json?.attemptCount) || (existingSub ? 1 : 0);
    const canRetryMore =
      Boolean(existingSub) &&
      meta.assignmentType === 'practice' &&
      (meta.maxAttempts === 0 || attemptCount < meta.maxAttempts);

    if (existingSub && !(forceRetry && canRetryMore)) {
      // Mở chế độ xem lại bài đã nộp & giải thích (có nút Làm lại bên trong nếu còn lượt)
      setIsRetryingPractice(false);
      setStuInteractiveAnswers(
        existingSub.answers_json || existingSub.ai_feedback_json?.studentAnswersMap || {}
      );
      setStuAnswerInput(existingSub.answer_text || '');
      setRemainingSeconds(null);
      return;
    }

    setIsRetryingPractice(Boolean(existingSub && forceRetry && canRetryMore));

    const draftKey = `sc_draft_${currentStudent.student_code}_${task.id}`;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (saved && (Object.keys(saved.answers || {}).length > 0 || saved.textAnswer)) {
        setStuInteractiveAnswers(saved.answers || {});
        setStuAnswerInput(saved.textAnswer || '');
        setDraftRestoredBanner(true);
        if (meta.timeLimitMinutes > 0) {
          setRemainingSeconds(
            typeof saved.remainingSeconds === 'number'
              ? saved.remainingSeconds
              : meta.timeLimitMinutes * 60
          );
        } else {
          setRemainingSeconds(null);
        }
        return;
      }
    } catch {
      // ignore corrupted draft
    }

    setStuInteractiveAnswers({});
    setStuAnswerInput('');
    setRemainingSeconds(meta.timeLimitMinutes > 0 ? meta.timeLimitMinutes * 60 : null);
  };

  // Tự động lưu nháp mỗi khi học sinh chọn đáp án hoặc gõ bài
  useEffect(() => {
    if (!submittingAsg || !currentStudent) return;
    const existingSub = studentPortalData?.subByAsg?.[submittingAsg.id];
    if (existingSub && !isRetryingPractice) return; // Không ghi đè nếu đang ở chế độ xem lại

    const draftKey = `sc_draft_${currentStudent.student_code}_${submittingAsg.id}`;
    const hasContent =
      Object.keys(stuInteractiveAnswers).length > 0 || Boolean(stuAnswerInput.trim());
    if (hasContent || typeof remainingSeconds === 'number') {
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          answers: stuInteractiveAnswers,
          textAnswer: stuAnswerInput,
          remainingSeconds,
          savedAt: Date.now()
        })
      );
    }
  }, [submittingAsg, currentStudent, stuInteractiveAnswers, stuAnswerInput, remainingSeconds, studentPortalData, isRetryingPractice]);

  // Học sinh nộp bài (hỗ trợ cả tự động thu bài khi hết giờ)
  const submitStudentWork = useCallback(
    async (isAutoTimeout = false) => {
      if (!submittingAsg || !currentStudent || !supabase || isSubmitting) return;

      const existingSub = studentPortalData?.subByAsg?.[submittingAsg.id];
      const meta = getAssignmentMeta(submittingAsg);
      const prevAttempts = Number(existingSub?.ai_feedback_json?.attemptCount) || (existingSub ? 1 : 0);
      const canRetryMore =
        Boolean(existingSub) &&
        meta.assignmentType === 'practice' &&
        (meta.maxAttempts === 0 || prevAttempts < meta.maxAttempts);

      // Chống nộp trùng nếu không phải chế độ luyện tập nhiều lần hoặc đã hết lượt
      if (existingSub && !canRetryMore) {
        notify('Bài này em đã nộp rồi và đã hết lượt làm bài.', 'error');
        return;
      }

      const questions = getAssignmentQuestions(submittingAsg);
      const isInteractive = questions.length > 0;

      if (!isAutoTimeout && !isInteractive && !stuAnswerInput.trim() && !stuPdfFile) {
        notify('Em hãy nhập đáp án hoặc đính kèm file PDF bài làm nhé!', 'error');
        return;
      }

      setIsSubmitting(true);
      try {
        let fileUrl = null;
        let fileName = null;

        if (stuPdfFile) {
          const cleanName = stuPdfFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = `${currentStudent.student_code}/${Date.now()}_${cleanName}`;
          const { error: uploadErr } = await supabase.storage
            .from('homework-files')
            .upload(storagePath, stuPdfFile, { upsert: true });

          if (uploadErr) throw uploadErr;
          const { data: pubUrl } = supabase.storage.from('homework-files').getPublicUrl(storagePath);
          fileUrl = pubUrl?.publicUrl || null;
          fileName = stuPdfFile.name;
        }

        let finalStatus = 'pending_review';
        let finalScore = null;
        let finalWeakTopics = [];
        let finalFeedbackJson = {
          summary: 'Đã nộp bài thành công. Đang chờ giáo viên chấm điểm.'
        };
        let formattedAnswerText = stuAnswerInput.trim();

        if (isInteractive) {
          formattedAnswerText = questions
            .map((q) => `Câu ${q.number}: ${stuInteractiveAnswers[String(q.number)] || '(Bỏ trống)'}`)
            .join(' | ');

          const graded = gradeInteractiveQuestions(
            questions,
            stuInteractiveAnswers,
            submittingAsg.topic
          );

          if (graded) {
            finalScore = graded.score;
            finalWeakTopics = graded.weakTopics;
            finalFeedbackJson = {
              ...graded.feedbackJson,
              studentAnswersMap: stuInteractiveAnswers
            };
            finalStatus = graded.hasUngradedOpen ? 'pending_review' : 'graded';
          } else {
            finalStatus = 'pending_review';
            finalFeedbackJson = {
              summary: 'Bài làm đã gửi tới giáo viên để chấm điểm từng câu.',
              studentAnswersMap: stuInteractiveAnswers
            };
          }
        } else {
          const graded = autoGradeLegacyTextAnswers(
            submittingAsg.answer_key_text,
            stuAnswerInput,
            submittingAsg.topic
          );
          if (graded && !stuPdfFile) {
            finalStatus = 'graded';
            finalScore = graded.score;
            finalWeakTopics = graded.weakTopics;
            finalFeedbackJson = graded.feedbackJson;
          }
        }

        const currentAttemptNum = prevAttempts + 1;
        const prevHistory = Array.isArray(existingSub?.ai_feedback_json?.attemptHistory)
          ? existingSub.ai_feedback_json.attemptHistory
          : existingSub
          ? [
              {
                attempt: 1,
                score: existingSub.score,
                submittedAt: existingSub.submitted_at || new Date().toISOString()
              }
            ]
          : [];

        const nextHistory = [
          ...prevHistory,
          {
            attempt: currentAttemptNum,
            score: finalScore,
            submittedAt: new Date().toISOString()
          }
        ];

        // Nếu luyện tập nhiều lần: giữ điểm cao nhất làm điểm chính thức trên bảng điểm
        const prevBestScore =
          existingSub && existingSub.score !== null && existingSub.score !== undefined
            ? Number(existingSub.score)
            : null;
        const bestScore =
          finalScore !== null && prevBestScore !== null
            ? Math.max(prevBestScore, Number(finalScore))
            : finalScore !== null
            ? finalScore
            : prevBestScore;

        const enrichedFeedbackJson = {
          ...finalFeedbackJson,
          attemptCount: currentAttemptNum,
          latestScore: finalScore,
          bestScore,
          attemptHistory: nextHistory
        };

        const fullSubPayload = {
          student_id: currentStudent.id,
          student_code: currentStudent.student_code,
          assignment_id: submittingAsg.id,
          file_url: fileUrl || existingSub?.file_url || null,
          file_name: fileName || existingSub?.file_name || null,
          answer_text: formattedAnswerText,
          answers_json: stuInteractiveAnswers,
          status: finalStatus,
          score: bestScore,
          weak_topics: finalWeakTopics,
          ai_feedback_json: enrichedFeedbackJson
        };

        let insertErr = null;
        if (existingSub) {
          const { error: updErr } = await supabase
            .from('submissions')
            .update({
              file_url: fullSubPayload.file_url,
              file_name: fullSubPayload.file_name,
              answer_text: fullSubPayload.answer_text,
              answers_json: fullSubPayload.answers_json,
              status: fullSubPayload.status,
              score: fullSubPayload.score,
              weak_topics: fullSubPayload.weak_topics,
              ai_feedback_json: fullSubPayload.ai_feedback_json,
              submitted_at: new Date().toISOString()
            })
            .eq('id', existingSub.id);
          insertErr = updErr;
        } else {
          const res = await supabase.from('submissions').insert([fullSubPayload]);
          insertErr = res.error;
          if (insertErr && insertErr.message?.includes('column')) {
            const { answers_json, ...fallbackSub } = fullSubPayload;
            const retry = await supabase.from('submissions').insert([fallbackSub]);
            insertErr = retry.error;
          }
        }

        if (insertErr) throw insertErr;

        // Xóa bản nháp & thoát chế độ làm lại sau khi nộp thành công
        localStorage.removeItem(`sc_draft_${currentStudent.student_code}_${submittingAsg.id}`);
        setIsRetryingPractice(false);
        setRemainingSeconds(null);
        setDraftRestoredBanner(false);

        notify(
          isAutoTimeout
            ? `Hết giờ làm bài! Hệ thống đã tự động thu bài (${finalScore !== null ? `Điểm: ${finalScore}/10` : 'Chờ GV chấm'}).`
            : existingSub && finalScore !== null
            ? `Hoàn thành lần ${currentAttemptNum}: Đạt ${finalScore}/10 điểm (Điểm cao nhất: ${bestScore}/10)!`
            : finalStatus === 'graded'
            ? `Chấm tự động hoàn tất! Điểm của em: ${finalScore}/10 — Xem chi tiết đáp án ngay!`
            : 'Đã nộp bài thành công! Giáo viên sẽ chấm điểm và trả kết quả ngay.'
        );
        await fetchAllData();
      } catch (err) {
        notify('Lỗi nộp bài: ' + err.message, 'error');
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      submittingAsg,
      currentStudent,
      supabase,
      isSubmitting,
      studentPortalData,
      stuAnswerInput,
      stuPdfFile,
      stuInteractiveAnswers,
      notify,
      fetchAllData
    ]
  );

  // Đồng hồ đếm ngược khi học sinh đang làm bài có giới hạn thời gian
  useEffect(() => {
    if (remainingSeconds === null || !submittingAsg || !currentStudent) return;
    if (studentPortalData?.subByAsg?.[submittingAsg.id] && !isRetryingPractice) return;

    if (remainingSeconds <= 0) {
      submitStudentWork(true);
      return;
    }

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev === null) return null;
        return prev > 0 ? prev - 1 : 0;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [remainingSeconds, submittingAsg, currentStudent, studentPortalData, submitStudentWork, isRetryingPractice]);

  // Danh sách học sinh theo lớp & trạng thái Đang học / Nghỉ học
  const classStudentsAll = useMemo(() => {
    if (selectedClassId === 'all') return students;
    return students.filter((s) => s.class_id === selectedClassId);
  }, [students, selectedClassId]);

  const activeClassStudents = useMemo(() => {
    return classStudentsAll.filter(
      (s) => (studentMetaMap[s.id]?.status || 'active') === 'active'
    );
  }, [classStudentsAll, studentMetaMap]);

  const trackedStudentsForStats = useMemo(() => {
    return includeInactiveInStats ? classStudentsAll : activeClassStudents;
  }, [includeInactiveInStats, classStudentsAll, activeClassStudents]);

  const trackedStudentIds = useMemo(
    () => new Set(trackedStudentsForStats.map((s) => s.id)),
    [trackedStudentsForStats]
  );

  const filteredSubmissions = useMemo(() => {
    return submissions.filter((sub) => trackedStudentIds.has(sub.student_id));
  }, [submissions, trackedStudentIds]);

  const pendingReviewSubmissions = useMemo(() => {
    return filteredSubmissions.filter((s) => s.status === 'pending_review');
  }, [filteredSubmissions]);

  const teacherKpis = useMemo(() => {
    const allItems = trackedStudentsForStats.flatMap((stu) => unifiedScoresByStudent[stu.id]?.items || []);
    const avgScore =
      allItems.length > 0
        ? (allItems.reduce((acc, cur) => acc + cur.score, 0) / allItems.length).toFixed(1)
        : '—';
    const classAssignments = assignments.filter(
      (a) => !a.is_remedial && (selectedClassId === 'all' || !a.class_id || a.class_id === selectedClassId)
    );
    const expectedTotal = trackedStudentsForStats.length * Math.max(1, classAssignments.length);
    const rate =
      expectedTotal > 0 ? Math.min(100, Math.round((filteredSubmissions.length / expectedTotal) * 100)) : 0;

    return {
      studentCount: trackedStudentsForStats.length,
      inactiveCount: classStudentsAll.length - activeClassStudents.length,
      submissionRate: `${rate}%`,
      avgScore,
      pendingCount: pendingReviewSubmissions.length
    };
  }, [
    trackedStudentsForStats,
    classStudentsAll,
    activeClassStudents,
    filteredSubmissions,
    assignments,
    selectedClassId,
    pendingReviewSubmissions,
    unifiedScoresByStudent
  ]);

  // Phân tích phễu: Top câu sai nhiều nhất toàn lớp + Nhóm tốt / Nhóm cần kèm
  const classFunnelAnalytics = useMemo(() => {
    const classAsgs = assignments.filter(
      (a) => !a.is_remedial && (selectedClassId === 'all' || !a.class_id || a.class_id === selectedClassId)
    );

    const perStudentStats = trackedStudentsForStats.map((stu) => {
      const stuSubs = filteredSubmissions.filter((s) => s.student_id === stu.id);
      const avg = unifiedScoresByStudent[stu.id]?.avg ?? null;
      const missingCount =
        Math.max(0, classAsgs.length - stuSubs.length) +
        (unifiedScoresByStudent[stu.id]?.missingManual.length || 0);
      return {
        student: stu,
        submittedCount: stuSubs.length,
        missingCount,
        avgScore: avg
      };
    });

    const topPerformers = perStudentStats
      .filter((x) => x.avgScore !== null && x.avgScore >= 8.0)
      .sort((a, b) => b.avgScore - a.avgScore);

    const needSupport = perStudentStats.filter(
      (x) => (x.avgScore !== null && x.avgScore < 6.5) || x.missingCount > 0
    );

    // Thống kê câu sai nhiều nhất trên bài gần nhất / toàn bộ bài
    const wrongQuestionCounter = {};
    filteredSubmissions.forEach((sub) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      const breakdown = sub.ai_feedback_json?.breakdown || [];
      breakdown.forEach((b) => {
        if (b.status === 'wrong') {
          const key = `${asg?.title || 'Bài tập'} — Câu ${b.question}`;
          if (!wrongQuestionCounter[key]) {
            wrongQuestionCounter[key] = {
              label: key,
              asgTitle: asg?.title || 'Bài tập',
              qNum: b.question,
              wrongCount: 0,
              totalAttempts: 0
            };
          }
          wrongQuestionCounter[key].wrongCount += 1;
        }
        if (b.status === 'wrong' || b.status === 'correct') {
          const key = `${asg?.title || 'Bài tập'} — Câu ${b.question}`;
          if (!wrongQuestionCounter[key]) {
            wrongQuestionCounter[key] = {
              label: key,
              asgTitle: asg?.title || 'Bài tập',
              qNum: b.question,
              wrongCount: 0,
              totalAttempts: 0
            };
          }
          wrongQuestionCounter[key].totalAttempts += 1;
        }
      });
    });

    const topMissedQuestions = Object.values(wrongQuestionCounter)
      .filter((x) => x.wrongCount > 0)
      .map((x) => ({
        ...x,
        wrongRate:
          x.totalAttempts > 0 ? Math.round((x.wrongCount / x.totalAttempts) * 100) : 100
      }))
      .sort((a, b) => b.wrongCount - a.wrongCount || b.wrongRate - a.wrongRate)
      .slice(0, 6);

    const selectedClassObj = classes.find((c) => c.id === selectedClassId);
    const classLabel = selectedClassObj ? selectedClassObj.name : 'Tất cả các lớp';

    const autoOverviewReport = [
      `📊 BÁO CÁO TỔNG QUAN TÌNH HÌNH HỌC TẬP (${classLabel.toUpperCase()})`,
      `• Sĩ số đang theo dõi: ${trackedStudentsForStats.length} học sinh | Tỷ lệ hoàn thành bài: ${teacherKpis.submissionRate} | Điểm TB tổng hợp (Web + Vocab + Chấm tay): ${teacherKpis.avgScore}/10.`,
      topPerformers.length > 0
        ? `• 🌟 Nhóm học tốt (≥ 8.0đ): ${topPerformers
            .slice(0, 5)
            .map((x) => `${x.student.full_name} (${x.avgScore}đ)`)
            .join(', ')}.`
        : `• 🌟 Nhóm học tốt (≥ 8.0đ): Chưa có học sinh đạt mức ≥ 8.0đ ở kỳ này.`,
      needSupport.length > 0
        ? `• ⚠️ Nhóm cần đôn đốc / kèm thêm: ${needSupport
            .slice(0, 6)
            .map(
              (x) =>
                `${x.student.full_name}${
                  x.avgScore !== null && x.avgScore < 6.5 ? ` (${x.avgScore}đ)` : ''
                }${x.missingCount > 0 ? ` (thiếu ${x.missingCount} bài)` : ''}`
            )
            .join(', ')}.`
        : `• ✅ Tất cả học sinh đều đã hoàn thành đầy đủ bài tập và đạt mức điểm khá trở lên.`,
      topMissedQuestions.length > 0
        ? `• 🎯 Trọng tâm cần chữa trên lớp: ${topMissedQuestions
            .slice(0, 3)
            .map((q) => `Câu ${q.qNum} [${q.asgTitle}] (${q.wrongCount}/${q.totalAttempts} em sai)`)
            .join('; ')}.`
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    return {
      topPerformers,
      needSupport,
      topMissedQuestions,
      autoOverviewReport
    };
  }, [
    assignments,
    selectedClassId,
    trackedStudentsForStats,
    filteredSubmissions,
    classes,
    teacherKpis,
    unifiedScoresByStudent
  ]);

  // Phân tích chi tiết từng câu của 1 đề thi bất kỳ (Top câu nhiều học sinh sai nhất)
  const assignmentAnalyticsData = useMemo(() => {
    if (!analyticsAssignment) return null;
    const qList = getAssignmentQuestions(analyticsAssignment);
    const asgSubs = submissions.filter((s) => s.assignment_id === analyticsAssignment.id);
    const graded = asgSubs.filter((s) => s.score !== null && s.score !== undefined);
    const avgScore =
      graded.length > 0
        ? (graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1)
        : '—';

    const questionStats = qList.map((q) => {
      const qKey = String(q.number);
      let wrongCount = 0;
      let correctCount = 0;
      const choiceCounts = {};

      asgSubs.forEach((sub) => {
        const ansMap = sub.answers_json || sub.ai_feedback_json?.studentAnswersMap || {};
        const breakdown = sub.ai_feedback_json?.breakdown || [];
        const bItem = breakdown.find((b) => String(b.question) === qKey);
        const stuAns = String(ansMap[qKey] || bItem?.actual || '').trim();

        if (stuAns && stuAns !== '(Bỏ trống)') {
          choiceCounts[stuAns] = (choiceCounts[stuAns] || 0) + 1;
        }

        const canAuto = hasGradableKey(q) && (q.type === 'mcq' || !bItem);
        if (canAuto) {
          if (isAnswerCorrect(q, stuAns)) correctCount += 1;
          else wrongCount += 1;
        } else if (bItem) {
          if (bItem.status === 'wrong') wrongCount += 1;
          else if (bItem.status === 'correct') correctCount += 1;
        }
      });

      const attempts = wrongCount + correctCount;
      const wrongRate = attempts > 0 ? Math.round((wrongCount / attempts) * 100) : 0;

      // Tìm phương án sai bị chọn nhiều nhất
      const wrongChoices = Object.entries(choiceCounts)
        .filter(([opt]) => opt.toUpperCase() !== getKeyLetterOrText(q).toUpperCase())
        .sort((a, b) => b[1] - a[1]);

      return {
        ...q,
        wrongCount,
        correctCount,
        attempts,
        wrongRate,
        mostCommonWrong: wrongChoices[0] || null
      };
    });

    const topMissed = [...questionStats]
      .filter((q) => q.wrongCount > 0)
      .sort((a, b) => b.wrongCount - a.wrongCount || b.wrongRate - a.wrongRate);

    return {
      asgSubs,
      avgScore,
      questionStats,
      topMissed
    };
  }, [analyticsAssignment, submissions]);

  const teacherChartPoints = useMemo(() => {
    const targetStudents =
      chartStudentFilter === 'all'
        ? trackedStudentsForStats
        : trackedStudentsForStats.filter((s) => s.id === chartStudentFilter);
    const items = targetStudents.flatMap((stu) => unifiedScoresByStudent[stu.id]?.items || []);

    const groups = {};
    items.forEach((it) => {
      const sortKey = chartTimeMode === 'week' ? String(it.week).padStart(3, '0') : it.date || '9999-99-99';
      if (!groups[sortKey]) {
        const [, mm, dd] = String(it.date || '').split('-');
        groups[sortKey] = {
          label: chartTimeMode === 'week' ? `Tuần ${it.week}` : dd && mm ? `${dd}/${mm}` : '—',
          arr: []
        };
      }
      groups[sortKey].arr.push(it.score);
    });

    return Object.keys(groups)
      .sort()
      .map((k) => ({
        label: groups[k].label,
        score: Number((groups[k].arr.reduce((a, b) => a + b, 0) / groups[k].arr.length).toFixed(1))
      }));
  }, [trackedStudentsForStats, chartStudentFilter, chartTimeMode, unifiedScoresByStudent]);

  // Tạo nhận xét tự động chi tiết cho từng học sinh (gửi phụ huynh)
  const buildIndividualStudentReport = useCallback(
    (stu) => {
      const stuSubs = submissions.filter((s) => s.student_id === stu.id);
      const graded = stuSubs.filter((s) => s.score !== null && s.score !== undefined);
      const chronological = [...graded].reverse();
      const unified = unifiedScoresByStudent[stu.id];
      const avg = unified && unified.avg !== null ? unified.avg.toFixed(1) : null;
      const attendance = getStudentAttendanceSummary(stu);

      const classTasks = assignments.filter(
        (a) => !a.is_remedial && (!a.class_id || a.class_id === stu.class_id)
      );
      const missingTasks = classTasks.filter((t) => !stuSubs.some((s) => s.assignment_id === t.id));

      const weakCounter = {};
      const allWrongSample = [];
      stuSubs.forEach((sub) => {
        const asg = assignments.find((a) => a.id === sub.assignment_id);
        (sub.weak_topics || []).forEach((t) => {
          weakCounter[t] = (weakCounter[t] || 0) + 1;
        });
        (sub.ai_feedback_json?.breakdown || []).forEach((b) => {
          if (b.status === 'wrong' && allWrongSample.length < 6) {
            allWrongSample.push(`Câu ${b.question} (${asg?.title || 'Bài tập'})`);
          }
        });
      });
      const weakTopicsArr = Object.keys(weakCounter);

      let trajectoryText = '';
      if (chronological.length >= 2) {
        const prev = Number(chronological[chronological.length - 2].score);
        const latest = Number(chronological[chronological.length - 1].score);
        const diff = Number((latest - prev).toFixed(1));
        trajectoryText =
          diff > 0
            ? `Phong độ tăng +${diff} điểm so với bài trước (${prev}đ → ${latest}đ).`
            : diff < 0
            ? `Điểm giảm ${Math.abs(diff)} điểm so với bài trước (${prev}đ → ${latest}đ), cần tập trung rà soát kỹ hơn.`
            : `Phong độ ổn định ở mức ${latest}đ.`;
      } else if (chronological.length === 1) {
        trajectoryText = `Bài gần nhất đạt ${chronological[0].score}/10 điểm.`;
      }

      const parentMessage = [
        `📋 BÁO CÁO TÌNH HÌNH HỌC TẬP — EM ${stu.full_name.toUpperCase()} (${stu.student_code})`,
        `• Lớp: ${stu.class_name || 'Lớp học'} | Số bài web đã nộp: ${stuSubs.length}/${classTasks.length} bài | Điểm TB tổng hợp: ${
          avg !== null ? `${avg}/10` : 'Chưa có điểm'
        }.`,
        unified && unified.items.length > 0 ? `• Chi tiết điểm: ${formatSourceBreakdown(unified)}.` : '',
        attendance
          ? `• Chuyên cần tháng ${formatYmLabel(attendance.ym)}: có mặt ${attendance.presentCount}/${attendance.total} buổi.`
          : '',
        trajectoryText ? `• Tiến độ: ${trajectoryText}` : '',
        unified && unified.missingManual.length > 0
          ? `• ⚠️ Bài CHƯA NỘP (tính 0đ): ${unified.missingManual.join(', ')} — Phụ huynh nhắc em nộp bổ sung giúp cô nhé.`
          : '',
        missingTasks.length > 0
          ? `• Bài chưa hoàn thành: ${missingTasks.map((t) => t.title).join(', ')} (Phụ huynh nhắc em hoàn thành sớm nhé).`
          : `• Chuyên cần: Em đã hoàn thành đầy đủ các bài tập được giao.`,
        weakTopicsArr.length > 0 || allWrongSample.length > 0
          ? `• Phần kiến thức / dạng câu hay mất điểm: ${
              weakTopicsArr.length > 0 ? weakTopicsArr.join(', ') : ''
            }${allWrongSample.length > 0 ? ` — Cụ thể sai ở ${allWrongSample.join(', ')}` : ''}.`
          : `• Nhận xét chuyên môn: Em nắm chắc kiến thức, các dạng bài đều làm tốt.`,
        avg !== null && Number(avg) >= 8
          ? `👉 Lời khuyên: Em đang học rất tốt, tiếp tục duy trì phong độ và luyện thêm các bài nâng cao.`
          : `👉 Lời khuyên: Em cần xem lại phần giải thích các câu sai trên hệ thống và làm đầy đủ bài ôn bổ trợ giáo viên giao.`
      ]
        .filter(Boolean)
        .join('\n');

      return {
        submissions: stuSubs,
        avg,
        missingTasks,
        weakList: Object.entries(weakCounter).sort((a, b) => b[1] - a[1]),
        parentMessage
      };
    },
    [submissions, assignments, unifiedScoresByStudent, getStudentAttendanceSummary]
  );

  const deepDiveData = useMemo(() => {
    if (!deepDiveStudent) return null;
    const report = buildIndividualStudentReport(deepDiveStudent);
    const graded = report.submissions.filter((s) => s.score !== null && s.score !== undefined);
    const trend = [...graded].reverse().map((sub, idx) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      return {
        label: asg ? `T${asg.week_number || idx + 1}` : `Bài ${idx + 1}`,
        score: Number(sub.score)
      };
    });

    // Kiểm tra các câu sai cũ nào đã được em làm lại đúng trong bài ôn bổ trợ
    const masteredSourceUids = new Set();
    report.submissions.forEach((sub) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      if (!asg?.is_remedial) return;
      const qList = getAssignmentQuestions(asg);
      const breakdown = sub.ai_feedback_json?.breakdown || [];
      breakdown.forEach((b) => {
        if (b.status === 'correct') {
          const matchedQ = qList.find((q) => String(q.number) === String(b.question));
          if (matchedQ?.sourceUid) {
            masteredSourceUids.add(matchedQ.sourceUid);
          }
        }
      });
    });

    // Tự động gom toàn bộ câu hỏi học sinh từng làm sai (kèm nguyên đoạn văn đọc hiểu, phương án, đáp án & giải thích)
    const wrongMap = new Map();
    report.submissions.forEach((sub) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      if (!asg || asg.is_remedial) return;

      const asgQuestions = getAssignmentQuestions(asg);
      const breakdown = sub.ai_feedback_json?.breakdown || [];
      const ansMap = sub.answers_json || sub.ai_feedback_json?.studentAnswersMap || {};

      if (breakdown.length > 0) {
        breakdown.forEach((b) => {
          if (b.status !== 'wrong') return;
          const qNumStr = String(b.question);
          const origQ = asgQuestions.find((q) => String(q.number) === qNumStr);
          // Ignore stale "wrong" marks produced by an unreadable key in the past
          if (
            origQ &&
            origQ.type === 'mcq' &&
            hasGradableKey(origQ) &&
            isAnswerCorrect(origQ, ansMap[qNumStr] || b.actual)
          ) {
            return;
          }
          const uid = `${asg.id}__${qNumStr}`;
          if (!wrongMap.has(uid)) {
            wrongMap.set(uid, {
              uid,
              sourceAssignmentId: asg.id,
              sourceAssignmentTitle: asg.title,
              sourceQuestionNumber: Number(qNumStr) || 0,
              sourceTopic: asg.topic || 'Tổng hợp',
              type: origQ?.type === 'mcq' ? 'mcq' : 'open',
              passage: origQ?.passage || '',
              text: origQ?.text || `Câu ${qNumStr} (${asg.title})`,
              options: origQ?.options || { A: '', B: '', C: '', D: '' },
              correctAnswer: origQ?.correctAnswer || b.expected || '',
              explanation: origQ?.explanation || b.explanation || '',
              previousAnswer: b.actual || ansMap[qNumStr] || '(Bỏ trống)',
              isAlreadyFixed: masteredSourceUids.has(uid)
            });
          }
        });
      } else if (asgQuestions.length > 0 && sub.score !== null && sub.score !== undefined) {
        asgQuestions.forEach((origQ) => {
          const qNumStr = String(origQ.number);
          if (!hasGradableKey(origQ)) return;
          const expected = getKeyLetterOrText(origQ);
          const actual = String(ansMap[qNumStr] || '').trim();
          const isRight = isAnswerCorrect(origQ, actual);
          if (!isRight) {
            const uid = `${asg.id}__${qNumStr}`;
            if (!wrongMap.has(uid)) {
              wrongMap.set(uid, {
                uid,
                sourceAssignmentId: asg.id,
                sourceAssignmentTitle: asg.title,
                sourceQuestionNumber: origQ.number,
                sourceTopic: asg.topic || 'Tổng hợp',
                type: origQ.type === 'mcq' ? 'mcq' : 'open',
                passage: origQ.passage || '',
                text: origQ.text,
                options: origQ.options || { A: '', B: '', C: '', D: '' },
                correctAnswer: expected,
                explanation: origQ.explanation || '',
                previousAnswer: actual || '(Bỏ trống)',
                isAlreadyFixed: masteredSourceUids.has(uid)
              });
            }
          }
        });
      }
    });

    const wrongQuestionsPool = Array.from(wrongMap.values());
    const unfixedWrongQuestions = wrongQuestionsPool.filter((q) => !q.isAlreadyFixed);

    return {
      ...report,
      trend,
      wrongQuestionsPool,
      unfixedWrongQuestions
    };
  }, [deepDiveStudent, buildIndividualStudentReport, assignments]);

  // Tự động chọn sẵn toàn bộ câu sai chưa khắc phục mỗi khi mở Deep-dive của 1 học sinh
  useEffect(() => {
    if (!deepDiveStudent || !deepDiveData) return;
    const defaultList =
      deepDiveData.unfixedWrongQuestions.length > 0
        ? deepDiveData.unfixedWrongQuestions
        : deepDiveData.wrongQuestionsPool;

    setSelectedWrongUids(defaultList.map((q) => q.uid));
    setRemSourceFile(null);
    setRemAnswerKey('');
    setRemNote('');
    if (defaultList.length > 0) {
      setRemTitle(`Luyện lại ${defaultList.length} câu đã sai — ${deepDiveStudent.full_name}`);
    } else {
      setRemTitle(
        deepDiveData.weakList[0]?.[0]
          ? `Ôn tập bổ trợ: ${deepDiveData.weakList[0][0]}`
          : 'Bài luyện tập củng cố'
      );
    }
  }, [deepDiveStudent?.id]);

  const handleAssignRemedial = useCallback(
    async (e) => {
      e.preventDefault();
      if (!deepDiveStudent || !supabase || isAssigningRemedial) return;

      const selectedQuestions = (deepDiveData?.wrongQuestionsPool || []).filter((q) =>
        selectedWrongUids.includes(q.uid)
      );

      if (selectedQuestions.length === 0 && !remSourceFile && !remTitle.trim()) {
        notify('Anh vui lòng chọn ít nhất 1 câu đã sai hoặc đính kèm file đề!', 'error');
        return;
      }

      setIsAssigningRemedial(true);
      try {
        let uploadedFileUrl = null;
        let uploadedFileName = null;
        let parsedExternalQuestions = [];

        if (remSourceFile) {
          const cleanName = remSourceFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `remedial/${deepDiveStudent.student_code}_${Date.now()}_${cleanName}`;
          const { error: upErr } = await supabase.storage
            .from('homework-files')
            .upload(path, remSourceFile, { upsert: true });
          if (!upErr) {
            const { data: pub } = supabase.storage.from('homework-files').getPublicUrl(path);
            uploadedFileUrl = pub?.publicUrl || null;
            uploadedFileName = remSourceFile.name;
          }

          // Nếu không dùng bộ câu sai mà up file đề ngoài -> tự bóc tách câu hỏi từ file Word/PDF luôn
          if (selectedQuestions.length === 0) {
            try {
              const extracted = await extractRawContentFromFile(remSourceFile);
              parsedExternalQuestions = parseQuestionsFromExtractedContent(extracted);
            } catch {
              parsedExternalQuestions = [];
            }
          }
        }

        const compiledQuestions =
          selectedQuestions.length > 0
            ? selectedQuestions.map((q, idx) => ({
                id: `rem-q-${idx + 1}-${Date.now()}`,
                number: idx + 1,
                type: q.type === 'mcq' ? 'mcq' : 'open',
                passage: q.passage || '',
                text: q.text,
                options: q.options || { A: '', B: '', C: '', D: '' },
                correctAnswer: q.correctAnswer || '',
                explanation: q.explanation || '',
                sourceUid: q.uid,
                sourceHint: `${q.sourceAssignmentTitle} — Câu ${q.sourceQuestionNumber}`,
                previousWrongAnswer: q.previousAnswer || ''
              }))
            : parsedExternalQuestions.map((q, idx) => ({
                ...q,
                type: q.type === 'mcq' ? 'mcq' : 'open',
                number: idx + 1
              }));

        const finalTitle =
          remTitle.trim() ||
          (selectedQuestions.length > 0
            ? `Luyện lại ${selectedQuestions.length} câu đã sai — ${deepDiveStudent.full_name}`
            : remSourceFile
            ? `Bài ôn bổ trợ: ${remSourceFile.name.replace(/\.[^/.]+$/, '')}`
            : 'Bài ôn tập bổ trợ');

        const finalAnswerKey =
          compiledQuestions.length > 0
            ? compiledQuestions
                .filter((q) => q.correctAnswer)
                .map((q) => `${q.number}:${q.correctAnswer}`)
                .join(', ')
            : remAnswerKey.trim();

        const baseNote =
          remNote.trim() ||
          (selectedQuestions.length > 0
            ? `Bộ ${selectedQuestions.length} câu em từng làm sai. Hãy tự suy nghĩ làm lại cẩn thận — đáp án & giải thích chi tiết sẽ mở ngay sau khi em nộp bài!`
            : '');

        const embeddedRubric =
          compiledQuestions.length > 0
            ? `${baseNote}\n__SC_QUESTIONS__:${JSON.stringify(compiledQuestions)}`
            : baseNote;

        const fullPayload = {
          title: finalTitle,
          class_id: deepDiveStudent.class_id,
          class_name: deepDiveStudent.class_name,
          target_student_id: deepDiveStudent.id,
          week_number: 0,
          due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
          topic: remTopic.trim() || 'Luyện lại câu sai',
          answer_key_text: finalAnswerKey,
          answer_key_url: uploadedFileUrl,
          rubric: embeddedRubric,
          is_remedial: true,
          questions_json: compiledQuestions,
          source_file_url: uploadedFileUrl,
          source_file_name: uploadedFileName
        };

        let { error } = await supabase.from('assignments').insert([fullPayload]);

        if (error && error.message?.includes('column')) {
          const fallbackPayload = {
            title: fullPayload.title,
            class_id: fullPayload.class_id,
            class_name: fullPayload.class_name,
            target_student_id: fullPayload.target_student_id,
            week_number: 0,
            due_date: fullPayload.due_date,
            topic: fullPayload.topic,
            answer_key_text: fullPayload.answer_key_text,
            answer_key_url: uploadedFileUrl,
            rubric: embeddedRubric,
            is_remedial: true
          };
          const retry = await supabase.from('assignments').insert([fallbackPayload]);
          error = retry.error;
        }

        if (error) throw error;

        await supabase.from('announcements').insert([
          {
            target_student_id: deepDiveStudent.id,
            message:
              selectedQuestions.length > 0
                ? `Giáo viên vừa giao bài "${finalTitle}" gồm ${selectedQuestions.length} câu em từng làm sai để em tự luyện lại và xem giải thích chi tiết!`
                : `Giáo viên vừa giao bài ôn bổ trợ riêng "${finalTitle}" cho phần ${remTopic || 'cần củng cố'}.`
          }
        ]);

        setRemSourceFile(null);
        setRemAnswerKey('');
        setRemNote('');
        notify(
          selectedQuestions.length > 0
            ? `Đã giao bài luyện lại ${selectedQuestions.length} câu đã sai cho ${deepDiveStudent.full_name}!`
            : `Đã giao bài ôn bổ trợ riêng cho ${deepDiveStudent.full_name}!`
        );
        fetchAllData();
      } catch (err) {
        notify('Lỗi giao bài ôn riêng: ' + err.message, 'error');
      } finally {
        setIsAssigningRemedial(false);
      }
    },
    [
      deepDiveStudent,
      supabase,
      isAssigningRemedial,
      deepDiveData,
      selectedWrongUids,
      remSourceFile,
      remTitle,
      remAnswerKey,
      remNote,
      remTopic,
      notify,
      fetchAllData
    ]
  );

  const handleDismissAnnouncement = (annId) => {
    const next = [...dismissedAnnIds, annId];
    setDismissedAnnIds(next);
    localStorage.setItem('sc_dismissed_anns', JSON.stringify(next));
  };

  const handleRemindAllUnsubmitted = async () => {
    if (!supabase) return;
    const classAsgs = assignments.filter(
      (a) => !a.is_remedial && (selectedClassId === 'all' || !a.class_id || a.class_id === selectedClassId)
    );
    if (classAsgs.length === 0) {
      notify('Chưa có bài tập nào được giao.', 'error');
      return;
    }
    const rows = [];
    activeClassStudents.forEach((stu) => {
      const stuSubs = submissions.filter((s) => s.student_id === stu.id);
      const missing = classAsgs.filter((t) => !stuSubs.some((s) => s.assignment_id === t.id));
      if (missing.length > 0) {
        rows.push({
          target_student_id: stu.id,
          message: `Nhắc nhở: Em ${stu.full_name} còn ${missing.length} bài chưa nộp (${missing
            .slice(0, 2)
            .map((m) => m.title)
            .join(', ')}). Em tranh thủ hoàn thành sớm nhé!`
        });
      }
    });
    if (rows.length === 0) {
      notify('Tất cả học sinh đang học đều đã nộp đủ bài!');
      return;
    }
    const { error } = await supabase.from('announcements').insert(rows);
    if (error) notify(error.message, 'error');
    else {
      notify(`Đã gửi nhắc nhở tới ${rows.length} học sinh chưa nộp đủ bài!`);
      fetchAllData();
    }
  };

  const previewNextId = useMemo(() => {
    if (genClassMode === 'new' || classes.length === 0) {
      const p = deriveClassPrefix(genNewClassName || '10A1');
      return `${p}-01`;
    }
    const cls = classes.find((c) => c.id === genSelectedClassId) || classes[0];
    if (!cls) return 'HS-01';
    const p = deriveClassPrefix(cls.name, cls.id);
    const count = students.filter(
      (s) => s.class_id === cls.id || s.student_code?.startsWith(`${p}-`)
    ).length;
    return `${p}-${String(count + 1).padStart(2, '0')}`;
  }, [genClassMode, genNewClassName, genSelectedClassId, classes, students]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 via-rose-50/80 to-fuchsia-50/50 text-slate-800 relative overflow-x-hidden">
      {/* Họa tiết nền hồng pastel dịu mắt tạo cảm hứng học tập */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-pink-200/35 blur-3xl" />
        <div className="absolute top-1/3 -right-28 w-96 h-96 rounded-full bg-rose-200/30 blur-3xl" />
        <div className="absolute -bottom-24 left-1/4 w-96 h-96 rounded-full bg-fuchsia-200/25 blur-3xl" />
      </div>
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 text-white ${
            toast.type === 'error' ? 'bg-rose-600' : 'bg-emerald-600'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{toast.msg}</span>
        </div>
      )}

      {/* HỘP THOẠI XÁC NHẬN XÓA AN TOÀN */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 text-base">{confirmDialog.title}</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">{confirmDialog.message}</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={async () => {
                  const fn = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  await fn();
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-sm"
              >
                {confirmDialog.confirmText || 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-pink-200/80 shadow-sm shadow-pink-100/50 px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-500 text-white flex items-center justify-center text-lg font-bold shadow-md shadow-pink-200">
              🌸
            </div>
            <div>
              <div className="font-bold text-slate-900 leading-tight flex items-center gap-2">
                <span className="bg-gradient-to-r from-pink-600 via-rose-500 to-fuchsia-600 bg-clip-text text-transparent font-extrabold text-base sm:text-lg tracking-tight">
                  Lớp cô Hà
                </span>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-full font-semibold ${
                    supabase && realtimeStatus === 'live'
                      ? 'bg-pink-50 text-pink-700 border border-pink-200'
                      : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      supabase && realtimeStatus === 'live' ? 'bg-pink-500 animate-pulse' : 'bg-amber-500'
                    }`}
                  />
                  {supabase ? 'Lớp cô Hà • Online' : 'Chưa nối DB'}
                </span>
              </div>
              <p className="text-xs text-pink-700/80 hidden sm:block font-medium">
                ✨ Lớp cô Hà — Học vui mỗi ngày • Làm bài trực tiếp & nhận giải thích chi tiết ✨
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {role === 'teacher' && (
              <button
                onClick={() => {
                  setGeneratedCredentials([]);
                  setShowQuickGenModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
              >
                <Wand2 className="w-3.5 h-3.5" />
                <span>+ Cấp ID Học sinh mới</span>
              </button>
            )}

            {supabase && (
              <button
                onClick={fetchAllData}
                title="Làm mới dữ liệu"
                className="p-2 text-slate-500 hover:text-pink-600 hover:bg-slate-100 rounded-lg transition"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}

            {(!hasEnvConfig || role === 'teacher') && (
              <button
                onClick={() => setShowSetupModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700"
              >
                <Database className="w-3.5 h-3.5 text-pink-600" />
                <span className="hidden sm:inline">Supabase</span>
              </button>
            )}

            {role !== 'login' && (
              <button
                onClick={handleLogout}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 hover:bg-rose-50 hover:text-rose-600 text-slate-700 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Đăng xuất</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MODAL CẬP NHẬT TRẠNG THÁI HỌC SINH (ĐANG HỌC / NGHỈ HỌC) */}
      {editingStudentStatus && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveStudentStatus}
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-bold text-slate-900">
                  Trạng thái theo học: {editingStudentStatus.full_name}
                </h3>
                <p className="text-xs text-slate-500">
                  Mã ID: {editingStudentStatus.student_code} • Giữ nguyên toàn bộ điểm lịch sử
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingStudentStatus(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setStuStatusDraft('active')}
                className={`p-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition ${
                  stuStatusDraft === 'active'
                    ? 'bg-emerald-50 border-emerald-500 text-emerald-700'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                <UserCheck className="w-4 h-4" />
                <span>Đang học</span>
              </button>
              <button
                type="button"
                onClick={() => setStuStatusDraft('inactive')}
                className={`p-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition ${
                  stuStatusDraft === 'inactive'
                    ? 'bg-amber-50 border-amber-500 text-amber-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                <UserX className="w-4 h-4" />
                <span>Nghỉ học</span>
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Ghi chú theo dõi (VD: Nghỉ từ 15/11 - Chuyển trường / Bảo lưu)
              </label>
              <input
                type="text"
                placeholder="Nhập ghi chú ngắn..."
                value={stuNoteDraft}
                onChange={(e) => setStuNoteDraft(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-sm font-semibold"
            >
              Lưu trạng thái học sinh
            </button>
          </form>
        </div>
      )}

      {/* MODAL GENERATE NHANH ID & PIN */}
      {showQuickGenModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-5">
            <div className="flex items-start justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="font-bold text-lg text-slate-900 flex items-center gap-2">
                  <Wand2 className="w-5 h-5 text-emerald-600" />
                  <span>Generate ID & Mật khẩu cho học sinh mới</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Chọn hoặc tạo lớp → Bấm Generate → Copy gửi học sinh đăng nhập
                </p>
              </div>
              <button
                onClick={() => setShowQuickGenModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleGenerateStudentCredentials} className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700">1. Chọn lớp học</label>
                  <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setGenClassMode('existing')}
                      className={`px-2 py-0.5 rounded-md font-semibold ${
                        genClassMode === 'existing' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      Lớp có sẵn
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenClassMode('new')}
                      className={`px-2 py-0.5 rounded-md font-semibold ${
                        genClassMode === 'new' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      + Tạo lớp mới
                    </button>
                  </div>
                </div>

                {genClassMode === 'existing' && classes.length > 0 ? (
                  <select
                    value={genSelectedClassId}
                    onChange={(e) => setGenSelectedClassId(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-pink-500 outline-none"
                  >
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.group_name}) — Tiền tố mã: {deriveClassPrefix(c.name, c.id)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="text"
                      required
                      placeholder="Tên lớp (VD: 10A1)"
                      value={genNewClassName}
                      onChange={(e) => setGenNewClassName(e.target.value)}
                      className="col-span-2 px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                    <input
                      type="text"
                      placeholder="Nhóm (VD: Khối 10)"
                      value={genNewClassGroup}
                      onChange={(e) => setGenNewClassGroup(e.target.value)}
                      className="px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-700">
                    2. Tên học sinh (Mỗi em 1 dòng)
                  </label>
                  <span className="text-[11px] font-mono text-pink-600 bg-pink-50 px-2 py-0.5 rounded">
                    Mã tiếp theo: {previewNextId}
                  </span>
                </div>
                <textarea
                  rows={3}
                  placeholder="Nguyễn Văn An&#10;Trần Thị Bình"
                  value={genStudentNames}
                  onChange={(e) => setGenStudentNames(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-pink-500 outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={isGenerating}
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition"
              >
                <Wand2 className="w-4 h-4" />
                <span>{isGenerating ? 'Đang tạo...' : 'Generate ID & Mật khẩu ngay'}</span>
              </button>
            </form>

            {generatedCredentials.length > 0 && (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-3">
                <div className="text-xs font-bold text-emerald-900">
                  ✅ Đã lưu lên Supabase! Gửi thông tin dưới đây cho học sinh:
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {generatedCredentials.map((stu) => (
                    <div
                      key={stu.student_code}
                      className="bg-white p-3 rounded-xl border border-emerald-200 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-900">{stu.full_name}</div>
                        <div className="text-xs text-slate-600 mt-0.5 flex items-center gap-3">
                          <span>
                            ID: <strong className="font-mono text-pink-600">{stu.student_code}</strong>
                          </span>
                          <span>
                            PIN: <strong className="font-mono text-emerald-700">{stu.pin_code}</strong>
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyInviteMessage(stu)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-700 text-white text-xs font-semibold shrink-0"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy gửi HS</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Cấu hình Supabase */}
      {showSetupModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 font-bold text-lg">
                <Database className="w-5 h-5 text-pink-600" />
                <span>Kết nối Database Supabase</span>
              </div>
              {supabase && (
                <button onClick={() => setShowSetupModal(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {hasEnvConfig ? (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
                Hệ thống đã kết nối sẵn qua biến môi trường Vercel. Mọi học sinh truy cập link đều tự động đồng bộ!
              </div>
            ) : (
              <form onSubmit={handleSaveConfig} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Supabase Project URL</label>
                  <input
                    type="url"
                    required
                    placeholder="https://xxxxxxx.supabase.co"
                    value={cfgUrl}
                    onChange={(e) => setCfgUrl(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Publishable / Anon Key</label>
                  <input
                    type="text"
                    required
                    value={cfgKey}
                    onChange={(e) => setCfgKey(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2 text-sm font-semibold rounded-xl bg-pink-600 text-white hover:bg-pink-700"
                >
                  Lưu & Kết nối ngay
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* MÀN HÌNH ĐĂNG NHẬP */}
      {role === 'login' && (
        <main className="relative z-10 max-w-md mx-auto px-4 py-10 sm:py-12">
          <div className="bg-white/95 backdrop-blur rounded-3xl border-2 border-pink-200 shadow-xl shadow-pink-200/50 p-6 sm:p-8 overflow-hidden">
            <div className="text-center mb-6 bg-gradient-to-b from-pink-100/80 via-rose-50/40 to-transparent -mx-6 -mt-6 sm:-mx-8 sm:-mt-8 px-6 pt-7 pb-4 border-b border-pink-100">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/90 border border-pink-200 text-[11px] font-bold text-pink-600 mb-3 shadow-xs">
                <span>🌸</span>
                <span>Góc học tập nhỏ xinh</span>
                <span>✨</span>
              </div>
              <div className="w-14 h-14 rounded-3xl bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-500 text-white font-bold text-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-pink-200">
                🎀
              </div>
              <h1 className="text-2xl font-extrabold bg-gradient-to-r from-pink-600 via-rose-500 to-fuchsia-600 bg-clip-text text-transparent">
                Lớp cô Hà
              </h1>
              <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                Chào mừng các em! Nhập Mã ID & Mật khẩu cô Hà đã cấp để vào làm bài & nhận điểm xinh nhé 💖
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1.5 bg-pink-100/70 rounded-2xl mb-6">
              <button
                type="button"
                onClick={() => {
                  setLoginTab('student');
                  setLoginError('');
                }}
                className={`py-2 text-sm font-bold rounded-xl transition ${
                  loginTab === 'student'
                    ? 'bg-white text-pink-600 shadow-sm'
                    : 'text-pink-800/70 hover:text-pink-900'
                }`}
              >
                🎒 Học sinh
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoginTab('teacher');
                  setLoginError('');
                }}
                className={`py-2 text-sm font-bold rounded-xl transition ${
                  loginTab === 'teacher'
                    ? 'bg-white text-pink-600 shadow-sm'
                    : 'text-pink-800/70 hover:text-pink-900'
                }`}
              >
                👩‍🏫 Cô Hà
              </button>
            </div>

            {loginError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
                {loginError}
              </div>
            )}

            {loginTab === 'student' ? (
              <form onSubmit={handleStudentLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mã ID học sinh theo lớp (VD: 10A-01)
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Nhập mã ID của em"
                    value={stuCodeInput}
                    onChange={(e) => setStuCodeInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl uppercase font-mono focus:ring-2 focus:ring-pink-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mật khẩu PIN (4 số)
                  </label>
                  <input
                    type="password"
                    required
                    placeholder="••••"
                    value={stuPinInput}
                    onChange={(e) => setStuPinInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-pink-500 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white font-semibold text-sm shadow-sm transition"
                >
                  Đăng nhập & Đồng bộ lớp học
                </button>
              </form>
            ) : (
              <form onSubmit={handleTeacherLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mật khẩu quản trị Giáo viên
                  </label>
                  <input
                    type="password"
                    required
                    placeholder="Nhập mật khẩu quản trị"
                    value={teacherPassInput}
                    onChange={(e) => setTeacherPassInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-pink-500 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 text-white font-bold text-sm shadow-md shadow-pink-200 transition"
                >
                  Vào Góc Quản Lý Lớp cô Hà 🌸
                </button>
              </form>
            )}

            <div className="mt-6 pt-4 border-t border-pink-100 text-center">
              <p className="text-[11px] font-medium text-pink-700/80 bg-pink-50/80 px-3 py-2 rounded-2xl border border-pink-100">
                🌟 "Mỗi ngày cố gắng một chút xíu, kết quả ngọt ngào sẽ đến với em!"
              </p>
            </div>
          </div>
        </main>
      )}

      {/* CỔNG GIÁO VIÊN */}
      {role === 'teacher' && (
        <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          {/* LỜI CHÚC DÀNH RIÊNG CHO CÔ HÀ */}
          {(() => {
            const hour = new Date().getHours();
            const greeting =
              hour < 11 ? 'Chào buổi sáng' : hour < 14 ? 'Chào buổi trưa' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
            return (
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-pink-500 via-rose-500 to-fuchsia-500 p-4 sm:p-5 text-white shadow-md shadow-pink-200">
                <div className="absolute -right-6 -top-8 text-8xl opacity-20 select-none pointer-events-none">💗</div>
                <div className="relative flex items-center gap-3">
                  <div className="text-3xl sm:text-4xl select-none">🌸</div>
                  <div>
                    <div className="text-xs sm:text-sm font-medium text-pink-50">{greeting} cô Hà ✨</div>
                    <div className="text-base sm:text-xl font-extrabold tracking-tight">
                      Chúc vợ làm việc luôn vui vẻ nha! 💕
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setTeacherTab('overview')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'overview'
                    ? 'bg-pink-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                1. Tổng quan & Báo cáo PH
              </button>
              <button
                onClick={() => setTeacherTab('assignments')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'assignments'
                    ? 'bg-pink-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                2. Bài tập, Vocab & Sổ điểm
              </button>
              <button
                onClick={() => setTeacherTab('students')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'students'
                    ? 'bg-pink-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                3. Lớp học & Học sinh ({students.length})
              </button>
              <button
                onClick={() => setTeacherTab('attendance')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'attendance'
                    ? 'bg-pink-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                4. Điểm danh & Học phí
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-2 rounded-xl cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeInactiveInStats}
                  onChange={(e) => setIncludeInactiveInStats(e.target.checked)}
                  className="rounded text-pink-600"
                />
                <span>Tính cả HS nghỉ học (CV/Lịch sử)</span>
              </label>

              <div className="flex items-center gap-1.5">
                <Filter className="w-4 h-4 text-slate-400" />
                <select
                  value={selectedClassId}
                  onChange={(e) => {
                    setSelectedClassId(e.target.value);
                    setChartStudentFilter('all');
                  }}
                  className="px-3 py-2 text-sm font-medium bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-pink-500"
                >
                  <option value="all">Tất cả các lớp ({classes.length})</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.group_name})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {teacherTab === 'overview' && (
            <>
              {/* KHỐI 1 TRÊN CÙNG: NHẬN XÉT TỔNG QUAN & COPY BÁO CÁO NHANH GỬI PHỤ HUYNH */}
              <div className="bg-gradient-to-br from-pink-100/75 via-white to-rose-50/80 p-5 rounded-3xl border-2 border-pink-200 shadow-sm shadow-pink-100/50 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="font-bold text-pink-950 text-base flex items-center gap-2">
                      <Award className="w-5 h-5 text-pink-600" />
                      <span>Nhận xét tổng quan Lớp cô Hà & Báo cáo nhanh gửi Phụ huynh 🌸</span>
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Tự động tổng hợp theo dữ liệu thực tế (Overview → Nhóm tốt / Nhóm cần kèm → Câu sai nhiều)
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openGradebookForClass(selectedClassId)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold shadow-sm"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>Nhập điểm Vocab / Sổ điểm</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRemindAllUnsubmitted}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold shadow-sm"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>Nhắc tất cả HS chưa nộp</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const textToCopy =
                          customTeacherOverviewNote.trim() ||
                          classFunnelAnalytics.autoOverviewReport;
                        navigator.clipboard.writeText(textToCopy);
                        notify('Đã copy báo cáo tổng quan — Dán (Ctrl+V) gửi nhóm Phụ huynh ngay!');
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-xs font-semibold shadow-sm"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Báo cáo gửi nhóm PH</span>
                    </button>
                  </div>
                </div>

                <textarea
                  rows={5}
                  value={
                    customTeacherOverviewNote !== ''
                      ? customTeacherOverviewNote
                      : classFunnelAnalytics.autoOverviewReport
                  }
                  onChange={(e) => setCustomTeacherOverviewNote(e.target.value)}
                  className="w-full p-3.5 text-xs sm:text-sm bg-white/90 border border-pink-200 rounded-xl text-slate-800 leading-relaxed focus:ring-2 focus:ring-pink-500 outline-none"
                />
                {customTeacherOverviewNote !== '' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setCustomTeacherOverviewNote('')}
                      className="text-[11px] text-pink-600 hover:underline font-semibold"
                    >
                      ↺ Khôi phục nhận xét tự động theo dữ liệu mới nhất
                    </button>
                  </div>
                )}
              </div>

              {/* CẢNH BÁO BÀI NỘP BỊ CHẤM LỆCH SO VỚI ĐÁP ÁN HIỆN TẠI */}
              {regradeCandidates.length > 0 && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-3xl p-4 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className="font-bold text-amber-950 text-sm">
                        ⚠️ Có {regradeCandidates.length} bài nộp đang có điểm khác với đáp án hiện tại của đề
                      </div>
                      <div className="text-xs text-amber-900">
                        Thường do file đáp án trước đây bị đọc sai. Bấm chấm lại để trả điểm đúng — học sinh không cần làm lại.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmDialog({
                          title: `Chấm lại ${regradeCandidates.length} bài nộp?`,
                          message:
                            'Hệ thống chấm lại theo đáp án hiện tại và đáp án các em đã chọn. Điểm mới sẽ cập nhật ngay cho học sinh.',
                          confirmText: 'Chấm lại tất cả',
                          onConfirm: () => applyRegrade(regradeCandidates)
                        })
                      }
                      className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Chấm lại {regradeCandidates.length} bài</span>
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {regradeCandidates.slice(0, 10).map(({ sub, asg, oldScore, newScore }) => {
                      const stu = students.find((x) => x.id === sub.student_id);
                      return (
                        <span key={sub.id} className="px-2 py-0.5 rounded-lg bg-white border border-amber-200 text-amber-900">
                          {stu?.full_name || sub.student_code} • {asg.title}: {oldScore ?? '—'} → <strong>{newScore}</strong>
                        </span>
                      );
                    })}
                    {regradeCandidates.length > 10 && <span>… và {regradeCandidates.length - 10} bài khác</span>}
                  </div>
                </div>
              )}

              {/* KHỐI 2: 4 KPI TỔNG QUAN */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>{includeInactiveInStats ? 'Tổng HS (Cả đã nghỉ)' : 'Sĩ số đang học'}</span>
                    <Users className="w-4 h-4 text-pink-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{teacherKpis.studentCount}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    {teacherKpis.inactiveCount > 0
                      ? `Ngoài ra có ${teacherKpis.inactiveCount} em đã nghỉ học`
                      : '100% đang theo học'}
                  </div>
                </div>

                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Tỷ lệ hoàn thành bài</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-2xl font-bold text-emerald-600">{teacherKpis.submissionRate}</div>
                  <div className="text-xs text-slate-400 mt-1">{filteredSubmissions.length} lượt đã nộp</div>
                </div>

                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Điểm trung bình</span>
                    <TrendingUp className="w-4 h-4 text-pink-600" />
                  </div>
                  <div className="text-2xl font-bold text-pink-600">{teacherKpis.avgScore}</div>
                  <div className="text-xs text-slate-400 mt-1">Gộp Web + Vocab + Chấm tay (thang 10)</div>
                </div>

                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Bài chờ giáo viên chấm</span>
                    <Clock className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-amber-600">{teacherKpis.pendingCount}</div>
                  <div className="text-xs text-slate-400 mt-1">Cập nhật Realtime</div>
                </div>
              </div>

              {/* BÀI CHỜ CHẤM */}
              {pendingReviewSubmissions.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 font-bold text-amber-900 text-sm mb-3">
                    <FileText className="w-4 h-4 text-amber-600" />
                    <span>Bài làm mới cần giáo viên chấm điểm ({pendingReviewSubmissions.length})</span>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {pendingReviewSubmissions.map((sub) => {
                      const stu = students.find((s) => s.id === sub.student_id);
                      const asg = assignments.find((a) => a.id === sub.assignment_id);
                      return (
                        <div
                          key={sub.id}
                          className="bg-white p-3.5 rounded-xl border border-amber-200 flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-slate-900 truncate">
                              {stu?.full_name || sub.student_code} ({sub.student_code})
                            </div>
                            <div className="text-xs text-slate-500 truncate">{asg?.title || 'Bài tập'}</div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => openManualReviewModal(sub)}
                              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                            >
                              Chấm bài
                            </button>
                            <button
                              onClick={() => requestDeleteSubmission(sub, stu?.full_name)}
                              title="Xóa lượt nộp này"
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* KHỐI 3: CLASS DEEP-DIVE (NHÓM TỐT / NHÓM CẦN KÈM / TOP CÂU SAI NHIỀU NHẤT) */}
              <div className="grid lg:grid-cols-3 gap-4">
                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Nhóm học tốt (Điểm TB ≥ 8.0)</span>
                  </h3>
                  {classFunnelAnalytics.topPerformers.length === 0 ? (
                    <p className="text-xs text-slate-400">Chưa có học sinh đạt mức ≥ 8.0</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {classFunnelAnalytics.topPerformers.map((item) => (
                        <div
                          key={item.student.id}
                          className="flex items-center justify-between text-xs bg-emerald-50/70 px-3 py-1.5 rounded-lg"
                        >
                          <span className="font-semibold text-slate-800">
                            {item.student.full_name} ({item.student.student_code})
                          </span>
                          <span className="font-bold text-emerald-700">{item.avgScore}đ</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-rose-700 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Cần kèm thêm / Chưa nộp đủ bài</span>
                  </h3>
                  {classFunnelAnalytics.needSupport.length === 0 ? (
                    <p className="text-xs text-slate-400">Tất cả các em đều đạt yêu cầu!</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {classFunnelAnalytics.needSupport.map((item) => (
                        <div
                          key={item.student.id}
                          className="flex items-center justify-between text-xs bg-rose-50/70 px-3 py-1.5 rounded-lg"
                        >
                          <span className="font-semibold text-slate-800 truncate pr-2">
                            {item.student.full_name}
                          </span>
                          <span className="text-rose-700 font-bold shrink-0">
                            {item.avgScore !== null && item.avgScore < 6.5 ? `${item.avgScore}đ • ` : ''}
                            {item.missingCount > 0 ? `Thiếu ${item.missingCount} bài` : 'Điểm thấp'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-pink-700 flex items-center gap-1.5">
                    <BarChart3 className="w-4 h-4" />
                    <span>Top câu hỏi cả lớp sai nhiều nhất</span>
                  </h3>
                  {classFunnelAnalytics.topMissedQuestions.length === 0 ? (
                    <p className="text-xs text-slate-400">Chưa ghi nhận câu sai nào</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {classFunnelAnalytics.topMissedQuestions.map((q, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between text-xs bg-pink-50/70 px-3 py-1.5 rounded-lg gap-2"
                        >
                          <span className="font-medium text-slate-800 truncate">{q.label}</span>
                          <span className="font-bold text-rose-600 shrink-0">
                            {q.wrongCount}/{q.totalAttempts} sai ({q.wrongRate}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* BIỂU ĐỒ */}
              <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 className="font-bold text-slate-900">Biểu đồ điểm kết quả học tập theo thời gian</h2>
                    <p className="text-xs text-slate-500">
                      Gộp 3 nguồn: Bài web + Vocab hàng tuần + Sổ điểm chấm tay (theo tuần đã gán cho từng cột)
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={chartStudentFilter}
                      onChange={(e) => setChartStudentFilter(e.target.value)}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <option value="all">Trung bình cả lớp</option>
                      {trackedStudentsForStats.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.student_code} — {s.full_name}
                        </option>
                      ))}
                    </select>
                    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
                      <button
                        onClick={() => setChartTimeMode('week')}
                        className={`px-2.5 py-1 rounded-md font-medium ${
                          chartTimeMode === 'week' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        Theo Tuần
                      </button>
                      <button
                        onClick={() => setChartTimeMode('day')}
                        className={`px-2.5 py-1 rounded-md font-medium ${
                          chartTimeMode === 'day' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        Theo Ngày
                      </button>
                    </div>
                  </div>
                </div>

                <TrendLineChart points={teacherChartPoints} />
              </div>

              {/* KHỐI 4: BẢNG INDIVIDUAL DEEP-DIVE TỪNG HỌC SINH */}
              <div className="bg-white rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="font-bold text-slate-900">Theo dõi chi tiết & Báo cáo từng học sinh</h2>
                    <p className="text-xs text-slate-500">
                      Bấm <strong>Copy PH</strong> để dán ngay nhận xét gửi riêng phụ huynh, hoặc <strong>Deep-dive</strong> để xem từng bài & sửa điểm
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Mã ID</th>
                        <th className="py-3 px-4">Họ và tên</th>
                        <th className="py-3 px-4">Trạng thái</th>
                        <th className="py-3 px-4">Đã nộp</th>
                        <th className="py-3 px-4">Điểm TB (Web • Vocab • Chấm tay)</th>
                        <th className="py-3 px-4">Phần đang yếu</th>
                        <th className="py-3 px-4 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {classStudentsAll.map((stu) => {
                        const mySubs = submissions.filter((s) => s.student_id === stu.id);
                        const unified = unifiedScoresByStudent[stu.id];
                        const avg = unified && unified.avg !== null ? unified.avg.toFixed(1) : '—';
                        const weakSet = new Set();
                        mySubs.forEach((s) => (s.weak_topics || []).forEach((w) => weakSet.add(w)));
                        const weakArr = Array.from(weakSet);

                        const meta = studentMetaMap[stu.id] || { status: 'active', note: '' };
                        const isInactive = meta.status === 'inactive';

                        return (
                          <tr
                            key={stu.id}
                            className={`transition ${
                              isInactive ? 'bg-slate-50/60 opacity-75' : 'hover:bg-slate-50/80'
                            }`}
                          >
                            <td className="py-3 px-4">
                              <span className="font-mono font-bold text-pink-600 text-xs bg-pink-50 px-2 py-1 rounded">
                                {stu.student_code}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">{stu.full_name}</div>
                              <div className="text-[11px] text-slate-400">{stu.class_name}</div>
                            </td>
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingStudentStatus(stu);
                                  setStuStatusDraft(meta.status || 'active');
                                  setStuNoteDraft(meta.note || '');
                                }}
                                title="Bấm để đổi trạng thái Đang học / Nghỉ học"
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                  isInactive
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                }`}
                              >
                                <span>{isInactive ? 'Nghỉ học' : 'Đang học'}</span>
                                <Edit3 className="w-2.5 h-2.5" />
                              </button>
                              {meta.note && (
                                <div className="text-[11px] text-slate-500 mt-0.5 max-w-[140px] truncate">
                                  {meta.note}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-xs font-medium">
                              <div>{mySubs.length} bài</div>
                              {(() => {
                                const pd = classMeta.practice[stu.id];
                                const runCount = Object.values(pd?.runs || {}).reduce(
                                  (n, list) => n + (Array.isArray(list) ? list.length : 0),
                                  0
                                );
                                const nbPending = computeNotebookEntries(assignments, mySubs, pd?.notebook || {}).filter(
                                  (e) => !e.mastered
                                ).length;
                                return (
                                  <div className="text-[10px] text-violet-700 mt-0.5 whitespace-nowrap">
                                    Luyện {runCount} lượt • Sổ tay còn {nbPending} câu
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                  avg === '—'
                                    ? 'bg-slate-100 text-slate-500'
                                    : Number(avg) >= 8
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : Number(avg) >= 6.5
                                    ? 'bg-pink-50 text-pink-700'
                                    : 'bg-rose-50 text-rose-700'
                                }`}
                              >
                                {avg}
                              </span>
                              <div className="text-[10px] text-slate-500 mt-1 whitespace-nowrap">
                                {formatSourceBreakdown(unified)}
                              </div>
                              {unified && unified.missingManual.length > 0 && (
                                <div className="text-[10px] font-semibold text-rose-600 mt-0.5">
                                  Chưa nộp: {unified.missingManual.length} bài
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              {weakArr.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {weakArr.map((w) => (
                                    <span
                                      key={w}
                                      className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-[11px] font-medium"
                                    >
                                      {w}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-xs text-slate-400">Chưa ghi nhận</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                              <button
                                onClick={() => {
                                  const rep = buildIndividualStudentReport(stu);
                                  navigator.clipboard.writeText(rep.parentMessage);
                                  notify(`Đã copy báo cáo nhận xét gửi Phụ huynh em ${stu.full_name}!`);
                                }}
                                title="Copy tin nhắn báo cáo gửi Phụ huynh (Ctrl+V)"
                                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
                              >
                                Copy PH
                              </button>
                              <button
                                onClick={() => handleSendReminder(stu)}
                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200"
                              >
                                Nhắc
                              </button>
                              <button
                                onClick={() => {
                                  setDeepDiveStudent(stu);
                                  setRemTopic(weakArr[0] || '');
                                  setRemTitle(
                                    weakArr[0] ? `Ôn tập bổ trợ: ${weakArr[0]}` : 'Bài luyện tập củng cố'
                                  );
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-pink-600 hover:bg-pink-700"
                              >
                                Deep-dive
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* TAB 2: TẠO ĐỀ TỪ WORD / PDF & PHÂN TÍCH ĐỀ */}
          {teacherTab === 'assignments' && (
            <div className="grid lg:grid-cols-12 gap-6">
              <form
                onSubmit={handleCreateAssignment}
                className="lg:col-span-7 bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-5 h-fit"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div>
                    <h2 className="font-bold text-slate-900 flex items-center gap-2">
                      <FileUp className="w-5 h-5 text-pink-600" />
                      <span>Tải file Word (.docx) hoặc PDF (.pdf) thành đề tương tác</span>
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Tự nhận diện trắc nghiệm A/B/C/D, điền đáp án / tự luận & cả đoạn văn bài đọc dài
                    </p>
                  </div>
                </div>

                <div>
                  <label className="flex flex-col items-center justify-center p-5 border-2 border-dashed border-pink-300 rounded-2xl bg-pink-50/40 hover:bg-pink-50 cursor-pointer transition text-center">
                    <Upload className="w-7 h-7 text-pink-600 mb-1.5" />
                    <span className="text-sm font-bold text-pink-900">
                      {isParsingFile
                        ? 'Đang đọc và bóc tách từng câu hỏi từ file...'
                        : sourceFile
                        ? `Đã chọn: ${sourceFile.name}`
                        : 'Bấm để chọn file Đề bài (.DOCX Word, .PDF hoặc .TXT)'}
                    </span>
                    <span className="text-xs text-slate-500 mt-1">
                      Giữ nguyên trình tự đề gốc • Tự tách bài đọc hiểu chung cho nhóm câu hỏi
                    </span>
                    <input
                      type="file"
                      accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={handleTeacherFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Tên bài tập *</label>
                    <input
                      type="text"
                      required
                      placeholder="VD: Mini Test Unit 4"
                      value={asgTitle}
                      onChange={(e) => setAsgTitle(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Giao cho lớp</label>
                    <select
                      value={asgClassId}
                      onChange={(e) => setAsgClassId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                    >
                      <option value="">Tất cả các lớp</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Tuần học</label>
                    <input
                      type="number"
                      min="1"
                      value={asgWeek}
                      onChange={(e) => setAsgWeek(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Chuyên đề</label>
                    <input
                      type="text"
                      placeholder="VD: Tiếng Anh"
                      value={asgTopic}
                      onChange={(e) => setAsgTopic(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Hạn nộp</label>
                    <input
                      type="date"
                      value={asgDueDate}
                      onChange={(e) => setAsgDueDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Thời gian làm bài
                    </label>
                    <select
                      value={asgTimePreset}
                      onChange={(e) => setAsgTimePreset(e.target.value)}
                      className="w-full px-2.5 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                    >
                      <option value="0">Không giới hạn</option>
                      <option value="15">15 phút</option>
                      <option value="30">30 phút</option>
                      <option value="45">45 phút</option>
                      <option value="60">60 phút</option>
                      <option value="custom">Tự nhập số phút...</option>
                    </select>
                  </div>
                </div>

                {asgTimePreset === 'custom' && (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-pink-50/70 border border-pink-200">
                    <Timer className="w-4 h-4 text-pink-600 shrink-0" />
                    <label className="text-xs font-semibold text-pink-950">
                      Nhập số phút làm bài tùy chọn:
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="300"
                      value={asgCustomMinutes}
                      onChange={(e) => setAsgCustomMinutes(e.target.value)}
                      className="w-24 px-3 py-1.5 text-sm font-bold bg-white border border-pink-300 rounded-lg"
                    />
                    <span className="text-xs text-slate-600">phút (Hết giờ tự động thu bài)</span>
                  </div>
                )}

                {/* CHỌN LOẠI BÀI & CHẾ ĐỘ LUYỆN TẬP / KIỂM TRA */}
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-pink-50/80 via-rose-50/60 to-fuchsia-50/50 border border-pink-200/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-800">
                      Chế độ giao bài cho học sinh
                    </label>
                    <span className="text-[11px] text-pink-700 font-medium">
                      {asgType === 'homework'
                        ? 'Làm 1 lần • Xem đáp án ngay'
                        : asgType === 'practice'
                        ? 'Làm lại nhiều lần • Lấy điểm cao nhất'
                        : 'Thi nghiêm túc 1 lần • Đảo câu hỏi'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setAsgType('homework')}
                      className={`p-2.5 rounded-xl border text-left transition ${
                        asgType === 'homework'
                          ? 'bg-white border-pink-500 ring-2 ring-pink-200 shadow-xs'
                          : 'bg-white/70 border-slate-200 hover:bg-white'
                      }`}
                    >
                      <div className="text-xs font-bold text-slate-900">📚 Bài về nhà</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">Nộp 1 lần chuẩn</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setAsgType('practice')}
                      className={`p-2.5 rounded-xl border text-left transition ${
                        asgType === 'practice'
                          ? 'bg-white border-emerald-500 ring-2 ring-emerald-200 shadow-xs'
                          : 'bg-white/70 border-slate-200 hover:bg-white'
                      }`}
                    >
                      <div className="text-xs font-bold text-emerald-800">🔄 Luyện tập</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">Cho làm nhiều lần</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setAsgType('exam')}
                      className={`p-2.5 rounded-xl border text-left transition ${
                        asgType === 'exam'
                          ? 'bg-white border-amber-500 ring-2 ring-amber-200 shadow-xs'
                          : 'bg-white/70 border-slate-200 hover:bg-white'
                      }`}
                    >
                      <div className="text-xs font-bold text-amber-800">📝 Kiểm tra</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">Đảo đề • Thi 1 lần</div>
                    </button>
                  </div>

                  {asgType === 'practice' && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-pink-200/60">
                      <span className="text-xs font-semibold text-emerald-900 flex items-center gap-1.5">
                        <RotateCcw className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Số lần làm bài tối đa cho mỗi học sinh:</span>
                      </span>
                      <select
                        value={asgMaxAttempts}
                        onChange={(e) => setAsgMaxAttempts(e.target.value)}
                        className="px-3 py-1.5 text-xs font-bold bg-white border border-emerald-300 rounded-lg text-emerald-900"
                      >
                        <option value="2">Tối đa 2 lần</option>
                        <option value="3">Tối đa 3 lần</option>
                        <option value="5">Tối đa 5 lần</option>
                        <option value="0">Không giới hạn số lần</option>
                      </select>
                    </div>
                  )}

                  {asgType === 'exam' && (
                    <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-pink-200/60 text-xs">
                      <label className="inline-flex items-center gap-2 font-semibold text-amber-950 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={asgShuffleQuestions}
                          onChange={(e) => setAsgShuffleQuestions(e.target.checked)}
                          className="rounded border-amber-400 text-pink-600 focus:ring-pink-500"
                        />
                        <Shuffle className="w-3.5 h-3.5 text-amber-600" />
                        <span>Đảo thứ tự câu hỏi mỗi học sinh</span>
                      </label>

                      <label className="inline-flex items-center gap-2 font-semibold text-amber-950 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={asgHideAnswersOnExam}
                          onChange={(e) => setAsgHideAnswersOnExam(e.target.checked)}
                          className="rounded border-amber-400 text-pink-600 focus:ring-pink-500"
                        />
                        <Lock className="w-3.5 h-3.5 text-amber-600" />
                        <span>Khóa đáp án sau khi nộp (GV mở sau)</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* BẢNG XEM TRƯỚC & CHỐT ĐÁP ÁN TỪNG CÂU */}
                {parsedQuestions.length > 0 && (
                  <div className="space-y-3 border-t border-slate-200 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">
                          Bộ câu hỏi đã xuất sang Web ({parsedQuestions.length} câu)
                        </h3>
                        <p className="text-[11px] text-slate-500">
                          Có đáp án → Tự động chấm • Để trống đáp án → Giáo viên tự chấm
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isExplainingAi}
                          onClick={handleAiGenerateExplanationsForDraft}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold hover:bg-emerald-100"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>
                            {isExplainingAi ? 'AI đang giải...' : 'AI tạo đáp án & giải thích'}
                          </span>
                        </button>
                        {rawExtractedText && (
                          <button
                            type="button"
                            onClick={handleAiParseQuestions}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-50 text-purple-700 border border-purple-200 text-xs font-semibold hover:bg-purple-100"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>Quét lại AI</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleAddManualQuestion}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Thêm câu</span>
                        </button>
                      </div>
                    </div>

                    {showAiKeyInput && (
                      <div className="p-3 rounded-xl bg-purple-50 border border-purple-200 flex items-center gap-2">
                        <input
                          type="password"
                          placeholder="Dán Gemini API Key (AIzaSy...)"
                          value={geminiApiKey}
                          onChange={(e) => setGeminiApiKey(e.target.value)}
                          className="flex-1 px-3 py-1.5 text-xs bg-white border border-purple-200 rounded-lg"
                        />
                        <button
                          type="button"
                          onClick={handleAiGenerateExplanationsForDraft}
                          className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-semibold"
                        >
                          Lưu & Chạy AI
                        </button>
                      </div>
                    )}

                    <div className="max-h-[460px] overflow-y-auto space-y-3 pr-1">
                      {parsedQuestions.map((q, idx) => (
                        <div
                          key={q.id}
                          className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 rounded bg-pink-600 text-white font-bold text-xs">
                                Câu {idx + 1}
                              </span>
                              <select
                                value={q.type === 'mcq' ? 'mcq' : 'open'}
                                onChange={(e) =>
                                  updateParsedQuestion(idx, {
                                    type: e.target.value,
                                    correctAnswer: ''
                                  })
                                }
                                className="px-2 py-1 text-xs bg-white border border-slate-300 rounded-lg font-medium"
                              >
                                <option value="mcq">Trắc nghiệm (A/B/C/D)</option>
                                <option value="open">Điền đáp án / Tự luận</option>
                              </select>
                            </div>

                            <div className="flex items-center gap-2">
                              {q.correctAnswer ? (
                                <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                  Tự chấm: {q.correctAnswer}
                                </span>
                              ) : (
                                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                                  GV chấm tay
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setParsedQuestions((prev) => prev.filter((_, i) => i !== idx))
                                }
                                className="text-slate-400 hover:text-rose-600 p-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {(q.keyIssue || (q.type === 'mcq' && !hasGradableKey(q))) && (
                            <div className="px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-[11px] font-semibold text-amber-900">
                              ⚠️ {q.keyIssue || 'Chưa có đáp án A–D — bấm chữ cái bên dưới để chọn, nếu không câu này sẽ chờ GV chấm tay'}
                            </div>
                          )}

                          {q.passage && (
                            <div className="p-2 rounded-lg bg-pink-50/70 border border-pink-200 text-[11px] text-pink-950">
                              <span className="font-bold">📖 Bài đọc chung: </span>
                              <span className="line-clamp-2">{q.passage}</span>
                            </div>
                          )}

                          <textarea
                            rows={2}
                            value={q.text}
                            onChange={(e) => updateParsedQuestion(idx, { text: e.target.value })}
                            placeholder="Nội dung câu hỏi..."
                            className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                          />

                          {q.type === 'mcq' ? (
                            <div className="grid sm:grid-cols-2 gap-2">
                              {['A', 'B', 'C', 'D'].map((opt) => {
                                const isSelected = q.correctAnswer === opt;
                                return (
                                  <div
                                    key={opt}
                                    className={`flex items-center gap-1.5 p-1.5 rounded-lg border ${
                                      isSelected
                                        ? 'bg-emerald-50 border-emerald-400'
                                        : 'bg-white border-slate-200'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateParsedQuestion(idx, {
                                          correctAnswer: isSelected ? '' : opt
                                        })
                                      }
                                      title="Bấm để chọn làm đáp án đúng"
                                      className={`w-6 h-6 rounded-md text-xs font-bold shrink-0 transition ${
                                        isSelected
                                          ? 'bg-emerald-600 text-white'
                                          : 'bg-slate-100 text-slate-700 hover:bg-pink-100'
                                      }`}
                                    >
                                      {opt}
                                    </button>
                                    <input
                                      type="text"
                                      value={q.options?.[opt] || ''}
                                      onChange={(e) =>
                                        updateParsedQuestion(idx, {
                                          options: { ...q.options, [opt]: e.target.value }
                                        })
                                      }
                                      placeholder={`Phương án ${opt}`}
                                      className="w-full text-xs bg-transparent outline-none"
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={q.correctAnswer || ''}
                              onChange={(e) =>
                                updateParsedQuestion(idx, { correctAnswer: e.target.value })
                              }
                              placeholder="Nhập đáp án chuẩn để tự động chấm (Hoặc để trống nếu giáo viên tự chấm tay)..."
                              className="w-full px-3 py-1.5 text-xs bg-white border border-emerald-300 rounded-lg"
                            />
                          )}

                          <input
                            type="text"
                            value={q.explanation || ''}
                            onChange={(e) =>
                              updateParsedQuestion(idx, { explanation: e.target.value })
                            }
                            placeholder="💡 Giải thích đáp án (Hiện tự động cho học sinh xem khi làm sai câu này)..."
                            className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-600"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {parsedQuestions.length === 0 && (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Hoặc nhập nhanh chuỗi đáp án chuẩn (nếu không tải file)
                      </label>
                      <input
                        type="text"
                        placeholder="VD: 1:A, 2:B, 3:C, 4:D (Để trống nếu muốn chấm thủ công)"
                        value={asgAnswerKey}
                        onChange={(e) => setAsgAnswerKey(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Hướng dẫn / Đề bài tóm tắt
                      </label>
                      <textarea
                        rows={2}
                        placeholder="Dặn dò học sinh cách làm..."
                        value={asgRubric}
                        onChange={(e) => setAsgRubric(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                  </>
                )}

                {(() => {
                  const keyIssues = parsedQuestions
                    .map((q, i) => ({ q, i }))
                    .filter(({ q }) => q.keyIssue || (q.type === 'mcq' && !hasGradableKey(q)));
                  if (parsedQuestions.length === 0 || keyIssues.length === 0) return null;
                  return (
                    <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 space-y-1">
                      <div className="font-bold">
                        ⚠️ {keyIssues.length}/{parsedQuestions.length} câu cần kiểm tra đáp án trước khi đăng
                      </div>
                      <div className="text-[11px]">
                        Câu không có đáp án hợp lệ sẽ chuyển sang chờ giáo viên chấm tay (không bao giờ bị chấm Sai oan).
                      </div>
                      <ul className="list-disc pl-4 text-[11px] max-h-28 overflow-y-auto">
                        {keyIssues.slice(0, 12).map(({ q, i }) => (
                          <li key={q.id || i}>
                            Câu {i + 1}: {q.keyIssue || 'Chưa có đáp án A–D'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}

                <button
                  type="submit"
                  disabled={isPublishingAsg}
                  className="w-full py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white font-semibold text-sm shadow-sm transition"
                >
                  {isPublishingAsg
                    ? 'Đang xuất bản lên hệ thống...'
                    : parsedQuestions.length > 0
                    ? `Đăng bộ đề ${parsedQuestions.length} câu hỏi lên Web`
                    : 'Đăng bài lên hệ thống'}
                </button>
              </form>

              {/* DANH SÁCH ĐỀ ĐÃ GIAO */}
              <div className="lg:col-span-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-slate-900">
                    Danh sách bài tập đã giao ({assignments.length})
                  </h2>
                </div>
                {assignments.map((a) => {
                  const qList = getAssignmentQuestions(a);
                  const meta = getAssignmentMeta(a);
                  const subCount = submissions.filter((s) => s.assignment_id === a.id).length;
                  const hasKeys =
                    Boolean(a.answer_key_text) || qList.some((q) => Boolean(q.correctAnswer));
                  return (
                    <div
                      key={a.id}
                      className="bg-white p-4 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 flex flex-col justify-between gap-2.5"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {a.is_remedial ? (
                              <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[11px] font-bold">
                                Ôn bổ trợ riêng
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-md bg-pink-50 text-pink-700 text-[11px] font-bold">
                                Tuần {a.week_number}
                              </span>
                            )}
                            <span className="text-xs text-slate-500">{a.class_name}</span>
                            {meta.assignmentType === 'practice' && (
                              <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
                                🔄 Luyện tập ({meta.maxAttempts === 0 ? '∞ lượt' : `${meta.maxAttempts} lượt`})
                              </span>
                            )}
                            {meta.assignmentType === 'exam' && (
                              <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-bold">
                                📝 Kiểm tra{meta.shuffleQuestions ? ' • Đảo đề' : ''}
                              </span>
                            )}
                            {meta.timeLimitMinutes > 0 && (
                              <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 text-[11px] font-bold">
                                ⏱ {meta.timeLimitMinutes}p
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => requestDeleteAssignment(a)}
                            title="Xóa bài tập này"
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <h3 className="font-bold text-slate-900 mt-1.5">{a.title}</h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Chuyên đề: <strong>{a.topic || 'Tổng hợp'}</strong> • Hạn: {a.due_date || 'Mở'} •{' '}
                          <strong className="text-pink-600">{subCount} bài nộp</strong>
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
                        {hasKeys ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-medium">
                            <Check className="w-3.5 h-3.5" /> Tự chấm
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-700 font-medium">
                            GV chấm
                          </span>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5">
                          {meta.assignmentType === 'exam' && (
                            <button
                              type="button"
                              onClick={() => handleToggleExamAnswerLock(a)}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg font-semibold border transition ${
                                meta.hideAnswersUntilGraded
                                  ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                              }`}
                              title="Bấm để mở hoặc khóa đáp án cho học sinh"
                            >
                              {meta.hideAnswersUntilGraded ? (
                                <>
                                  <Lock className="w-3 h-3" />
                                  <span>Mở đáp án</span>
                                </>
                              ) : (
                                <>
                                  <Unlock className="w-3 h-3" />
                                  <span>Đang mở ĐA</span>
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setAnalyticsAssignment(a)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-pink-600 hover:bg-pink-700 text-white font-semibold"
                          >
                            <BarChart3 className="w-3.5 h-3.5" />
                            <span>Top câu sai & Bài nộp</span>
                          </button>
                          {subCount > 0 && (
                            <button
                              type="button"
                              onClick={() => requestRegradeAssignment(a)}
                              title="Chấm lại toàn bộ bài nộp theo đáp án hiện tại"
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>Chấm lại</span>
                            </button>
                          )}

                          {(a.source_file_url || a.answer_key_url) && (
                            <a
                              href={a.source_file_url || a.answer_key_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-pink-600 hover:underline font-semibold"
                            >
                              <span>Đề gốc</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2 (tiếp): SỔ ĐIỂM VOCAB HÀNG TUẦN & SỔ ĐIỂM CHẤM TAY ĐA CỘT */}
          {teacherTab === 'assignments' &&
            (() => {
              const gbClassId =
                gradebookClassId || (selectedClassId !== 'all' ? selectedClassId : classes[0]?.id || '');
              const gbClass = classes.find((c) => c.id === gbClassId) || null;
              const gbStudents = gbClass
                ? students
                    .filter(
                      (s) =>
                        s.class_id === gbClass.id &&
                        (includeInactiveInStats || (studentMetaMap[s.id]?.status || 'active') === 'active')
                    )
                    .sort((a, b) => String(a.student_code).localeCompare(String(b.student_code)))
                : [];
              return (
                <div className="space-y-6">
                  <div
                    id="sc-vocab-grid"
                    className="scroll-mt-6 bg-gradient-to-r from-violet-50 via-white to-sky-50 p-4 rounded-3xl border border-violet-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <h2 className="font-bold text-slate-900">📒 Sổ điểm lớp: Vocab hàng tuần & Chấm tay</h2>
                      <p className="text-xs text-slate-500">
                        Điểm nhập ở đây tự động gộp vào Điểm TB, biểu đồ và tin nhắn báo cáo Phụ huynh ở Tab 1.
                      </p>
                    </div>
                    <select
                      value={gbClassId}
                      onChange={(e) => setGradebookClassId(e.target.value)}
                      className="px-3 py-2 text-sm font-semibold bg-white border border-slate-200 rounded-xl"
                    >
                      {classes.length === 0 && <option value="">Chưa có lớp</option>}
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <ScoreGridSection
                    kind="vocab"
                    anchorId="sc-vocab-table"
                    title="Điểm Từ vựng (Vocab) hàng tuần"
                    subtitle="Mỗi cột là một tuần — đổi tên cột trực tiếp trên tiêu đề."
                    classObj={gbClass}
                    gridStudents={gbStudents}
                    data={gbClass ? classMeta.vocab[gbClass.id] : null}
                    onUpdate={(updater) => gbClass && updateClassMeta('vocab', gbClass.id, updater)}
                    allowMissing={false}
                    setConfirmDialog={setConfirmDialog}
                  />

                  <ScoreGridSection
                    kind="manual"
                    anchorId="sc-manual-grid"
                    title="Sổ điểm chấm tay đa cột"
                    subtitle="VD: KT 15p Unit 1, Phiếu đọc hiểu số 2... Chọn tuần để điểm lên biểu đồ Tab 1."
                    classObj={gbClass}
                    gridStudents={gbStudents}
                    data={gbClass ? classMeta.manual[gbClass.id] : null}
                    onUpdate={(updater) => gbClass && updateClassMeta('manual', gbClass.id, updater)}
                    allowMissing
                    setConfirmDialog={setConfirmDialog}
                  />
                </div>
              );
            })()}

          {/* TAB 4: ĐIỂM DANH & HỌC PHÍ + XUẤT PHIẾU VIETQR */}
          {teacherTab === 'attendance' && (
            <AttendanceTuitionPanel
              classes={classes}
              students={students}
              studentMetaMap={studentMetaMap}
              classCfgMap={classMeta.classCfg}
              attendanceMap={classMeta.attendance}
              onUpdateAttendance={(clsId, updater) => updateClassMeta('attendance', clsId, updater)}
              includeInactive={includeInactiveInStats}
              defaultClassId={selectedClassId}
              setConfirmDialog={setConfirmDialog}
              notify={notify}
              onOpenReceipt={setReceiptPreview}
            />
          )}

          {/* TAB 3: HỌC PHÍ & LỊCH HỌC CỐ ĐỊNH THEO LỚP */}
          {teacherTab === 'students' && (
            <ClassBillingSettingsCard
              classes={classes}
              classCfgMap={classMeta.classCfg}
              onUpdateClassCfg={(clsId, updater) => updateClassMeta('classCfg', clsId, updater)}
            />
          )}

          {/* TAB 3: QUẢN LÝ ID LỚP & TRẠNG THÁI HỌC SINH */}
          {teacherTab === 'students' && (
            <div className="grid lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40 space-y-4 h-fit">
                <h2 className="font-bold text-slate-900 flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-emerald-600" />
                  <span>Generate tự động ID & PIN theo lớp</span>
                </h2>

                <form onSubmit={handleGenerateStudentCredentials} className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-bold text-slate-700">1. Chọn lớp hoặc tạo lớp mới</label>
                      <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setGenClassMode('existing')}
                          className={`px-2 py-0.5 rounded-md font-semibold ${
                            genClassMode === 'existing' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                          }`}
                        >
                          Chọn lớp
                        </button>
                        <button
                          type="button"
                          onClick={() => setGenClassMode('new')}
                          className={`px-2 py-0.5 rounded-md font-semibold ${
                            genClassMode === 'new' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-600'
                          }`}
                        >
                          + Lớp mới
                        </button>
                      </div>
                    </div>

                    {genClassMode === 'existing' && classes.length > 0 ? (
                      <select
                        value={genSelectedClassId}
                        onChange={(e) => setGenSelectedClassId(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                      >
                        {classes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.group_name})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          required
                          placeholder="Tên lớp (VD: 10A1)"
                          value={genNewClassName}
                          onChange={(e) => setGenNewClassName(e.target.value)}
                          className="col-span-2 px-3 py-2 text-sm border border-slate-300 rounded-xl"
                        />
                        <input
                          type="text"
                          placeholder="Khối"
                          value={genNewClassGroup}
                          onChange={(e) => setGenNewClassGroup(e.target.value)}
                          className="px-3 py-2 text-sm border border-slate-300 rounded-xl"
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-bold text-slate-700">2. Nhập tên học sinh</label>
                      <span className="text-[11px] font-mono bg-pink-50 text-pink-700 px-2 py-0.5 rounded">
                        Dự kiến: {previewNextId}
                      </span>
                    </div>
                    <textarea
                      rows={3}
                      placeholder="Nguyễn Văn An&#10;Lê Thị Bình"
                      value={genStudentNames}
                      onChange={(e) => setGenStudentNames(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isGenerating}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    <Wand2 className="w-4 h-4" />
                    <span>{isGenerating ? 'Đang tạo...' : 'Generate ID & Mật khẩu'}</span>
                  </button>
                </form>

                <div className="pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={requestClearAllTestData}
                    className="w-full py-2 rounded-xl border border-rose-200 bg-rose-50/70 hover:bg-rose-100 text-rose-700 text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Dọn sạch toàn bộ bài tập & bài nộp test</span>
                  </button>
                </div>
              </div>

              <div className="lg:col-span-3 bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                <h2 className="font-bold text-slate-900 mb-3">
                  Danh sách học sinh ({students.length}) — Bấm trạng thái để đổi Đang học / Nghỉ học
                </h2>
                <div className="max-h-[480px] overflow-y-auto divide-y divide-slate-100">
                  {students.map((s) => {
                    const meta = studentMetaMap[s.id] || { status: 'active', note: '' };
                    const isInactive = meta.status === 'inactive';
                    return (
                      <div
                        key={s.id}
                        className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <span className="font-mono font-bold text-pink-600 bg-pink-50 px-2 py-0.5 rounded mr-2">
                            {s.student_code}
                          </span>
                          <span className="font-semibold text-slate-900">{s.full_name}</span>
                          <span className="text-slate-400 ml-2">({s.class_name})</span>
                          {meta.note && (
                            <span className="ml-2 text-[11px] text-amber-700 italic">• {meta.note}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <label
                            className="inline-flex items-center gap-1 text-slate-600"
                            title="Đơn giá riêng / buổi (VNĐ) — để trống = dùng đơn giá chuẩn của lớp"
                          >
                            <span>Giá riêng</span>
                            <input
                              key={`cp-${s.id}-${meta.customPrice || 0}`}
                              type="number"
                              min="0"
                              step="1000"
                              defaultValue={meta.customPrice || ''}
                              placeholder="Chuẩn lớp"
                              onBlur={(e) => handleSaveStudentCustomPrice(s, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                              }}
                              className={`w-24 px-2 py-1 rounded-lg border text-xs font-semibold ${
                                meta.customPrice ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-slate-200 bg-white'
                              }`}
                            />
                          </label>
                          <span className="text-slate-600">
                            PIN: <strong className="font-mono text-slate-900">{s.pin_code}</strong>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingStudentStatus(s);
                              setStuStatusDraft(meta.status || 'active');
                              setStuNoteDraft(meta.note || '');
                            }}
                            className={`px-2 py-1 rounded-lg font-bold border ${
                              isInactive
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            }`}
                          >
                            {isInactive ? 'Nghỉ học' : 'Đang học'}
                          </button>
                          <button
                            onClick={() => copyInviteMessage(s)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-pink-50 hover:text-pink-600 text-slate-700 font-medium"
                          >
                            <Copy className="w-3 h-3" />
                            <span>Copy</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => requestDeleteStudent(s)}
                            title="Xóa tài khoản học sinh test"
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* MODAL PHIẾU BÁO HỌC PHÍ .PNG + VIETQR */}
      {receiptPreview && (
        <TuitionReceiptModal receipt={receiptPreview} onClose={() => setReceiptPreview(null)} notify={notify} />
      )}

      {/* MODAL PHÂN TÍCH ĐỀ THI & TOP CÂU SAI NHIỀU NHẤT + DANH SÁCH BÀI NỘP */}
      {analyticsAssignment && assignmentAnalyticsData && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-5">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-pink-600" />
                  <span>Phân tích đề: {analyticsAssignment.title}</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Tổng số lượt nộp: <strong>{assignmentAnalyticsData.asgSubs.length}</strong> • Điểm trung bình:{' '}
                  <strong className="text-pink-600">{assignmentAnalyticsData.avgScore}/10</strong>
                </p>
              </div>
              <button
                onClick={() => setAnalyticsAssignment(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* TOP CÂU SAI NHIỀU NHẤT */}
            <div className="space-y-2.5">
              <h3 className="text-sm font-bold text-rose-700 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                <span>Top những câu hỏi nhiều học sinh sai nhất (Ưu tiên chữa trên lớp)</span>
              </h3>
              {assignmentAnalyticsData.topMissed.length === 0 ? (
                <div className="p-4 rounded-xl bg-slate-50 text-xs text-slate-500">
                  Chưa có dữ liệu câu sai trên đề này.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {assignmentAnalyticsData.topMissed.map((q) => (
                    <div
                      key={q.number}
                      className="p-3 rounded-xl bg-rose-50/60 border border-rose-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div className="space-y-0.5 flex-1">
                        <div className="font-bold text-slate-900">
                          Câu {q.number}: {q.text}
                        </div>
                        <div className="text-slate-600">
                          Đáp án đúng: <strong className="text-emerald-700">{q.correctAnswer || 'GV chấm'}</strong>
                          {q.mostCommonWrong && (
                            <span className="ml-3 text-rose-700">
                              • Lỗi phổ biến nhất: Chọn <strong>"{q.mostCommonWrong[0]}"</strong> ({q.mostCommonWrong[1]} em)
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold shrink-0">
                        Sai {q.wrongCount}/{q.attempts} ({q.wrongRate}%)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* DANH SÁCH TẤT CẢ BÀI NỘP CỦA ĐỀ NÀY (XEM / SỬA ĐIỂM / XÓA) */}
            <div className="space-y-2.5">
              <h3 className="text-sm font-bold text-slate-900">
                Danh sách học sinh đã nộp đề này ({assignmentAnalyticsData.asgSubs.length})
              </h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                {assignmentAnalyticsData.asgSubs.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400">Chưa có học sinh nào nộp bài này.</div>
                ) : (
                  assignmentAnalyticsData.asgSubs.map((sub) => {
                    const stu = students.find((s) => s.id === sub.student_id);
                    return (
                      <div
                        key={sub.id}
                        className="p-3 bg-white flex items-center justify-between gap-3 text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-900">
                            {stu?.full_name || sub.student_code}
                          </span>
                          <span className="text-slate-400 ml-2">({sub.student_code})</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-pink-600">
                            {sub.score !== null ? `${sub.score}/10đ` : 'Chờ chấm'}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setAnalyticsAssignment(null);
                              openManualReviewModal(sub);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-pink-50 text-pink-700 hover:bg-pink-100 font-semibold"
                          >
                            Xem & Sửa điểm
                          </button>
                          <button
                            type="button"
                            onClick={() => requestDeleteSubmission(sub, stu?.full_name)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DEEP-DIVE HỌC SINH */}
      {deepDiveStudent && deepDiveData && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-5">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-lg bg-pink-50 text-pink-700 font-mono font-bold text-xs">
                    {deepDiveStudent.student_code}
                  </span>
                  <h2 className="text-lg font-bold text-slate-900">{deepDiveStudent.full_name}</h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">{deepDiveStudent.class_name}</p>
              </div>
              <button
                onClick={() => setDeepDiveStudent(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* NHẬN XÉT TỰ ĐỘNG GỬI RIÊNG PHỤ HUYNH */}
            <div className="p-4 rounded-xl bg-emerald-50/80 border border-emerald-200 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-900">
                  Nhận xét chi tiết tự động (Gửi Phụ huynh em {deepDiveStudent.full_name})
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(deepDiveData.parentMessage);
                    notify(`Đã copy báo cáo của ${deepDiveStudent.full_name} để dán gửi Phụ huynh!`);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy gửi Phụ huynh</span>
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-xs text-slate-800 bg-white p-3 rounded-xl border border-emerald-200 leading-relaxed">
                {deepDiveData.parentMessage}
              </pre>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Biểu đồ phong độ cá nhân
              </h3>
              <TrendLineChart points={deepDiveData.trend} color="#4f46e5" />
            </div>

            {/* LỊCH SỬ BÀI ĐÃ NỘP (CÓ NÚT XEM/SỬA ĐIỂM & XÓA) */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Lịch sử bài đã nộp ({deepDiveData.submissions.length})
              </h3>
              {deepDiveData.submissions.map((sub) => {
                const asg = assignments.find((a) => a.id === sub.assignment_id);
                return (
                  <div
                    key={sub.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-bold text-slate-900">{asg?.title || 'Bài tập'}</div>
                      <div className="text-slate-500 mt-0.5">
                        Điểm: <strong className="text-pink-600">{sub.score ?? 'Chờ chấm'}</strong>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDeepDiveStudent(null);
                          openManualReviewModal(sub);
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-pink-600 text-white font-semibold"
                      >
                        Xem & Sửa điểm
                      </button>
                      <button
                        type="button"
                        onClick={() => requestDeleteSubmission(sub, deepDiveStudent.full_name)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-rose-50/70 border border-rose-200 space-y-2">
                <h3 className="text-sm font-bold text-rose-900 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                  <span>Chuyên đề đang yếu / Hay sai</span>
                </h3>
                {deepDiveData.weakList.length === 0 ? (
                  <p className="text-xs text-slate-600">Chưa phát hiện chuyên đề yếu nào.</p>
                ) : (
                  <div className="space-y-1.5">
                    {deepDiveData.weakList.map(([topic, count]) => (
                      <div
                        key={topic}
                        className="flex items-center justify-between bg-white px-3 py-2 rounded-lg text-xs border border-rose-100"
                      >
                        <span className="font-semibold text-slate-800">{topic}</span>
                        <span className="text-rose-600 font-bold">Sai {count} lần</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <form
                onSubmit={handleAssignRemedial}
                className="p-4 rounded-xl bg-pink-50/70 border border-pink-200 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-pink-950">
                    Giao bài ôn bổ trợ riêng cho em
                  </h3>
                  {deepDiveData.wrongQuestionsPool.length > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 text-[11px] font-bold">
                      Gom được {deepDiveData.wrongQuestionsPool.length} câu sai
                    </span>
                  )}
                </div>

                {/* DANH SÁCH TỰ ĐỘNG GOM TOÀN BỘ CÂU HỌC SINH TỪNG LÀM SAI */}
                {deepDiveData.wrongQuestionsPool.length > 0 ? (
                  <div className="space-y-2 bg-white p-3 rounded-xl border border-pink-200">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-slate-700">
                        Chọn câu sai giao làm lại ({selectedWrongUids.length}/{deepDiveData.wrongQuestionsPool.length} câu):
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const allUids = deepDiveData.wrongQuestionsPool.map((q) => q.uid);
                            setSelectedWrongUids(allUids);
                            setRemTitle(
                              `Luyện lại ${allUids.length} câu đã sai — ${deepDiveStudent.full_name}`
                            );
                          }}
                          className="text-pink-600 font-semibold hover:underline"
                        >
                          Chọn tất cả
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedWrongUids([])}
                          className="text-slate-400 hover:text-slate-600"
                        >
                          Bỏ chọn
                        </button>
                      </div>
                    </div>

                    <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
                      {deepDiveData.wrongQuestionsPool.map((wq) => {
                        const checked = selectedWrongUids.includes(wq.uid);
                        return (
                          <label
                            key={wq.uid}
                            className={`flex items-start gap-2 p-2 rounded-lg border text-[11px] cursor-pointer transition ${
                              checked
                                ? 'bg-pink-50/70 border-pink-300'
                                : 'bg-slate-50 border-slate-200 opacity-75'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...selectedWrongUids, wq.uid]
                                  : selectedWrongUids.filter((id) => id !== wq.uid);
                                setSelectedWrongUids(next);
                                if (next.length > 0) {
                                  setRemTitle(
                                    `Luyện lại ${next.length} câu đã sai — ${deepDiveStudent.full_name}`
                                  );
                                }
                              }}
                              className="mt-0.5 rounded text-pink-600 shrink-0"
                            />
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="font-bold text-pink-700">
                                  [{wq.sourceAssignmentTitle} - Câu {wq.sourceQuestionNumber}]
                                </span>
                                {wq.passage && (
                                  <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 font-semibold">
                                    📖 Kèm bài đọc
                                  </span>
                                )}
                                {wq.isAlreadyFixed && (
                                  <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-700 font-semibold">
                                    ✓ Đã sửa đúng
                                  </span>
                                )}
                              </div>
                              <div className="text-slate-800 line-clamp-2">{wq.text}</div>
                              <div className="text-slate-500">
                                Em chọn: <span className="text-rose-600 font-semibold">{wq.previousAnswer}</span>
                                {wq.correctAnswer && (
                                  <>
                                    {' '}• Đúng: <span className="text-emerald-700 font-semibold">{wq.correctAnswer}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-lg bg-white/80 border border-pink-100 text-[11px] text-slate-600">
                    Chưa có câu sai nào được ghi nhận từ các bài trước. Anh có thể đính kèm file Word/PDF bên dưới để giao đề ôn riêng cho em.
                  </div>
                )}

                <input
                  type="text"
                  required
                  placeholder="Tên bài ôn bổ trợ"
                  value={remTitle}
                  onChange={(e) => setRemTitle(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-pink-200 rounded-lg"
                />

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Chuyên đề (VD: Luyện câu sai)"
                    value={remTopic}
                    onChange={(e) => setRemTopic(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-white border border-pink-200 rounded-lg"
                  />
                  <label className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border border-dashed border-pink-300 hover:bg-pink-50 cursor-pointer text-[11px] font-semibold text-pink-700 truncate">
                    <FileUp className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {remSourceFile ? remSourceFile.name : '+ Đính kèm Word/PDF'}
                    </span>
                    <input
                      type="file"
                      accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={(e) => setRemSourceFile(e.target.files?.[0] || null)}
                      className="hidden"
                    />
                  </label>
                </div>

                {remSourceFile && (
                  <div className="flex items-center justify-between px-2.5 py-1 rounded-lg bg-white border border-pink-200 text-[11px] text-slate-700">
                    <span className="truncate">📎 File đính kèm: {remSourceFile.name}</span>
                    <button
                      type="button"
                      onClick={() => setRemSourceFile(null)}
                      className="text-rose-600 font-bold ml-2 shrink-0"
                    >
                      Gỡ
                    </button>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isAssigningRemedial}
                  className="w-full py-2.5 rounded-lg bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white text-xs font-bold shadow-sm transition"
                >
                  {isAssigningRemedial
                    ? 'Đang giao bài...'
                    : selectedWrongUids.length > 0
                    ? `Giao bài luyện lại ${selectedWrongUids.length} câu đã sai`
                    : `Giao bài ôn riêng cho ${deepDiveStudent.full_name}`}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* MODAL GIÁO VIÊN CHẤM BÀI & SỬA ĐIỂM */}
      {reviewingSubmission && (() => {
        const targetAsg = assignments.find((a) => a.id === reviewingSubmission.assignment_id);
        const asgQuestions = getAssignmentQuestions(targetAsg);
        const ansMap =
          reviewingSubmission.answers_json ||
          reviewingSubmission.ai_feedback_json?.studentAnswersMap ||
          {};
        const correctTickedCount = Object.values(gradeQuestionMarks).filter(
          (v) => v === 'correct'
        ).length;
        const wrongTickedCount = Object.values(gradeQuestionMarks).filter(
          (v) => v === 'wrong'
        ).length;

        return (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
            <form
              onSubmit={handleSaveManualGrade}
              className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="font-bold text-slate-900">
                    Chấm bài & Sửa điểm: {reviewingSubmission.student_code}
                  </h3>
                  <p className="text-xs text-slate-500">{targetAsg?.title}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => requestDeleteSubmission(reviewingSubmission)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xóa lượt nộp</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setReviewingSubmission(null)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {reviewingSubmission.file_url && (
                <a
                  href={reviewingSubmission.file_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 rounded-xl bg-pink-50 border border-pink-200 text-pink-700 text-xs font-semibold hover:bg-pink-100"
                >
                  <span>Mở file PDF đính kèm: {reviewingSubmission.file_name || 'Xem PDF'}</span>
                  <Eye className="w-4 h-4" />
                </a>
              )}

              {asgQuestions.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-100 p-2.5 rounded-xl">
                    <div className="text-xs font-bold text-slate-700">
                      Tick Đúng / Sai từng câu ({correctTickedCount} Đúng • {wrongTickedCount} Sai / {asgQuestions.length} câu):
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleMarkAllQuestions(asgQuestions, 'correct')}
                        className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold"
                      >
                        ✓ Tick tất cả Đúng
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setGradeQuestionMarks({});
                          setGradeQuestionNotes({});
                        }}
                        className="px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 text-[11px] font-semibold"
                      >
                        Bỏ tick
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
                    {asgQuestions.map((q, idx) => {
                      const qKey = String(q.number);
                      const stuVal = ansMap[qKey] || '(Học sinh bỏ trống)';
                      const mark = gradeQuestionMarks[qKey];
                      const chosenOptionText =
                        q.type === 'mcq' && q.options?.[stuVal] ? ` (${q.options[stuVal]})` : '';

                      return (
                        <div
                          key={q.id || idx}
                          className={`p-3 rounded-xl border text-xs space-y-2 transition ${
                            mark === 'correct'
                              ? 'bg-emerald-50/70 border-emerald-300'
                              : mark === 'wrong'
                              ? 'bg-rose-50/70 border-rose-300'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1 flex-1">
                              <div className="font-bold text-slate-900">
                                Câu {q.number}: {q.text}
                              </div>
                              <div className="text-pink-700 font-semibold">
                                → Học sinh chọn/trả lời: <span className="underline">{stuVal}</span>
                                <span className="font-normal text-slate-600">{chosenOptionText}</span>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  handleToggleQuestionMark(qKey, 'correct', asgQuestions.length)
                                }
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-bold text-xs border transition ${
                                  mark === 'correct'
                                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                    : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
                                }`}
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>Đúng</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleToggleQuestionMark(qKey, 'wrong', asgQuestions.length)
                                }
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-bold text-xs border transition ${
                                  mark === 'wrong'
                                    ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                                    : 'bg-white text-rose-700 border-rose-300 hover:bg-rose-50'
                                }`}
                              >
                                <X className="w-3.5 h-3.5" />
                                <span>Sai</span>
                              </button>
                            </div>
                          </div>

                          {mark === 'wrong' && (
                            <div className="pt-1">
                              <input
                                type="text"
                                placeholder="Ghi chú đáp án đúng & giải thích cho học sinh xem..."
                                value={gradeQuestionNotes[qKey] || ''}
                                onChange={(e) =>
                                  setGradeQuestionNotes((prev) => ({
                                    ...prev,
                                    [qKey]: e.target.value
                                  }))
                                }
                                className="w-full px-2.5 py-1.5 text-xs bg-white border border-rose-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-rose-500"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                reviewingSubmission.answer_text && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                    <span className="font-semibold text-slate-600">Nội dung học sinh nộp: </span>
                    <span>{reviewingSubmission.answer_text}</span>
                  </div>
                )
              )}

              <div className="grid sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Điểm tổng (0 - 10) *
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="10"
                    required
                    value={gradeScore}
                    onChange={(e) => setGradeScore(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-bold text-pink-700 border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Chuyên đề học sinh còn yếu
                  </label>
                  <input
                    type="text"
                    placeholder="VD: Reported speech"
                    value={gradeWeakTopic}
                    onChange={(e) => setGradeWeakTopic(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nhận xét tổng quát gửi trả học sinh
                </label>
                <textarea
                  rows={2}
                  placeholder="Nhận xét chi tiết gửi trả học sinh..."
                  value={gradeComment}
                  onChange={(e) => setGradeComment(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm shadow-sm"
              >
                Lưu điểm ({gradeScore}/10) & Gửi trả từng câu Đúng/Sai cho học sinh
              </button>
            </form>
          </div>
        );
      })()}

      {/* CỔNG HỌC SINH */}
      {role === 'student' && currentStudent && studentPortalData && (
        <main className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          {(() => {
            const allTasks = [...studentPortalData.remedialTasks, ...studentPortalData.classTasks];
            const todoCount = allTasks.filter((t) => !studentPortalData.subByAsg[t.id]).length;
            const nbPending = computeNotebookEntries(
              assignments,
              studentPortalData.mySubs,
              classMeta.practice[currentStudent.id]?.notebook || {}
            ).filter((e) => !e.mastered).length;
            const avg = studentPortalData.avgScore;
            const cheer =
              avg !== '—' && Number(avg) >= 8
                ? '🏆 Ong chăm chỉ xuất sắc — giữ vững phong độ nhé!'
                : avg !== '—' && Number(avg) >= 6.5
                ? '🌷 Em đang tiến bộ từng ngày!'
                : '✨ Cố lên nào, cô Hà luôn đồng hành cùng em!';
            const tabs = [
              { id: 'tasks', icon: '✏️', label: 'Bài tập', count: todoCount },
              { id: 'progress', icon: '🌟', label: 'Kết quả' },
              { id: 'library', icon: '📚', label: 'Kho đề ôn tập' },
              { id: 'notebook', icon: '📒', label: 'Sổ tay câu sai', count: nbPending },
              { id: 'tuition', icon: '📅', label: 'Điểm danh & Học phí' }
            ];
            const stats = [
              { label: 'Điểm TB', value: avg === '—' ? '—' : avg, tab: 'progress' },
              { label: 'Bài cần làm', value: todoCount, tab: 'tasks' },
              { label: 'Câu cần ôn', value: nbPending, tab: 'notebook' }
            ];
            return (
              <>
                <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-500 text-white p-5 sm:p-7 shadow-lg shadow-pink-200/70">
                  <div className="absolute -top-16 -right-10 w-56 h-56 rounded-full bg-white/10 pointer-events-none" />
                  <div className="absolute -bottom-20 left-1/3 w-64 h-64 rounded-full bg-white/10 pointer-events-none" />
                  <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-5">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white/20 ring-1 ring-white/40 text-3xl flex items-center justify-center shrink-0">
                        🎒
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] sm:text-xs font-semibold text-pink-50">
                          <span className="px-2 py-0.5 rounded-lg bg-white/20 font-mono">{currentStudent.student_code}</span>
                          <span>Lớp {currentStudent.class_name}</span>
                        </div>
                        <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight mt-1 truncate">
                          Chào {currentStudent.full_name} 🌸
                        </h1>
                        <p className="text-xs sm:text-sm text-pink-50 mt-0.5">{cheer}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 sm:gap-3 md:min-w-[360px]">
                      {stats.map((st) => (
                        <button
                          key={st.label}
                          type="button"
                          onClick={() => setStudentTab(st.tab)}
                          className="rounded-2xl bg-white/15 hover:bg-white/25 ring-1 ring-white/25 px-3 py-2.5 text-center transition"
                        >
                          <div className="text-xl sm:text-2xl font-extrabold leading-tight">{st.value}</div>
                          <div className="text-[10px] sm:text-[11px] font-semibold text-pink-50">{st.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <nav className="sticky top-2 z-30 bg-white/90 backdrop-blur-md border border-pink-100 rounded-2xl p-1.5 shadow-sm flex gap-1 overflow-x-auto">
                  {tabs.map((t) => {
                    const active = studentTab === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setStudentTab(t.id)}
                        className={`flex-1 min-w-max inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
                          active
                            ? 'bg-gradient-to-r from-pink-500 to-rose-500 text-white shadow-sm shadow-pink-200'
                            : 'text-slate-600 hover:bg-pink-50 hover:text-pink-700'
                        }`}
                      >
                        <span>{t.icon}</span>
                        <span>{t.label}</span>
                        {t.count > 0 && (
                          <span
                            className={`min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center ${
                              active ? 'bg-white/25 text-white' : 'bg-rose-500 text-white'
                            }`}
                          >
                            {t.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </>
            );
          })()}

          {/* CẢNH BÁO HẠN NỘP SẮP ĐẾN / QUÁ HẠN */}
          {studentTab === 'tasks' && studentPortalData.urgentTasks.length > 0 && (
            <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-rose-900">
                <Clock className="w-4 h-4 text-rose-600" />
                <span>Cảnh báo hạn nộp bài tập ({studentPortalData.urgentTasks.length} bài cần hoàn thành gấp)</span>
              </div>
              {studentPortalData.urgentTasks.map((t) => {
                const info = getDeadlineBadgeInfo(t.due_date);
                return (
                  <div key={t.id} className="text-xs text-rose-800 flex items-center justify-between">
                    <span>• <strong>{t.title}</strong> — {info?.label}</span>
                    <button
                      type="button"
                      onClick={() => handleOpenStudentAssignment(t)}
                      className="text-rose-700 font-bold underline hover:text-rose-900"
                    >
                      Làm ngay →
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* THÔNG BÁO NHẮC NHỞ TỪ GIÁO VIÊN */}
          {studentTab === 'tasks' && studentPortalData.myAnnouncements.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                <Bell className="w-4 h-4 text-amber-600" />
                <span>Nhắc nhở từ giáo viên ({studentPortalData.myAnnouncements.length})</span>
              </div>
              {studentPortalData.myAnnouncements.slice(0, 4).map((ann) => (
                <div
                  key={ann.id}
                  className="flex items-center justify-between gap-3 bg-white/80 px-3 py-2 rounded-xl text-xs text-amber-900"
                >
                  <span>• {ann.message}</span>
                  <button
                    type="button"
                    onClick={() => handleDismissAnnouncement(ann.id)}
                    className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold shrink-0"
                  >
                    Đã hiểu
                  </button>
                </div>
              ))}
            </div>
          )}

          {studentTab === 'library' ? (
            <PracticeLibraryView
              key={`lib-${currentStudent.id}`}
              student={currentStudent}
              assignments={assignments}
              subByAsg={studentPortalData.subByAsg}
              practiceData={classMeta.practice[currentStudent.id]}
              onUpdatePractice={(updater) => updateClassMeta('practice', currentStudent.id, updater)}
            />
          ) : studentTab === 'notebook' ? (
            <MistakeNotebookView
              key={`nb-${currentStudent.id}`}
              student={currentStudent}
              assignments={assignments}
              mySubs={studentPortalData.mySubs}
              practiceData={classMeta.practice[currentStudent.id]}
              onUpdatePractice={(updater) => updateClassMeta('practice', currentStudent.id, updater)}
            />
          ) : studentTab === 'tuition' ? (
            <StudentTuitionView
              student={currentStudent}
              classObj={classes.find((c) => c.id === currentStudent.class_id) || null}
              classCfg={classMeta.classCfg[currentStudent.class_id] || {}}
              attendanceData={classMeta.attendance[currentStudent.class_id]}
              studentMeta={studentMetaMap[currentStudent.id]}
              notify={notify}
            />
          ) : studentTab === 'tasks' ? (
            <div className="space-y-6">
              {studentPortalData.remedialTasks.length > 0 && (
                <div className="space-y-3">
                  <h2 className="text-sm font-bold text-rose-700 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Bài tập ôn bổ trợ riêng giáo viên giao cho em</span>
                  </h2>
                  <div className="grid sm:grid-cols-2 gap-4">
                    {studentPortalData.remedialTasks.map((task) => {
                      const sub = studentPortalData.subByAsg[task.id];
                      const deadlineInfo = !sub ? getDeadlineBadgeInfo(task.due_date) : null;
                      return (
                        <div
                          key={task.id}
                          className="bg-white p-4 rounded-2xl border-2 border-rose-200 shadow-sm flex flex-col justify-between gap-3"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[11px] font-bold">
                                Ôn phần yếu: {task.topic}
                              </span>
                              {deadlineInfo && (
                                <span
                                  className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${deadlineInfo.badgeClass}`}
                                >
                                  {deadlineInfo.label}
                                </span>
                              )}
                            </div>
                            <h3 className="font-bold text-slate-900 mt-1.5">{task.title}</h3>
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                            {sub ? (
                              <span className="text-xs font-bold text-emerald-600">
                                {sub.score !== null ? `Đã chấm: ${sub.score}/10` : 'Đã nộp (Chờ chấm)'}
                              </span>
                            ) : (
                              <span className="text-xs text-rose-600 font-medium">Chưa nộp</span>
                            )}
                            <button
                              onClick={() => handleOpenStudentAssignment(task)}
                              className={`px-3 py-1.5 rounded-xl text-white text-xs font-semibold ${
                                sub
                                  ? 'bg-emerald-600 hover:bg-emerald-700'
                                  : 'bg-rose-600 hover:bg-rose-700'
                              }`}
                            >
                              {sub ? 'Xem bài & Đáp án' : 'Làm bài ngay'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {[
                {
                  key: 'todo',
                  title: '📝 Cần làm',
                  list: studentPortalData.classTasks
                    .filter((t) => !studentPortalData.subByAsg[t.id])
                    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))),
                  empty: 'Em đã làm hết bài được giao rồi, giỏi quá! 🎉'
                },
                {
                  key: 'done',
                  title: '✅ Đã hoàn thành',
                  list: studentPortalData.classTasks.filter((t) => studentPortalData.subByAsg[t.id]),
                  empty: 'Chưa có bài nào hoàn thành.'
                }
              ].map((group) => (
              <div key={group.key} className="space-y-3">
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <span>{group.title}</span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px]">{group.list.length}</span>
                </h2>
                {group.list.length === 0 ? (
                  <div className="p-5 rounded-2xl bg-white/70 border border-dashed border-slate-200 text-center text-xs text-slate-400">
                    {group.empty}
                  </div>
                ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {group.list.map((task) => {
                    const sub = studentPortalData.subByAsg[task.id];
                    const qList = getAssignmentQuestions(task);
                    const meta = getAssignmentMeta(task);
                    const attemptCount = Number(sub?.ai_feedback_json?.attemptCount) || (sub ? 1 : 0);
                    const canRetryMore =
                      Boolean(sub) &&
                      meta.assignmentType === 'practice' &&
                      (meta.maxAttempts === 0 || attemptCount < meta.maxAttempts);
                    const deadlineInfo = !sub ? getDeadlineBadgeInfo(task.due_date) : null;
                    const hasDraft =
                      (!sub || canRetryMore) &&
                      Boolean(
                        localStorage.getItem(`sc_draft_${currentStudent.student_code}_${task.id}`)
                      );

                    const accent = sub
                      ? sub.score !== null && sub.score !== undefined
                        ? 'bg-emerald-400'
                        : 'bg-sky-400'
                      : deadlineInfo && deadlineInfo.diffDays < 0
                      ? 'bg-rose-500'
                      : deadlineInfo?.urgent
                      ? 'bg-amber-400'
                      : 'bg-pink-400';

                    return (
                      <div
                        key={task.id}
                        className="relative overflow-hidden bg-white p-4 pl-5 rounded-3xl border border-pink-100 shadow-sm shadow-pink-100/40 hover:shadow-md hover:-translate-y-0.5 transition flex flex-col justify-between gap-3"
                      >
                        <div className={`absolute left-0 top-4 bottom-4 w-1.5 rounded-r-full ${accent}`} />
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="px-2 py-0.5 rounded-md bg-pink-50 text-pink-700 font-bold">
                                Tuần {task.week_number}
                              </span>
                              {meta.assignmentType === 'practice' && (
                                <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                                  🔄 Luyện tập ({meta.maxAttempts === 0 ? `Đã làm ${attemptCount} lần` : `${attemptCount}/${meta.maxAttempts} lượt`})
                                </span>
                              )}
                              {meta.assignmentType === 'exam' && (
                                <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                                  📝 Kiểm tra
                                </span>
                              )}
                              {meta.timeLimitMinutes > 0 && (
                                <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 font-bold">
                                  ⏱ {meta.timeLimitMinutes} phút
                                </span>
                              )}
                            </div>
                            {deadlineInfo && (
                              <span
                                className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${deadlineInfo.badgeClass}`}
                              >
                                {deadlineInfo.label}
                              </span>
                            )}
                          </div>
                          <h3 className="font-bold text-slate-900 mt-2">{task.title}</h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Chuyên đề: {task.topic || 'Tổng hợp'}
                            {qList.length > 0 && ` • ${qList.length} câu hỏi trực tuyến`}
                          </p>
                          {hasDraft && (
                            <div className="mt-1.5 text-[11px] font-semibold text-pink-600">
                              💾 Đang lưu dở bài làm (Bấm vào để làm tiếp)
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                          {sub ? (
                            <span className="text-xs font-bold text-emerald-600">
                              {sub.score !== null
                                ? `${attemptCount > 1 ? 'Điểm cao nhất' : 'Điểm'}: ${sub.score}/10`
                                : 'Đã nộp (Chờ giáo viên chấm)'}
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 font-medium">Chưa nộp bài</span>
                          )}
                          <div className="flex items-center gap-1.5">
                            {canRetryMore && (
                              <button
                                type="button"
                                onClick={() => handleOpenStudentAssignment(task, true)}
                                className="px-3 py-1.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-xs font-semibold flex items-center gap-1 shadow-xs"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Làm lại (Lần {attemptCount + 1})</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleOpenStudentAssignment(task, false)}
                              className={`px-3.5 py-1.5 rounded-xl text-white text-xs font-semibold flex items-center gap-1.5 ${
                                sub
                                  ? 'bg-emerald-600 hover:bg-emerald-700'
                                  : 'bg-pink-600 hover:bg-pink-700'
                              }`}
                            >
                              <BookOpen className="w-3.5 h-3.5" />
                              <span>{sub ? (canRetryMore ? 'Xem lại' : 'Xem lại bài & Đáp án') : hasDraft ? 'Làm tiếp bài' : 'Làm bài ngay'}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <StudentGradebookView
                student={currentStudent}
                unified={unifiedScoresByStudent[currentStudent.id]}
                vocabData={classMeta.vocab[currentStudent.class_id]}
                manualData={classMeta.manual[currentStudent.class_id]}
                mySubs={studentPortalData.mySubs}
                assignments={assignments}
              />
              <div className="bg-white p-5 rounded-3xl border border-pink-200/80 shadow-sm shadow-pink-100/40">
                <h2 className="font-bold text-slate-900 mb-1">Biểu đồ phong độ học tập của em</h2>
                <p className="text-xs text-slate-500 mb-4">Theo dõi sự tiến bộ qua từng bài tập</p>
                <TrendLineChart points={studentPortalData.trend} color="#ec4899" />
              </div>

              <div className="space-y-3">
                <h2 className="font-bold text-slate-900 text-sm">Chi tiết điểm, câu Đúng / Sai & Giải thích</h2>
                {studentPortalData.mySubs.map((sub) => {
                  const asg = assignments.find((a) => a.id === sub.assignment_id);
                  const asgMeta = getAssignmentMeta(asg);
                  const hideAnswers =
                    asgMeta.assignmentType === 'exam' && asgMeta.hideAnswersUntilGraded;
                  const fb = sub.ai_feedback_json || {};
                  const breakdown = Array.isArray(fb.breakdown) ? fb.breakdown : [];

                  return (
                    <div key={sub.id} className="bg-white p-4 rounded-2xl border border-slate-200 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-bold text-sm text-slate-900">{asg?.title || 'Bài tập'}</div>
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-0.5 rounded-full bg-pink-50 text-pink-700 font-bold text-xs">
                            {sub.score !== null ? `${sub.score}/10 điểm` : 'Chờ giáo viên chấm'}
                          </span>
                          {asg && (
                            <button
                              type="button"
                              onClick={() => handleOpenStudentAssignment(asg)}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-pink-50 text-pink-700 text-xs font-semibold"
                            >
                              Mở đề & Giải thích
                            </button>
                          )}
                        </div>
                      </div>

                      {fb.summary && (
                        <p className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-100">
                          {fb.summary}
                        </p>
                      )}

                      {!hideAnswers && breakdown.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[11px] font-bold text-slate-600">
                            Kết quả chi tiết từng câu:
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {breakdown.map((item, idx) => (
                              <span
                                key={idx}
                                title={
                                  item.status === 'correct'
                                    ? `Câu ${item.question}: Đúng (${item.actual})`
                                    : `Câu ${item.question}: Sai — Em chọn "${item.actual}"${
                                        item.expected ? ` (Đúng: ${item.expected})` : ''
                                      }`
                                }
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border ${
                                  item.status === 'correct'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-rose-50 text-rose-700 border-rose-200'
                                }`}
                              >
                                <span>Câu {item.question}</span>
                                {item.status === 'correct' ? (
                                  <Check className="w-3 h-3" />
                                ) : (
                                  <X className="w-3 h-3" />
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {!hideAnswers && Array.isArray(fb.wrongDetails) && fb.wrongDetails.length > 0 && (
                        <div className="p-3 rounded-xl bg-rose-50 text-xs text-rose-800 space-y-1.5">
                          <div className="font-bold">Chi tiết các câu sai & Giải thích:</div>
                          {fb.wrongDetails.map((line, i) => (
                            <div key={i} className="leading-relaxed">• {line}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      )}

      {/* MODAL HỌC SINH LÀM BÀI (LUYỆN TẬP NHIỀU LẦN / KIỂM TRA ĐẢO ĐỀ / AUTO-SAVE / TIMER / XEM ĐÁP ÁN) */}
      {submittingAsg && (() => {
        const rawQList = getAssignmentQuestions(submittingAsg);
        const asgMeta = getAssignmentMeta(submittingAsg);
        const qList = getOrderedQuestionsForStudent(
          rawQList,
          currentStudent?.student_code,
          submittingAsg.id,
          asgMeta.shuffleQuestions
        );
        const cleanRubric = getCleanRubricText(submittingAsg);
        const existingSub = studentPortalData?.subByAsg?.[submittingAsg.id];
        const attemptCount = Number(existingSub?.ai_feedback_json?.attemptCount) || (existingSub ? 1 : 0);
        const attemptHistory = Array.isArray(existingSub?.ai_feedback_json?.attemptHistory)
          ? existingSub.ai_feedback_json.attemptHistory
          : [];
        const canRetryMore =
          Boolean(existingSub) &&
          asgMeta.assignmentType === 'practice' &&
          (asgMeta.maxAttempts === 0 || attemptCount < asgMeta.maxAttempts);
        const isLockedReview = Boolean(existingSub) && !isRetryingPractice;
        const hideAnswers =
          isLockedReview &&
          asgMeta.assignmentType === 'exam' &&
          asgMeta.hideAnswersUntilGraded;
        const breakdownMap = {};
        (existingSub?.ai_feedback_json?.breakdown || []).forEach((b) => {
          breakdownMap[String(b.question)] = b;
        });

        const answeredCount = qList.filter(
          (q) => Boolean(stuInteractiveAnswers[String(q.number)]?.trim())
        ).length;
        const unansweredList = qList.filter(
          (q) => !String(stuInteractiveAnswers[String(q.number)] || '').trim()
        );
        // Live correctness for review (MCQ re-checked against the cleaned key)
        const getLiveStatus = (q) => {
          const k = String(q.number);
          if (q.type === 'mcq' && hasGradableKey(q)) {
            return isAnswerCorrect(q, stuInteractiveAnswers[k]) ? 'correct' : 'wrong';
          }
          return breakdownMap[k]?.status || null;
        };
        const wrongInReview = isLockedReview
          ? qList.filter((q) => getLiveStatus(q) === 'wrong').length
          : 0;
        const scrollToQuestion = (k) =>
          document.getElementById(`sc-q-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

        return (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!isLockedReview) setShowSubmitConfirm(true);
              }}
              onKeyDown={(e) => {
                // Enter inside a text box must never submit the test
                if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
              }}
              className="bg-white rounded-2xl max-w-3xl lg:max-w-5xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col gap-4"
            >
              <div className="flex items-start justify-between border-b border-slate-100 pb-3 shrink-0 gap-2">
                <div>
                  <h3 className="font-bold text-base sm:text-lg text-slate-900">
                    {submittingAsg.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 mt-1">
                    <span>Chuyên đề: {submittingAsg.topic || 'Tổng hợp'}</span>
                    {qList.length > 0 && (
                      <span className="font-bold text-pink-600">
                        {isLockedReview
                          ? `Điểm đạt được: ${
                              existingSub.score !== null ? `${existingSub.score}/10` : 'Chờ GV chấm'
                            }`
                          : `Đã chọn: ${answeredCount}/${qList.length} câu`}
                      </span>
                    )}
                    {(submittingAsg.source_file_url || submittingAsg.answer_key_url) && (
                      <a
                        href={submittingAsg.source_file_url || submittingAsg.answer_key_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-pink-600 font-semibold hover:underline"
                      >
                        <span>File đề gốc</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isLockedReview && remainingSeconds !== null && (
                    <div
                      className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold flex items-center gap-1.5 border ${
                        remainingSeconds <= 60
                          ? 'bg-rose-600 text-white border-rose-600 animate-pulse'
                          : 'bg-amber-50 text-amber-800 border-amber-300'
                      }`}
                    >
                      <Timer className="w-3.5 h-3.5" />
                      <span>{formatSecondsMMSS(remainingSeconds)}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSubmittingAsg(null);
                      setIsRetryingPractice(false);
                      setRemainingSeconds(null);
                    }}
                    className="text-slate-400 hover:text-slate-600 p-1"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {isLockedReview ? (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-2 shrink-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-bold">
                      {canRetryMore
                        ? `🔄 Chế độ luyện tập: Em đã hoàn thành ${attemptCount}/${asgMeta.maxAttempts === 0 ? '∞' : asgMeta.maxAttempts} lượt làm bài.`
                        : '🔒 Bài làm đã nộp & khóa chỉnh sửa.'}
                    </div>
                    {canRetryMore && (
                      <button
                        type="button"
                        onClick={() => handleOpenStudentAssignment(submittingAsg, true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-700 text-white font-bold shadow-xs"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Làm lại bài này (Lần {attemptCount + 1})</span>
                      </button>
                    )}
                  </div>
                  {existingSub.ai_feedback_json?.summary && (
                    <div>{existingSub.ai_feedback_json.summary}</div>
                  )}
                  {attemptHistory.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-emerald-200/70">
                      <span className="font-bold text-emerald-800">Lịch sử điểm:</span>
                      {attemptHistory.map((h, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 rounded bg-white border border-emerald-200 font-semibold text-emerald-800"
                        >
                          Lần {h.attempt}: {h.score !== null && h.score !== undefined ? `${h.score}đ` : 'Chờ chấm'}
                        </span>
                      ))}
                    </div>
                  )}
                  {hideAnswers && (
                    <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 font-medium">
                      ⏳ Đề kiểm tra đang khóa đáp án chi tiết. Giáo viên sẽ mở đáp án sau khi cả lớp thi xong!
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {isRetryingPractice && (
                    <div className="px-3.5 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 font-semibold shrink-0 flex items-center justify-between">
                      <span>🔄 Đang làm lại lượt {attemptCount + 1} — Hệ thống sẽ ghi nhận điểm cao nhất của em!</span>
                      <button
                        type="button"
                        onClick={() => handleOpenStudentAssignment(submittingAsg, false)}
                        className="underline text-emerald-700 hover:text-emerald-900 ml-2"
                      >
                        Quay lại xem bài cũ
                      </button>
                    </div>
                  )}
                  {asgMeta.shuffleQuestions && !isRetryingPractice && (
                    <div className="px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 font-medium shrink-0">
                      🔀 Đề kiểm tra đã được đảo thứ tự câu hỏi riêng cho em. Chúc em làm bài thật tốt!
                    </div>
                  )}
                  {draftRestoredBanner && (
                    <div className="px-3.5 py-2 rounded-xl bg-pink-50 border border-pink-200 text-xs text-pink-800 font-medium shrink-0">
                      💾 Đã tự động khôi phục các câu em đã chọn trước đó!
                    </div>
                  )}
                </>
              )}

              {qList.length > 1 && (
                <div className="shrink-0 space-y-2">
                  {!isLockedReview && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-pink-500 to-rose-500 transition-all"
                          style={{ width: `${Math.round((answeredCount / qList.length) * 100)}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">
                        {answeredCount}/{qList.length} câu
                      </span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    {qList.map((q) => {
                      const k = String(q.number);
                      const answered = Boolean(String(stuInteractiveAnswers[k] || '').trim());
                      const live = isLockedReview && !hideAnswers ? getLiveStatus(q) : null;
                      const chip =
                        live === 'correct'
                          ? 'bg-emerald-500 text-white border-emerald-500'
                          : live === 'wrong'
                          ? 'bg-rose-500 text-white border-rose-500'
                          : answered
                          ? 'bg-pink-600 text-white border-pink-600'
                          : 'bg-white text-slate-500 border-dashed border-slate-300';
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setReviewWrongOnly(false);
                            setTimeout(() => scrollToQuestion(k), 30);
                          }}
                          title={`Đi tới câu ${q.number}`}
                          className={`min-w-[30px] h-7 px-1 rounded-md border text-[11px] font-bold ${chip}`}
                        >
                          {q.number}
                        </button>
                      );
                    })}
                  </div>
                  {isLockedReview && !hideAnswers && wrongInReview > 0 && (
                    <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={reviewWrongOnly}
                        onChange={(e) => setReviewWrongOnly(e.target.checked)}
                        className="rounded text-rose-600"
                      />
                      <span>Chỉ xem {wrongInReview} câu làm sai</span>
                    </label>
                  )}
                </div>
              )}

              <div className="overflow-y-auto space-y-4 pr-1 flex-1">
                {cleanRubric && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700">
                    {cleanRubric}
                  </div>
                )}

                {qList.length > 0 ? (
                  <div className="space-y-4">
                    {qList.map((q, idx) => {
                      const qKey = String(q.number);
                      const chosen = stuInteractiveAnswers[qKey] || '';
                      const bItem = breakdownMap[qKey];
                      const liveStatus = isLockedReview ? getLiveStatus(q) : null;
                      if (reviewWrongOnly && liveStatus !== 'wrong') return null;
                      const prevPassage = idx > 0 ? qList[idx - 1].passage : '';
                      const showPassageBox = q.passage && (q.passage !== prevPassage || reviewWrongOnly);

                      return (
                        <React.Fragment key={q.id || qKey}>
                          {/* KHUNG ĐOẠN VĂN ĐỌC HIỂU CHUNG */}
                          {showPassageBox && (
                            <div className="p-4 rounded-2xl bg-pink-50/70 border border-pink-200 space-y-1.5">
                              <div className="text-xs font-bold text-pink-900 flex items-center gap-1.5">
                                <BookOpen className="w-4 h-4 text-pink-600" />
                                <span>Đoạn văn đọc hiểu / Bài đọc chung</span>
                              </div>
                              <div className="text-xs sm:text-sm text-slate-800 whitespace-pre-line leading-relaxed bg-white p-3.5 rounded-xl border border-pink-100">
                                {q.passage}
                              </div>
                            </div>
                          )}

                          <div
                            id={`sc-q-${qKey}`}
                            className={`p-4 rounded-2xl border space-y-3 scroll-mt-4 ${
                              isLockedReview && !hideAnswers && liveStatus === 'correct'
                                ? 'bg-emerald-50/50 border-emerald-300'
                                : isLockedReview && !hideAnswers && liveStatus === 'wrong'
                                ? 'bg-rose-50/50 border-rose-300'
                                : 'bg-slate-50/70 border-slate-200'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm font-semibold text-slate-900 whitespace-pre-line">
                                <span className="inline-block px-2 py-0.5 rounded-md bg-pink-600 text-white text-xs font-bold mr-2">
                                  Câu {q.number}
                                </span>
                                {q.sourceHint && (
                                  <span className="inline-block px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[11px] font-semibold mr-2">
                                    Luyện lại: {q.sourceHint}
                                  </span>
                                )}
                                {q.text}
                              </div>

                              {isLockedReview && !hideAnswers && liveStatus && (
                                <span
                                  className={`px-2 py-0.5 rounded-md text-[11px] font-bold shrink-0 ${
                                    liveStatus === 'correct'
                                      ? 'bg-emerald-600 text-white'
                                      : 'bg-rose-600 text-white'
                                  }`}
                                >
                                  {liveStatus === 'correct' ? '✓ Đúng' : '✗ Sai'}
                                </span>
                              )}
                            </div>

                            {q.type === 'mcq' ? (
                              <div className="grid sm:grid-cols-2 gap-2">
                                {['A', 'B', 'C', 'D']
                                  .filter((opt) => q.options?.[opt])
                                  .map((opt) => {
                                    const active = chosen.toUpperCase() === opt;
                                    const isCorrectOpt =
                                      isLockedReview &&
                                      extractMcqLetter(q.correctAnswer || bItem?.expected || '', q.options).letter === opt;

                                    let btnStyle =
                                      'bg-white text-slate-800 border-slate-200 hover:border-pink-400';
                                    if (isLockedReview) {
                                      if (hideAnswers) {
                                        btnStyle = active
                                          ? 'bg-pink-600 text-white border-pink-600 shadow-sm'
                                          : 'bg-white text-slate-500 border-slate-200 opacity-80';
                                      } else if (isCorrectOpt) {
                                        btnStyle =
                                          'bg-emerald-600 text-white border-emerald-600 shadow-sm';
                                      } else if (active && !isCorrectOpt) {
                                        btnStyle = 'bg-rose-600 text-white border-rose-600';
                                      } else {
                                        btnStyle = 'bg-white text-slate-500 border-slate-200 opacity-80';
                                      }
                                    } else if (active) {
                                      btnStyle =
                                        'bg-pink-600 text-white border-pink-600 shadow-sm';
                                    }

                                    return (
                                      <button
                                        key={opt}
                                        type="button"
                                        disabled={isLockedReview}
                                        onClick={() =>
                                          setStuInteractiveAnswers((prev) => ({
                                            ...prev,
                                            [qKey]: opt
                                          }))
                                        }
                                        className={`text-left p-2.5 rounded-xl border text-xs flex items-start gap-2.5 transition ${btnStyle}`}
                                      >
                                        <span
                                          className={`w-5 h-5 rounded-md font-bold flex items-center justify-center shrink-0 ${
                                            active || isCorrectOpt
                                              ? 'bg-white text-slate-900'
                                              : 'bg-slate-100 text-slate-700'
                                          }`}
                                        >
                                          {opt}
                                        </span>
                                        <span className="pt-0.5">{q.options[opt]}</span>
                                      </button>
                                    );
                                  })}
                              </div>
                            ) : (
                              <input
                                type="text"
                                disabled={isLockedReview}
                                placeholder="Nhập câu trả lời / đáp án của em..."
                                value={chosen}
                                onChange={(e) =>
                                  setStuInteractiveAnswers((prev) => ({
                                    ...prev,
                                    [qKey]: e.target.value
                                  }))
                                }
                                className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-pink-500 outline-none disabled:bg-slate-100"
                              />
                            )}

                            {/* HIỆN ĐÁP ÁN ĐÚNG & GIẢI THÍCH NGAY SAU KHI NỘP (NẾU KHÔNG BỊ KHÓA) */}
                            {isLockedReview && !hideAnswers && (q.correctAnswer || bItem?.expected || q.explanation || bItem?.explanation || q.previousWrongAnswer) && (
                              <div className="p-2.5 rounded-xl bg-white border border-slate-200 text-xs space-y-1">
                                {q.previousWrongAnswer && (
                                  <div className="text-slate-500">
                                    ↺ Lần làm trước em từng chọn: <span className="line-through text-rose-600 font-semibold">{q.previousWrongAnswer}</span>
                                  </div>
                                )}
                                {(q.correctAnswer || bItem?.expected) && (
                                  <div className="text-emerald-700 font-bold">
                                    ✓ Đáp án chuẩn: {formatKeyForDisplay(q, bItem?.expected)}
                                  </div>
                                )}
                                {(q.explanation || bItem?.explanation) && (
                                  <div className="text-slate-700">
                                    💡 <strong>Giải thích:</strong> {q.explanation || bItem?.explanation}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                ) : (
                  submittingAsg.answer_key_text && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Nhập đáp án (VD: 1:A, 2:B, 3:C, 4:D)
                      </label>
                      <input
                        type="text"
                        disabled={isLockedReview}
                        placeholder="1:A, 2:B, 3:C..."
                        value={stuAnswerInput}
                        onChange={(e) => setStuAnswerInput(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                  )
                )}

                {!isLockedReview && (
                  <div className="pt-2">
                    <label className="flex items-center justify-between p-3 border border-dashed border-slate-300 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer transition">
                      <div className="flex items-center gap-2 text-xs text-slate-700">
                        <Upload className="w-4 h-4 text-pink-600" />
                        <span>
                          {stuPdfFile
                            ? `File đính kèm: ${stuPdfFile.name}`
                            : 'Đính kèm thêm file PDF bài giải viết tay (Không bắt buộc)'}
                        </span>
                      </div>
                      <span className="text-[11px] font-semibold text-pink-600">Chọn file</span>
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        onChange={(e) => setStuPdfFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-100 shrink-0">
                {isLockedReview ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSubmittingAsg(null);
                      setIsRetryingPractice(false);
                      setRemainingSeconds(null);
                    }}
                    className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-semibold text-sm"
                  >
                    Đóng cửa sổ xem bài
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-3 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Send className="w-4 h-4" />
                    <span>
                      {isSubmitting
                        ? 'Đang nộp bài & chấm điểm...'
                        : 'Hoàn thành & Nộp bài (Chấm điểm & Xem đáp án ngay)'}
                    </span>
                  </button>
                )}
              </div>
            </form>

            {showSubmitConfirm && !isLockedReview && (
              <div className="fixed inset-0 z-[70] bg-slate-900/50 flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl max-w-md w-full p-5 space-y-3 shadow-2xl border border-slate-200">
                  <h4 className="font-bold text-slate-900">Nộp bài “{submittingAsg.title}”?</h4>
                  {qList.length > 0 && (
                    <p className="text-sm text-slate-700">
                      Em đã làm <strong>{answeredCount}/{qList.length}</strong> câu.
                    </p>
                  )}
                  {qList.length > 0 && answeredCount === 0 && (
                    <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs font-bold text-rose-700">
                      Em chưa chọn đáp án nào — nộp bây giờ sẽ được 0 điểm!
                    </div>
                  )}
                  {unansweredList.length > 0 && answeredCount > 0 && (
                    <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1.5">
                      <div className="font-bold">Còn {unansweredList.length} câu chưa làm:</div>
                      <div className="flex flex-wrap gap-1">
                        {unansweredList.slice(0, 30).map((q) => (
                          <button
                            key={q.number}
                            type="button"
                            onClick={() => {
                              setShowSubmitConfirm(false);
                              setTimeout(() => scrollToQuestion(String(q.number)), 50);
                            }}
                            className="px-1.5 py-0.5 rounded bg-white border border-amber-300 font-bold hover:bg-amber-100"
                          >
                            {q.number}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {asgMeta.assignmentType !== 'practice' && (
                    <p className="text-xs text-slate-500">Sau khi nộp, bài sẽ bị khóa và không làm lại được.</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowSubmitConfirm(false)}
                      className="flex-1 py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-sm font-bold"
                    >
                      Quay lại làm tiếp
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        setShowSubmitConfirm(false);
                        submitStudentWork(false);
                      }}
                      className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-sm font-bold disabled:opacity-50"
                    >
                      Nộp bài
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
