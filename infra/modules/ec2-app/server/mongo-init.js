// Bật xác thực MongoDB (start.sh chạy mỗi lần khởi động / deploy; chạy lại nhiều lần không sao).
// - Lần đầu (chưa có tài khoản nào): dùng ngoại lệ localhost của MongoDB để khởi tạo replica set và tạo tài khoản root.
// - Sau đó: đăng nhập root, đảm bảo tài khoản ứng dụng `erpapp` (chỉ đọc/ghi CSDL inoxpran_erp + xem trạng thái cụm
//   cho màn Giám sát hệ thống) có đúng mật khẩu trong SSM Parameter Store.
const rootPassword = process.env.MONGO_ROOT_PASSWORD;
const appPassword = process.env.MONGO_APP_PASSWORD;
if (!rootPassword || !appPassword) throw new Error('Thiếu MONGO_ROOT_PASSWORD / MONGO_APP_PASSWORD');

const admin = db.getSiblingDB('admin');
const login = () => {
  try {
    admin.auth('root', rootPassword);
    return true;
  } catch (error) {
    return false;
  }
};
const initiate = () => {
  if (!db.hello().setName) rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
};
const waitPrimary = () => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (db.hello().isWritablePrimary) return;
    sleep(1000);
  }
  throw new Error('MongoDB chưa trở thành PRIMARY sau 90 giây');
};

if (!login()) {
  initiate();
  waitPrimary();
  admin.createUser({ user: 'root', pwd: rootPassword, roles: [{ role: 'root', db: 'admin' }] });
  if (!login()) throw new Error('Không đăng nhập được bằng tài khoản root vừa tạo');
  print('mongo-init: đã bật xác thực và tạo tài khoản root');
} else {
  initiate();
}
waitPrimary();

const app = db.getSiblingDB('inoxpran_erp');
const roles = [{ role: 'readWrite', db: 'inoxpran_erp' }, { role: 'clusterMonitor', db: 'admin' }];
if (app.getUser('erpapp')) app.updateUser('erpapp', { pwd: appPassword, roles });
else app.createUser({ user: 'erpapp', pwd: appPassword, roles });
print('mongo-init: ok');
