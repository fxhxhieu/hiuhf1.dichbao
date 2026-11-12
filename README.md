# hiuhf1 – Dịch PDF sang tiếng Việt

Website tĩnh để dịch bài báo PDF sang tiếng Việt. Kéo thả file, đọc song song bản gốc và bản dịch, rồi tải về **DOCX**, **PDF giữ bố cục** hoặc **bản song ngữ**. Toàn bộ chạy trên trình duyệt nên đưa lên GitHub Pages được, không cần máy chủ.

## Tính năng

- **3 chế độ xem:** chia đôi (gốc | dịch), chỉ bản gốc, chỉ bản dịch. Hai bên cuộn đồng bộ.
- **Bản dịch giữ bố cục:** chữ tiếng Việt được đặt đúng vị trí đoạn gốc, hiểu bài báo 2 cột. Phủ theo **màu nền** quanh đoạn (hộp màu, slide vẫn đẹp), giữ **màu chữ** gốc, chọn **chữ có chân/không chân** theo font của bản gốc. Chữ dịch dài hơn thì lấn xuống khoảng trống bên dưới trước, hết chỗ mới thu nhỏ; vẫn không vừa thì góc đoạn có **dấu cam**, rê chuột vào xem đủ chữ.
- **Rê chuột / chạm:** rê vào một đoạn ở bản gốc thì đoạn dịch tương ứng sáng lên (và ngược lại). Khi chỉ xem một bên, có khung nổi hiện nội dung bên còn lại. Trên điện thoại thì chạm vào đoạn.
- **Sửa từng đoạn:** nút **✎ Sửa** ở góc đoạn dịch: sửa tay, dịch lại đoạn (hoặc cả trang) bằng engine khác, hoặc giữ nguyên bản gốc.
- **Chọn, copy, tìm chữ:** cả hai bên đều bôi đen và copy được. Ô **Tìm trong bài** (Ctrl+F) tìm cả bản gốc lẫn bản dịch, không phân biệt dấu.
- **Bảng thuật ngữ:** ví dụ giữ nguyên "transformer" (Google hay dịch thành "máy biến áp"), dịch "attention" thành "cơ chế chú ý".
- **Bảo vệ phần không nên dịch:** trích dẫn `[4, 7]`, URL, email, công thức giữa câu (`x ∈ R^n`, `h_t`, `O(n²)`) được thay bằng mã giữ chỗ trước khi gửi đi, dịch xong trả lại nguyên vẹn.
- **Bỏ qua phần References** (bật sẵn, tắt được trong Cài đặt): đỡ tốn hạn mức, khỏi hỏng tên tác giả. Phụ lục sau References vẫn được dịch.
- **PDF scan:** tự nhận ra bản scan và nhận dạng chữ (**OCR**, Tesseract.js) trước khi dịch.
- **Tải về:** DOCX, DOCX song ngữ (bảng gốc | dịch), PDF giữ bố cục, PDF song ngữ (xen kẽ trang hoặc đặt cạnh nhau), và **bản dịch .json** để gửi người khác nhập lại mà không phải dịch.
- **Hợp bài dài (30–60 trang):** dịch trang đang xem trước, chọn được khoảng trang, có thanh tiến độ, bấm Dừng/Tiếp tục bất cứ lúc nào.
- **Lưu trong trình duyệt:** bài đã mở (cả file PDF) và bản dịch lưu trong IndexedDB; mở lại từ danh sách **Bài đã mở gần đây** ở trang chủ, xoá được từng bài. Bản dịch gắn với nội dung đoạn văn, nên tải lại cùng file (hay phiên bản mới của bài) vẫn dùng lại được các đoạn không đổi. **Bộ nhớ dịch** dùng chung giữa các bài để không dịch lại đoạn trùng.
- **Dùng được khi mất mạng:** thư viện và font nằm sẵn trong repo, service worker lưu lại giao diện (cài được như ứng dụng). Mất mạng vẫn mở và xem được bài đã lưu; dịch thì cần mạng, trừ engine Chrome trên máy.
- **Miễn phí, nhiều engine, tự chuyển dự phòng** khi engine đang dùng bị lỗi.
- Giao diện sáng/tối, thu phóng (nút, Ctrl + cuộn chuột, chụm hai ngón), nhảy tới trang.

## Engine dịch

| Engine | Chất lượng | Ghi chú |
|---|---|---|
| **Google Translate** (mặc định) | Tốt | Không cần key. Gom nhiều đoạn vào mỗi lần gọi nên bài 14 trang dịch trong khoảng chục giây. Endpoint không chính thức nên Google có thể đổi hoặc tạm chặn nếu gửi quá nhiều (khi đó web tự chờ rồi chuyển engine khác). |
| **Chrome trên máy** | Khá | Dùng Translator API có sẵn trong Chrome 138+ (bản máy tính). Không giới hạn, chạy ngay trên máy. Lần đầu Chrome phải tải gói ngôn ngữ (có hiện phần trăm), và chỉ cho tải khi bạn vừa bấm nút **Dịch**. Nếu gói không tải được, web tự chuyển sang Google. |
| **MyMemory** | Trung bình | Hạn mức nhỏ (khoảng 5.000 ký tự/ngày, nhiều hơn nếu khai email). Chỉ nên làm phương án cuối. Menu ▾ cạnh nút Dịch cho biết còn bao nhiêu ký tự chưa dịch. |
| **Gemini** | Rất tốt | Cần API key miễn phí từ Google AI Studio. Key chỉ lưu trong trình duyệt của bạn (localStorage), gửi trong header chứ không nằm trên URL. Gemini được gửi kèm tiêu đề, tóm tắt bài và bảng thuật ngữ để dịch nhất quán. Nhập key xong, ô Model gợi ý các model key đó dùng được. |

