# 阿里云 Ubuntu 24.04 公网 IP 部署指南

本项目是一个 Node.js 打卡系统。你当前要求是不使用域名，直接用阿里云轻量服务器公网 IP 访问。

部署完成后的地址是：

```text
前台签到：http://你的公网IP/
后台管理：http://你的公网IP/admin
后台密码：114514
```

注意：手机浏览器定位通常要求 HTTPS 安全上下文。公网 IP + HTTP 能打开网页，但部分手机浏览器可能拒绝定位权限。正式长期使用时，建议后续再加域名和 HTTPS。

## 1. 准备阿里云安全组

在阿里云轻量服务器控制台放行：

```text
22/tcp   SSH 登录
80/tcp   网页访问
```

不需要放行 `3000`。Node 服务只监听本机 `127.0.0.1:3000`，公网访问统一走 Nginx 的 80 端口。

## 2. 登录服务器

在你自己的电脑终端执行：

```bash
ssh root@你的公网IP
```

后续命令都在服务器里执行。

## 3. 安装运行环境

```bash
apt update
apt install -y git nodejs npm nginx
node -v
```

项目要求 Node.js 18 或更高。Ubuntu 24.04 默认源通常满足要求。

## 4. 拉取 GitHub 项目

```bash
mkdir -p /opt
git clone https://github.com/hippyever/SuYo_MiniGame.git /opt/suyo-minigame
cd /opt/suyo-minigame
npm install --omit=dev
```

如果提示目录已经存在，说明之前部署过，改用：

```bash
cd /opt/suyo-minigame
git pull
npm install --omit=dev
```

## 5. 创建运行用户和数据目录

```bash
useradd --system --home /opt/suyo-minigame --shell /usr/sbin/nologin suyo || true
mkdir -p /var/lib/suyo-minigame
chown -R suyo:suyo /var/lib/suyo-minigame
chown -R suyo:suyo /opt/suyo-minigame
```

签到数据会保存到：

```text
/var/lib/suyo-minigame/checkins.json
```

这个文件就是你的正式签到记录，记得备份。

## 6. 写入环境变量

复制模板：

```bash
cp /opt/suyo-minigame/.env.example /etc/suyo-minigame.env
nano /etc/suyo-minigame.env
```

把里面的 `YOUR_SERVER_IP` 改成你的阿里云公网 IP，例如：

```env
HOST=127.0.0.1
PORT=3000
CHECKIN_TZ=Asia/Shanghai
ADMIN_HOSTS=47.100.10.20
ADMIN_PASSWORD=114514
ADMIN_ROOT_ON_ADMIN_HOST=false
CHECKIN_DATA_FILE=/var/lib/suyo-minigame/checkins.json
CHECKIN_GEOFENCE_FILE=/opt/suyo-minigame/data/geofence-hbut.json
CHECKIN_COOLDOWN_MS=15000
```

保存后设置权限：

```bash
chown root:suyo /etc/suyo-minigame.env
chmod 640 /etc/suyo-minigame.env
```

这里最重要的是：

```env
ADMIN_ROOT_ON_ADMIN_HOST=false
```

它会让同一个 IP 下：

```text
/      前台签到
/admin 后台管理
```

## 7. 安装 systemd 服务

```bash
cp /opt/suyo-minigame/deploy/suyo-minigame.service /etc/systemd/system/suyo-minigame.service
systemctl daemon-reload
systemctl enable --now suyo-minigame
systemctl status suyo-minigame
```

如果状态不是 `active (running)`，查看日志：

```bash
journalctl -u suyo-minigame -n 100 --no-pager
```

本机健康检查：

```bash
curl http://127.0.0.1:3000/api/health
```

正常会返回 JSON，里面有：

```json
{"ok":true}
```

## 8. 配置 Nginx 反向代理

复制 IP 直连模板：

```bash
cp /opt/suyo-minigame/deploy/nginx-suyo-minigame-ip.conf.example /etc/nginx/sites-available/suyo-minigame
nano /etc/nginx/sites-available/suyo-minigame
```

把文件里的 `YOUR_SERVER_IP` 改成你的公网 IP。

启用配置：

```bash
ln -sf /etc/nginx/sites-available/suyo-minigame /etc/nginx/sites-enabled/suyo-minigame
nginx -t
systemctl reload nginx
```

如果 `nginx -t` 报错，把错误发给我。

## 9. 访问地址

假设你的公网 IP 是 `47.100.10.20`：

```text
前台签到：http://47.100.10.20/
后台管理：http://47.100.10.20/admin
后台密码：114514
```

后台接口同样只会在这个 IP Host 下工作。

## 10. 更新项目

以后你在 GitHub 推了新代码，服务器上执行：

```bash
cd /opt/suyo-minigame
git pull
npm install --omit=dev
systemctl restart suyo-minigame
journalctl -u suyo-minigame -n 80 --no-pager
```

## 11. 备份签到数据

手动备份：

```bash
mkdir -p /var/backups/suyo-minigame
cp /var/lib/suyo-minigame/checkins.json "/var/backups/suyo-minigame/checkins-$(date +%F-%H%M%S).json"
```

查看备份：

```bash
ls -lh /var/backups/suyo-minigame
```

## 12. 常见问题

### 前台能打开，但定位失败

公网 IP + HTTP 下，手机浏览器可能不允许定位。这是浏览器安全限制，不是代码问题。

解决方案：

```text
买域名 -> 解析到服务器 IP -> 配 HTTPS -> 用 https://域名/ 访问
```

### 后台打不开

确认访问的是：

```text
http://你的公网IP/admin
```

然后检查 `/etc/suyo-minigame.env`：

```env
ADMIN_HOSTS=你的公网IP
ADMIN_ROOT_ON_ADMIN_HOST=false
```

重启：

```bash
systemctl restart suyo-minigame
systemctl reload nginx
```

### 502 Bad Gateway

说明 Nginx 能访问，但 Node 服务没起来。检查：

```bash
systemctl status suyo-minigame
journalctl -u suyo-minigame -n 100 --no-pager
```
