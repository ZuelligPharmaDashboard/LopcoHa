import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  Award
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
  // Chuẩn hóa loại câu hỏi về 2 nhóm duy nhất: 'mcq' và 'open'
  return rawList.map((q, idx) => ({
    ...q,
    number: Number(q.number) || idx + 1,
    type: q.type === 'mcq' ? 'mcq' : 'open',
    passage: q.passage || '',
    explanation: q.explanation || ''
  }));
}

// Trích xuất cấu hình bổ sung của đề (thời gian làm bài...) từ rubric
function getAssignmentMeta(asg) {
  if (!asg || typeof asg.rubric !== 'string') {
    return { timeLimitMinutes: 0 };
  }
  const match = asg.rubric.match(/__SC_META__:(\{.*?\})(?:\n|$)/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      return {
        timeLimitMinutes: Number(parsed.timeLimitMinutes) || 0
      };
    } catch {
      return { timeLimitMinutes: 0 };
    }
  }
  return { timeLimitMinutes: 0 };
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
    (q) => q.correctAnswer && String(q.correctAnswer).trim() !== ''
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
    const expected = String(q.correctAnswer).trim();
    const actual = String(studentAnswersMap[key] || '').trim();

    const normExpected = expected.toLowerCase().replace(/\s+/g, '');
    const normActual = actual.toLowerCase().replace(/\s+/g, '');
    const isRight = normActual !== '' && normActual === normExpected;

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
    (q) => !q.correctAnswer || String(q.correctAnswer).trim() === ''
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
      if (match) {
        map[match[1].trim().toLowerCase()] = match[2].trim().toLowerCase();
      } else {
        map[String(idx + 1)] = part.toLowerCase();
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

function TrendLineChart({ points, labelKey = 'label', valueKey = 'score', color = '#4f46e5' }) {
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
                stroke="#e2e8f0"
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

  // Bài ôn bổ trợ riêng
  const [remTitle, setRemTitle] = useState('');
  const [remTopic, setRemTopic] = useState('');
  const [remAnswerKey, setRemAnswerKey] = useState('');
  const [remNote, setRemNote] = useState('');

  // Chấm bài thủ công & sửa điểm
  const [gradeScore, setGradeScore] = useState('8.5');
  const [gradeWeakTopic, setGradeWeakTopic] = useState('');
  const [gradeComment, setGradeComment] = useState('');
  const [gradeQuestionMarks, setGradeQuestionMarks] = useState({});
  const [gradeQuestionNotes, setGradeQuestionNotes] = useState({});

  // Cổng học sinh làm bài trực tiếp + Auto-save + Timer
  const [studentTab, setStudentTab] = useState('tasks');
  const [submittingAsg, setSubmittingAsg] = useState(null);
  const [stuInteractiveAnswers, setStuInteractiveAnswers] = useState({});
  const [stuAnswerInput, setStuAnswerInput] = useState('');
  const [stuPdfFile, setStuPdfFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftRestoredBanner, setDraftRestoredBanner] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(null);
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
        supabase.from('classes').select('*').order('created_at', { ascending: true }),
        supabase.from('students').select('*').order('student_code', { ascending: true }),
        supabase.from('assignments').select('*').order('created_at', { ascending: false }),
        supabase.from('submissions').select('*').order('submitted_at', { ascending: false }),
        supabase.from('announcements').select('*').order('created_at', { ascending: false })
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

  // Lưu trạng thái Đang học / Nghỉ học + ghi chú của học sinh
  const handleSaveStudentStatus = async (e) => {
    e.preventDefault();
    if (!editingStudentStatus || !supabase) return;
    const nextMap = {
      ...studentMetaMap,
      [editingStudentStatus.id]: {
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

  const requestDeleteSubmission = (sub, studentName = '') => {
    setConfirmDialog({
      title: 'Xóa lượt nộp bài này?',
      message: `Xóa lượt nộp của ${studentName || sub.student_code}? Sau khi xóa, dữ liệu test sẽ sạch và học sinh này có thể làm lại bài từ đầu.`,
      confirmText: 'Xóa lượt nộp',
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
      setParsedQuestions(questions);

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
        setParsedQuestions(aiQuestions);
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
      const next = prev.map((q, i) => (i === idx ? { ...q, ...patch } : q));
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
      `🎓 Thông tin đăng nhập lớp ${stu.class_name || ''}:`,
      `• Học sinh: ${stu.full_name}`,
      `• Mã ID: ${stu.student_code}`,
      `• Mật khẩu (PIN): ${stu.pin_code}`,
      `👉 Vào làm bài trực tiếp tại: ${directLink}`
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
      setLoginError('Mật khẩu giáo viên chưa đúng (Mặc định: 2026)');
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
      const cleanQuestions = parsedQuestions.map((q, idx) => ({
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

      const metaTag = `__SC_META__:${JSON.stringify({ timeLimitMinutes })}`;
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
      notify('Đã xuất bản bài tập lên web! Học sinh có thể làm trực tiếp ngay.');
      fetchAllData();
    } catch (err) {
      notify('Lỗi đăng bài: ' + err.message, 'error');
    } finally {
      setIsPublishingAsg(false);
    }
  };

  const handleAssignRemedial = async (e) => {
    e.preventDefault();
    if (!deepDiveStudent || !remTitle.trim() || !supabase) return;
    const { error } = await supabase.from('assignments').insert([
      {
        title: remTitle.trim(),
        class_id: deepDiveStudent.class_id,
        class_name: deepDiveStudent.class_name,
        target_student_id: deepDiveStudent.id,
        week_number: 0,
        due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        topic: remTopic.trim() || 'Ôn tập bổ trợ',
        answer_key_text: remAnswerKey.trim(),
        rubric: remNote.trim(),
        is_remedial: true
      }
    ]);

    if (!error) {
      await supabase.from('announcements').insert([
        {
          target_student_id: deepDiveStudent.id,
          message: `Giáo viên vừa giao bài ôn bổ trợ riêng "${remTitle.trim()}" cho phần ${remTopic || 'cần củng cố'}.`
        }
      ]);
      setRemTitle('');
      setRemAnswerKey('');
      setRemNote('');
      notify(`Đã giao bài ôn riêng cho ${deepDiveStudent.full_name}!`);
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
      if (!initialMarks[k] && q.correctAnswer && String(q.correctAnswer).trim() !== '') {
        const exp = String(q.correctAnswer).trim().toLowerCase().replace(/\s+/g, '');
        const act = String(ansMap[k] || '').trim().toLowerCase().replace(/\s+/g, '');
        initialMarks[k] = act !== '' && act === exp ? 'correct' : 'wrong';
        if (initialMarks[k] === 'wrong') {
          initialNotes[k] = q.explanation || String(q.correctAnswer).trim();
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
    const avgScore =
      graded.length > 0
        ? (graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1)
        : '—';

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
  }, [currentStudent, submissions, assignments, announcements, dismissedAnnIds]);


  // Mở bài làm cho học sinh (Khôi phục nháp tự động + khởi động đồng hồ nếu chưa nộp)
  const handleOpenStudentAssignment = (task) => {
    setSubmittingAsg(task);
    setStuPdfFile(null);
    setDraftRestoredBanner(false);

    const existingSub = studentPortalData?.subByAsg?.[task.id];
    const meta = getAssignmentMeta(task);

    if (existingSub) {
      // Đã nộp rồi -> khóa làm lại, mở chế độ xem kết quả & giải thích
      setStuInteractiveAnswers(
        existingSub.answers_json || existingSub.ai_feedback_json?.studentAnswersMap || {}
      );
      setStuAnswerInput(existingSub.answer_text || '');
      setRemainingSeconds(null);
      return;
    }

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
    if (existingSub) return; // Không ghi đè nếu đã nộp

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
  }, [submittingAsg, currentStudent, stuInteractiveAnswers, stuAnswerInput, remainingSeconds, studentPortalData]);

  // Học sinh nộp bài (hỗ trợ cả tự động thu bài khi hết giờ)
  const submitStudentWork = useCallback(
    async (isAutoTimeout = false) => {
      if (!submittingAsg || !currentStudent || !supabase || isSubmitting) return;

      // Chống nộp trùng 2 lần
      if (studentPortalData?.subByAsg?.[submittingAsg.id]) {
        notify('Bài này em đã nộp rồi (Mỗi bài chỉ được nộp 1 lần).', 'error');
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

        const fullSubPayload = {
          student_id: currentStudent.id,
          student_code: currentStudent.student_code,
          assignment_id: submittingAsg.id,
          file_url: fileUrl,
          file_name: fileName,
          answer_text: formattedAnswerText,
          answers_json: stuInteractiveAnswers,
          status: finalStatus,
          score: finalScore,
          weak_topics: finalWeakTopics,
          ai_feedback_json: finalFeedbackJson
        };

        let { error: insertErr } = await supabase.from('submissions').insert([fullSubPayload]);

        if (insertErr && insertErr.message?.includes('column')) {
          const { answers_json, ...fallbackSub } = fullSubPayload;
          const retry = await supabase.from('submissions').insert([fallbackSub]);
          insertErr = retry.error;
        }

        if (insertErr) throw insertErr;

        // Xóa bản nháp sau khi nộp thành công
        localStorage.removeItem(`sc_draft_${currentStudent.student_code}_${submittingAsg.id}`);
        setRemainingSeconds(null);
        setDraftRestoredBanner(false);

        notify(
          isAutoTimeout
            ? `Hết giờ làm bài! Hệ thống đã tự động thu bài (${finalScore !== null ? `Điểm: ${finalScore}/10` : 'Chờ GV chấm'}).`
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
    if (studentPortalData?.subByAsg?.[submittingAsg.id]) return;

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
  }, [remainingSeconds, submittingAsg, currentStudent, studentPortalData, submitStudentWork]);

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
    const graded = filteredSubmissions.filter((s) => s.score !== null && s.score !== undefined);
    const avgScore =
      graded.length > 0
        ? (graded.reduce((acc, cur) => acc + Number(cur.score), 0) / graded.length).toFixed(1)
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
    pendingReviewSubmissions
  ]);

  // Phân tích phễu: Top câu sai nhiều nhất toàn lớp + Nhóm tốt / Nhóm cần kèm
  const classFunnelAnalytics = useMemo(() => {
    const classAsgs = assignments.filter(
      (a) => !a.is_remedial && (selectedClassId === 'all' || !a.class_id || a.class_id === selectedClassId)
    );

    const perStudentStats = trackedStudentsForStats.map((stu) => {
      const stuSubs = filteredSubmissions.filter((s) => s.student_id === stu.id);
      const graded = stuSubs.filter((s) => s.score !== null && s.score !== undefined);
      const avg =
        graded.length > 0
          ? Number((graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1))
          : null;
      const missingCount = Math.max(0, classAsgs.length - stuSubs.length);
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
      `• Sĩ số đang theo dõi: ${trackedStudentsForStats.length} học sinh | Tỷ lệ hoàn thành bài: ${teacherKpis.submissionRate} | Điểm trung bình lớp: ${teacherKpis.avgScore}/10.`,
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
    teacherKpis
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

        if (bItem) {
          if (bItem.status === 'wrong') wrongCount += 1;
          else if (bItem.status === 'correct') correctCount += 1;
        } else if (q.correctAnswer) {
          const isRight =
            stuAns.toLowerCase().replace(/\s+/g, '') ===
            String(q.correctAnswer).trim().toLowerCase().replace(/\s+/g, '');
          if (isRight) correctCount += 1;
          else wrongCount += 1;
        }
      });

      const attempts = wrongCount + correctCount;
      const wrongRate = attempts > 0 ? Math.round((wrongCount / attempts) * 100) : 0;

      // Tìm phương án sai bị chọn nhiều nhất
      const wrongChoices = Object.entries(choiceCounts)
        .filter(([opt]) => opt.toUpperCase() !== String(q.correctAnswer || '').trim().toUpperCase())
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
    let targetSubs = filteredSubmissions.filter((s) => s.score !== null && s.score !== undefined);
    if (chartStudentFilter !== 'all') {
      targetSubs = targetSubs.filter((s) => s.student_id === chartStudentFilter);
    }

    const groups = {};
    targetSubs.forEach((sub) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      const key =
        chartTimeMode === 'week'
          ? `Tuần ${asg?.week_number || 1}`
          : new Date(sub.submitted_at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      if (!groups[key]) groups[key] = [];
      groups[key].push(Number(sub.score));
    });

    return Object.entries(groups).map(([label, arr]) => ({
      label,
      score: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1))
    }));
  }, [filteredSubmissions, chartStudentFilter, chartTimeMode, assignments]);

  // Tạo nhận xét tự động chi tiết cho từng học sinh (gửi phụ huynh)
  const buildIndividualStudentReport = useCallback(
    (stu) => {
      const stuSubs = submissions.filter((s) => s.student_id === stu.id);
      const graded = stuSubs.filter((s) => s.score !== null && s.score !== undefined);
      const chronological = [...graded].reverse();
      const avg =
        graded.length > 0
          ? (graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1)
          : null;

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
        `• Lớp: ${stu.class_name || 'Lớp học'} | Số bài đã nộp: ${stuSubs.length}/${classTasks.length} bài | Điểm trung bình: ${
          avg !== null ? `${avg}/10` : 'Chưa có điểm'
        }.`,
        trajectoryText ? `• Tiến độ: ${trajectoryText}` : '',
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
    [submissions, assignments]
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

    return {
      ...report,
      trend
    };
  }, [deepDiveStudent, buildIndividualStudentReport, assignments]);

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
    <div className="min-h-screen bg-slate-50 text-slate-900">
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

      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-sm">
              SC
            </div>
            <div>
              <div className="font-bold text-slate-900 leading-tight flex items-center gap-2">
                <span>SmartClass Realtime</span>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                    supabase && realtimeStatus === 'live'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      supabase && realtimeStatus === 'live' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                    }`}
                  />
                  {supabase ? 'Supabase Live' : 'Chưa nối DB'}
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block">
                Đọc đề Word/PDF tự động • Học sinh làm trực tiếp • Báo cáo tự động gửi Phụ huynh
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
                className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}

            {(!hasEnvConfig || role === 'teacher') && (
              <button
                onClick={() => setShowSetupModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700"
              >
                <Database className="w-3.5 h-3.5 text-indigo-600" />
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
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold"
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
                        genClassMode === 'existing' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      Lớp có sẵn
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenClassMode('new')}
                      className={`px-2 py-0.5 rounded-md font-semibold ${
                        genClassMode === 'new' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
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
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
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
                  <span className="text-[11px] font-mono text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                    Mã tiếp theo: {previewNextId}
                  </span>
                </div>
                <textarea
                  rows={3}
                  placeholder="Nguyễn Văn An&#10;Trần Thị Bình"
                  value={genStudentNames}
                  onChange={(e) => setGenStudentNames(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
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
                            ID: <strong className="font-mono text-indigo-600">{stu.student_code}</strong>
                          </span>
                          <span>
                            PIN: <strong className="font-mono text-emerald-700">{stu.pin_code}</strong>
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyInviteMessage(stu)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shrink-0"
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
                <Database className="w-5 h-5 text-indigo-600" />
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
                  className="w-full py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
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
        <main className="max-w-md mx-auto px-4 py-12">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white font-bold text-lg flex items-center justify-center mx-auto mb-3 shadow">
                SC
              </div>
              <h1 className="text-xl font-bold text-slate-900">Cổng Học Tập Trực Tuyến</h1>
              <p className="text-xs text-slate-500 mt-1">
                Nhập Mã ID & Mật khẩu giáo viên đã cấp để làm bài & xem điểm
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-xl mb-6">
              <button
                type="button"
                onClick={() => {
                  setLoginTab('student');
                  setLoginError('');
                }}
                className={`py-2 text-sm font-semibold rounded-lg transition ${
                  loginTab === 'student'
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Học sinh
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoginTab('teacher');
                  setLoginError('');
                }}
                className={`py-2 text-sm font-semibold rounded-lg transition ${
                  loginTab === 'teacher'
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Giáo viên
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
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl uppercase font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
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
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-sm transition"
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
                    placeholder="Nhập mật khẩu (Mặc định: 2026)"
                    value={teacherPassInput}
                    onChange={(e) => setTeacherPassInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-sm transition"
                >
                  Vào Cổng Giáo Viên
                </button>
              </form>
            )}
          </div>
        </main>
      )}

      {/* CỔNG GIÁO VIÊN */}
      {role === 'teacher' && (
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setTeacherTab('overview')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'overview'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                1. Tổng quan & Báo cáo PH
              </button>
              <button
                onClick={() => setTeacherTab('assignments')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'assignments'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                2. Tạo đề từ Word/PDF & Phân tích
              </button>
              <button
                onClick={() => setTeacherTab('students')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'students'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                3. Cấp ID & Trạng thái HS ({students.length})
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-2 rounded-xl cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeInactiveInStats}
                  onChange={(e) => setIncludeInactiveInStats(e.target.checked)}
                  className="rounded text-indigo-600"
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
                  className="px-3 py-2 text-sm font-medium bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
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
              <div className="bg-gradient-to-br from-indigo-50 via-white to-emerald-50/40 p-5 rounded-2xl border border-indigo-200 shadow-sm space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="font-bold text-indigo-950 text-base flex items-center gap-2">
                      <Award className="w-5 h-5 text-indigo-600" />
                      <span>Nhận xét tổng quan lớp & Báo cáo nhanh gửi Phụ huynh</span>
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Tự động tổng hợp theo dữ liệu thực tế (Overview → Nhóm tốt / Nhóm cần kèm → Câu sai nhiều)
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
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
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm"
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
                  className="w-full p-3.5 text-xs sm:text-sm bg-white/90 border border-indigo-200 rounded-xl text-slate-800 leading-relaxed focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                {customTeacherOverviewNote !== '' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setCustomTeacherOverviewNote('')}
                      className="text-[11px] text-indigo-600 hover:underline font-semibold"
                    >
                      ↺ Khôi phục nhận xét tự động theo dữ liệu mới nhất
                    </button>
                  </div>
                )}
              </div>

              {/* KHỐI 2: 4 KPI TỔNG QUAN */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>{includeInactiveInStats ? 'Tổng HS (Cả đã nghỉ)' : 'Sĩ số đang học'}</span>
                    <Users className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{teacherKpis.studentCount}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    {teacherKpis.inactiveCount > 0
                      ? `Ngoài ra có ${teacherKpis.inactiveCount} em đã nghỉ học`
                      : '100% đang theo học'}
                  </div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Tỷ lệ hoàn thành bài</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-2xl font-bold text-emerald-600">{teacherKpis.submissionRate}</div>
                  <div className="text-xs text-slate-400 mt-1">{filteredSubmissions.length} lượt đã nộp</div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Điểm trung bình</span>
                    <TrendingUp className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="text-2xl font-bold text-indigo-600">{teacherKpis.avgScore}</div>
                  <div className="text-xs text-slate-400 mt-1">Thang điểm 10</div>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
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
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
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

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
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

                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-700 flex items-center gap-1.5">
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
                          className="flex items-center justify-between text-xs bg-indigo-50/70 px-3 py-1.5 rounded-lg gap-2"
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
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 className="font-bold text-slate-900">Biểu đồ điểm kết quả học tập theo thời gian</h2>
                    <p className="text-xs text-slate-500">
                      Tự động nhảy số ngay khi học sinh nộp bài hoặc giáo viên chấm xong
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
                          chartTimeMode === 'week' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        Theo Tuần
                      </button>
                      <button
                        onClick={() => setChartTimeMode('day')}
                        className={`px-2.5 py-1 rounded-md font-medium ${
                          chartTimeMode === 'day' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
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
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
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
                        <th className="py-3 px-4">Điểm TB</th>
                        <th className="py-3 px-4">Phần đang yếu</th>
                        <th className="py-3 px-4 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {classStudentsAll.map((stu) => {
                        const mySubs = submissions.filter((s) => s.student_id === stu.id);
                        const graded = mySubs.filter((s) => s.score !== null && s.score !== undefined);
                        const avg =
                          graded.length > 0
                            ? (graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1)
                            : '—';
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
                              <span className="font-mono font-bold text-indigo-600 text-xs bg-indigo-50 px-2 py-1 rounded">
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
                            <td className="py-3 px-4 text-xs font-medium">{mySubs.length} bài</td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                  avg === '—'
                                    ? 'bg-slate-100 text-slate-500'
                                    : Number(avg) >= 8
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : Number(avg) >= 6.5
                                    ? 'bg-indigo-50 text-indigo-700'
                                    : 'bg-rose-50 text-rose-700'
                                }`}
                              >
                                {avg}
                              </span>
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
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700"
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
                className="lg:col-span-7 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-5 h-fit"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div>
                    <h2 className="font-bold text-slate-900 flex items-center gap-2">
                      <FileUp className="w-5 h-5 text-indigo-600" />
                      <span>Tải file Word (.docx) hoặc PDF (.pdf) thành đề tương tác</span>
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Tự nhận diện trắc nghiệm A/B/C/D, điền đáp án / tự luận & cả đoạn văn bài đọc dài
                    </p>
                  </div>
                </div>

                <div>
                  <label className="flex flex-col items-center justify-center p-5 border-2 border-dashed border-indigo-300 rounded-2xl bg-indigo-50/40 hover:bg-indigo-50 cursor-pointer transition text-center">
                    <Upload className="w-7 h-7 text-indigo-600 mb-1.5" />
                    <span className="text-sm font-bold text-indigo-900">
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
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-indigo-50/70 border border-indigo-200">
                    <Timer className="w-4 h-4 text-indigo-600 shrink-0" />
                    <label className="text-xs font-semibold text-indigo-950">
                      Nhập số phút làm bài tùy chọn:
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="300"
                      value={asgCustomMinutes}
                      onChange={(e) => setAsgCustomMinutes(e.target.value)}
                      className="w-24 px-3 py-1.5 text-sm font-bold bg-white border border-indigo-300 rounded-lg"
                    />
                    <span className="text-xs text-slate-600">phút (Hết giờ tự động thu bài)</span>
                  </div>
                )}

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
                              <span className="px-2 py-0.5 rounded bg-indigo-600 text-white font-bold text-xs">
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

                          {q.passage && (
                            <div className="p-2 rounded-lg bg-indigo-50/70 border border-indigo-200 text-[11px] text-indigo-950">
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
                                          : 'bg-slate-100 text-slate-700 hover:bg-indigo-100'
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

                <button
                  type="submit"
                  disabled={isPublishingAsg}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm shadow-sm transition"
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
                      className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between gap-2.5"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {a.is_remedial ? (
                              <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[11px] font-bold">
                                Ôn bổ trợ riêng
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-[11px] font-bold">
                                Tuần {a.week_number}
                              </span>
                            )}
                            <span className="text-xs text-slate-500">{a.class_name}</span>
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
                          <strong className="text-indigo-600">{subCount} bài nộp</strong>
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

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setAnalyticsAssignment(a)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold"
                          >
                            <BarChart3 className="w-3.5 h-3.5" />
                            <span>Top câu sai & Bài nộp</span>
                          </button>

                          {(a.source_file_url || a.answer_key_url) && (
                            <a
                              href={a.source_file_url || a.answer_key_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-indigo-600 hover:underline font-semibold"
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

          {/* TAB 3: QUẢN LÝ ID LỚP & TRẠNG THÁI HỌC SINH */}
          {teacherTab === 'students' && (
            <div className="grid lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 h-fit">
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
                            genClassMode === 'existing' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
                          }`}
                        >
                          Chọn lớp
                        </button>
                        <button
                          type="button"
                          onClick={() => setGenClassMode('new')}
                          className={`px-2 py-0.5 rounded-md font-semibold ${
                            genClassMode === 'new' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
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
                      <span className="text-[11px] font-mono bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
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

              <div className="lg:col-span-3 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
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
                          <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded mr-2">
                            {s.student_code}
                          </span>
                          <span className="font-semibold text-slate-900">{s.full_name}</span>
                          <span className="text-slate-400 ml-2">({s.class_name})</span>
                          {meta.note && (
                            <span className="ml-2 text-[11px] text-amber-700 italic">• {meta.note}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
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
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-700 font-medium"
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

      {/* MODAL PHÂN TÍCH ĐỀ THI & TOP CÂU SAI NHIỀU NHẤT + DANH SÁCH BÀI NỘP */}
      {analyticsAssignment && assignmentAnalyticsData && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-5">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-indigo-600" />
                  <span>Phân tích đề: {analyticsAssignment.title}</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Tổng số lượt nộp: <strong>{assignmentAnalyticsData.asgSubs.length}</strong> • Điểm trung bình:{' '}
                  <strong className="text-indigo-600">{assignmentAnalyticsData.avgScore}/10</strong>
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
                          <span className="font-bold text-indigo-600">
                            {sub.score !== null ? `${sub.score}/10đ` : 'Chờ chấm'}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setAnalyticsAssignment(null);
                              openManualReviewModal(sub);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold"
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
                  <span className="px-2.5 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 font-mono font-bold text-xs">
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
                        Điểm: <strong className="text-indigo-600">{sub.score ?? 'Chờ chấm'}</strong>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDeepDiveStudent(null);
                          openManualReviewModal(sub);
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold"
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
                className="p-4 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-2.5"
              >
                <h3 className="text-sm font-bold text-indigo-950">Giao bài ôn bổ trợ riêng cho em</h3>
                <input
                  type="text"
                  required
                  placeholder="Tên bài ôn thêm"
                  value={remTitle}
                  onChange={(e) => setRemTitle(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-indigo-200 rounded-lg"
                />
                <input
                  type="text"
                  placeholder="Chuyên đề cần củng cố"
                  value={remTopic}
                  onChange={(e) => setRemTopic(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-indigo-200 rounded-lg"
                />
                <input
                  type="text"
                  placeholder="Đáp án tự chấm (VD: 1:A, 2:B)"
                  value={remAnswerKey}
                  onChange={(e) => setRemAnswerKey(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-indigo-200 rounded-lg"
                />
                <button
                  type="submit"
                  className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
                >
                  Giao ngay cho {deepDiveStudent.full_name}
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
                  className="flex items-center justify-between p-3 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-semibold hover:bg-indigo-100"
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
                              <div className="text-indigo-700 font-semibold">
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
                    className="w-full px-3 py-2 text-sm font-bold text-indigo-700 border border-slate-300 rounded-xl"
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
        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-lg bg-indigo-600 text-white font-mono text-xs font-bold">
                  {currentStudent.student_code}
                </span>
                <h1 className="text-lg font-bold text-slate-900">Xin chào, {currentStudent.full_name}</h1>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {currentStudent.class_name} • Điểm trung bình hiện tại:{' '}
                <strong className="text-indigo-600">{studentPortalData.avgScore}/10</strong>
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStudentTab('tasks')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                  studentTab === 'tasks'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                Làm bài tập
              </button>
              <button
                onClick={() => setStudentTab('progress')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                  studentTab === 'progress'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                Phong độ & Kết quả chấm
              </button>
            </div>
          </div>

          {/* CẢNH BÁO HẠN NỘP SẮP ĐẾN / QUÁ HẠN */}
          {studentPortalData.urgentTasks.length > 0 && (
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
          {studentPortalData.myAnnouncements.length > 0 && (
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

          {studentTab === 'tasks' ? (
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

              <div className="space-y-3">
                <h2 className="text-sm font-bold text-slate-800">Bài tập của lớp</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  {studentPortalData.classTasks.map((task) => {
                    const sub = studentPortalData.subByAsg[task.id];
                    const qList = getAssignmentQuestions(task);
                    const meta = getAssignmentMeta(task);
                    const deadlineInfo = !sub ? getDeadlineBadgeInfo(task.due_date) : null;
                    const hasDraft =
                      !sub &&
                      Boolean(
                        localStorage.getItem(`sc_draft_${currentStudent.student_code}_${task.id}`)
                      );

                    return (
                      <div
                        key={task.id}
                        className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between gap-3"
                      >
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                            <div className="flex items-center gap-1.5">
                              <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-bold">
                                Tuần {task.week_number}
                              </span>
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
                            <div className="mt-1.5 text-[11px] font-semibold text-indigo-600">
                              💾 Đang lưu dở bài làm (Bấm vào để làm tiếp)
                            </div>
                          )}
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                          {sub ? (
                            <span className="text-xs font-bold text-emerald-600">
                              {sub.score !== null
                                ? `Điểm: ${sub.score}/10 (Đã khóa nộp)`
                                : 'Đã nộp (Chờ giáo viên chấm)'}
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 font-medium">Chưa nộp bài</span>
                          )}
                          <button
                            onClick={() => handleOpenStudentAssignment(task)}
                            className={`px-3.5 py-1.5 rounded-xl text-white text-xs font-semibold flex items-center gap-1.5 ${
                              sub
                                ? 'bg-emerald-600 hover:bg-emerald-700'
                                : 'bg-indigo-600 hover:bg-indigo-700'
                            }`}
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                            <span>{sub ? 'Xem lại bài & Đáp án' : hasDraft ? 'Làm tiếp bài' : 'Làm bài ngay'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                <h2 className="font-bold text-slate-900 mb-1">Biểu đồ phong độ học tập của em</h2>
                <p className="text-xs text-slate-500 mb-4">Theo dõi sự tiến bộ qua từng bài tập</p>
                <TrendLineChart points={studentPortalData.trend} color="#10b981" />
              </div>

              <div className="space-y-3">
                <h2 className="font-bold text-slate-900 text-sm">Chi tiết điểm, câu Đúng / Sai & Giải thích</h2>
                {studentPortalData.mySubs.map((sub) => {
                  const asg = assignments.find((a) => a.id === sub.assignment_id);
                  const fb = sub.ai_feedback_json || {};
                  const breakdown = Array.isArray(fb.breakdown) ? fb.breakdown : [];

                  return (
                    <div key={sub.id} className="bg-white p-4 rounded-2xl border border-slate-200 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-bold text-sm text-slate-900">{asg?.title || 'Bài tập'}</div>
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold text-xs">
                            {sub.score !== null ? `${sub.score}/10 điểm` : 'Chờ giáo viên chấm'}
                          </span>
                          {asg && (
                            <button
                              type="button"
                              onClick={() => handleOpenStudentAssignment(asg)}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 text-indigo-700 text-xs font-semibold"
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

                      {breakdown.length > 0 && (
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

                      {Array.isArray(fb.wrongDetails) && fb.wrongDetails.length > 0 && (
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

      {/* MODAL HỌC SINH LÀM BÀI (KHÓA NỘP 1 LẦN + AUTO-SAVE + TIMER + ĐỌC HIỂU + XEM ĐÁP ÁN & GIẢI THÍCH) */}
      {submittingAsg && (() => {
        const qList = getAssignmentQuestions(submittingAsg);
        const cleanRubric = getCleanRubricText(submittingAsg);
        const existingSub = studentPortalData?.subByAsg?.[submittingAsg.id];
        const isLockedReview = Boolean(existingSub);
        const breakdownMap = {};
        (existingSub?.ai_feedback_json?.breakdown || []).forEach((b) => {
          breakdownMap[String(b.question)] = b;
        });

        const answeredCount = qList.filter(
          (q) => Boolean(stuInteractiveAnswers[String(q.number)]?.trim())
        ).length;

        return (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!isLockedReview) submitStudentWork(false);
              }}
              className="bg-white rounded-2xl max-w-3xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col gap-4"
            >
              <div className="flex items-start justify-between border-b border-slate-100 pb-3 shrink-0 gap-2">
                <div>
                  <h3 className="font-bold text-base sm:text-lg text-slate-900">
                    {submittingAsg.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 mt-1">
                    <span>Chuyên đề: {submittingAsg.topic || 'Tổng hợp'}</span>
                    {qList.length > 0 && (
                      <span className="font-bold text-indigo-600">
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
                        className="inline-flex items-center gap-1 text-indigo-600 font-semibold hover:underline"
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
                      setRemainingSeconds(null);
                    }}
                    className="text-slate-400 hover:text-slate-600 p-1"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {isLockedReview ? (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1 shrink-0">
                  <div className="font-bold">
                    🔒 Bài làm đã nộp & khóa chỉnh sửa (Mỗi bài chỉ nộp 1 lần).
                  </div>
                  {existingSub.ai_feedback_json?.summary && (
                    <div>{existingSub.ai_feedback_json.summary}</div>
                  )}
                </div>
              ) : (
                draftRestoredBanner && (
                  <div className="px-3.5 py-2 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-800 font-medium shrink-0">
                    💾 Đã tự động khôi phục các câu em đã chọn trước đó!
                  </div>
                )
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
                      const prevPassage = idx > 0 ? qList[idx - 1].passage : '';
                      const showPassageBox = q.passage && q.passage !== prevPassage;

                      return (
                        <React.Fragment key={q.id || qKey}>
                          {/* KHUNG ĐOẠN VĂN ĐỌC HIỂU CHUNG */}
                          {showPassageBox && (
                            <div className="p-4 rounded-2xl bg-indigo-50/70 border border-indigo-200 space-y-1.5">
                              <div className="text-xs font-bold text-indigo-900 flex items-center gap-1.5">
                                <BookOpen className="w-4 h-4 text-indigo-600" />
                                <span>Đoạn văn đọc hiểu / Bài đọc chung</span>
                              </div>
                              <div className="text-xs sm:text-sm text-slate-800 whitespace-pre-line leading-relaxed bg-white p-3.5 rounded-xl border border-indigo-100">
                                {q.passage}
                              </div>
                            </div>
                          )}

                          <div
                            className={`p-4 rounded-2xl border space-y-3 ${
                              isLockedReview && bItem?.status === 'correct'
                                ? 'bg-emerald-50/50 border-emerald-300'
                                : isLockedReview && bItem?.status === 'wrong'
                                ? 'bg-rose-50/50 border-rose-300'
                                : 'bg-slate-50/70 border-slate-200'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm font-semibold text-slate-900 whitespace-pre-line">
                                <span className="inline-block px-2 py-0.5 rounded-md bg-indigo-600 text-white text-xs font-bold mr-2">
                                  Câu {q.number}
                                </span>
                                {q.text}
                              </div>

                              {isLockedReview && bItem && (
                                <span
                                  className={`px-2 py-0.5 rounded-md text-[11px] font-bold shrink-0 ${
                                    bItem.status === 'correct'
                                      ? 'bg-emerald-600 text-white'
                                      : 'bg-rose-600 text-white'
                                  }`}
                                >
                                  {bItem.status === 'correct' ? '✓ Đúng' : '✗ Sai'}
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
                                      String(q.correctAnswer || bItem?.expected || '')
                                        .trim()
                                        .toUpperCase() === opt;

                                    let btnStyle =
                                      'bg-white text-slate-800 border-slate-200 hover:border-indigo-400';
                                    if (isLockedReview) {
                                      if (isCorrectOpt) {
                                        btnStyle =
                                          'bg-emerald-600 text-white border-emerald-600 shadow-sm';
                                      } else if (active && !isCorrectOpt) {
                                        btnStyle = 'bg-rose-600 text-white border-rose-600';
                                      } else {
                                        btnStyle = 'bg-white text-slate-500 border-slate-200 opacity-80';
                                      }
                                    } else if (active) {
                                      btnStyle =
                                        'bg-indigo-600 text-white border-indigo-600 shadow-sm';
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
                                className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none disabled:bg-slate-100"
                              />
                            )}

                            {/* HIỆN ĐÁP ÁN ĐÚNG & GIẢI THÍCH NGAY SAU KHI NỘP */}
                            {isLockedReview && (q.correctAnswer || bItem?.expected || q.explanation || bItem?.explanation) && (
                              <div className="p-2.5 rounded-xl bg-white border border-slate-200 text-xs space-y-1">
                                {(q.correctAnswer || bItem?.expected) && (
                                  <div className="text-emerald-700 font-bold">
                                    ✓ Đáp án chuẩn: {q.correctAnswer || bItem?.expected}
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
                        <Upload className="w-4 h-4 text-indigo-600" />
                        <span>
                          {stuPdfFile
                            ? `File đính kèm: ${stuPdfFile.name}`
                            : 'Đính kèm thêm file PDF bài giải viết tay (Không bắt buộc)'}
                        </span>
                      </div>
                      <span className="text-[11px] font-semibold text-indigo-600">Chọn file</span>
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
                    className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm"
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
          </div>
        );
      })()}
    </div>
  );
}
