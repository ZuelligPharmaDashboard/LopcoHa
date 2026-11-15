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
  Wand2
} from 'lucide-react';
import {
  getSupabaseClient,
  getStoredConfig,
  saveLocalConfig,
  hasEnvConfig
} from './supabaseClient';

const TEACHER_PASSCODE = import.meta.env.VITE_TEACHER_PASSCODE || '2026';

// Trích xuất mã tiền tố lớp học ngắn gọn để phân biệt từng lớp (VD: "Lớp 10A1 - Chuyên Toán" -> "10A1")
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

function autoGradeAnswers(answerKeyRaw, studentAnswerRaw, topic) {
  if (!answerKeyRaw || !answerKeyRaw.trim()) {
    return null;
  }
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
    const isRight = actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '');
    if (isRight) {
      correct += 1;
      breakdown.push({ question: k.toUpperCase(), status: 'correct', expected, actual });
    } else {
      wrongDetails.push(`Câu ${k.toUpperCase()}: Em chọn "${actual}" — Đáp án đúng là "${expected}"`);
      breakdown.push({ question: k.toUpperCase(), status: 'wrong', expected, actual });
    }
  });

  const score = Number(((correct / keys.length) * 10).toFixed(2));
  const weakTopics = score < 8 && topic ? [topic] : [];

  return {
    score,
    weakTopics,
    feedbackJson: {
      correctCount: correct,
      totalCount: keys.length,
      wrongDetails,
      breakdown,
      summary:
        score >= 8
          ? `Rất tốt! Em làm đúng ${correct}/${keys.length} câu, nắm vững chuyên đề ${topic || 'bài học'}.`
          : `Em đúng ${correct}/${keys.length} câu. Cần xem lại các câu sai bên dưới và ôn kỹ phần ${topic || 'trọng tâm'}.`
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

  const [showQuickGenModal, setShowQuickGenModal] = useState(false);
  const [genClassMode, setGenClassMode] = useState('existing');
  const [genSelectedClassId, setGenSelectedClassId] = useState('');
  const [genNewClassName, setGenNewClassName] = useState('');
  const [genNewClassGroup, setGenNewClassGroup] = useState('Khối 10');
  const [genStudentNames, setGenStudentNames] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCredentials, setGeneratedCredentials] = useState([]);

  const [asgTitle, setAsgTitle] = useState('');
  const [asgClassId, setAsgClassId] = useState('');
  const [asgWeek, setAsgWeek] = useState(1);
  const [asgDueDate, setAsgDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [asgTopic, setAsgTopic] = useState('');
  const [asgAnswerKey, setAsgAnswerKey] = useState('');
  const [asgRubric, setAsgRubric] = useState('');

  const [remTitle, setRemTitle] = useState('');
  const [remTopic, setRemTopic] = useState('');
  const [remAnswerKey, setRemAnswerKey] = useState('');
  const [remNote, setRemNote] = useState('');

  const [gradeScore, setGradeScore] = useState('8.5');
  const [gradeWeakTopic, setGradeWeakTopic] = useState('');
  const [gradeComment, setGradeComment] = useState('');

  const [studentTab, setStudentTab] = useState('tasks');
  const [submittingAsg, setSubmittingAsg] = useState(null);
  const [stuAnswerInput, setStuAnswerInput] = useState('');
  const [stuPdfFile, setStuPdfFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const notify = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
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

  const seedDemoData = async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const { data: clsData, error: clsErr } = await supabase
        .from('classes')
        .insert([
          { name: 'Lớp 10A1 - Chuyên Toán', group_name: 'Khối 10' },
          { name: 'Lớp 10A2 - Nền Tảng', group_name: 'Khối 10' }
        ])
        .select();

      if (clsErr) throw clsErr;
      const c1 = clsData[0];
      const c2 = clsData[1];

      const { data: stuData } = await supabase
        .from('students')
        .insert([
          { student_code: '10A1-01', pin_code: '1234', full_name: 'Nguyễn Minh Anh', class_id: c1.id, class_name: c1.name },
          { student_code: '10A1-02', pin_code: '1234', full_name: 'Trần Bảo Long', class_id: c1.id, class_name: c1.name },
          { student_code: '10A2-01', pin_code: '1234', full_name: 'Lê Thảo Vy', class_id: c2.id, class_name: c2.name },
          { student_code: '10A2-02', pin_code: '1234', full_name: 'Phạm Gia Huy', class_id: c2.id, class_name: c2.name }
        ])
        .select();

      const { data: asgData } = await supabase
        .from('assignments')
        .insert([
          {
            title: 'Tuần 1: Hàm số bậc hai & Đồ thị',
            class_id: c1.id,
            class_name: c1.name,
            week_number: 1,
            due_date: new Date().toISOString().slice(0, 10),
            topic: 'Hàm số bậc hai',
            answer_key_text: '1:A, 2:C, 3:B, 4:D',
            rubric: 'Trắc nghiệm 4 câu, mỗi câu 2.5 điểm'
          },
          {
            title: 'Tuần 2: Hệ bất phương trình bậc nhất hai ẩn',
            class_id: c1.id,
            class_name: c1.name,
            week_number: 2,
            due_date: new Date().toISOString().slice(0, 10),
            topic: 'Bất phương trình',
            answer_key_text: '1:B, 2:D, 3:A, 4:C',
            rubric: 'Nộp đáp án trắc nghiệm hoặc đính kèm PDF bài giải chi tiết'
          }
        ])
        .select();

      if (stuData?.length >= 2 && asgData?.length >= 1) {
        await supabase.from('submissions').insert([
          {
            student_id: stuData[0].id,
            student_code: '10A1-01',
            assignment_id: asgData[0].id,
            answer_text: '1:A, 2:C, 3:B, 4:D',
            status: 'graded',
            score: 10,
            weak_topics: [],
            ai_feedback_json: {
              correctCount: 4,
              totalCount: 4,
              wrongDetails: [],
              summary: 'Xuất sắc! Hoàn thành chính xác 100%.'
            }
          },
          {
            student_id: stuData[1].id,
            student_code: '10A1-02',
            assignment_id: asgData[0].id,
            answer_text: '1:A, 2:B, 3:D, 4:D',
            status: 'graded',
            score: 5,
            weak_topics: ['Hàm số bậc hai'],
            ai_feedback_json: {
              correctCount: 2,
              totalCount: 4,
              wrongDetails: [
                'Câu 2: Em chọn "B" — Đáp án đúng là "C"',
                'Câu 3: Em chọn "D" — Đáp án đúng là "B"'
              ],
              summary: 'Cần ôn lại cách xác định đỉnh và trục đối xứng của Parabol.'
            }
          }
        ]);
      }

      await fetchAllData();
      notify('Đã nạp dữ liệu lớp mẫu lên Supabase thành công!');
    } catch (err) {
      notify('Lỗi nạp dữ liệu mẫu: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
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
    if (!supabase) {
      notify('Vui lòng kết nối Supabase trước!', 'error');
      return;
    }

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
          .insert([
            {
              name: genNewClassName.trim(),
              group_name: genNewClassGroup.trim() || 'Khối chung'
            }
          ])
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

      if (!targetClass) {
        notify('Chưa xác định được lớp học!', 'error');
        setIsGenerating(false);
        return;
      }

      const prefix = deriveClassPrefix(targetClass.name, targetClass.id);
      const existingInClass = students.filter(
        (s) => s.class_id === targetClass.id || s.student_code?.startsWith(`${prefix}-`)
      );

      let maxSeq = 0;
      existingInClass.forEach((s) => {
        const m = s.student_code?.match(/-(\d+)$/);
        if (m) {
          const num = parseInt(m[1], 10);
          if (num > maxSeq) maxSeq = num;
        }
      });
      if (maxSeq === 0 && existingInClass.length > 0) {
        maxSeq = existingInClass.length;
      }

      const rawLines = genStudentNames
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const namesToCreate = rawLines.length > 0 ? rawLines : [`Học sinh ${maxSeq + 1}`];

      const rowsToInsert = namesToCreate.map((fullName, idx) => {
        const nextNum = String(maxSeq + idx + 1).padStart(2, '0');
        const generatedCode = `${prefix}-${nextNum}`;
        const generatedPin = generateRandomPin();
        return {
          student_code: generatedCode,
          pin_code: generatedPin,
          full_name: fullName,
          class_id: targetClass.id,
          class_name: targetClass.name
        };
      });

      const { data: insertedStudents, error: insertErr } = await supabase
        .from('students')
        .insert(rowsToInsert)
        .select();

      if (insertErr) throw insertErr;

      setGeneratedCredentials(insertedStudents || rowsToInsert);
      setGenStudentNames('');
      await fetchAllData();
      notify(`Đã tạo thành công ${rowsToInsert.length} tài khoản học sinh lớp ${targetClass.name}!`);
    } catch (err) {
      notify('Lỗi tạo mã học sinh: ' + err.message, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyInviteMessage = (stu) => {
    const baseUrl = window.location.origin;
    const directLink = `${baseUrl}/?id=${encodeURIComponent(stu.student_code)}`;
    const text = [
      `🎓 Thông tin đăng nhập lớp ${stu.class_name || ''}:`,
      `• Học sinh: ${stu.full_name}`,
      `• Mã ID: ${stu.student_code}`,
      `• Mật khẩu (PIN): ${stu.pin_code}`,
      `👉 Vào học & nộp bài tại: ${directLink}`
    ].join('\n');

    navigator.clipboard.writeText(text);
    notify(`Đã copy thông tin đăng nhập của ${stu.full_name} (${stu.student_code})!`);
  };

  const handleStudentLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!supabase) {
      setLoginError('Chưa kết nối Supabase. Giáo viên vui lòng cấu hình ở góc trên.');
      return;
    }
    const code = stuCodeInput.trim().toUpperCase();
    const pin = stuPinInput.trim();
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('student_code', code)
      .eq('pin_code', pin)
      .maybeSingle();

    if (error || !data) {
      setLoginError('Sai Mã học sinh hoặc Mật khẩu PIN. Vui lòng kiểm tra lại tin nhắn của giáo viên!');
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

  const handleCreateAssignment = async (e) => {
    e.preventDefault();
    if (!asgTitle.trim() || !supabase) return;
    const cls = classes.find((c) => c.id === asgClassId) || null;
    const { error } = await supabase.from('assignments').insert([
      {
        title: asgTitle.trim(),
        class_id: cls ? cls.id : null,
        class_name: cls ? cls.name : 'Tất cả các lớp',
        week_number: Number(asgWeek) || 1,
        due_date: asgDueDate || null,
        topic: asgTopic.trim() || 'Tổng hợp',
        answer_key_text: asgAnswerKey.trim(),
        rubric: asgRubric.trim(),
        is_remedial: false
      }
    ]);
    if (error) {
      notify(error.message, 'error');
    } else {
      setAsgTitle('');
      setAsgAnswerKey('');
      setAsgRubric('');
      notify('Đã giao bài tập! Học sinh thấy ngay trên máy.');
      fetchAllData();
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
        message: `Nhắc nhở: Em ${student.full_name} (${student.student_code}) vui lòng hoàn thành bài tập tuần đúng hạn nhé!`
      }
    ]);
    notify(`Đã gửi thông báo nhắc nhở tới ${student.full_name}`);
  };

  const handleSavePdfGrade = async (e) => {
    e.preventDefault();
    if (!reviewingSubmission || !supabase) return;
    const scoreNum = Math.max(0, Math.min(10, Number(gradeScore) || 0));
    const weakArr = gradeWeakTopic
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const { error } = await supabase
      .from('submissions')
      .update({
        status: 'graded',
        score: scoreNum,
        weak_topics: weakArr,
        ai_feedback_json: {
          ...(reviewingSubmission.ai_feedback_json || {}),
          summary: gradeComment.trim() || 'Giáo viên đã chấm và nhận xét bài PDF.',
          wrongDetails: weakArr.length ? [`Cần ôn lại chuyên đề: ${weakArr.join(', ')}`] : []
        }
      })
      .eq('id', reviewingSubmission.id);

    if (error) {
      notify(error.message, 'error');
    } else {
      setReviewingSubmission(null);
      notify('Đã lưu điểm bài PDF — Biểu đồ học sinh đã tự động cập nhật!');
      fetchAllData();
    }
  };

  const handleStudentSubmit = async (e) => {
    e.preventDefault();
    if (!submittingAsg || !currentStudent || !supabase) return;
    if (!stuAnswerInput.trim() && !stuPdfFile) {
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

      const graded = autoGradeAnswers(
        submittingAsg.answer_key_text,
        stuAnswerInput,
        submittingAsg.topic
      );

      const payload = {
        student_id: currentStudent.id,
        student_code: currentStudent.student_code,
        assignment_id: submittingAsg.id,
        file_url: fileUrl,
        file_name: fileName,
        answer_text: stuAnswerInput.trim(),
        status: graded && !stuPdfFile ? 'graded' : 'pending_review',
        score: graded ? graded.score : null,
        weak_topics: graded ? graded.weakTopics : [],
        ai_feedback_json: graded
          ? graded.feedbackJson
          : {
              summary: 'Đã nộp file PDF thành công. Đang chờ giáo viên duyệt bài tự luận.'
            }
      };

      const { error: insertErr } = await supabase.from('submissions').insert([payload]);
      if (insertErr) throw insertErr;

      setSubmittingAsg(null);
      setStuAnswerInput('');
      setStuPdfFile(null);
      notify(
        graded && !stuPdfFile
          ? `Đã chấm tự động xong! Điểm của em: ${graded.score}/10`
          : 'Đã nộp bài lên Supabase! Điểm sẽ cập nhật ngay khi chấm xong.'
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

  const pendingPdfSubmissions = useMemo(() => {
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
      pendingCount: pendingPdfSubmissions.length
    };
  }, [filteredStudents, filteredSubmissions, assignments, selectedClassId, pendingPdfSubmissions]);

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
                Quản lý lớp học, cấp mã ID tự động & đồng bộ điểm Realtime
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
                  <label className="text-xs font-bold text-slate-700">1. Chọn lớp học của em</label>
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
                    2. Tên học sinh (Có thể nhập nhiều em, mỗi em 1 dòng)
                  </label>
                  <span className="text-[11px] font-mono text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                    Mã tiếp theo: {previewNextId}
                  </span>
                </div>
                <textarea
                  rows={3}
                  placeholder="Ví dụ:&#10;Nguyễn Văn An&#10;Trần Thị Bình"
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
                <span>
                  {isGenerating
                    ? 'Đang tạo & đồng bộ Supabase...'
                    : 'Generate ID & Mật khẩu ngay'}
                </span>
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
              <div className="space-y-3">
                <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
                  Hệ thống đã kết nối sẵn qua biến môi trường Vercel. Mọi học sinh truy cập link đều tự động đồng bộ!
                </div>
                {classes.length === 0 && (
                  <button
                    type="button"
                    onClick={seedDemoData}
                    className="w-full py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
                  >
                    + Nạp nhanh 2 lớp mẫu để test ngay
                  </button>
                )}
              </div>
            ) : (
              <form onSubmit={handleSaveConfig} className="space-y-4">
                <p className="text-xs text-slate-500">
                  Dán <strong>Project URL</strong> và <strong>Anon Public Key</strong> từ Supabase Project Settings để kích hoạt đồng bộ Realtime.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Supabase Project URL</label>
                  <input
                    type="url"
                    required
                    placeholder="https://xxxxxxx.supabase.co"
                    value={cfgUrl}
                    onChange={(e) => setCfgUrl(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Anon Public Key</label>
                  <input
                    type="text"
                    required
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
                    value={cfgKey}
                    onChange={(e) => setCfgKey(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div className="flex items-center justify-between pt-2 gap-2">
                  {supabase && (
                    <button
                      type="button"
                      onClick={seedDemoData}
                      className="px-3 py-2 text-xs font-semibold rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                    >
                      + Nạp dữ liệu lớp mẫu
                    </button>
                  )}
                  <button
                    type="submit"
                    className="ml-auto px-4 py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
                  >
                    Lưu & Kết nối ngay
                  </button>
                </div>
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
                Nhập Mã ID & Mật khẩu giáo viên đã cấp để đồng bộ bài tập
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
                2. Giao bài & Đáp án tự chấm
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
                    <span>File PDF chờ duyệt</span>
                    <Clock className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-amber-600">{teacherKpis.pendingCount}</div>
                  <div className="text-xs text-slate-400 mt-1">Cập nhật Realtime</div>
                </div>
              </div>

              {pendingPdfSubmissions.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 font-bold text-amber-900 text-sm mb-3">
                    <FileText className="w-4 h-4 text-amber-600" />
                    <span>Bài nộp PDF mới cần giáo viên chấm điểm ({pendingPdfSubmissions.length})</span>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {pendingPdfSubmissions.map((sub) => {
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
                            onClick={() => {
                              setReviewingSubmission(sub);
                              setGradeScore(sub.score ?? '8.5');
                              setGradeWeakTopic(asg?.topic || '');
                              setGradeComment('');
                            }}
                            className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                          >
                            Chấm PDF
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
                <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h2 className="font-bold text-slate-900">Theo dõi chi tiết từng học sinh</h2>
                    <p className="text-xs text-slate-500">
                      Bấm <strong>Deep-dive</strong> để xem phần yếu và giao bài ôn riêng, hoặc <strong>Copy ID</strong> gửi học sinh
                    </p>
                  </div>
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
                      {filteredStudents.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-400 text-sm">
                            Chưa có học sinh nào. Bấm nút <strong>+ Cấp ID Học sinh mới</strong> ở góc trên để tạo ngay!
                          </td>
                        </tr>
                      ) : (
                        filteredStudents.map((stu) => {
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
                                  title="Copy ID & Mật khẩu gửi học sinh"
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
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {teacherTab === 'assignments' && (
            <div className="grid lg:grid-cols-5 gap-6">
              <form
                onSubmit={handleCreateAssignment}
                className="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 h-fit"
              >
                <h2 className="font-bold text-slate-900 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-indigo-600" />
                  <span>Tạo bài tập mới</span>
                </h2>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tên bài tập *</label>
                  <input
                    type="text"
                    required
                    placeholder="VD: Tuần 3 - Phương trình lượng giác"
                    value={asgTitle}
                    onChange={(e) => setAsgTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Giao cho lớp</label>
                    <select
                      value={asgClassId}
                      onChange={(e) => setAsgClassId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    >
                      <option value="">Tất cả các lớp</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
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
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Chuyên đề kiến thức</label>
                    <input
                      type="text"
                      placeholder="VD: Lượng giác"
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

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Đáp án chuẩn để tự động chấm điểm
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Nhập dạng: 1:A, 2:B, 3:C, 4:D (Nếu để trống, học sinh sẽ nộp file PDF để giáo viên chấm)"
                    value={asgAnswerKey}
                    onChange={(e) => setAsgAnswerKey(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Hướng dẫn / Đề bài tóm tắt</label>
                  <textarea
                    rows={2}
                    placeholder="Dặn dò học sinh cách làm hoặc yêu cầu đính kèm PDF..."
                    value={asgRubric}
                    onChange={(e) => setAsgRubric(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm"
                >
                  Đăng bài lên hệ thống
                </button>
              </form>

              <div className="lg:col-span-3 space-y-3">
                <h2 className="font-bold text-slate-900">Danh sách bài tập đã giao ({assignments.length})</h2>
                {assignments.map((a) => (
                  <div
                    key={a.id}
                    className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
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
                      <h3 className="font-bold text-slate-900 mt-1">{a.title}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Chuyên đề: <strong>{a.topic || 'Tổng hợp'}</strong> • Hạn: {a.due_date || 'Không giới hạn'}
                      </p>
                    </div>
                    <div className="text-xs text-right shrink-0">
                      {a.answer_key_text ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-medium">
                          <Check className="w-3.5 h-3.5" /> Tự động chấm
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 font-medium">
                          Chấm file PDF
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {teacherTab === 'students' && (
            <div className="grid lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 h-fit">
                <h2 className="font-bold text-slate-900 flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-emerald-600" />
                  <span>Generate tự động ID & PIN theo lớp</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Hệ thống tự lấy mã lớp làm tiền tố (VD: <code className="text-indigo-600 font-bold">10A1-01</code>) và sinh ngẫu nhiên mật khẩu PIN để giáo viên gửi cho học sinh.
                </p>

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
                      <label className="text-xs font-bold text-slate-700">2. Nhập tên học sinh (1 hoặc nhiều dòng)</label>
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

              <div className="lg:col-span-3 space-y-4">
                <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                    Các lớp hiện có ({classes.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {classes.map((c) => {
                      const count = students.filter((s) => s.class_id === c.id).length;
                      return (
                        <div
                          key={c.id}
                          className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs flex items-center gap-2"
                        >
                          <span className="font-bold text-slate-900">{c.name}</span>
                          <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-mono font-bold text-[10px]">
                            Mã: {deriveClassPrefix(c.name, c.id)}
                          </span>
                          <span className="text-slate-500">({count} HS)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-bold text-slate-900">Danh sách ID & Mật khẩu học sinh ({students.length})</h2>
                  </div>
                  <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
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

      {/* MODAL CHẤM BÀI PDF */}
      {reviewingSubmission && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSavePdfGrade}
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900">Chấm bài nộp của {reviewingSubmission.student_code}</h3>
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
                <span>Mở file PDF bài làm: {reviewingSubmission.file_name || 'Xem PDF'}</span>
                <Eye className="w-4 h-4" />
              </a>
            )}

            {reviewingSubmission.answer_text && (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                <span className="font-semibold text-slate-600">Đáp án học sinh nhập: </span>
                <span>{reviewingSubmission.answer_text}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Điểm số (0 - 10)</label>
              <input
                type="number"
                step="0.25"
                min="0"
                max="10"
                required
                value={gradeScore}
                onChange={(e) => setGradeScore(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Chuyên đề học sinh còn yếu (cách nhau dấu phẩy)
              </label>
              <input
                type="text"
                placeholder="VD: Hình học không gian, Đạo hàm"
                value={gradeWeakTopic}
                onChange={(e) => setGradeWeakTopic(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nhận xét & Lỗi sai cần sửa</label>
              <textarea
                rows={3}
                placeholder="Chỉ rõ câu sai và phần kiến thức cần ôn lại..."
                value={gradeComment}
                onChange={(e) => setGradeComment(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm"
            >
              Lưu điểm & Gửi trả kết quả
            </button>
          </form>
        </div>
      )}

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
                Bài tập & Nộp PDF
              </button>
              <button
                onClick={() => setStudentTab('progress')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                  studentTab === 'progress'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                Phong độ & Phần cần ôn
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
                            {task.rubric && <p className="text-xs text-slate-500 mt-1">{task.rubric}</p>}
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                            {sub ? (
                              <span className="text-xs font-bold text-emerald-600">
                                {sub.score !== null ? `Đã chấm: ${sub.score}/10` : 'Đã nộp PDF (Chờ chấm)'}
                              </span>
                            ) : (
                              <span className="text-xs text-rose-600 font-medium">Cần hoàn thành</span>
                            )}
                            <button
                              onClick={() => {
                                setSubmittingAsg(task);
                                setStuAnswerInput('');
                                setStuPdfFile(null);
                              }}
                              className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
                            >
                              {sub ? 'Nộp lại' : 'Nộp bài ngay'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h2 className="text-sm font-bold text-slate-800">Bài tập của lớp theo Tuần / Ngày</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  {studentPortalData.classTasks.map((task) => {
                    const sub = studentPortalData.subByAsg[task.id];
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
                          <p className="text-xs text-slate-500 mt-0.5">Chuyên đề: {task.topic || 'Tổng hợp'}</p>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                          {sub ? (
                            <span className="text-xs font-bold text-emerald-600">
                              {sub.score !== null ? `Điểm: ${sub.score}/10` : 'Đã nộp PDF (Chờ chấm)'}
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 font-medium">Chưa nộp</span>
                          )}
                          <button
                            onClick={() => {
                              setSubmittingAsg(task);
                              setStuAnswerInput('');
                              setStuPdfFile(null);
                            }}
                            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
                          >
                            {sub ? 'Xem / Nộp lại' : 'Nộp bài ngay'}
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

              {studentPortalData.weakTopics.length > 0 && (
                <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4">
                  <h3 className="text-sm font-bold text-rose-900 mb-2">
                    Chuyên đề em cần tự ôn lại dựa trên các bài đã chấm:
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {studentPortalData.weakTopics.map((w) => (
                      <span
                        key={w}
                        className="px-3 py-1 rounded-full bg-white border border-rose-200 text-rose-700 text-xs font-semibold"
                      >
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h2 className="font-bold text-slate-900 text-sm">Chi tiết điểm & nhận xét từng bài đã nộp</h2>
                {studentPortalData.mySubs.map((sub) => {
                  const asg = assignments.find((a) => a.id === sub.assignment_id);
                  const fb = sub.ai_feedback_json || {};
                  return (
                    <div key={sub.id} className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-sm text-slate-900">{asg?.title || 'Bài tập'}</div>
                        <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold text-xs">
                          {sub.score !== null ? `${sub.score}/10 điểm` : 'Chờ chấm PDF'}
                        </span>
                      </div>
                      {fb.summary && <p className="text-xs text-slate-700">{fb.summary}</p>}
                      {Array.isArray(fb.wrongDetails) && fb.wrongDetails.length > 0 && (
                        <div className="p-3 rounded-xl bg-rose-50 text-xs text-rose-800 space-y-1">
                          <div className="font-bold">Chi tiết chỗ sai cần sửa:</div>
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

      {/* MODAL NỘP BÀI */}
      {submittingAsg && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleStudentSubmit}
            className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-bold text-slate-900">{submittingAsg.title}</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Chuyên đề: {submittingAsg.topic || 'Tổng hợp'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSubmittingAsg(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {submittingAsg.rubric && (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700">
                {submittingAsg.rubric}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                1. Đính kèm file PDF bài làm (Tự luận / Bài giải ra giấy)
              </label>
              <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-indigo-200 rounded-xl bg-indigo-50/40 hover:bg-indigo-50 cursor-pointer transition">
                <Upload className="w-6 h-6 text-indigo-600 mb-1" />
                <span className="text-xs font-semibold text-indigo-700">
                  {stuPdfFile ? stuPdfFile.name : 'Bấm để chọn file .PDF từ máy hoặc điện thoại'}
                </span>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={(e) => setStuPdfFile(e.target.files?.[0] || null)}
                  className="hidden"
                />
              </label>
            </div>

            {submittingAsg.answer_key_text && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  2. Nhập đáp án nhanh (Hệ thống tự chấm điểm ngay sau 1 giây)
                </label>
                <input
                  type="text"
                  placeholder="Ví dụ: 1:A, 2:B, 3:C, 4:D"
                  value={stuAnswerInput}
                  onChange={(e) => setStuAnswerInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" />
              <span>{isSubmitting ? 'Đang tải lên Supabase...' : 'Xác nhận nộp bài'}</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
