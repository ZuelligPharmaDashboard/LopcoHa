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
  Search,
  KeyRound
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
  return rawList.map((q, idx) => ({
    ...q,
    number: Number(q.number) || idx + 1,
    type: q.type === 'mcq' ? 'mcq' : 'open',
    passage: q.passage || '',
    explanation: q.explanation || ''
  }));
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

  // Gom các câu liên tiếp có cùng đoạn văn passage thành từng block nguyên vẹn
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

  const seedStr = `${studentCode \vert{}\vert{} 'HS'}_${assignmentId || 'ASG'}`;
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

// Parse chuỗi đáp án nhanh dạng "1:A, 2:B, 3:C" thành map { "1": "A", ... }
function parseAnswerKeyPairs(raw) {
  const map = {};
  if (!raw || !raw.trim()) return map;
  const parts = raw
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  parts.forEach((part, idx) => {
    const match = part.match(/^(?:câu\s*)?([^:=\-]+)[:=\-]\s*(.+)$/i);
    if (match) {
      map[match[1].trim()] = match[2].trim();
    } else {
      map[String(idx + 1)] = part;
    }
  });
  return map;
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
      label: `Quá hạn ${Math.abs(diffDays)} ngày`, badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' }; } if (diffDays === 0) { return { diffDays: 0, urgent: true, label: 'Hết hạn HÔM NAY', badgeClass: 'bg-rose-600 text-white border-rose-600 animate-pulse' }; } if (diffDays === 1) { return { diffDays: 1, urgent: true, label: 'Còn 1 ngày (Hạn ngày mai)', badgeClass: 'bg-amber-50 text-amber-800 border-amber-300' }; } if (diffDays <= 3) { return { diffDays, urgent: true, label: `Còn ${diffDays} ngày nữa hết hạn`,
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200'
    };
  }
  return {
    diffDays,
    urgent: false,
    label: `Còn ${diffDays} ngày (${due.toLocaleDateString