Chọn engine ở nút ⚙ (Cài đặt). Nếu engine chọn bị lỗi liên tục, ứng dụng tự chuyển sang engine kế tiếp theo thứ tự Google → Chrome → MyMemory. Key Gemini sai hoặc hết hạn thì báo rõ lỗi và chuyển ngay, không thử lại vô ích.

## Chạy thử trên máy

Không cần cài gì thêm. Mở terminal trong thư mục này và chạy một web server tĩnh bất kỳ, ví dụ:

```bash
python -m http.server 8000
```

Rồi mở http://localhost:8000. Mở trực tiếp `index.html` bằng file:// cũng chạy được, nhưng khi đó font lấy từ CDN và không có chế độ dùng khi mất mạng.

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

1. **PDF.js** hiển thị trang và lấy chữ cùng toạ độ (trang scan thì **Tesseract.js** nhận dạng chữ trước).
2. Chữ được gom thành từng đoạn (tách cột, nối dòng, bỏ gạch nối cuối dòng). Đoạn chỉ gồm số/ký hiệu/công thức, URL hay danh sách tên tác giả được giữ nguyên, không dịch.
3. Từng đoạn được gửi tới engine dịch (sau khi che thuật ngữ, trích dẫn, công thức bằng mã giữ chỗ). Kết quả lưu vào IndexedDB theo nội dung đoạn.
4. Trang gốc được vẽ ra ảnh tạm để lấy màu nền, màu chữ và khoảng trống quanh từng đoạn. Bản dịch được vẽ đè lên trang gốc: phủ chữ cũ bằng màu nền, viết chữ Việt vào cùng khung.
5. **pdf-lib** + font Noto (Sans, Serif, và Noto Sans Math cho ký hiệu toán) tạo PDF tiếng Việt, **docx** tạo file Word (đọc theo thứ tự cột trái rồi cột phải).

Thư viện (PDF.js, pdf-lib, fontkit, docx) nằm trong `vendor/`, font Noto trong `fonts/`. Chỉ Tesseract.js (OCR) được tải từ CDN khi cần, có kiểm tra toàn vẹn (SRI).

## Giới hạn hiện tại

- **OCR** chậm hơn (khoảng 10 giây mỗi trang) và kém chính xác hơn chữ thật trong PDF. Lần đầu phải tải khoảng 10–20 MB dữ liệu nhận dạng.
- **Công thức toán dạng khối, chữ trong hình, bảng phức tạp** có thể không được dịch hoặc bị tách đoạn chưa đẹp.
- **Tên người** (dòng tác giả) được nhận diện và giữ nguyên, nhưng nhận diện chỉ là phỏng đoán nên đôi khi dòng tên vẫn bị dịch.
- **PDF giữ bố cục** vẫn còn chữ tiếng Anh gốc nằm dưới lớp phủ: nhìn thì chỉ thấy tiếng Việt, nhưng copy hay tìm kiếm trong file có thể ra cả tiếng Anh. Cần văn bản tiếng Việt sạch thì dùng bản DOCX.
- Chữ xoay (ví dụ dải ghi mã arXiv bên lề) bị bỏ qua.
- Văn bản được gửi tới dịch vụ dịch bạn chọn (Google, MyMemory, Gemini). Đừng dùng cho tài liệu mật.

## Kiểm tra cách tách đoạn

Mở `debug.html` để xem từng khối chữ mà thuật toán tách ra (khung màu theo loại, khe cột, số thứ tự), lưu snapshot và so sánh sau mỗi lần sửa `js/core.js`. Xem hướng dẫn trong `samples/README.md`.

## Cấu trúc

```
hiuhf1/
├─ index.html          Giao diện
├─ debug.html          Trang kiểm tra cách tách đoạn
├─ sw.js               Service worker (dùng khi mất mạng)
├─ manifest.webmanifest, icon.svg
├─ css/style.css       Kiểu dáng (sáng/tối)
├─ js/
│  ├─ core.js          Tách đoạn, phân tích ảnh trang, dàn chữ dịch, nạp font
│  ├─ translate.js     Các engine dịch, che mã giữ chỗ, bộ nhớ dịch, cơ chế dự phòng
│  ├─ storage.js       Lưu bài, file PDF, bản dịch, bộ nhớ dịch vào IndexedDB
│  ├─ export.js        Xuất PDF, DOCX, JSON
│  ├─ ocr.js           Nhận dạng chữ cho PDF scan (Tesseract.js)
│  ├─ app.js           Luồng chính và giao diện
│  └─ debug.js         Mã của debug.html
├─ vendor/             PDF.js 3.11.174, pdf-lib 1.17.1, fontkit 1.1.1, docx 8.5.0
├─ fonts/              Noto Sans, Noto Serif, Noto Sans Math (bản hinted)
└─ samples/            PDF mẫu và snapshot cho debug.html
```
