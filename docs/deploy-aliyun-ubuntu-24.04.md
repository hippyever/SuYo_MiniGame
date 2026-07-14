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

Nginx 模板允许最大 320MB 请求体，和默认视频上传限制匹配。

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

### 视频上传失败

确认 Nginx `client_max_body_size`、Node 的 `MAX_VIDEO_MB` 和云服务器磁盘空间。大文件上传期间不要关闭后台页面。

### 502 Bad Gateway

```bash
systemctl status suyo-minigame
journalctl -u suyo-minigame -n 100 --no-pager
```
