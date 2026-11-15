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
  ExternalLink
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
  parseQuestionsWithGeminiAI
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

// Trích xuất danh sách câu hỏi dù lưu ở cột questions_json hay nhúng dự phòng trong rubric
function getAssignmentQuestions(asg) {
  if (!asg) return [];
  if (Array.isArray(asg.questions_json) && asg.questions_json.length > 0) {
    return asg.questions_json;
  }
  if (typeof asg.rubric === 'string' && asg.rubric.includes('__SC_QUESTIONS__:')) {
    try {
      const jsonPart = asg.rubric.split('__SC_QUESTIONS__:')[1];
      const parsed = JSON.parse(jsonPart);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

function getCleanRubricText(asg) {
  if (!asg?.rubric) return '';
  return asg.rubric.split('__SC_QUESTIONS__:')[0].trim();
}

// Chấm điểm tự động 100% không cần AI dựa trên bộ câu hỏi tương tác
function gradeInteractiveQuestions(questions, studentAnswersMap, topic) {
  const gradableQuestions = questions.filter(
    (q) => q.correctAnswer && String(q.correctAnswer).trim() !== ''
  );

  // Nếu bộ đề KHÔNG có đáp án sẵn (hoặc toàn câu tự luận) -> chuyển sang giáo viên chấm
  if (gradableQuestions.length === 0) {
    return null;
  }

  let correctCount = 0;
  const wrongDetails = [];
  const breakdown = [];

  gradableQuestions.forEach((q) => {
    const key = String(q.number);
    const expected = String(q.correctAnswer).trim();
    const actual = String(studentAnswersMap[key] || '').trim();

    const normExpected = expected.toLowerCase().replace(/\s+/g, '');
    const normActual = actual.toLowerCase().replace(/\s+/g, '');
    const isRight = normActual !== '' && normActual === normExpected;

    if (isRight) {
      correctCount += 1;
      breakdown.push({
        question: key,
        status: 'correct',
        expected,
        actual: actual || '(Bỏ trống)'
      });
    } else {
      wrongDetails.push(
        `Câu ${key}: Em trả lời "${actual || 'Bỏ trống'}" — Đáp án đúng là "${expected}"`
      );
      breakdown.push({
        question: key,
        status: 'wrong',
        expected,
        actual: actual || '(Bỏ trống)'
      });
    }
  });

  // Nếu có xen kẽ câu tự luận chưa có đáp án thì đánh dấu chờ giáo viên duyệt thêm
  const hasUngradedEssay = questions.some(
    (q) => !q.correctAnswer || String(q.correctAnswer).trim() === ''
  );

  const score = Number(((correctCount / gradableQuestions.length) * 10).toFixed(2));
  const weakTopics = score < 8 && topic ? [topic] : [];

  return {
    score,
    hasUngradedEssay,
    weakTopics,
    feedbackJson: {
      correctCount,
      totalCount: gradableQuestions.length,
      wrongDetails,
      breakdown,
      summary: hasUngradedEssay
        ? `Phần tự động chấm đúng ${correctCount}/${gradableQuestions.length} câu (${score}/10). Các câu tự luận đang chờ giáo viên chấm bổ sung.`
        : score >= 8
        ? `Rất tốt! Em làm đúng ${correctCount}/${gradableQuestions.length} câu, nắm vững chuyên đề ${topic || 'bài học'}.`
        : `Em đúng ${correctCount}/${gradableQuestions.length} câu. Xem chi tiết câu sai bên dưới để ôn lại phần ${topic || 'trọng tâm'}.`
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
      breakdown.push({ question: k.toUpperCase(), status: 'correct', expected, actual });
    } else {
      wrongDetails.push(`Câu ${k.toUpperCase()}: Em chọn "${actual}" — Đáp án đúng là "${expected}"`);
      breakdown.push({ question: k.toUpperCase(), status: 'wrong', expected, actual });
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
  const [assignments, setAssignments] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [toast, setToast] = useState(null);

  const [teacherTab, setTeacherTab] = useState('overview');
  const [selectedClassId, setSelectedClassId] = useState('all');
  const [chartTimeMode, setChartTimeMode] = useState('week');
  const [chartStudentFilter, setChartStudentFilter] = useState('all');
  const [deepDiveStudent, setDeepDiveStudent] = useState(null);
  const [reviewingSubmission, setReviewingSubmission] = useState(null);

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
  const [asgAnswerKey, setAsgAnswerKey] = useState('');
  const [asgRubric, setAsgRubric] = useState('');
  const [sourceFile, setSourceFile] = useState(null);
  const [rawExtractedText, setRawExtractedText] = useState('');
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [isPublishingAsg, setIsPublishingAsg] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('sc_gemini_key') || '');
  const [showAiKeyInput, setShowAiKeyInput] = useState(false);

  // Bài ôn bổ trợ riêng
  const [remTitle, setRemTitle] = useState('');
  const [remTopic, setRemTopic] = useState('');
  const [remAnswerKey, setRemAnswerKey] = useState('');
  const [remNote, setRemNote] = useState('');

  // Chấm bài thủ công kèm tick Đúng/Sai từng câu
  const [gradeScore, setGradeScore] = useState('8.5');
  const [gradeWeakTopic, setGradeWeakTopic] = useState('');
  const [gradeComment, setGradeComment] = useState('');
  const [gradeQuestionMarks, setGradeQuestionMarks] = useState({});
  const [gradeQuestionNotes, setGradeQuestionNotes] = useState({});

  // Cổng học sinh làm bài trực tiếp
  const [studentTab, setStudentTab] = useState('tasks');
  const [submittingAsg, setSubmittingAsg] = useState(null);
  const [stuInteractiveAnswers, setStuInteractiveAnswers] = useState({});
  const [stuAnswerInput, setStuAnswerInput] = useState('');
  const [stuPdfFile, setStuPdfFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      if (annRes.data) setAnnouncements(annRes.data);
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

      notify(
        `Đã trích xuất nguyên văn ${questions.length} câu hỏi từ "${file.name}"!`
      );
    } catch (err) {
      notify('Không thể đọc file: ' + err.message, 'error');
    } finally {
      setIsParsingFile(false);
    }
  };

  // Tùy chọn dùng Gemini AI tách đề khi file lộn xộn
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
        notify(`Gemini AI đã tách chuẩn ${aiQuestions.length} câu hỏi!`);
      }
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setIsParsingFile(false);
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
        text: '',
        options: { A: '', B: '', C: '', D: '' },
        correctAnswer: ''
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

  // Đăng bài tập (hỗ trợ cả file Word/PDF đã tách câu hỏi lẫn nhập tay)
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
        number: idx + 1
      }));

      const finalAnswerKey =
        cleanQuestions.length > 0
          ? cleanQuestions
              .filter((q) => q.correctAnswer)
              .map((q) => `${q.number}:${q.correctAnswer}`)
              .join(', ')
          : asgAnswerKey.trim();

      const embeddedRubric =
        cleanQuestions.length > 0
          ? `${asgRubric.trim()}\n__SC_QUESTIONS__:${JSON.stringify(cleanQuestions)}`
          : asgRubric.trim();

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

  const handleSendReminder = async (student) => {
    if (!supabase) return;
    await supabase.from('announcements').insert([
      {
        target_student_id: student.id,
        message: `Nhắc nhở: Em ${student.full_name} (${student.student_code}) vui lòng hoàn thành bài tập đúng hạn nhé!`
      }
    ]);
    notify(`Đã gửi thông báo nhắc nhở tới ${student.full_name}`);
  };

  // Mở popup chấm bài thủ công và nạp sẵn trạng thái Đúng/Sai từng câu nếu có
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
        if (b.expected && b.status === 'wrong') {
          initialNotes[String(b.question)] = b.expected;
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
          initialNotes[k] = String(q.correctAnswer).trim();
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

    setGradeWeakTopic(targetAsg?.topic || '');
    setGradeComment('');
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
      const noteExpected = String(gradeQuestionNotes[k] || q.correctAnswer || '').trim();

      if (mark === 'correct') {
        correctCount += 1;
        breakdown.push({
          question: k,
          status: 'correct',
          expected: noteExpected,
          actual: stuAns
        });
      } else if (mark === 'wrong') {
        breakdown.push({
          question: k,
          status: 'wrong',
          expected: noteExpected,
          actual: stuAns
        });
        wrongDetails.push(
          noteExpected
            ? `Câu ${k}: Em trả lời "${stuAns}" — Đáp án đúng: "${noteExpected}"`
            : `Câu ${k}: Chưa chính xác (Bài làm của em: "${stuAns}")`
        );
      }
    });

    if (wrongDetails.length === 0 && weakArr.length > 0) {
      wrongDetails.push(`Cần ôn lại chuyên đề: ${weakArr.join(', ')}`);
    }

    const autoSummary =
      breakdown.length > 0
        ? `Giáo viên đã chấm: Đúng ${correctCount}/${breakdown.length} câu (${scoreNum}/10 điểm).`
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

  // Học sinh nộp bài (hỗ trợ cả làm trực tiếp trên web lẫn nộp PDF/nhập tay)
  const handleStudentSubmit = async (e) => {
    e.preventDefault();
    if (!submittingAsg || !currentStudent || !supabase) return;

    const questions = getAssignmentQuestions(submittingAsg);
    const isInteractive = questions.length > 0;

    if (!isInteractive && !stuAnswerInput.trim() && !stuPdfFile) {
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
          finalStatus = graded.hasUngradedEssay ? 'pending_review' : 'graded';
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

      setSubmittingAsg(null);
      setStuInteractiveAnswers({});
      setStuAnswerInput('');
      setStuPdfFile(null);

      notify(
        finalStatus === 'graded'
          ? `Chấm tự động hoàn tất! Điểm của em: ${finalScore}/10`
          : 'Đã nộp bài thành công! Giáo viên sẽ chấm điểm và trả kết quả ngay.'
      );
      fetchAllData();
    } catch (err) {
      notify('Lỗi nộp bài: ' + err.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredStudents = useMemo(() => {
    if (selectedClassId === 'all') return students;
    return students.filter((s) => s.class_id === selectedClassId);
  }, [students, selectedClassId]);

  const filteredStudentIds = useMemo(
    () => new Set(filteredStudents.map((s) => s.id)),
    [filteredStudents]
  );

  const filteredSubmissions = useMemo(() => {
    return submissions.filter((sub) => filteredStudentIds.has(sub.student_id));
  }, [submissions, filteredStudentIds]);

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
    const expectedTotal = filteredStudents.length * Math.max(1, classAssignments.length);
    const rate =
      expectedTotal > 0 ? Math.min(100, Math.round((filteredSubmissions.length / expectedTotal) * 100)) : 0;

    return {
      studentCount: filteredStudents.length,
      submissionRate: `${rate}%`,
      avgScore,
      pendingCount: pendingReviewSubmissions.length
    };
  }, [filteredStudents, filteredSubmissions, assignments, selectedClassId, pendingReviewSubmissions]);

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

  const deepDiveData = useMemo(() => {
    if (!deepDiveStudent) return null;
    const stuSubs = submissions.filter((s) => s.student_id === deepDiveStudent.id);
    const graded = stuSubs.filter((s) => s.score !== null && s.score !== undefined);
    const trend = [...graded].reverse().map((sub, idx) => {
      const asg = assignments.find((a) => a.id === sub.assignment_id);
      return {
        label: asg ? `T${asg.week_number || idx + 1}` : `Bài ${idx + 1}`,
        score: Number(sub.score)
      };
    });

    const weakCounter = {};
    stuSubs.forEach((sub) => {
      (sub.weak_topics || []).forEach((t) => {
        weakCounter[t] = (weakCounter[t] || 0) + 1;
      });
    });

    return {
      submissions: stuSubs,
      trend,
      weakList: Object.entries(weakCounter).sort((a, b) => b[1] - a[1])
    };
  }, [deepDiveStudent, submissions, assignments]);

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
      (ann) => !ann.target_student_id || ann.target_student_id === currentStudent.id
    );

    return {
      mySubs,
      subByAsg,
      remedialTasks,
      classTasks,
      avgScore,
      trend,
      weakTopics: Array.from(weakSet),
      myAnnouncements
    };
  }, [currentStudent, submissions, assignments, announcements]);

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
                Đọc đề Word/PDF tự động • Học sinh làm trực tiếp trên web • Đồng bộ Realtime
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
                    Mã ID học sinh theo lớp (VD: 10A1-01)
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
                1. Tổng quan & Biểu đồ
              </button>
              <button
                onClick={() => setTeacherTab('assignments')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'assignments'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                2. Tạo đề từ Word/PDF & Giao bài
              </button>
              <button
                onClick={() => setTeacherTab('students')}
                className={`px-3.5 py-2 rounded-xl text-sm font-semibold transition ${
                  teacherTab === 'students'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                3. Cấp ID Lớp & Học sinh ({students.length})
              </button>
            </div>

            <div className="flex items-center gap-2">
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

          {teacherTab === 'overview' && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 text-xs font-medium mb-2">
                    <span>Sĩ số đang theo dõi</span>
                    <Users className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{teacherKpis.studentCount}</div>
                  <div className="text-xs text-slate-400 mt-1">Học sinh phân mã theo lớp</div>
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
                            {sub.file_name && (
                              <div className="text-[11px] text-indigo-600 truncate mt-0.5">{sub.file_name}</div>
                            )}
                          </div>
                          <button
                            onClick={() => openManualReviewModal(sub)}
                            className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                          >
                            Chấm bài
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

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
                      {filteredStudents.map((s) => (
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

              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-slate-200">
                  <h2 className="font-bold text-slate-900">Theo dõi chi tiết từng học sinh</h2>
                  <p className="text-xs text-slate-500">
                    Bấm <strong>Deep-dive</strong> để xem phần yếu và giao bài ôn riêng, hoặc <strong>Copy ID</strong> gửi học sinh
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Mã ID (Theo lớp)</th>
                        <th className="py-3 px-4">Họ và tên</th>
                        <th className="py-3 px-4">Lớp</th>
                        <th className="py-3 px-4">Bài đã nộp</th>
                        <th className="py-3 px-4">Điểm TB</th>
                        <th className="py-3 px-4">Phần đang yếu</th>
                        <th className="py-3 px-4 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filteredStudents.map((stu) => {
                        const mySubs = submissions.filter((s) => s.student_id === stu.id);
                        const graded = mySubs.filter((s) => s.score !== null && s.score !== undefined);
                        const avg =
                          graded.length > 0
                            ? (graded.reduce((a, b) => a + Number(b.score), 0) / graded.length).toFixed(1)
                            : '—';
                        const weakSet = new Set();
                        mySubs.forEach((s) => (s.weak_topics || []).forEach((w) => weakSet.add(w)));
                        const weakArr = Array.from(weakSet);

                        return (
                          <tr key={stu.id} className="hover:bg-slate-50/80 transition">
                            <td className="py-3 px-4">
                              <span className="font-mono font-bold text-indigo-600 text-xs bg-indigo-50 px-2 py-1 rounded">
                                {stu.student_code}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-semibold text-slate-900">{stu.full_name}</td>
                            <td className="py-3 px-4 text-xs text-slate-500">{stu.class_name}</td>
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
                                onClick={() => copyInviteMessage(stu)}
                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200"
                              >
                                Copy ID
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

          {/* TAB 2: TẠO ĐỀ TỪ WORD / PDF & CHỈNH SỬA TRỰC QUAN */}
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
                      Tự động giữ nguyên văn 100% câu hỏi • Tự nhận diện đáp án cuối file hoặc chữ in đậm (Không cần AI)
                    </p>
                  </div>
                </div>

                {/* VÙNG KÉO THẢ FILE WORD / PDF */}
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
                      Hỗ trợ đề trắc nghiệm A/B/C/D, điền đáp án ngắn và đề tự luận
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
                      placeholder="VD: Đề kiểm tra Tuần 3 - Hàm số"
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

                <div className="grid grid-cols-3 gap-3">
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
                      placeholder="VD: Đại số"
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
                          Bấm chọn A/B/C/D để gắn đáp án tự chấm — hoặc bỏ trống nếu muốn giáo viên tự chấm điểm
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {rawExtractedText && (
                          <button
                            type="button"
                            onClick={handleAiParseQuestions}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-50 text-purple-700 border border-purple-200 text-xs font-semibold hover:bg-purple-100"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>Quét lại bằng AI</span>
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
                          onClick={handleAiParseQuestions}
                          className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-semibold"
                        >
                          Chạy AI
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
                                value={q.type}
                                onChange={(e) =>
                                  updateParsedQuestion(idx, {
                                    type: e.target.value,
                                    correctAnswer: ''
                                  })
                                }
                                className="px-2 py-1 text-xs bg-white border border-slate-300 rounded-lg font-medium"
                              >
                                <option value="mcq">Trắc nghiệm (A/B/C/D)</option>
                                <option value="short">Trả lời ngắn (Tự chấm)</option>
                                <option value="essay">Tự luận (GV tự chấm)</option>
                              </select>
                            </div>

                            <div className="flex items-center gap-2">
                              {q.correctAnswer ? (
                                <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                  Đáp án: {q.correctAnswer}
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

                          <textarea
                            rows={2}
                            value={q.text}
                            onChange={(e) => updateParsedQuestion(idx, { text: e.target.value })}
                            placeholder="Nội dung câu hỏi..."
                            className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                          />

                          {q.type === 'mcq' && (
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
                          )}

                          {q.type === 'short' && (
                            <input
                              type="text"
                              value={q.correctAnswer || ''}
                              onChange={(e) =>
                                updateParsedQuestion(idx, { correctAnswer: e.target.value })
                              }
                              placeholder="Nhập đáp án ngắn chuẩn để tự động so khớp (VD: 12.5 hoặc x=2)..."
                              className="w-full px-3 py-1.5 text-xs bg-white border border-emerald-300 rounded-lg"
                            />
                          )}
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
                <h2 className="font-bold text-slate-900">Danh sách bài tập đã giao ({assignments.length})</h2>
                {assignments.map((a) => {
                  const qList = getAssignmentQuestions(a);
                  const hasKeys =
                    Boolean(a.answer_key_text) || qList.some((q) => Boolean(q.correctAnswer));
                  return (
                    <div
                      key={a.id}
                      className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between gap-2.5"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
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
                          </div>
                          {qList.length > 0 && (
                            <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-[11px] font-bold">
                              {qList.length} câu trên Web
                            </span>
                          )}
                        </div>
                        <h3 className="font-bold text-slate-900 mt-1.5">{a.title}</h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Chuyên đề: <strong>{a.topic || 'Tổng hợp'}</strong> • Hạn: {a.due_date || 'Mở'}
                        </p>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
                        {hasKeys ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-medium">
                            <Check className="w-3.5 h-3.5" /> Tự động chấm theo đáp án
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 font-medium">
                            Giáo viên chấm điểm
                          </span>
                        )}

                        {(a.source_file_url || a.answer_key_url) && (
                          <a
                            href={a.source_file_url || a.answer_key_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-indigo-600 hover:underline font-semibold"
                          >
                            <span>File đề gốc</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: QUẢN LÝ ID LỚP & HỌC SINH */}
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

                {generatedCredentials.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
                    <div className="text-xs font-bold text-emerald-900">Tài khoản vừa tạo xong:</div>
                    {generatedCredentials.map((stu) => (
                      <div
                        key={stu.student_code}
                        className="bg-white p-2.5 rounded-lg border border-emerald-200 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-bold text-slate-900">{stu.full_name}</div>
                          <div className="text-slate-600">
                            ID: <strong className="font-mono text-indigo-600">{stu.student_code}</strong> • PIN:{' '}
                            <strong className="font-mono text-emerald-700">{stu.pin_code}</strong>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => copyInviteMessage(stu)}
                          className="px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" /> Copy
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="lg:col-span-3 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                <h2 className="font-bold text-slate-900 mb-3">
                  Danh sách ID & Mật khẩu học sinh ({students.length})
                </h2>
                <div className="max-h-[460px] overflow-y-auto divide-y divide-slate-100">
                  {students.map((s) => (
                    <div key={s.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                      <div>
                        <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded mr-2">
                          {s.student_code}
                        </span>
                        <span className="font-semibold text-slate-900">{s.full_name}</span>
                        <span className="text-slate-400 ml-2">({s.class_name})</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-slate-600">
                          PIN: <strong className="font-mono text-slate-900">{s.pin_code}</strong>
                        </span>
                        <button
                          onClick={() => copyInviteMessage(s)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-700 font-medium transition"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copy gửi HS</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* MODAL DEEP-DIVE HỌC SINH */}
      {deepDiveStudent && deepDiveData && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-6">
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

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Biểu đồ phong độ cá nhân
              </h3>
              <TrendLineChart points={deepDiveData.trend} color="#4f46e5" />
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

      {/* MODAL GIÁO VIÊN CHẤM BÀI (CÓ NÚT TICK ĐÚNG / SAI TỪNG CÂU + TỰ TÍNH ĐIỂM TỔNG) */}
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
                    Chấm bài nộp của {reviewingSubmission.student_code}
                  </h3>
                  <p className="text-xs text-slate-500">{targetAsg?.title}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewingSubmission(null)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="w-5 h-5" />
                </button>
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

                            {/* NÚT TICK ĐÚNG / SAI */}
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
                                placeholder="Ghi chú đáp án đúng cho học sinh xem (VD: B hoặc giải thích ngắn)..."
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
                    Điểm tổng (0 - 10) * <span className="text-[11px] font-normal text-slate-400">(Tự tính khi tick hoặc nhập tay)</span>
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

          {studentPortalData.myAnnouncements.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                <Bell className="w-4 h-4 text-amber-600" />
                <span>Thông báo từ giáo viên</span>
              </div>
              {studentPortalData.myAnnouncements.slice(0, 3).map((ann) => (
                <p key={ann.id} className="text-xs text-amber-800">
                  • {ann.message}
                </p>
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
                      return (
                        <div
                          key={task.id}
                          className="bg-white p-4 rounded-2xl border-2 border-rose-200 shadow-sm flex flex-col justify-between gap-3"
                        >
                          <div>
                            <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[11px] font-bold">
                              Ôn phần yếu: {task.topic}
                            </span>
                            <h3 className="font-bold text-slate-900 mt-1.5">{task.title}</h3>
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                            {sub ? (
                              <span className="text-xs font-bold text-emerald-600">
                                {sub.score !== null ? `Đã chấm: ${sub.score}/10` : 'Đã nộp (Chờ chấm)'}
                              </span>
                            ) : (
                              <span className="text-xs text-rose-600 font-medium">Cần hoàn thành</span>
                            )}
                            <button
                              onClick={() => {
                                setSubmittingAsg(task);
                                setStuInteractiveAnswers({});
                                setStuAnswerInput('');
                                setStuPdfFile(null);
                              }}
                              className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
                            >
                              {sub ? 'Làm lại' : 'Làm bài ngay'}
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
                    return (
                      <div
                        key={task.id}
                        className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between gap-3"
                      >
                        <div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-bold">
                              Tuần {task.week_number}
                            </span>
                            <span className="text-slate-400">Hạn: {task.due_date || 'Mở'}</span>
                          </div>
                          <h3 className="font-bold text-slate-900 mt-2">{task.title}</h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Chuyên đề: {task.topic || 'Tổng hợp'}
                            {qList.length > 0 && ` • ${qList.length} câu hỏi trực tuyến`}
                          </p>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                          {sub ? (
                            <span className="text-xs font-bold text-emerald-600">
                              {sub.score !== null
                                ? `Điểm: ${sub.score}/10`
                                : 'Đã nộp (Chờ giáo viên chấm)'}
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 font-medium">Chưa làm</span>
                          )}
                          <button
                            onClick={() => {
                              setSubmittingAsg(task);
                              setStuInteractiveAnswers({});
                              setStuAnswerInput('');
                              setStuPdfFile(null);
                            }}
                            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-1.5"
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                            <span>{sub ? 'Xem / Làm lại' : 'Làm bài ngay'}</span>
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
                <h2 className="font-bold text-slate-900 text-sm">Chi tiết điểm & từng câu Đúng / Sai</h2>
                {studentPortalData.mySubs.map((sub) => {
                  const asg = assignments.find((a) => a.id === sub.assignment_id);
                  const fb = sub.ai_feedback_json || {};
                  const breakdown = Array.isArray(fb.breakdown) ? fb.breakdown : [];

                  return (
                    <div key={sub.id} className="bg-white p-4 rounded-2xl border border-slate-200 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-sm text-slate-900">{asg?.title || 'Bài tập'}</div>
                        <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold text-xs">
                          {sub.score !== null ? `${sub.score}/10 điểm` : 'Chờ giáo viên chấm'}
                        </span>
                      </div>

                      {fb.summary && <p className="text-xs text-slate-700">{fb.summary}</p>}

                      {/* HIỂN THỊ TỪNG CÂU ĐÚNG / SAI CHO HỌC SINH */}
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
                        <div className="p-3 rounded-xl bg-rose-50 text-xs text-rose-800 space-y-1">
                          <div className="font-bold">Chi tiết các câu sai cần xem lại:</div>
                          {fb.wrongDetails.map((line, i) => (
                            <div key={i}>• {line}</div>
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

      {/* MODAL HỌC SINH LÀM BÀI TRỰC TIẾP TRÊN WEB */}
      {submittingAsg && (() => {
        const qList = getAssignmentQuestions(submittingAsg);
        const cleanRubric = getCleanRubricText(submittingAsg);
        const answeredCount = qList.filter(
          (q) => Boolean(stuInteractiveAnswers[String(q.number)]?.trim())
        ).length;

        return (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <form
              onSubmit={handleStudentSubmit}
              className="bg-white rounded-2xl max-w-3xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col gap-4"
            >
              <div className="flex items-start justify-between border-b border-slate-100 pb-3 shrink-0">
                <div>
                  <h3 className="font-bold text-base sm:text-lg text-slate-900">
                    {submittingAsg.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1">
                    <span>Chuyên đề: {submittingAsg.topic || 'Tổng hợp'}</span>
                    {qList.length > 0 && (
                      <span className="font-bold text-indigo-600">
                        Tiến độ: {answeredCount}/{qList.length} câu
                      </span>
                    )}
                    {(submittingAsg.source_file_url || submittingAsg.answer_key_url) && (
                      <a
                        href={submittingAsg.source_file_url || submittingAsg.answer_key_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-600 font-semibold hover:underline"
                      >
                        <span>Mở file đề gốc</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSubmittingAsg(null)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto space-y-4 pr-1 flex-1">
                {cleanRubric && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700">
                    {cleanRubric}
                  </div>
                )}

                {qList.length > 0 ? (
                  <div className="space-y-4">
                    {qList.map((q) => {
                      const qKey = String(q.number);
                      const chosen = stuInteractiveAnswers[qKey] || '';

                      return (
                        <div
                          key={q.id || qKey}
                          className="p-4 rounded-2xl bg-slate-50/70 border border-slate-200 space-y-3"
                        >
                          <div className="text-sm font-semibold text-slate-900 whitespace-pre-line">
                            <span className="inline-block px-2 py-0.5 rounded-md bg-indigo-600 text-white text-xs font-bold mr-2">
                              Câu {q.number}
                            </span>
                            {q.text}
                          </div>

                          {q.type === 'mcq' && (
                            <div className="grid sm:grid-cols-2 gap-2">
                              {['A', 'B', 'C', 'D']
                                .filter((opt) => q.options?.[opt])
                                .map((opt) => {
                                  const active = chosen === opt;
                                  return (
                                    <button
                                      key={opt}
                                      type="button"
                                      onClick={() =>
                                        setStuInteractiveAnswers((prev) => ({
                                          ...prev,
                                          [qKey]: opt
                                        }))
                                      }
                                      className={`text-left p-2.5 rounded-xl border text-xs flex items-start gap-2.5 transition ${
                                        active
                                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                          : 'bg-white text-slate-800 border-slate-200 hover:border-indigo-400'
                                      }`}
                                    >
                                      <span
                                        className={`w-5 h-5 rounded-md font-bold flex items-center justify-center shrink-0 ${
                                          active
                                            ? 'bg-white text-indigo-600'
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
                          )}

                          {q.type === 'short' && (
                            <input
                              type="text"
                              placeholder="Nhập đáp án ngắn của em..."
                              value={chosen}
                              onChange={(e) =>
                                setStuInteractiveAnswers((prev) => ({
                                  ...prev,
                                  [qKey]: e.target.value
                                }))
                              }
                              className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                          )}

                          {q.type === 'essay' && (
                            <textarea
                              rows={3}
                              placeholder="Nhập lời giải tự luận của em vào đây (hoặc đính kèm file PDF bài viết tay ở cuối trang)..."
                              value={chosen}
                              onChange={(e) =>
                                setStuInteractiveAnswers((prev) => ({
                                  ...prev,
                                  [qKey]: e.target.value
                                }))
                              }
                              className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                          )}
                        </div>
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
                        placeholder="1:A, 2:B, 3:C..."
                        value={stuAnswerInput}
                        onChange={(e) => setStuAnswerInput(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                  )
                )}

                {/* Tùy chọn đính kèm thêm file PDF viết tay */}
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
              </div>

              <div className="pt-2 border-t border-slate-100 shrink-0">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm"
                >
                  <Send className="w-4 h-4" />
                  <span>{isSubmitting ? 'Đang nộp bài...' : 'Hoàn thành & Nộp bài'}</span>
                </button>
              </div>
            </form>
          </div>
        );
      })()}
    </div>
  );
}
