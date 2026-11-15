-- ============================================================================
-- SMARTCLASS REALTIME — MÃ SQL KHỞI TẠO TOÀN BỘ HỆ THỐNG TRÊN SUPABASE
-- Hướng dẫn: Copy toàn bộ nội dung file này -> Dán vào SQL Editor trên Supabase -> Bấm Run
-- ============================================================================

-- 1. Tạo bảng Danh sách lớp học
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  group_name text default 'Khối chung',
  created_at timestamptz default now()
);

-- 2. Tạo bảng Học sinh (Đăng nhập bằng Mã ID tự động theo lớp + Mã PIN 4 số)
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  student_code text unique not null,
  pin_code text not null default '1234',
  full_name text not null,
  class_id uuid references public.classes(id) on delete set null,
  class_name text,
  created_at timestamptz default now()
);

-- 3. Tạo bảng Bài tập & Đáp án tự chấm (Bao gồm bài lớp & bài ôn bổ trợ riêng)
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  class_id uuid references public.classes(id) on delete cascade,
  class_name text,
  target_student_id uuid references public.students(id) on delete cascade,
  week_number int default 1,
  due_date date,
  topic text,
  answer_key_text text,
  answer_key_url text,
  rubric text,
  is_remedial boolean default false,
  created_at timestamptz default now()
);

-- 4. Tạo bảng Bài nộp & Kết quả điểm / Nhận xét lỗi sai
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references public.students(id) on delete cascade,
  student_code text,
  assignment_id uuid references public.assignments(id) on delete cascade,
  file_url text,
  file_name text,
  answer_text text,
  status text default 'pending_review',
  score numeric(4,2),
  weak_topics text[],
  ai_feedback_json jsonb,
  submitted_at timestamptz default now()
);

-- 5. Tạo bảng Thông báo nhắc nhở từ Giáo viên
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  class_id uuid references public.classes(id) on delete cascade,
  target_student_id uuid references public.students(id) on delete cascade,
  message text not null,
  is_read boolean default false,
  created_at timestamptz default now()
);

-- 6. Tạo kho chứa file PDF bài làm của học sinh (Storage Bucket)
insert into storage.buckets (id, name, public)
values ('homework-files', 'homework-files', true)
on conflict (id) do nothing;

-- 7. Mở quyền truy cập đọc/ghi cho Web App (Row Level Security)
alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.assignments enable row level security;
alter table public.submissions enable row level security;
alter table public.announcements enable row level security;

drop policy if exists "Public access classes" on public.classes;
drop policy if exists "Public access students" on public.students;
drop policy if exists "Public access assignments" on public.assignments;
drop policy if exists "Public access submissions" on public.submissions;
drop policy if exists "Public access announcements" on public.announcements;
drop policy if exists "Public upload homework" on storage.objects;

create policy "Public access classes" on public.classes for all using (true) with check (true);
create policy "Public access students" on public.students for all using (true) with check (true);
create policy "Public access assignments" on public.assignments for all using (true) with check (true);
create policy "Public access submissions" on public.submissions for all using (true) with check (true);
create policy "Public access announcements" on public.announcements for all using (true) with check (true);

create policy "Public upload homework" on storage.objects
for all using (bucket_id = 'homework-files') with check (bucket_id = 'homework-files');

-- 8. Bật đồng bộ dữ liệu thời gian thực (Supabase Realtime)
do $$
begin
  alter publication supabase_realtime add table public.submissions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.assignments;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.announcements;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.students;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.classes;
exception when duplicate_object then null;
end $$;
