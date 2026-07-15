# 阿里云 Ubuntu 24.04 部署

推荐使用域名和 HTTPS。公开投票会传输姓名、队伍、邮箱与验证码，不建议以公网 IP 加 HTTP 正式运行。

## 安装

```bash
apt update
apt install -y git nodejs npm nginx
git clone https://github.com/hippyever/SuYo_MiniGame.git /opt/suyo-minigame
cd /opt/suyo-minigame
npm install --omit=dev
```

项目要求 Node.js 18 或更高。

## 创建运行用户和数据目录

```bash
useradd --system --home /opt/suyo-minigame --shell /usr/sbin/nologin suyo || true
mkdir -p /var/lib/suyo-minigame/uploads
chown -R suyo:suyo /var/lib/suyo-minigame /opt/suyo-minigame
```

## 配置环境变量

```bash
cp /opt/suyo-minigame/.env.example /etc/suyo-minigame.env
nano /etc/suyo-minigame.env
chown root:suyo /etc/suyo-minigame.env
chmod 640 /etc/suyo-minigame.env
```

必须修改后台密码、OTP 密钥和全部 SMTP 配置。正式环境保持：

```env
NODE_ENV=production
ALLOW_DEV_OTP=false
```

SMTP 密码通常是邮箱服务商提供的授权码。完成后先用测试邮箱验证收信。

## 启动 systemd 服务

```bash
cp /opt/suyo-minigame/deploy/suyo-minigame.service /etc/systemd/system/suyo-minigame.service
systemctl daemon-reload
systemctl enable --now suyo-minigame
systemctl status suyo-minigame
curl http://127.0.0.1:3000/api/health
```

日志：

```bash
journalctl -u suyo-minigame -n 100 --no-pager
```

## 配置 Nginx

域名部署使用 `deploy/nginx-suyo-minigame.conf.example`，IP 直连测试使用 `deploy/nginx-suyo-minigame-ip.conf.example`。

```bash
cp /opt/suyo-minigame/deploy/nginx-suyo-minigame.conf.example /etc/nginx/sites-available/suyo-minigame
ln -sf /etc/nginx/sites-available/suyo-minigame /etc/nginx/sites-enabled/suyo-minigame
nginx -t
systemctl reload nginx
```

域名方案还需要申请 HTTPS 证书。例如使用 Certbot：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d play.example.com -d admin.example.com
```

Nginx 模板允许最大 2200MB 请求体，覆盖 2GB 作品文件与 multipart 额外开销。上传接口关闭请求缓冲，文件会直接流向 Node 与持久化目录，避免 Nginx 先完整落盘。

多人同时上传时，应用默认把单条上传限制在 150Mbit/s，并将总上传带宽控制在 180Mbit/s：

```env
UPLOAD_PER_REQUEST_MBIT=150
UPLOAD_TOTAL_MBIT=180
```

应用会按当前活跃上传数动态均分 `UPLOAD_TOTAL_MBIT`。Nginx 同时把单个 IP 的上传连接限制为 2 条，降低单个用户以多连接挤占带宽的可能。修改后需要重启服务并重新加载 Nginx。

视频、作品压缩包和开发文档使用 8MB 分片上传。连接中断时，服务端会保留已收到的分片 48 小时；用户保持文件选择后点击保存/上传即可续传，刷新页面后重新选择同一文件也会识别进度。可按需在 `/etc/suyo-minigame.env` 调整：

```env
MINIGAME_UPLOAD_SESSION_DIR=/var/lib/suyo-minigame/upload-sessions
RESUMABLE_UPLOAD_CHUNK_MB=8
RESUMABLE_UPLOAD_TTL_HOURS=48
```

## 访问

```text
公开展厅：https://play.example.com/
管理后台：https://admin.example.com/
```

如果使用同一公网 IP 测试：

```text
公开展厅：http://你的公网IP/
管理后台：http://你的公网IP/admin
```

## 更新

```bash
cd /opt/suyo-minigame
git pull
npm install --omit=dev
systemctl restart suyo-minigame
journalctl -u suyo-minigame -n 80 --no-pager
```

## 备份

至少备份数据文件和上传目录：

```bash
mkdir -p /var/backups/suyo-minigame
cp /var/lib/suyo-minigame/minigame.json /var/backups/suyo-minigame/minigame.json
cp -a /var/lib/suyo-minigame/uploads /var/backups/suyo-minigame/uploads
```

## 常见问题

### 验证码发送失败

检查 SMTP 主机、端口、加密方式、账号、授权码和发件人地址是否匹配，然后查看 systemd 日志。部分邮箱服务需要先在后台开启 SMTP。

### 视频或作品文件上传失败

确认 Nginx `client_max_body_size`、Node 的 `MAX_VIDEO_MB`、`MAX_GAME_FILE_MB` 和云服务器磁盘空间。大文件上传期间不要关闭页面，也不要集中在比赛结束前 1 小时上传。

### 502 Bad Gateway

```bash
systemctl status suyo-minigame
journalctl -u suyo-minigame -n 100 --no-pager
```
