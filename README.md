# 溯造 MiniGame 活动打卡系统

一个零依赖 Node.js 网页打卡系统，包含手机端打卡页和后台统计页。

## 功能

- 用户填写姓名和队伍，自动缓存在本机浏览器。
- 自动生成本应用设备码并保存在本机，用于设备绑定。
- 打卡时上传服务器时间、客户端时间、定位、设备码、浏览器环境指纹和基础设备信息。
- 防作弊规则：同一个人可以使用多个设备码；同一个设备码或浏览器环境指纹不能绑定多个姓名/队伍。
- 后台查看原始日志、每日每人的最早/最晚打卡、今日出勤时间。
- 后台导出原始日志 CSV 和每日汇总 CSV，可直接用 Excel 打开。

## 运行

```bash
npm start
```

前台地址：

```text
http://localhost:3000/
```

后台地址：

```text
http://admin.localhost:3000/
```

默认后台访问密码：

```text
114514
```

后台登录成功后，密码会缓存在本机浏览器的 localStorage 中，不需要每次重复输入。

## 后台域名与密码

后台只能通过专属域名访问。默认专属域名是：

```text
admin.localhost:3000
```

正式使用时可以通过环境变量调整：

```bash
ADMIN_HOST=admin.example.com ADMIN_PASSWORD=your-secret-password npm start
```

如果需要多个后台域名，可使用英文逗号分隔：

```bash
ADMIN_HOSTS=admin.example.com,admin.internal.example.com npm start
```

## 手机定位注意

浏览器定位通常要求 HTTPS 安全上下文；`localhost` 可用于本机测试，但手机通过局域网访问时建议部署到 HTTPS 域名，或放到支持 HTTPS 的内网网关后面。

## 数据文件

数据写入：

```text
data/checkins.json
```

这个文件就是后台统计和导出的来源。正式活动前如需清空演练数据，可以停服后备份并删除该文件，再重新启动服务。
