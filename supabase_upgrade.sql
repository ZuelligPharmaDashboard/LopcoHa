-- ============================================================================
-- NÂNG CẤP DATABASE CHO TÍNH NĂNG ĐỌC FILE WORD/PDF & LÀM BÀI TRỰC TIẾP TRÊN WEB
-- Hướng dẫn: Copy toàn bộ mã này -> Dán vào SQL Editor trên Supabase -> Bấm Run
-- ============================================================================

-- 1. Thêm cột lưu bộ câu hỏi tương tác tách từ file Word/PDF & link file đề gốc
alter table public.assignments
  add column if not exists questions_json jsonb default '[]'::jsonb,
  add column if not exists source_file_url text,
  add column if not exists source_file_name text;

-- 2. Thêm cột lưu chi tiết từng câu trả lời của học sinh làm trực tiếp trên web
alter table public.submissions
  add column if not exists answers_json jsonb default '{}'::jsonb;
