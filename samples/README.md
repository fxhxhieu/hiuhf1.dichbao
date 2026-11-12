# Bộ mẫu kiểm tra tách đoạn

Thư mục này chứa các PDF mẫu và snapshot dùng để kiểm tra lại thuật toán tách đoạn trong `js/core.js` mỗi khi sửa.

## Cách dùng

1. Chạy web server trong thư mục `hiuhf1/`: `python -m http.server 8000`
2. Đặt PDF mẫu vào đây, nên có đủ các kiểu: bài 2 cột (arXiv/IEEE), bài 1 cột, trang có hình và bảng, trang có hội thoại hoặc danh sách.
3. **Trước khi sửa** `core.js`: mở `http://localhost:8000/debug.html?pdf=samples/<tên>.pdf`, bấm **Tải snapshot hiện tại** rồi lưu file JSON vào đây, cùng tên với file PDF.
4. **Sau khi sửa**: mở `http://localhost:8000/debug.html?pdf=samples/<tên>.pdf&snap=samples/<tên>.json`. Bảng bên phải liệt kê những trang có khối mới, khối mất, hoặc khối đổi loại (tiêu đề, căn giữa, không dịch). Bấm vào một dòng để xem trang đó, khối khác snapshot được tô đỏ.
5. Thay đổi nào là đúng thì tải snapshot mới để ghi đè file cũ.

Bản dịch đã lưu được ghép lại theo nội dung đoạn văn (hash), nên đổi cách tách đoạn chỉ làm mất bản dịch của những đoạn có chữ thay đổi. Không cần tăng số phiên bản nào cả.

Lưu ý bản quyền: chỉ đưa lên repo những PDF được phép phân phối lại (ví dụ bài arXiv giấy phép CC BY).
