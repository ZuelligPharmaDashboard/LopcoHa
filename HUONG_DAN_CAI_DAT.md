# Hướng Dẫn Đưa Toàn Bộ Hệ Thống Lên Supabase & Vercel (Miễn Phí Trọn Đời)

## Bước 1: Dựng Database trên Supabase
1. Đăng nhập https://supabase.com -> Bấm **New Project** (chọn khu vực **Southeast Asia - Singapore**).
2. Vào **SQL Editor** (menu trái) -> Bấm **New query** -> Copy toàn bộ nội dung file `supabase_setup.sql` trong thư mục này dán vào -> Bấm **Run**.
3. Vào **Project Settings** (bánh răng góc dưới bên trái):
   - Vào **Data API**: Copy **Project URL**.
   - Vào **API Keys**: Copy khóa **anon public**.

## Bước 2: Đưa Web App lên GitHub & Vercel
1. Tạo một kho lưu trữ mới trên https://github.com -> Upload toàn bộ các file trong thư mục này lên.
2. Đăng nhập https://vercel.com bằng tài khoản GitHub -> Bấm **Add New Project** -> Chọn **Import** kho vừa tạo.
3. Tại mục **Environment Variables**, thêm 2 biến:
   - `VITE_SUPABASE_URL` = dán Project URL của Supabase
   - `VITE_SUPABASE_ANON_KEY` = dán khóa anon public của Supabase
4. Bấm **Deploy** để nhận đường link `.vercel.app` chạy độc lập mãi mãi.

## Bước 3: Vận hành lớp học
- Mật khẩu Giáo viên mặc định: `2026`.
- Bấm nút **+ Cấp ID Học sinh mới** trên thanh menu -> Chọn lớp hoặc tạo lớp mới -> Bấm **Generate ID & Mật khẩu** -> Bấm **Copy gửi HS** để gửi link đăng nhập trực tiếp cho từng em.
