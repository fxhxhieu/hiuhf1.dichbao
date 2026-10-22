# hiuhf1 – Dịch PDF sang tiếng Việt

Website tĩnh để dịch bài báo PDF sang tiếng Việt. Kéo thả file, đọc song song bản gốc và bản dịch, rồi tải về **DOCX** hoặc **PDF giữ bố cục**. Toàn bộ chạy trên trình duyệt nên đưa lên GitHub Pages được, không cần máy chủ.

## Tính năng

- **3 chế độ xem:** chia đôi (gốc | dịch), chỉ bản gốc, chỉ bản dịch. Hai bên cuộn đồng bộ.
- **Bản dịch giữ bố cục:** chữ tiếng Việt được đặt đúng vị trí đoạn gốc, hiểu bài báo 2 cột.
- **Tải về:** DOCX (chỉnh sửa được) hoặc PDF (trang gốc, chữ đã thay bằng tiếng Việt).
- **Hợp bài dài (30–60 trang):** dịch từng trang, có thanh tiến độ, bấm Dừng/Tiếp tục. Bản dịch lưu trong IndexedDB nên đóng tab rồi mở lại vẫn dịch tiếp được.
- **Miễn phí, nhiều engine, tự chuyển dự phòng** khi engine đang dùng bị lỗi.
- Giao diện sáng/tối, thu phóng, nhảy tới trang.

## Engine dịch

| Engine | Chất lượng | Ghi chú |
|---|---|---|
| **Google Translate** (mặc định) | Tốt | Không cần key. Endpoint không chính thức nên Google có thể đổi hoặc chặn nếu gửi quá nhiều. |
| **Chrome trên máy** | Khá | Dùng Translator API có sẵn trong Chrome 138+ (bản máy tính). Không giới hạn, chạy ngay trên máy. |
| **MyMemory** | Trung bình | Hạn mức nhỏ (khoảng 5.000 ký tự/ngày, nhiều hơn nếu khai email). Chỉ nên làm phương án cuối. |
| **Gemini** | Rất tốt | Cần API key miễn phí từ Google AI Studio. Key chỉ lưu trong trình duyệt của bạn (localStorage), không nằm trong repo. |

Chọn engine ở nút ⚙ (Cài đặt). Nếu engine chọn bị lỗi liên tục, ứng dụng tự chuyển sang engine kế tiếp theo thứ tự Google → Chrome → MyMemory.

## Chạy thử trên máy

Không cần cài gì thêm. Mở terminal trong thư mục này và chạy một web server tĩnh bất kỳ, ví dụ:

```bash
python -m http.server 8000
```

Rồi mở http://localhost:8000. (Mở trực tiếp `index.html` bằng file:// cũng chạy được ở hầu hết trình duyệt, nhưng dùng server sẽ ổn định hơn.)

## Đưa lên GitHub Pages

1. Tạo repo mới trên GitHub tên `hiuhf1`.
2. Đẩy toàn bộ nội dung thư mục này lên nhánh `main`:
   ```bash
   git init
   git add .
   git commit -m "hiuhf1: dịch PDF sang tiếng Việt"
   git branch -M main
   git remote add origin https://github.com/<tên-github-của-bạn>/hiuhf1.git
   git push -u origin main
   ```
3. Vào **Settings → Pages**, chọn **Deploy from a branch**, nhánh `main`, thư mục `/ (root)`.
4. Sau ít phút, web chạy tại `https://<tên-github-của-bạn>.github.io/hiuhf1/`.

## Cách hoạt động

1. **PDF.js** hiển thị trang và lấy chữ cùng toạ độ.
2. Chữ được gom thành từng đoạn (tách cột, nối dòng, bỏ gạch nối cuối dòng). Đoạn chỉ gồm số/ký hiệu/công thức hoặc URL được giữ nguyên, không dịch.
3. Từng đoạn được gửi tới engine dịch. Kết quả lưu vào IndexedDB theo từng trang.
4. Bản dịch được vẽ đè lên trang gốc (phủ trắng chữ cũ, viết chữ Việt vào cùng khung, tự thu nhỏ cỡ chữ cho vừa).
5. **pdf-lib** + font Noto Sans tạo PDF tiếng Việt, **docx** tạo file Word (đọc theo thứ tự cột trái rồi cột phải).

Thư viện (PDF.js, pdf-lib, fontkit, docx) và font Noto Sans được tải từ CDN, nên lần đầu cần có mạng.

## Giới hạn hiện tại

- **PDF scan (ảnh) chưa được hỗ trợ**, vì chưa có OCR. Cần PDF có chữ chọn được.
- **Công thức toán, chữ trong hình, bảng phức tạp** có thể không được dịch hoặc bị tách đoạn chưa đẹp. Với PDF xuất ra, vùng này giữ nguyên bản gốc nếu không được nhận là chữ cần dịch.
- Chữ tiếng Việt dài hơn tiếng Anh nên cỡ chữ ở bản PDF thường nhỏ hơn bản gốc một chút.
- Chữ xoay (ví dụ dải ghi mã arXiv bên lề) bị bỏ qua.
- Văn bản được gửi tới dịch vụ dịch bạn chọn (Google, MyMemory, Gemini). Đừng dùng cho tài liệu mật.

## Cấu trúc

```
hiuhf1/
├─ index.html        Giao diện
├─ css/style.css     Kiểu dáng (sáng/tối)
└─ js/
   ├─ core.js        Tách đoạn từ PDF, dàn chữ dịch, nạp font
   ├─ translate.js   Các engine dịch và cơ chế dự phòng
   ├─ storage.js     Lưu bản dịch vào IndexedDB
   ├─ export.js      Xuất PDF và DOCX
   └─ app.js         Luồng chính và giao diện
```
